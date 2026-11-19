import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRepo } from "./repo.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "plugin-audit-repo-"))
}

function write(root: string, file: string, text: string): void {
  mkdirSync(join(root, file, ".."), { recursive: true })
  writeFileSync(join(root, file), text)
}

describe("loadRepo", () => {
  test("reads each plugin directory with its sources, skills, agents and test presence", () => {
    const root = tmp()
    try {
      write(root, "package.json", JSON.stringify({ name: "root", devDependencies: { "@biomejs/biome": "2.6.8" } }))
      write(root, ".release-please-manifest.json", JSON.stringify({ "plugins/demo": "0.1.0" }))
      write(root, "release-please-config.json", JSON.stringify({ packages: { "plugins/demo": {} } }))
      write(root, "plugins/demo/package.json", JSON.stringify({ version: "0.1.0" }))
      write(root, "plugins/demo/src/index.ts", "export {}")
      write(root, "plugins/demo/src/index.test.ts", "test")
      write(root, "plugins/demo/skills/s/SKILL.md", "# s")
      write(root, "plugins/demo/agents/a.md", "agent")
      write(root, "plugins/demo/README.md", "# demo")
      mkdirSync(join(root, "plugins/empty"))

      const repo = loadRepo(root)

      expect(repo.root).toMatchObject({ name: "root" })
      expect(repo.releaseManifest).toEqual({ "plugins/demo": "0.1.0" })
      expect(repo.plugins.map((p) => p.name)).toEqual(["demo"])
      const [demo] = repo.plugins
      expect(demo?.src.map((f) => f.path)).toEqual(["plugins/demo/src/index.ts"])
      expect(demo?.tests).toEqual(["index.test.ts"])
      expect(demo?.skills.map((f) => f.path)).toEqual(["plugins/demo/skills/s/SKILL.md"])
      expect(demo?.agents.map((f) => f.path)).toEqual(["plugins/demo/agents/a.md"])
      expect(demo).toMatchObject({ hasSkillsDir: true, hasAgentsDir: true, hasReadme: true, hasChangelog: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
