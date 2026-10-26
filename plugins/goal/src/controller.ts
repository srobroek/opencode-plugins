import type { Context } from "@opencode/plugin/promise/plugin"
import { describeLoopCondition, evaluateLoopCondition, type LoopConditionVerdict } from "./condition.ts"
import { type ContinuationKind, GOAL_SOURCE, isGoalSourced, registry } from "./continuation.ts"
import {
  activityDigest,
  activityFingerprint,
  addUsage,
  assessContinuationTurn,
  completeGoal,
  continuationDecision,
  createGoal,
  describeGoal,
  type Goal,
  goalAfterRestart,
  goalFromJson,
  goalToolText,
  isOpen,
  parseGoalCommand,
  pauseGoal,
  renderActivePrompt,
  renderBudgetLimitPrompt,
  renderCompactionPrompt,
  renderContinuationPrompt,
  resumeGoal,
  setBudget,
  stepTokens,
} from "./goal.ts"
import {
  consumeLoopLimitIteration,
  createLoopLimitRuntime,
  describeLoopLimit,
  isLoopLimitExhausted,
  type LoopConditionConfig,
  type LoopLimitRuntime,
  parseLoopArgs,
} from "./loop.ts"

export const GOAL_KEY_PREFIX = "goal:"
export const LOOP_KEY_PREFIX = "loop:"

export type LoopState = {
  paused: boolean
  prompt?: string
  limit?: LoopLimitRuntime
  condition?: LoopConditionConfig
  iterations: number
}

export function loopFromJson(value: unknown): LoopState | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  const loop: LoopState = { paused: v.paused === true, iterations: typeof v.iterations === "number" ? v.iterations : 0 }
  if (typeof v.prompt === "string") loop.prompt = v.prompt
  const limit = v.limit as LoopLimitRuntime | undefined
  if (limit?.kind === "iterations" && typeof limit.remaining === "number") loop.limit = limit
  if (limit?.kind === "duration" && typeof limit.deadlineMs === "number") loop.limit = limit
  const condition = v.condition as LoopConditionConfig | undefined
  if (typeof condition?.command === "string") loop.condition = { command: condition.command, until: condition.until === true }
  return loop
}

export type ControllerOptions = {
  /** Pause between a turn ending and the continuation, so Esc or typing can win. */
  delayMs?: number
  /** Automatic goal continuations before the plugin stops and waits for the user. */
  maxContinuations?: number
  conditionTimeoutMs?: number
  now?: () => number
  evaluateCondition?: typeof evaluateLoopCondition
}

export function controllerOptions(options: unknown): ControllerOptions {
  const o = (options ?? {}) as Record<string, unknown>
  const positive = (value: unknown) => (typeof value === "number" && value >= 0 ? value : undefined)
  const result: ControllerOptions = {}
  const delayMs = positive(o.delayMs)
  const maxContinuations = positive(o.maxContinuations)
  const conditionTimeoutMs = positive(o.conditionTimeoutMs)
  if (delayMs !== undefined) result.delayMs = delayMs
  if (maxContinuations !== undefined) result.maxContinuations = maxContinuations
  if (conditionTimeoutMs !== undefined) result.conditionTimeoutMs = conditionTimeoutMs
  return result
}

type Runtime = {
  /** `null` is a known root session; `undefined` is not yet looked up. */
  parentID: string | null | undefined
  running: boolean
  startedAt?: number
  agent?: string
  directory?: string
  toolNames: Map<string, string>
  digests: string[]
  previousFingerprint?: string
  awaitingContinuation: boolean
  stalled: boolean
  continuations: number
  deferred: boolean
  timer?: ReturnType<typeof setTimeout>
  conditionAbort?: AbortController
  runningChildren: Set<string>
  runningShells: Set<string>
}

type Loose = Record<string, unknown>

type Invocation = { sessionID: string; prompt: { text: string }; delivery?: string }

export class GoalController {
  readonly goals = new Map<string, Goal>()
  readonly loops = new Map<string, LoopState>()
  readonly sessions = new Map<string, Runtime>()
  readonly #ctx: Context
  readonly #delayMs: number
  readonly #maxContinuations: number
  readonly #conditionTimeoutMs: number | undefined
  readonly #now: () => number
  readonly #evaluate: typeof evaluateLoopCondition
  #disposed = false

  constructor(ctx: Context, options: ControllerOptions = {}) {
    this.#ctx = ctx
    this.#delayMs = options.delayMs ?? 800
    this.#maxContinuations = options.maxContinuations ?? 25
    this.#conditionTimeoutMs = options.conditionTimeoutMs
    this.#now = options.now ?? Date.now
    this.#evaluate = options.evaluateCondition ?? evaluateLoopCondition
  }

  /** Restore stored goals and loops. Anything that was running comes back paused. */
  async load(): Promise<void> {
    for (const { key, value } of await this.#scan(GOAL_KEY_PREFIX)) {
      const stored = goalFromJson(value)
      if (!stored) continue
      const sessionID = key.slice(GOAL_KEY_PREFIX.length)
      const goal = goalAfterRestart(stored, this.#now())
      this.goals.set(sessionID, goal)
      if (goal !== stored) await this.#saveGoal(sessionID)
    }
    for (const { key, value } of await this.#scan(LOOP_KEY_PREFIX)) {
      const loop = loopFromJson(value)
      if (!loop) continue
      const sessionID = key.slice(LOOP_KEY_PREFIX.length)
      const wasPaused = loop.paused
      loop.paused = true
      this.loops.set(sessionID, loop)
      if (!wasPaused) await this.#saveLoop(sessionID)
    }
  }

  dispose(): void {
    this.#disposed = true
    for (const [sessionID, rt] of this.sessions) {
      if (rt.timer) clearTimeout(rt.timer)
      rt.conditionAbort?.abort()
      registry().delete(sessionID)
    }
  }

  // Commands

  async goalCommand(input: Invocation): Promise<void> {
    const { sessionID } = input
    const parsed = parseGoalCommand(input.prompt.text ?? "")
    if (typeof parsed === "string") throw new Error(parsed)
    const rt = this.#runtime(sessionID)
    if (!(await this.#isRoot(sessionID))) {
      throw new Error("Goal mode only runs in a top-level session, not in a subagent.")
    }
    const goal = this.goals.get(sessionID)
    const now = this.#now()
    switch (parsed.kind) {
      case "show": {
        if (!goal) throw new Error("No goal. Start one with /goal <objective>.")
        let text = describeGoal(goal)
        if (goal.status === "active" && rt.stalled) text += "\n\nAuto-continue is stopped. /goal resume restarts it."
        return this.#notify(sessionID, text)
      }
      case "pause": {
        if (!goal || (goal.status !== "active" && goal.status !== "budget-limited")) {
          throw new Error("No active goal to pause.")
        }
        this.#cancel(rt)
        this.goals.set(sessionID, pauseGoal(goal, "paused by user", now))
        await this.#saveGoal(sessionID)
        return this.#notify(sessionID, "Goal paused. /goal resume continues it.")
      }
      case "resume": {
        if (!isOpen(goal)) throw new Error("No goal to resume.")
        if (goal.status === "active" && !rt.stalled) throw new Error("Goal is already active.")
        const resumed = resumeGoal(goal, now)
        if (typeof resumed === "string") throw new Error(resumed)
        this.goals.set(sessionID, resumed)
        this.#resetProgress(rt)
        await this.#saveGoal(sessionID)
        if (resumed.status === "budget-limited") {
          return this.#notify(sessionID, "Goal budget is spent. Raise it with /goal budget <tokens|$usd|off>.")
        }
        this.#maybeContinue(sessionID)
        return
      }
      case "drop": {
        if (!goal) throw new Error("No goal to drop.")
        this.#cancel(rt)
        this.goals.delete(sessionID)
        await this.#ctx.storage.remove(GOAL_KEY_PREFIX + sessionID)
        this.#sync(sessionID)
        return this.#notify(sessionID, "Goal dropped.")
      }
      case "budget": {
        if (!isOpen(goal)) throw new Error("No goal. Start one with /goal <objective>.")
        const next = setBudget(goal, parsed.budget, now)
        this.goals.set(sessionID, next)
        await this.#saveGoal(sessionID)
        await this.#notify(sessionID, `Goal budget updated.\n\n${describeGoal(next)}`)
        if (goal.status === "budget-limited" && next.status === "active") this.#maybeContinue(sessionID)
        return
      }
      case "set": {
        if (this.loops.has(sessionID)) {
          throw new Error("Loop mode is on in this session. Turn it off with /loop before setting a goal.")
        }
        if (isOpen(goal) && !parsed.replace) {
          throw new Error(`A goal is already set (${goal.status}). Use /goal set <objective> to replace it, or /goal drop.`)
        }
        this.#cancel(rt)
        const created = createGoal(parsed.objective, now)
        this.goals.set(sessionID, created)
        this.#resetProgress(rt)
        await this.#saveGoal(sessionID)
        await this.#prompt(sessionID, `${created.objective}\n\n${renderActivePrompt(created)}`, "goal-start", input.delivery)
        return
      }
    }
  }

  async loopCommand(input: Invocation): Promise<void> {
    const { sessionID } = input
    const rt = this.#runtime(sessionID)
    if (this.loops.has(sessionID)) return this.#disableLoop(sessionID, "Loop mode disabled.")
    if (isOpen(this.goals.get(sessionID))) {
      throw new Error("A goal is set in this session. Finish it or /goal drop before starting a loop.")
    }
    if (!(await this.#isRoot(sessionID))) {
      throw new Error("Loop mode only runs in a top-level session, not in a subagent.")
    }
    const parsed = parseLoopArgs(input.prompt.text ?? "")
    if (typeof parsed === "string") throw new Error(parsed)
    const loop: LoopState = { paused: false, iterations: 0 }
    const limit = createLoopLimitRuntime(parsed.limit, this.#now())
    if (limit) loop.limit = limit
    if (parsed.condition) loop.condition = parsed.condition
    if (parsed.prompt) loop.prompt = parsed.prompt
    this.#cancel(rt)
    this.loops.set(sessionID, loop)
    await this.#saveLoop(sessionID)
    const limitText = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : ""
    const conditionText = parsed.condition ? ` Continuing ${describeLoopCondition(parsed.condition)}.` : ""
    // With an inline prompt the first turn is the confirmation; a notice would only reach the model.
    if (parsed.prompt) return this.#prompt(sessionID, parsed.prompt, "loop", input.delivery, 0)
    await this.#notify(
      sessionID,
      `Loop mode enabled.${limitText}${conditionText} Your next prompt will repeat after each turn. Esc suspends the loop; /loop again disables it.`,
    )
  }

  // Tools

  async goalGet(sessionID: string): Promise<string> {
    const owner = await this.#goalOwner(sessionID)
    return goalToolText(owner ? this.goals.get(owner) : undefined)
  }

  async goalComplete(sessionID: string, evidence: string): Promise<string> {
    const owner = await this.#goalOwner(sessionID)
    const goal = owner ? this.goals.get(owner) : undefined
    if (!owner || !goal) throw new Error("No goal is set for this session.")
    const completed = completeGoal(goal, evidence, this.#now())
    if (typeof completed === "string") throw new Error(completed)
    const rt = this.#runtime(owner)
    this.#cancel(rt)
    rt.awaitingContinuation = false
    this.goals.set(owner, completed)
    await this.#saveGoal(owner)
    const report = [`tokens used: ${completed.tokensUsed}${completed.tokenBudget ? ` of ${completed.tokenBudget}` : ""}`]
    if (completed.costUsed > 0) report.push(`cost: $${completed.costUsed.toFixed(4)}`)
    if (completed.timeUsedSeconds > 0) report.push(`time used: ${completed.timeUsedSeconds} seconds`)
    return `Goal complete. Automatic continuation has stopped. Report the result and final usage to the user (${report.join("; ")}).`
  }

  // Hooks

  /** Keep the objective in compaction summaries. Only the compaction request changes. */
  compaction(event: { sessionID: string; system: Array<{ type: "text"; text: string }> }): void {
    const goal = this.goals.get(event.sessionID)
    if (isOpen(goal)) event.system.push({ type: "text", text: renderCompactionPrompt(goal) })
  }

  async handleEvent(event: unknown): Promise<void> {
    if (this.#disposed) return
    const type = (event as { type?: unknown } | null)?.type
    const data = ((event as { data?: unknown } | null)?.data ?? {}) as Loose
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (typeof type !== "string" || !sessionID) return
    switch (type) {
      case "session.created": {
        const rt = this.#runtime(sessionID)
        rt.parentID = typeof data.parentID === "string" ? data.parentID : null
        const location = data.location as { directory?: unknown } | undefined
        if (typeof location?.directory === "string") rt.directory = location.directory
        return
      }
      case "session.deleted":
        return this.#forget(sessionID)
      case "session.step.started":
        if (typeof data.agent === "string") this.#runtime(sessionID).agent = data.agent
        return
      case "session.tool.input.started":
        if (typeof data.id === "string" && typeof data.name === "string") {
          this.#runtime(sessionID).toolNames.set(data.id, data.name)
        }
        return
      case "session.tool.called":
      case "session.tool.success":
      case "session.tool.failed": {
        if (!this.#tracking()) return
        const rt = this.#runtime(sessionID)
        const name = rt.toolNames.get(String(data.id)) ?? ""
        if (type === "session.tool.called") rt.digests.push(activityDigest(["call", name, data.input]))
        else if (type === "session.tool.success") rt.digests.push(activityDigest(["result", name, data.content, false]))
        else rt.digests.push(activityDigest(["result", name, (data.error as Loose | undefined)?.message, true]))
        return
      }
      case "session.step.ended":
        return this.#onStep(sessionID, data)
      case "session.inbox.enqueued": {
        const item = data.item as { type?: unknown; payload?: { text?: unknown; metadata?: unknown } } | undefined
        if (item?.type !== "user" || isGoalSourced(item.payload?.metadata)) return
        return this.#onUserInput(sessionID, typeof item.payload?.text === "string" ? item.payload.text : "")
      }
      case "session.execution.started":
        return this.#onStarted(sessionID)
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        return this.#onEnded(sessionID, type, data)
      case "session.shell.started":
      case "session.shell.ended": {
        const shell = data.shell as { id?: unknown; status?: unknown } | undefined
        if (typeof shell?.id !== "string") return
        const rt = this.#runtime(sessionID)
        if (type === "session.shell.started" && shell.status === "running") rt.runningShells.add(shell.id)
        else rt.runningShells.delete(shell.id)
        if (type === "session.shell.ended" && rt.deferred) this.#resume(sessionID)
        return
      }
    }
  }

  // Event handling

  #tracking(): boolean {
    return this.goals.size > 0 || this.loops.size > 0
  }

  async #onStarted(sessionID: string): Promise<void> {
    const rt = this.#runtime(sessionID)
    rt.running = true
    rt.startedAt = this.#now()
    rt.digests = []
    rt.toolNames.clear()
    if (rt.timer) {
      clearTimeout(rt.timer)
      rt.timer = undefined
    }
    if (!this.#tracking()) return
    const parent = await this.#parent(sessionID)
    if (parent) this.#runtime(parent).runningChildren.add(sessionID)
  }

  async #onEnded(sessionID: string, type: string, data: Loose): Promise<void> {
    const rt = this.#runtime(sessionID)
    const startedAt = rt.startedAt
    rt.running = false
    rt.startedAt = undefined
    if (!this.#tracking()) return

    const parent = rt.parentID === undefined ? await this.#parent(sessionID) : rt.parentID
    if (parent) {
      const parentRt = this.#runtime(parent)
      parentRt.runningChildren.delete(sessionID)
      if (parentRt.deferred) this.#resume(parent)
    }

    const goal = this.goals.get(sessionID)
    if (goal && startedAt !== undefined && (goal.status === "active" || goal.status === "budget-limited")) {
      const seconds = Math.max(0, Math.round((this.#now() - startedAt) / 1000))
      this.goals.set(sessionID, { ...goal, timeUsedSeconds: goal.timeUsedSeconds + seconds })
      await this.#saveGoal(sessionID)
    }

    if (type === "session.execution.succeeded") return this.#onSucceeded(sessionID)
    this.#cancel(rt)
    rt.awaitingContinuation = false
    if (type === "session.execution.failed") {
      const message = String((data.error as Loose | undefined)?.message ?? "unknown error")
      return this.#onFailed(sessionID, message)
    }
    if (data.reason === "user") return this.#onUserInterrupt(sessionID)
  }

  async #onSucceeded(sessionID: string): Promise<void> {
    const rt = this.#runtime(sessionID)
    if (this.loops.has(sessionID)) return this.#scheduleLoop(sessionID)
    const goal = this.goals.get(sessionID)
    if (!goal) return
    if (rt.awaitingContinuation) {
      rt.awaitingContinuation = false
      const fingerprint = activityFingerprint(rt.digests)
      const assessment = assessContinuationTurn(fingerprint, rt.previousFingerprint)
      rt.previousFingerprint = fingerprint
      if (goal.status === "active" && assessment !== "progress") {
        const why = assessment === "no-activity" ? "the last turn used no tools" : "the last turn repeated the one before"
        return this.#stall(sessionID, `Goal auto-continue stopped: ${why}. Send a message or /goal resume to keep going.`)
      }
    } else {
      rt.previousFingerprint = undefined
    }
    this.#maybeContinue(sessionID)
  }

  async #onFailed(sessionID: string, message: string): Promise<void> {
    const goal = this.goals.get(sessionID)
    if (goal?.status === "active" || goal?.status === "budget-limited") {
      this.goals.set(sessionID, pauseGoal(goal, "turn failed", this.#now()))
      await this.#saveGoal(sessionID)
      await this.#notify(sessionID, `Goal paused: the turn failed (${message}). /goal resume continues it.`)
    }
    if (this.loops.has(sessionID)) await this.#disableLoop(sessionID, `Loop stopped: the turn failed (${message}).`)
  }

  async #onUserInterrupt(sessionID: string): Promise<void> {
    const goal = this.goals.get(sessionID)
    if (goal?.status === "active" || goal?.status === "budget-limited") {
      this.goals.set(sessionID, pauseGoal(goal, "interrupted", this.#now()))
      await this.#saveGoal(sessionID)
      await this.#notify(sessionID, "Goal paused (interrupted). /goal resume continues it.")
    }
    const loop = this.loops.get(sessionID)
    if (loop && !loop.paused) {
      loop.paused = true
      await this.#saveLoop(sessionID)
      await this.#notify(sessionID, "Loop suspended. Your next prompt resumes it; /loop disables it.")
    }
  }

  async #onUserInput(sessionID: string, text: string): Promise<void> {
    const rt = this.#runtime(sessionID)
    this.#cancel(rt)
    this.#resetProgress(rt)
    const loop = this.loops.get(sessionID)
    if (loop && text.trim()) {
      loop.prompt = text
      loop.paused = false
      await this.#saveLoop(sessionID)
    }
    this.#sync(sessionID)
  }

  async #onStep(sessionID: string, data: Loose): Promise<void> {
    if (this.goals.size === 0) return
    const owner = await this.#goalOwner(sessionID)
    const goal = owner ? this.goals.get(owner) : undefined
    if (!owner || !goal) return
    const cost = typeof data.cost === "number" ? data.cost : 0
    const { goal: next, limited } = addUsage(goal, { tokens: stepTokens(data.tokens), cost }, this.#now())
    if (next === goal) return
    this.goals.set(owner, next)
    await this.#saveGoal(owner)
    if (!limited) return
    this.#cancel(this.#runtime(owner))
    await this.#synthetic(owner, renderBudgetLimitPrompt(next), "Goal: budget reached", "goal-budget-limit", {
      delivery: "steer",
      resume: true,
    })
  }

  // Goal continuation

  #maybeContinue(sessionID: string): void {
    const rt = this.#runtime(sessionID)
    const decision = this.#decide(sessionID)
    if (!decision.continue) {
      if (decision.reason === "cap") {
        void this.#stall(
          sessionID,
          `Goal auto-continue stopped after ${this.#maxContinuations} continuations. Send a message or /goal resume to keep going.`,
        )
      }
      rt.deferred = decision.reason === "deferred"
      return
    }
    rt.deferred = false
    if (rt.timer) clearTimeout(rt.timer)
    rt.timer = setTimeout(() => {
      rt.timer = undefined
      void this.#continue(sessionID)
    }, this.#delayMs)
  }

  #decide(sessionID: string) {
    const rt = this.#runtime(sessionID)
    return continuationDecision({
      goal: this.goals.get(sessionID),
      root: rt.parentID === null,
      running: rt.running,
      loopEnabled: this.loops.has(sessionID),
      agent: rt.agent,
      runningChildren: rt.runningChildren.size,
      runningShells: rt.runningShells.size,
      stalled: rt.stalled,
      continuations: rt.continuations,
      maxContinuations: this.#maxContinuations,
    })
  }

  async #continue(sessionID: string): Promise<void> {
    if (this.#disposed) return
    const rt = this.#runtime(sessionID)
    const decision = this.#decide(sessionID)
    const goal = this.goals.get(sessionID)
    if (!decision.continue || !goal) {
      if (!decision.continue && decision.reason === "deferred") rt.deferred = true
      return
    }
    rt.continuations += 1
    rt.awaitingContinuation = true
    const n = rt.continuations
    try {
      await this.#synthetic(sessionID, renderContinuationPrompt(goal), `Goal: continue #${n}`, "goal-continuation", {
        delivery: "queue",
        resume: true,
        iteration: n,
      })
    } catch (error) {
      rt.awaitingContinuation = false
      await this.#stall(sessionID, `Goal auto-continue failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #resume(sessionID: string): void {
    const rt = this.#runtime(sessionID)
    rt.deferred = false
    if (rt.running) return
    if (this.loops.has(sessionID)) this.#scheduleLoop(sessionID)
    else this.#maybeContinue(sessionID)
  }

  async #stall(sessionID: string, message: string): Promise<void> {
    const rt = this.#runtime(sessionID)
    if (rt.stalled) return
    rt.stalled = true
    this.#sync(sessionID)
    await this.#notify(sessionID, message)
  }

  #resetProgress(rt: Runtime): void {
    rt.stalled = false
    rt.continuations = 0
    rt.previousFingerprint = undefined
    rt.awaitingContinuation = false
    rt.deferred = false
  }

  // Loop

  #scheduleLoop(sessionID: string): void {
    const loop = this.loops.get(sessionID)
    const rt = this.#runtime(sessionID)
    if (!loop || loop.paused || !loop.prompt) return
    if (rt.runningChildren.size > 0 || rt.runningShells.size > 0) {
      rt.deferred = true
      return
    }
    rt.deferred = false
    if (rt.timer) clearTimeout(rt.timer)
    rt.timer = setTimeout(() => {
      rt.timer = undefined
      void this.#runLoopIteration(sessionID, loop)
    }, this.#delayMs)
  }

  async #runLoopIteration(sessionID: string, loop: LoopState): Promise<void> {
    const rt = this.#runtime(sessionID)
    const prompt = loop.prompt
    const current = () => !this.#disposed && this.loops.get(sessionID) === loop && !loop.paused && loop.prompt === prompt
    if (!prompt || !current() || rt.running) return
    if (isLoopLimitExhausted(loop.limit, this.#now())) {
      return this.#disableLoop(sessionID, "Loop limit reached. Loop mode disabled.")
    }
    if (loop.condition) {
      rt.conditionAbort?.abort()
      const controller = new AbortController()
      rt.conditionAbort = controller
      let verdict: LoopConditionVerdict
      try {
        verdict = await this.#evaluate(loop.condition, {
          cwd: rt.directory ?? this.#ctx.location.directory,
          signal: controller.signal,
          ...(this.#conditionTimeoutMs === undefined ? {} : { timeoutMs: this.#conditionTimeoutMs }),
        })
      } finally {
        if (rt.conditionAbort === controller) rt.conditionAbort = undefined
      }
      if (!current()) return
      if (verdict.kind === "aborted") return
      if (verdict.kind !== "continue") return this.#disableLoop(sessionID, verdict.message)
    }
    if (rt.running) return
    if (!consumeLoopLimitIteration(loop.limit, this.#now())) {
      return this.#disableLoop(sessionID, "Loop limit reached. Loop mode disabled.")
    }
    loop.iterations += 1
    await this.#saveLoop(sessionID)
    await this.#prompt(sessionID, prompt, "loop", "queue", loop.iterations)
  }

  async #disableLoop(sessionID: string, message: string): Promise<void> {
    const rt = this.#runtime(sessionID)
    this.#cancel(rt)
    this.loops.delete(sessionID)
    await this.#ctx.storage.remove(LOOP_KEY_PREFIX + sessionID)
    this.#sync(sessionID)
    await this.#notify(sessionID, message)
  }

  // Plumbing

  #runtime(sessionID: string): Runtime {
    let rt = this.sessions.get(sessionID)
    if (!rt) {
      rt = {
        parentID: undefined,
        running: false,
        toolNames: new Map(),
        digests: [],
        awaitingContinuation: false,
        stalled: false,
        continuations: 0,
        deferred: false,
        runningChildren: new Set(),
        runningShells: new Set(),
      }
      this.sessions.set(sessionID, rt)
    }
    return rt
  }

  #cancel(rt: Runtime): void {
    if (rt.timer) clearTimeout(rt.timer)
    rt.timer = undefined
    rt.conditionAbort?.abort()
    rt.conditionAbort = undefined
  }

  async #parent(sessionID: string): Promise<string | undefined> {
    const rt = this.#runtime(sessionID)
    if (rt.parentID === undefined) {
      try {
        const info = (await this.#ctx.session.get({ sessionID } as never)) as unknown as Loose
        rt.parentID = typeof info.parentID === "string" ? info.parentID : null
        const location = info.location as { directory?: unknown } | undefined
        if (typeof location?.directory === "string") rt.directory = location.directory
      } catch {
        rt.parentID = null
      }
    }
    return rt.parentID ?? undefined
  }

  async #isRoot(sessionID: string): Promise<boolean> {
    return (await this.#parent(sessionID)) === undefined
  }

  /** The session itself or the nearest ancestor that has a goal. */
  async #goalOwner(sessionID: string): Promise<string | undefined> {
    let current: string | undefined = sessionID
    for (let depth = 0; current !== undefined && depth < 8; depth++) {
      if (this.goals.has(current)) return current
      current = await this.#parent(current)
    }
    return undefined
  }

  #sync(sessionID: string): void {
    if (this.#disposed) return
    const goal = this.goals.get(sessionID)
    const loop = this.loops.get(sessionID)
    const rt = this.sessions.get(sessionID)
    let kind: ContinuationKind | undefined
    if (goal?.status === "active" && !rt?.stalled) kind = "goal"
    if (loop && !loop.paused) kind = "loop"
    if (kind) registry().set(sessionID, kind)
    else registry().delete(sessionID)
  }

  async #forget(sessionID: string): Promise<void> {
    const rt = this.sessions.get(sessionID)
    if (rt) this.#cancel(rt)
    this.sessions.delete(sessionID)
    registry().delete(sessionID)
    if (this.goals.delete(sessionID)) await this.#ctx.storage.remove(GOAL_KEY_PREFIX + sessionID)
    if (this.loops.delete(sessionID)) await this.#ctx.storage.remove(LOOP_KEY_PREFIX + sessionID)
  }

  async #scan(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const entries: Array<{ key: string; value: unknown }> = []
    let after: string | undefined
    for (;;) {
      const page = await this.#ctx.storage.scan(after === undefined ? { prefix } : { prefix, after })
      entries.push(...page.entries)
      if (page.next === undefined || page.entries.length === 0) return entries
      after = page.next
    }
  }

  async #saveGoal(sessionID: string): Promise<void> {
    const goal = this.goals.get(sessionID)
    this.#sync(sessionID)
    if (goal) await this.#ctx.storage.set(GOAL_KEY_PREFIX + sessionID, goal as never)
  }

  async #saveLoop(sessionID: string): Promise<void> {
    const loop = this.loops.get(sessionID)
    this.#sync(sessionID)
    if (loop) await this.#ctx.storage.set(LOOP_KEY_PREFIX + sessionID, loop as never)
  }

  async #synthetic(
    sessionID: string,
    text: string,
    description: string,
    kind: string,
    options: { delivery: "queue" | "steer"; resume: boolean; iteration?: number },
  ): Promise<void> {
    const metadata: Loose = { source: GOAL_SOURCE, kind }
    if (options.iteration !== undefined) metadata.iteration = options.iteration
    await this.#ctx.session.synthetic({
      sessionID,
      text,
      description,
      metadata,
      delivery: options.delivery,
      resume: options.resume,
    } as never)
  }

  async #prompt(sessionID: string, text: string, kind: string, delivery?: string, iteration?: number): Promise<void> {
    const metadata: Loose = { source: GOAL_SOURCE, kind }
    if (iteration !== undefined) metadata.iteration = iteration
    await this.#ctx.session.prompt({ sessionID, text, metadata, delivery: delivery ?? "queue" } as never)
  }

  /**
   * A status line for the user. Plugins have no toast API, so it is a synthetic
   * message that does not start a turn; steer delivery folds it into the next
   * turn instead of giving it a model turn of its own.
   */
  async #notify(sessionID: string, text: string): Promise<void> {
    try {
      await this.#synthetic(sessionID, text, text.split("\n", 1)[0] ?? text, "notice", {
        delivery: "steer",
        resume: false,
      })
    } catch {
      // A notice that cannot be delivered must not break the command or event loop.
    }
  }
}
