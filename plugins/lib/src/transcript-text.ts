/** Text helpers shared by the transcript renderers (session, seance). Ported from omp-plugins `session/extensions`. */

/** Approximate text tokens for handoff-size reporting, not provider cache metrics. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function clip(text: string, limit: number): string {
  const trimmed = (text ?? "").trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit).trimEnd()} …[+${trimmed.length - limit} chars]`
}

/** Collapse to one line, so list rows and traces cannot break the layout. */
export function oneLine(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

/**
 * Recorded transcripts carry harness markup (`<system-reminder>`, tool-call tags)
 * that would read as live instructions if forwarded verbatim. Escaping every tag
 * opener keeps the text legible while no recorded tag survives. Idempotent.
 */
export function neutralizeMarkup(text: string): string {
  return text.replace(/<(?=[A-Za-z/!?])/g, "&lt;")
}

const SECRETS: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_\w{20,}/g,
  /\bsk-[\w-]{20,}/g,
  /\bxox[abp]-[\w-]{10,}/g,
  /\bBearer\s+\S{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
]

/** Replace obvious credentials with `[redacted]`. */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRETS) out = out.replace(pattern, "[redacted]")
  return out
}

/** Markup escape plus secret redaction; applied to every string the tool returns. */
export function neutralize(text: string): string {
  return neutralizeMarkup(redactSecrets(text))
}

export function relativeTime(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return "unknown"
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function absoluteTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "unknown"
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The cost line every mode ends with. */
export function withCost(text: string): string {
  return `${text}\n\nThis window: ~${estimateTokens(text).toLocaleString("en-US")} uncached tokens (${text.length.toLocaleString("en-US")} chars, estimated).`
}

/**
 * The shortest prefix length at which every listed id is distinct, floored at `floor`.
 * Ids created close together share a long leading run.
 */
export function idPrefixLength(ids: readonly string[], floor = 12): number {
  const longest = Math.max(floor, ...ids.map((id) => id.length))
  for (let length = floor; length < longest; length += 1) {
    if (new Set(ids.map((id) => id.slice(0, length))).size === ids.length) return length
  }
  return longest
}
