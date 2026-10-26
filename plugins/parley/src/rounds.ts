import { type Answer, normaliseAnswer, publicAnswer, type SubmittedAnswer } from "./answers.ts"
import { type Question, validateQuestions } from "./questions.ts"

export type RoundStatus = "open" | "submitted" | "cancelled"
export type WaitMode = "all" | "any" | "none"
export type ResultStatus = "submitted" | "open" | "partial" | "timeout" | "cancelled" | "unavailable" | "none"

export interface Round {
  readonly id: string
  readonly sessionID: string
  readonly number: number
  title?: string
  readonly questions: Question[]
  readonly answers: Map<string, Answer>
  readonly delivered: Set<string>
  status: RoundStatus
  reason?: string
  readonly created: number
  updated: number
}

/** What a client sees of a round (`pending` RPC). */
export interface RoundView {
  readonly roundID: string
  readonly sessionID: string
  readonly number: number
  readonly title?: string
  readonly status: RoundStatus
  readonly questions: readonly Question[]
  readonly answers: readonly Answer[]
}

export interface RoundResult {
  readonly status: ResultStatus
  readonly reason?: string
  readonly round?: number
  readonly round_id?: string
  readonly answers: Answer[]
  readonly pending: string[]
}

export interface OpenInput {
  readonly questions: readonly Question[]
  readonly title?: string
  readonly round?: number
}

type Listener = (round: Round) => void

/** In-memory rounds for one plugin instance, keyed by session. One open round per session. */
export class Rounds {
  readonly #rounds = new Map<string, Round>()
  readonly #counters = new Map<string, number>()
  readonly #listeners = new Set<Listener>()

  constructor(readonly newID: () => string = () => `rnd_${crypto.randomUUID().replaceAll("-", "")}`) {}

  /** Opens a round, or adds the questions to the session's open round. */
  open(sessionID: string, input: OpenInput, now: number): { round: Round; joined: boolean } | { errors: string[] } {
    const existing = this.current(sessionID)
    const errors = validateQuestions(input.questions, existing?.questions)
    if (errors.length > 0) return { errors }
    if (existing) {
      existing.questions.push(...input.questions)
      if (input.title !== undefined) existing.title = input.title
      existing.updated = now
      this.#emit(existing)
      return { round: existing, joined: true }
    }
    const number = input.round ?? (this.#counters.get(sessionID) ?? 0) + 1
    this.#counters.set(sessionID, Math.max(number, this.#counters.get(sessionID) ?? 0))
    const round: Round = {
      id: this.newID(),
      sessionID,
      number,
      ...(input.title === undefined ? {} : { title: input.title }),
      questions: [...input.questions],
      answers: new Map(),
      delivered: new Set(),
      status: "open",
      created: now,
      updated: now,
    }
    this.#rounds.set(round.id, round)
    this.#emit(round)
    return { round, joined: false }
  }

  get(roundID: string) {
    return this.#rounds.get(roundID)
  }

  current(sessionID: string) {
    for (const round of this.#rounds.values()) if (round.sessionID === sessionID && round.status === "open") return round
    return undefined
  }

  latest(sessionID: string) {
    let found: Round | undefined
    for (const round of this.#rounds.values()) if (round.sessionID === sessionID) found = round
    return found
  }

  pending(sessionID?: string): Round[] {
    return [...this.#rounds.values()].filter(
      (round) => round.status === "open" && (sessionID === undefined || round.sessionID === sessionID),
    )
  }

  /** Records answers. Invalid entries are reported and skipped; `final` closes the round. */
  submit(roundID: string, submitted: readonly SubmittedAnswer[], final: boolean, now: number) {
    const round = this.#rounds.get(roundID)
    if (!round) return { ok: false, errors: [`unknown round ${roundID}`] }
    if (round.status !== "open") return { ok: false, errors: [`round ${roundID} is ${round.status}`] }
    const errors: string[] = []
    const accepted: Answer[] = []
    for (const item of submitted) {
      const question = round.questions.find((candidate) => candidate.id === item.id)
      if (!question) {
        errors.push(`unknown question ${item.id}`)
        continue
      }
      const result = normaliseAnswer(question, item)
      if ("error" in result) errors.push(result.error)
      else accepted.push(result.answer)
    }
    // A submission with errors is rejected whole so the client can fix it and resend.
    if (errors.length > 0) return { ok: false, errors }
    for (const answer of accepted) {
      round.answers.set(answer.id, answer)
      round.delivered.delete(answer.id)
    }
    if (final) round.status = "submitted"
    round.updated = now
    this.#emit(round)
    return { ok: true, errors }
  }

  cancel(roundID: string, reason: string, now: number) {
    const round = this.#rounds.get(roundID)
    if (round?.status !== "open") return false
    round.status = "cancelled"
    round.reason = reason
    round.updated = now
    this.#emit(round)
    return true
  }

  /** Drops a session's rounds, cancelling any open one. */
  remove(sessionID: string, now: number) {
    for (const round of [...this.#rounds.values()]) {
      if (round.sessionID !== sessionID) continue
      this.cancel(round.id, "ended", now)
      this.#rounds.delete(round.id)
    }
  }

  /** Forgets closed rounds older than `ttlMs`. */
  sweep(now: number, ttlMs: number) {
    for (const [id, round] of this.#rounds) if (round.status !== "open" && now - round.updated > ttlMs) this.#rounds.delete(id)
  }

  subscribe(listener: Listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(round: Round) {
    for (const listener of [...this.#listeners]) listener(round)
  }
}

const scoped = (round: Round, ids?: readonly string[]) =>
  round.questions.map((question) => question.id).filter((id) => ids === undefined || ids.includes(id))

/** Whether a wait in `mode` is satisfied for the given ids. */
export function settled(round: Round, mode: WaitMode, ids?: readonly string[]): boolean {
  if (round.status !== "open" || mode === "none") return true
  const wanted = scoped(round, ids)
  if (mode === "any") return wanted.some((id) => round.answers.has(id) && !round.delivered.has(id))
  return wanted.every((id) => round.answers.has(id))
}

/** Builds a tool result and marks the returned answers as delivered. */
export function collect(round: Round, options: { ids?: readonly string[]; timedOut?: boolean } = {}): RoundResult {
  const wanted = scoped(round, options.ids)
  const fresh = wanted.filter((id) => round.answers.has(id) && !round.delivered.has(id))
  for (const id of fresh) round.delivered.add(id)
  const answers = fresh.map((id) => round.answers.get(id) as Answer)
  const pending = wanted.filter((id) => !round.answers.has(id))
  const status: ResultStatus =
    round.status === "submitted"
      ? "submitted"
      : round.status === "cancelled"
        ? "cancelled"
        : options.timedOut
          ? "timeout"
          : round.answers.size > 0
            ? "partial"
            : "open"
  return {
    status,
    ...(round.reason === undefined ? {} : { reason: round.reason }),
    round: round.number,
    round_id: round.id,
    answers,
    pending,
  }
}

export function view(round: Round): RoundView {
  return {
    roundID: round.id,
    sessionID: round.sessionID,
    number: round.number,
    ...(round.title === undefined ? {} : { title: round.title }),
    status: round.status,
    questions: round.questions,
    answers: [...round.answers.values()].map(publicAnswer),
  }
}

/**
 * Resolves when the round satisfies `mode`, the timeout passes (0 = never) or the signal aborts.
 */
export function waitFor(
  rounds: Rounds,
  round: Round,
  options: { mode: WaitMode; ids?: readonly string[]; timeoutMs: number; signal?: AbortSignal },
): Promise<"settled" | "timeout" | "aborted"> {
  if (settled(round, options.mode, options.ids)) return Promise.resolve("settled")
  if (options.signal?.aborted) return Promise.resolve("aborted")
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: "settled" | "timeout" | "aborted") => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolve(outcome)
    }
    const onAbort = () => finish("aborted")
    const unsubscribe = rounds.subscribe((changed) => {
      if (changed.id === round.id && settled(round, options.mode, options.ids)) finish("settled")
    })
    if (options.timeoutMs > 0) timer = setTimeout(() => finish("timeout"), options.timeoutMs)
    options.signal?.addEventListener("abort", onAbort, { once: true })
  })
}
