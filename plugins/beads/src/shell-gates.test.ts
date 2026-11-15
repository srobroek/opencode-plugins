import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setBdShowRunForTests } from "./bd-close-gate.ts"
import { GateAdmitter } from "./gate-admission.ts"
import { parse } from "./shell.ts"
import { actorForCommand, createLedgerWarning, decideShell, hasBdEdit, withActorPrefix } from "./shell-gates.ts"
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

  describe("ledger context wiring", () => {
    let repoA = ""
    let repoB = ""
    beforeAll(() => {
      repoA = join(root, "repo-a")
      repoB = join(root, "repo-b")
      for (const repo of [repoA, repoB]) {
        mkdirSync(join(repo, ".beads"), { recursive: true })
        writeFileSync(join(repo, ".beads", "metadata.json"), `{"dolt_database":"db_${repo.slice(-1)}"}`)
        execFileSync("git", ["init", "-q", repo])
      }
    })

    test("an allowed bd create into another repository's ledger carries the advisory", async () => {
      const decision = await decideShell(
        "bd create --title t",
        repoA,
        deps({ actor: "a/b/c", env: { PATH: process.env.PATH, BEADS_DIR: join(repoB, ".beads") } }),
      )
      if (decision.kind !== "allow") throw new Error(JSON.stringify(decision))
      expect(decision.advisories.join("\n")).toContain(realpathSync(join(repoB, ".beads")))
    })

    test("a create into the repository's own ledger carries none", async () => {
      const decision = await decideShell(
        "bd create --title t",
        repoA,
        deps({ actor: "a/b/c", env: { PATH: process.env.PATH, BEADS_DIR: join(repoA, ".beads") } }),
      )
      expect(decision.kind === "allow" ? decision.advisories : ["x"]).toEqual([])
    })

    test("a PR-link refusal names the ledger it read and where it walked from", async () => {
      const sub = join(repoA, "sub")
      mkdirSync(sub, { recursive: true })
      const decision = await decideShell(
        'gh pr create --title t --body "no trailer"',
        sub,
        deps({ repositoryControl: () => ({ kind: "controlled" }) }),
      )
      if (decision.kind !== "block") throw new Error(JSON.stringify(decision))
      expect(decision.cause).toContain(JSON.stringify(join(repoA, ".beads")))
      expect(decision.cause).toContain('prefix "db_a"')
      expect(decision.cause).toContain(`walking up from ${JSON.stringify(sub)}`)
    })

    test("with the write lock disabled, a hostile ledger file neither hangs nor yields an advisory", async () => {
      const hostileRoot = join(root, "repo-fifo")
      mkdirSync(join(hostileRoot, ".beads"), { recursive: true })
      execFileSync("mkfifo", [join(hostileRoot, ".beads", "metadata.json")])
      execFileSync("git", ["init", "-q", hostileRoot])
      const env = { PATH: process.env.PATH, BEADS_DIR: join(hostileRoot, ".beads") }
      const off = { gates: { "bd-embedded-write-lock": { enabled: false } } }
      const decision = await decideShell("bd create --title t", repoA, deps({ actor: "a/b/c", env, options: off }))
      expect(decision.kind === "allow" ? decision.advisories : ["x"]).toEqual([])
      // Enabled, the same ledger still reaches the lock rather than skipping it.
      const on = await decideShell("bd create --title t", repoA, deps({ actor: "a/b/c", env }))
      expect(on.kind).toBe("allow")
      expect(on.kind === "allow" ? on.command : "").toContain("bd-embedded-write-runner")
    })

    test("admission's dynamic-cwd refusal tells the agent to pass workdir", async () => {
      const decision = await decideShell("cd $WORKTREE && bd update proj-1 --claim", root, deps({ actor: "a/b/c" }))
      if (decision.kind !== "block") throw new Error(JSON.stringify(decision))
      expect(decision.gate).toBe("beads-gate-admission")
      expect(decision.cause).toContain("pass the shell tool's `workdir` parameter")
    })

    test("--actor and --json before create do not suppress the advisory", () => {
      const env = { BEADS_DIR: join(repoB, ".beads") }
      for (const command of ["bd --actor x create --title t", "bd --json create --title t"])
        expect(createLedgerWarning(command, repoA, env)).toContain("`workdir`")
    })

    test("target selectors and help forms suppress it", () => {
      const env = { BEADS_DIR: join(repoB, ".beads") }
      for (const command of [
        `bd -C ${repoB} create --title t`,
        `bd --db ${join(repoB, ".beads")} create --title t`,
        "bd --global create --title t",
        "bd create --help",
        "bd list",
      ])
        expect(createLedgerWarning(command, repoA, env)).toBeUndefined()
    })

    test("follows export and unset BEADS_DIR earlier in the command", () => {
      const own = { BEADS_DIR: join(repoA, ".beads") }
      expect(createLedgerWarning(`export BEADS_DIR=${join(repoB, ".beads")}; bd create --title t`, repoA, own)).toContain(
        "belongs to",
      )
      const other = { BEADS_DIR: join(repoB, ".beads") }
      expect(createLedgerWarning("unset BEADS_DIR; bd create --title t", repoA, other)).toBeUndefined()
    })
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
