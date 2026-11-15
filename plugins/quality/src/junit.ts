import { XMLParser, XMLValidator } from "fast-xml-parser"

export type CaseStatus = "passed" | "failed" | "error" | "skipped"

/** `timeout` when the failure message or type names a timeout; `other` for an assertion or any other error. */
export type FailureKind = "timeout" | "other"

export type TestCase = {
  /** Stable across runs: file (when the report has one), classname and name. */
  id: string
  status: CaseStatus
  /** Seconds. */
  time: number
  /** Retries inside the run that the report records (cargo-nextest `flakyFailure`/`flakyError`). */
  retries: number
  /** Set for `failed` and `error` cases. */
  failureKind?: FailureKind
}

/** A parsed report: its cases and the number of non-empty lines inside `system-err` elements. */
export type JunitReport = { cases: TestCase[]; stderrLines: number }

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "testcase",
})

type Node = Record<string, unknown>

const isNode = (value: unknown): value is Node => value !== null && typeof value === "object" && !Array.isArray(value)

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : value === undefined ? 0 : 1
}

function caseStatus(node: Node): CaseStatus {
  if ("failure" in node || "rerunFailure" in node) return "failed"
  if ("error" in node || "rerunError" in node) return "error"
  if ("skipped" in node) return "skipped"
  return "passed"
}

const TIMEOUT = /time(?:d)?[\s-]?out/i
const FAILURE_KEYS = ["failure", "error", "rerunFailure", "rerunError"] as const

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textOf).join(" ")
  if (!isNode(value)) return ""
  return [value["@_message"], value["@_type"], value["#text"]].map((v) => (typeof v === "string" ? v : "")).join(" ")
}

/**
 * Heuristic: a failure is a timeout when its message, type or the start of its body matches
 * "timeout", "timed out" or "time-out" (case-insensitive). Everything else is `other`.
 */
export function classifyFailure(node: Node): FailureKind {
  const text = FAILURE_KEYS.map((key) => textOf(node[key])).join(" ").slice(0, 2000)
  return TIMEOUT.test(text) ? "timeout" : "other"
}

function collect(node: unknown, out: TestCase[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return
  }
  if (!isNode(node)) return
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue
    if (key !== "testcase") {
      collect(value, out)
      continue
    }
    for (const raw of value as unknown[]) {
      const tc = isNode(raw) ? raw : {}
      const name = String(tc["@_name"] ?? "")
      const classname = String(tc["@_classname"] ?? "")
      const file = tc["@_file"] === undefined ? "" : String(tc["@_file"])
      const label = [classname, name].filter(Boolean).join(" :: ")
      const time = Number.parseFloat(String(tc["@_time"] ?? "0"))
      const status = caseStatus(tc)
      out.push({
        id: file ? `${file} :: ${label}` : label,
        status,
        time: Number.isFinite(time) ? time : 0,
        retries: count(tc.flakyFailure) + count(tc.flakyError),
        ...(status === "failed" || status === "error" ? { failureKind: classifyFailure(tc) } : {}),
      })
    }
  }
}

/**
 * Test cases of a JUnit XML report, in document order. Handles the nesting the supported writers
 * produce: pytest `--junitxml`, Vitest, `bun test --reporter=junit` (nested suites), gotestsum
 * `--junitfile` and cargo-nextest. Throws on input that is not XML with a `testsuite(s)` root.
 */
export function parseJunit(xml: string): TestCase[] {
  return parseJunitReport(xml).cases
}

const STDERR = /<system-err\b[^>]*>([\s\S]*?)<\/system-err>/g

/** Non-empty lines inside `system-err` elements, CDATA wrappers removed. */
function countStderrLines(xml: string): number {
  let lines = 0
  for (const match of xml.matchAll(STDERR)) {
    const body = (match[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "")
    lines += body.split("\n").filter((line) => line.trim() !== "").length
  }
  return lines
}

/** Like `parseJunit`, and also counts the stderr lines the report carries. */
export function parseJunitReport(xml: string): JunitReport {
  const valid = XMLValidator.validate(xml)
  if (valid !== true) throw new Error(`invalid XML: ${valid.err.msg} (line ${valid.err.line})`)
  const doc = parser.parse(xml) as Node
  if (!("testsuites" in doc) && !("testsuite" in doc)) throw new Error("not a JUnit report: no testsuite element")
  const out: TestCase[] = []
  collect(doc, out)
  return { cases: out, stderrLines: countStderrLines(xml) }
}
