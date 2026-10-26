import { describe, expect, test } from "bun:test"

import { conditionVerdict, describeLoopCondition, evaluateLoopCondition, runCondition } from "./condition.ts"

const until = { command: "bun test", until: true }
const whileCond = { command: "test -f x", until: false }

describe("conditionVerdict", () => {
  test("exit 0 continues --while and halts --until", () => {
    expect(conditionVerdict(whileCond, { kind: "exited", exitCode: 0, output: "" })).toEqual({ kind: "continue" })
    expect(conditionVerdict(until, { kind: "exited", exitCode: 0, output: "" })).toEqual({
      kind: "halt",
      message: "Loop condition `bun test` is now satisfied. Loop mode disabled.",
    })
  })

  test("exit 1 continues --until and halts --while", () => {
    expect(conditionVerdict(until, { kind: "exited", exitCode: 1, output: "" })).toEqual({ kind: "continue" })
    expect(conditionVerdict(whileCond, { kind: "exited", exitCode: 1, output: "" })).toMatchObject({ kind: "halt" })
  })

  test("exit above 1, a missing status, a timeout or a spawn error is a broken condition", () => {
    expect(conditionVerdict(until, { kind: "exited", exitCode: 127, output: "\n  sh: bun: not found\n" })).toEqual({
      kind: "error",
      message: "Loop condition `bun test` failed (exit 127): sh: bun: not found. Loop mode disabled.",
    })
    expect(conditionVerdict(until, { kind: "exited", exitCode: null, output: "" })).toMatchObject({
      kind: "error",
      message: expect.stringContaining("no exit status"),
    })
    expect(conditionVerdict(until, { kind: "timeout" }, 30_000)).toEqual({
      kind: "error",
      message: "Loop condition `bun test` timed out after 30s. Loop mode disabled.",
    })
    expect(conditionVerdict(until, { kind: "spawn-error", error: "ENOENT" })).toMatchObject({ kind: "error" })
    expect(conditionVerdict(until, { kind: "aborted" })).toEqual({ kind: "aborted" })
  })

  test("describe", () => {
    expect(describeLoopCondition(until)).toBe("until `bun test` succeeds")
    expect(describeLoopCondition(whileCond)).toBe("while `test -f x` succeeds")
  })
})

describe("runCondition", () => {
  test("reports the exit status and output", async () => {
    expect(await runCondition("true", { cwd: "/" })).toMatchObject({ kind: "exited", exitCode: 0 })
    const failed = await runCondition("echo oops >&2; exit 3", { cwd: "/" })
    expect(failed).toMatchObject({ kind: "exited", exitCode: 3 })
    expect(failed.kind === "exited" && failed.output).toContain("oops")
  })

  test("times out and aborts", async () => {
    expect(await runCondition("sleep 5", { cwd: "/", timeoutMs: 50 })).toEqual({ kind: "timeout" })
    const controller = new AbortController()
    const pending = runCondition("sleep 5", { cwd: "/", signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ kind: "aborted" })
  })

  test("a missing working directory is a spawn error", async () => {
    expect(await runCondition("true", { cwd: "/definitely/not/here" })).toMatchObject({ kind: "spawn-error" })
  })

  test("evaluateLoopCondition ties both together", async () => {
    expect(await evaluateLoopCondition({ command: "exit 1", until: true }, { cwd: "/" })).toEqual({ kind: "continue" })
    expect(await evaluateLoopCondition({ command: "exit 2", until: true }, { cwd: "/" })).toMatchObject({
      kind: "error",
    })
  })
})
