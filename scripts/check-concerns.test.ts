import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkLanguage, checkRepo, classifyDefault, parseShared, parseSpec, parseTable, staleRows } from "./check-concerns.ts"

const FIXTURE = path.join(import.meta.dir, "fixtures", "concerns", "valid")
const REF = "plugins/toolchain/skills/toolchain-languages/references"
const SPEC = `${REF}/concerns.md`
const SHARED = `${REF}/shared-tools.md`
const PY_TESTING = "plugins/lang/skills/lang-x/references/testing.md"
const PY_QUALITY = "plugins/lang/skills/lang-x/references/quality.md"
const SH = "plugins/lang/skills/lang-sh/references/shell.md"
const TF = "plugins/lang/skills/lang-tf/references/tf.md"
const TODAY = "2026-02-01"

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** Copy the valid fixture and apply `file: [from, to]` replacements; each `from` must exist. */
function repo(edits: Record<string, [string, string]> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "concerns-"))
  temps.push(root)
  cpSync(FIXTURE, root, { recursive: true })
  for (const [file, [from, to]] of Object.entries(edits)) {
    const abs = path.join(root, file)
    const text = readFileSync(abs, "utf8")
    if (!text.includes(from)) throw new Error(`fixture ${file} lacks ${JSON.stringify(from)}`)
    writeFileSync(abs, text.replace(from, to))
  }
  return root
}
const reasons = (root: string, language?: string) =>
  checkRepo(root, { language, today: TODAY }).map((f) => `${f.file}:${f.line}: ${f.reason}`)

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
    expect(parsed.spec.languages[0]).toMatchObject({ id: "py", kind: "managed", skill: "lang-x" })
    expect(parsed.spec.languages[0]?.files).toHaveLength(2)
  })
  test.each([
    ["duplicate concern id", "| lint | Linting |", "| unit | Linting |", 'duplicate concern id "unit"'],
    ["unknown group", "| testing |", "| nope |", 'unknown group "nope"'],
    ["unknown kind in N/A", "| shell, iac |", "| shell, ghost |", 'unknown kind "ghost" in N/A allowed for'],
    ["unknown run token", "| scheduled |\n\n## Kinds", "| yearly |\n\n## Kinds", 'unknown run token "yearly"'],
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
  test("is clean for every language", () => {
    expect(reasons(repo())).toEqual([])
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
    rmSync(path.join(root, SPEC))
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
    ["Tradeoffs entry without bullets", PY_TESTING, "- **pytest**: fixtures and parametrize.\n- **unittest**: standard library only.", "Nothing.", 'has no "- **tool**:" bullet'],
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
    const found = checkRepo(repo({ [PY_QUALITY]: ["| `lint` |", "| `lintt` |"] }), { today: TODAY })
    expect(found).toContainEqual({ file: PY_QUALITY, line: 9, reason: 'unknown concern id "lintt"' })
  })
  test("out-of-order rows", () => {
    const root = repo()
    const abs = path.join(root, PY_QUALITY)
    const lines = readFileSync(abs, "utf8").split("\n")
    const [a, b] = [lines.findIndex((l) => l.startsWith("| `lint`")), lines.findIndex((l) => l.startsWith("| `types`"))]
    ;[lines[a], lines[b]] = [lines[b] as string, lines[a] as string]
    writeFileSync(abs, lines.join("\n"))
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

describe("registration findings", () => {
  test("registered file missing", () => {
    const root = repo()
    rmSync(path.join(root, SH))
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
    writeFileSync(path.join(root, "plugins/lang/skills/lang-x/references/deeper.md"), "[quality](quality.md)\n")
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
    expect(staleRows(repo(), 26, "2026-02-01")).toEqual([
      `${PY_TESTING}:9: unit released 2026-01-02 (30 days old)`,
      `${PY_QUALITY}:9: lint released 2026-01-05 (27 days old)`,
      `${PY_QUALITY}:10: types released 2026-01-04 (28 days old)`,
    ])
  })
  test("is empty when all rows are recent", () => {
    expect(staleRows(repo(), 365, "2026-02-01")).toEqual([])
  })
})

describe("checkLanguage", () => {
  test("is the unit used by checkRepo", () => {
    const root = repo()
    const spec = parseSpec(readFileSync(path.join(root, SPEC), "utf8")).spec
    const shared = parseShared(readFileSync(path.join(root, SHARED), "utf8")).shared
    expect(checkLanguage({ root, spec, shared, today: TODAY }, "py")).toEqual([])
  })
})
