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
/** Only this many characters of each failure body are read; the message and type are read whole. */
const BODY_LIMIT = 2000

const str = (value: unknown): string => (typeof value === "string" ? value : "")

/** Text of an element: a plain string, or the `#text` of one that has attributes. */
function elementText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(elementText).join("\n")
  return isNode(value) ? str(value["#text"]) : ""
}

/**
 * Heuristic: a failure is a timeout when the message or type of any one failure element, or the
 * start of its body, matches "timeout", "timed out" or "time-out" (case-insensitive). Each element
 * is read on its own, so a long body cannot hide the metadata of a later `rerunFailure`.
 * Everything else is `other`.
 */
export function classifyFailure(node: Node): FailureKind {
  for (const key of FAILURE_KEYS) {
    const value = node[key]
    for (const item of Array.isArray(value) ? value : [value]) {
      const fields = isNode(item)
        ? [str(item["@_message"]), str(item["@_type"]), str(item["#text"]).slice(0, BODY_LIMIT)]
        : [str(item).slice(0, BODY_LIMIT)]
      if (fields.some((field) => TIMEOUT.test(field))) return "timeout"
    }
  }
  return "other"
}

/** Non-empty lines of the `system-err` element(s) under `value`. */
function stderrLines(value: unknown): number {
  return elementText(value)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "").length
}

/** Stderr lines of every `system-err` under `node`, at any depth, each counted once. */
function nestedStderrLines(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((sum, item) => sum + nestedStderrLines(item), 0)
  if (!isNode(node)) return 0
  let lines = 0
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue
    lines += key === "system-err" ? stderrLines(value) : nestedStderrLines(value)
  }
  return lines
}

type Collected = { cases: TestCase[]; stderrLines: number }

function collect(node: unknown, out: Collected): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return
  }
  if (!isNode(node)) return
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue
    if (key === "system-err") {
      out.stderrLines += stderrLines(value)
      continue
    }
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
      out.stderrLines += nestedStderrLines(tc)
      out.cases.push({
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

/** Like `parseJunit`, and also counts the stderr lines the report carries. */
export function parseJunitReport(xml: string): JunitReport {
  const valid = XMLValidator.validate(xml)
  if (valid !== true) throw new Error(`invalid XML: ${valid.err.msg} (line ${valid.err.line})`)
  const doc = parser.parse(xml) as Node
  if (!("testsuites" in doc) && !("testsuite" in doc)) throw new Error("not a JUnit report: no testsuite element")
  const out: Collected = { cases: [], stderrLines: 0 }
  collect(doc, out)
  return out
}
