import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONTENTION_ADVISORY, confirmClaims, contentionAdvisory, inspectClaim, readClaimState, withJson } from "./claims.ts"
import { agentActor, blockReason, gateEnabled, sessionChain, shellInput } from "./host.ts"
import { closeInvocations, parse, parsedInvocations } from "./shell.ts"
import { claimJson, recordResult } from "./test-support.ts"

describe("a claim that carries or inherits any ledger selector is never tracked", () => {
  const claim = (command: string, inherited: NodeJS.ProcessEnv = {}) =>
    inspectClaim(command, "/repo", { BEADS_DIR: "/repo/.beads" }, { injected: "a/s1", inherited })

  test.each([
    ["--db before the verb", "bd --db /x/.beads update proj-1 --claim"],
    ["--db= before the verb", "bd --db=/x/.beads update proj-1 --claim"],
    ["--db after the verb", "bd update proj-1 --claim --db /x/.beads"],
    ["--database before", "bd --database x update proj-1 --claim"],
    ["--database= after", "bd update proj-1 --claim --database=x"],
    ["-C before, separate value", "bd -C /x update proj-1 --claim"],
    ["-C before, attached value", "bd -C/x update proj-1 --claim"],
    ["-C after, attached value", "bd update proj-1 --claim -C/x"],
    ["--directory before", "bd --directory /x update proj-1 --claim"],
    ["--directory= after", "bd update proj-1 --claim --directory=/x"],
    ["--global before", "bd --global update proj-1 --claim"],
    ["--global=false then --global", "bd --global=false --global update proj-1 --claim"],
    ["--global=false alone", "bd --global=false update proj-1 --claim"],
    ["a --dolt flag", "bd update proj-1 --claim --dolt-auto-commit off"],
    ["a repeated selector", "bd --db /a --db /b update proj-1 --claim"],
    ["a BEADS_DIR assignment", "BEADS_DIR=/x/.beads bd update proj-1 --claim"],
    ["a BEADS_DB assignment", "BEADS_DB=x bd update proj-1 --claim"],
    ["a BD_DB assignment", "BD_DB=x bd update proj-1 --claim"],
    ["another BEADS_ path assignment", "BEADS_DOLT_DATA_DIR=/x bd update proj-1 --claim"],
    ["an export", "export BEADS_DIR=/x/.beads; bd update proj-1 --claim"],
    ["an env wrapper", "env BEADS_DIR=/x bd update proj-1 --claim"],
  ])("%s", (_name, command) => {
    expect(claim(command).kind).toBe("refused")
  })

  test.each([
    "BEADS_DB",
    "BD_DB",
    "BD_SOCKET",
    "BEADS_DOLT_DATA_DIR",
    "BEADS_DOLT_SERVER_PORT",
    "BEADS_PROXIED_SERVER_ROOT_PATH",
  ])("%s set in the plugin's own environment is its ledger, so the claim is tracked", (name) => {
    expect(claim("bd update proj-1 --claim", { [name]: "/own/path" }).kind).toBe("claim")
  })

  test("an inherited BEADS_DIR is the default ledger, so the claim is still tracked", () => {
    expect(claim("bd update proj-1 --claim", { BEADS_DIR: "/repo/.beads" }).kind).toBe("claim")
  })

  test("an empty inherited variable selects nothing", () => {
    expect(claim("bd update proj-1 --claim", { BEADS_DIR: "", BD_DB: "" }).kind).toBe("claim")
  })

  test("the actor variables and the plugin's own pin are not selectors", () => {
    expect(claim("BEADS_ACTOR=a/s1 bd update proj-1 --claim").kind).toBe("claim")
    expect(claim("bd update proj-1 --claim", { BEADS_ACTOR: "a/s1" }).kind).toBe("claim")
  })
})

describe("an inline ledger assignment against the plugin's own environment", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "beads-own-"))
  const own = join(dir, "own", ".beads")
  const other = join(dir, "other", ".beads")
  mkdirSync(own, { recursive: true })
  mkdirSync(other, { recursive: true })
  symlinkSync(own, join(dir, "link"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const inspect = (name: string, inline: string, inherited: NodeJS.ProcessEnv = { [name]: own }) =>
    inspectClaim(`${name}=${inline} bd update proj-1 --claim`, dir, { BEADS_DIR: own }, { injected: "B", inherited })

  test.each([
    ["the same path", own],
    ["a trailing slash", `${own}/`],
    ["a symlink to it", join(dir, "link")],
  ])("BEADS_DIR naming %s is the plugin's own ledger, so tracked", (_name, inline) => {
    expect(inspect("BEADS_DIR", inline).kind).toBe("claim")
  })

  test("another ledger variable with the plugin's own value is tracked too", () => {
    expect(inspect("BEADS_DB", own).kind).toBe("claim")
  })

  test.each([
    ["another ledger", other],
    ["a path that does not exist", join(dir, "missing", ".beads")],
  ])("BEADS_DIR naming %s is refused", (_name, inline) => {
    const inspected = inspect("BEADS_DIR", inline)
    expect(inspected.kind).toBe("refused")
    expect(JSON.stringify(inspected)).toContain("different")
  })

  test.each(["BEADS_DOLT_PORT", "BEADS_DOLT_SERVER_PORT"])(
    "%s is compared as written: symlink aliases named like the ports do not make 3307 equal 3306",
    (name) => {
      const at = join(dir, name)
      mkdirSync(join(at, "real"), { recursive: true })
      symlinkSync(join(at, "real"), join(at, "3306"))
      symlinkSync(join(at, "real"), join(at, "3307"))
      const inspected = inspectClaim(
        `${name}=3307 bd update proj-1 --claim`,
        at,
        { BEADS_DIR: own },
        { injected: "B", inherited: { [name]: "3306" } },
      )
      expect(inspected.kind).toBe("refused")
      expect(JSON.stringify(inspected)).toContain("different")
    },
  )

  test("a scalar variable with the identical value is tracked", () => {
    const same = inspectClaim(
      "BEADS_DOLT_SERVER_PORT=3306 bd update proj-1 --claim",
      dir,
      { BEADS_DIR: own },
      { injected: "B", inherited: { BEADS_DOLT_SERVER_PORT: "3306" } },
    )
    expect(same.kind).toBe("claim")
  })

  test("an inline value for a variable the plugin's environment does not set is refused", () => {
    expect(inspect("BEADS_DB", own, { BEADS_DIR: own }).kind).toBe("refused")
  })
})

describe("a claim run through the embedded-write runner by the agent", () => {
  const refusal = (command: string) => inspectClaim(command, "/repo", { BEADS_DIR: "/s" }, { injected: "B", inherited: { BEADS_DIR: "/s" } })

  test.each([
    ["the .js form", "BEADS_DIR=/s /opt/bun /p/bd-embedded-write-runner.js -- bd update proj-1 --claim"],
    ["the .ts form with --beads-store", "/opt/bun /p/bd-embedded-write-runner.ts --beads-store /s -- bd update proj-1 --claim"],
    ["a bd claim verb", "/opt/bun /p/bd-embedded-write-runner.ts --beads-store /s -- bd claim proj-1"],
  ])("%s is refused with the runner as the reason", (_name, command) => {
    const inspected = refusal(command)
    expect(inspected.kind).toBe("refused")
    expect(JSON.stringify(inspected)).toContain("embedded-write runner")
  })

  test("a runner-wrapped write that claims nothing is not a claim", () => {
    expect(refusal("/opt/bun /p/bd-embedded-write-runner.ts --beads-store /s -- bd update proj-1 --status blocked").kind).toBe("none")
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
    expect(agentActor(main)).toBeUndefined()
    const broken = await sessionChain("c", "general", async () => {
      throw new Error("gone")
    })
    expect(agentActor(broken)).toBeUndefined()
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
    const inspected = inspectClaim(command, "/repo", {}, { injected, inherited: {} })
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
    const inspected = inspectClaim(command, "/repo", {}, { injected: "B", inherited: {} })
    expect(inspected.kind === "claim" ? [...inspected.plan.candidates] : inspected).toEqual(candidates)
    expect(confirm(command, holder)).toMatchObject({ confirmed: [{ id: "proj-1", actor: holder }], unconfirmed: [] })
  })

  test("the injected actor is the only candidate: an ambient actor in the environment is not", () => {
    const env = { BEADS_ACTOR: "ambient", BD_ACTOR: "ambient2" }
    const command = "bd update proj-1 --claim --json"
    const inspected = inspectClaim(command, "/repo", env, { injected: "B", inherited: env })
    if (inspected.kind !== "claim") throw new Error("expected a claim")
    expect([...inspected.plan.candidates]).toEqual(["B"])
    const outcome = confirmClaims(inspected.plan, [JSON.stringify([{ id: "proj-1", status: "in_progress", assignee: "ambient" }])])
    expect(outcome).toMatchObject({ confirmed: [], unconfirmed: ["proj-1"] })
  })

  test.each([
    ["a different assignee", "bd update proj-1 --claim --json", "A", "in_progress"],
    ["a status other than in_progress", "bd update proj-1 --claim --json", "B", "open"],
  ])("%s leaves the claim unconfirmed", (_name, command, holder, status) => {
    expect(confirm(command, holder, "B", status)).toMatchObject({ confirmed: [], unconfirmed: ["proj-1"] })
  })

  test("another bead's issue in the output does not confirm the claimed one", () => {
    const inspected = inspectClaim("bd update proj-1 --claim --json", "/repo", {}, { injected: "B", inherited: {} })
    if (inspected.kind !== "claim") throw new Error("expected a claim")
    const outcome = confirmClaims(inspected.plan, [JSON.stringify([{ id: "proj-2", status: "in_progress", assignee: "B" }])])
    expect(outcome).toEqual({ confirmed: [], unconfirmed: ["proj-1"], jsonFound: true })
  })

  test("text output is no confirmation", () => {
    const inspected = inspectClaim("bd update proj-1 --claim", "/repo", {}, { injected: "B", inherited: {} })
    if (inspected.kind !== "claim") throw new Error("expected a claim")
    expect(confirmClaims(inspected.plan, ["✓ Updated issue: proj-1 — Title"]).confirmed).toEqual([])
  })

  test("reads bd's JSON after a warning line ahead of it", () => {
    const inspected = inspectClaim("bd update proj-1 --claim --json", "/repo", {}, { injected: "B", inherited: {} })
    if (inspected.kind !== "claim") throw new Error("expected a claim")
    const out = `warning: workspace gate unavailable\n${claimJson({ "proj-1": "B" })}`
    expect(confirmClaims(inspected.plan, [out]).confirmed).toHaveLength(1)
  })
})

describe("why a claim is refused", () => {
  const reason = (command: string) => {
    const inspected = inspectClaim(command, "/repo", {}, { injected: "B", inherited: {} })
    return inspected.kind === "refused" ? inspected.reason : inspected.kind
  }

  test("a quoted assignment before bd is named as such, not as a wrapper", () => {
    expect(reason('BEADS_ACTOR="x" bd update proj-1 --claim')).toContain("quoted variable assignment")
    expect(reason("BEADS_ACTOR='x' bd update proj-1 --claim")).toContain("quoted variable assignment")
  })

  test("an interpreter or wrapper is named as one", () => {
    expect(reason("bash -c 'bd update proj-1 --claim'")).toContain("wrapper or interpreter")
    expect(reason("env bd update proj-1 --claim")).toContain("wrapper")
  })

  test("an assigned ledger variable is named as one", () => {
    expect(reason("BEADS_DB=x bd update proj-1 --claim")).toContain("assigns BEADS_DB to a different ledger")
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
    expect(inspectClaim(command, "/repo", { BEADS_DIR: "/repo/.beads" }, { injected: "B", inherited: {} }).kind).toBe("refused")
  })

  test("a semicolon inside a quoted note is not a command separator", () => {
    const command = 'bd update proj-1 --claim --json --notes "step 1; step 2 && done | ok"'
    expect(inspectClaim(command, "/repo", { BEADS_DIR: "/repo/.beads" }, { injected: "B", inherited: {} }).kind).toBe("claim")
  })

  test("a command that claims nothing is not a claim", () => {
    expect(inspectClaim("bd update proj-1 --status blocked", "/repo", {}, { injected: "B", inherited: {} }).kind).toBe("none")
    expect(inspectClaim("ls; echo hi", "/repo", {}, { injected: "B", inherited: {} }).kind).toBe("none")
  })
})

describe("asking bd for json", () => {
  const plan = (command: string) => {
    const inspected = inspectClaim(command, "/repo", { BEADS_DIR: "/repo/.beads" }, { injected: "B", inherited: {} })
    if (inspected.kind !== "claim") throw new Error("expected a claim")
    return inspected.plan
  }

  test.each([
    ["bd update proj-1 --claim", "bd update --json proj-1 --claim"],
    ["bd update proj-1 --claim 2>&1", "bd update --json proj-1 --claim 2>&1"],
    ["bd update proj-1 --claim # note", "bd update --json proj-1 --claim # note"],
    ['bd update proj-1 --claim --notes "a; b"', 'bd update --json proj-1 --claim --notes "a; b"'],
    ["bd update proj-1 --claim --assignee", "bd update --json proj-1 --claim --assignee"],
    ["bd update proj-1 --claim --notes", "bd update --json proj-1 --claim --notes"],
    ["BEADS_ACTOR=a/s1 bd ready --claim", "BEADS_ACTOR=a/s1 bd ready --json --claim"],
    ["bd claim proj-1", "bd claim --json proj-1"],
  ])("adds --json right after the verb of %s, leaving every other word as written", (command, expected) => {
    const rewritten = withJson(command, plan(command))
    expect(rewritten).toBe(expected)
    expect(rewritten.replace(" --json", "")).toBe(command)
  })

  test("leaves a command that already asks for it alone", () => {
    const command = "bd --json update proj-1 --claim"
    expect(withJson(command, plan(command))).toBe(command)
  })
})
