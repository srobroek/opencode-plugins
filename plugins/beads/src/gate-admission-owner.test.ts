import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { withEmbeddedWriteLock } from "./bd-embedded-write-lock.ts"
import { internalWriteOwner, runBdResult } from "./gate-admission.ts"

// Real child processes; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000)

describe("internal write owner ids", () => {
  test("are unique across calls and never match the older pid-and-counter form", () => {
    const ids = Array.from({ length: 50 }, () => internalWriteOwner())
    expect(new Set(ids).size).toBe(50)
    for (const id of ids) expect(id).not.toMatch(/^beads-plugin-run-\d+-\d+$/)
  })

  test("a write from an older plugin version whose counter is at 0 serialises with a new one", async () => {
    const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-owner-"))
    const store = join(root, ".beads")
    const bin = join(root, "bin")
    const log = join(root, "log")
    mkdirSync(store)
    mkdirSync(bin)
    writeFileSync(join(store, "metadata.json"), "{}")
    // A stand-in `bd` that records when it starts and ends, so overlap is visible.
    writeFileSync(join(bin, "bd"), `#!/bin/sh\necho start >> "${log}"\nsleep 0.4\necho end >> "${log}"\n`)
    chmodSync(join(bin, "bd"), 0o755)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, BEADS_DIR: store }
    try {
      // The owner id the older module's first write got: its counter starts at 0 on the shared pid.
      const older = withEmbeddedWriteLock(
        root,
        `beads-plugin-run-${process.pid}-0`,
        () => Bun.spawn(["bd", "create", "older"], { cwd: root, env, stdout: "ignore", stderr: "ignore" }).exited,
        env,
      )
      const newer = runBdResult(root, ["create", "newer"], Date.now() + 20_000, env)
      await Promise.all([older, newer])
      const lines = readFileSync(log, "utf8").trim().split("\n")
      expect(lines).toEqual(["start", "end", "start", "end"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
