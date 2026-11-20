/**
 * Pure decisions for a lane's lifecycle: what a session event, an idle gate or a sweep
 * may do to a lane. The adapters in `lifecycle.ts` gather the facts and carry out the
 * answer; nothing here touches git, the host or a clock.
 *
 * A lane is removed only when its work is finished and landed:
 *  1. landed: its tip reached the base branch (ancestor, merged PR head, `wt` integrated,
 *     or the head `delivery_land` recorded);
 *  2. clean: no uncommitted or untracked change, stash, or operation in progress;
 *  3. the child is finished: not running, and it is known not to be;
 *  4. the parent is done with it: idle, and no `subagent` call resumed the child lately.
 * An empty lane waits for both sessions to stay idle for the grace period instead.
 */

import type { Lane } from "./lane.ts"

export type LaneEventType = "succeeded" | "idle" | "failed" | "interrupted" | "check"
/** `child`: the event is about the lane's own session. `parent`: it is about the session that owns the lane. */
export type LaneEvent = { type: LaneEventType; subject: "child" | "parent" }

export type LaneFacts = {
  /** The worktree directory exists. */
  exists: boolean
  /** Commits ahead of the lane base; undefined when git cannot read the worktree. */
  ahead: number | undefined
  /** `git status --porcelain` is not empty. */
  dirty: boolean | undefined
  /** A stable summary of the dirty state, for once-per-state notices. */
  dirtyToken: string
  /** A stash on the lane's branch or an operation in progress: not removable, not reportable as dirty. */
  busyTree: string | undefined
  /** Lane tip. */
  tip: string | undefined
  /** The tip reached the base branch. Only meaningful with commits ahead. */
  landed: boolean
  /** A pull request for the lane's branch is open. */
  openPr: boolean
  child: "running" | "finished" | "unknown"
  parent: "idle" | "busy" | "unknown"
  now: number
  /**
   * Why delivery's records forbid a removal: it was denied cleanup (until an explicit authorized
   * `delivery_cleanup` clears that), or its records cannot be read. Undefined when nothing does.
   */
  denied?: string | undefined
}

export type LanePolicy = { resumeGraceMs: number; emptyGraceMs: number }

export type LaneAction =
  | { action: "remove"; reason: string; basis: "landed" | "empty" }
  | { action: "notifyParent" | "notifyChild"; reason: string; key: string }
  | { action: "defer"; reason: string; quiet?: "start" | "reset" }
  | { action: "ignore"; reason: string }

const MINUTE = 60_000

/** The identity of a landed-but-dirty notice: the landed head and the dirty state, never a time. */
export const landedDirtyKey = (facts: Pick<LaneFacts, "tip" | "dirtyToken">): string => `landed-dirty:${facts.tip ?? "?"}:${facts.dirtyToken}`

/**
 * Whether the state a notice key describes is still the state now (`facts` read fresh, under the lock).
 * A notice about a worktree that is gone, clean, or in another state is not sent.
 */
export function noticeStillHolds(key: string, facts: LaneFacts): boolean {
  if (!facts.exists) return false
  if (key.startsWith("landed-dirty:")) return facts.child === "finished" && facts.dirty === true && facts.landed && (facts.ahead ?? 0) > 0 && key === landedDirtyKey(facts)
  if (key.startsWith("child:dirty:")) return facts.dirty === true && key === `child:dirty:${facts.dirtyToken}`
  if (key.startsWith("unresolved:")) return facts.child === "finished" && facts.dirty === false && key === `unresolved:${stateToken(facts)}`
  return true
}

function sent(lane: Pick<Lane, "notices">, key: string): boolean {
  return lane.notices?.includes(key) === true
}

/** The first of conditions 3 and 4, and the tree's busy state, that is not met; undefined when all hold. */
export function unmetFinished(
  lane: Pick<Lane, "resumedAt">,
  facts: Pick<LaneFacts, "child" | "parent" | "now" | "busyTree">,
  policy: Pick<LanePolicy, "resumeGraceMs">,
): string | undefined {
  if (facts.child === "unknown") return "the child's status is unknown"
  if (facts.child === "running") return "the child is still running"
  if (facts.parent === "unknown") return "the parent's status is unknown"
  if (facts.parent === "busy") return "the parent is mid-turn"
  if (lane.resumedAt !== undefined && facts.now - lane.resumedAt < policy.resumeGraceMs) {
    return `the child was resumed ${Math.max(0, Math.round((facts.now - lane.resumedAt) / MINUTE))} min ago`
  }
  if (facts.busyTree !== undefined) return facts.busyTree
  return undefined
}

/** The token a lane's `keep` and its unresolved nudge are tied to: it changes when the lane does. */
export function stateToken(facts: Pick<LaneFacts, "tip" | "ahead" | "dirtyToken">): string {
  return `${facts.ahead ?? "?"}:${facts.tip ?? "?"}:${facts.dirtyToken}`
}

/**
 * What an event means for one lane. `lane` is undefined for a session that is not a lane
 * child; only an `active` lane is acted on. Repeats return `ignore`: every notice has a key
 * recorded on the lane once sent.
 */
export function laneEventAction(
  lane: Lane | undefined,
  facts: LaneFacts,
  event: LaneEvent,
  policy: LanePolicy,
): LaneAction {
  if (lane === undefined) return { action: "ignore", reason: "not a lane session" }
  if (lane.state !== "active") return { action: "ignore", reason: `lane is ${lane.state}` }
  if (!facts.exists || facts.ahead === undefined || facts.dirty === undefined) {
    return { action: "defer", reason: "the worktree cannot be read" }
  }
  const landed = facts.landed && facts.ahead > 0
  const failure = event.subject === "child" && (event.type === "failed" || event.type === "interrupted")

  // Only a failure is news while the child may still be working; every other notice waits for a child known to be finished.
  const childDone = facts.child === "finished"
  if (facts.dirty) {
    if (landed) {
      if (!childDone) return { action: "defer", reason: "landed, but the child is not known to be finished" }
      const key = landedDirtyKey(facts)
      return sent(lane, key)
        ? { action: "ignore", reason: "landed-but-dirty notice already sent" }
        : { action: "notifyParent", reason: "landed but has uncommitted changes", key }
    }
    if (failure) {
      const key = `parent:${event.type}:${lane.outcome?.id ?? ""}`
      return sent(lane, key)
        ? { action: "ignore", reason: `${event.type} notice already sent` }
        : { action: "notifyParent", reason: `child ${event.type} with uncommitted changes`, key }
    }
    if (event.subject === "child" && (event.type === "succeeded" || event.type === "idle")) {
      if (!childDone) return { action: "defer", reason: "the child is not known to be finished" }
      const key = `child:dirty:${facts.dirtyToken}`
      return sent(lane, key)
        ? { action: "ignore", reason: "commit nudge already sent for this state" }
        : { action: "notifyChild", reason: "finished with uncommitted changes", key }
    }
    return { action: "defer", reason: "the worktree has uncommitted changes" }
  }

  if (facts.denied !== undefined && (landed || facts.ahead === 0)) {
    return { action: "defer", reason: facts.denied }
  }

  if (facts.ahead > 0) {
    if (landed) {
      const unmet = unmetFinished(lane, facts, policy)
      return unmet === undefined
        ? { action: "remove", reason: "landed, clean, child finished and parent done", basis: "landed" }
        : { action: "defer", reason: `landed, but ${unmet}` }
    }
    if (failure) {
      const key = `parent:${event.type}:${lane.outcome?.id ?? ""}`
      return sent(lane, key)
        ? { action: "ignore", reason: `${event.type} notice already sent` }
        : { action: "notifyParent", reason: `child ${event.type} with commits`, key }
    }
    return { action: "defer", reason: "not landed" }
  }

  // No commits, clean: removed only after both sessions stay idle for the grace period.
  const unmet = unmetFinished(lane, facts, policy)
  if (unmet !== undefined) return { action: "defer", reason: `empty lane, but ${unmet}`, quiet: "reset" }
  if (lane.quietSince === undefined) {
    return { action: "defer", reason: "empty lane: the grace period starts now", quiet: "start" }
  }
  const quiet = facts.now - lane.quietSince
  if (quiet < policy.emptyGraceMs) {
    return { action: "defer", reason: `empty lane: idle ${Math.round(quiet / MINUTE)} of ${Math.round(policy.emptyGraceMs / MINUTE)} min` }
  }
  return { action: "remove", reason: "empty, and both sessions stayed idle past the grace period", basis: "empty" }
}

/** The structured error's message, or a short fallback. */
export function failureReason(error: unknown): string {
  if (typeof error === "string" && error !== "") return error.slice(0, 200)
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === "string" && message !== "" ? message.slice(0, 200) : "no reason given"
}

/** The parent's notice for a child that failed or was interrupted while its lane holds work. */
export function outcomeNotice(
  lane: Pick<Lane, "child" | "title" | "branch" | "directory">,
  kind: "failed" | "interrupted",
  reason: string,
  facts: Pick<LaneFacts, "ahead" | "dirty">,
): string {
  const what = kind === "failed" ? "failed" : "was interrupted"
  return `<system-reminder>Subagent ${lane.child} (${lane.title ?? "no description"}) ${what}: ${reason}. Its lane ${lane.branch} at ${lane.directory} has ${facts.ahead ?? "?"} commits ahead, uncommitted changes: ${facts.dirty ? "yes" : "no"}. Resume it with subagent sessionID ${lane.child}, merge it with subagent_worktree_merge, or discard it.</system-reminder>`
}

export function landedDirtyNotice(lane: Pick<Lane, "child" | "branch" | "directory">): string {
  return `<system-reminder>Lane ${lane.branch} (subagent ${lane.child}) has landed, but ${lane.directory} has uncommitted changes, so its worktree was kept. Commit, stash or discard them and it can be removed.</system-reminder>`
}

/** The parent's notice for a child that was archived or deleted while its lane holds work that cannot go yet. */
export function archivedKeptNotice(lane: Pick<Lane, "child" | "title" | "branch" | "directory">, why: string): string {
  return `<system-reminder>Subagent ${lane.child} (${lane.title ?? "no description"}) was archived or deleted, but its worktree ${lane.directory} (branch ${lane.branch}) was kept: ${why}. Commit or discard the work, merge it with subagent_worktree_merge, or remove the worktree yourself.</system-reminder>`
}

export function childNudge(lane: Pick<Lane, "directory">): string {
  return `<system-reminder>Commit your work in ${lane.directory}, or reply why it stays uncommitted.</system-reminder>`
}

export function unresolvedLine(lane: Pick<Lane, "branch">, ahead: number): string {
  return `Lane ${lane.branch} (${ahead} commits, child finished) is unresolved: merge it with subagent_worktree_merge, open a PR, or record keep/discard.`
}

/** The idle session, as the gate sees it. */
export type IdleSession = {
  id: string
  /** Child sessions still listed as running subagents in the idle hook's `background`. */
  runningChildren: ReadonlySet<string>
  now: number
  /** When the gate last sent this session a message; the per-session cap. */
  lastMessageAt: number | undefined
}

/** No more than one gate message per session in this window: the hook fires again after each admitted message. */
export const GATE_MIN_INTERVAL_MS = 15_000

export type GateLane = { lane: Lane; facts: LaneFacts }

export type IdleGate = {
  remove: Array<{ lane: Lane; basis: "landed" | "empty" }>
  message?: string
  /** Notice keys to record on lanes once the message is admitted. */
  marks: Array<{ child: string; key: string; line?: string }>
  /** Why nothing was said, for diagnostics. */
  quiet?: string
}

/**
 * What an idle session's gates do. The session's own lane (it is a lane child) gets the
 * commit nudge; the lanes it leads are removed when landed, or reported once when unresolved
 * or landed-but-dirty. One message at most, and none while one of its children runs.
 */
export function idleGateAction(session: IdleSession, lanes: readonly GateLane[], policy: LanePolicy): IdleGate {
  const remove: IdleGate["remove"] = []
  const marks: IdleGate["marks"] = []
  const lines: string[] = []
  let childMessage: string | undefined
  const childMarks: IdleGate["marks"] = []

  const own = lanes.find(({ lane }) => lane.child === session.id)
  if (own) {
    const action = laneEventAction(own.lane, own.facts, { type: "idle", subject: "child" }, policy)
    if (action.action === "notifyChild") {
      childMessage = childNudge(own.lane)
      childMarks.push({ child: own.lane.child, key: action.key })
    }
  }

  const led = lanes.filter(({ lane }) => lane.parent === session.id && lane.child !== session.id)
  const childRunning = led.some(({ lane }) => session.runningChildren.has(lane.child))
  for (const { lane, facts } of led) {
    if (session.runningChildren.has(lane.child)) continue
    // The child's status is what the adapter read, never inferred from its absence in `background`.
    const action = laneEventAction(lane, { ...facts, parent: "idle" }, { type: "idle", subject: "parent" }, policy)
    if (action.action === "remove") {
      remove.push({ lane, basis: action.basis })
      continue
    }
    if (action.action === "notifyParent") {
      const line = landedDirtyNotice(lane).replace(/^<system-reminder>|<\/system-reminder>$/g, "")
      lines.push(line)
      marks.push({ child: lane.child, key: action.key, line })
      continue
    }
    const ahead = facts.ahead ?? 0
    const unresolved =
      facts.child === "finished" &&
      action.action === "defer" &&
      action.reason === "not landed" &&
      ahead > 0 &&
      facts.dirty === false &&
      !facts.openPr &&
      lane.kept?.token !== stateToken(facts)
    const key = `unresolved:${stateToken(facts)}`
    if (unresolved && !(lane.notices ?? []).includes(key)) {
      const line = unresolvedLine(lane, ahead)
      lines.push(line)
      marks.push({ child: lane.child, key, line })
    }
  }

  const capped = session.lastMessageAt !== undefined && session.now - session.lastMessageAt < GATE_MIN_INTERVAL_MS
  if (capped) return { remove, marks: [], quiet: "message cap" }
  if (childMessage) return { remove, message: childMessage, marks: childMarks }
  if (childRunning) return { remove, marks: [], quiet: "a child is still running" }
  if (lines.length === 0) return { remove, marks: [] }
  return { remove, message: gateMessage(lines), marks }
}

/** The lead's one message for the lines of the notices it is still allowed to send. */
export const gateMessage = (lines: readonly string[]): string => `<system-reminder>${lines.join("\n")}</system-reminder>`

/** One entry of the idle hook's `background` list. */
export type BackgroundJob = { kind: string; sessionID?: string; childSessionID?: string; shellID?: string; command?: string }

/**
 * The background jobs that belong to a lane: a job the child owns, one a descendant of the child
 * owns (or started), or a shell whose command names the lane directory. `descendant(id)` says
 * whether session `id` descends from the child: true, false, or undefined when it could not be
 * established, which counts as belonging (and is marked `unplaced`).
 */
export function laneBackgroundJobs(
  lane: Pick<Lane, "child" | "directory">,
  jobs: readonly BackgroundJob[],
  descendant: (sessionID: string) => boolean | undefined,
): Array<{ job: BackgroundJob; why: string }> {
  const matched: Array<{ job: BackgroundJob; why: string }> = []
  for (const job of jobs) {
    const ids = [job.sessionID, job.childSessionID].filter((id): id is string => typeof id === "string")
    let why: string | undefined
    for (const id of ids) {
      if (id === lane.child) why = `the child has a ${job.kind} job running`
      else {
        const below = descendant(id)
        if (below === undefined) why = `a ${job.kind} job could not be placed relative to the child`
        else if (below) why = `a descendant of the child has a ${job.kind} job running`
      }
      if (why !== undefined) break
    }
    if (why === undefined && job.kind === "shell" && typeof job.command === "string" && job.command.includes(lane.directory)) {
      why = "a shell is running in the lane"
    }
    if (why !== undefined) matched.push({ job, why })
  }
  return matched
}

/** Why a lane's child still has work running, or undefined. */
export function laneBackgroundWork(
  lane: Pick<Lane, "child" | "directory">,
  jobs: readonly BackgroundJob[],
  descendant: (sessionID: string) => boolean | undefined,
): string | undefined {
  return laneBackgroundJobs(lane, jobs, descendant)[0]?.why
}
