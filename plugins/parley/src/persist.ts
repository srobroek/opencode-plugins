import { type Answer, publicAnswer } from "./answers.ts"
import type { Question } from "./questions.ts"
import type { Round } from "./rounds.ts"

/** Storage key prefix; one entry per round. */
export const ROUND_KEY_PREFIX = "round:"
/** Open rounds older than this are dropped at restore (their session has moved on). */
export const OPEN_TTL_MS = 24 * 60 * 60_000

export const roundKey = (roundID: string) => `${ROUND_KEY_PREFIX}${roundID}`

/** What parley keeps of a round so it survives a plugin reload. Upload bytes are not kept. */
export interface StoredRound {
  readonly id: string
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
}

export function toStored(round: Round): StoredRound {
  return {
    id: round.id,
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
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Reads a stored entry back into a round, or undefined when it is not a usable round. */
export function fromStored(value: unknown): Round | undefined {
  if (!isRecord(value)) return undefined
  const { id, sessionID, number, questions, answers, status, created, updated } = value
  if (typeof id !== "string" || typeof sessionID !== "string" || typeof number !== "number") return undefined
  if (!Array.isArray(questions) || !Array.isArray(answers)) return undefined
  if (status !== "open" && status !== "submitted" && status !== "cancelled") return undefined
  if (typeof created !== "number" || typeof updated !== "number") return undefined
  const strings = (input: unknown) => (Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [])
  return {
    id,
    sessionID,
    number,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    questions: questions as Question[],
    answers: new Map((answers as Answer[]).filter((answer) => isRecord(answer) && typeof answer.id === "string").map((answer) => [answer.id, answer])),
    delivered: new Set(strings(value.delivered)),
    callIDs: strings(value.callIDs),
    status,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.deadline === "number" ? { deadline: value.deadline } : {}),
    created,
    updated,
  }
}

/** Whether a stored round is too old to restore: closed past `closedTtlMs`, or open past a day. */
export function stale(round: Round, now: number, closedTtlMs: number): boolean {
  return now - round.updated > (round.status === "open" ? OPEN_TTL_MS : closedTtlMs)
}
