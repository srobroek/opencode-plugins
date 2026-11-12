import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { compactRanges, PathError, resolveInside } from "./audit-util.ts"
import { compareCoverage, detectCoverageFormat, formatCoverage, parseCoverage } from "./coverage.ts"
import plugin from "./index.ts"
import { parseJunit } from "./junit.ts"
import { compareMutation, detectMutationFormat, formatMutation, parseMutation } from "./mutation.ts"
import { BUN, GOTESTSUM, NEXTEST, PYTEST, VITEST } from "./test-audit.fixtures.ts"
import {
  compareReports,
  confirmTestRepeat,
  parseRepeatInput,
  parseTestAuditOptions,
  repeatRuns,
  TEST_REPEAT_ACTION,
} from "./test-audit.ts"
import { formatRepeat, isFresh, markFile, type RunRecord, summarizeRuns } from "./test-repeat.ts"

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "quality-audit-"))
}

describe("parseJunit", () => {
  test("pytest: failure, error, skipped", () => {
    expect(parseJunit(PYTEST).map((c) => [c.id, c.status])).toEqual([
      ["test_a.TestX :: test_ok", "passed"],
      ["test_a.TestX :: test_bad", "failed"],
      ["test_a.TestX :: test_sk", "skipped"],
      ["test_a.TestX :: test_err", "error"],
    ])
  })
  test("vitest: entities decoded, empty skipped element", () => {
    const cases = parseJunit(VITEST)
    expect(cases.map((c) => c.id)).toEqual(["a.test.js :: suite > ok", "a.test.js :: suite > bad", "a.test.js :: suite > sk"])
    expect(cases.map((c) => c.status)).toEqual(["passed", "failed", "skipped"])
    expect(cases[1]?.time).toBeCloseTo(0.0032)
  })
  test("bun: nested suites, file in the id", () => {
    const cases = parseJunit(BUN)
    expect(cases.map((c) => [c.id, c.status])).toEqual([
      ["a.test.ts :: suite :: ok", "passed"],
      ["a.test.ts :: suite :: bad", "failed"],
      ["a.test.ts :: suite :: sk", "skipped"],
    ])
  })
  test("gotestsum: subtests and properties", () => {
    const cases = parseJunit(GOTESTSUM)
    expect(cases).toHaveLength(4)
    expect(cases.find((c) => c.id === "ex.com/m :: TestOk/sub")?.status).toBe("passed")
    expect(cases.find((c) => c.id === "ex.com/m :: TestSk")?.status).toBe("skipped")
    expect(cases.find((c) => c.id === "ex.com/m :: TestBad")?.status).toBe("failed")
  })
  test("nextest: rerunFailure fails, flakyFailure passes with retries", () => {
    const cases = parseJunit(NEXTEST)
    expect(cases.map((c) => c.status)).toEqual(["passed", "failed", "passed"])
    expect(cases[2]?.retries).toBe(2)
  })
  test("rejects non-JUnit input", () => {
    expect(() => parseJunit("<html/>")).toThrow()
    expect(() => parseJunit("")).toThrow()
  })
})

const rec = (run: number, report: RunRecord["report"], statuses: Record<string, "passed" | "failed" | "skipped">, exit = 0): RunRecord => ({
  run,
  exitCode: exit,
  outcome: "exited",
  seconds: run,
  report,
  cases: Object.entries(statuses).map(([id, status]) => ({ id, status, time: run / 10, retries: 0 })),
})

describe("summarizeRuns", () => {
  const records = [
    rec(1, "used", { a: "passed", b: "failed", c: "passed", d: "skipped" }, 1),
    rec(2, "used", { a: "failed", b: "failed", c: "passed", d: "skipped" }, 1),
    rec(3, "stale", { a: "passed" }),
    rec(4, "used", { a: "passed", b: "failed", c: "passed", d: "skipped" }, 1),
  ]
  const summary = summarizeRuns(records)
  test("flaky, always failing, slowest; stale reports ignored", () => {
    expect(summary.flaky.map((t) => [t.id, t.passed, t.failed])).toEqual([["a", 2, 1]])
    expect(summary.failedEveryRun.map((t) => t.id)).toEqual(["b"])
    expect(summary.slowest[0]?.id).toBeDefined()
    expect(summary.slowest.map((t) => t.id)).not.toContain("d")
    expect(summary.reportRuns).toBe(3)
    expect(summary.badReports).toEqual([{ run: 3, state: "stale" }])
    expect(summary.wallSeconds).toEqual({ min: 1, median: 2.5, max: 4 })
  })
  test("text names the sections and stays under the cap", () => {
    const text = formatRepeat(summary, { command: "t", cwd: "/x", requested: 4, junit: true })
    expect(text).toContain("flaky (passed and failed) (1)")
    expect(text).toContain("failed in every run (1)")
    expect(text).toContain("run 3: report stale")
    const many = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`very-long-test-name-${"x".repeat(40)}-${i}`, i % 2 ? "passed" : "failed"]))
    const big = summarizeRuns([rec(1, "used", many as never), rec(2, "used", Object.fromEntries(Object.keys(many).map((k) => [k, "failed"])) as never)])
    expect(formatRepeat(big, { command: "t", cwd: "/x", requested: 2, junit: true }).length).toBeLessThanOrEqual(4000)
  })
  test("reports differing exit codes without a junit file", () => {
    const text = formatRepeat(summarizeRuns([rec(1, "none", {}, 0), rec(2, "none", {}, 1)]), { command: "t", cwd: "/x", requested: 2, junit: false })
    expect(text).toContain("exit codes differ")
  })
})

describe("report freshness", () => {
  test("missing, unchanged and rewritten files", () => {
    const dir = scratch()
    try {
      const path = join(dir, "r.xml")
      expect(markFile(path)).toBeUndefined()
      writeFileSync(path, "a")
      const before = markFile(path)
      expect(isFresh(before, markFile(path))).toBe(false)
      writeFileSync(path, "b")
      expect(isFresh(before, markFile(path))).toBe(true)
      writeFileSync(path, "a")
      utimesSync(path, 1, 1)
      expect(isFresh(before, markFile(path))).toBe(true)
      expect(isFresh(undefined, markFile(path))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("repeatRuns", () => {
  test("runs a real command, reads only reports each run wrote, leaves files in place", async () => {
    const dir = scratch()
    try {
      // Writes a report on runs 1 and 3 only, with a test that fails on run 2.
      const script = `n=$(cat count 2>/dev/null || echo 0); n=$((n+1)); echo $n > count
if [ $n -ne 2 ]; then printf '<testsuites><testsuite name="s"><testcase classname="c" name="t" time="0.1"/><testcase classname="c" name="u" time="0.2">%s</testcase></testsuite></testsuites>' "$([ $n -eq 3 ] && echo '<failure/>')" > r.xml; fi
[ $n -ne 3 ]`
      const { records } = await repeatRuns({ command: script, runs: 3, cwd: dir, junitPath: join(dir, "r.xml"), timeoutSeconds: 30 }, undefined)
      expect(records.map((r) => r.exitCode)).toEqual([0, 0, 1])
      expect(records.map((r) => r.report)).toEqual(["used", "stale", "used"])
      const summary = summarizeRuns(records)
      expect(summary.flaky.map((t) => t.id)).toEqual(["c :: u"])
      expect(await Bun.file(join(dir, "r.xml")).exists()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("a timeout kills the process group", async () => {
    const dir = scratch()
    try {
      const { records } = await repeatRuns({ command: "sleep 30 & wait", runs: 1, cwd: dir, timeoutSeconds: 0.2 }, undefined)
      expect(records[0]).toMatchObject({ exitCode: null, outcome: "timeout" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("cancellation stops the loop", async () => {
    const dir = scratch()
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)
      const result = await repeatRuns({ command: "sleep 30", runs: 5, cwd: dir, timeoutSeconds: 60 }, controller.signal)
      expect(result.records).toHaveLength(1)
      expect(result.records[0]?.outcome).toBe("aborted")
      expect(result.interrupted).toContain("cancelled")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("parseRepeatInput", () => {
  test("defaults and bounds", () => {
    expect(parseRepeatInput({ command: "x" })).toEqual({ command: "x", runs: 5, cwd: undefined, junit: undefined, timeoutSeconds: 600 })
    for (const bad of [{}, { command: " " }, { command: "x", runs: 0 }, { command: "x", runs: 51 }, { command: "x", runs: 1.5 }, { command: "x", timeoutSeconds: 3601 }, { command: "x", timeoutSeconds: 0 }])
      expect(typeof parseRepeatInput(bad)).toBe("string")
  })
})

describe("resolveInside", () => {
  test("refuses escapes, including through symlinks", () => {
    const root = scratch()
    const outside = scratch()
    try {
      writeFileSync(join(outside, "x"), "")
      symlinkSync(outside, join(root, "link"))
      expect(resolveInside(root, root, "a/b.txt")).toBe(join(root, "a/b.txt"))
      expect(() => resolveInside(root, root, "../x")).toThrow(PathError)
      expect(() => resolveInside(root, root, join(outside, "x"))).toThrow(PathError)
      expect(() => resolveInside(root, root, "link/x")).toThrow(PathError)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
  test("compactRanges", () => {
    expect(compactRanges([7, 1, 2, 3, 3, 9])).toBe("1-3,7,9")
  })
})

const LCOV_A = `TN:
SF:src/a.ts
DA:1,1
DA:2,1
DA:3,1
DA:4,0
BRDA:2,0,0,1
BRDA:2,0,1,-
end_of_record
SF:src/gone.ts
DA:1,2
end_of_record
`
const LCOV_B = `SF:./src/a.ts
DA:1,1
DA:2,0
DA:3,0
DA:4,1
BRDA:2,0,0,0
BRDA:2,0,1,-
end_of_record
`
const COB = (hits: number, cond: string) => `<?xml version="1.0" ?>
<coverage><sources><source>/x</source></sources><packages><package name="."><classes>
<class name="m.py" filename="m.py"><lines>
<line number="1" hits="1"/><line number="2" hits="1" branch="true" condition-coverage="${cond}"/><line number="3" hits="${hits}"/>
</lines></class></classes></package></packages></coverage>`

describe("coverage", () => {
  test("LCOV: lost lines and branches, disappeared file, totals", () => {
    const c = compareCoverage(parseCoverage(LCOV_A, undefined), parseCoverage(LCOV_B, "lcov"))
    expect(c.lines.baseline).toEqual({ covered: 4, total: 5, percent: 80 })
    expect(c.lines.candidate).toEqual({ covered: 2, total: 4, percent: 50 })
    expect(c.branches?.baseline.covered).toBe(1)
    expect(c.lost).toEqual([{ file: "src/a.ts", lines: [2, 3], branches: ["2,0,0"], lostLineCount: 2, lostBranchCount: 1 }])
    expect(c.disappeared).toEqual([{ file: "src/gone.ts", coveredLines: 1 }])
    const text = formatCoverage(c)
    expect(text).toContain("lines 2-3")
    expect(text).toContain("src/gone.ts")
  })
  test("Cobertura (coverage.py shape): positional branches from condition-coverage", () => {
    const c = compareCoverage(parseCoverage(COB(1, "100% (2/2)"), undefined), parseCoverage(COB(0, "50% (1/2)"), undefined))
    expect(c.lost[0]).toMatchObject({ file: "m.py", lines: [3], branches: ["2:1"] })
    expect(c.branches?.baseline).toEqual({ covered: 2, total: 2, percent: 100 })
  })
  test("Cobertura conditions elements", () => {
    const xml = `<coverage><packages><package><classes><class filename="a"><lines><line number="1" hits="1" branch="true"><conditions><condition number="0" type="jump" coverage="100%"/><condition number="1" type="jump" coverage="0%"/></conditions></line></lines></class></classes></package></packages></coverage>`
    const r = parseCoverage(xml, "cobertura")
    expect([...(r.files.get("a")?.branches ?? [])]).toEqual([["1:0", true], ["1:1", false]])
  })
  test("Go profile: lines only, branches not measured", () => {
    const base = "mode: set\nex.com/m/a.go:3.10,5.2 2 1\nex.com/m/a.go:6.1,7.2 1 1\n"
    const cand = "mode: set\nex.com/m/a.go:3.10,5.2 2 0\nex.com/m/a.go:6.1,7.2 1 1\n"
    expect(detectCoverageFormat(base)).toBe("gocover")
    const c = compareCoverage(parseCoverage(base, undefined), parseCoverage(cand, undefined))
    expect(c.branches).toBeNull()
    expect(c.lost[0]).toMatchObject({ file: "ex.com/m/a.go", lines: [3, 4, 5] })
    expect(formatCoverage(c)).toContain("branches: not measured")
  })
  test("LCOV without BRDA is branches not measured, not zero", () => {
    const c = compareCoverage(parseCoverage("SF:a\nDA:1,1\nend_of_record\n", undefined), parseCoverage(LCOV_B, undefined))
    expect(c.branches).toBeNull()
  })
  test("unknown format throws", () => {
    expect(() => parseCoverage("hello", undefined)).toThrow(/detect/)
  })
})

const stryker = (statuses: string[], extra = "") =>
  JSON.stringify({
    schemaVersion: "1",
    files: {
      "src/a.js": {
        language: "javascript",
        source: "",
        mutants: statuses.map((status, i) => ({
          id: `run-specific-${extra}${i}`,
          mutatorName: "ConditionalExpression",
          replacement: `r${i}`,
          location: { start: { line: i + 1, column: 1 }, end: { line: i + 1, column: 5 } },
          status,
        })),
      },
    },
  })

describe("mutation", () => {
  test("mutation-testing schema: keyed by position, not by id", () => {
    const base = parseMutation(stryker(["Killed", "Timeout", "Survived", "NoCoverage", "CompileError"], "a"), undefined)
    const cand = parseMutation(stryker(["Survived", "NoCoverage", "Killed", "Killed", "Killed"], "b"), undefined)
    const c = compareMutation(base, cand)
    expect(c.baseline.score).toBe(50)
    expect(c.candidate.score).toBe(60)
    expect(c.lostProtection.map((m) => m.location.split("-")[0])).toEqual(["1:1", "2:1"])
    expect(c.lostProtection[0]).toMatchObject({ was: "Killed", now: "Survived" })
    expect(c.newlyKilled).toHaveLength(2)
    expect(formatMutation(c)).toContain("LOST PROTECTION")
  })
  test("mutants in one report only", () => {
    const c = compareMutation(parseMutation(stryker(["Killed", "Killed"]), undefined), parseMutation(stryker(["Killed"]), undefined))
    expect(c.onlyInBaseline).toHaveLength(1)
    expect(c.lostProtection).toHaveLength(0)
  })
  const cargo = (summaries: string[]) =>
    JSON.stringify({
      outcomes: [
        { scenario: "Baseline", summary: "Success" },
        ...summaries.map((summary, i) => ({
          scenario: { Mutant: { name: `n${i}`, file: "src/lib.rs", genre: "FnValue", replacement: "()", span: { start: { line: i + 1, column: 1 }, end: { line: i + 1, column: 9 } } } },
          summary,
        })),
      ],
      total_mutants: summaries.length,
    })
  test("cargo-mutants outcomes.json", () => {
    const data = JSON.parse(cargo([]))
    expect(detectMutationFormat(data)).toBe("cargo-mutants")
    const c = compareMutation(parseMutation(cargo(["CaughtMutant", "Timeout", "Unviable"]), undefined), parseMutation(cargo(["MissedMutant", "CaughtMutant", "Unviable"]), undefined))
    expect(c.lostProtection).toHaveLength(1)
    expect(c.baseline).toMatchObject({ detected: 2, ignored: 1, score: 100 })
  })
  const gremlins = (statuses: string[]) =>
    JSON.stringify({
      go_module: "ex.com/m",
      files: [{ file_name: "a.go", mutations: statuses.map((status, i) => ({ type: "CONDITIONALS_NEGATION", status, line: i + 1, column: 3 })) }],
    })
  test("gremlins JSON", () => {
    const c = compareMutation(parseMutation(gremlins(["KILLED", "TIMED OUT", "LIVED", "NOT VIABLE"]), undefined), parseMutation(gremlins(["NOT COVERED", "KILLED", "KILLED", "NOT VIABLE"]), undefined))
    expect(c.lostProtection).toHaveLength(1)
    expect(c.newlyKilled).toHaveLength(1)
    expect(c.baseline.score).toBeCloseTo(66.7, 1)
  })
  test("unknown format throws", () => {
    expect(() => parseMutation("{}", undefined)).toThrow(/detect/)
  })
})

describe("compareReports", () => {
  test("reads inside the session directory and refuses outside paths", () => {
    const root = scratch()
    const outside = scratch()
    try {
      mkdirSync(join(root, "r"))
      writeFileSync(join(root, "r/a.info"), LCOV_A)
      writeFileSync(join(root, "r/b.info"), LCOV_B)
      writeFileSync(join(outside, "c.info"), LCOV_B)
      const ok = compareReports(root, { kind: "coverage", baseline: "r/a.info", candidate: join(root, "r/b.info") })
      expect(ok.content).toContain("LOST COVERAGE")
      expect((ok.metadata.lost as unknown[]).length).toBe(1)
      for (const candidate of [join(outside, "c.info"), "../x"]) {
        const refused = compareReports(root, { kind: "coverage", baseline: "r/a.info", candidate })
        expect(refused.content).toContain("refused")
      }
      expect(compareReports(root, { kind: "mutation", baseline: "r/a.info", candidate: "r/b.info" }).content).toContain("quality_test_compare:")
      expect(compareReports(root, { kind: "coverage", baseline: "r/a.info", candidate: "r/b.info", format: "gremlins" }).content).toContain("format")
      expect(compareReports(root, { kind: "x" }).content).toContain("kind")
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>
const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }

describe("plugin wiring", () => {
  test("registers both tools and the confirm hook, and disposes them", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    expect([...fake.tools.keys()]).toEqual(["quality_test_repeat", "quality_test_compare"])
    expect(fake.hooks("permission")).toEqual(["evaluate"])
    for (const tool of fake.tools.values()) {
      expect((tool.description as string).split("\n")[0]?.length).toBeLessThanOrEqual(120)
      expect(JSON.stringify(tool.input).length).toBeLessThan(3000)
      expect((tool as { codemode?: boolean }).codemode).toBeUndefined()
    }
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
  })

  test("confirmTestRuns: false drops the hook", async () => {
    const fake = createFakeContext({ options: { confirmTestRuns: false } })
    await plugin.setup(fake.context)
    expect(fake.hooks("permission")).toEqual([])
    expect(parseTestAuditOptions({})).toEqual({ confirm: true })
  })

  test("quality_test_repeat asserts the permission, then runs; rejects bad cwd without a process", async () => {
    const dir = scratch()
    try {
      const fake = createFakeContext({ directory: dir })
      await plugin.setup(fake.context)
      const run = fake.tools.get("quality_test_repeat")?.execute as Execute
      const context = { ...call, signal: new AbortController().signal }
      const result = await run({ command: "echo hi", runs: 2 }, context)
      expect(fake.asserts).toHaveLength(1)
      expect(fake.asserts[0]).toMatchObject({ action: TEST_REPEAT_ACTION, resources: ["echo hi"], metadata: { runs: 2 } })
      expect(result.content).toContain("exit codes: 0 0")
      expect(result.metadata.runs).toBe(2)
      const refused = await run({ command: "echo hi", cwd: ".." }, context)
      expect(refused.content).toContain("no process started")
      expect(fake.asserts).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("quality_test_compare needs no permission", async () => {
    const dir = scratch()
    try {
      writeFileSync(join(dir, "a"), LCOV_A)
      const fake = createFakeContext({ directory: dir })
      await plugin.setup(fake.context)
      const compare = fake.tools.get("quality_test_compare")?.execute as Execute
      const result = await compare({ kind: "coverage", baseline: "a", candidate: "a" }, { ...call, signal: new AbortController().signal })
      expect(result.content).toContain("coverage: lines")
      expect(fake.asserts).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("confirmTestRepeat", () => {
  test("turns allow into ask naming command and run count; leaves other actions and denies", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const evaluation = await fake.fire.permission("evaluate", {
      action: TEST_REPEAT_ACTION,
      resources: ["bun test"],
      metadata: { runs: 7 },
      effect: "allow",
    } as { action: string; resources: string[]; metadata: Record<string, unknown>; effect: string; message?: string })
    expect(evaluation.effect).toBe("ask")
    expect(evaluation.message).toContain("bun test")
    expect(evaluation.message).toContain("7 times")
    for (const [action, effect] of [["other", "allow"], [TEST_REPEAT_ACTION, "deny"]] as const) {
      const e = { action, resources: ["x"], effect }
      confirmTestRepeat(e)
      expect(e.effect).toBe(effect)
    }
  })
})
