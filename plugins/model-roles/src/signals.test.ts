import { describe, expect, test } from "bun:test"
import { DEFAULT_TEST_COMMANDS, DEFAULT_TEST_GLOBS, exitStatusOf, parseEvaluate, parseVerdict, testRun, touchesTests, type Verdict } from "./signals.ts"

describe("parseVerdict", () => {
  test.each<[string, Verdict | undefined]>([
    ["VERDICT: APPROVE", "approve"],
    ["verdict: request-changes", "request-changes"],
    ["Summary\n\nVERDICT:COMMENT", "comment"],
    ["VERDICT: APPROVE\nmore text\nVERDICT: REQUEST-CHANGES\ntrailing", "request-changes"],
    ["VERDICT: REQUEST-CHANGES\nlong findings follow\nmore findings", "request-changes"],
    ["VERDICT: APPROVED-ish", undefined],
    ["VERDICT: MAYBE", undefined],
    ["I would say VERDICT: APPROVE", undefined],
    ["", undefined],
    // Not a verdict: fenced, indented or quoted.
    ["```\nVERDICT: APPROVE\n```", undefined],
    ["~~~text\nVERDICT: APPROVE\n~~~", undefined],
    ["    VERDICT: APPROVE", undefined],
    ["\tVERDICT: APPROVE", undefined],
    ["> VERDICT: APPROVE", undefined],
    [">VERDICT: APPROVE", undefined],
    ["```\nunclosed fence\nVERDICT: APPROVE", undefined],
    // A real verdict is counted around them, and the last real one wins.
    ["VERDICT: COMMENT\n```\nVERDICT: APPROVE\n```", "comment"],
    ["VERDICT: REQUEST-CHANGES\n\n> VERDICT: APPROVE\n    VERDICT: APPROVE", "request-changes"],
    ["```\nVERDICT: APPROVE\n```\nVERDICT: APPROVE", "approve"],
    // Fence length and character: only a closing line of the same character, at least as long, bare.
    ["````\n```\nVERDICT: APPROVE\n```\n````", undefined],
    ["VERDICT: COMMENT\n````\n```\n````\nVERDICT: APPROVE", "approve"],
    ["VERDICT: COMMENT\n````\n```\nVERDICT: APPROVE\n````", "comment"],
    ["```\n~~~\nVERDICT: APPROVE\n~~~\n```", undefined],
    ["~~~\n```\nVERDICT: APPROVE\n```\n~~~\nVERDICT: REQUEST-CHANGES", "request-changes"],
    ["```\n``` not a close\nVERDICT: APPROVE\n```", undefined],
    ["~~~~\n~~~\nVERDICT: APPROVE\n~~~~\nVERDICT: COMMENT", "comment"],
    ["  VERDICT: APPROVE", "approve"],
  ])("%j -> %j", (text, expected) => {
    expect(parseVerdict(text)).toBe(expected)
  })
})

describe("testRun", () => {
  const run = (command: string, exit: number | undefined) => testRun(command, exit, DEFAULT_TEST_COMMANDS)

  // The test command is the last command and only setup precedes it, so the exit is its own.
  test.each([
    "bun test",
    "bun test plugins/model-roles",
    "cd /repo; bun test",
    "CI=1 NODE_ENV='a b' bun test",
    "npm run test",
    "pnpm run test:unit",
    "bun run check",
    "python -m pytest -x",
    "cargo nextest run",
    "FOO=1 go test ./...",
    "bun test 2>&1",
    "bun test > out.log 2>&1",
    "bun test >> out.log",
    "bun test 2>/dev/null",
    "bun test\n",
    "bun test --grep 'a; b | c'",
  ])("counts %j: the exit is the test's", (command) => {
    expect(run(command, 0)).toBe("pass")
    expect(run(command, 1)).toBe("fail")
  })

  // Not a test run, or the exit could belong to something else: no result.
  test.each([
    "bun testing",
    "git status",
    "echo bun test",
    'echo "bun test; ok"',
    "echo 'cd x && bun test'",
    'echo "a; bun test src/x.test.ts"',
    "echo 'a && bun test src/x.test.ts'",
    "'bun test'",
    '"bun test" src/x.test.ts',
    "'bun' 'test' x 'a b'; 'bun test'",
    "bun run build",
    "ls && cat pytest.ini",
    "bun test; echo ok",
    "bun test && false",
    "bun test || true",
    "bun test | tail",
    "bun test 2>&1 | tail",
    "bun test &",
    "(bun test)",
    "$(bun test)",
    "`bun test`",
    "echo $(bun test)",
    "bun test && echo done",
    "bun test\necho ok",
    "ls | bun test",
    "make && bun test",
    "cd x && echo hi && bun test",
    "cd && bun test",
    "git pull; bun test",
    "bun test <<EOF\nx\nEOF",
    "bun test 'unbalanced",
    'bun test "unbalanced',
    "eval 'bun test'",
    "sh -c 'bun test'",
    "bash -c \"cd x && bun test\"",
    "xargs bun test",
  ])("leaves %j unset: the exit is not unambiguously the test's", (command) => {
    expect(run(command, 0)).toBeUndefined()
    expect(run(command, 1)).toBeUndefined()
  })

  test("an unknown exit status is no result", () => {
    expect(run("bun test", undefined)).toBeUndefined()
  })

  test("a quoted word is one token: bun 'test' runs bun test", () => {
    expect(run("bun 'test' src/x.test.ts", 1)).toBe("fail")
  })

  // After `&&` setup a non-zero exit may be the setup's: unset. Zero means both ran and passed.
  test.each(["cd /repo && bun test", "cd '/my repo' && bun test", "FOO=1 cd x && bun test", "cd x && export A=1 && B=2 bun test", "export CI=1 && bun test", "cd x && FOO=1 go test ./...", "cd x && FOO=1 bun test 2>&1", "cd a && cd b && bun test"])(
    "setup joined by && in %j: pass counts, a failure is ambiguous",
    (command) => {
      expect(run(command, 0)).toBe("pass")
      expect(run(command, 1)).toBeUndefined()
    },
  )

  // After `;` or a newline the test always runs, so its exit counts.
  test.each(["cd /repo; bun test", "cd /repo\nbun test", "export CI=1; bun test", "cd a && cd b; bun test"])(
    "setup joined by ; or a newline in %j: the test's exit counts",
    (command) => {
      expect(run(command, 0)).toBe("pass")
      expect(run(command, 1)).toBe("fail")
    },
  )

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

  test.each([
    ["a\\b\\foo.test.ts", true],
    ["src\\tests\\helper.ts", true],
    [".\\src\\foo.spec.ts", true],
    ["a\\b\\foo.ts", false],
  ])("Windows path %s is normalized: %s", (file, expected) => {
    expect(touchesTests([file], DEFAULT_TEST_GLOBS)).toBe(expected)
  })

  test("custom globs replace the defaults when given", () => {
    const globs = ["e2e/**"]
    expect(touchesTests(["e2e/login.ts"], globs)).toBe(true)
    expect(touchesTests(["src/a.test.ts"], globs)).toBe(false)
  })
})

describe("parseEvaluate", () => {
  test("defaults, and an array replaces its default", () => {
    expect(parseEvaluate(undefined)).toEqual({ testCommands: DEFAULT_TEST_COMMANDS, testGlobs: DEFAULT_TEST_GLOBS })
    expect(parseEvaluate({ testCommands: ["make verify", 3, " "], testGlobs: "x" })).toEqual({ testCommands: ["make verify"], testGlobs: DEFAULT_TEST_GLOBS })
  })

  test("a configured testGlobs array replaces the default globs", () => {
    const { testGlobs } = parseEvaluate({ testGlobs: ["e2e/**", " spec/** "] })
    expect(testGlobs).toEqual(["e2e/**", "spec/**"])
    expect(touchesTests(["src/a.test.ts"], testGlobs)).toBe(false)
    expect(touchesTests(["spec/x.rb"], testGlobs)).toBe(true)
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
