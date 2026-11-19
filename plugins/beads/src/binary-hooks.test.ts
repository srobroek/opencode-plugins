import { describe, expect, setDefaultTimeout, test } from "bun:test"

// Every case builds a real repository and probes it with git; under heavy machine load
// those children alone can outlast Bun's 5 s default. No assertion here is about time.
setDefaultTimeout(30_000)

import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TRAMPOLINE, writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { binaryHooksRepairAdvisory, hasBinaryHooks, protectBinaryHookCommands } from "./binary-hooks.ts"
import { decideShell } from "./shell-gates.ts"
import { gateDeps } from "./test-support.ts"

function scratch(): string {
  return mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-binary-hooks-"))
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
}
function repoWithHooks(): { root: string; hooks: string } {
  const root = scratch()
  git(root, "init", "-q")
  const hooks = join(root, "corporate-hooks")
  mkdirSync(hooks)
  git(root, "config", "--local", "core.hooksPath", hooks)
  return { root, hooks }
}
function putBinaryHook(path: string): void {
  // A writeExecutable hook is a symlink to the shared trampoline: remove it so the copy makes a new file.
  rmSync(path, { force: true })
  copyFileSync("/bin/ls", path)
  chmodSync(path, 0o755) // check-test-executables: a copied binary, not a script; the test needs a real executable
}

describe("binary Git hook protection", () => {
  test("distinguishes binary executables from script hooks", () => {
    const { root, hooks } = repoWithHooks()
    try {
      const script = join(hooks, "pre-commit")
      writeExecutable(script, "#!/bin/sh\necho safe\n")
      expect(hasBinaryHooks(root)).toBe(false)
      putBinaryHook(script)
      expect(hasBinaryHooks(root)).toBe(true)
      // The binary replaces the hook; it must not be written through the writeExecutable symlink.
      expect(lstatSync(script).isSymbolicLink()).toBe(false)
      expect(readFileSync(TRAMPOLINE, "utf8")).toStartWith("#!/bin/sh\n")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rewrites bd init to skip hooks once only when binary hooks exist", () => {
    const { root, hooks } = repoWithHooks()
    try {
      const input = { command: "bd init --prefix x", cwd: root }
      expect(protectBinaryHookCommands(input, input.command, root)).toBeUndefined()
      putBinaryHook(join(hooks, "pre-commit"))
      expect(protectBinaryHookCommands(input, input.command, root)).toEqual({
        kind: "rewrite",
        input: { command: "bd init --skip-hooks --prefix x", cwd: root },
      })
      const already = { ...input, command: "bd init --skip-hooks --prefix x" }
      expect(protectBinaryHookCommands(already, already.command, root)).toBeUndefined()
      expect(protectBinaryHookCommands(input, "echo before && bd init --prefix x", root)).toMatchObject({
        kind: "rewrite",
        input: { command: "echo before && bd init --skip-hooks --prefix x" },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("blocks hooks install only when binary hooks exist", () => {
    const { root, hooks } = repoWithHooks()
    try {
      const input = { command: "bd hooks install", cwd: root }
      expect(protectBinaryHookCommands(input, input.command, root)).toBeUndefined()
      putBinaryHook(join(hooks, "pre-push"))
      const result = protectBinaryHookCommands(input, input.command, root)
      expect(result?.kind).toBe("block")
      if (result?.kind === "block") expect(result.reason).toContain("keep the existing (binary) hooks intact")
      expect(protectBinaryHookCommands(input, "bd hooks list", root)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("leaves non-bd commands alone and fails open on probe errors", () => {
    const { root, hooks } = repoWithHooks()
    try {
      putBinaryHook(join(hooks, "pre-commit"))
      expect(protectBinaryHookCommands({ command: "echo bd init" }, "echo bd init", root)).toBeUndefined()
      expect(
        protectBinaryHookCommands({ command: "bd init" }, "bd init", root, () => {
          throw new Error("probe failed")
        }),
      ).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("session advisory requires a modified binary backup under local .beads/hooks", () => {
    const root = scratch()
    try {
      git(root, "init", "-q")
      const hooks = join(root, ".beads", "hooks")
      mkdirSync(hooks, { recursive: true })
      const backup = join(hooks, "pre-commit.backup")
      const hook = join(hooks, "pre-commit")
      putBinaryHook(backup)
      copyFileSync(backup, hook)
      git(root, "config", "--local", "core.hooksPath", ".beads/hooks")
      expect(binaryHooksRepairAdvisory(root)).toBeUndefined()
      writeFileSync(hook, "bd-added-bytes")
      const advisory = binaryHooksRepairAdvisory(root)
      expect(advisory).toContain("git config --local --unset core.hooksPath")
      expect(advisory).toContain("bd hooks uninstall")
      expect(advisory).toContain("rm -r .beads/hooks")
      expect(advisory).toContain("add `.beads/hooks/` to `.gitignore`")
      git(root, "config", "--local", "core.hooksPath", join(root, "elsewhere"))
      expect(binaryHooksRepairAdvisory(root)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("session advisory resolves an absolute hooksPath through symlinked temp paths", () => {
    // On macOS TMPDIR lives under /var, a symlink to /private/var; git reports the real form.
    const root = scratch()
    try {
      git(root, "init", "-q")
      const hooks = join(root, ".beads", "hooks")
      mkdirSync(hooks, { recursive: true })
      putBinaryHook(join(hooks, "pre-commit.backup"))
      writeFileSync(join(hooks, "pre-commit"), "bd-added-bytes")
      git(root, "config", "--local", "core.hooksPath", hooks)
      expect(binaryHooksRepairAdvisory(root)).toContain("git config --local --unset core.hooksPath")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("session advisory detects text injected inside a universal Mach-O hook", () => {
    // The observed damage: bd wrote its section into the binary, so the file keeps its fat header
    // and x86_64 slice but a later slice turns into data.
    const root = scratch()
    try {
      git(root, "init", "-q")
      const hooks = join(root, ".beads", "hooks")
      mkdirSync(hooks, { recursive: true })
      const backup = join(hooks, "pre-commit.backup")
      putBinaryHook(backup)
      const damaged = readFileSync(backup)
      damaged.write(
        '\n# --- BEGIN BEADS INTEGRATION ---\nbd hooks run pre-commit "$@"\n',
        Math.floor(damaged.length * 0.75),
        "latin1",
      )
      writeFileSync(join(hooks, "pre-commit"), damaged)
      expect(damaged.subarray(0, 4).equals(readFileSync(backup).subarray(0, 4))).toBe(true)
      git(root, "config", "--local", "core.hooksPath", ".beads/hooks")
      expect(binaryHooksRepairAdvisory(root)).toContain("git config --local --unset core.hooksPath")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("shell gate adds --skip-hooks for a real Mach-O hook and leaves scripts unchanged", async () => {
    const { root, hooks } = repoWithHooks()
    try {
      putBinaryHook(join(hooks, "pre-commit"))
      const gated = await decideShell("bd init --prefix x", root, gateDeps())
      expect(gated.kind).toBe("allow")
      if (gated.kind === "allow") {
        expect(gated.command).toContain("--skip-hooks")
        expect(gated.command).toContain("Beads hooks skipped")
        expect(gated.advisories.some((text) => text.includes("binary"))).toBe(true)
      }
      writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho safe\n")
      const script = await decideShell("bd init --prefix x", root, gateDeps())
      expect(script.kind === "allow" ? script.command : "").not.toContain("--skip-hooks")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the repair advisory fires only when a Beads hook differs from a binary backup", () => {
    const root = scratch()
    try {
      git(root, "init", "-q")
      const hooks = join(root, ".beads", "hooks")
      mkdirSync(hooks, { recursive: true })
      const backup = join(hooks, "pre-commit.backup")
      const hook = join(hooks, "pre-commit")
      putBinaryHook(backup)
      copyFileSync(backup, hook)
      git(root, "config", "--local", "core.hooksPath", ".beads/hooks")
      expect(binaryHooksRepairAdvisory(root)).toBeUndefined()
      writeFileSync(hook, "bd-modified-hook")
      expect(binaryHooksRepairAdvisory(root)).toContain("git config --local --unset core.hooksPath")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
