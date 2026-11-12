import { capText, percent } from "./audit-util.ts"

export type MutationFormat = "mutation-testing" | "cargo-mutants" | "gremlins"

/** detected: killed or timed out. Survived and nocoverage count against the score. Ignored is neither. */
export type MutantClass = "detected" | "survived" | "nocoverage" | "ignored"

export type Mutant = {
  key: string
  file: string
  mutator: string
  location: string
  replacement: string
  status: string
  class: MutantClass
}

export type MutationReport = { format: MutationFormat; mutants: Map<string, Mutant> }

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v)

export function detectMutationFormat(data: unknown): MutationFormat | undefined {
  if (!isObj(data)) return undefined
  if (isObj(data.files) && "schemaVersion" in data) return "mutation-testing"
  if (Array.isArray(data.outcomes)) return "cargo-mutants"
  if (Array.isArray(data.files) && "go_module" in data) return "gremlins"
  return undefined
}

/** Keep the first mutant per key and number the rest, so reports with repeated spots still pair up. */
function add(into: Map<string, Mutant>, mutant: Omit<Mutant, "key">): void {
  const base = `${mutant.file}|${mutant.mutator}|${mutant.location}|${mutant.replacement}`
  let key = base
  for (let n = 2; into.has(key); n++) key = `${base}#${n}`
  into.set(key, { ...mutant, key })
}

const STRYKER: Record<string, MutantClass> = {
  Killed: "detected",
  Timeout: "detected",
  Survived: "survived",
  NoCoverage: "nocoverage",
}

const pos = (p: unknown): string => (isObj(p) ? `${p.line}:${p.column}` : "?")
const span = (loc: unknown): string => (isObj(loc) ? `${pos(loc.start)}-${pos(loc.end)}` : "?")

/** mutation-testing-report-schema (Stryker JS, Stryker.NET, Stryker4s and others). */
export function parseMutationTesting(data: Json): MutationReport {
  const mutants = new Map<string, Mutant>()
  for (const [name, entry] of Object.entries(isObj(data.files) ? data.files : {})) {
    if (!isObj(entry) || !Array.isArray(entry.mutants)) continue
    for (const m of entry.mutants) {
      if (!isObj(m)) continue
      const status = String(m.status ?? "")
      add(mutants, {
        file: name.replaceAll("\\", "/"),
        mutator: String(m.mutatorName ?? ""),
        location: span(m.location),
        replacement: typeof m.replacement === "string" ? m.replacement : "",
        status,
        class: STRYKER[status] ?? "ignored",
      })
    }
  }
  return { format: "mutation-testing", mutants }
}

const CARGO: Record<string, MutantClass> = { CaughtMutant: "detected", Timeout: "detected", MissedMutant: "survived" }

/** cargo-mutants `mutants.out/outcomes.json`; the baseline scenario is not a mutant. */
export function parseCargoMutants(data: Json): MutationReport {
  const mutants = new Map<string, Mutant>()
  for (const outcome of Array.isArray(data.outcomes) ? data.outcomes : []) {
    if (!isObj(outcome) || !isObj(outcome.scenario) || !isObj(outcome.scenario.Mutant)) continue
    const m = outcome.scenario.Mutant
    const status = String(outcome.summary ?? "")
    add(mutants, {
      file: String(m.file ?? "").replaceAll("\\", "/"),
      mutator: String(m.genre ?? ""),
      location: span(m.span),
      replacement: String(m.replacement ?? ""),
      status,
      class: CARGO[status] ?? "ignored",
    })
  }
  return { format: "cargo-mutants", mutants }
}

const GREMLINS: Record<string, MutantClass> = {
  KILLED: "detected",
  "TIMED OUT": "detected",
  LIVED: "survived",
  "NOT COVERED": "nocoverage",
}

/** Gremlins `--output` JSON: per file, mutations with type, line and column (no replacement text). */
export function parseGremlins(data: Json): MutationReport {
  const mutants = new Map<string, Mutant>()
  for (const f of Array.isArray(data.files) ? data.files : []) {
    if (!isObj(f) || !Array.isArray(f.mutations)) continue
    for (const m of f.mutations) {
      if (!isObj(m)) continue
      const status = String(m.status ?? "")
      add(mutants, {
        file: String(f.file_name ?? "").replaceAll("\\", "/"),
        mutator: String(m.type ?? ""),
        location: `${m.line}:${m.column}`,
        replacement: "",
        status,
        class: GREMLINS[status] ?? "ignored",
      })
    }
  }
  return { format: "gremlins", mutants }
}

export function parseMutation(text: string, format: MutationFormat | undefined): MutationReport {
  const data: unknown = JSON.parse(text)
  const kind = format ?? detectMutationFormat(data)
  if (kind === undefined || !isObj(data))
    throw new Error("cannot detect the mutation format; pass format: mutation-testing, cargo-mutants or gremlins")
  if (kind === "mutation-testing") return parseMutationTesting(data)
  if (kind === "cargo-mutants") return parseCargoMutants(data)
  return parseGremlins(data)
}

export type Score = { detected: number; survived: number; nocoverage: number; ignored: number; score: number }

export function scoreOf(report: MutationReport): Score {
  const s = { detected: 0, survived: 0, nocoverage: 0, ignored: 0, score: 0 }
  for (const m of report.mutants.values()) s[m.class]++
  s.score = percent(s.detected, s.detected + s.survived + s.nocoverage)
  return s
}

export type MutantRef = { key: string; file: string; mutator: string; location: string; replacement: string; was: string; now: string }

export type MutationComparison = {
  kind: "mutation"
  baselineFormat: MutationFormat
  candidateFormat: MutationFormat
  baseline: Score
  candidate: Score
  lostProtection: MutantRef[]
  newlyKilled: MutantRef[]
  onlyInBaseline: MutantRef[]
  onlyInCandidate: MutantRef[]
}

const ref = (m: Mutant, other?: Mutant): MutantRef => ({
  key: m.key,
  file: m.file,
  mutator: m.mutator,
  location: m.location,
  replacement: m.replacement,
  was: m.status,
  now: other?.status ?? "absent",
})

const undetected = (c: MutantClass): boolean => c === "survived" || c === "nocoverage"

/** Pair mutants by file, mutator, location and replacement; the lost-protection list is the key result. */
export function compareMutation(baseline: MutationReport, candidate: MutationReport): MutationComparison {
  const lostProtection: MutantRef[] = []
  const newlyKilled: MutantRef[] = []
  const onlyInBaseline: MutantRef[] = []
  const onlyInCandidate: MutantRef[] = []
  for (const [key, base] of baseline.mutants) {
    const cand = candidate.mutants.get(key)
    if (cand === undefined) onlyInBaseline.push(ref(base))
    else if (base.class === "detected" && undetected(cand.class)) lostProtection.push(ref(base, cand))
    else if (undetected(base.class) && cand.class === "detected") newlyKilled.push({ ...ref(base, cand) })
  }
  for (const [key, cand] of candidate.mutants) if (!baseline.mutants.has(key)) onlyInCandidate.push(ref(cand))
  return {
    kind: "mutation",
    baselineFormat: baseline.format,
    candidateFormat: candidate.format,
    baseline: scoreOf(baseline),
    candidate: scoreOf(candidate),
    lostProtection,
    newlyKilled,
    onlyInBaseline,
    onlyInCandidate,
  }
}

const describe = (r: MutantRef): string =>
  `${r.file}:${r.location.split("-")[0]} ${r.mutator}${r.replacement ? ` -> ${r.replacement.replace(/\s+/g, " ").slice(0, 40)}` : ""}`

function section(title: string, refs: readonly MutantRef[], limit: number, show: (r: MutantRef) => string): string[] {
  if (refs.length === 0) return []
  const out = [`${title} (${refs.length}):`, ...refs.slice(0, limit).map((r) => `  ${show(r)}`)]
  if (refs.length > limit) out.push(`  ... +${refs.length - limit} more`)
  return out
}

const fmtScore = (s: Score): string => `${s.score}% (${s.detected} detected, ${s.survived} survived, ${s.nocoverage} no coverage, ${s.ignored} ignored)`

export function formatMutation(c: MutationComparison): string {
  const lines = [`mutation score: ${fmtScore(c.baseline)} -> ${fmtScore(c.candidate)}`]
  lines.push(
    ...section("LOST PROTECTION (detected in baseline, survived or uncovered in candidate)", c.lostProtection, 25, (r) => `${describe(r)}  [${r.was} -> ${r.now}]`),
  )
  if (c.lostProtection.length === 0) lines.push("lost protection: none")
  lines.push(
    ...section("newly killed", c.newlyKilled, 8, describe),
    ...section("only in baseline (candidate has no such mutant)", c.onlyInBaseline, 8, (r) => `${describe(r)}  [${r.was}]`),
    ...section("only in candidate", c.onlyInCandidate, 8, (r) => `${describe(r)}  [${r.was}]`),
  )
  return capText(lines)
}
