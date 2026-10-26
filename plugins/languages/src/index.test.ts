import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { SKILL_NAMES } from "./index.ts"

describe("setup", () => {
  test("registers the three skills and disposes them", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    expect([...fake.skills.keys()]).toEqual([...SKILL_NAMES])
    for (const skill of fake.skills.values())
      expect(String(skill.content)).not.toMatch(/skill:\/\/|rule:\/\/|_quality`? tool|\bbash\b/)
    expect(String(fake.skills.get("typescript-quality")?.content)).toContain("satisfies readonly Union[]")
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.skills.size).toBe(0)
  })

  test("keeps a user's skill of the same id", async () => {
    const fake = createFakeContext({ skills: [{ id: "go-quality", content: "mine" }] })
    await plugin.setup(fake.context)
    expect(fake.skills.get("go-quality")?.content).toBe("mine")
  })

  test("the built entry resolves the shipped skills from the package root", async () => {
    const built = (await import(join(import.meta.dir, "..", "index.js"))) as { SKILL_PATHS: string[] }
    expect(built.SKILL_PATHS[0]).toBe(join(import.meta.dir, "..", "skills", "go-quality", "SKILL.md"))
    for (const path of built.SKILL_PATHS) expect(existsSync(path)).toBe(true)
  })
})
