import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSkillFile, registerSkills, skillInfo } from "./skill-files.ts"

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
