import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setBdShowRunForTests } from "./bd-close-gate.ts"
import { GateAdmitter } from "./gate-admission.ts"
import { parse } from "./shell.ts"
import { actorForCommand, decideShell, hasBdEdit, withActorPrefix } from "./shell-gates.ts"
import { gateDeps } from "./test-support.ts"

describe("decideShell", () => {
  let root = ""
  let store = ""
  beforeAll(() => {
    root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-shell-gates-"))
    store = join(root, ".beads")
    mkdirSync(store)
    writeFileSync(join(store, "metadata.json"), "{}")
    setBdShowRunForTests((argv) => ({
      exitCode: 0,
      stdout: JSON.stringify(
        argv
          .filter((word) => /^proj-/.test(word))
          .map((id) => ({ id, issue_type: id === "proj-gate" ? "gate" : "task" })),
      ),
    }))
  })
  afterAll(() => {
    setBdShowRunForTests(null)
    rmSync(root, { recursive: true, force: true })
  })

  const deps = (overrides: Parameters<typeof gateDeps>[0] = {}) =>
    gateDeps({ env: { PATH: process.env.PATH, BEADS_DIR: store }, ...overrides })

  test("refuses an unparseable command", async () => {
    expect(await decideShell("echo 'unterminated", root, deps())).toMatchObject({ kind: "block", gate: "bash-gates" })
    expect(await decideShell("bd close 'proj-1", root, deps())).toMatchObject({ kind: "block" })
  })

  test("update-close is refused before the close lookup runs", async () => {
    const decision = await decideShell("bd update proj-gate --status closed", root, deps())
    expect(decision).toMatchObject({ kind: "block", gate: "bd-update-close-gate" })
  })

  test("refuses closing a gate bead", async () => {
    const decision = await decideShell('bd close proj-gate --reason "x"', root, deps({ actor: "a/b/c" }))
    expect(decision).toMatchObject({ kind: "block", gate: "bd-close-gate" })
  })

  test("refuses an unguarded unclaim", async () => {
    expect(await decideShell("bd unclaim proj-1", root, deps())).toMatchObject({ gate: "bd-unclaim-gate" })
  })

  test("refuses a main-session create without an actor", async () => {
    expect(await decideShell("bd create --title t", root, deps())).toMatchObject({ gate: "bd-actor-gate" })
  })

  test("refuses a PR without a bead trailer when the repository is controlled", async () => {
    const decision = await decideShell(
      'gh pr create --title t --body "no trailer here"',
      root,
      deps({ repositoryControl: () => ({ kind: "controlled" }) }),
    )
    expect(decision).toMatchObject({ kind: "block", gate: "pr-bead-link-gate" })
    const linked = await decideShell(
      'gh pr create --title t --body "Bead: proj-1 fixes it"',
      root,
      deps({ repositoryControl: () => ({ kind: "controlled" }) }),
    )
    expect(linked.kind).toBe("allow")
  })

  test("runs an embedded write under the runner and keeps the actor prefix outermost", async () => {
    const decision = await decideShell("bd update proj-1 --claim", root, deps({ actor: "opencode/r/general/s" }))
    if (decision.kind !== "allow") throw new Error(JSON.stringify(decision))
    const held = realpathSync(store)
    expect(decision.command).toBe(
      `export BEADS_ACTOR='opencode/r/general/s'; BEADS_DOLT_SHARED_SERVER= BEADS_DIR='${held}' '/opt/bun' '/opt/beads/src/bd-embedded-write-runner.ts' --beads-store '${held}' --beads-wait-ms 120000 -- bd update proj-1 --claim`,
    )
  })

  test("leaves reads unwrapped", async () => {
    const decision = await decideShell("bd show proj-1 --json", root, deps())
    expect(decision).toEqual({ kind: "allow", command: "bd show proj-1 --json", advisories: [] })
  })

  test("a gate's verdict notice rides along once as an advisory", async () => {
    const gates = JSON.stringify([{ id: "proj-g1", await_type: "human", status: "open", description: "" }])
    const admitter = new GateAdmitter(async () => ({ output: gates }))
    const first = await decideShell("bd update proj-1 --claim", root, deps({ actor: "a/b/c", admitter }))
    if (first.kind !== "allow") throw new Error(JSON.stringify(first))
    expect(first.advisories.join("\n")).toContain("1 open beads gate(s)")
    const second = await decideShell("bd update proj-2 --claim", root, deps({ actor: "a/b/c", admitter }))
    expect(second.kind === "allow" ? second.advisories : ["x"]).toEqual([])
  })

  test("admission refuses while gates cannot be verified", async () => {
    const admitter = new GateAdmitter(async () => ({ failure: "store locked" }))
    const decision = await decideShell("bd update proj-1 --claim", root, deps({ actor: "a/b/c", admitter }))
    expect(decision).toMatchObject({ kind: "block", gate: "beads-gate-admission" })
  })
})

describe("helpers", () => {
  test("hasBdEdit finds bd edit, also nested, and skips help", () => {
    expect(hasBdEdit(parse("bd edit proj-1") as never)).toBe(true)
    expect(hasBdEdit(parse("echo $(bd edit proj-1)") as never)).toBe(true)
    expect(hasBdEdit(parse("bd edit --help") as never)).toBe(false)
    expect(hasBdEdit(parse("echo bd edit") as never)).toBe(false)
  })

  test("actorForCommand respects an actor the command already chooses", () => {
    expect(actorForCommand("bd list", "a")).toBe("a")
    expect(actorForCommand("bd list", undefined)).toBeUndefined()
    expect(actorForCommand("git status", "a")).toBeUndefined()
    expect(actorForCommand("bd --actor x list", "a")).toBeUndefined()
    expect(actorForCommand("BEADS_ACTOR=x bd list", "a")).toBeUndefined()
    expect(actorForCommand("export BEADS_ACTOR=x; bd list", "a")).toBeUndefined()
  })

  test("withActorPrefix quotes the actor", () => {
    expect(withActorPrefix("bd list", "it's")).toBe("export BEADS_ACTOR='it'\\''s'; bd list")
  })
})
