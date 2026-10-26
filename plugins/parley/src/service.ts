import type { SubmittedAnswer } from "./answers.ts"
import { FALLBACK_KINDS, fromQuestionTool, toPrompt, unsupported } from "./fallback.ts"
import { Presence } from "./presence.ts"
import { coerceQuestion, type Question, validateQuestions } from "./questions.ts"
import { collect, type Round, type RoundResult, Rounds, view, type WaitMode, waitFor } from "./rounds.ts"
import type { RoundEvent } from "./rpc.ts"

export const DEFAULT_TIMEOUT_S = 1800
export const CLOSED_TTL_MS = 30 * 60_000

export interface Settings {
  /** `"question"` falls back to the built-in question tool when no TUI is attached. */
  readonly fallback: "question" | "none"
  readonly disabled: boolean
  readonly heartbeatWindowMs: number
}

export function settingsFrom(options: Readonly<Record<string, unknown>>, env: Record<string, string | undefined>): Settings {
  const window = Number(options.heartbeat_window_s)
  return {
    fallback: options.fallback === "question" ? "question" : "none",
    disabled: options.ui === "off" || env.PARLEY_DISABLE === "1",
    heartbeatWindowMs: Number.isFinite(window) && window > 0 ? window * 1000 : 30_000,
  }
}

export interface CallContext {
  readonly sessionID: string
  readonly signal?: AbortSignal
  readonly progress?: (update: Record<string, unknown>) => Promise<void>
  /** The original tool context, passed through to the question tool in fallback mode. */
  readonly tool?: unknown
}

export interface QuestionTool {
  execute(input: unknown, context: unknown): Promise<unknown>
}

export interface Deps {
  readonly emit: (event: RoundEvent) => Promise<void>
  readonly now?: () => number
  readonly questionTool?: () => Promise<QuestionTool | undefined>
  readonly settings: Settings
}

export interface Result extends RoundResult {
  readonly channel?: "tui" | "question"
}

export interface AskInput {
  readonly questions: readonly Question[]
  readonly title?: string
  readonly round?: number
  readonly wait?: WaitMode
  readonly timeout_s?: number
}

export interface WaitInput {
  readonly wait?: "all" | "any"
  readonly ids?: readonly string[]
  readonly timeout_s?: number
}

const unavailable = (reason: string): Result => ({ status: "unavailable", reason, answers: [], pending: [] })

export class InputError extends Error {}

const isCancel = (error: unknown) => {
  const text = `${(error as { name?: string })?.name ?? ""} ${(error as { _tag?: string })?._tag ?? ""} ${
    error instanceof Error ? error.message : String(error)
  }`
  return /cancel|dismiss/i.test(text)
}

/** Everything behind the tools and RPC methods. The plugin `setup` only wires this to the context. */
export class Parley {
  readonly rounds = new Rounds()
  readonly presence: Presence
  readonly #now: () => number

  constructor(readonly deps: Deps) {
    this.presence = new Presence(deps.settings.heartbeatWindowMs)
    this.#now = deps.now ?? Date.now
  }

  attached(sessionID?: string) {
    return this.presence.attached(this.#now(), sessionID)
  }

  async ask(input: AskInput, context: CallContext): Promise<{ result: Result; questions: readonly Question[] }> {
    const questions = (Array.isArray(input.questions) ? input.questions.map(coerceQuestion) : input.questions) as Question[]
    if (this.deps.settings.disabled) return { result: unavailable("disabled"), questions }
    if (!this.attached(context.sessionID)) {
      const errors = validateQuestions(questions)
      if (errors.length > 0) throw new InputError(`Invalid questions:\n- ${errors.join("\n- ")}`)
      return { result: await this.#fallback({ ...input, questions }, context), questions }
    }
    const opened = this.rounds.open(
      context.sessionID,
      {
        questions,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.round === undefined ? {} : { round: input.round }),
      },
      this.#now(),
    )
    if ("errors" in opened) throw new InputError(`Invalid questions:\n- ${opened.errors.join("\n- ")}`)
    const { round, joined } = opened
    await this.deps.emit({ sessionID: round.sessionID, roundID: round.id, action: joined ? "updated" : "opened" })
    const ids = questions.map((question) => question.id)
    const result = await this.#await(round, {
      mode: input.wait ?? "all",
      ids: joined ? ids : undefined,
      timeout_s: input.timeout_s,
      context,
    })
    return { result, questions: round.questions }
  }

  async wait(input: WaitInput, context: CallContext): Promise<{ result: Result; questions: readonly Question[] }> {
    const round = this.rounds.current(context.sessionID) ?? this.rounds.latest(context.sessionID)
    if (!round) return { result: { status: "none", answers: [], pending: [] }, questions: [] }
    const result = await this.#await(round, {
      mode: input.wait ?? "all",
      ids: input.ids,
      timeout_s: input.timeout_s,
      context,
    })
    return { result, questions: round.questions }
  }

  async end(sessionID: string, message?: string) {
    let closed = 0
    const round = this.rounds.current(sessionID)
    if (round && this.rounds.cancel(round.id, "ended", this.#now())) closed++
    await this.deps.emit({
      sessionID,
      roundID: round?.id ?? "",
      action: "ended",
      ...(message === undefined ? {} : { message }),
    })
    return { ok: true, closed }
  }

  // RPC handlers

  attach(input: { clientID: string; sessionIDs?: string[]; detach?: boolean }) {
    if (input.detach) this.presence.detach(input.clientID)
    else this.presence.attach(input.clientID, this.#now(), input.sessionIDs)
    return { ok: true, window_s: this.presence.windowMs / 1000 }
  }

  pending(input: { sessionID?: string }) {
    return { rounds: this.rounds.pending(input.sessionID).map(view) }
  }

  async submit(input: { roundID: string; answers: readonly SubmittedAnswer[]; final?: boolean }) {
    const final = input.final !== false
    const outcome = this.rounds.submit(input.roundID, input.answers, final, this.#now())
    const round = this.rounds.get(input.roundID)
    if (outcome.ok && round)
      await this.deps.emit({
        sessionID: round.sessionID,
        roundID: round.id,
        action: final ? "closed" : "updated",
        status: round.status,
      })
    return outcome
  }

  async cancel(input: { roundID: string; reason?: string }) {
    const reason = input.reason ?? "user_closed"
    const ok = this.rounds.cancel(input.roundID, reason, this.#now())
    const round = this.rounds.get(input.roundID)
    if (ok && round)
      await this.deps.emit({ sessionID: round.sessionID, roundID: round.id, action: "closed", status: "cancelled", reason })
    return { ok }
  }

  /** Cancels every open round so blocked tool calls return (plugin unload or reload). */
  close(reason = "plugin_unloaded") {
    for (const round of this.rounds.pending()) this.rounds.cancel(round.id, reason, this.#now())
  }

  sweep() {
    this.rounds.sweep(this.#now(), CLOSED_TTL_MS)
    this.presence.prune(this.#now())
  }

  async #await(
    round: Round,
    options: { mode: WaitMode; ids?: readonly string[]; timeout_s?: number; context: CallContext },
  ): Promise<Result> {
    const { context } = options
    const total = () =>
      options.ids === undefined ? round.questions.length : round.questions.filter((q) => options.ids?.includes(q.id)).length
    const report = () =>
      context.progress?.({ round: round.number, answered: round.answers.size, total: total() }).catch(() => {})
    const stop = this.rounds.subscribe((changed) => {
      if (changed.id === round.id) void report()
    })
    try {
      await report()
      const outcome = await waitFor(this.rounds, round, {
        mode: options.mode,
        ...(options.ids === undefined ? {} : { ids: options.ids }),
        timeoutMs: (options.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      if (outcome === "aborted" && this.rounds.cancel(round.id, "aborted", this.#now()))
        await this.deps.emit({
          sessionID: round.sessionID,
          roundID: round.id,
          action: "closed",
          status: "cancelled",
          reason: "aborted",
        })
      return {
        ...collect(round, { ...(options.ids === undefined ? {} : { ids: options.ids }), timedOut: outcome === "timeout" }),
        channel: "tui",
      }
    } finally {
      stop()
    }
  }

  async #fallback(input: AskInput, context: CallContext): Promise<Result> {
    if (this.deps.settings.fallback !== "question") return unavailable("no_tui")
    const blocked = unsupported(input.questions)
    if (blocked.length > 0)
      return unavailable(
        `no_tui; the question tool cannot ask ${blocked.join(", ")} (supports ${[...FALLBACK_KINDS].join(", ")})`,
      )
    const tool = await this.deps.questionTool?.()
    if (!tool) return unavailable("no_tui; question tool not available")
    try {
      const raw = (await tool.execute({ questions: input.questions.map(toPrompt) }, context.tool)) as {
        output?: { answers?: string[][] }
        metadata?: { answers?: string[][] }
      }
      const answers = raw?.output?.answers ?? raw?.metadata?.answers ?? []
      return {
        status: "submitted",
        channel: "question",
        ...(input.round === undefined ? {} : { round: input.round }),
        answers: fromQuestionTool(input.questions, answers),
        pending: [],
      }
    } catch (error) {
      const pending = input.questions.map((question) => question.id)
      if (context.signal?.aborted) return { status: "cancelled", reason: "aborted", channel: "question", answers: [], pending }
      if (isCancel(error)) return { status: "cancelled", reason: "dismissed", channel: "question", answers: [], pending }
      throw error
    }
  }
}
