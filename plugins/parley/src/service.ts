import { type Answer, type FileValue, normaliseAnswer, publicAnswer, type SubmittedAnswer } from "./answers.ts"
import { visibleQuestions } from "./conditions.ts"
import { FALLBACK_KINDS, fromQuestionTool, type Prompt, toPrompt, unsupported } from "./fallback.ts"
import { baseMime, fileNote, summarise } from "./format.ts"
import { fromOutbox, MAX_ATTEMPTS, messageID, type OutboxEntry, type RoundDelivery, SENT_TTL_MS } from "./outbox.ts"
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
  /** Records that a round closed, so its saved uploads are kept 24 h from then (see `uploads.ts`). */
  readonly closeUploads?: (roundID: string, at: number) => void
  /** Removes uploads whose round closed more than 24 h ago. */
  readonly sweepUploads?: (now: number) => void
  /** Removes one private copy made by `save`, when the submission it was made for is not committed. */
  readonly removeUpload?: (stored: string) => void
  /** Reads back a private upload copy (`FileValue.stored`) as base64, or undefined when it is gone. */
  readonly readUpload?: (stored: string) => string | undefined
  /** Waits between automatic retries of a round's message; defaults to `RETRY_DELAYS_MS`. */
  readonly retryDelaysMs?: readonly number[]
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
const HELD_FOR_WAIT = "Call parley_wait to receive them."

/** Waits between the automatic retries of a round's message, after the first attempt fails. */
export const RETRY_DELAYS_MS: readonly number[] = [2000, 8000]

const copyKey = (file: FileValue) => `${file.name}\u0000${file.data}`
const basename = (name: string) => name.split(/[\\/]/).pop() || "upload"

const filesOf = (answer: Answer): FileValue[] => {
  const files = (answer.value as { files?: unknown } | undefined)?.files
  return Array.isArray(files) ? (files as FileValue[]) : []
}
const withData = (answer: Answer) => filesOf(answer).filter((file) => file.data !== undefined)

type Save = (file: FileValue) => string | undefined

/** What a message says about one answer's uploads. A message carries text only, so files are saved and named by path, text files inlined. */
function uploadNotes(answer: Answer, save?: Save): string[] {
  return withData(answer).map((file) => {
    const inline = fileNote(answer.id, file, save)
    if (inline !== undefined) return inline
    const path = file.stored ?? save?.(file)
    return `${answer.id}: ${file.name} (${baseMime(file.mime)}, ${file.size} B)${path ? ` saved to ${path}` : " not forwarded"}`
  })
}

export interface AnswerPlan {
  readonly answerIDs: string[]
  readonly notes: Record<string, string[]>
  /** Answers with uploads and nowhere to save them. */
  readonly held: string[]
}

/** Which answers a message carries and what it says about their uploads. Without `save`, answers with uploads are held back. */
export function planAnswers(answers: readonly Answer[], save?: Save): AnswerPlan {
  const held = save ? [] : answers.filter((answer) => withData(answer).length > 0).map((answer) => answer.id)
  const carried = answers.filter((answer) => !held.includes(answer.id))
  return {
    answerIDs: carried.map((answer) => answer.id),
    notes: Object.fromEntries(carried.map((answer) => [answer.id, uploadNotes(answer, save)])),
    held,
  }
}

/** The text of a message for answers that have no tool call to return through, in the wording of a parley tool result. */
export function deliveryText(result: RoundResult, questions: readonly Question[], plan: AnswerPlan, heldAdvice: string): string {
  const answers = result.answers.filter((answer) => plan.answerIDs.includes(answer.id)).map(publicAnswer)
  const lines = [DELIVERY_HEAD, "", summarise({ ...result, answers }, questions), ...plan.answerIDs.flatMap((id) => plan.notes[id] ?? [])]
  if (plan.held.length > 0) lines.push("", `Uploads in ${plan.held.join(", ")} could not be sent in a message. ${heldAdvice}`)
  return lines.join("\n")
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const failure = (error: string) => `Could not send the answers to the session: ${error}`

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
  /** The TUI's fallback deliveries (rounds the server never held), by delivery id. Kept in storage too. */
  readonly #outbox = new Map<string, OutboxEntry>()
  /** One chain per round or delivery: collecting answers and sending them never interleave. */
  readonly #locks = new Map<string, Promise<unknown>>()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  /** Copies made for the submission in progress, so committing it does not copy them again. Keyed by name and contents. */
  #copies = new Map<string, string>()
  #suspended = false
  #writes: Promise<unknown> = Promise.resolve()
  #pending = 0

  constructor(readonly deps: Deps) {
    this.presence = new Presence(deps.settings.heartbeatWindowMs)
    this.#now = deps.now ?? Date.now
    this.rounds.subscribe((round) => {
      // Uploads are copied to the private store as they arrive, final or not, so the saved round can
      // reference them instead of holding (and losing) their bytes.
      this.#keepUploads(round)
      // The message is planned in the same call that saves the closure, so one write holds both.
      this.#plan(round)
      if (round.status !== "open") this.deps.closeUploads?.(round.id, round.updated)
      this.#persist(round)
    })
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
        this.deps.closeUploads?.(round.id, now)
      } else keep.push(round)
    }
    for (const round of keep) this.#loadUploads(round)
    this.rounds.restore(keep)
    for (const round of keep) if (round.status === "open") this.#orphans.add(round.id)
    this.deps.sweepUploads?.(now)
    await this.#restoreOutbox(store)
    // Messages planned before the reload and never admitted are sent again under the same id.
    const resends = [
      ...keep.filter((round) => round.delivery?.status === "pending").map((round) => this.#deliverRound(round)),
      ...[...this.#outbox.values()].filter((entry) => entry.status === "pending").map((entry) => this.#sendEntry(entry)),
    ]
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SUSPEND_DRAIN_MS * 2)
    })
    await Promise.race([Promise.allSettled(resends), bound]).finally(() => clearTimeout(timer))
  }

  async #restoreOutbox(store: RoundStore) {
    for (const raw of await store.listOutbox().catch(() => [])) {
      const entry = fromOutbox(raw)
      if (!entry) {
        this.deps.warn?.("parley: ignoring a stored delivery that is not valid")
        continue
      }
      if (entry.directory !== store.directory || !(await store.owns(entry.sessionID).catch(() => false))) continue
      if (this.#now() - entry.updated > SENT_TTL_MS) this.#dropOutbox(entry.key)
      else this.#outbox.set(entry.key, entry)
    }
  }

  /** Runs `task` after every earlier task with the same key. */
  #exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(key) ?? Promise.resolve()
    const run = before.then(task, task)
    const settled = run.then(
      () => {},
      () => {},
    )
    this.#locks.set(key, settled)
    void settled.then(() => {
      if (this.#locks.get(key) === settled) this.#locks.delete(key)
    })
    return run
  }

  /** Sends a message to the host, counted as in flight so a reload waits for its result. */
  async #post(message: SessionMessage): Promise<string | undefined> {
    const deliver = this.deps.deliver
    if (!deliver) return "Cannot message the session from here."
    const sending = deliver(message).then(
      () => undefined,
      (error: unknown) => messageOf(error),
    )
    this.#inflight.add(sending)
    void sending.finally(() => this.#inflight.delete(sending))
    return sending
  }

  /**
   * Plans the message for a restored round as it closes. It carries the answers the agent has not had,
   * under a host message id fixed now; the host admits an id once, so retries cannot repeat it.
   */
  #plan(round: Round) {
    if (round.status === "open" || !this.#orphans.has(round.id)) return
    this.#orphans.delete(round.id)
    if (!this.deps.deliver || round.delivery) return
    const save = this.deps.save
    const plan = planAnswers(collect(round, { keep: true }).answers, save && ((file) => save(file, round.id)))
    const now = this.#now()
    round.delivery = {
      messageID: messageID(now),
      generation: 0,
      description: `Parley round ${round.number} answers`,
      status: "pending",
      attempts: 0,
      created: now,
      updated: now,
      answerIDs: [...plan.answerIDs],
      notes: plan.notes,
      held: [...plan.held],
    }
  }

  /** Writes each upload that has bytes but no private copy yet, and records the copy on the answer. */
  #keepUploads(round: Round) {
    const save = this.deps.save
    if (!save) return
    for (const [id, answer] of round.answers) {
      const files = (answer.value as { files?: unknown } | undefined)?.files
      if (!Array.isArray(files) || !files.some((file: FileValue) => file.data !== undefined && file.stored === undefined)) continue
      const kept = (files as FileValue[]).map((file) => {
        if (file.data === undefined || file.stored !== undefined) return file
        const stored = this.#copies.get(copyKey(file)) ?? save(file, round.id)
        return stored === undefined ? file : { ...file, stored }
      })
      round.answers.set(id, { ...answer, value: { ...(answer.value as object), files: kept } })
    }
  }

  /** Copies the submitted answers' uploads into the private store; on a failure removes what this attempt copied. */
  #copyUploads(roundID: string, answers: readonly SubmittedAnswer[]): { copies: Map<string, string> } | { error: string } {
    const copies = new Map<string, string>()
    const save = this.deps.save
    const round = this.rounds.get(roundID)
    if (!save || round?.status !== "open") return { copies }
    for (const answer of answers) {
      const files = (answer.value as { files?: unknown } | undefined)?.files
      if (!Array.isArray(files)) continue
      for (const raw of files) {
        if (typeof raw !== "object" || raw === null || typeof raw.data !== "string" || typeof raw.name !== "string") continue
        const file = raw as FileValue
        if (copies.has(copyKey(file))) continue
        try {
          const stored = save(file, roundID)
          if (stored !== undefined) copies.set(copyKey(file), stored)
        } catch (error) {
          for (const done of copies.values()) this.deps.removeUpload?.(done)
          const code = (error as { code?: unknown } | null)?.code
          const kind = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "error"
          return { error: `Could not save the upload ${JSON.stringify(basename(file.name))} (${kind}). Nothing was submitted; send it again.` }
        }
      }
    }
    return { copies }
  }

  /** A restored round's answers reference their uploads' private copies; their bytes are read back from there. */
  #loadUploads(round: Round) {
    const read = this.deps.readUpload
    if (!read) return
    for (const [id, answer] of round.answers) {
      const files = (answer.value as { files?: unknown } | undefined)?.files
      if (!Array.isArray(files)) continue
      const loaded = (files as FileValue[]).map((file) => {
        if (file.data !== undefined || file.stored === undefined) return file
        const data = read(file.stored)
        return data === undefined ? file : { ...file, data }
      })
      round.answers.set(id, { ...answer, value: { ...(answer.value as object), files: loaded } })
    }
  }

  #roundText(round: Round, delivery: RoundDelivery) {
    const head = collect(round, { keep: true })
    const answers = delivery.answerIDs.map((id) => round.answers.get(id)).filter((answer): answer is Answer => answer !== undefined)
    return deliveryText({ ...head, answers }, round.questions, delivery, HELD_FOR_WAIT)
  }

  /** Sends a round's pending message now and, if that fails, again later. Returns the errors for the client. */
  async #deliverRound(round: Round): Promise<string[]> {
    const error = await this.#attemptRound(round)
    if (error !== undefined && round.delivery?.status === "pending") this.#retryLater(round, 0)
    return error === undefined ? [] : [error]
  }

  #retryLater(round: Round, step: number) {
    const delay = (this.deps.retryDelaysMs ?? RETRY_DELAYS_MS)[step]
    if (delay === undefined || this.#suspended) return
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      void this.#attemptRound(round).then((error) => {
        if (error !== undefined && round.delivery?.status === "pending") this.#retryLater(round, step + 1)
      })
    }, delay)
    timer.unref?.()
    this.#timers.add(timer)
  }

  /** One attempt at a round's message, in turn with the round's other sends and collections. */
  #attemptRound(round: Round): Promise<string | undefined> {
    return this.#exclusive(round.id, () => this.#attemptRoundNow(round))
  }

  /**
   * One attempt at a round's message; the caller holds the round's turn. The delivery is marked started,
   * and saved, before the first send: the host may admit any attempt, so from then on the message owns
   * its answers. They are marked delivered only once the host admits it. A result for a delivery that
   * changed or went while it was being sent is ignored. After `MAX_ATTEMPTS` failures the round goes back
   * to the user. `again` also sends a message that already failed (parley_wait finishing it).
   */
  async #attemptRoundNow(round: Round, again = false): Promise<string | undefined> {
    const delivery = round.delivery
    if (!delivery || this.#suspended) return undefined
    if (delivery.status !== "pending" && !(again && delivery.status === "failed")) return undefined
    const before = delivery.status
    if (!delivery.started) {
      delivery.started = true
      this.#persist(round)
      await this.#writes
    }
    const generation = delivery.generation
    const error = await this.#post({
      id: delivery.messageID,
      sessionID: round.sessionID,
      text: this.#roundText(round, delivery),
      description: delivery.description,
    })
    if (round.delivery !== delivery || delivery.generation !== generation) return undefined
    delivery.updated = this.#now()
    if (error === undefined) {
      for (const id of delivery.answerIDs) if (round.answers.has(id)) round.delivered.add(id)
      delivery.status = "sent"
      delete delivery.error
    } else {
      delivery.attempts++
      delivery.error = failure(error)
      if (delivery.attempts >= MAX_ATTEMPTS) delivery.status = "failed"
    }
    this.#persist(round)
    await this.#writes
    if (delivery.status === "failed" && before !== "failed")
      await this.deps.emit({
        sessionID: round.sessionID,
        roundID: round.id,
        action: "opened",
        status: "undelivered",
        reason: delivery.error ?? "",
      })
    // A card that was back with the user goes away once its message is in.
    if (delivery.status === "sent" && before === "failed")
      await this.deps.emit({ sessionID: round.sessionID, roundID: round.id, action: "closed", status: round.status })
    return error === undefined ? undefined : failure(error)
  }

  /**
   * The agent took these answers through a tool call. Before the first send the round's message stops
   * carrying them; once a send started the message owns its answers (they never reach this point), and
   * only held answers, which no message carries, leave the list.
   */
  #consume(round: Round, ids: readonly string[]) {
    const delivery = round.delivery
    if (!delivery || ids.length === 0 || delivery.status === "sent" || delivery.status === "dismissed") return
    const taken = new Set(ids)
    if (delivery.started) {
      const held = delivery.held.filter((id) => !taken.has(id))
      if (held.length === delivery.held.length) return
      delivery.held = held
      delivery.updated = this.#now()
      this.#persist(round)
      return
    }
    const carried = delivery.answerIDs.filter((id) => !taken.has(id))
    const held = delivery.held.filter((id) => !taken.has(id))
    if (carried.length === delivery.answerIDs.length && held.length === delivery.held.length) return
    delivery.answerIDs = carried
    delivery.held = held
    delivery.generation++
    delivery.updated = this.#now()
    if (carried.length === 0 && held.length === 0) {
      const wasFailed = delivery.status === "failed"
      round.delivery = undefined
      if (wasFailed) void this.deps.emit({ sessionID: round.sessionID, roundID: round.id, action: "closed", status: round.status })
    }
    this.#persist(round)
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

  /** Sends a fallback message under its fixed id. A result for an entry that was replaced or removed meanwhile is not written. */
  #sendEntry(entry: OutboxEntry): Promise<string | undefined> {
    return this.#exclusive(`outbox-${entry.key}`, async () => {
      if (this.#outbox.get(entry.key) !== entry || entry.status === "sent" || this.#suspended) return undefined
      const generation = entry.generation
      const error = await this.#post({ id: entry.messageID, sessionID: entry.sessionID, text: entry.text, description: entry.description })
      if (this.#outbox.get(entry.key) !== entry || entry.generation !== generation) return error === undefined ? undefined : failure(error)
      entry.updated = this.#now()
      if (error === undefined) {
        entry.status = "sent"
        delete entry.error
      } else {
        entry.attempts++
        entry.error = failure(error)
      }
      this.#saveOutbox(entry)
      await this.#writes
      return error === undefined ? undefined : failure(error)
    })
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

  /** Saves an upload for a tool result, under its round, and keeps it 24 h from the round's close. */
  saveUpload(file: FileValue, roundID?: string) {
    const path = this.deps.save?.(file, roundID)
    const round = roundID === undefined ? undefined : this.rounds.get(roundID)
    if (path !== undefined && round && round.status !== "open") this.deps.closeUploads?.(round.id, round.updated)
    return path
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
    // A round whose message failed is listed again, so the user can send it or dismiss it.
    const rounds = this.rounds
      .list()
      .filter((round) => round.status === "open" || round.delivery?.status === "failed")
      .filter((round) => input.sessionID === undefined || round.sessionID === input.sessionID)
    return { rounds: rounds.map(view), instance: this.instance }
  }

  /** The error for a round another session owns, or undefined. A caller without a session id is an older TUI: accepted, warned once. */
  #foreignRound(round: Round | undefined, sessionID: string | undefined) {
    if (!round) return undefined
    if (sessionID === undefined) {
      if (!this.#warnedNoSession) {
        this.#warnedNoSession = true
        this.deps.warn?.("parley: a submit without a session id was accepted; the TUI is older than the server")
      }
      return undefined
    }
    return round.sessionID === sessionID ? undefined : `round ${round.id} belongs to another session`
  }
  #warnedNoSession = false

  async submit(input: { roundID: string; sessionID?: string; answers: readonly SubmittedAnswer[]; final?: boolean }) {
    const final = input.final !== false
    const known = this.rounds.get(input.roundID)
    const foreign = this.#foreignRound(known, input.sessionID)
    if (foreign) return { ok: false, errors: [foreign] }
    // A closed round whose message failed: the client offers to send it again or dismiss it.
    if (known?.delivery?.status === "failed")
      return { ok: false, errors: [`undelivered round ${known.id}: ${known.delivery.error ?? "the message was not admitted"}`] }
    // Uploads are copied to the private store before anything is committed: a failed copy leaves the round
    // open and the card as it was, so the user can send again.
    const copied = this.#copyUploads(input.roundID, input.answers)
    if ("error" in copied) return { ok: false, errors: [copied.error] }
    this.#copies = copied.copies
    let outcome: ReturnType<Rounds["submit"]>
    try {
      outcome = this.rounds.submit(input.roundID, input.answers, final, this.#now())
    } finally {
      this.#copies = new Map()
    }
    if (!outcome.ok) for (const stored of copied.copies.values()) this.deps.removeUpload?.(stored)
    const round = this.rounds.get(input.roundID)
    if (outcome.ok && round)
      await this.deps.emit({
        sessionID: round.sessionID,
        roundID: round.id,
        action: final ? "closed" : "updated",
        status: round.status,
      })
    if (outcome.ok && round && final && round.delivery?.status === "pending")
      return { ...outcome, errors: await this.#deliverRound(round) }
    return outcome
  }

  /**
   * Sends answers to the session as a message, for the TUI's "Send these answers as a message". For a
   * round whose message failed, that message is sent again under its id. For a round the server never
   * held, the TUI's answers are sent; answers with uploads fail unless the files can be saved, since no
   * round keeps them, so the TUI keeps the card and its draft.
   */
  async deliver(input: {
    sessionID: string
    roundID?: string
    number?: number
    questions: readonly Question[]
    answers: readonly SubmittedAnswer[]
    /** Names one send, so a retry after a lost acknowledgement is the same message. */
    deliveryID?: string
  }) {
    if (!this.deps.deliver) return { ok: false, errors: ["Cannot message the session from here."] }
    const round = input.roundID === undefined ? undefined : this.rounds.get(input.roundID)
    const foreign = this.#foreignRound(round, input.sessionID)
    if (foreign) return { ok: false, errors: [foreign] }
    if (round?.delivery) return this.#resendRound(round)
    const key = input.deliveryID ?? `anon-${crypto.randomUUID()}`
    const existing = this.#outbox.get(key)
    if (existing?.status === "sent") return { ok: true, errors: [] }
    if (existing) {
      const error = await this.#sendEntry(existing)
      return error === undefined ? { ok: true, errors: [] } : { ok: false, errors: [error] }
    }
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
    const save = this.deps.save
    const plan = planAnswers(answers, save && ((file) => save(file)))
    if (plan.held.length > 0)
      return {
        ok: false,
        errors: [`Uploads in ${plan.held.join(", ")} cannot be sent in a message and there is nowhere to save them. Nothing was sent.`],
      }
    const answered = new Set(answers.map((answer) => answer.id))
    const result: RoundResult = {
      status: "submitted",
      ...(input.number === undefined ? {} : { round: input.number }),
      answers,
      pending: input.questions.filter((question) => !answered.has(question.id)).map((question) => question.id),
    }
    const now = this.#now()
    const entry: OutboxEntry = {
      key,
      messageID: messageID(now),
      generation: 0,
      directory: this.deps.store?.directory ?? "",
      sessionID: input.sessionID,
      text: deliveryText(result, input.questions, plan, ""),
      description: "Parley answers",
      status: "pending",
      attempts: 0,
      created: now,
      updated: now,
    }
    // In storage before it is sent: a reload now retries it under the same id instead of losing it.
    this.#saveOutbox(entry)
    await this.#writes
    const error = await this.#sendEntry(entry)
    return error === undefined ? { ok: true, errors: [] } : { ok: false, errors: [error] }
  }

  /** The user asked to send a failed round message again: same message id, a fresh set of attempts. */
  async #resendRound(round: Round) {
    const delivery = round.delivery
    if (!delivery || delivery.status === "sent") return { ok: true, errors: [] }
    if (delivery.status === "failed" || delivery.status === "dismissed") {
      delivery.status = "pending"
      delivery.attempts = 0
      delivery.generation++
      this.#persist(round)
    }
    const error = await this.#attemptRound(round)
    if (error !== undefined && round.delivery === delivery && delivery.status === "pending") {
      // The user is told now; the card comes back the same way if it keeps failing.
      delivery.status = "failed"
      this.#persist(round)
    }
    return error === undefined ? { ok: true, errors: [] } : { ok: false, errors: [error] }
  }

  /** The user dismissed a failed round message. Its answers stay for parley_wait. */
  #dismissDelivery(round: Round) {
    return this.#exclusive(round.id, async () => {
      const delivery = round.delivery
      if (delivery?.status !== "failed") return false
      delivery.status = "dismissed"
      delivery.generation++
      delivery.updated = this.#now()
      this.#persist(round)
      await this.deps.emit({ sessionID: round.sessionID, roundID: round.id, action: "closed", status: round.status, reason: "dismissed" })
      return true
    })
  }

  async cancel(input: { roundID: string; reason?: string }) {
    const reason = input.reason ?? "user_closed"
    const known = this.rounds.get(input.roundID)
    if (known?.delivery?.status === "failed") return { ok: await this.#dismissDelivery(known) }
    const ok = this.rounds.cancel(input.roundID, reason, this.#now())
    const round = this.rounds.get(input.roundID)
    if (ok && round) {
      await this.deps.emit({ sessionID: round.sessionID, roundID: round.id, action: "closed", status: "cancelled", reason })
      if (round.delivery?.status === "pending") await this.#deliverRound(round)
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
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
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
    for (const id of this.rounds.sweep(this.#now(), CLOSED_TTL_MS)) this.#forget(id)
    // Upload files go 24 h after their round closed, which is later than the round record.
    this.deps.sweepUploads?.(this.#now())
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
      // Collected in turn with the round's message, so no answer reaches the agent twice. Before the
      // message's first send, whatever the agent takes here leaves the message. Once a send started, the
      // message owns its answers: the wait finishes the send (same id, so a copy the host already admitted
      // is not repeated) and reports those answers by id only.
      return await this.#exclusive(round.id, async () => {
        const delivery = round.delivery
        const owned = delivery?.started ? new Set(delivery.answerIDs) : new Set<string>()
        if (delivery?.started) await this.#attemptRoundNow(round, true)
        const scope = (options.ids ?? round.questions.map((question) => question.id)).filter((id) => !owned.has(id))
        const result = collect(round, { ids: scope, timedOut: outcome === "timeout" })
        this.#consume(round, result.answers.map((answer) => answer.id))
        const messaged = [...owned].filter((id) => round.answers.has(id) && (options.ids === undefined || options.ids.includes(id)))
        const now = round.delivery
        const as_message =
          messaged.length === 0 || !now
            ? undefined
            : {
                status: now.status === "sent" ? ("delivered" as const) : now.status === "dismissed" ? ("dismissed" as const) : ("sending" as const),
                ids: messaged,
                ...(now.status === "sent" || now.error === undefined ? {} : { error: now.error }),
              }
        return { ...result, ...(as_message ? { as_message } : {}), channel: "tui" as const }
      })
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
