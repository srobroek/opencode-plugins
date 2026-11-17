/**
 * The lane lifecycle adapter: it gathers facts from git, `gh`, `wt` and the host, hands
 * them to the pure decisions in `events.ts`, `landing.ts` and `sweep.ts`, and carries out
 * the answer. Four layers share it, each covering what the others miss:
 *  - lane sync on a landing (`delivery_land` / `delivery_cleanup` results),
 *  - session execution events (failed, interrupted, succeeded, idle), debounced,
 *  - `experimental.idle` gates for a child and for a lead,
 *  - a throttled backstop sweep.
 * Every removal is a non-force host removal; nothing here deletes a remote branch.
 */

import { existsSync, realpathSync } from "node:fs"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { landingsFor, listLandings } from "@srobroek/opencode-lib/worktree-claims"
import { OPERATION_MARKERS, operationsInProgress, stashesOnBranch } from "@srobroek/opencode-lib/worktree-state"
import {
  type BackgroundJob,
  childNudge,
  failureReason,
  idleGateAction,
  type LaneAction,
  type LaneEvent,
  type LaneFacts,
  type LanePolicy,
  landedDirtyNotice,
  laneBackgroundWork,
  laneEventAction,
  outcomeNotice,
  stateToken,
} from "./events.ts"
import type { Git } from "./git.ts"
import { LANDING_TOOLS, laneForLanding } from "./landing.ts"
import { isRunning, type Lane, type Options } from "./lane.ts"
import { formatPlan, type PlanEntry, planSweep, type WorktreeFacts } from "./sweep.ts"

/** Epoch milliseconds from a number, Date or date string; undefined otherwise. */
export function toMillis(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const HOUR = 3_600_000
const PROOF_TTL_MS = 5 * 60_000
const EVENT_TYPES = [
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.succeeded",
  "session.idle",
  "session.created",
] as const
const PRIORITY: Record<string, number> = { idle: 0, succeeded: 1, interrupted: 2, failed: 3 }

type SessionLike = { id: string; parentID?: string; projectID: string; location: { directory: string }; time?: Record<string, unknown> }

export type LifecycleDeps = {
  ctx: Context
  options: Options
  git: Git
  now: () => number
  exists: (path: string) => Promise<boolean>
  lookupMs: number
  load: (child: string) => Promise<Lane | undefined>
  save: (lane: Lane) => Promise<unknown>
  scan: () => Promise<Lane[]>
  getSession: (sessionID: string) => Promise<SessionLike | undefined>
  moveHome: (lane: Lane) => Promise<void>
  removeWorktree: (projectID: string, directory: string, force: boolean) => Promise<void>
  /** Debounce for the event pass; the brief asks for about 2 s. */
  debounceMs?: number
  sweepDelayMs?: number
  worktreeRoot?: string
  /** The repository's git common directory, where claims and delivery's landing records live. */
  commonDir: (directory: string) => Promise<string | undefined>
  /** Make sure the lane's claim file exists (it is the lane's protection from every other remover). */
  ensureClaim: (lane: Lane) => Promise<void>
  /** Test seam: how long ago a worktree was created. */
  age?: (directory: string) => Promise<number | undefined>
}

export const canonical = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function defaultWorktreeRoot(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "worktree")
}

function within(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, "")
  return path === base || path.startsWith(`${base}/`)
}

export function createLifecycle(deps: LifecycleDeps) {
  const { ctx, options, git, now, load, save } = deps
  const policy: LanePolicy = { resumeGraceMs: options.resumeGraceMs, emptyGraceMs: options.emptyGraceMs }
  const debounceMs = deps.debounceMs ?? 2000
  const root = canonical(deps.worktreeRoot ?? defaultWorktreeRoot())
  const projectID = (ctx.location as { project?: { id?: string } }).project?.id

  let disposed = false
  let gatesActive = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const pending = new Map<string, { type: string; reason?: string; id?: string; timer: ReturnType<typeof setTimeout> }>()
  const lastGate = new Map<string, number>()

  /** One chain for event passes, gates and sweeps' lane writes, so a lane is never handled twice at once. */
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next
  }
  let sweepChain: Promise<unknown> = Promise.resolve()

  // --- session status ---------------------------------------------------------------------

  const withinLookup = async <T>(work: Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), deps.lookupMs)
    })
    try {
      return await Promise.race([work.catch(() => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** running / finished from `session.get`; unknown when the lookup fails or times out. */
  const statusOf = async (sessionID: string): Promise<"running" | "finished" | "unknown"> => {
    const session = await withinLookup(deps.getSession(sessionID))
    if (!session) return "unknown"
    return isRunning({ busy: toMillis(session.time?.busy), idle: toMillis(session.time?.idle) }) ? "running" : "finished"
  }

  // --- landed proofs ------------------------------------------------------------------------

  type Proofs = { at: number; merged: Set<string>; open: Set<string>; integrated: Set<string> }
  const proofCache = new Map<string, Proofs>()

  /** One batched read per repository: merged PR heads, open PR branches, and `wt`'s integrated branches. Cached a few minutes. */
  const proofsFor = async (parentDir: string): Promise<Proofs> => {
    const cached = proofCache.get(parentDir)
    if (cached && now() - cached.at < PROOF_TTL_MS) return cached
    const proofs: Proofs = { at: now(), merged: new Set(), open: new Set(), integrated: new Set() }
    const json = async (argv: string[]): Promise<unknown> => {
      const result = await git.run(argv, { cwd: parentDir })
      if (result.code !== 0) return undefined
      try {
        return JSON.parse(result.stdout)
      } catch {
        return undefined
      }
    }
    const [merged, open, listed] = await Promise.all([
      json(["gh", "pr", "list", "--state", "merged", "--json", "headRefOid", "--limit", "200"]),
      json(["gh", "pr", "list", "--state", "open", "--json", "headRefName", "--limit", "200"]),
      json(["wt", "-C", parentDir, "list", "--format", "json"]),
    ])
    for (const pr of Array.isArray(merged) ? merged : []) {
      const oid = (pr as { headRefOid?: unknown }).headRefOid
      if (typeof oid === "string") proofs.merged.add(oid)
    }
    for (const pr of Array.isArray(open) ? open : []) {
      const name = (pr as { headRefName?: unknown }).headRefName
      if (typeof name === "string") proofs.open.add(name)
    }
    const items = (listed as { items?: unknown } | undefined)?.items
    for (const item of Array.isArray(items) ? items : []) {
      // Keyed by commit, never by branch name: a branch that gained a commit since is not integrated.
      const entry = item as { head?: { sha?: unknown }; display?: { state?: unknown } }
      if (typeof entry.head?.sha === "string" && entry.display?.state === "integrated") proofs.integrated.add(entry.head.sha)
    }
    proofCache.set(parentDir, proofs)
    return proofs
  }

  /** The tree holds something git status does not show: a stash on the branch or an operation in progress. */
  const busyTreeOf = async (directory: string, branch: string | undefined): Promise<string | undefined> => {
    const dir = await git.gitDir(directory)
    if (dir !== undefined) {
      const operations = operationsInProgress(OPERATION_MARKERS.map((marker) => marker.name).filter((name) => existsSync(join(dir, name))))
      if (operations.length > 0) return `a ${operations.join(", ")} is in progress`
    }
    if (branch !== undefined) {
      const stash = await git.stashSubjects(directory)
      if (stash === undefined) return "stashes could not be read"
      if (stashesOnBranch(stash, branch).length > 0) return `a stash exists on ${branch}`
    }
    return undefined
  }

  /** What delivery's landing records say about `directory`: the heads it landed, and why it must not be removed, if so. */
  const deliveryRecords = async (directory: string, parentDir: string): Promise<{ heads: string[]; block: string | undefined }> => {
    const common = await deps.commonDir(parentDir)
    if (common === undefined) return { heads: [], block: "delivery's records cannot be located" }
    const listed = listLandings(common)
    const mine = landingsFor(listed.records, directory)
    const heads = mine.map((record) => record.headRefOid)
    if (listed.unreadable) return { heads, block: "delivery's landing records cannot be read" }
    const denied = mine.find((record) => record.denied !== undefined)
    return { heads, block: denied ? "delivery cleanup was denied; an explicit delivery_cleanup re-arms it" : undefined }
  }

  /** Worktrees the idle gate found busy (a job of the child or a descendant, or a shell in the lane), until the gate sees them clear. */
  const busyHolds = new Map<string, { reason: string; until: number }>()
  const BUSY_HOLD_MS = HOUR
  const busyHold = (directory: string): string | undefined => {
    const held = busyHolds.get(canonical(directory))
    return held !== undefined && held.until > now() ? held.reason : undefined
  }

  const dirtyToken = (porcelain: string): string => (porcelain === "" ? "clean" : String(Bun.hash(porcelain)))

  const laneFacts = async (
    lane: Lane,
    sessions: { child: LaneFacts["child"]; parent: LaneFacts["parent"] },
  ): Promise<LaneFacts> => {
    const base = { child: sessions.child, parent: sessions.parent, now: now() }
    if (!(await deps.exists(lane.directory))) {
      return { ...base, exists: false, ahead: undefined, dirty: undefined, dirtyToken: "gone", busyTree: undefined, tip: undefined, landed: false, openPr: false, denied: undefined }
    }
    const [status, porcelain, tip] = await Promise.all([git.status(lane.directory, lane.base), git.porcelain(lane.directory), git.head(lane.directory)])
    const busyTree = status === undefined ? undefined : await busyTreeOf(lane.directory, lane.branch)
    const records = await deliveryRecords(lane.directory, lane.parentDir)
    let landed = false
    let openPr = false
    if (status !== undefined && tip !== undefined && status.ahead > 0) {
      // A head delivery recorded as landed counts only for the commit that is still the tip.
      landed = records.heads.includes(tip) || (await git.isAncestor(lane.directory, tip, "origin/main"))
      if (!landed) {
        const proofs = await proofsFor(lane.parentDir)
        landed = proofs.merged.has(tip) || proofs.integrated.has(tip)
        openPr = proofs.open.has(lane.branch)
      }
    }
    return {
      ...base,
      exists: true,
      ahead: status?.ahead,
      dirty: porcelain === undefined ? undefined : porcelain !== "",
      dirtyToken: dirtyToken(porcelain ?? ""),
      busyTree,
      tip,
      landed,
      openPr,
      denied: records.block,
    }
  }

  // --- one fence for every removal ----------------------------------------------------------

  /** Bumped by a resume; a removal that collected its facts under an older number does not run. */
  const generations = new Map<string, number>()
  const locks = new Map<string, Promise<unknown>>()
  const generationOf = (directory: string) => generations.get(canonical(directory)) ?? 0

  /** One at a time per directory: removals, the resume bump and sweep removals all pass here. */
  const withLock = <T>(directory: string, work: () => Promise<T>): Promise<T> => {
    const key = canonical(directory)
    const next = (locks.get(key) ?? Promise.resolve()).then(work, work)
    locks.set(key, next.catch(() => {}))
    return next
  }

  /** A `subagent` call is about to resume the child of this lane: waits for an in-flight removal, then fences later ones. */
  const noteResume = (directory: string) =>
    withLock(directory, async () => {
      generations.set(canonical(directory), generationOf(directory) + 1)
    })

  type Removal = {
    directory: string
    projectID: string
    branch: string | undefined
    parentDir: string
    /** The commit the landed proof covered. */
    oid: string
    /** The generation read before the facts were collected. */
    gen: number
    /** The lane whose child is moved home first. */
    lane?: Lane
    /** Run under the lock, right before the removal: the refusal to honour, if any. */
    recheck?: () => Promise<string | undefined>
  }

  /**
   * The only removal path. Under the directory lock, and right before removing: the resume
   * generation is unchanged, HEAD is still the proven commit, and the tree is still clean. The
   * local branch is deleted only when the worktree was on it (not detached) and it still points
   * at the proven commit, with a compare-and-delete that fails if the ref moved.
   */
  const removeVerified = (removal: Removal): Promise<boolean> =>
    withLock(removal.directory, async () => {
      const { directory, branch, oid } = removal
      if (generationOf(directory) !== removal.gen) return false
      if ((await git.head(directory)) !== oid) return false
      if ((await git.porcelain(directory)) !== "") return false
      if ((await busyTreeOf(directory, branch)) !== undefined) return false
      if ((await removal.recheck?.()) !== undefined) return false
      let deleteBranch = false
      if (branch !== undefined && (await git.branch(directory)) === branch) {
        // On the branch: the ref must still be the commit the proof covered, or something moved it.
        if ((await git.commit(removal.parentDir, `refs/heads/${branch}`)) !== oid) return false
        deleteBranch = true
      }
      try {
        if (removal.lane) await deps.moveHome(removal.lane)
        await deps.removeWorktree(removal.projectID, directory, false)
      } catch {
        if (removal.lane && (await deps.exists(directory))) {
          await ctx.session.move({ sessionID: removal.lane.child, directory } as never).catch(() => {})
        }
        return false
      }
      await ctx.worktree.refresh({ projectID: removal.projectID } as never).catch(() => {})
      if (deleteBranch && branch !== undefined) await git.deleteBranchAt(removal.parentDir, branch, oid)
      return true
    })

  // --- actions ------------------------------------------------------------------------------

  const mark = async (child: string, key: string) => {
    const lane = await load(child)
    if (!lane) return
    await save({ ...lane, notices: [...(lane.notices ?? []), key].slice(-20) })
  }

  const send = async (sessionID: string, text: string): Promise<boolean> => {
    try {
      await ctx.session.synthetic({ sessionID, text } as never)
      return true
    } catch {
      return false
    }
  }

  /**
   * What must still be true at the moment of removal, read fresh under the lock: delivery has not
   * denied or hidden its records, the idle gate has not found work running, the child is finished
   * and the parent idle now. `parentIdle` is true only when the idle hook itself is the evidence.
   */
  const recheckFor =
    (lane: Lane | undefined, directory: string, parentDir: string, parentIdle: boolean) => async (): Promise<string | undefined> => {
      const records = await deliveryRecords(directory, parentDir)
      if (records.block !== undefined) return records.block
      const busy = busyHold(directory)
      if (busy !== undefined) return busy
      if (lane === undefined) return undefined
      if ((await statusOf(lane.child)) !== "finished") return "the child is not finished now"
      if (!parentIdle && (await statusOf(lane.parent)) !== "finished") return "the parent is not idle now"
      return undefined
    }

  /** A lane's removal, fenced by the generation read before its facts were collected. */
  const removeLane = async (lane: Lane, basis: "landed" | "empty", facts: LaneFacts, gen: number, parentIdle = false): Promise<boolean> => {
    if (facts.tip === undefined) return false
    const removed = await removeVerified({
      directory: lane.directory,
      projectID: lane.projectID,
      branch: lane.branch,
      parentDir: lane.parentDir,
      oid: facts.tip,
      gen,
      lane,
      recheck: recheckFor(lane, lane.directory, lane.parentDir, parentIdle),
    })
    if (!removed) return false
    const fresh = (await load(lane.child)) ?? lane
    await save({ ...fresh, state: basis === "landed" ? "landed" : "removed" })
    return true
  }

  const act = async (lane: Lane, action: LaneAction, facts: LaneFacts, event: LaneEvent, gen: number) => {
    if (action.action === "remove") return removeLane(lane, action.basis, facts, gen)
    if (action.action === "defer" && action.quiet) {
      const quietSince = action.quiet === "start" ? facts.now : undefined
      if (lane.quietSince !== quietSince) await save({ ...((await load(lane.child)) ?? lane), ...(quietSince === undefined ? { quietSince: undefined } : { quietSince }) })
      return
    }
    if (action.action === "notifyParent") {
      const text = action.key.startsWith("landed-dirty")
        ? landedDirtyNotice(lane)
        : outcomeNotice(lane, lane.outcome?.kind ?? (event.type === "interrupted" ? "interrupted" : "failed"), lane.outcome?.reason ?? "no reason given", facts)
      if (await send(lane.parent, text)) await mark(lane.child, action.key)
      return
    }
    if (action.action === "notifyChild") {
      // With the idle gate registered it owns this nudge (one source); keys keep either path from repeating.
      if (gatesActive && event.type !== "idle") return
      if (await send(lane.child, childNudge(lane))) await mark(lane.child, action.key)
    }
  }

  // --- execution events ---------------------------------------------------------------------

  const TERMINAL = new Set(["succeeded", "idle", "failed", "interrupted"])

  const pass = async (sessionID: string, type: string, reason: string | undefined, eventID: string | undefined) => {
    const lanes = await deps.scan()
    const own = lanes.find((lane) => lane.child === sessionID && lane.state === "active")
    const led = lanes.filter((lane) => lane.parent === sessionID && lane.child !== sessionID && lane.state === "active")
    if (own === undefined && led.length === 0) return
    for (const lane of [...(own ? [own] : []), ...led]) await deps.ensureClaim(lane)
    const eventType = type as LaneEvent["type"]
    let ownLane = own
    if (ownLane && (type === "failed" || type === "interrupted")) {
      const why = reason ?? "no reason given"
      // Identity of the outcome, never its time: a replayed event keeps its key, a new failure gets a new one.
      const id = eventID ?? `h${Bun.hash(`${sessionID}:${type}:${why}`)}`
      ownLane = { ...ownLane, outcome: { kind: type, at: now(), reason: why, id }, quietSince: undefined }
      await save(ownLane)
    }
    if (ownLane) {
      const event: LaneEvent = { type: eventType, subject: "child" }
      const gen = generationOf(ownLane.directory)
      const parent = await statusOf(ownLane.parent)
      const facts = await laneFacts(ownLane, { child: "finished", parent: parent === "finished" ? "idle" : parent === "running" ? "busy" : "unknown" })
      await act(ownLane, laneEventAction(ownLane, facts, event, policy), facts, event, gen)
    }
    for (const lane of led) {
      const event: LaneEvent = { type: "check", subject: "parent" }
      const gen = generationOf(lane.directory)
      const child = await statusOf(lane.child)
      const fresh = (await load(lane.child)) ?? lane
      // The parent's status is read now: an event does not say it is still idle after the debounce.
      const parentStatus = await statusOf(sessionID)
      const facts = await laneFacts(fresh, { child, parent: parentStatus === "finished" ? "idle" : parentStatus === "running" ? "busy" : "unknown" })
      await act(fresh, laneEventAction(fresh, facts, event, policy), facts, event, gen)
    }
  }

  const schedule = (sessionID: string, type: string, reason?: string, id?: string) => {
    if (disposed) return
    const held = pending.get(sessionID)
    if (held) {
      // succeeded + idle for one execution are one pass; the stronger outcome wins.
      if ((PRIORITY[type] ?? 0) > (PRIORITY[held.type] ?? 0)) {
        held.type = type
        if (reason !== undefined) held.reason = reason
        if (id !== undefined) held.id = id
      }
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      const entry = pending.get(sessionID)
      pending.delete(sessionID)
      if (!entry || disposed) return
      void serial(() => pass(sessionID, entry.type, entry.reason, entry.id)).catch((error) => console.error("subagent-worktree: lane pass failed", error))
    }, debounceMs)
    timers.add(timer)
    pending.set(sessionID, { type, ...(reason === undefined ? {} : { reason }), ...(id === undefined ? {} : { id }), timer })
  }

  /** Feed one server event. Cheap: it only schedules. */
  const handleEvent = (raw: unknown) => {
    const event = raw as { id?: unknown; type?: string; data?: { sessionID?: unknown; error?: unknown; reason?: unknown } }
    const eventID = typeof event.id === "string" ? event.id : undefined
    if (event.type === "session.created") {
      void maybeSweep()
      return
    }
    const sessionID = event.data?.sessionID
    if (typeof sessionID !== "string") return
    switch (event.type) {
      case "session.execution.failed":
        return schedule(sessionID, "failed", failureReason(event.data?.error), eventID)
      case "session.execution.interrupted":
        return schedule(sessionID, "interrupted", typeof event.data?.reason === "string" ? event.data.reason : "interrupted", eventID)
      case "session.execution.succeeded":
        return schedule(sessionID, "succeeded")
      case "session.idle":
        return schedule(sessionID, "idle")
    }
  }

  // --- idle gates ---------------------------------------------------------------------------

  type IdleInput = { sessionID: string; background?: ReadonlyArray<BackgroundJob> }

  /** Whether `sessionID` descends from `ancestor`: true, false, or undefined when a lookup failed. */
  const descends = async (sessionID: string, ancestor: string): Promise<boolean | undefined> => {
    let current: string | undefined = sessionID
    for (let depth = 0; depth < 8 && current !== undefined; depth++) {
      if (current === ancestor) return depth > 0
      const session: SessionLike | undefined = await withinLookup(deps.getSession(current))
      if (!session) return undefined
      current = session.parentID
    }
    return current === undefined ? false : undefined
  }

  const onIdle = async (input: IdleInput) => {
    if (disposed) return
    await serial(async () => {
      const lanes = (await deps.scan()).filter((lane) => lane.state === "active" && (lane.child === input.sessionID || lane.parent === input.sessionID))
      if (lanes.length === 0) return
      for (const lane of lanes) await deps.ensureClaim(lane)
      const jobs = input.background ?? []
      const running = new Set<string>()
      const gateLanes = await Promise.all(
        lanes.map(async (lane) => {
          const gen = generationOf(lane.directory)
          // Every kind of job counts, and the child's status is read, not inferred from the list.
          const known = new Map<string, boolean | undefined>()
          for (const job of jobs) {
            for (const id of [job.sessionID, job.childSessionID]) {
              if (typeof id === "string" && !known.has(id)) known.set(id, id === lane.child ? true : await descends(id, lane.child))
            }
          }
          const busy = laneBackgroundWork(lane, jobs, (id) => known.get(id))
          if (lane.parent === input.sessionID) {
            // The lead's own list is the evidence; share it with the event pass and the sweep until it clears.
            if (busy !== undefined) busyHolds.set(canonical(lane.directory), { reason: busy, until: now() + BUSY_HOLD_MS })
            else busyHolds.delete(canonical(lane.directory))
          }
          if (busy !== undefined && lane.parent === input.sessionID) running.add(lane.child)
          const child = busy !== undefined ? "running" : await statusOf(lane.child)
          if (child === "running" && lane.parent === input.sessionID) running.add(lane.child)
          return { lane, gen, facts: await laneFacts(lane, { child, parent: lane.parent === input.sessionID ? "idle" : "unknown" }) }
        }),
      )
      const gens = new Map(gateLanes.map((entry) => [entry.lane.child, entry.gen]))
      const gate = idleGateAction(
        { id: input.sessionID, runningChildren: running, now: now(), lastMessageAt: lastGate.get(input.sessionID) },
        gateLanes.map(({ lane, facts }) => ({ lane, facts })),
        policy,
      )
      for (const { lane, basis } of gate.remove) {
        const facts = gateLanes.find((entry) => entry.lane.child === lane.child)?.facts
        if (facts) await removeLane(lane, basis, facts, gens.get(lane.child) ?? generationOf(lane.directory), lane.parent === input.sessionID)
      }
      if (gate.message === undefined) return
      if (await send(input.sessionID, gate.message)) {
        lastGate.set(input.sessionID, now())
        for (const { child, key } of gate.marks) await mark(child, key)
      }
    })
  }

  // --- landings -----------------------------------------------------------------------------

  const onLanding = async (event: { tool: string; status: string; result?: unknown }) => {
    if (!LANDING_TOOLS.includes(event.tool) || event.status !== "completed") return
    const lanes = (await deps.scan()).filter((lane) => lane.state === "active")
    if (lanes.length === 0) return
    const gone = (path: string) => !existsSync(path)
    const lane = laneForLanding(event.result, lanes, canonical, gone)
    if (lane) {
      await save({ ...((await load(lane.child)) ?? lane), state: "landed" })
      await ctx.worktree.refresh({ projectID: lane.projectID } as never).catch(() => {})
      return
    }
  }

  // --- sweep --------------------------------------------------------------------------------

  const sweepKey = () => `sweep/at/${projectID ?? "none"}`

  type Entry = { directory: string }

  /** Who works in `directory`: "unknown" (so the worktree is kept) unless every page of the lookup was read. */
  const ownerOf = async (directory: string, minAgeMs: number): Promise<WorktreeFacts["owner"]> => {
    if (projectID === undefined) return "unknown"
    let query: Record<string, unknown> = { project: projectID, directory, archived: false, limit: 100 }
    for (let pages = 0; pages < 20; pages++) {
      const page = (await withinLookup(Promise.resolve(ctx.session.list(query as never)))) as
        | { data?: unknown; cursor?: { next?: string } }
        | undefined
      if (!page || !Array.isArray(page.data)) return "unknown"
      for (const raw of page.data as Array<{ time?: Record<string, unknown> }>) {
        const busy = toMillis(raw.time?.busy)
        const idle = toMillis(raw.time?.idle)
        const updated = toMillis(raw.time?.updated)
        if (isRunning({ busy, idle }) || (updated !== undefined && now() - updated < minAgeMs)) return "yes"
      }
      const next = page.cursor?.next
      if (!next) return "no"
      query = { cursor: next }
    }
    return "unknown"
  }

  const ageOf = async (directory: string): Promise<number | undefined> => {
    try {
      const info = await stat(join(directory, ".git"))
      const born = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs
      return Math.max(0, now() - born)
    } catch {
      return undefined
    }
  }

  const sweepFacts = async (directory: string, lane: Lane | undefined, minAgeMs: number): Promise<WorktreeFacts> => {
    const agentPath = lane !== undefined || [root, ...options.include.map(canonical)].some((base) => within(canonical(directory), base))
    const base = { path: directory, agentPath, ...(lane ? { branch: lane.branch } : {}) }
    if (!(await deps.exists(directory))) return { ...base, exists: false, owner: "unknown", ageMs: undefined, landed: false, dirty: undefined, ahead: undefined, unpushed: false }
    const records = await deliveryRecords(directory, lane?.parentDir ?? ctx.location.directory)
    const branch = lane?.branch ?? (await git.branch(directory))
    const [tip, porcelain, owner, ageMs] = await Promise.all([git.head(directory), git.porcelain(directory), ownerOf(directory, minAgeMs), (deps.age ?? ageOf)(directory)])
    const status = await git.status(directory, "origin/main")
    const busy = await busyTreeOf(directory, branch)
    let landed = false
    if (tip !== undefined && status !== undefined) {
      landed = records.heads.includes(tip) || status.ahead === 0 || (await git.isAncestor(directory, tip, "origin/main"))
      if (!landed) {
        const parentDir = lane?.parentDir ?? ctx.location.directory
        const proofs = await proofsFor(parentDir)
        landed = proofs.merged.has(tip) || proofs.integrated.has(tip)
      }
    }
    const behindRemote = await git.run(["git", "-C", directory, "rev-list", "--count", "@{upstream}..HEAD"])
    const unpushed = behindRemote.code === 0 ? Number.parseInt(behindRemote.stdout.trim(), 10) > 0 : (status?.ahead ?? 0) > 0
    return {
      ...base,
      ...(branch ? { branch } : {}),
      exists: true,
      owner,
      ageMs,
      landed,
      // A denial (or unreadable records) or a gate-held worktree reads as "dirty": quarantined, never pruned.
      dirty: porcelain === undefined ? undefined : porcelain !== "" || busy !== undefined || records.block !== undefined || busyHold(directory) !== undefined,
      ahead: status?.ahead,
      unpushed,
    }
  }

  /** The plan for this project; with mode "prune" it is also carried out. Never forces, never touches a remote. */
  const sweep = async (mode: "report" | "prune"): Promise<{ plan: PlanEntry[]; text: string }> => {
    if (projectID === undefined) return { plan: [], text: "subagent_worktree_sweep: the host reports no project." }
    const minAgeMs = options.minAgeHours * HOUR
    const listed = (await withinLookup(Promise.resolve(ctx.worktree.list({ projectID } as never)))) as readonly Entry[] | undefined
    const lanes = (await deps.scan()).filter((lane) => lane.state === "active" && lane.projectID === projectID)
    const byDir = new Map(lanes.map((lane) => [canonical(lane.directory), lane]))
    const directories = new Map<string, string>()
    for (const entry of listed ?? []) directories.set(canonical(entry.directory), entry.directory)
    for (const lane of lanes) directories.set(canonical(lane.directory), lane.directory)
    const facts: WorktreeFacts[] = []
    const proven = new Map<string, { oid: string | undefined; gen: number }>()
    for (const [key, directory] of directories) {
      // The commit and generation are read first: the removal runs only if both are unchanged.
      const gen = generationOf(directory)
      const oid = (await deps.exists(directory)) ? await git.head(directory) : undefined
      facts.push(await sweepFacts(directory, byDir.get(key), minAgeMs))
      proven.set(key, { oid, gen })
    }
    const plan = planSweep(facts, { minAgeMs })
    if (mode === "prune") {
      for (const entry of plan) {
        if (entry.verdict === "prune-registry") {
          await git.pruneWorktrees(ctx.location.directory)
          continue
        }
        if (entry.verdict !== "prune") continue
        const key = canonical(entry.path)
        const lane = byDir.get(key)
        const covered = proven.get(key)
        if (covered?.oid === undefined) continue
        const removed = await removeVerified({
          directory: entry.path,
          projectID,
          branch: entry.deleteBranch ? entry.branch : undefined,
          parentDir: lane?.parentDir ?? ctx.location.directory,
          oid: covered.oid,
          gen: covered.gen,
          ...(lane ? { lane } : {}),
          recheck: recheckFor(lane, entry.path, lane?.parentDir ?? ctx.location.directory, false),
        })
        if (removed && lane) await save({ ...((await load(lane.child)) ?? lane), state: "landed" })
      }
    }
    await ctx.storage.set("sweep/last", { at: now(), mode, plan })
    return { plan, text: formatPlan(plan, mode) }
  }

  const runSweep = (mode: "report" | "prune") => {
    const next = sweepChain.then(() => sweep(mode))
    sweepChain = next.catch(() => {})
    return next
  }

  /** The background sweep: off, or throttled to once per `intervalHours` per project. */
  const maybeSweep = async () => {
    if (disposed || options.sweep === "off" || projectID === undefined) return
    try {
      const last = (await ctx.storage.get(sweepKey())) as number | undefined
      if (typeof last === "number" && now() - last < options.intervalHours * HOUR) return
      await ctx.storage.set(sweepKey(), now())
      await runSweep(options.sweep)
    } catch (error) {
      console.error("subagent-worktree: sweep failed", error)
    }
  }

  /** Record an explicit keep: the gate stays quiet about this lane until its state token changes. */
  const keep = async (child: string, reason: string): Promise<Lane | undefined> => {
    const lane = await load(child)
    if (lane?.state !== "active") return undefined
    const facts = await laneFacts(lane, { child: "unknown", parent: "unknown" })
    const kept = { ...lane, kept: { reason, token: stateToken(facts) } }
    await save(kept)
    return kept
  }

  // --- registration -------------------------------------------------------------------------

  const registrations: Array<{ dispose: () => Promise<void> }> = []
  const abort = new AbortController()
  let iterator: AsyncIterator<unknown> | undefined

  const start = async () => {
    iterator = ctx.event.subscribe({ types: [...EVENT_TYPES], signal: abort.signal } as never)[Symbol.asyncIterator]()
    const events = iterator
    void (async () => {
      for (;;) {
        const next = await events.next().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        try {
          handleEvent(next.value)
        } catch (error) {
          console.error("subagent-worktree: event handling failed", error)
        }
      }
    })()
    if (options.gates) {
      try {
        registrations.push(await ctx.session.hook("experimental.idle" as never, onIdle as never))
        gatesActive = true
      } catch {
        gatesActive = false
      }
    }
    if (options.sweep !== "off") {
      const timer = setTimeout(() => {
        timers.delete(timer)
        void maybeSweep()
      }, deps.sweepDelayMs ?? 30_000)
      timers.add(timer)
    }
  }

  const dispose = async () => {
    disposed = true
    abort.abort()
    await iterator?.return?.()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    pending.clear()
    for (const registration of registrations.reverse()) await registration.dispose()
    await Promise.allSettled([chain, sweepChain])
  }

  /** Wait for scheduled and running passes; for tests and shutdown. */
  const settle = async () => {
    while (pending.size > 0) await new Promise((done) => setTimeout(done, debounceMs + 1))
    await Promise.allSettled([chain, sweepChain])
  }

  return { start, dispose, handleEvent, onIdle, onLanding, keep, noteResume, sweep: runSweep, maybeSweep, settle }
}

export type Lifecycle = ReturnType<typeof createLifecycle>
