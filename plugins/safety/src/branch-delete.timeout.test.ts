import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Binaries that never answer. Bun resolves binaries against the PATH it started with, so the gate
// runs in a child bun whose PATH puts the stub first; the stub is killed at the bound, never waited out.
const root = mkdtempSync(join(tmpdir(), "branch-delete-hang-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const gate = JSON.stringify(join(import.meta.dir, "branch-delete.ts"))

function stub(name: string): string {
  const bin = join(root, `${name}-bin`)
  mkdirSync(bin)
  writeFileSync(join(bin, name), "#!/bin/sh\nexec sleep 30\n")
  chmodSync(join(bin, name), 0o755)
  return bin
}

function runGate(bin: string, call: string): { verdict: { action: string; reason?: string; message?: string } } {
  const script = `import { reviewBranchDeletes } from ${gate}
const verdict = await ${call}
console.log(JSON.stringify({ verdict }));`
  const proc = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe", timeout: 20_000,
  })
  return JSON.parse(proc.stdout.toString())
}

describe("hanging subprocesses", () => {
  test("a git that never answers refuses the delete and names the timed-out call", () => {
    const bin = stub("git")
    const { verdict } = runGate(bin, `reviewBranchDeletes("git branch -D a b", ${JSON.stringify(bin)}, { timeoutMs: 1000, budgetMs: 2000 })`)
    expect(verdict.action).toBe("refuse")
    expect(verdict.reason).toContain("`git rev-parse --path-format=absolute` timed out")
    // Completion and the timeout diagnostic prove the hanging child was bounded;
    // a wall-clock ceiling also measures unrelated host scheduling delays.
  }, 25_000)

  test("a gh that never answers leaves the merged-PR signal absent, so the owner is asked", () => {
    const repo = join(root, "repo")
    const git = (...args: string[]) => {
      const proc = Bun.spawnSync(["git", ...args], {
        cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      })
      if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
    }
    mkdirSync(repo)
    git("init", "-q", "-b", "main")
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
    git("branch", "unlanded")
    git("remote", "add", "origin", "https://github.com/acme/widgets.git")
    const bin = stub("gh")
    const { verdict } = runGate(bin, `reviewBranchDeletes("git branch -D unlanded", ${JSON.stringify(repo)}, { ghTimeoutMs: 1000 })`)
    expect(verdict.action).toBe("confirm")
    expect(verdict.message).toContain("gh could not answer for acme/widgets")
  }, 25_000)
})
