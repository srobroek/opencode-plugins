import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

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
  expect([...fake.skills.keys()]).toEqual(["prototype-logic", "quality-code-design", "quality-code-policy", "quality-testing"])
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

test("every reference the code-design skill links resolves beside it", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const skill = fake.skills.get("quality-code-design") as unknown as { path: string; content: string }
  const links = [...skill.content.matchAll(/\]\((references\/[\w-]+\.md)\)/g)].map((match) => match[1] ?? "")
  expect(links.length).toBeGreaterThan(10)
  for (const link of links) expect(existsSync(join(dirname(skill.path), link))).toBe(true)
})
