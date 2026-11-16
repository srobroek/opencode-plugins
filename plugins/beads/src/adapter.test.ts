import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bdInvocations } from "./bd-actor-gate.ts"
import { CONTENTION_ADVISORY, claimLookups, contentionAdvisory, readClaimHolders, readClaimState, recordClaimTransitions } from "./claims.ts"
import type { BdRun } from "./gate-admission.ts"
import { agentActor, blockReason, gateEnabled, sessionChain, shellInput } from "./host.ts"
import { closeInvocations, parse, parsedInvocations } from "./shell.ts"
import { fixtureHolders } from "./test-support.ts"

describe("claim keys after a directory change", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  test.each([
    ["--db .beads", "sub/.beads"],
    ["--directory nested", "sub/nested"],
    ["-C nested", "sub/nested"],
  ])("a relative %s selector is resolved against the directory the write runs in", (selector, relative) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "beads-claims-")))
    roots.push(root)
    mkdirSync(join(root, "sub", ".beads"), { recursive: true })
    mkdirSync(join(root, "sub", "nested", ".beads"), { recursive: true })
    const command = `cd sub && bd ${selector} update proj-1 --claim`
    const invocations = bdInvocations(command)
    const [lookup] = claimLookups(command, root, {}, "Claimed proj-1", invocations)
    expect(lookup?.cwd).toBe(join(root, "sub"))
    expect(lookup?.key).toContain(join(root, relative))
    const state = readClaimState(undefined)
    recordClaimTransitions(
      state,
      command,
      root,
      {},
      "Claimed proj-1",
      invocations,
      fixtureHolders({ "proj-1": "a/s1" }, "a/s1"),
    )
    const [claim] = Object.values(state.claims)
    expect(claim?.id).toBe("proj-1")
    expect(JSON.stringify(state.claims)).toContain(join(root, relative))
    expect(JSON.stringify(state.claims)).not.toContain(join(root, selector.includes("nested") ? "nested" : ".beads"))
  })
})

describe("claim tracking", () => {
  const env = { BEADS_DIR: "/store/.beads", BEADS_ACTOR: "opencode/r/general/s" } as NodeJS.ProcessEnv
  const record = (state: ReturnType<typeof readClaimState>, command: string, output: string) =>
    {
      const invocations = bdInvocations(command)
      return recordClaimTransitions(state, command, "/repo", env, output, invocations, fixtureHolders({}, "opencode/r/general/s"))
    }

  test("a direct claim, then a close, round-trips through stored JSON", () => {
    const state = readClaimState(undefined)
    record(state, "bd update proj-1 --claim", "✓ Claimed proj-1")
    const stored = readClaimState(JSON.parse(JSON.stringify(state)))
    expect(Object.values(stored.claims)).toEqual([
      { id: "proj-1", actor: "opencode/r/general/s", store: "/store/.beads" },
    ])
    expect(stored.actors).toEqual(["opencode/r/general/s"])
    record(stored, 'bd close proj-1 --reason "done"', "✓ Closed proj-1")
    expect(stored.claims).toEqual({})
  })

  test("a compound claim counts only ids bd reported claiming", () => {
    const state = readClaimState(undefined)
    record(state, "bd update proj-1 --claim; bd update proj-2 --claim", "✓ Claimed proj-1")
    expect(Object.values(state.claims).map((claim) => claim.id)).toEqual(["proj-1"])
  })

  test("`bd ready --claim` takes the id from output", () => {
    const state = readClaimState(undefined)
    record(state, "bd ready --claim --json", '{"id": "proj-7", "status": "in_progress"}')
    expect(Object.values(state.claims).map((claim) => claim.id)).toEqual(["proj-7"])
  })

  test("readClaimState drops malformed entries", () => {
    expect(readClaimState({ claims: { a: 1, b: { id: "x" } }, actors: [1, "y"] })).toEqual({
      claims: { b: { id: "x", actor: null, store: null } },
      actors: ["y"],
    })
  })
})

describe("contention advisory", () => {
  test("fires on contention text only", () => {
    expect(contentionAdvisory("lock busy: held by another process")).toBe(CONTENTION_ADVISORY)
    expect(contentionAdvisory("warning: workspace gate unavailable, continuing ungated")).toBeUndefined()
    expect(contentionAdvisory("Error: issue not found")).toBeUndefined()
  })
})

describe("host", () => {
  test("gates default on and switch off by either spelling", () => {
    expect(gateEnabled(undefined, "bd-close-gate")).toBe(true)
    expect(gateEnabled({ gates: { "bd-close-gate": false } }, "bd-close-gate")).toBe(false)
    expect(gateEnabled({ gates: { "bd-close-gate": { enabled: false } } }, "bd-close-gate")).toBe(false)
    expect(gateEnabled({ gates: { "bd-close-gate": { enabled: true } } }, "bd-close-gate")).toBe(true)
  })

  test("blockReason names the plugin option", () => {
    expect(blockReason({ gate: "g", cause: "c", resolution: "r" })).toBe(
      "c; r. Disable: set the srobroek.beads plugin option gates.g.enabled=false",
    )
  })

  test("sessionChain walks parentID to the root", async () => {
    const parents: Record<string, string | undefined> = { c: "b", b: "a", a: undefined }
    const chain = await sessionChain("c", "general", async (id) => ({ parentID: parents[id] }))
    expect(chain).toEqual({ sessionID: "c", parentID: "b", rootID: "a", agent: "general" })
    expect(agentActor(chain)).toBe("opencode/a/general/c")
    const main = await sessionChain("a", "build", async (id) => ({ parentID: parents[id] }))
    expect(agentActor(main)).toBe("opencode/build/a")
    const broken = await sessionChain("c", "general", async () => {
      throw new Error("gone")
    })
    expect(agentActor(broken)).toBe("opencode/general/c")
  })

  test("shellInput resolves workdir against the location", () => {
    expect(shellInput({ command: "ls" }, "/repo")).toEqual({ command: "ls", cwd: "/repo" })
    expect(shellInput({ command: "ls", workdir: "sub" }, "/repo")).toEqual({ command: "ls", cwd: "/repo/sub" })
    expect(shellInput({ command: "ls", workdir: "/abs" }, "/repo")).toEqual({ command: "ls", cwd: "/abs" })
    expect(shellInput({ path: "x" }, "/repo")).toBeUndefined()
  })
})

describe("bd shell parsing", () => {
  test("boolean globals do not swallow the verb", () => {
    expect(parsedInvocations(parse("bd --json close proj-1")).map((i) => i.verb)).toEqual(["close"])
    expect(parsedInvocations(parse("bd --db x close proj-1")).map((i) => i.verb)).toEqual(["close"])
  })

  test("a runner-wrapped write is seen as the bd after `--`", () => {
    const command = "BEADS_DIR=/s /opt/bun /p/bd-embedded-write-runner.ts --beads-store /s -- bd update proj-1 --claim"
    expect(parsedInvocations(parse(command)).map((i) => [i.verb, i.args])).toEqual([
      ["update", ["update", "proj-1", "--claim"]],
    ])
  })

  test("closeInvocations collects ids and store arguments", () => {
    expect(closeInvocations('bd -C /r close proj-1 proj-2 --reason "proj-3"')).toEqual([
      { ids: ["proj-1", "proj-2"], dbArgs: ["-C", "/r"] },
    ])
  })
})

describe("claim holder candidates", () => {
  test("an explicit --actor is the only candidate, so a conditional export cannot become the holder", () => {
    const command = "if true; then export BEADS_ACTOR=B; fi; bd update proj-1 --claim --actor A; bd update proj-1 --assignee B"
    const [lookup] = claimLookups(command, "/repo", {}, "Claimed proj-1", bdInvocations(command), "B")
    expect([...(lookup?.candidates ?? [])]).toEqual(["A"])
  })
})

describe("claim holder confirmation", () => {
  test.each([
    ["a post-verb --actor", "BEADS_ACTOR=B bd update proj-1 --claim --actor A; bd update proj-1 --assignee B", ["A"]],
    ["a post-verb --actor= form", "BEADS_ACTOR=B bd update proj-1 --claim --actor=A; bd update proj-1 --assignee B", ["A"]],
    ["a post-verb --actor over a pre-verb one", "bd --actor B update proj-1 --claim --actor A; bd update proj-1 --assignee B", ["A"]],
    ["a non-literal flag actor", 'BEADS_ACTOR=B bd update proj-1 --claim --actor "$X"; bd update proj-1 --assignee B', []],
  ])("%s outranks the prefix actor, so a handoff to B is not tracked", async (_name, command, candidates) => {
    const asked: string[][] = []
    const run: BdRun = async (_cwd, args) => {
      asked.push(args)
      return { output: JSON.stringify([{ id: "proj-1", assignee: "B" }]) }
    }
    const lookups = claimLookups(command, "/repo", {}, "Claimed proj-1", bdInvocations(command), "B")
    expect(lookups.map((lookup) => [...lookup.candidates])).toEqual([candidates])
    const holders = await readClaimHolders(lookups, {}, run, Date.now() + 1000)
    expect(asked.length).toBe(1)
    expect(holders.size).toBe(0)
  })
})
