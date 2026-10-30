import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installFormulas } from "./formulas.ts"

const NAMES = ["alpha", "mol-beta"] as const

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lib-formulas-"))
  const sourceDir = join(root, "shipped")
  const repo = join(root, "repo")
  mkdirSync(sourceDir)
  mkdirSync(repo)
  for (const name of NAMES) writeFileSync(join(sourceDir, `${name}.formula.toml`), `formula = "${name}"\n`)
  return { root, repo, install: (force = false) => installFormulas({ workspace: repo, cwd: "/", names: NAMES, sourceDir, force }) }
}

describe("installFormulas", () => {
  test("copies every formula once, then reports them unchanged; a relative workspace resolves against cwd", () => {
    const { root, repo, install } = fixture()
    try {
      mkdirSync(join(repo, ".beads"))
      const first = install()
      expect(first).toMatchObject({ ok: true, copied: [...NAMES], unchanged: [], destination: join(repo, ".beads", "formulas") })
      expect(readdirSync(join(repo, ".beads", "formulas")).sort()).toEqual(NAMES.map((name) => `${name}.formula.toml`))
      const second = installFormulas({ workspace: "repo", cwd: root, names: NAMES, sourceDir: join(root, "shipped") })
      expect(second).toMatchObject({ ok: true, copied: [], unchanged: [...NAMES] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("refuses a workspace without .beads, and a divergent copy unless force", () => {
    const { root, repo, install } = fixture()
    try {
      expect(install()).toMatchObject({ ok: false })
      mkdirSync(join(repo, ".beads", "formulas"), { recursive: true })
      const local = join(repo, ".beads", "formulas", "alpha.formula.toml")
      writeFileSync(local, "formula = \"local\"\n")
      const refused = install()
      expect(refused.ok).toBe(false)
      expect(refused.text).toContain(local)
      expect(readFileSync(local, "utf8")).toBe("formula = \"local\"\n")
      expect(readdirSync(join(repo, ".beads", "formulas"))).toEqual(["alpha.formula.toml"])
      expect(install(true)).toMatchObject({ ok: true, copied: [...NAMES] })
      expect(readFileSync(local, "utf8")).toBe("formula = \"alpha\"\n")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("refuses a symlinked formulas directory and a missing shipped formula", () => {
    const { root, repo, install } = fixture()
    try {
      mkdirSync(join(repo, ".beads"))
      mkdirSync(join(root, "elsewhere"))
      symlinkSync(join(root, "elsewhere"), join(repo, ".beads", "formulas"))
      expect(install()).toMatchObject({ ok: false })
      expect(readdirSync(join(root, "elsewhere"))).toEqual([])
      rmSync(join(repo, ".beads", "formulas"))
      rmSync(join(root, "shipped", "mol-beta.formula.toml"))
      expect(install().text).toContain("shipped formula missing")
      expect(readdirSync(join(repo, ".beads"))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
