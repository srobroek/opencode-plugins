import { expect, test } from "bun:test"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the cheap mechanic subagent with an edit-and-shell allowlist", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect(fake.skills.size).toBe(0)
  const agent = fake.agents.get("mechanic")
  expect(agent).toMatchObject({ mode: "subagent", request: { headers: { "x-opencode-model-role": "cheap" } } })
  expect(agent?.system).toContain("exactly the described change")
  const rules = agent?.permissions as AgentPermission[]
  for (const action of ["read", "grep", "glob", "edit", "shell"]) expect(permissionEffect(rules, action)).toBe("allow")
  for (const action of ["skill", "execute", "subagent", "question", "webfetch", "websearch", "some_plugin_tool"])
    expect(permissionEffect(rules, action)).toBe("deny")
  expect(permissionEffect(rules, "read", "src/.env")).toBe("ask")
  expect(permissionEffect(rules, "read", "src/.env.local")).toBe("ask")
  expect(permissionEffect(rules, "read", "src/.env.example")).toBe("allow")
  expect(permissionEffect(rules, "external_directory", "/tmp/x/*")).toBe("ask")
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
