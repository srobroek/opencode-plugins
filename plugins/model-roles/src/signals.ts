/**
 * Outcome signals for the ledger, read from a child's own session: the reviewer verdict, the
 * last test run and whether a test file was edited. All pure; the text and commands parsed
 * here are dropped, only the enums and a boolean are kept.
 */

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

/** The verdict on the last `VERDICT:` line of `text`. */
export function parseVerdict(text: string): Verdict | undefined {
  let found: Verdict | undefined
  for (const line of text.split(/\r?\n/)) {
    const match = VERDICT_LINE.exec(line.trim())
    if (match?.[1] !== undefined) found = match[1].toLowerCase() as Verdict
  }
  return found
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/
const RUN_WRAPPER = /^(bun|npm|pnpm|yarn) run (?=\S)/

/** The command forms to compare: as written, and `<tool> run x` as `<tool> x`. */
function forms(segment: string): string[] {
  let rest = segment.trim()
  while (ENV_ASSIGNMENT.test(rest)) rest = rest.replace(ENV_ASSIGNMENT, "")
  const wrapped = RUN_WRAPPER.exec(rest)
  return wrapped === null ? [rest] : [rest, `${wrapped[1]} ${rest.slice(wrapped[0].length)}`]
}

const startsWithCommand = (form: string, command: string): boolean => {
  if (!form.startsWith(command)) return false
  const next = form[command.length]
  return next === undefined || next === ":" || /\s/.test(next)
}

/** Whether `command` runs one of `testCommands`, ignoring `cd …;` / `&&` prefixes, env assignments and `run` wrappers. */
export function isTestCommand(command: string, testCommands: readonly string[]): boolean {
  return command
    .split(/&&|\|\||;|\n/)
    .some((segment) => forms(segment).some((form) => testCommands.some((tc) => startsWithCommand(form, tc.trim()))))
}

/** The result of a test run: undefined when `command` is no test run or its exit status is unknown. */
export function testRun(command: string, exitStatus: number | undefined, testCommands: readonly string[]): "pass" | "fail" | undefined {
  if (exitStatus === undefined || !Number.isInteger(exitStatus) || !isTestCommand(command, testCommands)) return undefined
  return exitStatus === 0 ? "pass" : "fail"
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
