/**
 * Rewrite `gh pr create|edit --body` so GitHub close-keywords apply to every issue in a
 * comma list: `Fixes #1, #2` becomes `Fixes #1, fixes #2`. Ported from omp-plugins
 * (`safety/extensions/close-keywords.ts`).
 *
 * Only literal shell words are eligible; a command with an expansion or other
 * unsupported syntax is left unchanged. The rewrite replaces the source span of the
 * selected body with a single-quoted literal, so the new body stays data.
 */

const KEYWORDS = new Set(["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"])

const REF = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[0-9]+|GH-[0-9]+/i
const WORD = /^[A-Za-z]+/
const SPACE = /^[^\S\n]+/
const SEPARATORS = [/^[^\S\n]*,[^\S\n]+and[^\S\n]+/, /^[^\S\n]+and[^\S\n]+/, /^[^\S\n]*,[^\S\n]*/]

const MAX_COMMAND_LENGTH = 64_000

function matchAt(pattern: RegExp, text: string, pos: number): string | null {
  const m = pattern.exec(text.slice(pos))
  return m && m.index === 0 ? m[0] : null
}

function separatorAt(text: string, pos: number): string | null {
  for (const pattern of SEPARATORS) {
    const found = matchAt(pattern, text, pos)
    if (found) return found
  }
  return null
}

export function normalizeLine(line: string): string {
  const out: string[] = []
  let pos = 0
  while (pos < line.length) {
    const last = out.length ? out[out.length - 1] : ""
    const atBoundary = !last || !/[A-Za-z0-9_]$/.test(last)
    const word = atBoundary ? matchAt(WORD, line, pos) : null
    if (word === null) {
      out.push(line[pos] as string)
      pos += 1
      continue
    }
    if (!KEYWORDS.has(word.toLowerCase())) {
      out.push(word)
      pos += word.length
      continue
    }
    const afterWord = pos + word.length
    const space = matchAt(SPACE, line, afterWord) ?? ""
    const firstRef = matchAt(REF, line, afterWord + space.length)
    if (firstRef === null) {
      out.push(word)
      pos += word.length
      continue
    }
    const keyword = word.toLowerCase()
    out.push(word + space + firstRef)
    pos = afterWord + space.length + firstRef.length
    while (true) {
      const separator = separatorAt(line, pos)
      if (separator === null) break
      const ref = matchAt(REF, line, pos + separator.length)
      if (ref === null) break
      out.push(`${separator}${keyword} ${ref}`)
      pos += separator.length + ref.length
    }
  }
  return out.join("")
}

export function normalize(text: string): string {
  return text.split("\n").map(normalizeLine).join("\n")
}

type Token = { value: string; start: number; end: number }

// Only literal shell words are eligible. Unsupported shell syntax is never rewritten.
function literalSegments(command: string): Token[][] | null {
  const segments: Token[][] = [[]]
  let i = 0
  while (i < command.length) {
    const current = command[i] as string
    if (" \t\r".includes(current)) {
      i++
      continue
    }
    if (";&|\n".includes(current)) {
      i++
      if ((current === "&" || current === "|") && command[i] === current) i++
      segments.push([])
      continue
    }
    const start = i
    let value = ""
    let quote: string | null = null
    while (i < command.length) {
      const ch = command[i] as string
      if (!quote && " \t\r;&|\n".includes(ch)) break
      if (ch === "'" && quote !== '"') {
        quote = quote ? null : "'"
        i++
        continue
      }
      if (ch === '"' && quote !== "'") {
        quote = quote ? null : '"'
        i++
        continue
      }
      if (quote !== "'" && ch === "\\") {
        const next = command[i + 1]
        if (next === undefined) return null
        if (quote === '"' && !'$`"\\\n'.includes(next)) {
          value += ch
          i++
          continue
        }
        if (next !== "\n") value += next
        i += 2
        continue
      }
      if (
        quote !== "'" &&
        ("$`".includes(ch) || (!quote && ("()<>*?{}[]~".includes(ch) || (ch === "#" && i === start))))
      )
        return null
      value += ch
      i++
    }
    if (quote) return null
    segments[segments.length - 1]?.push({ value, start, end: i })
  }
  return segments
}

const VALUED = new Set([
  "--title",
  "-t",
  "--base",
  "-B",
  "--head",
  "-H",
  "--repo",
  "-R",
  "--reviewer",
  "-r",
  "--assignee",
  "-a",
  "--label",
  "-l",
  "--project",
  "-p",
  "--milestone",
  "-m",
  "--body-file",
  "-F",
  "--template",
  "-T",
  "--add-assignee",
  "--remove-assignee",
  "--add-label",
  "--remove-label",
  "--add-project",
  "--remove-project",
  "--add-reviewer",
  "--remove-reviewer",
])

function bodySpan(command: string): Token | null {
  const segments = literalSegments(command)
  if (!segments) return null
  let selected: Token | null = null
  for (const segment of segments) {
    let start = 0
    while (segment[start] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[start]?.value ?? "")) start++
    if (
      segment[start]?.value !== "gh" ||
      segment[start + 1]?.value !== "pr" ||
      !["create", "edit"].includes(segment[start + 2]?.value ?? "")
    )
      continue
    selected = null
    for (let i = start + 3; i < segment.length; i++) {
      const token = segment[i] as Token
      if (token.value === "--") break
      if (token.value === "--body" || token.value === "-b") {
        const next = segment[i + 1]
        selected = next ?? null
        if (next) i++
        continue
      }
      if (VALUED.has(token.value)) {
        if (segment[i + 1]) i++
        continue
      }
      const prefix = token.value.startsWith("--body=")
        ? "--body="
        : token.value.startsWith("-b=")
          ? "-b="
          : token.value.startsWith("-b") && !token.value.startsWith("--")
            ? "-b"
            : null
      if (prefix) selected = { ...token, value: token.value.slice(prefix.length) }
    }
  }
  return selected
}

export function extractBody(command: string): string {
  return bodySpan(command)?.value ?? ""
}

export function replaceLastBody(command: string, next: string): string | null {
  const span = bodySpan(command)
  if (!span) return null
  const raw = command.slice(span.start, span.end)
  const token = literalSegments(raw)?.[0]?.[0]?.value ?? ""
  const prefix = token !== span.value ? token.slice(0, token.length - span.value.length) : ""
  const escaped = `'${next.replaceAll("'", "'\\''")}'`
  return command.slice(0, span.start) + prefix + escaped + command.slice(span.end)
}

/** The command with its PR body's close-keyword lists expanded, or `undefined` when nothing changes. */
export function rewriteCloseKeywords(command: string): string | undefined {
  if (command.length > MAX_COMMAND_LENGTH || !command.includes("gh") || !command.includes("pr")) return undefined
  const body = extractBody(command)
  if (!body) return undefined
  const fixed = normalize(body)
  if (fixed === body) return undefined
  return replaceLastBody(command, fixed) ?? undefined
}
