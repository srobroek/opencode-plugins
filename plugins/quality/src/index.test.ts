import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { DEFAULT_STANDARDS_SUBAGENTS, parseStandardsOptions, STANDARDS_TEXT, TESTING_TEXT, wantsStandards } from "./index.ts"

test("skips the challenger copy when plugin.list reports agent-reviewer", async () => {
  const fake = createFakeContext()
  ;(fake.context as unknown as Record<string, unknown>).plugin = {
    list: async () => ({ data: [{ id: "srobroek.agent-reviewer" }] }),
  }
  await plugin.setup(fake.context)
  expect(fake.agents.has("adversarial-challenger")).toBe(false)
  expect(fake.skills.has("quality-code-design")).toBe(true)
})

test("registers the quality skills and the read-only challenger", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual([
    "prototype-logic",
    "quality-code-design",
    "quality-code-policy",
    "quality-profiling",
    "quality-test-audit",
    "quality-testing",
  ])
  expect(fake.agents.get("adversarial-challenger")).toMatchObject({ mode: "subagent" })
  const rules = fake.agents.get("adversarial-challenger")?.permissions as AgentPermission[]
  for (const action of ["edit", "shell", "subagent", "question", "execute", "some_plugin_tool"])
    expect(permissionEffect(rules, action)).toBe("deny")
  for (const action of ["read", "grep", "glob", "lsp_diagnostics", "webfetch", "websearch"])
    expect(permissionEffect(rules, action)).toBe("allow")
  expect(permissionEffect(rules, "skill", "quality-code-design")).toBe("allow")
  expect(permissionEffect(rules, "skill", "other")).toBe("deny")
  await cleanup?.()
  expect(fake.active()).toBe(0)
})

test("every reference the testing and audit skills link resolves beside them", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  for (const id of ["quality-testing", "quality-test-audit"]) {
    const skill = fake.skills.get(id) as unknown as { path: string; content: string }
    const links = [...skill.content.matchAll(/\]\((references\/[\w-]+\.md)\)/g)].map((match) => match[1] ?? "")
    expect(links.length).toBeGreaterThan(2)
    for (const link of links) expect(existsSync(join(dirname(skill.path), link))).toBe(true)
  }
})

test("every reference the code-design skill links resolves beside it", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const skill = fake.skills.get("quality-code-design") as unknown as { path: string; content: string }
  const links = [...skill.content.matchAll(/\]\((references\/[\w-]+\.md)\)/g)].map((match) => match[1] ?? "")
  expect(links.length).toBeGreaterThan(10)
  for (const link of links) expect(existsSync(join(dirname(skill.path), link))).toBe(true)
})

describe("engineering standards", () => {
  const sessions = [{ id: "ses_root" }, { id: "ses_general", parentID: "ses_root" }, { id: "ses_coder", parentID: "ses_root" }]
  const fire = (fake: ReturnType<typeof createFakeContext>, sessionID: string, agent: string, hook: "context" | "compaction" | "generate" = "context") =>
    fake.fire.session(hook, { sessionID, agent, system: [] as Array<{ type: string; text: string }>, messages: [], tools: {} })
  const block = [
    { type: "text", text: STANDARDS_TEXT },
    { type: "text", text: TESTING_TEXT },
  ]

  test("primary sessions and general subagents get the static block on every request kind", async () => {
    const fake = createFakeContext({ sessions })
    const cleanup = await plugin.setup(fake.context)
    expect(fake.hooks("session")).toEqual(["context", "compaction", "generate"])
    for (const hook of ["context", "compaction", "generate"] as const) {
      expect((await fire(fake, "ses_root", "build", hook)).system).toEqual(block)
      expect((await fire(fake, "ses_general", "general", hook)).system).toEqual(block)
    }
    expect((await fire(fake, "ses_root", "plan")).system).toEqual(block)
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("coder and other subagents get nothing: coder carries the same part in its prompt", async () => {
    const fake = createFakeContext({ sessions })
    await plugin.setup(fake.context)
    expect((await fire(fake, "ses_coder", "coder")).system).toEqual([])
    expect((await fire(fake, "ses_coder", "explore")).system).toEqual([])
    expect((await fire(fake, "ses_unknown", "build")).system).toEqual([])
  })

  test("options turn the block off or change the subagent list", async () => {
    const off = createFakeContext({ sessions, options: { standards: false } })
    await plugin.setup(off.context)
    expect(off.hooks("session")).toEqual([])
    const custom = createFakeContext({ sessions, options: { standardsSubagents: ["coder"] } })
    await plugin.setup(custom.context)
    expect((await fire(custom, "ses_general", "general")).system).toEqual([])
    expect((await fire(custom, "ses_coder", "coder")).system).toEqual(block)
    expect(parseStandardsOptions({ standardsSubagents: ["a", 3] })?.subagents).toEqual(new Set(["a"]))
    expect(wantsStandards(false, "general", new Set(DEFAULT_STANDARDS_SUBAGENTS))).toBe(true)
  })

  test("the block is the coding-core standards part, short enough for every request", () => {
    expect(STANDARDS_TEXT.length).toBeLessThanOrEqual(1000)
    for (const phrase of ["lang-<language>-libraries", "toolchain-languages", "aws-guidance", "middleware", "Powertools", "OpenTelemetry", "departure"])
      expect(STANDARDS_TEXT).toContain(phrase)
    expect(readFileSync(join(import.meta.dir, "../../lib/src/coding-core.md"), "utf8")).toContain(STANDARDS_TEXT.split("\n\n")[1]?.split("\n")[0] ?? "missing")
  })

  test("the testing block is the coding-core testing part, short enough for every request", () => {
    expect(TESTING_TEXT.length).toBeLessThanOrEqual(1000)
    for (const phrase of ["quality-testing", "lang-<language>-testing", "public interface", "distinct risk", "removed behavior", "only checks code is gone"])
      expect(TESTING_TEXT).toContain(phrase)
    expect(readFileSync(join(import.meta.dir, "../../lib/src/coding-core.md"), "utf8")).toContain(TESTING_TEXT.split("\n\n")[1]?.split("\n")[0] ?? "missing")
  })
})
