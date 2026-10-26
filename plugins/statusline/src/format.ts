import type { SessionMessageAssistant, SessionMessageInfo, TokenUsageInfo } from "@opencode/client"

export const LEFT_SEGMENTS = ["session", "hostname", "model", "agent", "path", "git"] as const
export const RIGHT_SEGMENTS = [
  "context_pct",
  "session_name",
  "token_in",
  "token_out",
  "cache_read",
  "cache_write",
  "token_rate",
  "time_spent",
] as const

export type LeftSegmentID = (typeof LEFT_SEGMENTS)[number]
export type RightSegmentID = (typeof RIGHT_SEGMENTS)[number]
export type SegmentID = LeftSegmentID | RightSegmentID
export type SeparatorStyle = "powerline" | "plain"

export interface Segment {
  readonly id: SegmentID
  readonly text: string
  /** Rendered in the session accent colour instead of the muted text colour. */
  readonly accent?: boolean
}

export interface Options {
  readonly segments: readonly SegmentID[]
  readonly separator: SeparatorStyle
  readonly pathMaxLength: number
}

export const DEFAULT_SEGMENTS: readonly SegmentID[] = [...LEFT_SEGMENTS, ...RIGHT_SEGMENTS]

const KNOWN = new Set<string>(DEFAULT_SEGMENTS)

export function parseOptions(raw: Readonly<Record<string, unknown>> | undefined): Options {
  const segments = Array.isArray(raw?.segments)
    ? raw.segments.filter((s): s is SegmentID => typeof s === "string" && KNOWN.has(s))
    : DEFAULT_SEGMENTS
  const separator = raw?.separator === "plain" ? "plain" : "powerline"
  const max = raw?.pathMaxLength
  const pathMaxLength = typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : 60
  return { segments, separator, pathMaxLength }
}

export function separators(style: SeparatorStyle): { left: string; right: string } {
  return style === "powerline" ? { left: " \uE0B1 ", right: " \uE0B3 " } : { left: " · ", right: " · " }
}

export function compact(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "")
  if (n >= 1e6) return `${trim(n / 1e6)}M`
  if (n >= 1e3) return `${trim(n / 1e3)}k`
  return `${Math.round(n)}`
}

export function shortSessionID(id: string): string {
  return id.replace(/^ses_?/, "").slice(0, 8)
}

/** The assistant step whose tokens fill the context window now. Mirrors `lastAssistantWithUsage` from `@opencode/client/solid`. */
export function lastAssistantWithUsage(
  messages: readonly SessionMessageInfo[],
  boundary?: string,
): (SessionMessageAssistant & { tokens: TokenUsageInfo }) | undefined {
  const boundaryIndex = boundary ? messages.findIndex((m) => m.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compaction = messages.findLastIndex((m, i) => m.type === "compaction" && m.status === "completed" && i < end)
  return messages.findLast(
    (m, i): m is SessionMessageAssistant & { tokens: TokenUsageInfo } =>
      m.type === "assistant" && m.tokens !== undefined && i > compaction && i < end,
  )
}

export function contextTokens(t: TokenUsageInfo): number {
  return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
}

/** `12.3%/1M`, as omp's formatContextUsage renders it. */
export function contextUsage(tokens: TokenUsageInfo | undefined, window: number | undefined): string | undefined {
  if (!tokens) return undefined
  const used = contextTokens(tokens)
  if (!window) return `${compact(used)}/?`
  return `${((used / window) * 100).toFixed(1)}%/${compact(window)}`
}

export function activeMs(messages: readonly SessionMessageInfo[]): number {
  let ms = 0
  for (const m of messages)
    if (m.type === "assistant" && m.time.completed !== undefined) ms += Math.max(0, m.time.completed - m.time.created)
  return ms
}

export function formatDuration(ms: number): string | undefined {
  const s = Math.floor(ms / 1000)
  if (s < 1) return undefined
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}

export function tokenRate(last: SessionMessageAssistant | undefined): string | undefined {
  if (!last?.tokens || last.time.streamed === undefined || last.time.completed === undefined) return undefined
  const seconds = (last.time.completed - last.time.streamed) / 1000
  return seconds > 0 ? `${(last.tokens.output / seconds).toFixed(1)} tok/s` : undefined
}

export function modelLabel(name: string | undefined, variant: string | undefined): string | undefined {
  if (!name) return undefined
  const short = name.replace(/^Claude /, "")
  return variant ? `${short} · ${variant}` : short
}

export function gitLabel(branch: string | undefined, dirty: number | undefined): string | undefined {
  if (!branch) return undefined
  return dirty ? `${branch} *${dirty}` : branch
}

/** Keeps the tail of a path within `max` columns, prefixed with an ellipsis. */
export function truncatePath(path: string, max: number): string {
  if (path.length <= max) return path
  const parts = path.split("/")
  let out = ""
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = out ? `${parts[i]}/${out}` : (parts[i] ?? "")
    if (next.length + 2 > max) break
    out = next
  }
  return out ? `…/${out}` : `…${path.slice(-(max - 1))}`
}

/** FNV-1a: a stable index into the theme's categorical palette for a session. */
export function accentIndex(seed: string, size: number): number {
  if (size <= 0) return 0
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % size
}

export interface SegmentInput {
  readonly sessionID: string
  readonly hostname?: string
  readonly model?: string
  readonly variant?: string
  readonly agent?: string
  readonly path?: string
  readonly branch?: string
  readonly dirty?: number
  readonly title?: string
  readonly tokens?: TokenUsageInfo
  readonly messages: readonly SessionMessageInfo[]
  readonly revert?: string
  readonly contextWindow?: number
}

export function buildSegments(
  input: SegmentInput,
  options: Pick<Options, "segments" | "pathMaxLength">,
): { left: Segment[]; right: Segment[] } {
  const last = lastAssistantWithUsage(input.messages, input.revert)
  const t = input.tokens
  const text: Record<SegmentID, () => string | undefined> = {
    session: () => shortSessionID(input.sessionID),
    hostname: () => input.hostname,
    model: () => modelLabel(input.model, input.variant),
    agent: () => input.agent,
    path: () => (input.path ? truncatePath(input.path, options.pathMaxLength) : undefined),
    git: () => gitLabel(input.branch, input.dirty),
    context_pct: () => contextUsage(last?.tokens, input.contextWindow),
    session_name: () => input.title || undefined,
    token_in: () => (t?.input ? `↑${compact(t.input)}` : undefined),
    token_out: () => (t?.output ? `↓${compact(t.output)}` : undefined),
    cache_read: () => (t?.cache.read ? `⟳${compact(t.cache.read)}` : undefined),
    cache_write: () => (t?.cache.write ? `✎${compact(t.cache.write)}` : undefined),
    token_rate: () => tokenRate(last),
    time_spent: () => formatDuration(activeMs(input.messages)),
  }
  const pick = (ids: readonly SegmentID[]) =>
    options.segments.flatMap((id): Segment[] => {
      if (!ids.includes(id)) return []
      const value = text[id]()
      if (!value) return []
      return [{ id, text: value, ...(id === "session" || id === "session_name" ? { accent: true } : {}) }]
    })
  return { left: pick(LEFT_SEGMENTS), right: pick(RIGHT_SEGMENTS) }
}

export type Measure = (text: string) => number

const measureDefault: Measure = (s) => (typeof Bun === "undefined" ? s.length : Bun.stringWidth(s))

export function rowWidth(
  left: readonly Segment[],
  right: readonly Segment[],
  sep: { left: string; right: string },
  measure: Measure = measureDefault,
): number {
  const side = (segs: readonly Segment[], s: string) =>
    segs.reduce((w, seg, i) => w + measure(seg.text) + (i ? measure(s) : 0), 0)
  const gap = left.length && right.length ? 1 : 0
  return side(left, sep.left) + gap + side(right, sep.right)
}

/**
 * Drops segments until the row fits `width`: the session title first, then
 * right-side segments from the far end. The left side is never dropped; the
 * renderer truncates it if it still overflows.
 */
export function fitSegments(
  left: readonly Segment[],
  right: readonly Segment[],
  width: number,
  sep: { left: string; right: string },
  measure: Measure = measureDefault,
): { left: Segment[]; right: Segment[] } {
  let r = [...right]
  const fits = () => rowWidth(left, r, sep, measure) <= width
  if (!fits()) r = r.filter((s) => s.id !== "session_name")
  while (r.length && !fits()) r = r.slice(0, -1)
  return { left: [...left], right: r }
}
