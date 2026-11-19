import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { SKILL_PATH } from "./index.ts"

type Result = { content: string; metadata: Record<string, unknown> }
type Execute = (input: unknown, context: unknown) => Promise<Result>

const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }
let root: string
let fixtures: string
let previous: string | undefined

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-audit-index-"))
  fixtures = mkdtempSync(join(tmpdir(), "plugin-audit-fixtures-"))
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@opencode/plugin": "2.3.0" } }))
  writeFileSync(join(root, ".release-please-manifest.json"), JSON.stringify({ "plugins/demo": "0.1.0" }))
  writeFileSync(join(root, "release-please-config.json"), JSON.stringify({ packages: { "plugins/demo": {} } }))
  mkdirSync(join(root, "plugins/demo/src"), { recursive: true })
  writeFileSync(
    join(root, "plugins/demo/package.json"),
    JSON.stringify({
      version: "0.1.0",
      private: true,
      type: "module",
      exports: { ".": "./dist/index.js" },
      files: ["dist", "index.js"],
      peerDependencies: { "@opencode/plugin": "^2.1.4" },
      peerDependenciesMeta: { "@opencode/plugin": { optional: true } },
      dependencies: { "left-pad": "1.0.0" },
      "opencode-plugins": { scope: "global" },
    }),
  )
  writeFileSync(join(root, "plugins/demo/src/index.ts"), 'Plugin.define({ id: "srobroek.demo" })\neditor.add({ name: "demo_run" })')
  writeFileSync(join(root, "plugins/demo/src/index.test.ts"), "")
  writeFileSync(join(root, "plugins/demo/README.md"), "")
  writeFileSync(join(root, "plugins/demo/CHANGELOG.md"), "")
  writeFileSync(
    join(fixtures, "npm___at__opencode__plugin.json"),
    JSON.stringify({ "dist-tags": { latest: "2.4.1" }, versions: { "2.3.0": {}, "2.4.1": {} } }),
  )
  writeFileSync(join(fixtures, "npm_left-pad.json"), JSON.stringify({ "dist-tags": { latest: "1.3.0" }, versions: { "1.0.0": {}, "1.3.0": {} } }))
  previous = process.env.DEP_UPDATE_FIXTURE_DIR
  process.env.DEP_UPDATE_FIXTURE_DIR = fixtures
})

afterAll(() => {
  if (previous === undefined) delete process.env.DEP_UPDATE_FIXTURE_DIR
  else process.env.DEP_UPDATE_FIXTURE_DIR = previous
  rmSync(root, { recursive: true, force: true })
  rmSync(fixtures, { recursive: true, force: true })
})

async function load() {
  const fake = createFakeContext({ directory: root })
  const cleanup = await plugin.setup(fake.context)
  return { fake, cleanup, tool: fake.tools.get("plugin_audit_scan")?.execute as Execute }
}

describe("setup", () => {
  test("registers the scan tool and the skill, and disposes them", async () => {
    const { fake, cleanup } = await load()
    expect([...fake.tools.keys()]).toEqual(["plugin_audit_scan"])
    expect(fake.skills.get("plugin-audit")).toMatchObject({ id: "plugin-audit", path: SKILL_PATH })
    await cleanup?.()
    expect(fake.tools.size).toBe(0)
    expect(fake.skills.size).toBe(0)
  })

  test("the schema is closed and accepts no fixture or network seam", async () => {
    const { fake } = await load()
    const input = fake.tools.get("plugin_audit_scan")?.input as { properties: object; additionalProperties: boolean }
    expect(input.additionalProperties).toBe(false)
    expect(Object.keys(input.properties)).toEqual(["path", "plugins", "categories", "offline", "git"])
  })
})

describe("plugin_audit_scan", () => {
  test("offline run reports local findings and skips the registry", async () => {
    const { tool } = await load()
    const result = await tool({ offline: true, git: false }, { ...call, signal: new AbortController().signal })
    const counts = result.metadata.counts as { total: number; bySeverity: Record<string, number> }
    expect(counts.total).toBe((result.metadata.findings as unknown[]).length)
    expect(result.content).toContain("-- ")
    expect(result.content).not.toContain("left-pad")
  })

  test("a networked run queries npm through the fixture directory", async () => {
    const { tool } = await load()
    const result = await tool(
      { categories: ["versions"], git: false },
      { ...call, signal: new AbortController().signal },
    )
    expect(result.content).toContain("left-pad 1.0.0 -> 1.3.0")
    expect(result.content).toContain("warn  host-behind: @opencode/plugin 2.3.0 -> 2.4.1")
  })

  test("a plugin name that is not a directory is refused without scanning", async () => {
    const { tool } = await load()
    const result = await tool({ plugins: ["nope"], offline: true }, call)
    expect(result.content).toContain("no plugin directory nope")
    expect(result.metadata).toMatchObject({ exit: 2 })
  })
})
