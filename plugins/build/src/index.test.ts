import { expect, test } from "bun:test"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers external-repo-worker without skills", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect(fake.skills.size).toBe(0)
  expect(fake.agents.get("external-repo-worker")).toMatchObject({ mode: "subagent" })
  const rules = fake.agents.get("external-repo-worker")?.permissions as AgentPermission[]
  for (const action of ["subagent", "question", "some_plugin_tool"]) expect(permissionEffect(rules, action)).toBe("deny")
  for (const action of ["read", "edit", "shell", "skill", "execute", "webfetch"]) expect(permissionEffect(rules, action)).toBe("allow")
  expect(permissionEffect(rules, "external_directory")).toBe("ask")
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
