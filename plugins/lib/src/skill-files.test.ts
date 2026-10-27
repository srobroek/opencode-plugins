import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSkillFile, registerSkills, skillInfo, skillPaths } from "./skill-files.ts"

describe("parseSkillFile", () => {
  test("reads name, description and body", () => {
    const file = parseSkillFile('---\nname: demo\ndescription: "Does a thing: well"\n---\n# Demo\n\nBody.\n')
    expect(file).toEqual({ name: "demo", description: "Does a thing: well", content: "# Demo\n\nBody.\n" })
  })

  test("description is optional; a missing name throws", () => {
    expect(parseSkillFile("---\nname: bare\n---\nx")).toEqual({ name: "bare", content: "x" })
    expect(() => parseSkillFile("---\ndescription: nameless\n---\nx")).toThrow("no name")
    expect(() => parseSkillFile("no frontmatter")).toThrow("no name")
  })

  test("disable-model-invocation: true turns autoinvoke off", () => {
    expect(parseSkillFile("---\nname: manual\ndisable-model-invocation: true\n---\nx")).toEqual({
      name: "manual",
      autoinvoke: false,
      content: "x",
    })
    expect(parseSkillFile("---\nname: auto\ndisable-model-invocation: false\n---\nx")).not.toHaveProperty("autoinvoke")
  })

  test("metadata opencode/autoinvoke: false turns autoinvoke off and wins over disable-model-invocation", () => {
    expect(parseSkillFile("---\nname: ref\nmetadata:\n  opencode/autoinvoke: false\n---\nx")).toEqual({
      name: "ref",
      autoinvoke: false,
      content: "x",
    })
    expect(
      parseSkillFile("---\nname: on\ndisable-model-invocation: true\nmetadata:\n  opencode/autoinvoke: true\n---\nx"),
    ).not.toHaveProperty("autoinvoke")
    expect(
      parseSkillFile("---\nname: other\nnotes:\n  opencode/autoinvoke: false\n---\nx"),
    ).not.toHaveProperty("autoinvoke")
  })
})

describe("skillPaths", () => {
  test("lists <dir>/<name>/SKILL.md, sorted, skipping directories without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-paths-"))
    try {
      for (const name of ["beta", "alpha", "empty"]) mkdirSync(join(dir, name))
      writeFileSync(join(dir, "beta", "SKILL.md"), "---\nname: beta\n---\n")
      writeFileSync(join(dir, "alpha", "SKILL.md"), "---\nname: alpha\n---\n")
      writeFileSync(join(dir, "loose.md"), "x")
      expect(skillPaths(dir)).toEqual([join(dir, "alpha", "SKILL.md"), join(dir, "beta", "SKILL.md")])
      expect(skillPaths(join(dir, "missing"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("registerSkills", () => {
  test("adds shipped skills with their absolute path and keeps an existing one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-files-"))
    try {
      const fresh = join(dir, "fresh.md")
      const taken = join(dir, "taken.md")
      writeFileSync(fresh, "---\nname: fresh\ndescription: new\n---\nbody")
      writeFileSync(taken, "---\nname: taken\n---\nplugin copy")
      expect(skillInfo(fresh)).toMatchObject({ id: "fresh", name: "fresh", path: fresh, content: "body" })

      const skills = new Map<string, unknown>([["taken", { id: "taken", content: "user copy" }]])
      let disposed = false
      const domain = {
        transform: async (callback: (editor: unknown) => void) => {
          callback({
            get: (id: string) => skills.get(id),
            add: (info: { id: string }) => void skills.set(info.id, info),
          })
          return {
            dispose: async () => {
              disposed = true
            },
          }
        },
      }
      const registration = await registerSkills(domain as never, [fresh, taken])
      expect(skills.get("fresh")).toMatchObject({ path: fresh, description: "new" })
      expect(skills.get("taken")).toEqual({ id: "taken", content: "user copy" })
      await registration.dispose()
      expect(disposed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
