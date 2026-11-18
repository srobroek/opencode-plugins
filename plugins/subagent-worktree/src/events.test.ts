import { describe, expect, test } from "bun:test"
import {
  GATE_MIN_INTERVAL_MS,
  type GateLane,
  idleGateAction,
  type LaneEvent,
  type LaneFacts,
  type LanePolicy,
  laneBackgroundWork,
  laneEventAction,
  outcomeNotice,
  stateToken,
} from "./events.ts"
import type { Lane } from "./lane.ts"

const MIN = 60_000
const NOW = 10_000_000
const policy: LanePolicy = { resumeGraceMs: 10 * MIN, emptyGraceMs: 30 * MIN }

const lane = (over: Partial<Lane> = {}): Lane => ({
  child: "ses_c",
  parent: "ses_p",
  projectID: "prj",
  directory: "/wt/a",
  branch: "a",
  base: "b".repeat(40),
  parentDir: "/repo",
  state: "active",
  title: "Write hello",
  ...over,
})

const facts = (over: Partial<LaneFacts> = {}): LaneFacts => ({
  exists: true,
  ahead: 2,
  dirty: false,
  dirtyToken: "clean",
  busyTree: undefined,
  tip: "t".repeat(40),
  landed: false,
  openPr: false,
  child: "finished",
  parent: "idle",
  now: NOW,
  ...over,
})

const child = (type: LaneEvent["type"]): LaneEvent => ({ type, subject: "child" })
const parent: LaneEvent = { type: "check", subject: "parent" }

describe("laneEventAction", () => {
  const rows: Array<[string, Lane | undefined, LaneFacts, LaneEvent, string, string]> = [
    ["a non-lane session", undefined, facts(), child("idle"), "ignore", ""],
    ["a lane that is no longer active", lane({ state: "landed" }), facts(), child("idle"), "ignore", ""],
    ["succeeded, empty", lane(), facts({ ahead: 0 }), child("succeeded"), "defer", "grace period starts"],
    ["failed, empty", lane(), facts({ ahead: 0 }), child("failed"), "defer", ""],
    ["interrupted, empty", lane(), facts({ ahead: 0 }), child("interrupted"), "defer", ""],
    ["empty, child still running", lane(), facts({ ahead: 0, child: "running" }), child("idle"), "defer", "still running"],
    ["empty past the grace period", lane({ quietSince: NOW - 31 * MIN }), facts({ ahead: 0 }), parent, "remove", ""],
    ["empty inside the grace period", lane({ quietSince: NOW - 5 * MIN }), facts({ ahead: 0 }), parent, "defer", "idle 5 of 30"],
    ["succeeded, commits, not landed", lane(), facts(), child("succeeded"), "defer", "not landed"],
    ["landed, clean, resumed 2 min ago", lane({ resumedAt: NOW - 2 * MIN }), facts({ landed: true }), parent, "defer", "resumed 2 min ago"],
    ["landed, clean, parent mid-turn", lane(), facts({ landed: true, parent: "busy" }), parent, "defer", "mid-turn"],
    ["landed, clean, child status unknown", lane(), facts({ landed: true, child: "unknown" }), parent, "defer", "unknown"],
    ["landed, clean, stash on the branch", lane(), facts({ landed: true, busyTree: "a stash exists on a" }), parent, "defer", "stash"],
    ["landed, clean, all finished", lane({ resumedAt: NOW - 11 * MIN }), facts({ landed: true }), parent, "remove", ""],
    ["landed, clean, but delivery cleanup was denied", lane(), facts({ landed: true, denied: "delivery cleanup was denied" }), parent, "defer", "denied"],
    ["landed, clean, delivery records unreadable", lane(), facts({ landed: true, denied: "delivery's landing records cannot be read" }), parent, "defer", "cannot be read"],
    ["landed, dirty", lane(), facts({ landed: true, dirty: true, dirtyToken: "d1" }), parent, "notifyParent", ""],
    ["a landed tip with no commits is not landed work", lane(), facts({ landed: true, ahead: 0, dirty: true }), child("idle"), "notifyChild", ""],
    ["failed, commits", lane(), facts(), child("failed"), "notifyParent", ""],
    ["interrupted, dirty", lane(), facts({ dirty: true, dirtyToken: "d1" }), child("interrupted"), "notifyParent", ""],
    ["succeeded, dirty", lane(), facts({ dirty: true, dirtyToken: "d1" }), child("succeeded"), "notifyChild", ""],
    ["unreadable worktree", lane(), facts({ ahead: undefined, dirty: undefined }), child("idle"), "defer", "cannot be read"],
  ]
  for (const [name, subject, given, event, action, reason] of rows) {
    test(name, () => {
      const result = laneEventAction(subject, given, event, policy)
      expect(result.action as string).toBe(action)
      if (reason) expect(result.reason).toContain(reason)
    })
  }

  test.each([
    ["failed", child("failed"), facts(), { outcome: { kind: "failed" as const, at: 5, reason: "x", id: "e1" } }, "parent:failed:e1"],
    ["interrupted", child("interrupted"), facts({ dirty: true, dirtyToken: "d1" }), { outcome: { kind: "interrupted" as const, at: 6, reason: "x", id: "e2" } }, "parent:interrupted:e2"],
    ["succeeded dirty", child("succeeded"), facts({ dirty: true, dirtyToken: "d1" }), {}, "child:dirty:d1"],
    ["landed dirty", parent, facts({ landed: true, dirty: true, dirtyToken: "d1" }), {}, "landed-dirty:d1"],
  ])("a repeated %s event produces no second notice", (_name, event, given, extra, key) => {
    const first = laneEventAction(lane(extra), given, event, policy)
    expect(first).toMatchObject({ key })
    expect(laneEventAction(lane({ ...extra, notices: [key] }), given, event, policy).action).toBe("ignore")
  })

  test("a new dirty state is nudged again", () => {
    const sent = lane({ notices: ["child:dirty:d1"] })
    expect(laneEventAction(sent, facts({ dirty: true, dirtyToken: "d2" }), child("idle"), policy).action).toBe("notifyChild")
  })
})

test("the parent notice has the agreed shape", () => {
  expect(outcomeNotice(lane(), "interrupted", "user", { ahead: 2, dirty: false })).toBe(
    "<system-reminder>Subagent ses_c (Write hello) was interrupted: user. Its lane a at /wt/a has 2 commits ahead, uncommitted changes: no. Resume it with subagent sessionID ses_c, merge it with subagent_worktree_merge, or discard it.</system-reminder>",
  )
})

describe("idleGateAction", () => {
  const session = (over: Partial<Parameters<typeof idleGateAction>[0]> = {}) => ({
    id: "ses_p",
    runningChildren: new Set<string>(),
    now: NOW,
    lastMessageAt: undefined,
    ...over,
  })
  const led = (over: Partial<Lane> = {}, given: Partial<LaneFacts> = {}): GateLane => ({ lane: lane(over), facts: facts(given) })

  test("a dirty child gets one nudge, and a second idle gets none", () => {
    const dirty = facts({ dirty: true, dirtyToken: "d1" })
    const first = idleGateAction(session({ id: "ses_c" }), [{ lane: lane(), facts: dirty }], policy)
    expect(first.message).toContain("Commit your work in /wt/a")
    expect(first.marks).toEqual([{ child: "ses_c", key: "child:dirty:d1" }])
    const second = idleGateAction(session({ id: "ses_c" }), [{ lane: lane({ notices: ["child:dirty:d1"] }), facts: dirty }], policy)
    expect(second.message).toBeUndefined()
  })

  test("a lead with a running child says nothing", () => {
    const gate = idleGateAction(session({ runningChildren: new Set(["ses_c"]) }), [led()], policy)
    expect(gate).toMatchObject({ remove: [], marks: [] })
    expect(gate.message).toBeUndefined()
  })

  test("a lead with a finished, unresolved lane gets one message naming it", () => {
    const gate = idleGateAction(session(), [led()], policy)
    expect(gate.message).toBe(
      "<system-reminder>Lane a (2 commits, child finished) is unresolved: merge it with subagent_worktree_merge, open a PR, or record keep/discard.</system-reminder>",
    )
    expect(gate.marks).toEqual([{ child: "ses_c", key: `unresolved:${stateToken(facts())}` }])
  })

  test("one message covers every unresolved lane", () => {
    const gate = idleGateAction(session(), [led(), led({ child: "ses_d", branch: "b" })], policy)
    expect(gate.message?.match(/is unresolved/g)).toHaveLength(2)
  })

  test("an open PR counts as resolved", () => {
    expect(idleGateAction(session(), [led({}, { openPr: true })], policy).message).toBeUndefined()
  })

  test("a recorded keep silences the gate until the lane changes", () => {
    const kept = { reason: "later", token: stateToken(facts()) }
    expect(idleGateAction(session(), [led({ kept })], policy).message).toBeUndefined()
    expect(idleGateAction(session(), [led({ kept }, { ahead: 3 })], policy).message).toContain("3 commits")
  })

  test("landed and clean is removed with no message", () => {
    const gate = idleGateAction(session(), [led({}, { landed: true })], policy)
    expect(gate.remove.map((entry) => entry.lane.child)).toEqual(["ses_c"])
    expect(gate.remove[0]?.basis).toBe("landed")
    expect(gate.message).toBeUndefined()
  })

  test("a lane resumed a minute ago is not removed even when landed", () => {
    const gate = idleGateAction(session(), [led({ resumedAt: NOW - MIN }, { landed: true })], policy)
    expect(gate.remove).toEqual([])
  })

  test("landed but dirty is reported once", () => {
    const given = { landed: true, dirty: true, dirtyToken: "d1" }
    expect(idleGateAction(session(), [led({}, given)], policy).message).toContain("has landed, but /wt/a has uncommitted changes")
    expect(idleGateAction(session(), [led({ notices: ["landed-dirty:d1"] }, given)], policy).message).toBeUndefined()
  })

  test("the per-session cap holds across repeated idles", () => {
    const first = idleGateAction(session(), [led()], policy)
    expect(first.message).toBeDefined()
    const soon = idleGateAction(session({ lastMessageAt: NOW - 1000 }), [led()], policy)
    expect(soon.message).toBeUndefined()
    expect(soon.marks).toEqual([])
    const later = idleGateAction(session({ lastMessageAt: NOW - GATE_MIN_INTERVAL_MS - 1 }), [led()], policy)
    expect(later.message).toBeDefined()
  })

  test("a child that is also a lead sends only its own nudge", () => {
    const own = { lane: lane({ child: "ses_p", parent: "ses_root" }), facts: facts({ dirty: true, dirtyToken: "d1" }) }
    const gate = idleGateAction(session(), [own, led()], policy)
    expect(gate.message).toContain("Commit your work")
    expect(gate.message).not.toContain("unresolved")
  })
})

describe("laneBackgroundWork", () => {
  const target = { child: "ses_c", directory: "/wt/a" }
  const never = () => false
  const rows: Array<[string, Parameters<typeof laneBackgroundWork>[1], (id: string) => boolean | undefined, string]> = [
    ["no jobs", [], never, ""],
    ["a job of another session", [{ kind: "shell", sessionID: "ses_other", command: "sleep 9" }], never, ""],
    ["a shell the child owns", [{ kind: "shell", sessionID: "ses_c", command: "sleep 9" }], never, "child has a shell"],
    ["a subagent the child started", [{ kind: "subagent", sessionID: "ses_c", childSessionID: "ses_g" }], never, "child has a subagent"],
    ["the child itself listed as a subagent", [{ kind: "subagent", sessionID: "ses_p", childSessionID: "ses_c" }], never, "child has a subagent"],
    ["an image job of the child", [{ kind: "image", sessionID: "ses_c" }], never, "child has a image"],
    ["a descendant's shell", [{ kind: "shell", sessionID: "ses_g", command: "x" }], (id) => id === "ses_g", "descendant"],
    ["a session that cannot be placed", [{ kind: "shell", sessionID: "ses_q", command: "x" }], () => undefined, "could not be placed"],
    ["a shell whose command names the lane", [{ kind: "shell", sessionID: "ses_p", command: "cd /wt/a && make" }], never, "running in the lane"],
  ]
  for (const [name, jobs, descendant, reason] of rows) {
    test(name, () => {
      const result = laneBackgroundWork(target, jobs, descendant)
      if (reason === "") expect(result).toBeUndefined()
      else expect(result).toContain(reason)
    })
  }
})

describe("idleGateAction with the child's real status", () => {
  const session = { id: "ses_p", runningChildren: new Set<string>(), now: NOW, lastMessageAt: undefined }
  test("a landed clean lane whose child status is unknown is not removed", () => {
    const gate = idleGateAction(session, [{ lane: lane(), facts: facts({ landed: true, child: "unknown" }) }], policy)
    expect(gate.remove).toEqual([])
  })
  test("an unresolved lane is not announced as finished while the child's status is unknown", () => {
    const gate = idleGateAction(session, [{ lane: lane(), facts: facts({ child: "unknown" }) }], policy)
    expect(gate.message).toBeUndefined()
  })
  test("a landed clean lane whose child is running is not removed", () => {
    const gate = idleGateAction(session, [{ lane: lane(), facts: facts({ landed: true, child: "running" }) }], policy)
    expect(gate.remove).toEqual([])
  })
})
