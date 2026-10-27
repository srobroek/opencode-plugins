import { expect, test } from "bun:test"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the architecture skills and the read-only architect", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["architecture-docs-files", "architecture-ownership", "architecture-top-level"])
  expect(fake.agents.get("architect")).toMatchObject({ name: "architect", mode: "subagent" })
  const rules = fake.agents.get("architect")?.permissions as AgentPermission[]
  for (const action of ["edit", "shell", "question", "some_plugin_tool"]) expect(permissionEffect(rules, action)).toBe("deny")
  for (const action of ["read", "grep", "glob", "skill", "execute", "lsp_diagnostics", "webfetch"])
    expect(permissionEffect(rules, action)).toBe("allow")
  expect(permissionEffect(rules, "subagent", "explore")).toBe("allow")
  expect(permissionEffect(rules, "subagent", "general")).toBe("deny")
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
