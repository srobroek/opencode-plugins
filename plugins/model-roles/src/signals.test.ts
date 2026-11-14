import { describe, expect, test } from "bun:test"
import { DEFAULT_TEST_COMMANDS, DEFAULT_TEST_GLOBS, exitStatusOf, parseEvaluate, parseVerdict, testRun, touchesTests, type Verdict } from "./signals.ts"

describe("parseVerdict", () => {
  test.each<[string, Verdict | undefined]>([
    ["VERDICT: APPROVE", "approve"],
    ["verdict: request-changes", "request-changes"],
    ["Summary\n\nVERDICT:COMMENT", "comment"],
    ["VERDICT: APPROVE\nmore text\nVERDICT: REQUEST-CHANGES\ntrailing", "request-changes"],
    ["VERDICT: APPROVED-ish", undefined],
    ["VERDICT: MAYBE", undefined],
    ["I would say VERDICT: APPROVE", undefined],
    ["", undefined],
  ])("%j -> %j", (text, expected) => {
    expect(parseVerdict(text)).toBe(expected)
  })
})

describe("testRun", () => {
  const run = (command: string, exit: number | undefined) => testRun(command, exit, DEFAULT_TEST_COMMANDS)

  test.each([
    "bun test",
    "bun test plugins/model-roles",
    "cd /repo && bun test",
    "cd /repo; bun test",
    "CI=1 NODE_ENV='a b' bun test",
    "npm run test",
    "pnpm run test:unit",
    "bun run check",
    "python -m pytest -x",
    "cargo nextest run",
    "cd x && FOO=1 go test ./...",
  ])("counts %j as a test run", (command) => {
    expect(run(command, 0)).toBe("pass")
    expect(run(command, 1)).toBe("fail")
  })

  test.each(["bun testing", "git status", "echo bun test", "bun run build", "ls && cat pytest.ini"])("does not count %j", (command) => {
    expect(run(command, 0)).toBeUndefined()
  })

  test("an unknown exit status is no result", () => {
    expect(run("bun test", undefined)).toBeUndefined()
  })

  test("a custom list replaces the defaults", () => {
    expect(testRun("make verify", 0, ["make verify"])).toBe("pass")
    expect(testRun("bun test", 0, ["make verify"])).toBeUndefined()
  })
})

describe("touchesTests", () => {
  test.each([
    ["src/a.test.ts", true],
    ["a.spec.js", true],
    ["plugins/x/test/helper.ts", true],
    ["tests/a.py", true],
    ["src/__tests__/a.ts", true],
    ["pkg/a_test.go", true],
    ["tools/test_a.py", true],
    ["src/a.ts", false],
    ["src/contest/a.ts", false],
    ["src/latest.ts", false],
    ["docs/testing.md", false],
  ])("%s -> %s", (file, expected) => {
    expect(touchesTests([file], DEFAULT_TEST_GLOBS)).toBe(expected)
  })

  test("any file counts, none is false", () => {
    expect(touchesTests(["a.ts", "b.test.ts"], DEFAULT_TEST_GLOBS)).toBe(true)
    expect(touchesTests([], DEFAULT_TEST_GLOBS)).toBe(false)
  })
})

describe("parseEvaluate", () => {
  test("defaults, and an array replaces its default", () => {
    expect(parseEvaluate(undefined)).toEqual({ testCommands: DEFAULT_TEST_COMMANDS, testGlobs: DEFAULT_TEST_GLOBS })
    expect(parseEvaluate({ testCommands: ["make verify", 3, " "], testGlobs: "x" })).toEqual({ testCommands: ["make verify"], testGlobs: DEFAULT_TEST_GLOBS })
  })
})

describe("exitStatusOf", () => {
  test.each([
    [{ exit: 2 }, 2],
    [{ exitCode: 0 }, 0],
    [{ exit: "1" }, undefined],
    [undefined, undefined],
  ])("%j -> %j", (metadata, expected) => {
    expect(exitStatusOf(metadata)).toBe(expected)
  })
})
