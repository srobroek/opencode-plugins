import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { type Result, Error as ToolError } from "@opencode/plugin/promise/tool"
import { toJsonSchema, withOptionalString } from "@srobroek/opencode-lib/tool-schema"
import { createGit, type Git, type Runner, spawnRunner } from "./git.ts"
import {
  annotation,
  blockingReservation,
  containingWorktree,
  decideIsolation,
  decideMerge,
  decideWriterGuard,
  FENCED_REASON,
  findWorktree,
  formatLaneList,
  isConflict,
  isRunning,
  LANE_PREFIX,
  type Lane,
  type LaneReport,
  laneKey,
  liveness,
  MERGE_TOOL,
  mergeArgs,
  type Options,
  parseLane,
  parseModel,
  parseWorktrees,
  planStart,
  RESERVATION_MS,
  type Reservation,
  readOptions,
  readSubagentInput,
  reservationStatus,
  resumeWorktreeNote,
  rewritePrompt,
  SESSION_LOOKUP_MS,
  SUBAGENT_TOOL,
  type SubagentInput,
  sessionIsReadOnly,
  shouldRemove,
  startPrompt,
  tail,
  UNBORN_NOTE,
  WORKTREE_PARAM,
  WORKTREE_PARAM_DESCRIPTION,
  type WriterSession,
  withoutWorktree,
  worktreeForBranch,
  worktreeName,
  writerRefusal,
} from "./lane.ts"

export * from "./git.ts"
export * from "./lane.ts"

export const MERGE_DESCRIPTION =
  "Merge a subagent's worktree branch back, report one lane, or list every active lane.\n" +
  "The subagent tool result names the lane (branch, base, sessionID). " +
  'method "wt-merge" runs `wt merge <target> --no-squash --no-ff --yes` from the subagent worktree, keeping its commits, ' +
  "and removes the worktree on success; a conflict keeps the worktree and reports the output. " +
  "The worktree must be committed and clean, and the target checkout must have no uncommitted or untracked changes to files the lane changes. " +
  'method "none" only reports the lane status. method "list" (no sessionID) reports every active lane in the project ' +
  "with commits ahead, uncommitted changes, and orphaned lanes; missing worktrees move their child sessions back."

export const MERGE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["method"],
  properties: {
    sessionID: {
      type: "string",
      description: 'From the subagent tool result; required unless method is "list"',
    },
    method: { type: "string", enum: ["wt-merge", "none", "list"] },
    target: { type: "string", description: "Defaults to the lane's base branch" },
  },
} as const

type MergeInput = { sessionID?: string; method: "wt-merge" | "none" | "list"; target?: string }

type Session = {
  id: string
  parentID?: string
  projectID: string
  model?: { id: string; providerID: string; variant?: string }
  location: { directory: string }
  /** Rules evaluated after the agent's; children are created with their parent's. */
  permissions?: unknown
}

type AgentInfo = { id: string; name?: string; mode?: string; model?: Session["model"]; permissions?: unknown }

/** Test seams; the host never passes these. */
export type Overrides = {
  run?: Runner
  suffix?: () => string
  lookupMs?: number
  directoryExists?: (path: string) => Promise<boolean>
  now?: () => number
  reserveMs?: number
}

const directoryExists = async (path: string) => {
  try { return (await stat(path)).isDirectory() } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

const TIMED_OUT = Symbol("timed out")

/** Epoch milliseconds from a number, Date or date string; undefined otherwise. */
function toMillis(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const randomSuffix = () => crypto.randomUUID().slice(0, 6)

/** The real path, or the resolved one when it does not exist. */
const normalize = (path: string) => realpath(path).catch(() => resolve(path))

function appendContent(content: Result["content"], note: string): Result["content"] {
  if (content === undefined) return note
  if (typeof content === "string") return `${content}\n\n${note}`
  return [...content, { type: "text", text: note }]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createLanes(
  ctx: Context,
  options: Options,
  git: Git,
  suffix: () => string,
  lookupMs = SESSION_LOOKUP_MS,
  exists = directoryExists,
  now: () => number = Date.now,
  reserveMs = RESERVATION_MS,
) {
  const load = async (child: string) => parseLane(await ctx.storage.get(laneKey(child)))
  const save = (lane: Lane) => ctx.storage.set(laneKey(lane.child), lane)

  const getSession = (sessionID: string) =>
    ctx.session.get({ sessionID } as never).then(
      (session) => session as unknown as Session,
      () => undefined,
    )

  const getAgent = (agentID: string, directory: string) =>
    ctx.agent.get({ agentID, location: { directory } } as never).then(
      (output) => {
        const value = output as unknown as { data?: AgentInfo } | AgentInfo | undefined
        const agent = value && "data" in value ? value.data : (value as AgentInfo | undefined)
        return typeof agent?.id === "string" ? agent : undefined
      },
      () => undefined,
    )

  const assertSubagent = (event: { sessionID: string; agent: string; messageID: string; id: string }, agent: string) =>
    ctx.permission.assert({
      sessionID: event.sessionID,
      agent: event.agent,
      action: SUBAGENT_TOOL,
      resources: [agent],
      save: [agent],
      source: { type: "tool", messageID: event.messageID, id: event.id },
    } as never)

  const removeWorktree = async (projectID: string, directory: string, force: boolean) => {
    await ctx.worktree.remove({ projectID, directory, force } as never)
  }

  /** Create a worktree from `from` (the caller's checkout, or the worktree it named); the caller cleans it up if a later step fails. */
  const provision = async (parent: Session, description: string, from = parent.location.directory, named = false) => {
    const parentDir = from
    const ref = named ? "HEAD" : options.base
    const base = await git.commit(parentDir, ref)
    if (!base) throw new Error(`subagent-worktree: cannot resolve base ${ref} in ${parentDir}`)
    const target =
      ref !== "HEAD" && (await git.isLocalBranch(parentDir, ref)) ? ref : await git.branch(parentDir)
    const name = worktreeName(description, suffix())
    const created = await ctx.worktree.create({ projectID: parent.projectID, name, branch: base } as never)
    const directory = (created as { directory: string }).directory
    try {
      let branch = await git.branch(directory)
      // OpenCode's git strategy checks out a detached HEAD; give the lane a branch to merge.
      if (!branch) {
        if (!(await git.createBranch(directory, name))) throw new Error(`cannot create branch ${name} in ${directory}`)
        branch = name
      }
      return { directory, branch, base, parentDir, ...(target ? { target } : {}) }
    } catch (error) {
      await removeWorktree(parent.projectID, directory, true).catch(() => {})
      throw error
    }
  }

  const createChild = async (event: { sessionID: string }, input: SubagentInput, agent: AgentInfo, parent: Session) => {
    const model = (input.model === undefined ? undefined : parseModel(input.model)) ?? agent.model ?? parent.model
    const created = await ctx.session.create({
      parentID: event.sessionID,
      title: input.description,
      agent: agent.id,
      ...(model ? { model } : {}),
    } as never)
    return (created as unknown as Session).id
  }

  /** The worktrees of the caller's repository, the one its directory is in, and the one `requested` names. */
  const locate = async (parentDir: string, requested: string) => {
    const porcelain = await git.worktrees(parentDir)
    const entries =
      porcelain === undefined
        ? undefined
        : await Promise.all(
            parseWorktrees(porcelain).map(async (entry) => ({ ...entry, directory: await normalize(entry.directory) })),
          )
    const raw = requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested
    const path = await normalize(resolve(parentDir, raw))
    const current = entries && containingWorktree(await normalize(parentDir), entries)?.directory
    return { lookup: findWorktree(requested, path, entries), current }
  }

  /**
   * The open sessions whose directory is `directory`, following pagination; undefined when the
   * lookup fails or does not finish within the lookup time (an incomplete answer is unknown).
   */
  const sessionsIn = async (projectID: string, directory: string): Promise<WriterSession[] | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMED_OUT>((done) => {
      timer = setTimeout(() => done(TIMED_OUT), lookupMs)
    })
    const within = <T>(work: Promise<T>) => Promise.race([work.catch(() => TIMED_OUT), timeout])
    try {
      const raws: Array<Record<string, unknown>> = []
      let query: Record<string, unknown> = { project: projectID, directory, archived: false, limit: 100 }
      for (;;) {
        const page = (await within(Promise.resolve(ctx.session.list(query as never)) as Promise<unknown>)) as
          | { data?: unknown; cursor?: { next?: string } }
          | typeof TIMED_OUT
        if (page === TIMED_OUT || !Array.isArray(page.data)) return undefined
        raws.push(...(page.data as Array<Record<string, unknown>>))
        const next = page.cursor?.next
        if (!next) break
        query = { cursor: next }
      }
      const sessions: WriterSession[] = []
      for (const raw of raws) {
        if (typeof raw.id !== "string") continue
        const time = (raw.time ?? {}) as Record<string, unknown>
        const busy = toMillis(time.busy)
        const idle = toMillis(time.idle)
        const session: WriterSession = {
          id: raw.id,
          ...(typeof raw.parentID === "string" ? { parentID: raw.parentID } : {}),
          ...(busy === undefined ? {} : { busy }),
          ...(idle === undefined ? {} : { idle }),
        }
        if (session.parentID !== undefined && isRunning(session)) {
          const agent = typeof raw.agent === "string" ? await within(getAgent(raw.agent, directory)) : undefined
          if (typeof agent === "symbol") return undefined
          session.readOnly = sessionIsReadOnly(agent?.permissions, raw.permissions)
        }
        sessions.push(session)
      }
      return sessions
    } finally {
      clearTimeout(timer)
    }
  }

  /** Skip notes by tool call id, appended to that call's result by `after`. */
  const notes = new Map<string, string>()

  /** Worktrees reserved by an in-flight writer spawn, by canonical path; see `Reservation`. */
  const reservations = new Map<string, Reservation>()
  let sequence = 0

  /** Whether a session's latest execution has started, as `session.get` reports `time.busy`. */
  const hasStarted = async (child: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMED_OUT>((done) => {
      timer = setTimeout(() => done(TIMED_OUT), lookupMs)
    })
    try {
      const session = await Promise.race([getSession(child), timeout])
      // No answer in time is unknown: keep the reservation until it expires, but do not hang.
      return session !== TIMED_OUT && (session as { time?: { busy?: unknown } } | undefined)?.time?.busy !== undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Take the reservation on `directory` for call `callId`, or refuse. A reservation whose child was
   * observed busy is dropped: the live-writer lookup covers it from then on. No await separates the
   * blocking check from the set, so concurrent spawns cannot both reserve.
   */
  const reserve = async (directory: string, callId: string): Promise<string> => {
    const token = `${callId}#${++sequence}`
    for (;;) {
      const held = blockingReservation(reservations.get(directory), now(), token)
      if (!held) {
        reservations.set(directory, { token, callId, until: now() + reserveMs })
        return token
      }
      if (held.child === undefined || !(await hasStarted(held.child))) {
        throw new Error(`subagent-worktree: ${writerRefusal(directory, held.child)}`)
      }
      if (reservations.get(directory) === held) reservations.delete(directory)
    }
  }

  const release = (callId: string) => {
    for (const [directory, reservation] of reservations) if (reservation.callId === callId) reservations.delete(directory)
  }

  const begin = async (event: {
    tool: string
    sessionID: string
    agent: string
    messageID: string
    id: string
    input: unknown
  }) => {
    if (event.tool !== SUBAGENT_TOOL) return
    const input = readSubagentInput(event.input)
    if (!input) return
    event.input = withoutWorktree(event.input)
    if (input.sessionID !== undefined) {
      const note = resumeWorktreeNote(input)
      if (note) {
        notes.set(event.id, note)
        return
      }
      return revive(event, input.sessionID, input.prompt)
    }

    const parent = await getSession(event.sessionID)
    if (!parent) return
    const parentDir = parent.location.directory
    const agent = await getAgent(input.agent, parentDir)
    const start = typeof input.worktree === "string" ? await locate(parentDir, input.worktree) : undefined
    const isolation = decideIsolation({
      tool: event.tool,
      input,
      options,
      agent,
      callerPermissions: parent.permissions,
      callerIsChild: Boolean(parent.parentID),
      isGit: start ? start.lookup.ok : await git.isWorkTree(parentDir),
      projectDir: parentDir,
      homeDir: homedir(),
    })
    const plan = planStart({
      input,
      isolation,
      parentDir,
      current: start?.current,
      ...(start ? { lookup: start.lookup } : {}),
      runnable: agent !== undefined && agent.mode !== "primary",
      trackedDirty: input.worktree === undefined && isolation.isolate ? await git.trackedDirty(parentDir) : false,
    })
    if (plan.kind === "refuse") throw new Error(`subagent-worktree: ${plan.reason}`)
    let hold: { directory: string; token: string; writer: boolean } | undefined
    if (plan.kind !== "isolate" && start?.lookup.ok && agent && agent.mode !== "primary") {
      const directory = start.lookup.worktree.directory
      const writer = !sessionIsReadOnly(agent.permissions, parent.permissions)
      // Reserve before any lookup so a concurrent spawn cannot read a snapshot that predates this one.
      if (writer) hold = { directory, token: await reserve(directory, event.id), writer }
      const guard = decideWriterGuard({
        writer,
        directory,
        caller: event.sessionID,
        sessions: await sessionsIn(parent.projectID, directory),
      })
      if (guard.kind === "refuse") throw new Error(`subagent-worktree: ${guard.reason}`)
      if (guard.warn) notes.set(event.id, guard.warn)
    }
    /**
     * After a wait (permission prompt), confirm this call still owns the worktree. Replaced by another
     * token: refuse. Expired and untaken: re-take the slot and look for a live writer again.
     */
    const fence = async () => {
      if (!hold) return
      const status = reservationStatus(reservations.get(hold.directory), now(), hold.token)
      if (status === "held") return
      if (status === "replaced") throw new Error(`subagent-worktree: ${hold.directory}: ${FENCED_REASON}`)
      reservations.set(hold.directory, { token: hold.token, callId: event.id, until: now() + reserveMs })
      const fresh = decideWriterGuard({
        writer: hold.writer,
        directory: hold.directory,
        caller: event.sessionID,
        sessions: await sessionsIn(parent.projectID, hold.directory),
      })
      if (fresh.kind === "refuse") throw new Error(`subagent-worktree: ${fresh.reason}`)
      if (fresh.warn) notes.set(event.id, fresh.warn)
      const after = reservationStatus(reservations.get(hold.directory), now(), hold.token)
      if (after === "replaced") throw new Error(`subagent-worktree: ${hold.directory}: ${FENCED_REASON}`)
    }
    if (plan.kind === "default") {
      await fence()
      if (plan.note) notes.set(event.id, plan.note)
      return
    }
    if (!agent) return

    await assertSubagent(event, agent.id)
    if (plan.kind === "move") {
      await fence()
      let child: string | undefined
      try {
        child = await createChild(event, input, agent, parent)
        const reserved = hold && reservations.get(hold.directory)
        if (reserved && hold && reserved.token === hold.token) reserved.child = child
        await ctx.session.move({ sessionID: child, directory: plan.worktree.directory } as never)
        event.input = { ...(event.input as object), sessionID: child, prompt: startPrompt(input.prompt, plan.worktree) }
      } catch (error) {
        if (child) await ctx.session.remove({ sessionID: child } as never).catch(() => {})
        throw new Error(`subagent-worktree: ${errorMessage(error)}`)
      }
      return
    }

    if (await git.isUnborn(plan.from)) {
      notes.set(event.id, UNBORN_NOTE)
      return
    }
    const worktree = await provision(parent, input.description || input.agent, plan.from, input.worktree !== undefined)
    let child: string | undefined
    try {
      child = await createChild(event, input, agent, parent)
      await ctx.session.move({ sessionID: child, directory: worktree.directory } as never)
      const lane: Lane = {
        child,
        parent: event.sessionID,
        projectID: parent.projectID,
        ...worktree,
        ...(input.description ? { title: input.description } : {}),
        state: "active",
      }
      await save(lane)
      event.input = { ...(event.input as object), sessionID: child, prompt: rewritePrompt(input.prompt, lane, true) }
    } catch (error) {
      if (child) await ctx.session.remove({ sessionID: child } as never).catch(() => {})
      await removeWorktree(parent.projectID, worktree.directory, true).catch(() => {})
      throw new Error(`subagent-worktree: ${errorMessage(error)}`)
    }
  }

  /** A failed spawn releases its reservation; a finished one releases it in `after`. */
  const before: typeof begin = async (event) => {
    try {
      await begin(event)
    } catch (error) {
      release(event.id)
      throw error
    }
  }

  /** Continuing a lane whose worktree was removed gives the child a fresh one. */
  const revive = async (
    event: { sessionID: string; agent: string; messageID: string; id: string; input: unknown },
    child: string,
    prompt: string,
  ) => {
    let lane = await load(child)
    if (lane) lane = await repair(lane)
    if (!lane || lane.state === "active" || lane.parent !== event.sessionID) return
    const parent = await getSession(event.sessionID)
    const session = await getSession(child)
    if (!parent || !session || !(await git.isWorkTree(parent.location.directory))) return
    if (session.parentID !== event.sessionID) return
    const agent = (event.input as { agent?: string }).agent ?? ""
    await assertSubagent(event, (await getAgent(agent, parent.location.directory))?.id ?? agent)
    const worktree = await provision(parent, lane.title ?? "task")
    try {
      await ctx.session.move({ sessionID: child, directory: worktree.directory } as never)
      const next: Lane = { ...lane, ...worktree, state: "active" }
      if (!worktree.target) delete next.target
      await save(next)
      event.input = { ...(event.input as object), prompt: rewritePrompt(prompt, next, false) }
    } catch (error) {
      await moveHome(lane)
      await removeWorktree(parent.projectID, worktree.directory, true).catch(() => {})
      throw new Error(`subagent-worktree: ${errorMessage(error)}`)
    }
  }

  const moveHome = async (lane: Lane) => {
    const parent = await getSession(lane.parent)
    const directory = parent?.location.directory ?? lane.parentDir
    await ctx.session.move({ sessionID: lane.child, directory } as never)
  }

  const retire = async (lane: Lane, state: "removed" | "merged") => {
    const next: Lane = { ...lane, state }
    await save(next)
    return next
  }

  const repair = async (lane: Lane) => {
    if (lane.state !== "active" || await exists(lane.directory)) return lane
    await moveHome(lane)
    return retire(lane, "removed")
  }

  const after = async (
    event: { tool: string; input: unknown; id?: string } & (
      | { status: "completed"; result: Result }
      | { status: "error"; error: InstanceType<typeof ToolError> }
    ),
  ) => {
    if (event.tool !== SUBAGENT_TOOL) return
    const reported = (event.status === "completed" ? event.result.metadata : event.error.metadata) as { status?: unknown } | undefined
    if (event.id !== undefined) {
      if (event.status === "completed" && reported?.status === "running") {
        // A background child keeps the worktree reserved until a later check sees it busy, or the hold expires.
        const started = (event.result.metadata as { sessionID?: unknown } | undefined)?.sessionID
        if (typeof started === "string") {
          for (const reservation of reservations.values()) if (reservation.callId === event.id) reservation.child = started
        }
      } else release(event.id)
    }
    const skipped = event.id === undefined ? undefined : notes.get(event.id)
    if (event.id !== undefined) notes.delete(event.id)
    if (skipped) {
      if (event.status === "completed") event.result = { ...event.result, content: appendContent(event.result.content, skipped) }
      else {
        const previous = event.error
        event.error = new ToolError({
          message: `${previous.message}\n\n${skipped}`,
          ...(previous.error === undefined ? {} : { error: previous.error }),
          ...(previous.metadata === undefined ? {} : { metadata: previous.metadata }),
        })
      }
    }
    const metadata = event.status === "completed" ? (event.result.metadata ?? {}) : (event.error.metadata ?? {})
    const child =
      typeof metadata.sessionID === "string" ? metadata.sessionID : readSubagentInput(event.input)?.sessionID
    if (!child) return
    let lane = await load(child)
    if (lane?.state !== "active") return

    const resultStatus = event.status === "error" ? "error" : metadata.status === "running" ? "running" : "completed"
    const status = await git.status(lane.directory, lane.base)
    let removed = false
    if (shouldRemove(status, resultStatus)) {
      try {
        await moveHome(lane)
        await removeWorktree(lane.projectID, lane.directory, false)
        await git.deleteBranch(lane.parentDir, lane.branch)
        lane = await retire(lane, "removed")
        removed = true
      } catch {}
    }
    const note = annotation(lane, status, removed)
    const worktree = { branch: lane.branch, base: lane.base, directory: lane.directory, state: lane.state }
    if (event.status === "completed") {
      event.result = {
        ...event.result,
        content: appendContent(event.result.content, note),
        metadata: { ...metadata, worktree },
      }
    } else {
      const previous = event.error
      event.error = new ToolError({
        message: `${previous.message}\n\n${note}`,
        ...(previous.error === undefined ? {} : { error: previous.error }),
        metadata: { ...metadata, worktree },
      })
    }
  }

  const scan = async () => {
    const found: Lane[] = []
    let after: string | undefined
    do {
      const page = await ctx.storage.scan({ prefix: LANE_PREFIX, ...(after === undefined ? {} : { after }) } as never)
      for (const entry of page.entries) {
        const lane = parseLane(entry.value)
        if (lane) found.push(lane)
      }
      after = page.next
    } while (after !== undefined)
    return found
  }

  const alive = (sessionID: string) => liveness(ctx.session.get({ sessionID } as never), lookupMs)

  /** Every active lane in the caller's project, with git status and session liveness. Removes nothing. */
  const list = async (caller: string): Promise<Result> => {
    const session = await getSession(caller)
    const lanes = (await scan())
      .filter((lane) => lane.state === "active")
      .filter((lane) => (session ? lane.projectID === session.projectID : lane.parent === caller))
      .sort((a, b) => a.branch.localeCompare(b.branch))
    const repaired: string[] = []
    const checked = await Promise.all(
      lanes.map(async (lane) => {
        const fixed = await repair(lane)
        if (fixed.state === "removed") {
          repaired.push(lane.child)
          return undefined
        }
        const [status, child, parent] = await Promise.all([
          git.status(lane.directory, lane.base),
          alive(lane.child),
          lane.parent === caller && session ? Promise.resolve("alive" as const) : alive(lane.parent),
        ])
        return { lane, status, child, parent }
      }),
    )
    const reports = checked.filter((report): report is LaneReport => report !== undefined)
    return {
      content: formatLaneList(reports, caller) + (repaired.length ? `\nMissing worktrees: moved child sessions back to their parent directory: ${repaired.join(", ")}.` : ""),
      metadata: {
        ok: true,
        repaired,
        lanes: reports.map(({ lane, status, child, parent }) => ({
          sessionID: lane.child,
          parent: lane.parent,
          branch: lane.branch,
          directory: lane.directory,
          ahead: status?.ahead,
          dirty: status?.dirty,
          child,
          parentSession: parent,
        })),
      },
    }
  }

  /** Uncommitted and untracked files where `target` is checked out; [] when it is not checked out. */
  const targetChanges = async (lane: Lane, target: string) => {
    const porcelain = await git.worktrees(lane.parentDir)
    if (porcelain === undefined) return undefined
    const directory = worktreeForBranch(porcelain, target)
    return directory === undefined ? [] : git.localFiles(directory)
  }

  const merge = async (
    input: MergeInput,
    tool: { sessionID: string; agent: string; messageID: string; id: string },
  ): Promise<Result> => {
    if (input.method === "list") {
      await ctx.permission.assert({
        sessionID: tool.sessionID,
        agent: tool.agent,
        action: MERGE_TOOL,
        resources: ["list"],
        source: { type: "tool", messageID: tool.messageID, id: tool.id },
      } as never)
      return list(tool.sessionID)
    }
    if (!input.sessionID) {
      return { content: `${MERGE_TOOL}: sessionID is required for method "${input.method}"`, metadata: { ok: false } }
    }
    let lane = await load(input.sessionID)
    await ctx.permission.assert({
      sessionID: tool.sessionID,
      agent: tool.agent,
      action: MERGE_TOOL,
      resources: [lane?.branch ?? input.sessionID],
      source: { type: "tool", messageID: tool.messageID, id: tool.id },
    } as never)
    if (lane) lane = await repair(lane)
    const status = lane && lane.state === "active" ? await git.status(lane.directory, lane.base) : undefined
    if (input.method === "none") {
      if (!lane) return { content: `${MERGE_TOOL}: no worktree lane for session ${input.sessionID}`, metadata: { ok: false } }
      return { content: annotation(lane, status, false), metadata: { ok: true, lane } }
    }
    const target = input.target ?? lane?.target
    const ready = lane?.state === "active" && lane.parent === tool.sessionID && target && status && status.ahead > 0
    const files =
      ready && lane && !status.dirty
        ? { laneFiles: await git.changedFiles(lane.directory, target), localFiles: await targetChanges(lane, target) }
        : {}
    const decision = decideMerge({
      lane,
      caller: tool.sessionID,
      status,
      ...(input.target ? { target: input.target } : {}),
      ...files,
    })
    if (decision.refuse || !lane) {
      const reason = decision.refuse ? decision.reason : "no lane"
      return { content: `${MERGE_TOOL}: not merged: ${reason}`, metadata: { ok: false, reason } }
    }
    const argv = mergeArgs(lane.directory, decision.target)
    // wt merge removes the checkout itself. A failed move must prevent that removal.
    await moveHome(lane)
    const result = await git.run(argv)
    const output = tail(`${result.stdout}\n${result.stderr}`)
    if (result.code !== 0) {
      const conflict = isConflict(output)
      const what = result.code === 127 ? "wt is not installed" : conflict ? "merge conflict" : `wt merge exited ${result.code}`
      if (await exists(lane.directory)) await ctx.session.move({ sessionID: lane.child, directory: lane.directory } as never)
      return {
        content: [
          `${MERGE_TOOL}: not merged (${what}). The worktree is kept at ${lane.directory} on branch ${lane.branch}.`,
          conflict ? `Resolve the conflict there (git -C ${lane.directory} status), commit, and call ${MERGE_TOOL} again.` : "",
          `$ ${argv.join(" ")}`,
          output,
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: { ok: false, conflict, code: result.code },
      }
    }
    const merged = await retire(lane, "merged")
    await ctx.worktree.refresh({ projectID: lane.projectID } as never).catch(() => {})
    return {
      content: `${MERGE_TOOL}: merged ${lane.branch} into ${decision.target} (${status?.ahead ?? 0} commits, --no-squash --no-ff).\n$ ${argv.join(" ")}\n${output}`,
      metadata: { ok: true, lane: merged },
    }
  }

  return { before, after, merge, load }
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.subagent-worktree",
    async setup(ctx) {
      const options = readOptions(ctx.options)
      const git = createGit(overrides.run ?? spawnRunner)
      const lanes = createLanes(ctx, options, git, overrides.suffix ?? randomSuffix, overrides.lookupMs, overrides.directoryExists, overrides.now, overrides.reserveMs)
      const registrations: { dispose: () => Promise<void> }[] = []
      const cleanup = async () => {
        for (const registration of registrations.reverse()) await registration.dispose()
      }
      try {
        registrations.push(await ctx.tool.hook("execute.before", lanes.before))
        registrations.push(await ctx.tool.hook("execute.after", lanes.after as never))
        registrations.push(
          await ctx.tool.transform((editor) => {
            editor.add({
              name: MERGE_TOOL,
              description: MERGE_DESCRIPTION,
              input: MERGE_INPUT,
              execute: async (raw, tool) => lanes.merge(raw as MergeInput, tool),
            })
          }),
        )
        registrations.push(
          await ctx.tool.transform((editor) => {
            editor.update(SUBAGENT_TOOL, (tool) => {
              const input = withOptionalString(tool.input, WORKTREE_PARAM, WORKTREE_PARAM_DESCRIPTION)
              const schema = toJsonSchema(input)
              if (schema) schema.properties[WORKTREE_PARAM] = { anyOf: [{ type: "string" }, { const: false }], description: WORKTREE_PARAM_DESCRIPTION }
              if (input !== undefined) tool.input = (schema ?? input) as typeof tool.input
            })
          }),
        )
      } catch (error) {
        await cleanup()
        throw error
      }
      return cleanup
    },
  })
}

export default createPlugin()
