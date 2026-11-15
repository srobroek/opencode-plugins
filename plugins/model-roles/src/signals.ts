/**
 * Outcome signals for the ledger, read from a child's own session: the reviewer verdict, the
 * last test run and whether a test file was edited. All pure; the text and commands parsed
 * here are dropped, only the enums and a boolean are kept.
 */

import { shellQuoteBalanced, tokenizeShell } from "@srobroek/opencode-lib"

export type Verdict = "approve" | "request-changes" | "comment"
export type TestResult = "pass" | "fail" | "none"

export const DEFAULT_TEST_COMMANDS: readonly string[] = [
  "bun test",
  "bun run test",
  "bun run check",
  "npm test",
  "pnpm test",
  "yarn test",
  "pytest",
  "python -m pytest",
  "go test",
  "cargo test",
  "cargo nextest",
]

export const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*_test.go",
  "**/test_*.py",
]

export type EvaluateOptions = { testCommands: readonly string[]; testGlobs: readonly string[] }

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : undefined

/** The `evaluate` option with defaults; an array replaces its default. */
export function parseEvaluate(raw: unknown): EvaluateOptions {
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    testCommands: strings(input.testCommands) ?? DEFAULT_TEST_COMMANDS,
    testGlobs: strings(input.testGlobs) ?? DEFAULT_TEST_GLOBS,
  }
}

const VERDICT_LINE = /^VERDICT:\s*(APPROVE|REQUEST-CHANGES|COMMENT)\b/i
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * The verdict on the last `VERDICT:` line of `text`. A line in a fenced block, indented four
 * spaces or a tab, or quoted with `>` is someone else's text and does not count. A fence
 * closes only on a bare line of the same character at least as long as the opening (CommonMark).
 */
export function parseVerdict(text: string): Verdict | undefined {
  let found: Verdict | undefined
  let fence: { char: string; length: number } | undefined
  for (const line of text.split(/\r?\n/)) {
    if (fence !== undefined) {
      const closes = CLOSE_FENCE.exec(line)?.[1]
      if (closes?.startsWith(fence.char) && closes.length >= fence.length) fence = undefined
      continue
    }
    const opens = OPEN_FENCE.exec(line)
    if (opens?.[1] !== undefined && !(opens[1].startsWith("`") && opens[2]?.includes("`"))) {
      fence = { char: opens[1].charAt(0), length: opens[1].length }
      continue
    }
    if (/^(?: {4}|\t)/.test(line) || /^ {0,3}>/.test(line)) continue
    const match = VERDICT_LINE.exec(line.trim())
    if (match?.[1] !== undefined) found = match[1].toLowerCase() as Verdict
  }
  return found
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n", "$(", "<<<"])
const JOINERS = new Set(["&&", ";", "\n"])

type Item = { word: string } | { separator: string }

/**
 * Words and separators of `command` from the lib's shell tokenizer, with the redirects that
 * do not change an exit status (`> file`, `>> file`, `2>&1`) removed. Undefined when the source
 * is ambiguous: an open quote, a here-document, a backtick.
 */
function items(command: string): Item[] | undefined {
  if (!shellQuoteBalanced(command) || command.includes("`") || command.includes("<<")) return undefined
  const tokens = tokenizeShell(command)
  const out: Item[] = []
  const isSeparator = (i: number) => {
    const t = tokens[i]
    return t !== undefined && !t.sawQuote && SEPARATORS.has(t.value)
  }
  const wordAt = (i: number) => (tokens[i] !== undefined && !isSeparator(i) ? tokens[i] : undefined)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === undefined) continue
    if (isSeparator(i)) {
      out.push({ separator: t.value })
      continue
    }
    if (!t.sawQuote && /^\d*>>?$/.test(t.value)) {
      // `2>&1` lexes as `2>`, `&`, `1`; `> file` as `>`, `file`.
      if (isSeparator(i + 1) && tokens[i + 1]?.value === "&" && /^(\d+|-)$/.test(wordAt(i + 2)?.value ?? "x")) i += 2
      else if (wordAt(i + 1) !== undefined) i += 1
      else return undefined
      continue
    }
    if (!t.sawQuote && /^\d*>>?[^>&]/.test(t.value)) continue
    out.push({ word: t.value })
  }
  return out
}

/** Whether `words` is only setup: assignments, `export NAME=value…`, or `cd <path>`, after any leading assignments. */
function isSetup(words: readonly string[]): boolean {
  let rest = words
  while (rest[0] !== undefined && ASSIGNMENT.test(rest[0])) rest = rest.slice(1)
  if (rest.length === 0) return true
  if (rest[0] === "cd") return rest.length === 2
  return rest[0] === "export" && rest.length > 1 && rest.slice(1).every((w) => ASSIGNMENT.test(w))
}

/** The words to compare: as written, and `<tool> run x` as `<tool> x`. */
function forms(words: readonly string[]): string[][] {
  const [tool, run, ...rest] = words
  const wrapped = tool !== undefined && ["bun", "npm", "pnpm", "yarn"].includes(tool) && run === "run" && rest.length > 0
  return wrapped ? [[...words], [tool, ...rest]] : [[...words]]
}

/** Whether `words` begin with the tokens of `command`; the last one may carry a `:script` suffix. */
const startsWithCommand = (words: readonly string[], command: string): boolean => {
  const tokens = command.trim().split(/\s+/)
  if (tokens.length > words.length) return false
  return tokens.every((token, i) => words[i] === token || (i === tokens.length - 1 && words[i]?.startsWith(`${token}:`) === true))
}

/**
 * Whether the exit status of the whole `command` is unambiguously that of a test command: the
 * test command is the last one, only setup (`cd <path>`, assignments, `export`) joined by `&&`
 * (or `;` or a newline) comes before it, and only a harmless redirect follows it. A pipe, `||`,
 * `&`, a subshell or a substitution, a later command, a here-document or an open quote make the
 * exit someone else's, or unknown. The test command is matched word by word, so a quoted
 * `'bun test'` is one word and no test run. `setupFirst` is true when the test is joined to
 * its setup by `&&`: it runs only if the setup succeeded, so a failing exit may be the setup's.
 */
export function parseTestCommand(command: string, testCommands: readonly string[]): { setupFirst: boolean } | undefined {
  const parts = items(command.trim())
  if (parts === undefined || parts.length === 0) return undefined
  const segments: string[][] = [[]]
  const joins: string[] = []
  let run = ""
  for (const part of parts) {
    if ("separator" in part) run += part.separator
    else {
      if (run !== "") {
        if (!JOINERS.has(run)) return undefined
        joins.push(run)
        segments.push([])
        run = ""
      }
      segments[segments.length - 1]?.push(part.word)
    }
  }
  if (run !== "" || segments.some((s) => s.length === 0)) return undefined
  const last = segments.pop() ?? []
  if (!segments.every(isSetup)) return undefined
  let rest = last
  while (rest[0] !== undefined && ASSIGNMENT.test(rest[0])) rest = rest.slice(1)
  if (!forms(rest).some((form) => testCommands.some((tc) => startsWithCommand(form, tc)))) return undefined
  return { setupFirst: joins[joins.length - 1] === "&&" }
}

/**
 * The result of a test run: undefined when `command` is no test run, its exit status is unknown,
 * or a failure could be the `&&` setup's rather than the test's.
 */
export function testRun(command: string, exitStatus: number | undefined, testCommands: readonly string[]): "pass" | "fail" | undefined {
  if (exitStatus === undefined || !Number.isInteger(exitStatus)) return undefined
  const parsed = parseTestCommand(command, testCommands)
  if (parsed === undefined) return undefined
  if (exitStatus === 0) return "pass"
  return parsed.setupFirst ? undefined : "fail"
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g

/** A glob as a regular expression over `/` separated paths: `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let source = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?"
        i += 2
      } else {
        source += ".*"
        i += 1
      }
    } else if (c === "*") source += "[^/]*"
    else if (c === "?") source += "[^/]"
    else source += c.replace(REGEX_SPECIAL, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

/** Whether any of `files` matches a test glob. */
export function touchesTests(files: readonly string[], testGlobs: readonly string[]): boolean {
  const patterns = testGlobs.map(globToRegExp)
  return files.some((file) => {
    const path = file.replace(/\\/g, "/").replace(/^\.\//, "")
    return patterns.some((p) => p.test(path))
  })
}

/** The exit status a shell tool result reports in its metadata, when it does. */
export function exitStatusOf(metadata: unknown): number | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const m = metadata as Record<string, unknown>
  for (const key of ["exit", "exitCode"]) if (typeof m[key] === "number") return m[key]
  return undefined
}
