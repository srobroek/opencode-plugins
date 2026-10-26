import { describe, expect, test } from "bun:test"

import {
  consumeLoopLimitIteration,
  createLoopLimitRuntime,
  describeLoopLimit,
  describeLoopLimitRuntime,
  isLoopLimitExhausted,
  LOOP_USAGE,
  parseLoopArgs,
  readShellWord,
} from "./loop.ts"

describe("parseLoopArgs", () => {
  test("empty arguments start an unbounded loop", () => {
    expect(parseLoopArgs("")).toEqual({})
    expect(parseLoopArgs("   ")).toEqual({})
  })

  test("a bare integer is an iteration count", () => {
    expect(parseLoopArgs("10")).toEqual({ limit: { kind: "iterations", iterations: 10 } })
    expect(parseLoopArgs("3 fix the tests")).toEqual({
      limit: { kind: "iterations", iterations: 3 },
      prompt: "fix the tests",
    })
  })

  test("durations: compact, compound and spelled out", () => {
    expect(parseLoopArgs("10m")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } })
    expect(parseLoopArgs("1h30m go")).toEqual({ limit: { kind: "duration", durationMs: 5_400_000 }, prompt: "go" })
    expect(parseLoopArgs("10 minutes keep going")).toEqual({
      limit: { kind: "duration", durationMs: 600_000 },
      prompt: "keep going",
    })
  })

  test("limit-shaped tokens that do not parse are errors", () => {
    expect(parseLoopArgs("-1")).toBe(LOOP_USAGE)
    expect(parseLoopArgs("1.5h")).toBe(LOOP_USAGE)
    expect(parseLoopArgs("0")).toBe("Loop count must be a positive integer.")
    expect(parseLoopArgs("10x")).toBe("Loop duration unit must be seconds, minutes, or hours.")
  })

  test("plain prose is the prompt", () => {
    expect(parseLoopArgs("keep going")).toEqual({ prompt: "keep going" })
  })

  test("--while and --until take a quoted shell command", () => {
    expect(parseLoopArgs("20 --until 'bun test' fix it")).toEqual({
      limit: { kind: "iterations", iterations: 20 },
      condition: { command: "bun test", until: true },
      prompt: "fix it",
    })
    expect(parseLoopArgs('--while="test -f x"')).toEqual({ condition: { command: "test -f x", until: false } })
  })

  test("condition flag errors", () => {
    expect(parseLoopArgs("--when x")).toContain("Unknown /loop flag --when")
    expect(parseLoopArgs("--until 'a' --while 'b'")).toBe("Use only one of --while or --until.")
    expect(parseLoopArgs("--until 'bun test")).toBe("--until has an unterminated quote.")
    expect(parseLoopArgs("--until")).toContain("--until needs a shell command")
    expect(parseLoopArgs("--until --while x")).toContain("--until needs a shell command")
  })
})

describe("readShellWord", () => {
  test("concatenates quoted and unquoted runs", () => {
    expect(readShellWord(`a"b c"d rest`)).toEqual({ value: "ab cd", rest: "rest" })
    expect(readShellWord(`'x \\y' z`)).toEqual({ value: "x \\y", rest: "z" })
    expect(readShellWord(`"a \\" b"`)).toEqual({ value: 'a " b', rest: "" })
    expect(readShellWord("a\\ b c")).toEqual({ value: "a b", rest: "c" })
  })

  test("empty and unterminated input", () => {
    expect(readShellWord("  ")).toBeUndefined()
    expect(readShellWord("'open")).toBe("unterminated")
  })
})

describe("loop limits", () => {
  test("iterations are consumed until none remain", () => {
    const limit = createLoopLimitRuntime({ kind: "iterations", iterations: 2 })
    expect(isLoopLimitExhausted(limit)).toBe(false)
    expect(consumeLoopLimitIteration(limit)).toBe(true)
    expect(consumeLoopLimitIteration(limit)).toBe(true)
    expect(isLoopLimitExhausted(limit)).toBe(true)
    expect(consumeLoopLimitIteration(limit)).toBe(false)
  })

  test("durations expire at the deadline", () => {
    const limit = createLoopLimitRuntime({ kind: "duration", durationMs: 1000 }, 0)
    expect(consumeLoopLimitIteration(limit, 999)).toBe(true)
    expect(isLoopLimitExhausted(limit, 999)).toBe(false)
    expect(isLoopLimitExhausted(limit, 1000)).toBe(true)
    expect(consumeLoopLimitIteration(limit, 1000)).toBe(false)
  })

  test("no limit never runs out", () => {
    expect(createLoopLimitRuntime(undefined)).toBeUndefined()
    expect(consumeLoopLimitIteration(undefined)).toBe(true)
    expect(isLoopLimitExhausted(undefined)).toBe(false)
  })

  test("descriptions", () => {
    expect(describeLoopLimit({ kind: "iterations", iterations: 1 })).toBe("1 iteration")
    expect(describeLoopLimit({ kind: "duration", durationMs: 7_200_000 })).toBe("2 hours")
    expect(describeLoopLimit({ kind: "duration", durationMs: 90_000 })).toBe("90 seconds")
    expect(describeLoopLimitRuntime({ kind: "iterations", initial: 3, remaining: 1 })).toBe(
      "1 of 3 iterations remaining",
    )
    expect(describeLoopLimitRuntime({ kind: "duration", durationMs: 60_000, deadlineMs: 1 })).toBe("1 minute limit")
  })
})
