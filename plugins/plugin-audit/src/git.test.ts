import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unreleasedCommits } from "./git.ts"

// Real git work (git init, commit, tag, log). The whole file measured 0.6-0.8 s with the load
// average near 15; 30 s leaves room for several `bun run check` runs on one machine (AGENTS.md).
setDefaultTimeout(30_000)

let root: string

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" })
}

function commit(file: string, message: string): void {
  mkdirSync(join(root, "plugins/demo"), { recursive: true })
  mkdirSync(join(root, "plugins/other"), { recursive: true })
  writeFileSync(join(root, file), `${message}\n`)
  git("add", ".")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-audit-git-"))
  git("init", "-q")
  commit("plugins/demo/a.txt", "feat(demo): first")
  git("tag", "demo--v0.1.0")
  commit("plugins/other/b.txt", "feat(other): unrelated")
  commit("plugins/demo/a.txt", "fix(demo): second")
  commit("plugins/demo/c.txt", "fix(demo): third")
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("unreleasedCommits", () => {
  test("counts only commits that touched the plugin since its tag", async () => {
    expect(await unreleasedCommits(root, "demo", "demo--v0.1.0")).toBe(2)
  })

  test("only the plugin's own commits count, and a tag at HEAD leaves none", async () => {
    expect(await unreleasedCommits(root, "other", "demo--v0.1.0")).toBe(1)
    git("tag", "other--v0.0.1")
    expect(await unreleasedCommits(root, "other", "other--v0.0.1")).toBe(0)
  })

  test("a missing tag is null, not an error", async () => {
    expect(await unreleasedCommits(root, "demo", "demo--v9.9.9")).toBeNull()
  })
})
