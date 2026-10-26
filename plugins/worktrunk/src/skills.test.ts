import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { loadSkills, parseSkillMarkdown, SKILL_NAMES, SKILLS_DIRECTORY } from "./skills.ts"

describe("parseSkillMarkdown", () => {
  test("reads name, description and body", () => {
    expect(parseSkillMarkdown('---\nname: demo\ndescription: "Does a thing: well"\n---\n\n# Demo\n\nBody\n')).toEqual({
      name: "demo",
      description: "Does a thing: well",
      autoinvoke: true,
      content: "# Demo\n\nBody",
    })
  })
  test("honours disable-model-invocation", () => {
    expect(parseSkillMarkdown("---\nname: demo\ndisable-model-invocation: true\n---\nx").autoinvoke).toBe(false)
  })
  test("requires frontmatter and a name", () => {
    expect(() => parseSkillMarkdown("# no frontmatter")).toThrow()
    expect(() => parseSkillMarkdown("---\ndescription: x\n---\nbody")).toThrow("no name")
  })
})

describe("shipped skills", () => {
  test("every skill loads, matches its directory and carries no Oh My Pi references", async () => {
    const skills = await loadSkills()
    expect(skills.map((skill) => skill.name)).toEqual([...SKILL_NAMES])
    for (const skill of skills) {
      expect(skill.path).toBe(join(SKILLS_DIRECTORY, skill.name, "SKILL.md"))
      expect(skill.description).toBeTruthy()
      expect(skill.content).not.toMatch(/skill:\/\/|rule:\/\/|\bomp\b|oh-my-pi|isolat/i)
    }
  })
})

describe("worktrunk-preflight script", () => {
  const python = Bun.which("python3")
  test.skipIf(python === null)("its Python regression tests pass", () => {
    const directory = join(SKILLS_DIRECTORY, "worktrunk-preflight")
    const result = Bun.spawnSync([python ?? "python3", "-m", "unittest", "-q", "test_preflight.py"], {
      cwd: directory,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  }, 30_000)
})
