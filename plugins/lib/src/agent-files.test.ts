import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AgentPermission,
  agentPaths,
  parseAgentFile,
  permissionEffect,
  registerAgentFiles,
  registerAgents,
  shapeAgent,
} from "./agent-files.ts"
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

  test("reads steps and the model-role request header", () => {
    const text = "---\nmode: subagent\nsteps: 400\nrequest:\n  headers:\n    x-opencode-model-role: designer\npermissions: []\n---\nhi"
    expect(parseAgentFile(text, "x")).toMatchObject({
      steps: 400,
      request: { headers: { "x-opencode-model-role": "designer" } },
      permissions: [],
    })
    expect(() => parseAgentFile("---\nsteps: lots\n---\nx", "x")).toThrow("steps must be a positive integer")
    expect(() => parseAgentFile("---\nrequest:\n  body: {}\n---\nx", "x")).toThrow("request supports only headers")
  })

  test("reads hidden and skips comment lines", () => {
    const text = "---\n# Generated. Do not edit.\nmode: subagent\nhidden: true\npermissions:\n  # a note\n  - action: read\n    resource: \"*\"\n    effect: allow\n---\nhi"
    expect(parseAgentFile(text, "x")).toMatchObject({ hidden: true, permissions: [{ action: "read", resource: "*", effect: "allow" }] })
    expect(parseAgentFile("---\nhidden: false\n---\nhi", "x").hidden).toBe(false)
    expect(parseAgentFile("---\nmode: all\n---\nhi", "x").hidden).toBeUndefined()
    expect(() => parseAgentFile("---\nhidden: yes\n---\nx", "x")).toThrow("hidden must be true or false")
  })

  test("rejects keys a shipped agent must not carry", () => {
    expect(() => parseAgentFile('---\nmodel: "a/b"\n---\nx', "x")).toThrow("unsupported frontmatter key model")
    expect(() => parseAgentFile("---\nmode: boss\n---\nx", "x")).toThrow("bad mode")
    expect(() => parseAgentFile("---\npermissions:\n  - action: edit\n---\nx", "x")).toThrow("incomplete permission")
    expect(() => parseAgentFile("no frontmatter", "x")).toThrow("no frontmatter")
  })
})

describe("permissionEffect", () => {
  const rules: AgentPermission[] = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "lsp_*", resource: "*", effect: "allow" },
    { action: "subagent", resource: "explore", effect: "allow" },
  ]

  test("the last matching rule wins and wildcards match any run of characters", () => {
    expect(permissionEffect(rules, "read", "src/a.ts")).toBe("allow")
    expect(permissionEffect(rules, "read", "app/.env")).toBe("ask")
    expect(permissionEffect(rules, "lsp_diagnostics")).toBe("allow")
    expect(permissionEffect(rules, "subagent", "explore")).toBe("allow")
    expect(permissionEffect(rules, "subagent", "general")).toBe("deny")
    expect(permissionEffect(rules, "edit")).toBe("deny")
  })

  test("no matching rule means ask", () => {
    expect(permissionEffect([], "edit")).toBe("ask")
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

  test("hidden fills in, but a configured value wins", () => {
    const file = { ...parseAgentFile("---\nhidden: true\n---\nhi", "x") }
    const created: Parameters<typeof shapeAgent>[0] = {}
    shapeAgent(created, file, true)
    expect(created.hidden).toBe(true)
    const prefilled: Parameters<typeof shapeAgent>[0] = { hidden: false }
    shapeAgent(prefilled, file, true)
    expect(prefilled.hidden).toBe(true)
    const shown: Parameters<typeof shapeAgent>[0] = { hidden: false }
    shapeAgent(shown, file, false)
    expect(shown.hidden).toBe(false)
  })

  test("a configured agent keeps its fields and gains the file's rules after its own", () => {
    const own: AgentPermission = { action: "edit", resource: "*", effect: "allow" }
    const agent: { name: string; description: string; mode: string; system: string; permissions: AgentPermission[] } = { name: "mine", description: "custom", mode: "all", system: "own", permissions: [own] }
    shapeAgent(agent, file, false)
    expect(agent).toMatchObject({ name: "mine", description: "custom", mode: "all", system: "own" })
    expect(agent.permissions).toEqual([own, ...file.permissions])
  })

  test("the file's role header and steps fill in, but a configured header or steps win", () => {
    const roled = parseAgentFile(
      "---\nsteps: 400\nrequest:\n  headers:\n    x-opencode-model-role: task\n    x-other: a\n---\nx",
      "r",
    )
    const fresh: Record<string, unknown> = {}
    shapeAgent(fresh, roled, true)
    expect(fresh).toMatchObject({ steps: 400, request: { headers: { "x-opencode-model-role": "task", "x-other": "a" } } })
    const configured: Record<string, unknown> = { steps: 10, request: { headers: { "x-opencode-model-role": "slow" } } }
    shapeAgent(configured, roled, false)
    expect(configured).toMatchObject({ steps: 10, request: { headers: { "x-opencode-model-role": "slow", "x-other": "a" } } })
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

describe("registerAgentFiles", () => {
  const file = { id: "x:a", mode: "subagent" as const, system: "S", permissions: [{ action: "*", resource: "*", effect: "deny" as const }] }
  test("onExisting skips and reports an id the host already has, leaving it untouched", async () => {
    const fake = createFakeContext({ agents: [{ id: "x:a", system: "Mine", permissions: [] }] })
    const skipped: string[] = []
    await registerAgentFiles(fake.context.agent, [file, { ...file, id: "x:b" }], { onExisting: (id) => skipped.push(id) })
    expect(skipped).toEqual(["x:a"])
    expect(fake.agents.get("x:a")).toEqual({ id: "x:a", system: "Mine", permissions: [] })
    expect(fake.agents.get("x:b")).toMatchObject({ system: "S", mode: "subagent" })
  })

  test("permissions combines the agent's prior rules with the file's", async () => {
    const fake = createFakeContext()
    await registerAgentFiles(fake.context.agent, [file], { permissions: (existing, f) => [...f.permissions, ...existing, { action: "z", resource: "*", effect: "ask" }] })
    expect((fake.agents.get("x:a") as unknown as { permissions: unknown[] }).permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "z", resource: "*", effect: "ask" },
    ])
  })
})
