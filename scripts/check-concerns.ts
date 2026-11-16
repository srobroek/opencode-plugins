#!/usr/bin/env bun
/**
 * Check the toolchain concerns framework. The spec
 * (`plugins/toolchain/skills/toolchain-languages/references/concerns.md`) defines the concerns,
 * language kinds, run tokens and the language registry. Each registered language lists files whose
 * `## Concerns` tables must together cover every concern that applies to its kind, in spec order,
 * with well-formed Default, Maintenance, Alternatives and Run cells.
 *
 *   bun scripts/check-concerns.ts [--language <id>] [--max-age <days>]
 *
 * `--max-age` prints rows whose release date is older than N days; it never fails the run.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

export type Finding = { file: string; line: number; reason: string }
export type Row = { line: number; cells: string[] }
export type Table = { line: number; header: string[]; rows: Row[] }

export type Concern = {
  id: string
  name: string
  group: string
  naAllowed: string[]
  runMust: string[]
  line: number
}
export type Language = { id: string; kind: string; skill: string; files: string[]; line: number }
/** A product surface; `naAllowed` lists the surface concern ids that may be N/A for it. */
export type Surface = { id: string; name: string; naAllowed: string[]; line: number }
export type Spec = {
  concerns: Concern[]
  kinds: string[]
  tokens: string[]
  languages: Language[]
  surfaceConcerns: Concern[]
  surfaces: Surface[]
  /** Repo-relative path of the surfaces file, from the `Surfaces file:` line; empty when absent. */
  surfacesFile: string
}
/** Shared tool id to the concern ids it covers. */
export type Shared = Map<string, string[]>
/** Read access to the repository tree, by absolute path. Tests pass an in-memory tree. */
export type Files = {
  exists(file: string): boolean
  read(file: string): string
  /** Names of the entries (files and directories) directly inside `dir`. */
  entries(dir: string): string[]
}
export const diskFiles: Files = {
  exists: (file) => existsSync(file),
  read: (file) => readFileSync(file, "utf8"),
  entries: (dir) => [...new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false })],
}
export type Context = { root: string; spec: Spec; shared: Shared; today: string; files: Files }

export type DefaultKind =
  | { type: "tool"; tool: string }
  | { type: "builtin" | "na" | "none" }
  | { type: "shared" | "inherits"; id: string }
  | { type: "unknown" }

export const SPEC_FILE = "plugins/toolchain/skills/toolchain-languages/references/concerns.md"
export const SHARED_FILE = "plugins/toolchain/skills/toolchain-languages/references/shared-tools.md"
export const GROUPS = ["testing", "quality", "iac"]
export const STATUSES = ["active", "maintenance", "beta", "pre-1.0", "preview"]
export const LANGUAGE_HEADER = ["Concern", "Default", "Maintenance", "Install", "Alternatives", "Use both when", "Run", "Avoid"]

const CONCERN_HEADER = ["Id", "Name", "Group", "Definition", "N/A allowed for", "Run must include"]
const SURFACE_HEADER = ["Surface", "Id", "N/A allowed for"]
const KIND_HEADER = ["Kind", "Meaning"]
const LANGUAGE_REGISTRY_HEADER = ["Language", "Id", "Kind", "Skill", "Files"]
const TOKEN_HEADER = ["Token", "Meaning"]
const SHARED_HEADER = ["Id", "Tool", "Concerns", "Maintenance", "Run", "Use with"]
const DAY_MS = 86_400_000

const unticked = (cell: string) => cell.replace(/`/g, "").trim()
const list = (cell: string, separator: RegExp) =>
  unticked(cell)
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean)
const isDate = (s: string) => {
  const time = Date.parse(`${s}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(time) && new Date(time).toISOString().startsWith(s)
}

/** Split one markdown table line into trimmed cells; `\|` stays in the cell as `|` (GFM). */
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "")
  const cells: string[] = []
  let cell = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "\\" && body[i + 1] === "|") {
      cell += "|"
      i++
    } else if (ch === "|") {
      cells.push(cell.trim())
      cell = ""
    } else cell += ch
  }
  // a trailing pipe closes the last cell; text after the last pipe is a cell of its own
  if (cell.trim() !== "" || !/\|$/.test(line.trim()) || cells.length === 0) cells.push(cell.trim())
  return cells
}

/** The first table under the `## <heading>` section, or undefined when the section or table is absent. */
export function parseTable(text: string, heading: string): Table | undefined {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (start < 0) return undefined
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end < 0) end = lines.length
  const first = lines.findIndex((l, i) => i > start && i < end && l.trimStart().startsWith("|"))
  if (first < 0) return undefined
  const block: Row[] = []
  for (let i = first; i < end && lines[i]?.trimStart().startsWith("|"); i++)
    block.push({ line: i + 1, cells: splitRow(lines[i] ?? "") })
  const [head, separator, ...rows] = block
  if (!head || !separator) return undefined
  if (separator.cells.length !== head.cells.length || !separator.cells.every((c) => /^:?-+:?$/.test(c))) return undefined
  return { line: head.line, header: head.cells, rows }
}

const sameHeader = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => c === b[i])

/** A table that must exist with an exact header; problems go to `out`. */
function requireTable(text: string, heading: string, header: string[], file: string, out: Finding[]): Table | undefined {
  const table = parseTable(text, heading)
  if (!table) out.push({ file, line: 1, reason: `no table under "## ${heading}"` })
  else if (!sameHeader(table.header, header))
    out.push({ file, line: table.line, reason: `"## ${heading}" header must be | ${header.join(" | ")} |` })
  else return table
  return undefined
}

function dataRows(table: Table | undefined, file: string, out: Finding[]): Row[] {
  return (table?.rows ?? []).filter((row) => {
    const ok = row.cells.length === table?.header.length
    if (!ok) out.push({ file, line: row.line, reason: `expected ${table?.header.length} cells, found ${row.cells.length}` })
    return ok
  })
}

/** Parse the spec file; malformed content becomes findings. */
export function parseSpec(text: string, file = SPEC_FILE): { spec: Spec; findings: Finding[] } {
  const findings: Finding[] = []
  const bad = (line: number, reason: string) => findings.push({ file, line, reason })
  const unique = (seen: Set<string>, id: string, line: number, what: string) => {
    if (seen.has(id)) bad(line, `duplicate ${what} "${id}"`)
    seen.add(id)
  }

  const kinds: string[] = []
  const kindSeen = new Set<string>()
  for (const r of dataRows(requireTable(text, "Kinds", KIND_HEADER, file, findings), file, findings)) {
    const id = unticked(r.cells[0] ?? "")
    unique(kindSeen, id, r.line, "kind")
    kinds.push(id)
  }
  const tokens: string[] = []
  const tokenSeen = new Set<string>()
  for (const r of dataRows(requireTable(text, "Run tokens", TOKEN_HEADER, file, findings), file, findings)) {
    const id = unticked(r.cells[0] ?? "")
    unique(tokenSeen, id, r.line, "run token")
    tokens.push(id)
  }

  const concernSeen = new Set<string>()
  /** Concern rows under `## <heading>`. Surface concerns never use N/A kinds: a surface's N/A lives in `## Surfaces`. */
  const readConcerns = (heading: string, groups: string[], surface: boolean): Concern[] => {
    const out: Concern[] = []
    for (const r of dataRows(requireTable(text, heading, CONCERN_HEADER, file, findings), file, findings)) {
      const [id = "", name = "", group = "", , na = "", must = ""] = r.cells.map(unticked)
      unique(concernSeen, id, r.line, "concern id")
      if (!groups.includes(group)) bad(r.line, `unknown group "${group}"`)
      const naAllowed = na === "none" ? [] : list(na, /\s*,\s*/)
      if (surface) {
        if (na !== "none") bad(r.line, `surface concern "${id}" must have N/A allowed for "none"; list N/A in ## Surfaces`)
      } else for (const k of naAllowed) if (!kinds.includes(k)) bad(r.line, `unknown kind "${k}" in N/A allowed for`)
      const runMust = must === "-" ? [] : list(must, /\s*\+\s*/)
      for (const t of runMust) if (!tokens.includes(t)) bad(r.line, `unknown run token "${t}"`)
      out.push({ id, name, group, naAllowed: surface ? [] : naAllowed, runMust, line: r.line })
    }
    return out
  }
  const concerns = readConcerns("Concerns", GROUPS, false)
  const surfaceConcerns = readConcerns("Surface concerns", ["surface"], true)

  const surfaces: Surface[] = []
  const surfaceSeen = new Set<string>()
  for (const r of dataRows(requireTable(text, "Surfaces", SURFACE_HEADER, file, findings), file, findings)) {
    const [name = "", id = "", na = ""] = r.cells.map(unticked)
    unique(surfaceSeen, id, r.line, "surface id")
    const naAllowed = na === "none" ? [] : list(na, /\s*,\s*/)
    for (const c of naAllowed)
      if (!surfaceConcerns.some((sc) => sc.id === c)) bad(r.line, `unknown surface concern "${c}" in N/A allowed for`)
    surfaces.push({ id, name, naAllowed, line: r.line })
  }
  const surfacesFile = /^Surfaces file: `([^`]+)`$/m.exec(text)?.[1] ?? ""
  if (!surfacesFile) bad(1, "no `Surfaces file: `<path>`` line")

  const languages: Language[] = []
  const languageSeen = new Set<string>()
  for (const r of dataRows(requireTable(text, "Languages", LANGUAGE_REGISTRY_HEADER, file, findings), file, findings)) {
    const [, rawId = "", kind = "", skill = "", files = ""] = r.cells.map((c) => c.trim())
    const id = unticked(rawId)
    unique(languageSeen, id, r.line, "language id")
    if (!kinds.includes(unticked(kind))) bad(r.line, `unknown kind "${kind}"`)
    const fileList = list(files, /\s*,\s*/)
    if (fileList.length === 0) bad(r.line, "no files listed")
    languages.push({ id, kind: unticked(kind), skill: unticked(skill), files: fileList, line: r.line })
  }
  return { spec: { concerns, kinds, tokens, languages, surfaceConcerns, surfaces, surfacesFile }, findings }
}

const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-")

/** Maintenance cell of a shared tool: a version row, `Family: [text](#anchor)` or `Service: <note>`. */
function sharedMaintenanceProblem(cell: string, anchors: Set<string>, checked: string | undefined): string | undefined {
  if (cell.startsWith("Service:")) return cell.slice("Service:".length).trim() ? undefined : "Service needs a note"
  if (cell.startsWith("Family:")) {
    const m = /^Family: \[[^\]]+\]\(#([^)\s]+)\)$/.exec(cell)
    if (!m) return `Family must be "Family: [text](#section)", found "${cell}"`
    return anchors.has(m[1] ?? "") ? undefined : `Family anchor "#${m[1]}" matches no "## " heading`
  }
  return maintenanceProblem(cell, checked)
}

/** Parse the shared tools file into tool id to concern ids; `tokens` enables Run cell validation. */
export function parseShared(text: string, file = SHARED_FILE, tokens?: string[]): { shared: Shared; findings: Finding[] } {
  const findings: Finding[] = []
  const shared: Shared = new Map()
  const anchors = new Set([...text.matchAll(/^## (.+)$/gm)].map((m) => slug(m[1] ?? "")))
  const checked = /^Checked (\S+)\.$/m.exec(text)?.[1]
  for (const r of dataRows(requireTable(text, "Tools", SHARED_HEADER, file, findings), file, findings)) {
    const id = unticked(r.cells[0] ?? "")
    if (shared.has(id)) findings.push({ file, line: r.line, reason: `duplicate shared tool "${id}"` })
    shared.set(id, list(r.cells[2] ?? "", /\s*,\s*/))
    const problem = sharedMaintenanceProblem(r.cells[3] ?? "", anchors, checked)
    if (problem) findings.push({ file, line: r.line, reason: problem })
    const unknown = tokens ? list(r.cells[4] ?? "", /\s*\+\s*/).filter((t) => !tokens.includes(unticked(t))) : []
    if (unknown.length > 0) findings.push({ file, line: r.line, reason: `unknown run token "${unknown.join(", ")}"` })
  }
  return { shared, findings }
}

/** Classify a Default cell. */
export function classifyDefault(cell: string): DefaultKind {
  const text = cell.trim()
  const after = (prefix: string) => (text.startsWith(prefix) ? text.slice(prefix.length).trim() : undefined)
  const builtin = after("Built-in:")
  if (builtin) return { type: "builtin" }
  const shared = after("Shared:")
  if (shared) return { type: "shared", id: unticked(shared) }
  const inherits = after("Inherits:")
  if (inherits) return { type: "inherits", id: unticked(inherits) }
  if (after("N/A:")) return { type: "na" }
  if (after("No maintained tool:")) return { type: "none" }
  const tool = /^`([^`]+)`/.exec(text)
  return tool?.[1] ? { type: "tool", tool: tool[1] } : { type: "unknown" }
}

const ALTERNATIVE = /^(?:`[^`]+`|[^\s:`][^:`]*?):\s*\S/

/** Alternatives cell: `None`, or `;`-separated items; returns the item count, or undefined when malformed. */
function countAlternatives(cell: string): number | undefined {
  if (cell === "None") return 0
  const items = cell.split(";").map((s) => s.trim())
  return items.every((i) => ALTERNATIVE.test(i)) ? items.length : undefined
}

/** Maintenance cell problem, or undefined when valid. */
function maintenanceProblem(cell: string, checked: string | undefined): string | undefined {
  const m = /^>= (\S+) · (\S+) · (\S+)$/.exec(cell)
  if (!m) return `Maintenance must be ">= <min version> · YYYY-MM-DD · <status>", found "${cell}"`
  const [, , date = "", status = ""] = m
  if (!isDate(date)) return `Maintenance date "${date}" is not YYYY-MM-DD`
  if (status === "deprecated" || status === "archived") return `default tool is ${status}`
  if (!STATUSES.includes(status)) return `unknown status "${status}"`
  if (checked && date > checked) return `Maintenance date ${date} is after Checked ${checked}`
  return undefined
}

const INSTALL = /^`([^`]*)` · `([^`]*)`$/

/** Install cell problem for a tool default: two non-empty backticked commands, detect then install. */
function installProblem(cell: string): string | undefined {
  const m = INSTALL.exec(cell)
  if (m?.[1]?.trim() && m[2]?.trim()) return undefined
  return `Install must be "\`<detect command>\` · \`<install command>\`", found "${cell}"`
}

const applicableGroups = (kind: string) => (kind === "iac" ? GROUPS : GROUPS.filter((g) => g !== "iac"))
const languageFiles = (lang: Language) => lang.files.map((f) => f.replace(/^\.\//, ""))

type FileRow = { file: string; row: Row }

/** Concern rows of one language file, with problems from table shape only. */
function readConcernRows(files: Files, root: string, file: string): Row[] {
  const abs = path.join(root, file)
  if (!files.exists(abs)) return []
  const table = parseTable(files.read(abs), "Concerns")
  return table && sameHeader(table.header, LANGUAGE_HEADER)
    ? table.rows.filter((r) => r.cells.length === LANGUAGE_HEADER.length)
    : []
}

/** The Default cell a language declares for a concern, searching all its files. */
function defaultOf(ctx: Context, lang: Language, concern: string): string | undefined {
  for (const file of languageFiles(lang))
    for (const row of readConcernRows(ctx.files, ctx.root, file)) if (unticked(row.cells[0] ?? "") === concern) return row.cells[1]
  return undefined
}

function skillPath(files: Files, root: string, skill: string): string | undefined {
  const plugins = path.join(root, "plugins")
  if (!files.exists(plugins)) return undefined
  for (const plugin of files.entries(plugins)) {
    const candidate = path.join(plugins, plugin, "skills", skill, "SKILL.md")
    if (files.exists(candidate)) return candidate
  }
  return undefined
}

function linksOf(files: Files, file: string): string[] {
  if (!files.exists(file)) return []
  const targets = [...files.read(file).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "")
  return targets
    .filter((t) => !/^[a-z][a-z0-9+.-]*:|^#/i.test(t))
    .map((t) => path.resolve(path.dirname(file), t.split("#")[0] ?? ""))
}

/** Absolute paths linked from SKILL.md or from a file it links (one hop). */
function reachableFrom(files: Files, skill: string): Set<string> {
  const direct = linksOf(files, skill)
  return new Set([...direct, ...direct.filter((f) => f.endsWith(".md")).flatMap((f) => linksOf(files, f))])
}

/** Findings for one language across all its registered files. */
export function checkLanguage(ctx: Context, languageId: string): Finding[] {
  const lang = ctx.spec.languages.find((l) => l.id === languageId)
  if (!lang) return [{ file: SPEC_FILE, line: 1, reason: `unknown language "${languageId}"` }]
  const findings: Finding[] = []
  const owner = new Map<string, FileRow>()
  const skill = skillPath(ctx.files, ctx.root, lang.skill)
  if (!skill) findings.push({ file: SPEC_FILE, line: lang.line, reason: `skill "${lang.skill}" not found in plugins/*/skills` })
  const linked = skill ? reachableFrom(ctx.files, skill) : new Set<string>()

  for (const file of languageFiles(lang)) {
    const abs = path.join(ctx.root, file)
    if (!ctx.files.exists(abs)) {
      findings.push({ file: SPEC_FILE, line: lang.line, reason: `registered file ${file} is missing` })
      continue
    }
    if (skill && !linked.has(abs))
      findings.push({ file, line: 1, reason: `not linked from ${lang.skill} SKILL.md (directly or one hop)` })
    findings.push(...checkFile(ctx, lang, file, ctx.files.read(abs), owner))
  }

  const applicable = ctx.spec.concerns.filter((c) => applicableGroups(lang.kind).includes(c.group))
  for (const c of applicable)
    if (!owner.has(c.id)) findings.push({ file: SPEC_FILE, line: lang.line, reason: `${lang.id}: no row for concern "${c.id}"` })
  return findings
}

function checkFile(ctx: Context, lang: Language, file: string, text: string, owner: Map<string, FileRow>): Finding[] {
  const findings: Finding[] = []
  const bad = (line: number, reason: string) => findings.push({ file, line, reason })
  const checkedMatch = /^Checked (\S+)\.$/m.exec(text)
  const checked = checkedMatch?.[1]
  if (!checkedMatch || !checked || !isDate(checked)) bad(1, "no valid `Checked YYYY-MM-DD.` line")
  else if (checked > ctx.today) bad(1, `Checked ${checked} is in the future`)

  text.split(/\r?\n/).forEach((l, i, all) => {
    if (l.trim() === "## Concerns" && all.findIndex((x) => x.trim() === "## Concerns") !== i) bad(i + 1, 'duplicate section "Concerns"')
  })

  const table = parseTable(text, "Concerns")
  if (!table) return [...findings, { file, line: 1, reason: 'no table under "## Concerns"' }]
  if (!sameHeader(table.header, LANGUAGE_HEADER)) {
    bad(table.line, `"## Concerns" header must be | ${LANGUAGE_HEADER.join(" | ")} |`)
    return findings
  }

  const order = ctx.spec.concerns.map((c) => c.id)
  const tradeoffs = tradeoffMap(tradeoffSections(text.split(/\r?\n/), "## Tradeoffs", "###"))
  let lastIndex = -1
  for (const row of table.rows) {
    if (row.cells.length !== LANGUAGE_HEADER.length) {
      bad(row.line, `expected ${LANGUAGE_HEADER.length} cells, found ${row.cells.length}`)
      continue
    }
    const concernCell = row.cells[0] ?? ""
    const id = /^`([^`]+)`$/.exec(concernCell)?.[1]
    const concern = ctx.spec.concerns.find((c) => c.id === id)
    if (!id) {
      bad(row.line, "Concern cell must be the concern id in backticks")
      continue
    }
    if (!concern) {
      bad(row.line, `unknown concern id "${id}"`)
      continue
    }
    const previous = owner.get(id)
    if (previous) {
      bad(row.line, `duplicate concern "${id}" (also ${previous.file}:${previous.row.line})`)
      continue
    }
    owner.set(id, { file, row })
    if (!applicableGroups(lang.kind).includes(concern.group))
      bad(row.line, `concern "${id}" (group ${concern.group}) does not apply to kind ${lang.kind}`)
    const index = order.indexOf(id)
    if (index < lastIndex) bad(row.line, `concern "${id}" is out of spec order`)
    lastIndex = Math.max(lastIndex, index)

    const naProblem = concern.naAllowed.includes(lang.kind)
      ? undefined
      : `N/A is not allowed for kind ${lang.kind} on concern "${id}"`
    findings.push(
      ...checkCells(ctx, { naProblem, lang }, concern, row, { file, checked, tradeoffs, tradeoffWhere: `### ${id}" entry under ## Tradeoffs` }),
    )
  }

  for (const [id, section] of tradeoffs) {
    if (!order.includes(id)) bad(section.line, `Tradeoffs entry for unknown concern "${id}"`)
    else if (!hasBullet(section)) bad(section.line, `Tradeoffs entry "${id}" has no "- **tool**:" bullet`)
  }
  findings.push(...checkLanguageSpecific(ctx, file, text))
  return findings
}

type TradeoffSection = { id: string; line: number; body: string[] }

/**
 * Item headings (`item`, for example `###`) under the first `container` heading (for example `## Tradeoffs`) in
 * `lines`, up to the next heading of the container's level or higher. `offset` maps slice lines to file lines.
 */
function tradeoffSections(lines: string[], container: string, item: string, offset = 0): TradeoffSection[] {
  const start = lines.findIndex((l) => l.trim() === container)
  if (start < 0) return []
  const level = container.indexOf(" ")
  const stop = new RegExp(`^#{1,${level}} `)
  let end = lines.findIndex((l, i) => i > start && stop.test(l))
  if (end < 0) end = lines.length
  const sections: TradeoffSection[] = []
  for (let i = start + 1; i < end; i++) {
    const m = new RegExp(`^${item} (\\S+)\\s*$`).exec(lines[i] ?? "")
    if (m?.[1]) sections.push({ id: unticked(m[1]), line: i + 1 + offset, body: [] })
    else sections.at(-1)?.body.push(lines[i] ?? "")
  }
  return sections
}

/** A Tradeoffs bullet: `- **tool**:` or `- **tool** (note):`, followed by text. Group 1 is the tool name. */
const BULLET = /^- \*\*([^*]+)\*\*(?: \([^)]*\))?:\s*\S/

const hasBullet = (section: TradeoffSection) => section.body.some((l) => BULLET.test(l))

const tradeoffMap = (sections: TradeoffSection[]) => new Map(sections.map((s) => [s.id, s]))

const toolKey = (name: string) => unticked(name).toLowerCase()

/** Each alternative's name: its leading code span, else the text before the first colon (as ALTERNATIVE reads it). */
const alternativeNames = (cell: string) =>
  cell.split(";").map((i) => {
    const item = i.trim()
    const span = /^`([^`]+)`/.exec(item)
    return toolKey(span ? (span[1] ?? "") : item.slice(0, item.indexOf(":")))
  })

/** Tools a Tradeoffs entry must cover but has no bullet for: the Default tool and every alternative. */
function missingTradeoffTools(section: TradeoffSection, def: string, alts: string): string[] {
  const bullets = section.body.flatMap((l) => {
    const m = BULLET.exec(l)
    return m?.[1] ? [toolKey(m[1])] : []
  })
  const kind = classifyDefault(def)
  const named = [...(kind.type === "tool" ? [toolKey(kind.tool)] : []), ...alternativeNames(alts)]
  return named.filter((n) => !bullets.some((b) => b === n || (b.startsWith(n) && /^(?:\s+\S|\()/.test(b.slice(n.length)))))
}

type CellsAt = {
  file: string
  checked: string | undefined
  tradeoffs: Map<string, TradeoffSection>
  /** Tail of the missing-Tradeoffs message after `need a "`. */
  tradeoffWhere: string
}

/** Cell rules shared by language and surface rows: no empty cell, Default, Alternatives and Run. */
function checkCells(ctx: Context, owner: Owner, concern: Concern, row: Row, at: CellsAt): Finding[] {
  const findings: Finding[] = []
  const bad = (reason: string) => findings.push({ file: at.file, line: row.line, reason })
  const [, def = "", maint = "", install = "", alts = "", , run = ""] = row.cells
  const empty = LANGUAGE_HEADER.filter((_, i) => row.cells[i] === "")
  if (empty.length > 0) bad(`empty cell: ${empty.join(", ")}`)
  findings.push(...checkDefault(ctx, owner, concern, { file: at.file, line: row.line, def, maint, install, checked: at.checked }))
  const count = countAlternatives(alts)
  if (alts === "") {
    // reported as an empty cell
  } else if (count === undefined) bad(`Alternatives must be "None" or "tool: condition" items separated by ";"`)
  else if (count >= 2) {
    const section = at.tradeoffs.get(concern.id)
    if (!section) bad(`${count} alternatives need a "${at.tradeoffWhere}`)
    else if (hasBullet(section))
      for (const tool of missingTradeoffTools(section, def, alts)) bad(`Tradeoffs entry "${concern.id}" lacks a "- **${tool}**:" bullet`)
  }
  findings.push(...checkRun(ctx, concern, def, { file: at.file, line: row.line, run }))
  return findings
}

type Where = { file: string; line: number }

/** Where a row lives and what it may do: a language row may inherit and may be N/A per kind; a surface row neither inherits nor is N/A unless `naProblem` is undefined. */
type Owner = { lang?: Language; naProblem: string | undefined }

function checkDefault(
  ctx: Context,
  owner: Owner,
  concern: Concern,
  at: Where & { def: string; maint: string; install: string; checked: string | undefined },
): Finding[] {
  const findings: Finding[] = []
  const bad = (reason: string) => findings.push({ file: at.file, line: at.line, reason })
  const kind = classifyDefault(at.def)
  const id = concern.id
  const needsDash = (what: string) => at.maint !== "-" && bad(`Maintenance must be "-" for ${what}`)
  const needsInstall = (expected: string) =>
    at.install !== expected && bad(`Install must be "${expected}" for this Default, found "${at.install}"`)
  switch (kind.type) {
    case "unknown":
      bad(`unknown Default "${at.def}"; use \`tool\`, Built-in:, Shared:, Inherits:, N/A: or No maintained tool:`)
      break
    case "tool": {
      const problem = maintenanceProblem(at.maint, at.checked) ?? installProblem(at.install)
      if (problem) bad(problem)
      break
    }
    case "builtin": {
      const problem = at.maint === "-" ? undefined : maintenanceProblem(at.maint, at.checked)
      if (problem) bad(problem)
      if (at.install !== "Built-in") {
        const install = installProblem(at.install)
        if (install) bad(`${install} (or "Built-in")`)
      }
      break
    }
    case "shared": {
      needsDash("Shared")
      needsInstall("Shared")
      const covers = ctx.shared.get(kind.id)
      if (!covers) bad(`shared tool "${kind.id}" is not in shared-tools.md`)
      else if (!covers.includes(id)) bad(`shared tool "${kind.id}" does not list concern "${id}"`)
      break
    }
    case "inherits": {
      needsDash("Inherits")
      needsInstall("Inherits")
      if (owner.lang) findings.push(...checkInherits(ctx, owner.lang, id, kind.id, at))
      else bad("Inherits is not allowed in surfaces")
      break
    }
    case "na":
      needsDash("N/A")
      needsInstall("-")
      if (owner.naProblem) bad(owner.naProblem)
      break
    case "none":
      needsDash("No maintained tool")
      needsInstall("-")
      break
  }
  return findings
}

function checkInherits(ctx: Context, lang: Language, concern: string, target: string, at: Where): Finding[] {
  const bad = (reason: string): Finding[] => [{ ...at, reason }]
  const targetLang = ctx.spec.languages.find((l) => l.id === target)
  if (!targetLang) return bad(`Inherits target "${target}" is not a language in the spec`)
  if (target === lang.id) return bad("a language cannot inherit from itself")
  const cell = defaultOf(ctx, targetLang, concern)
  if (cell === undefined) return bad(`Inherits target "${target}" has no row for "${concern}"`)
  const kind = classifyDefault(cell).type
  if (kind === "inherits") return bad(`Inherits target "${target}" itself inherits "${concern}" (no chains)`)
  if (kind === "na") return bad(`Inherits target "${target}" has N/A for "${concern}"`)
  return []
}

function checkRun(ctx: Context, concern: Concern, def: string, at: Where & { run: string }): Finding[] {
  const bad = (reason: string): Finding[] => [{ file: at.file, line: at.line, reason }]
  if (at.run === "" || (at.run === "-" && concern.runMust.length === 0)) return []
  if (at.run === "-") return classifyDefault(def).type === "na" ? [] : bad(`Run must include ${concern.runMust.join(" + ")}`)
  const tokens = at.run.split(/\s*\+\s*/)
  const unknown = tokens.filter((t) => !ctx.spec.tokens.includes(t))
  if (unknown.length > 0) return bad(`unknown run token "${unknown.join(", ")}"`)
  const missing = concern.runMust.filter((t) => !tokens.includes(t))
  if (missing.length > 0 && classifyDefault(def).type !== "na") return bad(`Run must include ${missing.join(" + ")}`)
  return []
}

/** Lines of the `## <id>` section: the slice and its 0-based offset in the file. */
function sectionOf(lines: string[], id: string): { lines: string[]; offset: number } | undefined {
  const start = lines.findIndex((l) => l.trim() === `## ${id}`)
  if (start < 0) return undefined
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end < 0) end = lines.length
  return { lines: lines.slice(start, end), offset: start }
}

/**
 * Findings for the surfaces file: one `## <surface-id>` section per surface, each with a language-style table of
 * the surface concerns in spec order, and optional `### Tradeoffs` with one `#### <concern-id>` per concern that
 * has two or more alternatives.
 */
export function checkSurfaces(ctx: Context): Finding[] {
  const { spec } = ctx
  const file = spec.surfacesFile
  const abs = path.join(ctx.root, file)
  if (!file || !ctx.files.exists(abs)) return [{ file: SPEC_FILE, line: 1, reason: `surfaces file ${file || "(unset)"} is missing` }]
  const text = ctx.files.read(abs)
  const lines = text.split(/\r?\n/)
  const findings: Finding[] = []
  const bad = (line: number, reason: string) => findings.push({ file, line, reason })
  const checked = /^Checked (\S+)\.$/m.exec(text)?.[1]
  if (!checked || !isDate(checked)) bad(1, "no valid `Checked YYYY-MM-DD.` line")
  else if (checked > ctx.today) bad(1, `Checked ${checked} is in the future`)

  lines.forEach((l, i) => {
    const heading = /^## (\S+)\s*$/.exec(l)?.[1]
    if (heading && !spec.surfaces.some((s) => s.id === heading)) bad(i + 1, `section "${heading}" is not a surface in the spec`)
  })

  const sectionSeen = new Set<string>()
  lines.forEach((l, i) => {
    const heading = /^## (\S+)\s*$/.exec(l)?.[1]
    if (heading && spec.surfaces.some((s) => s.id === heading)) {
      if (sectionSeen.has(heading)) bad(i + 1, `duplicate section "${heading}"`)
      sectionSeen.add(heading)
    }
  })

  const order = spec.surfaceConcerns.map((c) => c.id)
  for (const surface of spec.surfaces) {
    const section = sectionOf(lines, surface.id)
    if (!section) {
      bad(1, `no "## ${surface.id}" section`)
      continue
    }
    const seen = new Set<string>()
    const tradeoffs = tradeoffSections(section.lines, "### Tradeoffs", "####", section.offset)
    const table = parseTable(section.lines.join("\n"), surface.id)
    const rows = table && sameHeader(table.header, LANGUAGE_HEADER) ? table.rows : []
    if (table && !sameHeader(table.header, LANGUAGE_HEADER))
      bad(table.line + section.offset, `"## ${surface.id}" header must be | ${LANGUAGE_HEADER.join(" | ")} |`)
    let lastIndex = -1
    for (const r of rows) {
      const row = { line: r.line + section.offset, cells: r.cells }
      if (row.cells.length !== LANGUAGE_HEADER.length) {
        bad(row.line, `expected ${LANGUAGE_HEADER.length} cells, found ${row.cells.length}`)
        continue
      }
      const id = /^`([^`]+)`$/.exec(row.cells[0] ?? "")?.[1]
      if (!id) {
        bad(row.line, "Concern cell must be the concern id in backticks")
        continue
      }
      const concern = spec.surfaceConcerns.find((c) => c.id === id)
      if (!concern) {
        bad(row.line, `unknown surface concern id "${id}"`)
        continue
      }
      if (seen.has(id)) {
        bad(row.line, `duplicate concern "${id}" in surface ${surface.id}`)
        continue
      }
      seen.add(id)
      const index = order.indexOf(id)
      if (index < lastIndex) bad(row.line, `concern "${id}" is out of spec order`)
      lastIndex = Math.max(lastIndex, index)
      const naProblem = surface.naAllowed.includes(id)
        ? undefined
        : `N/A is not allowed for surface ${surface.id} on concern "${id}"`
      findings.push(
        ...checkCells(ctx, { naProblem }, concern, row, {
          file,
          checked,
          tradeoffs: tradeoffMap(tradeoffs),
          tradeoffWhere: `#### ${id}" entry under ### Tradeoffs in ## ${surface.id}`,
        }),
      )
    }
    for (const t of tradeoffs) {
      if (!order.includes(t.id)) bad(t.line, `Tradeoffs entry for unknown surface concern "${t.id}"`)
      else if (!hasBullet(t)) bad(t.line, `Tradeoffs entry "${t.id}" has no "- **tool**:" bullet`)
    }
    for (const id of order) if (!seen.has(id)) bad(section.offset + 1, `surface ${surface.id}: no row for concern "${id}"`)
  }
  return findings
}

function checkLanguageSpecific(ctx: Context, file: string, text: string): Finding[] {
  const table = parseTable(text, "Language-specific")
  if (!table) return []
  const reserved = new Set(ctx.spec.concerns.flatMap((c) => [c.id, c.name.toLowerCase()]))
  return table.rows
    .filter((r) => reserved.has(unticked(r.cells[0] ?? "").toLowerCase()))
    .map((r) => ({
      file,
      line: r.line,
      reason: `Language-specific row "${unticked(r.cells[0] ?? "")}" reuses a canonical concern; move it to ## Concerns`,
    }))
}

/** Load the spec and shared tools, then check the chosen language or every language. */
export function checkRepo(root: string, options: { language?: string; today?: string; files?: Files } = {}): Finding[] {
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const loaded = loadContext(root, today, options.files ?? diskFiles)
  if (!("ctx" in loaded)) return loaded.findings
  const { ctx, findings } = loaded
  const ids = options.language ? [options.language] : ctx.spec.languages.map((l) => l.id)
  for (const id of ids) findings.push(...checkLanguage(ctx, id))
  if (!options.language) findings.push(...checkSurfaces(ctx))
  return findings
}

function loadContext(root: string, today: string, files: Files): { ctx: Context; findings: Finding[] } | { findings: Finding[] } {
  const specPath = path.join(root, SPEC_FILE)
  const sharedPath = path.join(root, SHARED_FILE)
  const missing = [SPEC_FILE, SHARED_FILE].filter((f) => !files.exists(path.join(root, f)))
  if (missing.length > 0) return { findings: missing.map((file) => ({ file, line: 1, reason: "file is missing" })) }
  const specText = files.read(specPath)
  const spec = parseSpec(specText)
  const shared = parseShared(files.read(sharedPath), SHARED_FILE, spec.spec.tokens)
  const findings = [...spec.findings, ...shared.findings]
  const dated = /^Checked (\S+)\.$/m.exec(specText)?.[1]
  if (dated && !isDate(dated)) findings.push({ file: SPEC_FILE, line: 1, reason: `Checked "${dated}" is not YYYY-MM-DD` })
  if (findings.length > 0) return { findings }
  return { ctx: { root, spec: spec.spec, shared: shared.shared, today, files }, findings }
}

/** Report lines for rows whose release date is older than `maxAgeDays`. Informational only. */
export function staleRows(root: string, maxAgeDays: number, today: string, language?: string, files: Files = diskFiles): string[] {
  const loaded = loadContext(root, today, files)
  if (!("ctx" in loaded)) return []
  const { ctx } = loaded
  const out: string[] = []
  for (const lang of ctx.spec.languages.filter((l) => !language || l.id === language))
    for (const file of languageFiles(lang))
      for (const row of readConcernRows(files, root, file)) {
        const date = /(\d{4}-\d{2}-\d{2})/.exec(row.cells[2] ?? "")?.[1]
        if (!date || !isDate(date)) continue
        const age = Math.floor((Date.parse(today) - Date.parse(date)) / DAY_MS)
        if (age > maxAgeDays) out.push(`${file}:${row.line}: ${unticked(row.cells[0] ?? "")} released ${date} (${age} days old)`)
      }
  if (!language) out.push(...staleSurfaceRows(ctx, maxAgeDays, today))
  return out
}

function staleSurfaceRows(ctx: Context, maxAgeDays: number, today: string): string[] {
  const file = ctx.spec.surfacesFile
  const abs = path.join(ctx.root, file)
  if (!file || !ctx.files.exists(abs)) return []
  const lines = ctx.files.read(abs).split(/\r?\n/)
  const out: string[] = []
  for (const surface of ctx.spec.surfaces) {
    const section = sectionOf(lines, surface.id)
    const table = section && parseTable(section.lines.join("\n"), surface.id)
    if (!section || !table || !sameHeader(table.header, LANGUAGE_HEADER)) continue
    for (const row of table.rows) {
      const date = /(\d{4}-\d{2}-\d{2})/.exec(row.cells[2] ?? "")?.[1]
      if (!date || !isDate(date)) continue
      const age = Math.floor((Date.parse(today) - Date.parse(date)) / DAY_MS)
      if (age > maxAgeDays)
        out.push(`${file}:${row.line + section.offset}: ${surface.id}/${unticked(row.cells[0] ?? "")} released ${date} (${age} days old)`)
    }
  }
  return out
}

type MainIo = { root?: string; files?: Files; today?: string; stdout?: (line: string) => void; stderr?: (line: string) => void }

/** CLI entry: returns the exit code (0 clean, 1 findings, 2 bad usage). */
export function main(argv: string[], io: MainIo = {}): number {
  const out = io.stdout ?? console.log
  const err = io.stderr ?? console.error
  let values: { language?: string; "max-age"?: string }
  try {
    values = parseArgs({ args: argv, options: { language: { type: "string" }, "max-age": { type: "string" } } }).values
  } catch (e) {
    err(`check-concerns: ${e instanceof Error ? e.message : String(e)}`)
    err("usage: bun scripts/check-concerns.ts [--language <id>] [--max-age <days>]")
    return 2
  }
  const root = io.root ?? path.resolve(import.meta.dir, "..")
  const today = io.today ?? new Date().toISOString().slice(0, 10)
  const maxAge = values["max-age"] === undefined ? undefined : Number(values["max-age"])
  if (maxAge !== undefined && !(maxAge >= 0)) {
    err("check-concerns: --max-age needs a non-negative number of days")
    return 2
  }
  const findings = checkRepo(root, { language: values.language, today, files: io.files })
  for (const f of findings) err(`${f.file}:${f.line}: ${f.reason}`)
  if (maxAge !== undefined) {
    const stale = staleRows(root, maxAge, today, values.language, io.files)
    out(`check-concerns: ${stale.length} row(s) older than ${maxAge} days`)
    for (const line of stale) out(line)
  }
  if (findings.length > 0) {
    err(`check-concerns: ${findings.length} finding(s)`)
    return 1
  }
  out("check-concerns: clean")
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
