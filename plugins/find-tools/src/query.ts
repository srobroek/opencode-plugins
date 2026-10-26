/** Query handling shared by the discovery sources: terms, relevance and npm's text window. */

const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "any",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with",
  "find",
  "need",
  "want",
  "some",
  "something",
  "tool",
  "tools",
  "plugin",
  "plugins",
  "skill",
  "skills",
  "server",
  "servers",
  "mcp",
  "opencode",
  "agent",
  "agents",
  "reusable",
  "capability",
])

/** Lowercased query words worth matching, in order, without duplicates or filler. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const word of query.toLowerCase().split(/[^a-z0-9@._/+-]+/)) {
    const term = word.replace(/^[._/-]+|[._/-]+$/g, "")
    if (term.length < 2 || STOPWORDS.has(term)) continue
    seen.add(term)
  }
  return [...seen]
}

/**
 * The few most specific terms, longest first, for backends that AND every word
 * (GitHub search) or match a name substring (MCP Registry). Falls back to the raw
 * query when it has no matchable term.
 */
export function keyTerms(query: string, count: number): string[] {
  const terms = queryTerms(query)
  if (terms.length === 0) {
    const trimmed = query.trim()
    return trimmed ? [trimmed] : []
  }
  return [...terms].sort((a, b) => b.length - a.length || terms.indexOf(a) - terms.indexOf(b)).slice(0, count)
}

/** Relevance of a name and description to the terms: a name match counts double. */
export function relevance(terms: readonly string[], name: string, detail = ""): number {
  const n = name.toLowerCase()
  const d = detail.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (n.includes(term)) score += 2
    else if (d.includes(term)) score += 1
  }
  return score
}

/** npm rejects a search `text` outside 2..64 characters with HTTP 400 ERR_TEXT_LENGTH. */
export const NPM_TEXT_MAX = 64

/**
 * Fits `keywords:<kw> <terms>` inside npm's search-text window. Terms that do not
 * fit are dropped and counted rather than sent and rejected.
 */
export function npmSearchText(keyword: string, query: string): { text: string; dropped: number } | null {
  const text = `keywords:${keyword}`
  if (text.length > NPM_TEXT_MAX) return null
  const terms = queryTerms(query)
  let used = 0
  let joined = text
  for (const term of terms) {
    if (joined.length + 1 + term.length > NPM_TEXT_MAX) break
    joined = `${joined} ${term}`
    used++
  }
  return { text: joined, dropped: terms.length - used }
}
