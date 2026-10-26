import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentPermission, agentPaths, parseAgentFile, registerAgents, shapeAgent } from "./agent-files.ts"
import { createFakeContext } from "./testing.ts"

const CONVERTED = [
  "---",
  'description: "Read-only: never edits."',
  "mode: subagent",
  "permissions:",
  "  - action: edit",
  '    resource: "*"',
  "    effect: deny",
  "  - action: subagent",
  '    resource: "explore"',
  "    effect: allow",
  "---",
  "",
  "You are a reader.",
  "",
].join("\n")

describe("parseAgentFile", () => {
  test("reads the converter's frontmatter and uses the body as the prompt", () => {
    expect(parseAgentFile(CONVERTED, "reader")).toEqual({
      id: "reader",
      description: "Read-only: never edits.",
      mode: "subagent",
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "subagent", resource: "explore", effect: "allow" },
      ],
      system: "You are a reader.",
    })
  })

  test("accepts an empty permission list", () => {
    expect(parseAgentFile("---\nmode: all\npermissions: []\n---\nhi", "x")).toMatchObject({ mode: "all", permissions: [] })
  })

  test("rejects keys a shipped agent must not carry", () => {
    expect(() => parseAgentFile('---\nmodel: "a/b"\n---\nx', "x")).toThrow("unsupported frontmatter key model")
    expect(() => parseAgentFile("---\nmode: boss\n---\nx", "x")).toThrow("bad mode")
    expect(() => parseAgentFile("---\npermissions:\n  - action: edit\n---\nx", "x")).toThrow("incomplete permission")
    expect(() => parseAgentFile("no frontmatter", "x")).toThrow("no frontmatter")
  })
})

describe("shapeAgent", () => {
  const file = parseAgentFile(CONVERTED, "reader")

  test("a created agent takes every field from the file", () => {
    const agent: { mode: string; permissions: AgentPermission[] } = { mode: "primary", permissions: [] }
    shapeAgent(agent, file, true)
    expect(agent as Record<string, unknown>).toEqual({
      name: "reader",
      description: file.description,
      mode: "subagent",
      system: file.system,
      permissions: file.permissions,
    })
  })

  test("a configured agent keeps its fields and gains the file's rules after its own", () => {
    const own: AgentPermission = { action: "edit", resource: "*", effect: "allow" }
    const agent: { name: string; description: string; mode: string; system: string; permissions: AgentPermission[] } = { name: "mine", description: "custom", mode: "all", system: "own", permissions: [own] }
    shapeAgent(agent, file, false)
    expect(agent).toMatchObject({ name: "mine", description: "custom", mode: "all", system: "own" })
    expect(agent.permissions).toEqual([own, ...file.permissions])
  })
})

describe("registerAgents", () => {
  test("lists *.md files and registers each by file name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-files-"))
    try {
      mkdirSync(join(dir, "nested"))
      writeFileSync(join(dir, "reader.md"), CONVERTED)
      writeFileSync(join(dir, "notes.txt"), "ignored")
      const paths = agentPaths(dir)
      expect(paths).toEqual([join(dir, "reader.md")])
      expect(agentPaths(join(dir, "missing"))).toEqual([])

      const fake = createFakeContext()
      const registration = await registerAgents(fake.context.agent, paths)
      expect(fake.agents.get("reader")).toMatchObject({ name: "reader", mode: "subagent", system: "You are a reader." })
      await registration.dispose()
      expect(fake.active()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
