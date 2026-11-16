import { type Answer, publicAnswer } from "./answers.ts"
import { fromRoundDelivery, type RoundDelivery } from "./outbox.ts"
import { type Question, validateQuestions } from "./questions.ts"
import { awaitsDelivery, type Round } from "./rounds.ts"

/** Storage key prefix; one entry per round. */
export const ROUND_KEY_PREFIX = "round:"
/** Open rounds older than this are dropped at restore (their session has moved on). */
export const OPEN_TTL_MS = 24 * 60 * 60_000

export const roundKey = (roundID: string) => `${ROUND_KEY_PREFIX}${roundID}`

/** What parley keeps of a round so it survives a plugin reload. Upload bytes are not kept. */
export interface StoredRound {
  readonly id: string
  /** The location (directory) of the plugin instance that owns the round. Storage is shared by every location. */
  readonly directory: string
  readonly sessionID: string
  readonly number: number
  readonly title?: string
  readonly questions: Question[]
  readonly answers: Answer[]
  readonly delivered: string[]
  readonly callIDs: string[]
  readonly status: Round["status"]
  readonly reason?: string
  readonly deadline?: number
  readonly created: number
  readonly updated: number
  readonly delivery?: RoundDelivery
}

export function toStored(round: Round, directory: string): StoredRound {
  return {
    id: round.id,
    directory,
    sessionID: round.sessionID,
    number: round.number,
    ...(round.title === undefined ? {} : { title: round.title }),
    questions: round.questions,
    answers: [...round.answers.values()].map(publicAnswer),
    delivered: [...round.delivered],
    callIDs: round.callIDs,
    status: round.status,
    ...(round.reason === undefined ? {} : { reason: round.reason }),
    ...(round.deadline === undefined ? {} : { deadline: round.deadline }),
    created: round.created,
    updated: round.updated,
    ...(round.delivery === undefined ? {} : { delivery: structuredClone(round.delivery) }),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A stored round, with the location that owns it. */
export interface Restored {
  readonly round: Round
  readonly directory: string
}

/** Reads a stored entry back into a round, or undefined when it is not a usable round. Nested data is checked too. */
export function fromStored(value: unknown): Restored | undefined {
  try {
    return decode(value)
  } catch {
    // Malformed nested data (validation reads options, answers, ...) is one bad round, not a failed restore.
    return undefined
  }
}

function decode(value: unknown): Restored | undefined {
  if (!isRecord(value)) return undefined
  const { id, directory, sessionID, number, questions, answers, status, created, updated } = value
  if (typeof id !== "string" || typeof directory !== "string" || typeof sessionID !== "string" || typeof number !== "number") return undefined
  if (!Array.isArray(questions) || !Array.isArray(answers)) return undefined
  if (status !== "open" && status !== "submitted" && status !== "cancelled") return undefined
  if (typeof created !== "number" || typeof updated !== "number") return undefined
  if (validateQuestions(questions).length > 0) return undefined
  const known = new Set((questions as Question[]).map((question) => question.id))
  const usable = (answer: unknown): answer is Answer =>
    isRecord(answer) && typeof answer.id === "string" && known.has(answer.id) && typeof answer.status === "string"
  if (!answers.every(usable)) return undefined
  const delivery = value.delivery === undefined ? undefined : fromRoundDelivery(value.delivery)
  if (value.delivery !== undefined && delivery === undefined) return undefined
  const strings = (input: unknown) => (Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [])
  return {
    directory,
    round: {
      id,
      sessionID,
      number,
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      questions: questions as Question[],
      answers: new Map((answers as Answer[]).map((answer) => [answer.id, answer])),
      delivered: new Set(strings(value.delivered)),
      callIDs: strings(value.callIDs),
      status,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(typeof value.deadline === "number" ? { deadline: value.deadline } : {}),
      created,
      updated,
      ...(delivery === undefined ? {} : { delivery }),
    },
  }
}

/** Whether a stored round is too old to restore: closed past `closedTtlMs`, or open (or still to be delivered) past a day. */
export function stale(round: Round, now: number, closedTtlMs: number): boolean {
  return now - round.updated > (round.status === "open" || awaitsDelivery(round) ? OPEN_TTL_MS : closedTtlMs)
}
