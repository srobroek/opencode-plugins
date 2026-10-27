import { expect, test } from "bun:test"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the architecture skills and the read-only architect", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["architecture-docs-files", "architecture-guide", "architecture-ownership", "architecture-top-level"])
  expect(fake.agents.get("architect")).toMatchObject({ name: "architect", mode: "subagent" })
  const rules = fake.agents.get("architect")?.permissions as AgentPermission[]
  for (const action of ["edit", "shell", "execute", "question", "some_plugin_tool"]) expect(permissionEffect(rules, action)).toBe("deny")
  for (const action of ["read", "grep", "glob", "lsp_diagnostics", "webfetch", "websearch"])
    expect(permissionEffect(rules, action)).toBe("allow")
  for (const skill of ["architecture-guide", "architecture-ownership", "lang-rust-crate-boundaries", "quality-code-design"])
    expect(permissionEffect(rules, "skill", skill)).toBe("allow")
  for (const skill of ["design-guide", "delivery-fan-out", "beads-guide"]) expect(permissionEffect(rules, "skill", skill)).toBe("deny")
  expect(permissionEffect(rules, "subagent", "explore")).toBe("allow")
  expect(permissionEffect(rules, "subagent", "general")).toBe("deny")
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
