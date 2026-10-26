import { describe, expect, test } from "bun:test"
import { createFakeContext, type FakeContextOptions } from "@srobroek/opencode-lib/testing"
import plugin, { localInventory, readOptions, SKILL_PATH } from "./index.ts"

type Result = { content: string; metadata: Record<string, unknown> }
type Execute = (input: unknown, context: unknown) => Promise<Result>

async function load(options: FakeContextOptions = {}) {
  const fake = createFakeContext(options)
  // The fake context has no plugin or mcp domain; add the list calls the scan reads.
  Object.assign(fake.context, {
    plugin: { list: async () => ({ data: [{ id: "srobroek.beads", source: { type: "builtin" } }] }) },
    mcp: { list: async () => ({ data: [{ name: "private", status: { status: "connected" } }] }) },
  })
  const cleanup = await plugin.setup(fake.context)
  const execute = fake.tools.get("find_tools_scan")?.execute as Execute
  return { fake, cleanup, execute }
}

describe("setup", () => {
  test("registers the tool, the install guard and the skill, and disposes them all", async () => {
    const { fake, cleanup } = await load()
    expect([...fake.tools.keys()]).toEqual(["find_tools_scan"])
    expect(fake.hooks("permission")).toEqual(["evaluate"])
    expect(fake.skills.get("find-tools")).toMatchObject({ id: "find-tools", path: SKILL_PATH })
    expect(String(fake.skills.get("find-tools")?.content)).not.toMatch(/skill:\/\/|rule:\/\/|\bomp\b/)
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
    expect(fake.skills.size).toBe(0)
  })

  test("guardInstalls: false leaves the permission layer alone", async () => {
    const { fake } = await load({ options: { guardInstalls: false } })
    expect(fake.hooks("permission")).toEqual([])
  })

  test("the hook asks before a skills CLI install", async () => {
    const { fake } = await load()
    const evaluation = await fake.fire.permission("evaluate", {
      action: "shell",
      resources: ["npx skills add owner/repo"],
      effect: "allow" as string,
    })
    expect(evaluation.effect).toBe("ask")
  })

  test("the tool input is JSON Schema with a query and an optional source subset", async () => {
    const { fake } = await load()
    expect(fake.tools.get("find_tools_scan")?.input).toMatchObject({
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" }, sources: { type: "array" } },
    })
  })
})

describe("find_tools_scan", () => {
  test("scans the host inventory without leaking MCP names", async () => {
    const { execute } = await load({ skills: [{ id: "browse", name: "browse", description: "Browse the web" }] })
    const result = await execute(
      { query: "browser", sources: ["local", "skills_cli"] },
      { signal: new AbortController().signal },
    )
    expect(result.metadata.ok).toBe(true)
    expect(result.content).toContain("plugin:srobroek.beads")
    expect(result.content).toContain("skill:browse")
    expect(result.content).toContain('mcp: {"configured":1,"connected":1}')
    expect(result.content).not.toContain("private")
    expect(result.content).toContain("[skipped] skills_cli")
  })

  test("an unknown source is a tool error, not a throw", async () => {
    const { execute } = await load()
    const result = await execute({ query: "x", sources: ["omp"] }, { signal: new AbortController().signal })
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("Unknown source: omp")
  })
})

describe("options", () => {
  test("guardInstalls defaults on; skillCatalogs keeps strings only", () => {
    expect(readOptions({})).toEqual({ guardInstalls: true, skillCatalogs: [] })
    expect(readOptions({ guardInstalls: false, skillCatalogs: ["https://a", 3] })).toEqual({
      guardInstalls: false,
      skillCatalogs: ["https://a"],
    })
  })

  test("localInventory fails a missing domain instead of throwing at setup", async () => {
    const inventory = localInventory({})
    await expect(inventory.plugins()).rejects.toThrow("plugin.list unavailable")
  })
})
