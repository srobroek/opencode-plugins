/** Messages parley has to get into a session (answers of a restored round, or a TUI's fallback), kept until the host admits them. */
export const OUTBOX_KEY_PREFIX = "outbox:"
/** A pending delivery is retried on this many restores; after that its answers wait for parley_wait. */
export const MAX_ATTEMPTS = 3
/** Admitted deliveries are remembered this long, so a retried request is recognised. */
export const SENT_TTL_MS = 60 * 60_000

export const outboxKey = (key: string) => `${OUTBOX_KEY_PREFIX}${key}`

export interface OutboxEntry {
  /** What identifies the delivery: a round (`round-<id>`) or the TUI's delivery id. */
  readonly key: string
  /** The host message id, fixed when the entry is written so every retry carries the same one. */
  readonly messageID: string
  readonly directory: string
  readonly sessionID: string
  readonly text: string
  readonly description: string
  /** The round whose answers the message carries, and which of them. They are marked delivered once the host admits it. */
  readonly roundID?: string
  readonly answerIDs: readonly string[]
  status: "pending" | "sent"
  attempts: number
  readonly created: number
  updated: number
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

/** Reads a stored outbox entry; anything that is not a usable entry is undefined. Never throws. */
export function fromOutbox(value: unknown): OutboxEntry | undefined {
  if (!isRecord(value)) return undefined
  const { key, messageID: id, directory, sessionID, text, description, status, attempts, created, updated } = value
  if (typeof key !== "string" || typeof id !== "string" || !id.startsWith("msg_")) return undefined
  if (typeof directory !== "string" || typeof sessionID !== "string" || typeof text !== "string") return undefined
  if (typeof description !== "string" || (status !== "pending" && status !== "sent")) return undefined
  if (typeof attempts !== "number" || typeof created !== "number" || typeof updated !== "number") return undefined
  const answerIDs = Array.isArray(value.answerIDs) ? value.answerIDs.filter((item): item is string => typeof item === "string") : []
  return {
    key,
    messageID: id,
    directory,
    sessionID,
    text,
    description,
    ...(typeof value.roundID === "string" ? { roundID: value.roundID } : {}),
    answerIDs,
    status,
    attempts,
    created,
    updated,
  }
}
