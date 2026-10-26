// Ported from Oh My Pi (MIT): src/modes/loop-limit.ts and src/tools/shell-tokenize.ts. See NOTICE.

export type LoopLimitConfig = { kind: "iterations"; iterations: number } | { kind: "duration"; durationMs: number }

export type LoopLimitRuntime =
  | { kind: "iterations"; initial: number; remaining: number }
  | { kind: "duration"; durationMs: number; deadlineMs: number }

/** `until: false` continues while the command succeeds (`--while`); `true` continues while it fails (`--until`). */
export type LoopConditionConfig = { command: string; until: boolean }

export type ParsedLoopArgs = {
  limit?: LoopLimitConfig
  condition?: LoopConditionConfig
  prompt?: string
}

const TIME_UNITS_MS = new Map<string, number>([
  ["s", 1_000],
  ["sec", 1_000],
  ["secs", 1_000],
  ["second", 1_000],
  ["seconds", 1_000],
  ["m", 60_000],
  ["min", 60_000],
  ["mins", 60_000],
  ["minute", 60_000],
  ["minutes", 60_000],
  ["h", 3_600_000],
  ["hr", 3_600_000],
  ["hrs", 3_600_000],
  ["hour", 3_600_000],
  ["hours", 3_600_000],
])

export const LOOP_USAGE =
  "Usage: /loop [count|duration] [--while|--until '<command>'] [prompt]. Examples: /loop 10, /loop 10m, /loop 20 --until 'bun test' fix the failing tests."

const CONDITION_FLAGS: Record<string, boolean | undefined> = {
  "--while": false,
  "--until": true,
}

/**
 * Parse `/loop` arguments into an optional leading limit, an optional
 * continue-condition flag, and an optional inline prompt. Returns an error
 * message string when a limit- or flag-shaped token does not parse.
 */
export function parseLoopArgs(args: string): ParsedLoopArgs | string {
  const trimmed = args.trim()
  if (!trimmed) return {}

  const limitResult = takeLoopLimit(trimmed)
  if (typeof limitResult === "string") return limitResult

  const conditionResult = takeLoopCondition(limitResult.rest)
  if (typeof conditionResult === "string") return conditionResult

  const parsed: ParsedLoopArgs = {}
  if (limitResult.limit) parsed.limit = limitResult.limit
  if (conditionResult.condition) parsed.condition = conditionResult.condition
  if (conditionResult.rest) parsed.prompt = conditionResult.rest
  return parsed
}

function takeLoopLimit(input: string): { limit?: LoopLimitConfig; rest: string } | string {
  const firstSpace = input.search(/\s/)
  const firstToken = firstSpace === -1 ? input : input.slice(0, firstSpace)
  const rest = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim()
  const token = firstToken.toLowerCase()

  if (!/^[+-]?\d/.test(token)) return { rest: input }

  if (/^\d+$/.test(token)) {
    if (rest) {
      const unitToken = /^\S+/.exec(rest)?.[0] ?? ""
      const unitMs = TIME_UNITS_MS.get(unitToken.toLowerCase())
      if (unitMs !== undefined) {
        const limit = makeDuration(token, unitMs)
        if (typeof limit === "string") return limit
        return { limit, rest: rest.slice(unitToken.length).trim() }
      }
    }
    const limit = makeIterations(token)
    if (typeof limit === "string") return limit
    return { limit, rest }
  }

  const duration = parseCompoundDuration(token)
  if (duration !== undefined) {
    if (typeof duration === "string") return duration
    return { limit: duration, rest }
  }

  return LOOP_USAGE
}

function takeLoopCondition(input: string): { condition?: LoopConditionConfig; rest: string } | string {
  let rest = input.trim()
  let condition: LoopConditionConfig | undefined

  while (rest.startsWith("--")) {
    const name = /^(--[a-z][a-z-]*)(?=[\s=]|$)/.exec(rest)?.[1]
    const until = name === undefined ? undefined : CONDITION_FLAGS[name]
    if (name === undefined || until === undefined) {
      return `Unknown /loop flag ${name ?? rest.split(/\s+/, 1)[0]}. ${LOOP_USAGE}`
    }
    if (condition) return "Use only one of --while or --until."

    const afterName = rest.slice(name.length)
    const valueText = afterName.startsWith("=") ? afterName.slice(1) : afterName
    const value = readShellWord(valueText)
    if (value === "unterminated") return `${name} has an unterminated quote.`
    if (value === undefined || !value.value.trim() || valueText.trim().startsWith("-")) {
      return `${name} needs a shell command. Quote it when it contains spaces: /loop ${name} 'bun test'.`
    }
    condition = { command: value.value.trim(), until }
    rest = value.rest
  }

  return condition ? { condition, rest } : { rest }
}

function makeIterations(amountText: string): LoopLimitConfig | string {
  const amount = Number(amountText)
  if (!Number.isSafeInteger(amount) || amount <= 0) return "Loop count must be a positive integer."
  return { kind: "iterations", iterations: amount }
}

function makeDuration(amountText: string, unitMs: number): LoopLimitConfig | string {
  const amount = Number(amountText)
  if (!Number.isSafeInteger(amount) || amount <= 0) return "Loop duration must be positive."
  return { kind: "duration", durationMs: amount * unitMs }
}

function parseCompoundDuration(token: string): LoopLimitConfig | string | undefined {
  if (!/^(?:\d+[a-z]+)+$/.test(token)) return undefined
  const segments = token.match(/\d+[a-z]+/g)
  if (!segments) return undefined
  let totalMs = 0
  for (const segment of segments) {
    const match = /^(\d+)([a-z]+)$/.exec(segment)
    if (!match) return LOOP_USAGE
    const unitMs = TIME_UNITS_MS.get(match[2] ?? "")
    if (unitMs === undefined) return "Loop duration unit must be seconds, minutes, or hours."
    const amount = Number(match[1])
    if (!Number.isSafeInteger(amount) || amount <= 0) return "Loop duration must be positive."
    totalMs += amount * unitMs
  }
  if (totalMs <= 0) return "Loop duration must be positive."
  return { kind: "duration", durationMs: totalMs }
}

/**
 * Read one shell-style word from the start of `text`. Quoted and unquoted runs
 * concatenate (`a"b c"d` is `ab cd`). Returns `undefined` for empty input and
 * `"unterminated"` for an unclosed quote.
 */
export function readShellWord(text: string): { value: string; rest: string } | "unterminated" | undefined {
  let i = 0
  while (i < text.length && /[ \t\n\r]/.test(text[i] ?? "")) i++
  if (i >= text.length) return undefined

  let value = ""
  let inSingle = false
  let inDouble = false
  for (; i < text.length; i++) {
    const ch = text[i] ?? ""
    if (inSingle) {
      if (ch === "'") {
        inSingle = false
        continue
      }
      value += ch
      continue
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < text.length) {
        const next = text[i + 1] ?? ""
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          value += next
          i++
          continue
        }
      }
      if (ch === '"') {
        inDouble = false
        continue
      }
      value += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === "\\" && i + 1 < text.length) {
      value += text[i + 1] ?? ""
      i++
      continue
    }
    if (/[ \t\n\r]/.test(ch)) break
    value += ch
  }
  if (inSingle || inDouble) return "unterminated"
  return { value, rest: text.slice(i).trim() }
}

export function createLoopLimitRuntime(
  config: LoopLimitConfig | undefined,
  nowMs = Date.now(),
): LoopLimitRuntime | undefined {
  if (!config) return undefined
  if (config.kind === "iterations") return { kind: "iterations", initial: config.iterations, remaining: config.iterations }
  return { kind: "duration", durationMs: config.durationMs, deadlineMs: nowMs + config.durationMs }
}

/** Spend one iteration. False when the budget is already spent. Mutates `limit`. */
export function consumeLoopLimitIteration(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
  if (!limit) return true
  if (limit.kind === "duration") return nowMs < limit.deadlineMs
  if (limit.remaining <= 0) return false
  limit.remaining -= 1
  return true
}

/** True when the budget is spent. Never mutates, so a condition need not run for a loop that is over. */
export function isLoopLimitExhausted(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
  if (!limit) return false
  if (limit.kind === "duration") return nowMs >= limit.deadlineMs
  return limit.remaining <= 0
}

export function describeLoopLimit(config: LoopLimitConfig): string {
  if (config.kind === "iterations") {
    return `${config.iterations} ${config.iterations === 1 ? "iteration" : "iterations"}`
  }
  return formatLoopBudget(config.durationMs)
}

export function describeLoopLimitRuntime(limit: LoopLimitRuntime): string {
  if (limit.kind === "iterations") {
    return `${limit.remaining} of ${limit.initial} ${limit.initial === 1 ? "iteration" : "iterations"} remaining`
  }
  return `${formatLoopBudget(limit.durationMs)} limit`
}

function formatLoopBudget(durationMs: number): string {
  if (durationMs % 3_600_000 === 0) {
    const hours = durationMs / 3_600_000
    return `${hours} ${hours === 1 ? "hour" : "hours"}`
  }
  if (durationMs % 60_000 === 0) {
    const minutes = durationMs / 60_000
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  }
  const seconds = durationMs / 1_000
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`
}
