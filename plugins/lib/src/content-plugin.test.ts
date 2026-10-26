import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { contentPaths, contentPlugin } from "./content-plugin.ts"
import { createFakeContext } from "./testing.ts"

function fixture(): { root: string; moduleUrl: string } {
  const root = mkdtempSync(join(tmpdir(), "content-plugin-"))
  mkdirSync(join(root, "dist"))
  mkdirSync(join(root, "skills", "alpha"), { recursive: true })
  mkdirSync(join(root, "skills", "empty"))
  mkdirSync(join(root, "agents"))
  writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A.\n---\nAlpha body")
  writeFileSync(join(root, "agents", "helper.md"), '---\ndescription: "Helps."\nmode: subagent\npermissions: []\n---\nHelp.')
  return { root, moduleUrl: pathToFileURL(join(root, "dist", "index.js")).href }
}

describe("contentPlugin", () => {
  test("finds skills/*/SKILL.md and agents/*.md one level above the module", () => {
    const { root, moduleUrl } = fixture()
    try {
      expect(contentPaths(moduleUrl)).toEqual({
        skills: [join(root, "skills", "alpha", "SKILL.md")],
        agents: [join(root, "agents", "helper.md")],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("registers both and disposes them", async () => {
    const { root, moduleUrl } = fixture()
    try {
      const fake = createFakeContext()
      const cleanup = await contentPlugin("test.content", moduleUrl).setup(fake.context)
      expect(fake.skills.get("alpha")).toMatchObject({ description: "A.", content: "Alpha body" })
      expect(fake.agents.get("helper")).toMatchObject({ mode: "subagent", system: "Help." })
      await cleanup?.()
      expect(fake.active()).toBe(0)
      expect(fake.skills.size).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
