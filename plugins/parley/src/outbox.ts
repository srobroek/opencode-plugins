/** Messages parley sends to a session for the TUI's fallback (a round the server never held), kept until the host admits them. */
export const OUTBOX_KEY_PREFIX = "outbox:"
/** A delivery that failed this many times stops retrying on its own and goes back to the user. */
export const MAX_ATTEMPTS = 3
/** Admitted or pending fallback deliveries are remembered this long, so a retried request is recognised. */
export const SENT_TTL_MS = 60 * 60_000

export const outboxKey = (key: string) => `${OUTBOX_KEY_PREFIX}${key}`

export type DeliveryStatus = "pending" | "sent" | "failed" | "dismissed"

/** Fields every delivery has. `generation` changes whenever its content does, so a stale send result is ignored. */
interface DeliveryBase {
  /** The host message id, fixed when the delivery is planned. The host admits an id once, so every retry reuses it. */
  readonly messageID: string
  generation: number
  readonly description: string
  status: DeliveryStatus
  attempts: number
  error?: string
  readonly created: number
  updated: number
}

/**
 * The message carrying a restored round's answers. It is stored in the round record, so it is saved in
 * the same write as the closure that plans it. The text is built from the round when it is sent.
 */
export interface RoundDelivery extends DeliveryBase {
  /** The answers the message carries. An answer the agent took through parley_wait leaves the list. */
  answerIDs: string[]
  /** Per answer: what the message says about its uploads (saved paths, inlined text). */
  readonly notes: Record<string, string[]>
  /** Answers with uploads that could not be saved: left for parley_wait. */
  held: string[]
  /**
   * Set, and saved, before the first send. The host may have admitted any attempt, so from then on the
   * message owns `answerIDs`: parley_wait finishes the send instead of returning them.
   */
  started?: boolean
}

/** A fallback message the TUI asked for: its text is fixed. */
export interface OutboxEntry extends DeliveryBase {
  /** The TUI's delivery id. */
  readonly key: string
  readonly directory: string
  readonly sessionID: string
  readonly text: string
}

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/**
 * A host message id: `msg_` plus 12 hex digits of time and a counter, then 14 characters, the shape the
 * host makes itself so the message sorts at the moment of creation. The host only checks the prefix.
 */
export function messageID(now: number): string {
  const time = (BigInt(now) * 0x1000n + 1n).toString(16).padStart(12, "0").slice(-12)
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return `msg_${time}${Array.from(bytes, (byte) => CHARS[byte % 62]).join("")}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const strings = (input: unknown) =>
  Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
const STATUSES = new Set<unknown>(["pending", "sent", "failed", "dismissed"])

function base(value: Record<string, unknown>): DeliveryBase | undefined {
  const { messageID: id, generation, description, status, attempts, created, updated } = value
  if (typeof id !== "string" || !id.startsWith("msg_") || typeof description !== "string" || !STATUSES.has(status)) return undefined
  if (typeof attempts !== "number" || typeof created !== "number" || typeof updated !== "number") return undefined
  return {
    messageID: id,
    generation: typeof generation === "number" ? generation : 0,
    description,
    status: status as DeliveryStatus,
    attempts,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    created,
    updated,
  }
}

/** Reads a stored round delivery; anything unusable is undefined. Never throws. */
export function fromRoundDelivery(value: unknown): RoundDelivery | undefined {
  if (!isRecord(value)) return undefined
  const head = base(value)
  if (!head) return undefined
  const notes: Record<string, string[]> = {}
  if (isRecord(value.notes)) for (const [id, lines] of Object.entries(value.notes)) notes[id] = strings(lines)
  return {
    ...head,
    answerIDs: strings(value.answerIDs),
    notes,
    held: strings(value.held),
    ...(value.started === true ? { started: true } : {}),
  }
}

/** Reads a stored fallback delivery; anything unusable is undefined. Never throws. */
export function fromOutbox(value: unknown): OutboxEntry | undefined {
  if (!isRecord(value)) return undefined
  const head = base(value)
  const { key, directory, sessionID, text } = value
  if (!head || typeof key !== "string" || typeof directory !== "string") return undefined
  if (typeof sessionID !== "string" || typeof text !== "string") return undefined
  return { ...head, key, directory, sessionID, text }
}
