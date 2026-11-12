import { XMLParser, XMLValidator } from "fast-xml-parser"

export type CaseStatus = "passed" | "failed" | "error" | "skipped"

export type TestCase = {
  /** Stable across runs: file (when the report has one), classname and name. */
  id: string
  status: CaseStatus
  /** Seconds. */
  time: number
  /** Retries inside the run that the report records (cargo-nextest `flakyFailure`/`flakyError`). */
  retries: number
}

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
      out.push({
        id: file ? `${file} :: ${label}` : label,
        status: caseStatus(tc),
        time: Number.isFinite(time) ? time : 0,
        retries: count(tc.flakyFailure) + count(tc.flakyError),
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
  const valid = XMLValidator.validate(xml)
  if (valid !== true) throw new Error(`invalid XML: ${valid.err.msg} (line ${valid.err.line})`)
  const doc = parser.parse(xml) as Node
  if (!("testsuites" in doc) && !("testsuite" in doc)) throw new Error("not a JUnit report: no testsuite element")
  const out: TestCase[] = []
  collect(doc, out)
  return out
}
