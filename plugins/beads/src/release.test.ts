import { describe, expect, test } from "bun:test"
import { bdInvocations } from "./bd-actor-gate.ts"
import { type ClaimState, readClaimState, recordClaimTransitions, type TrackedClaim } from "./claims.ts"
import type { BdRun } from "./gate-admission.ts"
import {
  heldClaimsAdvisory,
  releaseClaimArgs,
  releaseClaimCommand,
  releaseClaims,
  releaseReport,
  restoreStatusArgs,
} from "./release.ts"

const AT = "2026-09-14T12:34:56.789Z"

/** Feed successful shell results through claim tracking, as `execute.after` does. */
function track(commands: Array<string | [string, string]>, env: NodeJS.ProcessEnv = {}, cwd = "/repo"): ClaimState {
  const state = readClaimState(undefined)
  for (const entry of commands) {
    const [command, output] = typeof entry === "string" ? [entry, "command succeeded"] : entry
    recordClaimTransitions(state, command, cwd, { BEADS_DIR: "/repo/.beads", ...env }, output, bdInvocations(command))
  }
  return state
}

const advisory = (state: ClaimState) => heldClaimsAdvisory(state, true, AT) ?? ""

describe("releaseClaimArgs", () => {
  const reason = `session release by opencode/r/a/s2 at ${AT}; previous holder opencode/r/a/s1`
  test("builds one guarded native unclaim argv with its durable reason", () => {
    expect(releaseClaimArgs("bd-probe-2m7", "opencode/r/a/s1", { BD_ACTOR: "opencode/r/a/s2" }, AT)).toEqual([
      "unclaim",
      "bd-probe-2m7",
      "--reason",
      reason,
      "--if-assignee",
      "opencode/r/a/s1",
    ])
  })
  test("refuses to mutate when CAS is unavailable", () => {
    expect(releaseClaimArgs("bd-probe-2m7", "a/s1", { BD_ACTOR: "a/s2" }, AT, false)).toBeUndefined()
  })
  test("prefers BD_ACTOR and falls back to BEADS_ACTOR", () => {
    expect(releaseClaimArgs("bd-a-1", "a/s1", { BEADS_ACTOR: "a/fallback" }, AT)?.[3]).toContain("a/fallback")
    expect(releaseClaimArgs("bd-a-1", "a/s1", { BD_ACTOR: " ", BEADS_ACTOR: "a/fallback" }, AT)?.[3]).toContain("a/fallback")
    expect(releaseClaimArgs("bd-a-1", "a/s1", { BD_ACTOR: "a/wins", BEADS_ACTOR: "a/loses" }, AT)?.[3]).toContain("a/wins")
    expect(releaseClaimArgs("bd-a-1", "a/s1", {}, AT)).toBeUndefined()
  })
  test("refuses unsafe identifiers instead of interpolating shell text", () => {
    expect(releaseClaimArgs("bd-a-1;rm", "a/s1", { BD_ACTOR: "a/s2" }, AT)).toBeUndefined()
    expect(releaseClaimArgs("bd-a-1", "a/s1", { BD_ACTOR: "a/s2" }, "yesterday")).toBeUndefined()
    expect(releaseClaimCommand("bd-a-1", "a/s1", { BD_ACTOR: "a/s2" }, AT)).toContain("--if-assignee")
    expect(releaseClaimCommand("bd-a-1", "a/s1", { BD_ACTOR: "a/s2" }, AT, false)).toBeUndefined()
  })
  test("emits command-local store, actor and native reason", () => {
    const command = releaseClaimCommand("bd-a-1", "a/s1", { BD_ACTOR: "a/s2", BEADS_ACTOR: "a/ambient" }, AT, true, "/x/.beads")
    expect(command).toStartWith("BEADS_DIR='/x/.beads' BEADS_ACTOR='a/s2' BD_ACTOR='a/s2' bd 'unclaim'")
    expect(command).toContain("'session release by a/s2")
    expect(command).toContain("'--if-assignee' 'a/s1'")
  })
  test("only a parked status is restored", () => {
    expect(restoreStatusArgs("x-1", "in_progress")).toBeUndefined()
    expect(restoreStatusArgs("x-1", "open")).toBeUndefined()
    expect(restoreStatusArgs("x-1", "blocked")).toEqual(["update", "x-1", "--status", "blocked", "--if-status", "open", "--if-assignee", ""])
    expect(restoreStatusArgs("x-1", "deferred")?.[3]).toBe("deferred")
  })
})

describe("held-claims advisory (the stop nudge)", () => {
  test("nothing tracked, nothing said", () => {
    expect(heldClaimsAdvisory(readClaimState(undefined))).toBeUndefined()
  })

  test("emits a per-bead guarded command for each actor", () => {
    const state = track([
      ["bd ready --claim", "Claimed bd-a-1"],
      ["BD_ACTOR=actor/b bd ready --claim", "Claimed bd-b-2"],
    ], { BD_ACTOR: "actor/a" })
    const text = advisory(state)
    expect(text).toContain("BEADS_ACTOR='actor/a' BD_ACTOR='actor/a' bd")
    expect(text).toContain("BEADS_ACTOR='actor/b' BD_ACTOR='actor/b' bd")
    expect(text).toContain("'--if-assignee' 'actor/a'")
    expect(text).toContain("'--if-assignee' 'actor/b'")
    expect(text).toContain("BEADS_DIR='/repo/.beads'")
    expect(text).toContain('bd comments add <id> "..."')
  })

  test("quoted and escaped bd claims remain tracked", () => {
    const text = advisory(
      track([
        ["BD_ACTOR=actor/a 'bd' update bd-quoted-1 --claim", "Updated issue: bd-quoted-1"],
        ["BD_ACTOR=actor/a b\\d update bd-escaped-2 --claim", "Updated issue: bd-escaped-2"],
        ["BD_ACTOR=actor/a command 'bd' update bd-command-3 --claim", "Updated issue: bd-command-3"],
      ]),
    )
    for (const id of ["bd-quoted-1", "bd-escaped-2", "bd-command-3"]) expect(text).toContain(id)
  })

  test("a masked or skipped bd command neither claims nor clears", () => {
    const env = { BD_ACTOR: "a/s1" }
    const text = advisory(
      track(
        [
          "bd update bd-probe-2m7 --claim",
          "bd close bd-probe-2m7 --help",
          "bd update bd-help-6h6 --claim --help",
          "bd --help close bd-probe-2m7",
          "bd -h update bd-global-help-7h7 --claim",
          "bd update bd-help-value-8v8 --notes --help --claim",
          "bd update bd-post-actor-0a0 --actor=someone/else --claim",
          "bd update bd-actor-consumed-2a2 --actor --claim",
          "bd update bd-notes-consumed-3a3 --notes --claim",
          ["bd close bd-probe-2m7 || true", "close failed"],
          ["bd update bd-false-9z9 --claim || true", "claim failed"],
          ["BD_ACTOR=a/s1 bd update bd-background-8q8 --claim &", "backgrounded"],
          ["true || bd close bd-probe-2m7", ""],
          ["true || bd update bd-skipped-7w7 --claim", ""],
          ["echo $(BD_ACTOR=a/s1 bd close bd-probe-2m7)", ""],
          ["cat <<EOF\nbd close bd-probe-2m7\nEOF", "bd close bd-probe-2m7\n"],
        ],
        env,
      ),
    )
    expect(text).toContain("bd-probe-2m7")
    for (const id of ["bd-false-9z9", "bd-background-8q8", "bd-skipped-7w7", "bd-help-6h6", "bd-global-help-7h7"])
      expect(text).not.toContain(id)
    expect(text).toContain("bd-help-value-8v8")
    expect(text).toContain("bd-post-actor-0a0 [someone/else]")
    expect(text).toContain("BEADS_ACTOR='someone/else' BD_ACTOR='someone/else' bd")
    expect(text).not.toContain("bd-actor-consumed-2a2")
    expect(text).not.toContain("bd-notes-consumed-3a3")
  })

  test("tracks boolean claim flags and multi-id claims", () => {
    const text = advisory(
      track(["bd update bd-true-1 --claim=true", "bd update bd-one-1 --claim=1", "bd update bd-multi-1 bd-multi-2 --claim"], {
        BD_ACTOR: "a/s1",
      }),
    )
    for (const id of ["bd-true-1", "bd-one-1", "bd-multi-1", "bd-multi-2"]) expect(text).toContain(id)
  })

  test("tracks direct assignment to a session actor", () => {
    const text = advisory(
      track([
        ["BD_ACTOR=a/s1 bd update bd-claimed-0 --claim", "Claimed bd-claimed-0"],
        ["BD_ACTOR=a/s1 bd assign bd-assigned-1 a/s1", "Assigned bd-assigned-1 to a/s1"],
      ]),
    )
    expect(text).toContain("bd-assigned-1 [a/s1]")
  })

  test("compound claims retain each invocation's actor", () => {
    const text = advisory(
      track([["BD_ACTOR=actor/a bd update bd-a-1 --claim; BD_ACTOR=actor/b bd update bd-b-2 --claim", "Claimed bd-a-1\nClaimed bd-b-2"]]),
    )
    expect(text).toContain("bd-a-1 [actor/a]")
    expect(text).toContain("bd-b-2 [actor/b]")
  })

  test("ambiguous compound claims retain the id without guessing an actor", () => {
    const text = advisory(
      track([["BD_ACTOR=actor/a bd update bd-x-1 --claim; BD_ACTOR=actor/b bd update bd-x-1 --claim || true", "Claimed bd-x-1"]]),
    )
    expect(text).toContain("- bd-x-1 claim recorded by this session")
    expect(text).toContain("Release unavailable: the effective actor or store is missing or ambiguous")
    expect(text).not.toContain("bd-x-1 [actor/")
  })

  test("multi-id updates honour short status and assignee flags", () => {
    const state = track(
      [
        "bd update bd-a-1 --claim",
        "bd update bd-b-2 --claim",
        "bd update bd-c-3 --claim",
        "bd update bd-d-4 --claim",
        "bd update -a '' bd-a-1 bd-b-2",
        "bd update bd-c-3 bd-d-4 -s closed",
      ],
      { BD_ACTOR: "actor/a" },
    )
    expect(heldClaimsAdvisory(state)).toBeUndefined()
  })

  test("unknown update options cannot consume tracked claim ids", () => {
    const text = advisory(
      track(
        [
          "bd update bd-a-1 --claim",
          "bd update bd-b-2 --claim",
          "bd update bd-a-1 --assignee '' --status open --set-metadata release_actor=actor/a --if-assignee actor/a --spec-id bd-b-2",
        ],
        { BD_ACTOR: "actor/a" },
      ),
    )
    expect(text).not.toContain("bd-a-1")
    expect(text).toContain("bd-b-2")
  })

  test("compound JSON from a no-id claim is not attributed as claim evidence", () => {
    const state = track([["BD_ACTOR=actor/a bd ready --claim --json; bd show bd-other-1 --json", '{"id":"bd-claimed-1"}\n{"id":"bd-other-1"}']])
    expect(heldClaimsAdvisory(state)).toBeUndefined()
  })

  test("claims the session closed, finished or unclaimed are forgotten", () => {
    const state = track(
      [
        "BD_ACTOR=a/s1 bd update bd-probe-2m7.1.1 --claim",
        "BD_ACTOR=a/s1 bd update bd-other-4k2 --claim",
        "BD_ACTOR=a/s1 bd update bd-third-5k5 --claim",
        "BD_ACTOR=a/s1 bd done bd-probe-2m7.1.1",
        "BD_ACTOR=a/s1 bd close --reason finished bd-other-4k2",
        "BD_ACTOR=a/s1 bd unclaim --if-assignee a/s1 bd-third-5k5 --reason handoff",
      ],
      { BD_ACTOR: "a/s1" },
    )
    expect(heldClaimsAdvisory(state)).toBeUndefined()
  })

  test("equivalent external database selector spellings clear tracked claims", () => {
    const state = track([
      "BD_ACTOR=a/s1 bd --database=/external -C /irrelevant-a update bd-probe-2m7 --claim",
      "BD_ACTOR=a/s1 bd --database /external -C /irrelevant-b close bd-probe-2m7",
    ])
    expect(heldClaimsAdvisory(state)).toBeUndefined()
  })

  test("relative db selectors keep their effective directory identity", () => {
    const claimed = ["BEADS_DIR=$X BD_ACTOR=a/s1 bd -C /A --db .beads update bd-probe-2m7 --claim"]
    expect(heldClaimsAdvisory(track([...claimed, "BEADS_DIR=$X BD_ACTOR=a/s1 bd -C /B --db .beads close bd-probe-2m7"]))).toBeDefined()
    expect(heldClaimsAdvisory(track([...claimed, "BEADS_DIR=$X BD_ACTOR=a/s1 bd -C /A --db .beads close bd-probe-2m7"]))).toBeUndefined()
  })

  test("a long list is capped and counted", () => {
    const state = track(
      Array.from({ length: 11 }, (_, i) => `bd update bd-many-${i} --claim`),
      { BD_ACTOR: "a/s1" },
    )
    expect(advisory(state)).toContain("...and 3 more")
  })

  test("says when bd lacks guarded release", () => {
    const text = heldClaimsAdvisory(track(["bd update bd-a-1 --claim"], { BD_ACTOR: "a/s1" }), false) ?? ""
    expect(text).toContain("bd >= 1.3 is required")
    expect(text).not.toContain("Release with:")
  })
})

type Row = { id: string; status: string; issue_type?: string; assignee?: string }

/** A `bd` stand-in: `show` answers from `rows` (or a failure), writes from `writes`. */
function fakeBd(rows: Record<string, Row | string>, writes: (args: string[]) => { output: string } | { failure: string } = () => ({ output: "ok" })) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = []
  const run: BdRun = async (cwd, args, _deadline, env) => {
    calls.push({ args, env, cwd })
    if (args[0] === "show") {
      const row = rows[args[1] ?? ""]
      if (typeof row === "string") return { failure: row }
      return { output: JSON.stringify({ data: row === undefined ? [] : [{ issue_type: "task", ...row }], schema_version: 1 }) }
    }
    return writes(args)
  }
  return { run, calls }
}

const claim = (id: string, actor: string | null = `actor/${id}`, store: string | null = "/repo/.beads"): [string, TrackedClaim] => [
  `/repo/.beads\0${id}`,
  { id, actor, store },
]

describe("releaseClaims", () => {
  test("releases every held claim and restores parked statuses", async () => {
    const statuses = { "bd-completed": "in_progress", "bd-aborted": "blocked", "bd-error": "deferred" }
    const rows: Record<string, Row | string> = { "bd-fail": "foreign read failed" }
    for (const [id, status] of Object.entries(statuses)) rows[id] = { id, status, assignee: `actor/${id}` }
    const { run, calls } = fakeBd(rows)
    const entries = [...Object.keys(statuses), "bd-fail"].map((id) => claim(id))
    const outcome = await releaseClaims(entries, run, Date.now() + 5_000, {}, true, () => AT)
    expect(outcome.released).toEqual(Object.keys(statuses).map((id) => `/repo/.beads\0${id}`))
    expect(outcome.unverified.map((entry) => entry.message)).toEqual(["the claim read for bd-fail was not verified: foreign read failed"])
    expect(calls.filter((call) => call.args[0] === "unclaim")).toHaveLength(3)
    expect(calls.filter((call) => call.args[0] === "update").map((call) => call.args.slice(0, 4))).toEqual([
      ["update", "bd-aborted", "--status", "blocked"],
      ["update", "bd-error", "--status", "deferred"],
    ])
    const unclaim = calls.find((call) => call.args[0] === "unclaim")
    expect(unclaim?.env).toMatchObject({ BD_ACTOR: "actor/bd-completed", BEADS_ACTOR: "actor/bd-completed", BEADS_DIR: "/repo/.beads" })
    expect(unclaim?.cwd).toBe("/repo")
  })

  test("drops claims bd no longer shows as this holder's, without writing", async () => {
    const { run, calls } = fakeBd({
      "bd-taken": { id: "bd-taken", status: "in_progress", assignee: "someone/else" },
      "bd-closed": { id: "bd-closed", status: "closed", assignee: "actor/bd-closed" },
    })
    const outcome = await releaseClaims([claim("bd-taken"), claim("bd-closed"), claim("bd-gone")], run, Date.now() + 5_000, {})
    expect(outcome.dropped).toHaveLength(3)
    expect(calls.every((call) => call.args[0] === "show")).toBe(true)
  })

  test("refuses unknown actors or stores and never-released types", async () => {
    const { run, calls } = fakeBd({ "bd-gate": { id: "bd-gate", status: "open", issue_type: "gate", assignee: "actor/bd-gate" } })
    const outcome = await releaseClaims([claim("bd-noactor", null), claim("bd-nostore", "a/x", null), claim("bd-gate")], run, Date.now() + 5_000, {})
    expect(outcome.unverified.map((entry) => entry.claim.id)).toEqual(["bd-noactor", "bd-nostore", "bd-gate"])
    expect(outcome.unverified[2]?.message).toContain("never released automatically")
    expect(calls.map((call) => call.args[0])).toEqual(["show"])
  })

  test("an old CLI without --if-assignee leaves the claim assigned and stops trying", async () => {
    const rows = {
      "bd-old-1": { id: "bd-old-1", status: "in_progress", assignee: "actor/bd-old-1" },
      "bd-old-2": { id: "bd-old-2", status: "in_progress", assignee: "actor/bd-old-2" },
    }
    const { run, calls } = fakeBd(rows, (args) => (args[0] === "unclaim" ? { failure: "unknown flag: --if-assignee" } : { output: "ok" }))
    const outcome = await releaseClaims([claim("bd-old-1"), claim("bd-old-2")], run, Date.now() + 5_000, {})
    expect(outcome.casSupported).toBe(false)
    expect(outcome.released).toEqual([])
    expect(calls.map((call) => call.args[0])).toEqual(["show", "unclaim", "show"])
    expect(outcome.unverified.every((entry) => entry.message.includes("bd >= 1.3 is required"))).toBe(true)
  })

  test("a failed release is reported with bd's reason", async () => {
    const { run } = fakeBd({ "bd-slow": { id: "bd-slow", status: "in_progress", assignee: "actor/bd-slow" } }, () => ({
      failure: "bd command timed out",
    }))
    const outcome = await releaseClaims([claim("bd-slow")], run, Date.now() + 5_000, {})
    expect(outcome.unverified[0]?.message).toBe("the release of bd-slow was not verified: bd command timed out")
  })
})

describe("releaseReport", () => {
  test("names released claims and gives the check and release commands for the rest", async () => {
    const { run } = fakeBd(
      {
        "bd-ok": { id: "bd-ok", status: "in_progress", assignee: "actor/bd-ok" },
        "bd-slow": { id: "bd-slow", status: "in_progress", assignee: "actor/bd-slow" },
      },
      (args) => (args[1] === "bd-slow" ? { failure: "bd command timed out" } : { output: "ok" }),
    )
    const entries = [claim("bd-ok"), claim("bd-slow")]
    const outcome = await releaseClaims(entries, run, Date.now() + 5_000, {})
    const text = releaseReport("finished subagent session ses_c", Object.fromEntries(entries), outcome, AT) ?? ""
    expect(text).toContain("the claims of finished subagent session ses_c were released (guarded bd unclaim): bd-ok.")
    expect(text).toContain("- bd-slow [actor/bd-slow]: the release of bd-slow was not verified: bd command timed out")
    expect(text).toContain("Check with: BEADS_DIR='/repo/.beads' bd show 'bd-slow' --json")
    expect(text).toContain("'--if-assignee' 'actor/bd-slow'")
  })

  test("says nothing when nothing was held", () => {
    expect(releaseReport("x", {}, { released: [], dropped: ["k"], unverified: [], casSupported: true })).toBeUndefined()
  })
})
