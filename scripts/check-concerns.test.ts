import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  checkLanguage,
  checkRepo,
  classifyDefault,
  type Files,
  main,
  parseShared,
  parseSpec,
  parseTable,
  staleRows,
} from "./check-concerns.ts"

const FIXTURE = path.join(import.meta.dir, "fixtures", "concerns", "valid")
const REF = "plugins/toolchain/skills/toolchain-languages/references"
const SPEC = `${REF}/concerns.md`
const SHARED = `${REF}/shared-tools.md`
const PY_TESTING = "plugins/lang/skills/lang-x/references/testing.md"
const PY_QUALITY = "plugins/lang/skills/lang-x/references/quality.md"
const SH = "plugins/lang/skills/lang-sh/references/shell.md"
const TF = "plugins/lang/skills/lang-tf/references/tf.md"
const SURFACES = `${REF}/surfaces.md`
const TODAY = "2026-02-01"

/**
 * Repo-relative path to file text. Tests work on in-memory copies of the fixture: each file open costs
 * milliseconds under endpoint security, so copying the fixture to disk per test made this file take minutes.
 */
type Tree = Map<string, string>
/** Root the in-memory trees are mounted at. */
const ROOT = "/repo"
const VALID: Tree = new Map(
  [...new Bun.Glob("**/*").scanSync({ cwd: FIXTURE })].map((f) => [f, readFileSync(path.join(FIXTURE, f), "utf8")]),
)

/** `Files` over a tree mounted at ROOT; a directory exists when some file lies under it. */
function filesOf(tree: Tree): Files {
  const rel = (abs: string) => path.relative(ROOT, abs)
  const under = (abs: string) => [...tree.keys()].filter((k) => k.startsWith(`${rel(abs)}/`)).map((k) => k.slice(rel(abs).length + 1))
  return {
    exists: (abs) => tree.has(rel(abs)) || under(abs).length > 0,
    read: (abs) => {
      const text = tree.get(rel(abs))
      if (text === undefined) throw new Error(`ENOENT: ${abs}`)
      return text
    },
    entries: (abs) => [...new Set(under(abs).map((k) => k.split("/")[0] ?? ""))],
  }
}

/** A copy of the valid fixture with `file: [from, to]` replacements; each `from` must exist. */
function repo(edits: Record<string, [string, string]> = {}): Tree {
  const tree = new Map(VALID)
  for (const [file, [from, to]] of Object.entries(edits)) {
    const text = tree.get(file) ?? ""
    if (!text.includes(from)) throw new Error(`fixture ${file} lacks ${JSON.stringify(from)}`)
    tree.set(file, text.replace(from, to))
  }
  return tree
}
const check = (tree: Tree, language?: string) => checkRepo(ROOT, { language, today: TODAY, files: filesOf(tree) })
const reasons = (tree: Tree, language?: string) => check(tree, language).map((f) => `${f.file}:${f.line}: ${f.reason}`)
/** Swap the first lines starting with `a` and `b` in `file`. */
function swapLines(tree: Tree, file: string, a: string, b: string): Tree {
  const lines = (tree.get(file) ?? "").split("\n")
  const [i, j] = [lines.findIndex((l) => l.startsWith(a)), lines.findIndex((l) => l.startsWith(b))]
  ;[lines[i], lines[j]] = [lines[j] as string, lines[i] as string]
  return tree.set(file, lines.join("\n"))
}

describe("parseTable", () => {
  const text = "# T\n\n## A\n\n| X | Y |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n## B\n\n| Z |\n|---|\n| 9 |\n"
  test("returns header and rows with 1-based lines", () => {
    expect(parseTable(text, "A")).toEqual({
      line: 5,
      header: ["X", "Y"],
      rows: [
        { line: 7, cells: ["1", "2"] },
        { line: 8, cells: ["3", "4"] },
      ],
    })
  })
  test("stops at the next heading", () => {
    expect(parseTable(text, "B")?.rows).toEqual([{ line: 14, cells: ["9"] }])
  })
  test("is undefined for a missing section", () => {
    expect(parseTable(text, "C")).toBeUndefined()
  })
})

describe("classifyDefault", () => {
  test.each([
    ["`pytest`", { type: "tool", tool: "pytest" }],
    ["`ruff` (with plugins)", { type: "tool", tool: "ruff" }],
    ["Built-in: go test", { type: "builtin" }],
    ["Shared: tflint-shared", { type: "shared", id: "tflint-shared" }],
    ["Inherits: py", { type: "inherits", id: "py" }],
    ["N/A: no types", { type: "na" }],
    ["No maintained tool: manual review", { type: "none" }],
    ["pytest", { type: "unknown" }],
    ["N/A:", { type: "unknown" }],
  ])("%s", (cell, expected) => {
    expect(classifyDefault(cell)).toEqual(expected as never)
  })
})

describe("parseSpec and parseShared", () => {
  const spec = readFileSync(path.join(FIXTURE, SPEC), "utf8")
  test("parse the fixture spec", () => {
    const parsed = parseSpec(spec)
    expect(parsed.findings).toEqual([])
    expect(parsed.spec.concerns.map((c) => [c.id, c.group, c.naAllowed, c.runMust])).toEqual([
      ["unit", "testing", [], ["every-pr"]],
      ["lint", "quality", [], ["every-pr"]],
      ["types", "quality", ["shell", "iac"], ["every-pr"]],
      ["drift", "iac", [], ["scheduled"]],
    ])
    expect(parsed.spec.surfaceConcerns.map((c) => [c.id, c.group, c.runMust])).toEqual([
      ["e2e", "surface", ["every-pr", "scheduled"]],
      ["visual", "surface", ["diff-pr"]],
    ])
    expect(parsed.spec.surfaces.map((x) => [x.id, x.naAllowed])).toEqual([
      ["web", []],
      ["api", ["visual"]],
    ])
    expect(parsed.spec.surfacesFile).toBe(SURFACES)
    expect(parsed.spec.languages[0]).toMatchObject({ id: "py", kind: "managed", skill: "lang-x" })
    expect(parsed.spec.languages[0]?.files).toHaveLength(2)
  })
  test.each([
    ["duplicate concern id", "| lint | Linting |", "| unit | Linting |", 'duplicate concern id "unit"'],
    ["unknown group", "| testing |", "| nope |", 'unknown group "nope"'],
    ["unknown kind in N/A", "| shell, iac |", "| shell, ghost |", 'unknown kind "ghost" in N/A allowed for'],
    ["unknown run token", "| scheduled |\n\n## Surface concerns", "| yearly |\n\n## Surface concerns", 'unknown run token "yearly"'],
    ["surface concern in the wrong group", "| surface | Whole", "| testing | Whole", 'unknown group "testing"'],
    ["surface concern with a kind in N/A", "| surface | Whole-flow tests. | none |", "| surface | Whole-flow tests. | shell |", 'surface concern "e2e" must have N/A allowed for "none"; list N/A in ## Surfaces'],
    ["surface concern id clashing with a concern", "| e2e | End-to-end", "| unit | End-to-end", 'duplicate concern id "unit"'],
    ["duplicate surface id", "| HTTP API | api |", "| HTTP API | web |", 'duplicate surface id "web"'],
    ["unknown surface concern in N/A", "| HTTP API | api | visual |", "| HTTP API | api | ghost |", 'unknown surface concern "ghost" in N/A allowed for'],
    ["no Surfaces file line", "Surfaces file: `plugins/toolchain/skills/toolchain-languages/references/surfaces.md`", "", "no `Surfaces file: `<path>`` line"],
    ["unknown language kind", "| shell | lang-sh |", "| ghost | lang-sh |", 'unknown kind "ghost"'],
  ])("spec: %s", (_name, from, to, reason) => {
    const edited = spec.replace(from, to)
    expect(edited).not.toBe(spec)
    expect(parseSpec(edited).findings.map((f) => f.reason)).toContain(reason)
  })
  test("parseShared maps tool ids to concerns", () => {
    const { shared, findings } = parseShared(readFileSync(path.join(FIXTURE, SHARED), "utf8"))
    expect(findings).toEqual([])
    expect(shared.get("tflint-shared")).toEqual(["lint"])
  })
})

describe("checkRepo on the valid fixture", () => {
  test("is clean for every language, read from disk", () => {
    expect(checkRepo(FIXTURE, { today: TODAY })).toEqual([])
  })
  test("--language limits the check", () => {
    const root = repo({ [SH]: ["`bats`", "bats"] })
    expect(reasons(root, "py")).toEqual([])
    expect(reasons(root, "sh")).toHaveLength(1)
  })
  test("unknown language is a finding", () => {
    expect(reasons(repo(), "zz")).toEqual([`${SPEC}:1: unknown language "zz"`])
  })
  test("a backticked language id in the spec matches --language", () => {
    const root = repo({ [SPEC]: ["| Python | py |", "| Python | `py` |"] })
    expect(reasons(root, "py")).toEqual([])
  })
  test("missing spec file is a finding", () => {
    const root = repo()
    root.delete(SPEC)
    expect(reasons(root)).toEqual([`${SPEC}:1: file is missing`])
  })
})

describe("language file findings", () => {
  // [name, file, from, to, expected reason fragment]
  const cases: [string, string, string, string, string][] = [
    ["Checked in the future", PY_QUALITY, "Checked 2026-01-10.", "Checked 2026-03-01.", "is in the future"],
    ["no Checked line", PY_QUALITY, "Checked 2026-01-10.", "", "no valid `Checked"],
    ["wrong header", PY_QUALITY, "| Concern | Default |", "| Concern | Tool |", "header must be"],
    ["unknown concern id", PY_QUALITY, "| `lint` |", "| `lintt` |", 'unknown concern id "lintt"'],
    ["duplicate row", PY_QUALITY, "| `types` |", "| `lint` |", 'duplicate concern "lint"'],
    ["concern cell without backticks", PY_QUALITY, "| `lint` |", "| lint |", "Concern cell must be"],
    ["empty cell", PY_QUALITY, "| None | - | every-pr | - |", "| None |  | every-pr | - |", "empty cell: Use both when"],
    ["wrong cell count", PY_QUALITY, "| every-pr | - |\n| `types`", "| every-pr |\n| `types`", "expected 8 cells"],
    ["iac concern in a non-iac language", PY_QUALITY, "| `types` |", "| `drift` |", "does not apply to kind managed"],
    ["unknown Default", PY_QUALITY, "`ruff` |", "ruff |", 'unknown Default "ruff"'],
    ["deprecated tool", PY_QUALITY, "0.9.0 · 2026-01-05 · active", "0.9.0 · 2026-01-05 · deprecated", "default tool is deprecated"],
    ["unknown status", PY_QUALITY, "0.9.0 · 2026-01-05 · active", "0.9.0 · 2026-01-05 · stable", 'unknown status "stable"'],
    ["malformed Maintenance", PY_QUALITY, "0.9.0 · 2026-01-05 · active", "0.9.0", "Maintenance must be"],
    ["exact version pin", PY_QUALITY, ">= 0.9.0", "0.9.0", "Maintenance must be"],
    ["Install without an install command", PY_QUALITY, "`ruff --version` · `uv tool install ruff`", "`ruff --version`", "Install must be"],
    ["Install with an empty command", PY_QUALITY, "`ruff --version` · `uv tool install ruff`", "`ruff --version` · ``", "Install must be"],
    ["Install as plain text", PY_QUALITY, "`ruff --version` · `uv tool install ruff`", "uv tool install ruff", "Install must be"],
    ["Shared with a tool Install", TF, "Shared: tflint-shared | - | Shared", "Shared: tflint-shared | - | `a` · `b`", 'Install must be "Shared"'],
    ["Inherits with a tool Install", TF, "Inherits: py | - | Inherits", "Inherits: py | - | `a` · `b`", 'Install must be "Inherits"'],
    ["N/A with an Install", SH, "types` | N/A: shell has no static types | - | -", "types` | N/A: shell has no static types | - | `a` · `b`", 'Install must be "-"'],
    ["Maintenance after Checked", PY_QUALITY, "2026-01-05", "2026-01-11", "is after Checked"],
    ["Maintenance not a date", PY_QUALITY, "2026-01-05", "2026-13-45", "is not YYYY-MM-DD"],
    ["Shared with a version", TF, "Shared: tflint-shared | - |", "Shared: tflint-shared | 1.0 · 2026-01-01 · active |", 'must be "-" for Shared'],
    ["N/A not allowed for kind", PY_QUALITY, "`mypy` | >= 1.14.0 · 2026-01-04 · active | `mypy --version` · `uv tool install mypy` |", "N/A: skipped | - | - |", "N/A is not allowed for kind managed"],
    ["unknown shared id", TF, "Shared: tflint-shared", "Shared: ghost", 'shared tool "ghost" is not in shared-tools.md'],
    ["shared tool lacks the concern", TF, "| `types` | N/A: HCL is validated by the provider", "| `types` | Shared: tflint-shared", 'does not list concern "types"'],
    ["Inherits unknown language", TF, "Inherits: py", "Inherits: zz", "is not a language in the spec"],
    ["Inherits itself", TF, "Inherits: py", "Inherits: tf", "cannot inherit from itself"],
    ["malformed Alternatives", PY_QUALITY, "| None | - | every-pr | - |", "| ruff-ish | - | every-pr | - |", "Alternatives must be"],
    ["two alternatives without Tradeoffs", PY_TESTING, "## Tradeoffs\n\n### unit", "## Tradeoffs\n\n### lint", 'need a "### unit" entry'],
    ["Tradeoffs entry without bullets", PY_TESTING, "- **pytest**: fixtures and parametrize.\n- **unittest**: standard library only.\n- **nose2**: legacy suites only.", "Nothing.", 'has no "- **tool**:" bullet'],
    ["Tradeoffs for unknown concern", PY_TESTING, "### unit", "### ghost", "unknown concern"],
    ["unknown run token", PY_QUALITY, "every-pr + scheduled", "every-pr + yearly", 'unknown run token "yearly"'],
    ["Run lacks required token", PY_QUALITY, "| every-pr | - |\n| `types`", "| scheduled | - |\n| `types`", "Run must include every-pr"],
    ["Language-specific reuses a concern", PY_TESTING, "| Fixtures |", "| `unit` |", "reuses a canonical concern"],
  ]
  test.each(cases)("%s", (_name, file, from, to, fragment) => {
    const found = reasons(repo({ [file]: [from, to] }))
    expect(found.some((r) => r.includes(fragment))).toBe(true)
  })

  test("a finding names file and line", () => {
    const found = check(repo({ [PY_QUALITY]: ["| `lint` |", "| `lintt` |"] }))
    expect(found).toContainEqual({ file: PY_QUALITY, line: 9, reason: 'unknown concern id "lintt"' })
  })
  test("out-of-order rows", () => {
    const root = swapLines(repo(), PY_QUALITY, "| `lint`", "| `types`")
    expect(reasons(root).some((r) => r.includes('"lint" is out of spec order'))).toBe(true)
  })
  test("N/A is accepted where the kind allows it, with Run `-`", () => {
    expect(reasons(repo(), "sh")).toEqual([])
  })
  test("Built-in accepts Maintenance and Install of `-` or `Built-in`", () => {
    const root = repo({
      [SH]: ["`bats` | >= 1.11.0 · 2026-01-06 · active | `bats --version` · `brew install bats-core`", "Built-in: bats | - | Built-in"],
    })
    expect(reasons(root, "sh")).toEqual([])
  })
  test("Inherits chain is rejected", () => {
    const root = repo({ [SH]: ["`bats` | >= 1.11.0 · 2026-01-06 · active", "Inherits: py | -"], [TF]: ["Inherits: py", "Inherits: sh"] })
    expect(reasons(root, "tf").some((r) => r.includes("no chains"))).toBe(true)
  })
  test("Inherits from a language whose Default is N/A is rejected", () => {
    const root = repo({ [SH]: ["`bats` | >= 1.11.0 · 2026-01-06 · active", "N/A: none | -"], [TF]: ["Inherits: py", "Inherits: sh"] })
    expect(reasons(root, "tf").some((r) => r.includes('has N/A for "unit"'))).toBe(true)
  })
})

describe("surfaces file", () => {
  const WEB_E2E = "| `e2e` | `playwright` | >= 1.50.0 · 2026-01-07 · active | `playwright --version` · `npm i -D @playwright/test` |"
  // [name, from, to, expected reason fragment]
  const cases: [string, string, string, string][] = [
    ["no Checked line", "Checked 2026-01-10.", "", "no valid `Checked"],
    ["Checked in the future", "Checked 2026-01-10.", "Checked 2026-03-01.", "is in the future"],
    ["missing surface section", "## api", "## other", 'no "## api" section'],
    ["section that is not a surface", "## api", "## api\n\n## ghost", 'section "ghost" is not a surface'],
    ["missing concern row", "| `visual` | Built-in: playwright screenshots | - | Built-in | None | - | diff-pr | - |\n", "", 'surface web: no row for concern "visual"'],
    ["wrong header", "| Concern | Default |", "| Concern | Tool |", "header must be"],
    ["language concern in a surface", WEB_E2E, WEB_E2E.replace("`e2e`", "`unit`"), 'unknown surface concern id "unit"'],
    ["duplicate row", "| `visual` | Built-in", "| `e2e` | Built-in", 'duplicate concern "e2e" in surface web'],
    ["Inherits", "`hurl` | >= 6.0.0 · 2026-01-08 · active | `hurl --version` · `brew install hurl`", "Inherits: py | - | Inherits", "Inherits is not allowed in surfaces"],
    ["N/A where the surface forbids it", "`hurl` | >= 6.0.0 · 2026-01-08 · active | `hurl --version` · `brew install hurl`", "N/A: skipped | - | -", 'N/A is not allowed for surface api on concern "e2e"'],
    ["deprecated tool", "1.50.0 · 2026-01-07 · active", "1.50.0 · 2026-01-07 · deprecated", "default tool is deprecated"],
    ["exact version pin", ">= 1.50.0", "1.50.0", "Maintenance must be"],
    ["Install as plain text", "`playwright --version` · `npm i -D @playwright/test`", "npm i -D @playwright/test", "Install must be"],
    ["unknown run token", "every-pr + scheduled | - |\n| `visual`", "every-pr + yearly | - |\n| `visual`", 'unknown run token "yearly"'],
    ["Run lacks required token", "| every-pr + scheduled | - |\n| `visual`", "| every-pr | - |\n| `visual`", "Run must include scheduled"],
    ["two alternatives without Tradeoffs", "#### e2e", "#### visual", 'need a "#### e2e" entry'],
    ["Tradeoffs entry without bullets", "- **playwright**: multi-browser and fast; costs a browser download.\n- **cypress**: good debugging UI; costs single-tab limits.\n- **selenium**: runs legacy grids; slow and flaky.", "Nothing.", 'has no "- **tool**:" bullet'],
    ["Tradeoffs for unknown concern", "#### e2e", "#### ghost", 'unknown surface concern "ghost"'],
  ]
  test.each(cases)("%s", (_name, from, to, fragment) => {
    const found = reasons(repo({ [SURFACES]: [from, to] }))
    expect(found.some((r) => r.includes(fragment))).toBe(true)
  })

  test("N/A is accepted where the surface allows it", () => {
    expect(reasons(repo()).filter((r) => r.startsWith(SURFACES))).toEqual([])
  })
  test("out-of-order rows", () => {
    const root = swapLines(repo(), SURFACES, "| `e2e` | `playwright`", "| `visual` | Built-in")
    expect(reasons(root).some((r) => r.includes('"e2e" is out of spec order'))).toBe(true)
  })
  test("a finding names the file and the line inside the section", () => {
    const found = check(repo({ [SURFACES]: ["1.50.0 · 2026-01-07 · active", "1.50.0 · 2026-01-07 · stable"] }))
    expect(found).toContainEqual({ file: SURFACES, line: 9, reason: 'unknown status "stable"' })
  })
  test("a missing surfaces file is a finding", () => {
    const root = repo()
    root.delete(SURFACES)
    expect(reasons(root)).toEqual([`${SPEC}:1: surfaces file ${SURFACES} is missing`])
  })
  test("--language skips the surfaces file", () => {
    const root = repo({ [SURFACES]: ["Checked 2026-01-10.", ""] })
    expect(reasons(root, "py")).toEqual([])
  })
})

describe("registration findings", () => {
  test("registered file missing", () => {
    const root = repo()
    root.delete(SH)
    expect(reasons(root, "sh").some((r) => r.includes(`registered file ${SH} is missing`))).toBe(true)
  })
  test("file not linked from the skill", () => {
    const root = repo({ "plugins/lang/skills/lang-sh/SKILL.md": ["[shell](references/shell.md)", "nothing"] })
    expect(reasons(root, "sh").some((r) => r.startsWith(`${SH}:1: not linked`))).toBe(true)
  })
  test("file linked only through a second hop is not linked", () => {
    const root = repo({
      "plugins/lang/skills/lang-x/references/more.md": ["[quality](quality.md)", "[deeper](deeper.md)"],
    })
    root.set("plugins/lang/skills/lang-x/references/deeper.md", "[quality](quality.md)\n")
    expect(reasons(root, "py").some((r) => r.startsWith(`${PY_QUALITY}:1: not linked`))).toBe(true)
  })
  test("skill not found", () => {
    const root = repo({ [SPEC]: ["| lang-sh |", "| lang-ghost |"] })
    expect(reasons(root, "sh").some((r) => r.includes('skill "lang-ghost" not found'))).toBe(true)
  })
  test("a concern with no row in any file", () => {
    const root = repo({ [TF]: ["| `drift` |", "| `driftx` |"] })
    expect(reasons(root, "tf").some((r) => r.includes('tf: no row for concern "drift"'))).toBe(true)
  })
})

describe("staleRows", () => {
  test("lists rows older than the limit with their age, skipping rows without a date", () => {
    expect(staleRows(ROOT, 26, "2026-02-01", undefined, filesOf(VALID))).toEqual([
      `${PY_TESTING}:9: unit released 2026-01-02 (30 days old)`,
      `${PY_QUALITY}:9: lint released 2026-01-05 (27 days old)`,
      `${PY_QUALITY}:10: types released 2026-01-04 (28 days old)`,
    ])
  })
  test("covers surface rows, with the surface in the label and a file-relative line", () => {
    expect(staleRows(ROOT, 20, "2026-02-01", undefined, filesOf(VALID)).filter((r) => r.startsWith(SURFACES))).toEqual([
      `${SURFACES}:9: web/e2e released 2026-01-07 (25 days old)`,
      `${SURFACES}:24: api/e2e released 2026-01-08 (24 days old)`,
    ])
  })
  test("is empty when all rows are recent", () => {
    expect(staleRows(ROOT, 365, "2026-02-01", undefined, filesOf(VALID))).toEqual([])
  })
})

describe("staleRows with a language filter", () => {
  test("reports only that language's rows, not other languages or surfaces", () => {
    const out = staleRows(ROOT, 0, TODAY, "sh", filesOf(VALID))
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((r) => r.startsWith(`${SH}:`))).toBe(true)
  })
})

describe("checkLanguage", () => {
  test("is the unit used by checkRepo", () => {
    const spec = parseSpec(VALID.get(SPEC) ?? "").spec
    const shared = parseShared(VALID.get(SHARED) ?? "").shared
    expect(checkLanguage({ root: ROOT, spec, shared, today: TODAY, files: filesOf(VALID) }, "py")).toEqual([])
  })
})

describe("shared tools Maintenance and Run cells", () => {
  const TOOL = "| tflint-shared | tflint | lint | >= 0.50.0 · 2026-01-03 · active | every-pr | - |"
  const sharedReasons = (from: string, to: string) =>
    parseShared(readFileSync(path.join(FIXTURE, SHARED), "utf8").replace(from, to), SHARED, [
      "every-pr",
      "diff-pr",
      "bounded-pr",
      "scheduled",
      "release",
      "on-demand",
    ]).findings.map((f) => f.reason)

  test("the valid fixture, with Family and Service rows, is clean", () => {
    expect(sharedReasons(TOOL, TOOL)).toEqual([])
  })

  test.each([
    ["an exact pin", ">= 0.50.0", "0.50.0", "Maintenance must be"],
    ["a missing status", " · active", "", "Maintenance must be"],
    ["an unknown status", "· active", "· stable", 'unknown status "stable"'],
    ["a bad date", "2026-01-03", "2026-13-45", "is not YYYY-MM-DD"],
    ["a date after Checked", "2026-01-03", "2026-12-01", "is after Checked 2026-11-16"],
    ["a Family link without an anchor", "[Family tool](#family-tool)", "Family tool", 'Family must be "Family: [text](#section)"'],
    ["a Family anchor with no heading", "(#family-tool)", "(#ghost)", 'Family anchor "#ghost" matches no'],
    ["an empty Service note", "Service: hosted only", "Service:", "Service needs a note"],
  ])("rejects %s", (_name, from, to, reason) => {
    const base = readFileSync(path.join(FIXTURE, SHARED), "utf8").replace("# Shared tools\n", "# Shared tools\n\nChecked 2026-11-16.\n")
    const out = parseShared(base.replace(from, to), SHARED, ["every-pr", "scheduled"]).findings.map((f) => f.reason)
    expect(out.some((r) => r.includes(reason))).toBe(true)
  })

  test("rejects an unknown Run token", () => {
    expect(sharedReasons("| every-pr | - |", "| every-prr | - |")).toContain('unknown run token "every-prr"')
  })

  test("checkRepo reports a bad shared Maintenance cell", () => {
    const root = repo({ [SHARED]: [">= 0.50.0", "0.50.0"] })
    expect(reasons(root).some((r) => r.startsWith(`${SHARED}:`) && r.includes("Maintenance must be"))).toBe(true)
  })
})

describe("tradeoff coverage", () => {
  const cases: [string, string, string, string, string][] = [
    ["language: Default tool", PY_TESTING, "- **pytest**: fixtures and parametrize.\n", "", 'lacks a "- **pytest**:" bullet'],
    ["language: first alternative", PY_TESTING, "- **unittest**: standard library only.\n", "", 'lacks a "- **unittest**:" bullet'],
    ["language: last alternative", PY_TESTING, "- **nose2**: legacy suites only.\n", "", 'lacks a "- **nose2**:" bullet'],
    ["surface: Default tool", SURFACES, "- **playwright**: multi-browser and fast; costs a browser download.\n", "", 'lacks a "- **playwright**:" bullet'],
    ["surface: alternative", SURFACES, "- **selenium**: runs legacy grids; slow and flaky.\n", "", 'lacks a "- **selenium**:" bullet'],
  ]
  test.each(cases)("%s", (_name, file, from, to, fragment) => {
    expect(reasons(repo({ [file]: [from, to] })).some((r) => r.includes(fragment))).toBe(true)
  })
  test("a bullet named after the alternative, with a suffix, covers it", () => {
    const root = repo({ [PY_TESTING]: ["- **nose2**:", "- **nose2 (legacy)**:"] })
    expect(reasons(root)).toEqual([])
  })
  test("a bullet whose name only starts with the alternative does not cover it", () => {
    const root = repo({ [PY_TESTING]: ["- **nose2**:", "- **nose2-watcher**:"] })
    expect(reasons(root).some((r) => r.includes('lacks a "- **nose2**:" bullet'))).toBe(true)
  })
  test("a bullet with a parenthesised note after the name covers the Default", () => {
    const root = repo({ [PY_TESTING]: ["- **pytest**:", "- **pytest** (plugins):"] })
    expect(reasons(root)).toEqual([])
  })
  test("an entry whose every bullet carries a parenthesised note still has bullets", () => {
    const tree = repo()
    const text = tree.get(PY_TESTING) ?? ""
    tree.set(PY_TESTING, text.replace(/^- \*\*([^*]+)\*\*:/gm, "- **$1** (note):"))
    expect(reasons(tree)).toEqual([])
  })
  test.each([
    ["no bullet for it", "- **unittest**:", "- **unittest**:", true],
    ["its own bullet", "- **unittest**:", "- **node:test**:", false],
  ])("a backticked alternative name with a colon, %s", (_, from, to, missing) => {
    const root = repo({ [PY_TESTING]: ["`unittest`: no dependencies allowed", "`node:test`: no dependencies allowed"] })
    root.set(PY_TESTING, (root.get(PY_TESTING) ?? "").replace(from, to))
    expect(reasons(root).some((r) => r.includes('lacks a "- **node:test**:" bullet'))).toBe(missing)
  })
  test("a Built-in Default needs bullets for the alternatives only", () => {
    const root = repo({
      [SURFACES]: [
        "| `visual` | Built-in: playwright screenshots | - | Built-in | None |",
        "| `visual` | Built-in: playwright screenshots | - | Built-in | `a`: x; `b`: y |",
      ],
    })
    const found = reasons(root)
    expect(found.some((r) => r.includes('need a "#### visual"'))).toBe(true)
  })
})

describe("No maintained tool Default", () => {
  const ROW = "`pytest` | >= 8.3.0 · 2026-01-02 · active | `pytest --version` · `uv tool install pytest`"
  const unitReasons = (cells: string) => reasons(repo({ [PY_TESTING]: [ROW, `No maintained tool: review by hand | ${cells}`] }), "py")
  test("accepts Maintenance and Install of `-`", () => {
    expect(unitReasons("- | -")).toEqual([])
  })
  test("rejects a Maintenance other than `-`", () => {
    expect(unitReasons(">= 1.0.0 · 2026-01-02 · active | -")).toEqual([`${PY_TESTING}:9: Maintenance must be "-" for No maintained tool`])
  })
  test("rejects an Install other than `-`", () => {
    expect(unitReasons("- | `a` · `b`")).toEqual([`${PY_TESTING}:9: Install must be "-" for this Default, found "\`a\` · \`b\`"`])
  })
})

describe("duplicate sections in a language file", () => {
  test("a second ## Concerns section is a finding", () => {
    const root = repo({ [PY_QUALITY]: ["## Concerns", "## Concerns\n\n## Concerns"] })
    expect(reasons(root).some((r) => r.includes('duplicate section "Concerns"'))).toBe(true)
  })
})

describe("the spec's contract concern", () => {
  test("requires every-pr in Run", () => {
    const real = readFileSync(path.join(import.meta.dir, "..", SPEC), "utf8")
    expect(parseSpec(real).spec.concerns.find((c) => c.id === "contract")?.runMust).toContain("every-pr")
  })
})

describe("table shape", () => {
  const table = (header: string, sep: string, row: string) => `## A\n\n${header}\n${sep}\n${row}\n`
  test("an escaped pipe stays inside its cell and is unescaped", () => {
    expect(parseTable(table("| X | Y |", "|---|---|", "| a \\| b | c |"), "A")?.rows[0]?.cells).toEqual(["a | b", "c"])
  })
  test("an escaped pipe in a language row does not shift cells", () => {
    const root = repo({ [PY_TESTING]: ["Plugins that patch internals", "Plugins that a \\| b"] })
    expect(reasons(root)).toEqual([])
  })
  test("a delimiter row with fewer columns than the header is rejected", () => {
    expect(parseTable(table("| X | Y |", "|---|", "| 1 | 2 |"), "A")).toBeUndefined()
  })
  test("a spec table with a short delimiter row is reported", () => {
    const root = repo({ [SPEC]: ["| Kind | Meaning |\n|---|---|", "| Kind | Meaning |\n|---|"] })
    expect(reasons(root).some((r) => r.includes("Kinds"))).toBe(true)
  })
  test("a second section for the same surface is a finding", () => {
    const root = repo({ [SURFACES]: ["## api", "## web\n\n## api"] })
    expect(reasons(root).some((r) => r.includes('duplicate section "web"'))).toBe(true)
  })
})

describe("main", () => {
  const run = (argv: string[], tree: Tree) => {
    const out: string[] = []
    const err: string[] = []
    const code = main(argv, { root: ROOT, files: filesOf(tree), today: TODAY, stdout: (s) => out.push(s), stderr: (s) => err.push(s) })
    return { code, out, err }
  }
  const brokenPy = () => repo({ [PY_TESTING]: ["every-pr + diff-pr", "every-pr + yearly"] })
  test("exits 0 and prints clean for a clean repo", () => {
    expect(run([], repo())).toEqual({ code: 0, out: ["check-concerns: clean"], err: [] })
  })
  test("exits 1 with findings on stderr", () => {
    const { code, out, err } = run([], brokenPy())
    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err[0]).toContain(`${PY_TESTING}:9: unknown run token "yearly"`)
    expect(err.at(-1)).toBe("check-concerns: 1 finding(s)")
  })
  test("--language reaches the checker", () => {
    const root = brokenPy()
    expect(run(["--language", "sh"], root).code).toBe(0)
    expect(run(["--language", "py"], root).code).toBe(1)
  })
  test.each(["abc", "-1"])("invalid --max-age %s exits 2 with the message", (value) => {
    const { code, err } = run([`--max-age=${value}`], repo())
    expect(code).toBe(2)
    expect(err).toEqual(["check-concerns: --max-age needs a non-negative number of days"])
  })
  test.each([
    ["an unknown option", ["--bogus"]],
    ["a missing option value", ["--language"]],
  ])("%s exits 2 with a usage message", (_name, argv) => {
    const { code, out, err } = run(argv, repo())
    expect(code).toBe(2)
    expect(out).toEqual([])
    expect(err[0]).toStartWith("check-concerns: ")
    expect(err.join("\n")).toContain("usage: bun scripts/check-concerns.ts [--language <id>] [--max-age <days>]")
  })
  test("--max-age reports stale rows without changing the exit status", () => {
    const clean = run(["--max-age", "0"], repo())
    expect(clean.code).toBe(0)
    expect(clean.out[0]).toMatch(/^check-concerns: [1-9]\d* row\(s\) older than 0 days$/)
    expect(run(["--max-age", "0"], brokenPy()).code).toBe(1)
  })
})
