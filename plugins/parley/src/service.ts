import { type Answer, type FileValue, normaliseAnswer, type SubmittedAnswer } from "./answers.ts"
import { visibleQuestions } from "./conditions.ts"
import { FALLBACK_KINDS, fromQuestionTool, type Prompt, toPrompt, unsupported } from "./fallback.ts"
import { baseMime, render } from "./format.ts"
import { fromOutbox, MAX_ATTEMPTS, messageID, type OutboxEntry, SENT_TTL_MS } from "./outbox.ts"
import { fromStored, type StoredRound, stale, toStored } from "./persist.ts"
import { Presence } from "./presence.ts"
import { coerceQuestion, type Question, validateQuestions } from "./questions.ts"
import {
  collect,
  RELOADED_REASON,
  type Round,
  type RoundResult,
  Rounds,
  TIMEOUT,
  view,
  type WaitMode,
  waitFor,
} from "./rounds.ts"
import type { RoundEvent } from "./rpc.ts"
import { BUILTIN, fromPrompts, nativeResult, shouldTakeOver } from "./takeover.ts"

export const DEFAULT_TIMEOUT_S = 1800
export const CLOSED_TTL_MS = 30 * 60_000
/** Timer jitter tolerated when deciding whether a timed-out call holds the round's deadline. */
const DEADLINE_SLACK_MS = 250

export interface Settings {
  /** `"question"` falls back to the built-in question tool when no TUI is attached. */
  readonly fallback: "question" | "none"
  /** `"takeover"` routes built-in `question` calls through parley while a TUI is attached. */
  readonly questionTool: "takeover" | "off"
  readonly disabled: boolean
  readonly heartbeatWindowMs: number
}

export function settingsFrom(options: Readonly<Record<string, unknown>>, env: Record<string, string | undefined>): Settings {
  const window = Number(options.heartbeat_window_s)
  return {
    fallback: options.fallback === "question" ? "question" : "none",
    questionTool: options.questionTool === "off" ? "off" : "takeover",
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
  /** The tool call id, recorded on taken-over rounds. */
  readonly callID?: string
}

export interface QuestionTool {
  execute(input: unknown, context: unknown): Promise<unknown>
}

/** Where open rounds are kept so they outlive a plugin reload. */
export interface RoundStore {
  /** The location this instance serves. Rounds are stored for every location in one place. */
  readonly directory: string
  /** Whether a session belongs to this instance's location. Unknown sessions are not owned. */
  readonly owns: (sessionID: string) => Promise<boolean>
  readonly list: () => Promise<readonly unknown[]>
  readonly save: (round: StoredRound) => Promise<void>
  readonly remove: (roundID: string) => Promise<void>
  /** Messages still to be sent to a session, and recently sent ones. */
  readonly listOutbox: () => Promise<readonly unknown[]>
  readonly saveOutbox: (entry: OutboxEntry) => Promise<void>
  readonly removeOutbox: (key: string) => Promise<void>
}

/** A message for the session's agent, for answers that have no waiting tool call to return through. */
export interface SessionMessage {
  /** The host message id, the same on every retry of this message. */
  readonly id: string
  readonly sessionID: string
  readonly text: string
  readonly description: string
}

export interface Deps {
  readonly emit: (event: RoundEvent) => Promise<void>
  readonly store?: RoundStore
  /** Writes an upload to disk and returns its path; without it uploads cannot go in a session message. */
  readonly save?: (file: FileValue, roundID?: string) => string | undefined
  /** Removes what `save` wrote for a round. Called when the closed round is pruned, never before. */
  readonly dropUploads?: (roundID: string) => void
  readonly warn?: (message: string) => void
  readonly deliver?: (message: SessionMessage) => Promise<void>
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
  /** `"native"` words the result text like the built-in question tool. */
  readonly format?: "native" | "parley"
}

export interface WaitInput {
  readonly wait?: "all" | "any"
  readonly ids?: readonly string[]
  readonly timeout_s?: number
}

/** `timeout_s` as seconds: the default when missing, numbers sent as strings repaired, 0 for no limit. */
export function timeoutSeconds(value: unknown): number {
  const seconds = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_TIMEOUT_S
}

const unavailable = (reason: string): Result => ({ status: "unavailable", reason, answers: [], pending: [] })

export class InputError extends Error {}

/** How long `suspend` waits for waiting calls and storage writes to settle. */
export const SUSPEND_DRAIN_MS = 2000

const DELIVERY_HEAD =
  "The parley plugin reloaded while you waited, so your parley call ended. The user answered that round afterwards; their answers follow. Act on them; do not ask these questions again."

const filesOf = (answer: Answer): FileValue[] => {
  const files = (answer.value as { files?: unknown } | undefined)?.files
  return Array.isArray(files) ? (files as FileValue[]) : []
}
const withData = (answer: Answer) => filesOf(answer).filter((file) => file.data !== undefined)

/**
 * The session message for answers that have no tool call to return through, in the wording of a parley
 * tool result. A message carries text only, so uploads are written to disk and reported by path (text
 * files are inlined, as in a normal result). Without `save`, answers with uploads are held back: their
 * ids come back in `held`, and the text says how to get them.
 */
export function deliveryMessage(
  result: RoundResult,
  questions: readonly Question[],
  save: Deps["save"],
  heldAdvice: string,
): { text: string; held: string[] } {
  const held = save ? [] : result.answers.filter((answer) => withData(answer).length > 0).map((answer) => answer.id)
  const notes: string[] = []
  const answers = result.answers
    .filter((answer) => !held.includes(answer.id))
    .map((answer) => {
      const files = filesOf(answer).map((file) => {
        if (file.data === undefined || !baseMime(file.mime).startsWith("image/")) return file
        const path = save?.(file)
        notes.push(`${answer.id}: ${file.name} (${baseMime(file.mime)}, ${file.size} B)${path ? ` saved to ${path}` : " not forwarded"}`)
        const { data: _data, ...rest } = file
        return rest
      })
      return files.length === 0 ? answer : { ...answer, value: { ...(answer.value as object), files } }
    })
  const body = render({ ...result, answers }, questions, save).content as string
  const lines = [DELIVERY_HEAD, "", body, ...notes]
  if (held.length > 0) lines.push("", `Uploads in ${held.join(", ")} could not be sent in a message. ${heldAdvice}`)
  return { text: lines.join("\n"), held }
}

/** The message id as a line of the text: the host may collapse a repeat by id, and if it does not, the agent can see it is one. */
const withKey = (text: string, id: string) => `${text}\n\nDelivery key: ${id} (a repeat of this key is the same message)`

const failure = (error: unknown) =>
  `Could not send the answers to the session: ${error instanceof Error ? error.message : String(error)}`

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
  /** Identifies this instance, so a client can tell that the plugin reloaded under it. */
  readonly instance = crypto.randomUUID()
  /** Open rounds restored from storage that no tool call is waiting on. Their answers go to the session as a message. */
  readonly #orphans = new Set<string>()
  readonly #waits = new Set<AbortController>()
  readonly #inflight = new Set<Promise<unknown>>()
  /** Deliveries that are pending or recently sent, by key. Kept in storage too, so a reload does not forget them. */
  readonly #outbox = new Map<string, OutboxEntry>()
  #suspended = false
  #writes: Promise<unknown> = Promise.resolve()
  #pending = 0

  constructor(readonly deps: Deps) {
    this.presence = new Presence(deps.settings.heartbeatWindowMs)
    this.#now = deps.now ?? Date.now
    this.rounds.subscribe((round) => this.#persist(round))
  }

  /** Loads the rounds a previous instance left in storage; call once, before the tools are registered. */
  async restore() {
    const store = this.deps.store
    if (!store) return
    const entries = await store.list().catch(() => [])
    const now = this.#now()
    const keep: Round[] = []
    for (const entry of entries) {
      const restored = fromStored(entry)
      if (!restored) {
        this.deps.warn?.(`parley: ignoring a stored round that is not valid (${(entry as { id?: unknown } | null)?.id ?? "no id"})`)
        continue
      }
      const { round, directory } = restored
      // Storage holds every location's rounds; another location's instance owns and writes those.
      if (directory !== store.directory || !(await store.owns(round.sessionID).catch(() => false))) continue
      if (stale(round, now, CLOSED_TTL_MS)) {
        this.#forget(round.id)
        this.deps.dropUploads?.(round.id)
      } else keep.push(round)
    }
    this.rounds.restore(keep)
    for (const round of keep) if (round.status === "open") this.#orphans.add(round.id)
    await this.#restoreOutbox(store)
  }

  /** Reads this location's outbox and sends again, with the same message ids, what the host never admitted. */
  async #restoreOutbox(store: RoundStore) {
    for (const raw of await store.listOutbox().catch(() => [])) {
      const entry = fromOutbox(raw)
      if (!entry) {
        this.deps.warn?.("parley: ignoring a stored delivery that is not valid")
        continue
      }
      if (entry.directory !== store.directory || !(await store.owns(entry.sessionID).catch(() => false))) continue
      if (entry.status === "sent" && this.#now() - entry.updated > SENT_TTL_MS) this.#dropOutbox(entry.key)
      else if (entry.status === "pending" && entry.attempts >= MAX_ATTEMPTS) {
        // Its answers stay undelivered, so parley_wait still returns them.
        this.deps.warn?.(`parley: giving up on delivering message ${entry.messageID} after ${entry.attempts} attempts`)
        this.#dropOutbox(entry.key)
      } else this.#outbox.set(entry.key, entry)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SUSPEND_DRAIN_MS * 2)
    })
    const retries = [...this.#outbox.values()].filter((entry) => entry.status === "pending").map((entry) => this.#send(entry))
    await Promise.race([Promise.allSettled(retries), bound]).finally(() => clearTimeout(timer))
  }

  #saveOutbox(entry: OutboxEntry) {
    this.#outbox.set(entry.key, entry)
    const store = this.deps.store
    if (!store) return
    const stored = { ...entry }
    this.#queue(() => store.saveOutbox(stored))
  }

  #dropOutbox(key: string) {
    this.#outbox.delete(key)
    const store = this.deps.store
    if (store) this.#queue(() => store.removeOutbox(key))
  }

  /**
   * Sends an outbox entry to the session under its fixed message id. Only once the host admits it are the
   * round's answers marked delivered, so a reload before that leaves them to be sent again, never hidden.
   * The text carries the message id, so a repeat the host does not collapse is recognisable to the agent.
   * Returns an error message, or undefined on success.
   */
  async #send(entry: OutboxEntry): Promise<string | undefined> {
    if (!this.deps.deliver) return "Cannot message the session from here."
    try {
      await this.deps.deliver({
        id: entry.messageID,
        sessionID: entry.sessionID,
        text: entry.text,
        description: entry.description,
      })
    } catch (error) {
      this.#saveOutbox({ ...entry, attempts: entry.attempts + 1, updated: this.#now() })
      return failure(error)
    }
    const round = entry.roundID === undefined ? undefined : this.rounds.get(entry.roundID)
    if (round) {
      for (const id of entry.answerIDs) if (round.answers.has(id)) round.delivered.add(id)
      this.#persist(round)
    }
    this.#saveOutbox({ ...entry, status: "sent", updated: this.#now() })
    // The marks and the sent state are in storage before the caller is told it worked.
    await this.#writes
    return undefined
  }

  #persist(round: Round) {
    const store = this.deps.store
    if (!store) return
    const stored = toStored(round, store.directory)
    this.#queue(() => store.save(stored))
  }

  /** Writes run one after another, so a round's states reach storage in the order they happened. */
  #queue(write: () => Promise<void>) {
    this.#pending++
    this.#writes = this.#writes
      .then(write)
      .catch(() => {})
      .finally(() => void this.#pending--)
  }

  #forget(roundID: string) {
    const store = this.deps.store
    if (!store) return
    this.#queue(() => store.remove(roundID))
  }

  attached(sessionID?: string) {
    return this.presence.attached(this.#now(), sessionID)
  }

  /** Whether the `question` tool should be wrapped at all: takeover on and some TUI attached here. */
  takeoverWanted() {
    this.presence.prune(this.#now())
    return shouldTakeOver(this.deps.settings, this.presence.size > 0)
  }

  async ask(input: AskInput, context: CallContext): Promise<{ result: Result; questions: readonly Question[] }> {
    const questions = (Array.isArray(input.questions) ? input.questions.map(coerceQuestion) : input.questions) as Question[]
    if (this.deps.settings.disabled) return { result: unavailable("disabled"), questions }
    if (!this.attached(context.sessionID)) {
      const errors = validateQuestions(questions)
      if (errors.length > 0) throw new InputError(`Invalid questions:\n- ${errors.join("\n- ")}`)
      return { result: await this.#fallback({ ...input, questions }, context), questions }
    }
    return this.#open({ ...input, questions }, context)
  }

  /**
   * Runs a built-in `question` call as a parley round when takeover applies, and returns its result in
   * the question tool's shape. `BUILTIN` means: hand the call to the built-in tool, either because
   * takeover does not apply or because the user dismissed the round. In that case the dismissing TUI
   * cancels the built-in form, so the call fails with the built-in dismissal and the turn ends.
   */
  async takeover(input: { questions?: readonly Prompt[] }, context: CallContext) {
    if (!shouldTakeOver(this.deps.settings, this.attached(context.sessionID))) return BUILTIN
    const prompts = input.questions ?? []
    const mapped = fromPrompts(prompts)
    if ("errors" in mapped) return BUILTIN
    const { result, questions } = await this.#open({ questions: mapped.questions, timeout_s: 0 }, context, context.callID)
    // The user did not answer (the plugin reloaded under the call). Failing the call says so; a result
    // in the question tool's shape would read as an answer.
    if (result.status === "unavailable") throw new Error(`The question was not answered: ${result.reason ?? "unavailable"}`)
    if (result.status === "cancelled") {
      if (result.reason === "user_closed" || result.reason === "dismissed") return BUILTIN
      throw new Error(`The question was cancelled before the user answered (${result.reason ?? "cancelled"})`)
    }
    return nativeResult(prompts, questions, result)
  }

  /**
   * Tells the session's TUI that a `question` call went to the built-in tool. Its form events reach
   * the TUI without a location when the tool runs under the plugin's wrapper, and the TUI drops those,
   * so the TUI fetches the form itself.
   */
  async handedToBuiltin(sessionID: string, callID: string) {
    if (!this.attached(sessionID)) return
    await this.deps.emit({ sessionID, roundID: "", action: "native", callID })
  }

  async #open(input: AskInput, context: CallContext, callID?: string): Promise<{ result: Result; questions: readonly Question[] }> {
    const questions = input.questions
    const opened = this.rounds.open(
      context.sessionID,
      {
        questions,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.round === undefined ? {} : { round: input.round }),
        ...(callID === undefined ? {} : { callID }),
      },
      this.#now(),
    )
    if ("errors" in opened) throw new InputError(`Invalid questions:\n- ${opened.errors.join("\n- ")}`)
    const { round, joined } = opened
    if ((input.wait ?? "all") !== "none") this.#extendDeadline(round, input.timeout_s)
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

  /** Records when a waiting call gives up, so the TUI can show the time left. The latest deadline wins. */
  #extendDeadline(round: Round, timeout_s: number | undefined) {
    const seconds = timeoutSeconds(timeout_s)
    if (seconds === 0 || round.status !== "open") return
    round.deadline = Math.max(round.deadline ?? 0, this.#now() + seconds * 1000)
    this.#persist(round)
  }

  async wait(input: WaitInput, context: CallContext): Promise<{ result: Result; questions: readonly Question[] }> {
    const round = this.rounds.current(context.sessionID) ?? this.rounds.latest(context.sessionID)
    if (!round) return { result: { status: "none", answers: [], pending: [] }, questions: [] }
    if (round.status === "open") {
      this.#extendDeadline(round, input.timeout_s)
      await this.deps.emit({ sessionID: round.sessionID, roundID: round.id, action: "updated" })
    }
    const result = await this.#await(round, {
      mode: input.wait ?? "all",
      ids: input.ids,
      timeout_s: input.timeout_s,
      context,
    })
    // The agent has these answers now; a delivery still waiting to be sent would repeat them.
    const waiting = this.#outbox.get(`round-${round.id}`)
    if (waiting?.status === "pending" && result.answers.length > 0) this.#dropOutbox(waiting.key)
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
    return { ok: true, window_s: this.presence.windowMs / 1000, instance: this.instance }
  }

  pending(input: { sessionID?: string }) {
    return { rounds: this.rounds.pending(input.sessionID).map(view), instance: this.instance }
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
    if (outcome.ok && round && final) return { ...outcome, errors: await this.#deliverOrphan(round) }
    return outcome
  }

  /**
   * Sends answers the TUI holds for a round this instance does not know (it was never persisted) to the
   * session as a message, so the user's input is not lost. Answers with uploads fail unless there is a
   * place to save the files: no round keeps them, so the TUI must keep the card and its draft.
   */
  async deliver(input: {
    sessionID: string
    number?: number
    questions: readonly Question[]
    answers: readonly SubmittedAnswer[]
    /** Names one send, so a retry after a lost acknowledgement does not send it again. */
    deliveryID?: string
  }) {
    if (!this.deps.deliver) return { ok: false, errors: ["Cannot message the session from here."] }
    const key = input.deliveryID ?? `anon-${crypto.randomUUID()}`
    const existing = this.#outbox.get(key)
    if (existing?.status === "sent") return { ok: true, errors: [] }
    const errors: string[] = []
    const answers: Answer[] = []
    for (const item of input.answers) {
      const question = input.questions.find((candidate) => candidate.id === item.id)
      if (!question) {
        errors.push(`unknown question ${item.id}`)
        continue
      }
      const result = normaliseAnswer(question, item)
      if ("error" in result) errors.push(result.error)
      else answers.push(result.answer)
    }
    if (errors.length > 0) return { ok: false, errors }
    const answered = new Set(answers.map((answer) => answer.id))
    const result: RoundResult = {
      status: "submitted",
      ...(input.number === undefined ? {} : { round: input.number }),
      answers,
      pending: input.questions.filter((question) => !answered.has(question.id)).map((question) => question.id),
    }
    const save = this.deps.save
    const { text, held } = deliveryMessage(result, input.questions, save && ((file) => save(file)), "")
    if (held.length > 0)
      return {
        ok: false,
        errors: [`Uploads in ${held.join(", ")} cannot be sent in a message and there is nowhere to save them. Nothing was sent.`],
      }
    const now = this.#now()
    const id = existing?.messageID ?? messageID(now)
    const entry: OutboxEntry = {
      key,
      messageID: id,
      directory: this.deps.store?.directory ?? "",
      sessionID: input.sessionID,
      text: withKey(text, id),
      description: "Parley answers",
      answerIDs: [],
      status: "pending",
      attempts: existing?.attempts ?? 0,
      created: existing?.created ?? now,
      updated: now,
    }
    // In storage before it is sent: a reload now retries it under the same id instead of losing it.
    this.#saveOutbox(entry)
    await this.#writes
    const error = await this.#send(entry)
    return error ? { ok: false, errors: [error] } : { ok: true, errors }
  }

  /**
   * A restored round has no waiting call, so the answers that close it go to the session as a message.
   * Returns the errors to report to the client (none on success).
   */
  async #deliverOrphan(round: Round): Promise<string[]> {
    if (!this.#orphans.has(round.id) || round.status === "open") return []
    this.#orphans.delete(round.id)
    if (!this.deps.deliver) return []
    const key = `round-${round.id}`
    const existing = this.#outbox.get(key)
    if (existing?.status === "sent") return []
    const result = collect(round, { keep: true })
    const save = this.deps.save
    const { text, held } = deliveryMessage(
      result,
      round.questions,
      save && ((file) => save(file, round.id)),
      "Call parley_wait to receive them.",
    )
    const now = this.#now()
    const id = existing?.messageID ?? messageID(now)
    const entry: OutboxEntry = {
      key,
      messageID: id,
      directory: this.deps.store?.directory ?? "",
      sessionID: round.sessionID,
      text: withKey(text, id),
      description: `Parley round ${round.number} answers`,
      roundID: round.id,
      answerIDs: result.answers.map((answer) => answer.id).filter((answerID) => !held.includes(answerID)),
      status: "pending",
      attempts: existing?.attempts ?? 0,
      created: existing?.created ?? now,
      updated: now,
    }
    this.#saveOutbox(entry)
    await this.#writes
    const error = await this.#send(entry)
    return error ? [error] : []
  }

  async cancel(input: { roundID: string; reason?: string }) {
    const reason = input.reason ?? "user_closed"
    const ok = this.rounds.cancel(input.roundID, reason, this.#now())
    const round = this.rounds.get(input.roundID)
    if (ok && round) {
      await this.deps.emit({ sessionID: round.sessionID, roundID: round.id, action: "closed", status: "cancelled", reason })
      await this.#deliverOrphan(round)
    }
    return { ok }
  }

  /** Cancels every open round so blocked tool calls return (plugin unload or reload). */
  close(reason = "plugin_unloaded") {
    for (const round of this.rounds.pending()) this.rounds.cancel(round.id, reason, this.#now())
  }

  /**
   * Plugin reload: waiting calls end as `unavailable` and the rounds stay open in storage. The next
   * instance restores them and sends the answers to the session as a message.
   */
  suspend(timeoutMs = SUSPEND_DRAIN_MS): Promise<void> | undefined {
    this.#suspended = true
    for (const wait of [...this.#waits]) wait.abort()
    if (this.#inflight.size === 0 && this.#pending === 0) return undefined
    // Waiting calls write their last state as they end, so drain until nothing is left, within the bound.
    const drain = async () => {
      do {
        await Promise.allSettled([...this.#inflight])
        await this.#writes
      } while (this.#inflight.size > 0 || this.#pending > 0)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    return Promise.race([drain(), bound]).finally(() => clearTimeout(timer))
  }

  sweep() {
    for (const id of this.rounds.sweep(this.#now(), CLOSED_TTL_MS)) {
      this.#forget(id)
      this.deps.dropUploads?.(id)
    }
    this.presence.prune(this.#now())
  }

  #await(
    round: Round,
    options: { mode: WaitMode; ids?: readonly string[]; timeout_s?: number; context: CallContext },
  ): Promise<Result> {
    const run = this.#awaitRound(round, options)
    this.#inflight.add(run)
    void run.then(
      () => this.#inflight.delete(run),
      () => this.#inflight.delete(run),
    )
    return run
  }

  async #awaitRound(
    round: Round,
    options: { mode: WaitMode; ids?: readonly string[]; timeout_s?: number; context: CallContext },
  ): Promise<Result> {
    const { context } = options
    this.#orphans.delete(round.id)
    const reload = new AbortController()
    this.#waits.add(reload)
    if (this.#suspended) reload.abort()
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
        timeoutMs: timeoutSeconds(options.timeout_s) * 1000,
        signal: context.signal === undefined ? reload.signal : AbortSignal.any([context.signal, reload.signal]),
      })
      if (outcome === "aborted" && this.#suspended && !context.signal?.aborted)
        return {
          status: "unavailable",
          reason: RELOADED_REASON,
          round: round.number,
          round_id: round.id,
          answers: [],
          pending: round.questions.map((question) => question.id).filter((id) => !round.answers.has(id)),
          channel: "tui",
        }
      // A timeout closes the round like a dismissal, so the TUI takes it down and the model moves on.
      // Only the call with the latest deadline closes it; one that gave up earlier leaves it to that call.
      const last = round.deadline === undefined || this.#now() >= round.deadline - DEADLINE_SLACK_MS
      const closing = outcome === "aborted" ? "aborted" : outcome === "timeout" && last ? TIMEOUT : undefined
      if (closing && this.rounds.cancel(round.id, closing, this.#now()))
        await this.deps.emit({
          sessionID: round.sessionID,
          roundID: round.id,
          action: "closed",
          status: closing === TIMEOUT ? "timeout" : "cancelled",
          reason: closing,
        })
      return {
        ...collect(round, { ...(options.ids === undefined ? {} : { ids: options.ids }), timedOut: outcome === "timeout" }),
        channel: "tui",
      }
    } finally {
      stop()
      this.#waits.delete(reload)
      this.#persist(round)
    }
  }

  async #fallback(input: AskInput, context: CallContext): Promise<Result> {
    if (this.deps.settings.fallback !== "question") return unavailable("no_tui")
    if (input.questions.some((question) => question.show_if !== undefined)) return this.#conditionalFallback(input, context)
    const blocked = unsupported(input.questions)
    if (blocked.length > 0)
      return { ...unavailable(
        `no_tui; the question tool cannot ask ${blocked.join(", ")} (supports ${[...FALLBACK_KINDS].join(", ")})`,
      ), pending: blocked }
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

  /** A dependent prompt must not be sent until its predecessor has actually been answered. */
  async #conditionalFallback(input: AskInput, context: CallContext): Promise<Result> {
    const tool = await this.deps.questionTool?.()
    if (!tool) return unavailable("no_tui; question tool not available")
    const answers: Answer[] = []
    const unavailableIDs: string[] = []
    try {
      for (const question of input.questions) {
        const active = visibleQuestions(input.questions, (id) => answers.find((answer) => answer.id === id)?.value)
        if (!active.some((entry) => entry.id === question.id)) continue
        if (unsupported([question]).length > 0) { unavailableIDs.push(question.id); continue }
        const raw = (await tool.execute({ questions: [toPrompt(question)] }, context.tool)) as {
          output?: { answers?: string[][] }; metadata?: { answers?: string[][] }
        }
        answers.push(...fromQuestionTool([question], raw?.output?.answers ?? raw?.metadata?.answers ?? []))
      }
      return { status: unavailableIDs.length > 0 ? "unavailable" : "submitted", channel: "question", answers, pending: unavailableIDs,
        ...(unavailableIDs.length > 0 ? { reason: `no_tui; unavailable questions: ${unavailableIDs.join(", ")}` } : {}),
        ...(input.round === undefined ? {} : { round: input.round }) }
    } catch (error) {
      if (context.signal?.aborted || isCancel(error)) return { status: "cancelled", reason: context.signal?.aborted ? "aborted" : "dismissed", channel: "question", answers,
        pending: visibleQuestions(input.questions, (id) => answers.find((answer) => answer.id === id)?.value).filter((q) => !answers.some((answer) => answer.id === q.id)).map((q) => q.id) }
      throw error
    }
  }

}
