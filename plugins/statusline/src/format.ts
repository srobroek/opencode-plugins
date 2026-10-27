import type { SessionMessageAssistant, SessionMessageInfo, TokenUsageInfo } from "@opencode/client"

export const SEGMENT_IDS = [
  "session",
  "hostname",
  "model",
  "agent",
  "path",
  "git",
  "context_pct",
  "cost",
  "session_name",
  "token_in",
  "token_out",
  "cache_read",
  "cache_write",
  "token_rate",
  "time_spent",
] as const

export type SegmentID = (typeof SEGMENT_IDS)[number]
export type SeparatorStyle = "powerline" | "plain"
export type Side = "left" | "right"

/**
 * Semantic colour role of a text run. The renderer maps each to a theme token:
 * `accent` is the session accent, `label` the faint text colour for glyphs and
 * units, `value` the base text colour, `dim` the muted one.
 */
export type Tone = "accent" | "value" | "dim" | "label" | "success" | "warning" | "error"

export interface Part {
  readonly text: string
  readonly tone: Tone
  readonly bold?: boolean
}

export interface Segment {
  readonly id: SegmentID
  readonly parts: readonly Part[]
}

export interface Layout {
  readonly left: readonly SegmentID[]
  readonly right: readonly SegmentID[]
}

export interface Options extends Layout {
  readonly separator: SeparatorStyle
  readonly pathMaxLength: number
}

/** omp's `default` preset, minus the segments OpenCode has no data for (`pi`, `pr`, hook statuses). */
export const DEFAULT_LAYOUT: Layout = {
  left: ["model", "agent", "path", "git", "context_pct", "cost"],
  right: ["session_name"],
}

/** The side a segment takes when `segments` is a flat list. */
export const DEFAULT_SIDE: Readonly<Record<SegmentID, Side>> = {
  session: "left",
  hostname: "left",
  model: "left",
  agent: "left",
  path: "left",
  git: "left",
  context_pct: "left",
  cost: "left",
  session_name: "right",
  token_in: "right",
  token_out: "right",
  cache_read: "right",
  cache_write: "right",
  token_rate: "right",
  time_spent: "right",
}

const KNOWN = new Set<string>(SEGMENT_IDS)

function ids(raw: unknown): SegmentID[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  return raw.filter((s): s is SegmentID => {
    if (typeof s !== "string" || !KNOWN.has(s) || seen.has(s)) return false
    seen.add(s)
    return true
  })
}

/**
 * `segments` is either a flat list (each id on its default side, in list order)
 * or `{ left, right }` (omp's `leftSegments` / `rightSegments`).
 */
export function parseLayout(raw: unknown): Layout {
  const flat = ids(raw)
  if (flat) return { left: flat.filter((id) => DEFAULT_SIDE[id] === "left"), right: flat.filter((id) => DEFAULT_SIDE[id] === "right") }
  if (raw && typeof raw === "object") {
    const o = raw as { left?: unknown; right?: unknown }
    const left = ids(o.left) ?? []
    return { left, right: (ids(o.right) ?? []).filter((id) => !left.includes(id)) }
  }
  return DEFAULT_LAYOUT
}

export function parseOptions(raw: Readonly<Record<string, unknown>> | undefined): Options {
  const separator = raw?.separator === "plain" ? "plain" : "powerline"
  const max = raw?.pathMaxLength
  const pathMaxLength = typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : 40
  return { ...parseLayout(raw?.segments), separator, pathMaxLength }
}

/** omp's `powerline-thin` (Nerd Font U+E0B1 / U+E0B3) or a plain dot. */
export function separators(style: SeparatorStyle): Readonly<Record<Side, string>> {
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

export type ContextLevel = "normal" | "warning" | "error"

/**
 * omp's context thresholds: warn at 50% or 150k tokens, alarm at 90% or 500k,
 * whichever comes first for the window.
 */
export function contextLevel(used: number, window: number | undefined): ContextLevel {
  const reaches = (pct: number, tokens: number) =>
    window ? used / window >= Math.min(pct, tokens / window) : used >= tokens
  if (reaches(0.9, 500_000)) return "error"
  if (reaches(0.5, 150_000)) return "warning"
  return "normal"
}

/** `12.3%/1M` (omp's formatContextUsage): the percent in the level colour, the window as a faint unit. */
export function contextParts(tokens: TokenUsageInfo | undefined, window: number | undefined): Part[] | undefined {
  if (!tokens) return undefined
  const used = contextTokens(tokens)
  const level = contextLevel(used, window)
  const tone: Tone = level === "normal" ? "value" : level
  if (!window) return [{ text: compact(used), tone }, { text: "/?", tone: "label" }]
  return [
    { text: `${((used / window) * 100).toFixed(1)}%`, tone },
    { text: `/${compact(window)}`, tone: "label" },
  ]
}

/** Session spend: two significant digits under a cent so early turns are not `$0.00`. */
export function formatCost(usd: number | undefined): string | undefined {
  if (!usd || !Number.isFinite(usd) || usd <= 0) return undefined
  if (usd < 0.0001) return "<0.0001"
  return usd < 0.01 ? String(Number(usd.toPrecision(2))) : usd.toFixed(2)
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

/** Output tokens per second of the latest step, e.g. `48.2`. */
export function tokenRate(last: SessionMessageAssistant | undefined): string | undefined {
  if (!last?.tokens || last.time.streamed === undefined || last.time.completed === undefined) return undefined
  const seconds = (last.time.completed - last.time.streamed) / 1000
  return seconds > 0 ? (last.tokens.output / seconds).toFixed(1) : undefined
}

export function modelName(name: string | undefined): string | undefined {
  return name?.replace(/^Claude /, "")
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

/** A path as its faint parent directories and its bright leaf (omp's pathSpans). */
export function pathParts(path: string): Part[] {
  const slash = path.lastIndexOf("/", path.length - 2)
  if (slash < 0 || slash + 1 >= path.length) return [{ text: path, tone: "value" }]
  return [
    { text: path.slice(0, slash + 1), tone: "label" },
    { text: path.slice(slash + 1), tone: "value" },
  ]
}

export function truncateEnd(text: string, max: number, measure: Measure = measureDefault): string {
  if (measure(text) <= max) return text
  let out = text
  while (out && measure(`${out}…`) > max) out = out.slice(0, -1)
  return `${out.trimEnd()}…`
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
  readonly cost?: number
  readonly tokens?: TokenUsageInfo
  readonly messages: readonly SessionMessageInfo[]
  readonly revert?: string
  readonly contextWindow?: number
}

const stat = (glyph: string, n: number | undefined): Part[] | undefined =>
  n ? [{ text: `${glyph}`, tone: "label" }, { text: compact(n), tone: "value" }] : undefined

/**
 * Nerd Font branch glyph (U+E0A0), shown with the powerline separator, which
 * already assumes a Nerd Font. Plain Unicode branch glyphs (⎇, ⑂) render one
 * column wide but OpenTUI lays them out as two, so the row would clip.
 */
export const BRANCH_GLYPH = "\uE0A0"

/** Renders one segment, or undefined when it has nothing to show. `pathMax` narrows the path when fitting. */
export function renderSegment(
  id: SegmentID,
  input: SegmentInput,
  pathMax: number,
  separator: SeparatorStyle = "powerline",
): Segment | undefined {
  const t = input.tokens
  const last = () => lastAssistantWithUsage(input.messages, input.revert)
  const parts = ((): Part[] | undefined => {
    switch (id) {
      case "session":
        return [{ text: shortSessionID(input.sessionID), tone: "accent" }]
      case "hostname":
        return input.hostname ? [{ text: input.hostname, tone: "dim" }] : undefined
      case "model": {
        const name = modelName(input.model)
        if (!name) return undefined
        const head: Part = { text: name, tone: "accent", bold: true }
        if (!input.variant) return [head]
        // With the plain ` · ` separator a second dot would read as a segment break.
        const joiner = separator === "powerline" ? " · " : " "
        return [head, { text: joiner, tone: "label" }, { text: input.variant, tone: "dim" }]
      }
      case "agent":
        return input.agent ? [{ text: input.agent, tone: "dim" }] : undefined
      case "path":
        return input.path ? pathParts(truncatePath(input.path, pathMax)) : undefined
      case "git": {
        if (!input.branch) return undefined
        const tone: Tone = input.dirty ? "warning" : "success"
        const out: Part[] = separator === "powerline" ? [{ text: `${BRANCH_GLYPH} `, tone: "label" }] : []
        out.push({ text: input.branch, tone })
        if (input.dirty) out.push({ text: ` *${input.dirty}`, tone: "warning" })
        return out
      }
      case "context_pct":
        return contextParts(last()?.tokens, input.contextWindow)
      case "cost": {
        const cost = formatCost(input.cost)
        return cost ? [{ text: "$", tone: "label" }, { text: cost, tone: "value" }] : undefined
      }
      case "session_name":
        return input.title ? [{ text: input.title, tone: "accent" }] : undefined
      case "token_in":
        return stat("↑", t?.input)
      case "token_out":
        return stat("↓", t?.output)
      case "cache_read":
        return stat("⟳", t?.cache.read)
      case "cache_write":
        return stat("✎", t?.cache.write)
      case "token_rate": {
        const rate = tokenRate(last())
        return rate ? [{ text: rate, tone: "value" }, { text: " tok/s", tone: "label" }] : undefined
      }
      case "time_spent": {
        const d = formatDuration(activeMs(input.messages))
        return d ? [{ text: d, tone: "dim" }] : undefined
      }
    }
  })()
  return parts ? { id, parts } : undefined
}

export interface Row {
  readonly left: Segment[]
  readonly right: Segment[]
}

export function buildSegments(
  input: SegmentInput,
  options: Pick<Options, "left" | "right" | "pathMaxLength"> & Partial<Pick<Options, "separator">>,
): Row {
  const pick = (list: readonly SegmentID[]) =>
    list.flatMap((id) => {
      const seg = renderSegment(id, input, options.pathMaxLength, options.separator)
      return seg ? [seg] : []
    })
  return { left: pick(options.left), right: pick(options.right) }
}

export type Measure = (text: string) => number

const measureDefault: Measure = (s) => (typeof Bun === "undefined" ? s.length : Bun.stringWidth(s))

export const segmentText = (seg: Segment): string => seg.parts.map((p) => p.text).join("")

/** Columns between the two sides; the row never lets them touch. */
export const GAP = 2

/** Elastic segments shrink to this many columns before anything drops. */
export const MIN_ELASTIC = 8

export function rowWidth(row: Row, sep: Readonly<Record<Side, string>>, measure: Measure = measureDefault): number {
  const side = (segs: readonly Segment[], s: string) =>
    segs.reduce((w, seg, i) => w + measure(segmentText(seg)) + (i ? measure(s) : 0), 0)
  const gap = row.left.length && row.right.length ? GAP : 0
  return side(row.left, sep.left) + gap + side(row.right, sep.right)
}

/**
 * omp's fitting order, so a narrow row loses the least useful text first:
 * 1. shrink the session title (down to {@link MIN_ELASTIC} columns),
 * 2. drop right-side segments from the far end,
 * 3. shrink the path (re-rendered with a smaller `pathMax`),
 * 4. drop left-side segments from the far end, keeping the path until last.
 * Whatever still overflows is clipped by the renderer.
 */
export function fitSegments(
  row: Row,
  width: number,
  sep: Readonly<Record<Side, string>>,
  input: SegmentInput,
  measure: Measure = measureDefault,
): Row {
  const left = [...row.left]
  const right = [...row.right]
  const over = () => rowWidth({ left, right }, sep, measure) - width
  if (over() <= 0) return { left, right }

  const title = right.findIndex((s) => s.id === "session_name")
  const titleSeg = right[title]
  if (titleSeg) {
    const text = segmentText(titleSeg)
    const target = Math.max(MIN_ELASTIC, measure(text) - over())
    const tone = titleSeg.parts[0]?.tone ?? "accent"
    right[title] = { id: titleSeg.id, parts: [{ text: truncateEnd(text, target, measure), tone }] }
  }
  while (right.length && over() > 0) right.pop()

  const path = left.findIndex((s) => s.id === "path")
  const pathSeg = left[path]
  if (pathSeg && input.path && over() > 0) {
    const target = Math.max(MIN_ELASTIC, measure(segmentText(pathSeg)) - over())
    left[path] = { id: "path", parts: pathParts(truncatePath(input.path, target)) }
  }
  while (left.length && over() > 0) {
    const drop = left.findLastIndex((s) => s.id !== "path")
    left.splice(drop === -1 ? left.length - 1 : drop, 1)
  }
  return { left, right }
}
