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
import { OPERATION_MARKERS, operationsInProgress, stashesOnBranch } from "@srobroek/opencode-lib/worktree-state"
import {
  childNudge,
  failureReason,
  idleGateAction,
  type LaneAction,
  type LaneEvent,
  type LaneFacts,
  type LanePolicy,
  landedDirtyNotice,
  laneEventAction,
  outcomeNotice,
  stateToken,
  unmetFinished,
} from "./events.ts"
import type { Git } from "./git.ts"
import { cleanupHolds, LAND_TOOL, LANDING_TOOLS, landedHeadForLane, laneForLanding } from "./landing.ts"
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
  const pending = new Map<string, { type: string; reason?: string; timer: ReturnType<typeof setTimeout> }>()
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
      const entry = item as { branch?: unknown; display?: { state?: unknown } }
      if (typeof entry.branch === "string" && entry.display?.state === "integrated") proofs.integrated.add(entry.branch)
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

  const dirtyToken = (porcelain: string): string => (porcelain === "" ? "clean" : String(Bun.hash(porcelain)))

  const laneFacts = async (
    lane: Lane,
    sessions: { child: LaneFacts["child"]; parent: LaneFacts["parent"] },
  ): Promise<LaneFacts> => {
    const base = { child: sessions.child, parent: sessions.parent, now: now() }
    if (!(await deps.exists(lane.directory))) {
      return { ...base, exists: false, ahead: undefined, dirty: undefined, dirtyToken: "gone", busyTree: undefined, tip: undefined, landed: false, openPr: false }
    }
    const [status, porcelain, tip] = await Promise.all([git.status(lane.directory, lane.base), git.porcelain(lane.directory), git.head(lane.directory)])
    const busyTree = status === undefined ? undefined : await busyTreeOf(lane.directory, lane.branch)
    let landed = false
    let openPr = false
    if (status !== undefined && tip !== undefined && status.ahead > 0) {
      landed = lane.landedHead === tip || (await git.isAncestor(lane.directory, tip, "origin/main"))
      if (!landed) {
        const proofs = await proofsFor(lane.parentDir)
        landed = proofs.merged.has(tip) || proofs.integrated.has(lane.branch)
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
    }
  }

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

  /** Non-force host removal, then refresh, then (landed only) the local branch. A refusal keeps the lane. */
  const removeLane = async (lane: Lane, basis: "landed" | "empty"): Promise<boolean> => {
    try {
      await deps.moveHome(lane)
      await deps.removeWorktree(lane.projectID, lane.directory, false)
    } catch {
      if (await deps.exists(lane.directory)) await ctx.session.move({ sessionID: lane.child, directory: lane.directory } as never).catch(() => {})
      return false
    }
    await ctx.worktree.refresh({ projectID: lane.projectID } as never).catch(() => {})
    if (basis === "landed") await git.forceDeleteBranch(lane.parentDir, lane.branch)
    else await git.deleteBranch(lane.parentDir, lane.branch)
    const fresh = (await load(lane.child)) ?? lane
    await save({ ...fresh, state: basis === "landed" ? "landed" : "removed" })
    return true
  }

  const act = async (lane: Lane, action: LaneAction, facts: LaneFacts, event: LaneEvent) => {
    if (action.action === "remove") return removeLane(lane, action.basis)
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

  const pass = async (sessionID: string, type: string, reason: string | undefined) => {
    const lanes = await deps.scan()
    const own = lanes.find((lane) => lane.child === sessionID && lane.state === "active")
    const led = lanes.filter((lane) => lane.parent === sessionID && lane.child !== sessionID && lane.state === "active")
    if (own === undefined && led.length === 0) return
    const eventType = type as LaneEvent["type"]
    let ownLane = own
    if (ownLane && (type === "failed" || type === "interrupted")) {
      ownLane = { ...ownLane, outcome: { kind: type, at: now(), reason: reason ?? "no reason given" }, quietSince: undefined }
      await save(ownLane)
    }
    if (ownLane) {
      const event: LaneEvent = { type: eventType, subject: "child" }
      const parent = await statusOf(ownLane.parent)
      const facts = await laneFacts(ownLane, { child: "finished", parent: parent === "finished" ? "idle" : parent === "running" ? "busy" : "unknown" })
      await act(ownLane, laneEventAction(ownLane, facts, event, policy), facts, event)
    }
    for (const lane of led) {
      const event: LaneEvent = { type: "check", subject: "parent" }
      const child = await statusOf(lane.child)
      const fresh = (await load(lane.child)) ?? lane
      const facts = await laneFacts(fresh, { child, parent: TERMINAL.has(type) ? "idle" : "unknown" })
      await act(fresh, laneEventAction(fresh, facts, event, policy), facts, event)
    }
  }

  const schedule = (sessionID: string, type: string, reason?: string) => {
    if (disposed) return
    const held = pending.get(sessionID)
    if (held) {
      // succeeded + idle for one execution are one pass; the stronger outcome wins.
      if ((PRIORITY[type] ?? 0) > (PRIORITY[held.type] ?? 0)) {
        held.type = type
        if (reason !== undefined) held.reason = reason
      }
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      const entry = pending.get(sessionID)
      pending.delete(sessionID)
      if (!entry || disposed) return
      void serial(() => pass(sessionID, entry.type, entry.reason)).catch((error) => console.error("subagent-worktree: lane pass failed", error))
    }, debounceMs)
    timers.add(timer)
    pending.set(sessionID, { type, ...(reason === undefined ? {} : { reason }), timer })
  }

  /** Feed one server event. Cheap: it only schedules. */
  const handleEvent = (raw: unknown) => {
    const event = raw as { type?: string; data?: { sessionID?: unknown; error?: unknown; reason?: unknown } }
    if (event.type === "session.created") {
      void maybeSweep()
      return
    }
    const sessionID = event.data?.sessionID
    if (typeof sessionID !== "string") return
    switch (event.type) {
      case "session.execution.failed":
        return schedule(sessionID, "failed", failureReason(event.data?.error))
      case "session.execution.interrupted":
        return schedule(sessionID, "interrupted", typeof event.data?.reason === "string" ? event.data.reason : "interrupted")
      case "session.execution.succeeded":
        return schedule(sessionID, "succeeded")
      case "session.idle":
        return schedule(sessionID, "idle")
    }
  }

  // --- idle gates ---------------------------------------------------------------------------

  type IdleInput = { sessionID: string; background?: ReadonlyArray<{ kind: string; childSessionID?: string }> }

  const onIdle = async (input: IdleInput) => {
    if (disposed) return
    await serial(async () => {
      const lanes = (await deps.scan()).filter((lane) => lane.state === "active" && (lane.child === input.sessionID || lane.parent === input.sessionID))
      if (lanes.length === 0) return
      const running = new Set<string>()
      for (const job of input.background ?? []) if (job.kind === "subagent" && typeof job.childSessionID === "string") running.add(job.childSessionID)
      const gateLanes = await Promise.all(
        lanes.map(async (lane) => ({
          lane,
          facts: await laneFacts(lane, { child: running.has(lane.child) ? "running" : "finished", parent: lane.parent === input.sessionID ? "idle" : "unknown" }),
        })),
      )
      const gate = idleGateAction({ id: input.sessionID, runningChildren: running, now: now(), lastMessageAt: lastGate.get(input.sessionID) }, gateLanes, policy)
      for (const { lane, basis } of gate.remove) await removeLane(lane, basis)
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
    const merged = landedHeadForLane(event.result, lanes, canonical)
    if (merged) await save({ ...((await load(merged.lane.child)) ?? merged.lane), landedHead: merged.head })
  }

  /** `execute.before` on `delivery_land`: hold inline cleanup for every lane that is not finished yet. */
  const holdLanes = async (event: { tool: string; input: unknown }) => {
    if (event.tool !== LAND_TOOL) return
    const lanes = (await deps.scan()).filter((lane) => lane.state === "active")
    if (lanes.length === 0) return
    const reasons = new Map<string, string | undefined>()
    await Promise.all(
      lanes.map(async (lane) => {
        const [child, parent] = await Promise.all([statusOf(lane.child), statusOf(lane.parent)])
        reasons.set(lane.child, unmetFinished(lane, { child, parent: parent === "finished" ? "idle" : parent === "running" ? "busy" : "unknown", now: now(), busyTree: undefined }, policy))
      }),
    )
    const holds = cleanupHolds(lanes, (lane) => reasons.get(lane.child))
    if (holds.length > 0) event.input = { ...(event.input as object), cleanupHold: holds }
  }

  // --- sweep --------------------------------------------------------------------------------

  const sweepKey = () => `sweep/at/${projectID ?? "none"}`

  type Entry = { directory: string }

  const ownerOf = async (directory: string, minAgeMs: number): Promise<WorktreeFacts["owner"]> => {
    if (projectID === undefined) return "unknown"
    const page = (await withinLookup(Promise.resolve(ctx.session.list({ project: projectID, directory, archived: false, limit: 100 } as never)))) as
      | { data?: unknown }
      | undefined
    if (!page || !Array.isArray(page.data)) return "unknown"
    for (const raw of page.data as Array<{ time?: Record<string, unknown> }>) {
      const busy = toMillis(raw.time?.busy)
      const idle = toMillis(raw.time?.idle)
      const updated = toMillis(raw.time?.updated)
      if (isRunning({ busy, idle }) || (updated !== undefined && now() - updated < minAgeMs)) return "yes"
    }
    return "no"
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
    const branch = lane?.branch ?? (await git.branch(directory))
    const [tip, porcelain, owner, ageMs] = await Promise.all([git.head(directory), git.porcelain(directory), ownerOf(directory, minAgeMs), (deps.age ?? ageOf)(directory)])
    const status = await git.status(directory, "origin/main")
    const busy = await busyTreeOf(directory, branch)
    let landed = false
    if (tip !== undefined && status !== undefined) {
      landed = lane?.landedHead === tip || status.ahead === 0 || (await git.isAncestor(directory, tip, "origin/main"))
      if (!landed) {
        const parentDir = lane?.parentDir ?? ctx.location.directory
        const proofs = await proofsFor(parentDir)
        landed = proofs.merged.has(tip) || (branch !== undefined && proofs.integrated.has(branch))
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
      dirty: porcelain === undefined ? undefined : porcelain !== "" || busy !== undefined,
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
    for (const [key, directory] of directories) facts.push(await sweepFacts(directory, byDir.get(key), minAgeMs))
    const plan = planSweep(facts, { minAgeMs })
    if (mode === "prune") {
      for (const entry of plan) {
        if (entry.verdict === "prune-registry") {
          await git.pruneWorktrees(ctx.location.directory)
          continue
        }
        if (entry.verdict !== "prune") continue
        try {
          await deps.removeWorktree(projectID, entry.path, false)
        } catch {
          continue
        }
        await ctx.worktree.refresh({ projectID } as never).catch(() => {})
        if (entry.deleteBranch && entry.branch) await git.forceDeleteBranch(ctx.location.directory, entry.branch)
        const lane = byDir.get(canonical(entry.path))
        if (lane) await save({ ...((await load(lane.child)) ?? lane), state: "landed" })
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

  return { start, dispose, handleEvent, onIdle, onLanding, holdLanes, keep, sweep: runSweep, maybeSweep, settle }
}

export type Lifecycle = ReturnType<typeof createLifecycle>
