import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { compactRanges, opencodeTempDir, PathError, readReportFile } from "./audit-util.ts"
import { compareCoverage, detectCoverageFormat, formatCoverage, parseCoverage } from "./coverage.ts"
import plugin from "./index.ts"
import { parseJunit } from "./junit.ts"
import { compareMutation, detectMutationFormat, formatMutation, parseMutation } from "./mutation.ts"
import { BUN, GOTESTSUM, NEXTEST, PYTEST, VITEST } from "./test-audit.fixtures.ts"
import { compareReports, parseSummarizeInput, parseTestAuditOptions, summarizeReports } from "./test-audit.ts"
import { formatSummary, type RunRecord, summarizeRuns } from "./test-repeat.ts"

/** A directory inside the OpenCode temp directory. */
function scratch(): string {
  mkdirSync(opencodeTempDir(), { recursive: true })
  return mkdtempSync(join(opencodeTempDir(), "quality-audit-"))
}

/** A directory in the system temp directory but outside the OpenCode temp directory. */
function outsideScratch(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "quality-audit-"))
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
  test("rejects truncated or malformed XML", () => {
    expect(() => parseJunit(PYTEST.slice(0, -40))).toThrow(/invalid XML/)
    expect(() => parseJunit("<testsuites><testsuite><testcase></testsuite></testsuites>")).toThrow(/invalid XML/)
  })
  test("rejects non-JUnit input", () => {
    expect(() => parseJunit("<html/>")).toThrow()
    expect(() => parseJunit("")).toThrow()
  })
})

const rec = (run: number, report: RunRecord["report"], statuses: Record<string, "passed" | "failed" | "skipped">, exit?: number): RunRecord => ({
  run,
  exitCode: exit,
  report,
  reason: report === "used" ? undefined : "invalid XML",
  cases: Object.entries(statuses).map(([id, status]) => ({ id, status, time: run / 10, retries: 0 })),
})

describe("summarizeRuns", () => {
  const records = [
    rec(1, "used", { a: "passed", b: "failed", c: "passed", d: "skipped" }, 1),
    rec(2, "used", { a: "failed", b: "failed", c: "passed", d: "skipped" }, 1),
    rec(3, "unreadable", { a: "passed" }, 0),
    rec(4, "used", { a: "passed", b: "failed", c: "passed", d: "skipped" }, 1),
  ]
  const summary = summarizeRuns(records)
  test("flaky, always failing, slowest; unreadable reports ignored", () => {
    expect(summary.flaky.map((t) => [t.id, t.passed, t.failed])).toEqual([["a", 2, 1]])
    expect(summary.failedEveryRun.map((t) => t.id)).toEqual(["b"])
    expect(summary.slowest[0]?.id).toBeDefined()
    expect(summary.slowest.map((t) => t.id)).not.toContain("d")
    expect(summary.reportRuns).toBe(3)
    expect(summary.unreadable).toEqual([{ run: 3, reason: "invalid XML" }])
    expect(summary.exitCodes).toEqual([1, 1, 0, 1])
    expect(summary.exitCodesAgree).toBe(false)
  })
  test("text names the sections and stays under the cap", () => {
    const text = formatSummary(summary)
    expect(text).toContain("flaky (passed and failed) (1)")
    expect(text).toContain("failed in every report (1)")
    expect(text).toContain("report 3: unreadable (invalid XML)")
    expect(text).toContain("exit codes differ")
    const many = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`very-long-test-name-${"x".repeat(40)}-${i}`, i % 2 ? "passed" : "failed"]))
    const big = summarizeRuns([rec(1, "used", many as never), rec(2, "used", Object.fromEntries(Object.keys(many).map((k) => [k, "failed"])) as never)])
    expect(formatSummary(big).length).toBeLessThanOrEqual(4000)
  })
  test("unknown exit codes take no part in agreement or counts", () => {
    const s = summarizeRuns([rec(1, "used", { a: "passed" }, 0), { ...rec(2, "used", { a: "passed" }), exitCode: null }])
    expect(s.exitCodesAgree).toBe(true)
    expect(s.exitCodesUnknown).toBe(1)
    const text = formatSummary(s)
    expect(text).toContain("1 zero, 0 non-zero, 1 unknown")
    expect(text).not.toContain("differ")
    const allUnknown = summarizeRuns([{ ...rec(1, "used", {}), exitCode: null }])
    expect(allUnknown.exitCodesAgree).toBeNull()
    expect(summarizeRuns([rec(1, "used", {}, 0), rec(2, "used", {}, 1)]).exitCodesAgree).toBe(false)
  })
  test("without exit codes there is no agreement claim", () => {
    const plain = summarizeRuns([rec(1, "used", { a: "passed" })])
    expect(plain.exitCodes).toBeNull()
    expect(plain.exitCodesAgree).toBeNull()
    expect(formatSummary(plain)).not.toContain("exit codes")
  })
  test("nextest retries are listed", () => {
    const cases = parseJunit(NEXTEST)
    const s = summarizeRuns([{ run: 1, report: "used", cases }])
    expect(s.retriedInRun).toEqual(["fixture-project::basic :: test_flaky_mod_4"])
  })
})

describe("parseSummarizeInput", () => {
  test("bounds and exit code shape", () => {
    expect(parseSummarizeInput({ reports: ["a"] })).toEqual({ reports: ["a"], exitCodes: undefined })
    expect(parseSummarizeInput({ reports: ["a", "b"], exitCodes: [0, null] })).toMatchObject({ exitCodes: [0, null] })
    for (const bad of [{}, { reports: [] }, { reports: Array(51).fill("a") }, { reports: [""] }, { reports: ["a"], exitCodes: [] }, { reports: ["a"], exitCodes: [1.5] }, { reports: ["a"], exitCodes: ["0"] }])
      expect(typeof parseSummarizeInput(bad)).toBe("string")
  })
})

describe("summarizeReports", () => {
  test("reads reports in the session and temp directories; unreadable ones are marked", () => {
    const root = scratch()
    const outside = outsideScratch()
    try {
      const ok = (failed: boolean) => `<testsuites><testsuite name="s"><testcase classname="c" name="t" time="0.1">${failed ? "<failure/>" : ""}</testcase></testsuite></testsuites>`
      writeFileSync(join(root, "r1.xml"), ok(false))
      writeFileSync(join(root, "r2.xml"), ok(true))
      writeFileSync(join(root, "truncated.xml"), ok(false).slice(0, -20))
      const result = summarizeReports(root, { reports: ["r1.xml", join(root, "r2.xml"), "truncated.xml", "missing.xml"], exitCodes: [0, 1, 1, null] })
      expect(result.metadata.reportRuns).toBe(2)
      expect((result.metadata.flaky as unknown[]).length).toBe(1)
      expect((result.metadata.unreadable as Array<{ run: number }>).map((u) => u.run)).toEqual([3, 4])
      expect(result.content).toContain("report 3: unreadable")
      const refused = summarizeReports(root, { reports: ["r1.xml", join(outside, "r.xml")] })
      expect(refused.content).toContain("refused")
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("readReportFile", () => {
  test("accepts the session and OpenCode temp directories, refuses everything else", () => {
    const session = outsideScratch()
    const temp = scratch()
    const outside = outsideScratch()
    try {
      writeFileSync(join(session, "a"), "A")
      writeFileSync(join(temp, "b"), "B")
      writeFileSync(join(outside, "c"), "C")
      expect(readReportFile(session, "a")).toBe("A")
      expect(readReportFile(session, join(temp, "b"))).toBe("B")
      expect(() => readReportFile(session, join(outside, "c"))).toThrow(PathError)
      expect(() => readReportFile(session, "../x")).toThrow(PathError)
      expect(() => readReportFile(session, join(outside, "missing"))).toThrow(PathError)
      expect(() => readReportFile(session, "missing")).toThrow(/does not exist/)
    } finally {
      for (const d of [session, temp, outside]) rmSync(d, { recursive: true, force: true })
    }
  })
  test("a symlink to an outside file is refused, also one that dangled when created", () => {
    const session = outsideScratch()
    const outside = outsideScratch()
    try {
      symlinkSync(join(outside, "later"), join(session, "dangling"))
      symlinkSync(join(outside, "c"), join(session, "live"))
      writeFileSync(join(outside, "c"), "C")
      expect(() => readReportFile(session, "live")).toThrow(PathError)
      writeFileSync(join(outside, "later"), "L")
      expect(() => readReportFile(session, "dangling")).toThrow(PathError)
    } finally {
      rmSync(session, { recursive: true, force: true })
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
    expect(c.lost).toEqual([{ file: "src/a.ts", lines: [2, 3], branches: ["2 (1/2 -> 0/2)"], lostLineCount: 2, lostBranchCount: 1 }])
    expect(c.disappeared).toEqual([{ file: "src/gone.ts", coveredLines: 1 }])
    const text = formatCoverage(c)
    expect(text).toContain("lines 2-3")
    expect(text).toContain("src/gone.ts")
  })
  test("Cobertura condition-coverage keeps covered/total per line: 2/2 to 1/2 loses a branch", () => {
    const c = compareCoverage(parseCoverage(COB(1, "100% (2/2)"), undefined), parseCoverage(COB(0, "50% (1/2)"), undefined))
    expect(c.lost[0]).toMatchObject({ file: "m.py", lines: [3], lostBranchCount: 1 })
    expect(c.lost[0]?.branches[0]).toContain("2/2 -> 1/2")
    expect(c.branches?.baseline).toEqual({ covered: 2, total: 2, percent: 100 })
    expect(c.branches?.candidate).toEqual({ covered: 1, total: 2, percent: 50 })
    const same = compareCoverage(parseCoverage(COB(1, "50% (1/2)"), undefined), parseCoverage(COB(1, "50% (1/2)"), undefined))
    expect(same.lost).toEqual([])
  })
  test("a partly covered condition counts by its percentage", () => {
    const cond = (a: number, b: number) =>
      `<coverage><packages><package><classes><class filename="a"><lines><line number="1" hits="1" branch="true"><conditions><condition number="0" type="jump" coverage="${a}%"/><condition number="1" type="jump" coverage="${b}%"/></conditions></line></lines></class></classes></package></packages></coverage>`
    const c = compareCoverage(parseCoverage(cond(100, 100), "cobertura"), parseCoverage(cond(100, 50), "cobertura"))
    expect(c.branches?.baseline).toEqual({ covered: 2, total: 2, percent: 100 })
    expect(c.branches?.candidate).toEqual({ covered: 1.5, total: 2, percent: 75 })
    expect(c.lost[0]).toMatchObject({ file: "a", lostBranchCount: 0.5 })
  })
  test("count-only and detailed Cobertura lines compare by covered/total", () => {
    const detailed = (a: number, b: number) =>
      `<coverage><packages><package><classes><class filename="m.py"><lines><line number="2" hits="1" branch="true"><conditions><condition number="0" coverage="${a}%"/><condition number="1" coverage="${b}%"/></conditions></line></lines></class></classes></package></packages></coverage>`
    const countOnly = (cov: string) => COB(1, cov)
    const same = compareCoverage(parseCoverage(countOnly("100% (2/2)"), undefined), parseCoverage(detailed(100, 100), undefined))
    expect(same.lost.flatMap((f) => f.branches)).toEqual([])
    const reverse = compareCoverage(parseCoverage(detailed(100, 100), undefined), parseCoverage(countOnly("100% (2/2)"), undefined))
    expect(reverse.lost.flatMap((f) => f.branches)).toEqual([])
    const drop = compareCoverage(parseCoverage(countOnly("100% (2/2)"), undefined), parseCoverage(detailed(100, 0), undefined))
    expect(drop.lost.flatMap((f) => f.branches)).toEqual(["2 (2/2 -> 1/2)"])
  })
  test("branches are not reported lost when either report has no branch data", () => {
    const withBranches = parseCoverage(LCOV_A, undefined)
    const without = parseCoverage("SF:src/a.ts\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nend_of_record\n", undefined)
    for (const c of [compareCoverage(withBranches, without), compareCoverage(without, withBranches)]) {
      expect(c.branches).toBeNull()
      for (const f of c.lost) expect(f.branches).toEqual([])
      for (const f of c.lost) expect(f.lostBranchCount).toBe(0)
      expect(formatCoverage(c)).toContain("branches: not measured")
    }
  })
  test("truncated Cobertura XML is rejected", () => {
    expect(() => parseCoverage(COB(1, "50% (1/2)").slice(0, -25), "cobertura")).toThrow(/invalid Cobertura XML/)
  })
  test("Cobertura conditions elements", () => {
    const xml = `<coverage><packages><package><classes><class filename="a"><lines><line number="1" hits="1" branch="true"><conditions><condition number="0" type="jump" coverage="100%"/><condition number="1" type="jump" coverage="0%"/></conditions></line></lines></class></classes></package></packages></coverage>`
    const r = parseCoverage(xml, "cobertura")
    expect([...(r.files.get("a")?.branches ?? [])]).toEqual([[1, { covered: 1, total: 2 }]])
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
    const root = outsideScratch()
    const outside = outsideScratch()
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
      writeFileSync(join(root, "bad.xml"), COB(1, "50% (1/2)").slice(0, -30))
      writeFileSync(join(root, "good.xml"), COB(1, "50% (1/2)"))
      const truncated = compareReports(root, { kind: "coverage", baseline: "good.xml", candidate: "bad.xml" })
      expect(truncated.content).toContain("invalid")
      expect(truncated.metadata.error).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>
const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }

describe("plugin wiring", () => {
  test("registers both read-only tools and no hooks, and disposes them", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    expect([...fake.tools.keys()]).toEqual(["quality_test_summarize", "quality_test_compare"])
    expect(fake.hooks("permission")).toEqual([])
    for (const tool of fake.tools.values()) {
      expect((tool.description as string).split("\n")[0]?.length).toBeLessThanOrEqual(120)
      expect(JSON.stringify(tool.input).length).toBeLessThan(3000)
      expect((tool as { codemode?: boolean }).codemode).toBeUndefined()
    }
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
  })

  test("testAudit: false registers neither tool", async () => {
    const fake = createFakeContext({ options: { testAudit: false } })
    const cleanup = await plugin.setup(fake.context)
    expect(fake.tools.has("quality_test_summarize")).toBe(false)
    expect(fake.tools.has("quality_test_compare")).toBe(false)
    expect(parseTestAuditOptions({ testAudit: false })).toBeUndefined()
    expect(parseTestAuditOptions({})).toEqual({ enabled: true })
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("both tools need no permission", async () => {
    const dir = outsideScratch()
    try {
      writeFileSync(join(dir, "a"), LCOV_A)
      writeFileSync(join(dir, "r.xml"), PYTEST)
      const fake = createFakeContext({ directory: dir })
      await plugin.setup(fake.context)
      const context = { ...call, signal: new AbortController().signal }
      const compare = fake.tools.get("quality_test_compare")?.execute as Execute
      expect((await compare({ kind: "coverage", baseline: "a", candidate: "a" }, context)).content).toContain("coverage: lines")
      const summarize = fake.tools.get("quality_test_summarize")?.execute as Execute
      const result = await summarize({ reports: ["r.xml", "r.xml"], exitCodes: [1, 1] }, context)
      expect(result.content).toContain("failed in every report")
      expect(fake.asserts).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
