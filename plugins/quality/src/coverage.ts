import { XMLParser } from "fast-xml-parser"
import { capText, compactRanges, percent } from "./audit-util.ts"

export type CoverageFormat = "lcov" | "cobertura" | "gocover"

/** Per file: line number to covered, branch key to covered. */
export type FileCoverage = { lines: Map<number, boolean>; branches: Map<string, boolean> }

export type CoverageReport = {
  format: CoverageFormat
  files: Map<string, FileCoverage>
  /** False when the report carries no branch data at all (bun LCOV, Go profiles): branches were not measured. */
  hasBranches: boolean
}

const normalizePath = (path: string, root?: string): string => {
  let p = path.trim().replaceAll("\\", "/")
  if (root !== undefined) {
    const prefix = `${root.replaceAll("\\", "/").replace(/\/+$/, "")}/`
    if (p.startsWith(prefix)) p = p.slice(prefix.length)
  }
  return p.replace(/^(\.\/)+/, "")
}

function file(report: Map<string, FileCoverage>, path: string): FileCoverage {
  let entry = report.get(path)
  if (entry === undefined) {
    entry = { lines: new Map(), branches: new Map() }
    report.set(path, entry)
  }
  return entry
}

/** Mark covered with OR semantics: a second record for the same line or branch can only add coverage. */
function mark<K>(map: Map<K, boolean>, key: K, covered: boolean): void {
  map.set(key, (map.get(key) ?? false) || covered)
}

export function detectCoverageFormat(text: string): CoverageFormat | undefined {
  const head = text.trimStart()
  if (head.startsWith("mode:")) return "gocover"
  if (head.startsWith("<")) return "cobertura"
  if (/^SF:/m.test(head)) return "lcov"
  return undefined
}

/** LCOV tracefile: `SF`, `DA:line,hits`, `BRDA:line,block,branch,taken|-`. */
export function parseLcov(text: string, root?: string): CoverageReport {
  const files = new Map<string, FileCoverage>()
  let current: FileCoverage | undefined
  let hasBranches = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith("SF:")) current = file(files, normalizePath(line.slice(3), root))
    else if (line === "end_of_record") current = undefined
    else if (current !== undefined && line.startsWith("DA:")) {
      const [no, hits] = line.slice(3).split(",")
      const n = Number(no)
      if (Number.isInteger(n)) mark(current.lines, n, Number(hits) > 0)
    } else if (current !== undefined && line.startsWith("BRDA:")) {
      const [no, block, branch, taken] = line.slice(5).split(",")
      hasBranches = true
      mark(current.branches, `${no},${block},${branch}`, taken !== "-" && Number(taken) > 0)
    }
  }
  return { format: "lcov", files, hasBranches }
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ["package", "class", "line", "condition"].includes(name),
})

type Node = Record<string, unknown>
const asNodes = (value: unknown): Node[] => (Array.isArray(value) ? value.filter((v) => typeof v === "object" && v !== null) : []) as Node[]

/** Cobertura XML: `class@filename`, `line@number/hits`, `condition-coverage="50% (1/2)"` or `conditions`. */
export function parseCobertura(text: string, root?: string): CoverageReport {
  const doc = xml.parse(text) as { coverage?: Node }
  if (doc.coverage === undefined || typeof doc.coverage !== "object") throw new Error("not a Cobertura report: no coverage element")
  const files = new Map<string, FileCoverage>()
  let hasBranches = false
  const packages = asNodes((doc.coverage.packages as Node | undefined)?.package)
  for (const pkg of packages) {
    for (const cls of asNodes((pkg.classes as Node | undefined)?.class)) {
      const name = String(cls["@_filename"] ?? "")
      if (!name) continue
      const entry = file(files, normalizePath(name, root))
      for (const line of asNodes((cls.lines as Node | undefined)?.line)) {
        const n = Number(line["@_number"])
        if (!Number.isInteger(n)) continue
        mark(entry.lines, n, Number(line["@_hits"]) > 0)
        const conditions = asNodes((line.conditions as Node | undefined)?.condition)
        if (conditions.length > 0) {
          hasBranches = true
          for (const [i, c] of conditions.entries())
            mark(entry.branches, `${n}:${c["@_number"] ?? i}`, parseInt(String(c["@_coverage"] ?? "0"), 10) > 0)
          continue
        }
        const summary = /\((\d+)\/(\d+)\)/.exec(String(line["@_condition-coverage"] ?? ""))
        if (summary !== null) {
          // Only counts are given, so branches are positional: the first `covered` slots count as taken.
          hasBranches = true
          const covered = Number(summary[1])
          for (let i = 0; i < Number(summary[2]); i++) mark(entry.branches, `${n}:${i}`, i < covered)
        }
      }
    }
  }
  return { format: "cobertura", files, hasBranches }
}

/** Go cover profile: `mode:` header then `file:l.c,l.c statements count`; lines only, no branches. */
export function parseGoCover(text: string, root?: string): CoverageReport {
  const files = new Map<string, FileCoverage>()
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(raw.trim())
    if (m === null) continue
    const entry = file(files, normalizePath(m[1] as string, root))
    for (let n = Number(m[2]); n <= Number(m[3]); n++) mark(entry.lines, n, Number(m[4]) > 0)
  }
  return { format: "gocover", files, hasBranches: false }
}

export function parseCoverage(text: string, format: CoverageFormat | undefined, root?: string): CoverageReport {
  const kind = format ?? detectCoverageFormat(text)
  if (kind === undefined) throw new Error("cannot detect the coverage format; pass format: lcov, cobertura or gocover")
  if (kind === "lcov") return parseLcov(text, root)
  if (kind === "cobertura") return parseCobertura(text, root)
  return parseGoCover(text, root)
}

export type Totals = { covered: number; total: number; percent: number }

export type FileLoss = { file: string; lines: number[]; branches: string[]; lostLineCount: number; lostBranchCount: number }

export type CoverageComparison = {
  kind: "coverage"
  baselineFormat: CoverageFormat
  candidateFormat: CoverageFormat
  lines: { baseline: Totals; candidate: Totals }
  /** Null when either report has no branch data: branches were not measured. */
  branches: { baseline: Totals; candidate: Totals } | null
  lost: FileLoss[]
  disappeared: Array<{ file: string; coveredLines: number }>
  gained: number
}

function totals(report: CoverageReport, pick: (f: FileCoverage) => Map<unknown, boolean>): Totals {
  let covered = 0
  let total = 0
  for (const f of report.files.values())
    for (const hit of pick(f).values()) {
      total++
      if (hit) covered++
    }
  return { covered, total, percent: percent(covered, total) }
}

/** What the baseline covered and the candidate does not, per file; files missing from the candidate listed apart. */
export function compareCoverage(baseline: CoverageReport, candidate: CoverageReport): CoverageComparison {
  const lost: FileLoss[] = []
  const disappeared: CoverageComparison["disappeared"] = []
  let gained = 0
  for (const [name, base] of baseline.files) {
    const cand = candidate.files.get(name)
    const baseLines = [...base.lines].filter(([, hit]) => hit).map(([n]) => n)
    if (cand === undefined) {
      if (baseLines.length > 0 || [...base.branches.values()].some(Boolean)) disappeared.push({ file: name, coveredLines: baseLines.length })
      continue
    }
    const lines = baseLines.filter((n) => cand.lines.get(n) !== true).sort((a, b) => a - b)
    const branches = [...base.branches].filter(([k, hit]) => hit && cand.branches.get(k) !== true).map(([k]) => k)
    if (lines.length > 0 || branches.length > 0)
      lost.push({ file: name, lines, branches, lostLineCount: lines.length, lostBranchCount: branches.length })
  }
  for (const [name, cand] of candidate.files) {
    const base = baseline.files.get(name)
    for (const [n, hit] of cand.lines) if (hit && base?.lines.get(n) !== true) gained++
  }
  const bothBranches = baseline.hasBranches && candidate.hasBranches
  return {
    kind: "coverage",
    baselineFormat: baseline.format,
    candidateFormat: candidate.format,
    lines: { baseline: totals(baseline, (f) => f.lines), candidate: totals(candidate, (f) => f.lines) },
    branches: bothBranches
      ? { baseline: totals(baseline, (f) => f.branches), candidate: totals(candidate, (f) => f.branches) }
      : null,
    lost: lost.sort((a, b) => b.lostLineCount + b.lostBranchCount - (a.lostLineCount + a.lostBranchCount) || a.file.localeCompare(b.file)),
    disappeared: disappeared.sort((a, b) => a.file.localeCompare(b.file)),
    gained,
  }
}

const fmt = (t: Totals): string => `${t.percent}% (${t.covered}/${t.total})`

export function formatCoverage(c: CoverageComparison, maxFiles = 15): string {
  const lines = [
    `coverage: lines ${fmt(c.lines.baseline)} -> ${fmt(c.lines.candidate)}`,
    c.branches
      ? `branches ${fmt(c.branches.baseline)} -> ${fmt(c.branches.candidate)}`
      : "branches: not measured (a report has no branch data)",
  ]
  const nothing = c.lost.length === 0 && c.disappeared.length === 0
  lines.push(nothing ? "no baseline-covered line or branch is uncovered in the candidate" : "LOST COVERAGE (covered in baseline, not in candidate):")
  for (const f of c.lost.slice(0, maxFiles)) {
    const parts = [] as string[]
    if (f.lines.length > 0) parts.push(`lines ${compactRanges(f.lines)}`)
    if (f.branches.length > 0) parts.push(`${f.branches.length} branch(es) ${f.branches.slice(0, 6).join(" ")}${f.branches.length > 6 ? " ..." : ""}`)
    lines.push(`  ${f.file}: ${parts.join("; ")}`)
  }
  if (c.lost.length > maxFiles) lines.push(`  ... +${c.lost.length - maxFiles} more files`)
  if (c.disappeared.length > 0) {
    lines.push(`files missing from the candidate (${c.disappeared.length}):`)
    for (const d of c.disappeared.slice(0, maxFiles)) lines.push(`  ${d.file} (${d.coveredLines} covered lines in baseline)`)
    if (c.disappeared.length > maxFiles) lines.push(`  ... +${c.disappeared.length - maxFiles} more`)
  }
  if (c.gained > 0) lines.push(`lines newly covered in the candidate: ${c.gained}`)
  return capText(lines)
}
