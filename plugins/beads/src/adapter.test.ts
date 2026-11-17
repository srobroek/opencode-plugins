import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTENTION_ADVISORY, confirmClaims, contentionAdvisory, inspectClaim, readClaimState, withJson } from "./claims.ts"
import { agentActor, blockReason, gateEnabled, sessionChain, shellInput } from "./host.ts"
import { closeInvocations, parse, parsedInvocations } from "./shell.ts"
import { claimJson, recordResult } from "./test-support.ts"

describe("a pre-verb ledger selector", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function ledgers() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "beads-claims-")))
    roots.push(root)
    mkdirSync(join(root, "nested", ".beads"), { recursive: true })
    mkdirSync(join(root, "elsewhere", ".beads"), { recursive: true })
    return { root, ambient: join(root, "nested", ".beads"), other: join(root, "elsewhere") }
  }

  test.each([
    ["--db nested/.beads"],
    ["--db=nested/.beads"],
    ["--directory nested"],
    ["-C nested"],
  ])("%s that names the ambient ledger is tracked under that ledger", (selector) => {
    const { root, ambient } = ledgers()
    const state = readClaimState(undefined)
    const command = `bd ${selector} update proj-1 --claim --json`
    recordResult(state, command, root, { BEADS_DIR: ambient }, claimJson({ "proj-1": "a/s1" }), "a/s1")
    expect(Object.values(state.claims)).toEqual([{ id: "proj-1", actor: "a/s1", store: ambient }])
  })

  test.each([
    ["--db elsewhere/.beads"],
    ["--db=elsewhere/.beads"],
    ["--directory elsewhere"],
    ["--directory=elsewhere"],
    ["-C elsewhere"],
    ["--database elsewhere/.beads"],
    ["--database=elsewhere/.beads"],
    ["--db missing/.beads"],
    ["--global"],
    ["--db nested/.beads --db elsewhere/.beads"],
    ["--db elsewhere/.beads --db nested/.beads"],
    ["-C nested --directory nested"],
    ["--db nested/.beads --database nested/.beads"],
    ["--global --db nested/.beads"],
  ])("%s, a ledger not proven to be the ambient one, is never tracked", (selector) => {
    const { root, ambient } = ledgers()
    const command = `bd ${selector} update proj-1 --claim --json`
    expect(inspectClaim(command, root, { BEADS_DIR: ambient }, "a/s1").kind).toBe("refused")
    const state = readClaimState(undefined)
    recordResult(state, command, root, { BEADS_DIR: ambient }, claimJson({ "proj-1": "a/s1" }), "a/s1")
    expect(state.claims).toEqual({})
  })
})

describe("claim tracking", () => {
  const env = { BEADS_DIR: "/store/.beads", BEADS_ACTOR: "opencode/r/general/s" } as NodeJS.ProcessEnv
  const ACTOR = "opencode/r/general/s"
  const record = (state: ReturnType<typeof readClaimState>, command: string, output: string) =>
    recordResult(state, command, "/repo", env, output)

  test("a direct claim, then a close, round-trips through stored JSON", () => {
    const state = readClaimState(undefined)
    record(state, "bd update proj-1 --claim --json", claimJson({ "proj-1": ACTOR }))
    const stored = readClaimState(JSON.parse(JSON.stringify(state)))
    expect(Object.values(stored.claims)).toEqual([{ id: "proj-1", actor: ACTOR, store: "/store/.beads" }])
    expect(stored.actors).toEqual([ACTOR])
    record(stored, 'bd close proj-1 --reason "done"', "✓ Closed proj-1")
    expect(stored.claims).toEqual({})
  })

  test("a compound claim is not tracked, even when its output confirms the bead", () => {
    const state = readClaimState(undefined)
    record(state, "bd update proj-1 --claim --json; bd update proj-2 --claim --json", claimJson({ "proj-1": ACTOR }))
    expect(state.claims).toEqual({})
  })

  test("`bd ready --claim` takes the id from bd's JSON", () => {
    const state = readClaimState(undefined)
    record(state, "bd ready --claim --json", claimJson({ "proj-7": ACTOR }))
    expect(Object.values(state.claims).map((claim) => claim.id)).toEqual(["proj-7"])
  })

  test("an assignment drops the claim it cannot prove instead of recording one", () => {
    const state = readClaimState(undefined)
    record(state, "bd update proj-1 --claim --json", claimJson({ "proj-1": ACTOR }))
    record(state, `bd assign proj-1 ${ACTOR}`, "ok")
    expect(state.claims).toEqual({})
    record(state, `bd assign proj-2 ${ACTOR}`, "ok")
    expect(state.claims).toEqual({})
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


describe("claim confirmation", () => {
  const confirm = (command: string, assignee: string, injected = "B", status = "in_progress") => {
    const inspected = inspectClaim(command, "/repo", {}, injected)
    if (inspected.kind !== "claim") return inspected
    return confirmClaims(inspected.plan, [JSON.stringify([{ id: "proj-1", status, assignee }])])
  }

  test.each([
    ["the injected actor", "bd update proj-1 --claim --json", "B", ["B"]],
    ["a prefix actor over the injected one", "BEADS_ACTOR=A bd update proj-1 --claim --json", "A", ["A"]],
    ["a post-verb --actor", "BEADS_ACTOR=B bd update proj-1 --claim --actor A --json", "A", ["A"]],
    ["a post-verb --actor= form", "BEADS_ACTOR=B bd update proj-1 --claim --actor=A --json", "A", ["A"]],
    ["a post-verb --actor over a pre-verb one", "bd --actor B update proj-1 --claim --actor A --json", "A", ["A"]],
  ])("%s is the actor bd's report must name", (_name, command, holder, candidates) => {
    const inspected = inspectClaim(command, "/repo", {}, "B")
    expect(inspected.kind === "claim" ? [...inspected.plan.candidates] : inspected).toEqual(candidates)
    expect(confirm(command, holder)).toMatchObject({ confirmed: [{ id: "proj-1", actor: holder }], unconfirmed: [] })
  })

  test.each([
    ["a different assignee", "bd update proj-1 --claim --json", "A", "in_progress"],
    ["a status other than in_progress", "bd update proj-1 --claim --json", "B", "open"],
  ])("%s leaves the claim unconfirmed", (_name, command, holder, status) => {
    expect(confirm(command, holder, "B", status)).toMatchObject({ confirmed: [], unconfirmed: ["proj-1"] })
  })

  test("another bead's issue in the output does not confirm the claimed one", () => {
    const inspected = inspectClaim("bd update proj-1 --claim --json", "/repo", {}, "B")
    if (inspected.kind !== "claim") throw new Error("expected a claim")
    const outcome = confirmClaims(inspected.plan, [JSON.stringify([{ id: "proj-2", status: "in_progress", assignee: "B" }])])
    expect(outcome).toEqual({ confirmed: [], unconfirmed: ["proj-1"], jsonFound: true })
  })

  test("text output is no confirmation", () => {
    const inspected = inspectClaim("bd update proj-1 --claim", "/repo", {}, "B")
    if (inspected.kind !== "claim") throw new Error("expected a claim")
    expect(confirmClaims(inspected.plan, ["✓ Updated issue: proj-1 — Title"]).confirmed).toEqual([])
  })

  test("reads bd's JSON after a warning line ahead of it", () => {
    const inspected = inspectClaim("bd update proj-1 --claim --json", "/repo", {}, "B")
    if (inspected.kind !== "claim") throw new Error("expected a claim")
    const out = `warning: workspace gate unavailable\n${claimJson({ "proj-1": "B" })}`
    expect(confirmClaims(inspected.plan, [out]).confirmed).toHaveLength(1)
  })
})

describe("which claims are refused", () => {
  test.each([
    ["a list", "bd update proj-1 --claim --json; bd show proj-1"],
    ["an and-list", "cd /x && bd update proj-1 --claim --json"],
    ["an or-list", "bd update proj-1 --claim --json || true"],
    ["a pipe", "bd update proj-1 --claim --json | jq ."],
    ["a subshell", "(bd update proj-1 --claim --json)"],
    ["a command substitution", "x=$(bd update proj-1 --claim --json)"],
    ["a background job", "bd update proj-1 --claim --json &"],
    ["a wrapper", "bash -c 'bd update proj-1 --claim --json'"],
    ["a post-verb -C", "bd update proj-1 --claim --json -C /other"],
    ["a post-verb --directory", "bd update proj-1 --claim --json --directory=/other"],
    ["a post-verb --db", "bd update proj-1 --claim --json --db /other/.beads"],
    ["a post-verb --dolt flag", "bd update proj-1 --claim --json --dolt-auto-commit off"],
    ["a computed pre-verb selector", 'bd -C "$DIR" update proj-1 --claim --json'],
    ["a computed ledger prefix", "BEADS_DIR=$DIR bd update proj-1 --claim --json"],
    ["a variable after the verb", 'bd update proj-1 --claim --json --notes "$X"'],
    ["a variable in an --actor value", 'bd update proj-1 --claim --json --actor "$WHO"'],
    ["a command substitution after the verb", "bd update proj-1 --claim --json --notes $(date)"],
    ["a backtick substitution", "bd update proj-1 --claim --json --notes `date`"],
    ["a glob after the verb", "bd update proj-1 --claim --json --notes *.md"],
    ["a tilde after the verb", "bd update proj-1 --claim --json --notes ~/x"],
    ["a brace expansion", "bd update proj-1 --claim --json --notes {a,b}"],
  ])("%s", (_name, command) => {
    expect(inspectClaim(command, "/repo", { BEADS_DIR: "/repo/.beads" }, "B").kind).toBe("refused")
  })

  test("a semicolon inside a quoted note is not a command separator", () => {
    const command = 'bd update proj-1 --claim --json --notes "step 1; step 2 && done | ok"'
    expect(inspectClaim(command, "/repo", { BEADS_DIR: "/repo/.beads" }, "B").kind).toBe("claim")
  })

  test("a command that claims nothing is not a claim", () => {
    expect(inspectClaim("bd update proj-1 --status blocked", "/repo", {}, "B").kind).toBe("none")
    expect(inspectClaim("ls; echo hi", "/repo", {}, "B").kind).toBe("none")
  })
})

describe("asking bd for json", () => {
  const plan = (command: string) => {
    const inspected = inspectClaim(command, "/repo", { BEADS_DIR: "/repo/.beads" }, "B")
    if (inspected.kind !== "claim") throw new Error("expected a claim")
    return inspected.plan
  }

  test.each([
    ["bd update proj-1 --claim", "bd update proj-1 --claim --json"],
    ["bd update proj-1 --claim 2>&1", "bd update proj-1 --claim --json 2>&1"],
    ["bd update proj-1 --claim # note", "bd update proj-1 --claim --json # note"],
    ['bd update proj-1 --claim --notes "a; b"', 'bd update proj-1 --claim --notes "a; b" --json'],
  ])("adds --json after the last word of %s", (command, expected) => {
    expect(withJson(command, plan(command))).toBe(expected)
  })

  test("leaves a command that already asks for it alone", () => {
    const command = "bd --json update proj-1 --claim"
    expect(withJson(command, plan(command))).toBe(command)
  })
})
