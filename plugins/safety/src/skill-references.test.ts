import { describe, expect, test } from "bun:test"
import { listedSkills, skillDirectories } from "./skill-references.ts"

describe("skillDirectories", () => {
  test("keeps the directory of each SKILL.md", () => {
    const skills = [{ path: "/h/.cache/opencode/npm/p/skills/a/SKILL.md" }, { path: "/opt/skills/b/SKILL.md" }]
    expect(skillDirectories(skills, "/h")).toEqual(["/h/.cache/opencode/npm/p/skills/a", "/opt/skills/b"])
  })

  test.each([
    ["the filesystem root", "/SKILL.md"],
    ["the home folder", "/u/h/SKILL.md"],
    ["a parent of the home folder", "/u/SKILL.md"],
    ["a relative path", "skills/a/SKILL.md"],
    ["a file that is not SKILL.md", "/opt/skills/a/notes.md"],
  ])("skips %s", (_, path) => {
    expect(skillDirectories([{ path }], "/u/h")).toEqual([])
  })
})

describe("listedSkills", () => {
  test("reads the client's { data } shape and a bare array", () => {
    const skill = { path: "/opt/skills/a/SKILL.md" }
    expect(listedSkills({ data: [skill] })).toEqual([skill])
    expect(listedSkills([skill])).toEqual([skill])
    expect(listedSkills(undefined)).toEqual([])
  })
})
