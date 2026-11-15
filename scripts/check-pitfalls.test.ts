import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkPitfalls, checkSkillDir } from "./check-pitfalls.ts"

const entry = (title: string) =>
  `## ${title}\n\n- **Symptom:** \`cannot resolve\`\n- **Cause:** a cd.\n- **Fix:** pass workdir.\n`

describe("checkPitfalls", () => {
  test("accepts well formed entries", () => {
    expect(checkPitfalls("p.md", `# Pitfalls\n\n${entry("One")}\n${entry("Two")}`)).toEqual([])
  })
  test("flags a missing field, naming the entry line", () => {
    const text = "# P\n\n## One\n\n- **Symptom:** `x`\n- **Fix:** y\n"
    expect(checkPitfalls("p.md", text)).toEqual([
      { file: "p.md", line: 3, reason: 'entry lacks "**Cause:**" (after the previous field)' },
    ])
  })
  test("flags fields out of order", () => {
    const text = "## One\n- **Cause:** a\n- **Symptom:** `x`\n- **Fix:** y\n"
    expect(checkPitfalls("p.md", text).map((f) => f.reason)).toEqual(['entry lacks "**Cause:**" (after the previous field)'])
  })
  test("flags a Symptom without a code span", () => {
    const text = "## One\n- **Symptom:** it breaks\n- **Cause:** a\n- **Fix:** b\n"
    expect(checkPitfalls("p.md", text).map((f) => f.reason)).toEqual(["Symptom quotes no exact text in a code span"])
  })
  test("flags a file with no entries", () => {
    expect(checkPitfalls("p.md", "# Pitfalls\n")).toHaveLength(1)
  })
})

describe("checkSkillDir", () => {
  const skill = (pointer: boolean) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pitfalls-"))
    mkdirSync(path.join(dir, "references"))
    writeFileSync(path.join(dir, "references", "pitfalls.md"), entry("One"))
    writeFileSync(path.join(dir, "SKILL.md"), pointer ? "Read references/pitfalls.md.\n" : "No link.\n")
    return dir
  }
  test("requires SKILL.md to point to the file", () => {
    const linked = skill(true)
    const unlinked = skill(false)
    expect(checkSkillDir(linked)).toEqual([])
    expect(checkSkillDir(unlinked).map((f) => f.reason)).toEqual(["SKILL.md does not point to references/pitfalls.md"])
    rmSync(linked, { recursive: true })
    rmSync(unlinked, { recursive: true })
  })
  test("a skill without the file is fine", () => {
    expect(checkSkillDir("/nonexistent-skill-dir")).toEqual([])
  })
})
