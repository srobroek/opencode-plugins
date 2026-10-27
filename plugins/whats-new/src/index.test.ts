import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { AGENT_PROMPT, SKILL_PATH, shapeAgent } from "./index.ts"
import { reportOnlyPermissions } from "./report-only.ts"

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>

describe("setup", () => {
  test("registers the tool, the agent, the gate and the skill, and disposes them all", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    expect([...fake.tools.keys()]).toEqual(["version_gap_scan"])
    expect(fake.agentUpdates).toEqual(["whats-new"])
    expect(fake.agents.get("whats-new")).toMatchObject({
      name: "whats-new",
      mode: "subagent",
      system: AGENT_PROMPT,
      permissions: reportOnlyPermissions(),
    })
    expect(fake.hooks("permission")).toEqual(["evaluate"])
    expect(fake.skills.get("whats-new")).toMatchObject({ path: SKILL_PATH })
    expect(String(fake.skills.get("whats-new")?.content)).not.toMatch(/skill:\/\/|report-only-gate/)
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
    expect(fake.skills.size).toBe(0)
  })

  test("a configured whats-new agent keeps its fields and gains the rules after its own", () => {
    const own = { action: "edit", resource: "*", effect: "allow" }
    const agent = { name: "mine", description: "custom", mode: "subagent", permissions: [own] }
    shapeAgent(agent, false)
    expect(agent).toMatchObject({ name: "mine", description: "custom", mode: "subagent" })
    expect(agent.permissions[0]).toEqual(own)
    expect(agent.permissions.slice(1)).toEqual(reportOnlyPermissions())
  })

  test("a newly created agent becomes a subagent over the host's primary default", () => {
    const agent = { mode: "primary", permissions: [] }
    shapeAgent(agent, true)
    expect(agent.mode).toBe("subagent")
  })

  test("a configured agent keeps its own primary mode", () => {
    const agent = { mode: "primary", permissions: [] }
    shapeAgent(agent, false)
    expect(agent.mode).toBe("primary")
  })
})

describe("version_gap_scan", () => {
  test("enumerates a fixture package.json as tab-separated rows", async () => {
    const project = mkdtempSync(join(tmpdir(), "vgap-"))
    try {
      writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { leftpad: "1.3.0" } }))
      const fake = createFakeContext({ directory: project })
      await plugin.setup(fake.context)
      const execute = fake.tools.get("version_gap_scan")?.execute as Execute
      const result = await execute({}, { signal: new AbortController().signal })
      expect(result.metadata.count).toBe(1)
      expect(result.content).toContain("npm\tleftpad\t1.3.0\t?\tdirect")
      expect(fake.tools.get("version_gap_scan")?.input).toMatchObject({ type: "object", properties: { path: {} } })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("a missing directory reports the failure", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const execute = fake.tools.get("version_gap_scan")?.execute as Execute
    const result = await execute({ path: "/nonexistent-vgap" }, {})
    expect(result.content).toContain("version_gap_scan failed (exit 2)")
  })
})

describe("bundle", () => {
  test("the built entry resolves the shipped SKILL.md from the package root", async () => {
    const built = (await import(join(import.meta.dir, "..", "index.js"))) as { SKILL_PATH: string }
    expect(built.SKILL_PATH).toBe(join(import.meta.dir, "..", "skills", "whats-new", "SKILL.md"))
    expect(existsSync(built.SKILL_PATH)).toBe(true)
  })
})
