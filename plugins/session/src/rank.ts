/** Find-by-description scoring over session fields. */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do for from has have how i in into is it its me my of on or our " +
    "please session so that the their then there this to up us was we were what when where which " +
    "with you your work worked working continue resume last"
  ).split(" "),
)

/** Lowercase words of 2+ characters, stopwords dropped. */
export function tokens(text: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const word of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 2 && !STOPWORDS.has(word)) out.add(word)
  }
  return out
}

export type ScoreFields = {
  title?: string
  objective?: string
  lastGoal?: string
  firstUser?: string
  files?: readonly string[]
  directory?: string
  branch?: string
}

export const WEIGHTS = { title: 3, objective: 3, lastGoal: 2, firstUser: 2, context: 1 } as const

const DAY = 86_400_000

/** Fraction of query words found in a field. */
function overlap(query: Set<string>, field: Set<string>): number {
  if (query.size === 0) return 0
  let hits = 0
  for (const word of query) if (field.has(word)) hits += 1
  return hits / query.size
}

/**
 * `Σ weight · |q ∩ field| / |q|`, plus `0.5 · exp(−age / 7d)` recency, plus `0.3`
 * when the session looks unfinished.
 */
export function score(query: string, fields: ScoreFields, ageMs: number, isUnfinished: boolean): number {
  const q = tokens(query)
  const context = tokens(
    [...(fields.files ?? []), fields.directory ?? "", fields.branch ?? ""].join(" "),
  )
  const relevance =
    WEIGHTS.title * overlap(q, tokens(fields.title)) +
    WEIGHTS.objective * overlap(q, tokens(fields.objective)) +
    WEIGHTS.lastGoal * overlap(q, tokens(fields.lastGoal)) +
    WEIGHTS.firstUser * overlap(q, tokens(fields.firstUser)) +
    WEIGHTS.context * overlap(q, context)
  const recency = 0.5 * Math.exp(-Math.max(0, ageMs) / (7 * DAY))
  return relevance + recency + (isUnfinished ? 0.3 : 0)
}

/** The top row is recommended when it clears 1.5 and leads the next by 0.5. */
export function recommended(scores: readonly number[]): boolean {
  const [top, second] = [...scores].sort((a, b) => b - a)
  if (top === undefined) return false
  return top >= 1.5 && top - (second ?? 0) >= 0.5
}

/** Query words long enough to send as server-side title searches. */
export function searchTerms(query: string): string[] {
  return [...tokens(query)].filter((word) => word.length >= 4)
}

/** An id or id prefix rather than a description. */
export function looksLikeId(query: string): boolean {
  const trimmed = query.trim()
  return /^ses_[A-Za-z0-9]*$/.test(trimmed) || /^[0-9a-f]{8}(?:-[0-9a-f-]*)?$/i.test(trimmed)
}

/** Resolve an id prefix among candidate ids: one match, none, or ambiguous. */
export function resolvePrefix(
  prefix: string,
  ids: readonly string[],
): { id: string } | { error: "none" | "ambiguous"; matches: string[] } {
  const wanted = prefix.trim()
  const exact = ids.find((id) => id === wanted)
  if (exact) return { id: exact }
  const matches = [...new Set(ids.filter((id) => id.startsWith(wanted)))]
  if (matches.length === 1 && matches[0]) return { id: matches[0] }
  return { error: matches.length === 0 ? "none" : "ambiguous", matches }
}
