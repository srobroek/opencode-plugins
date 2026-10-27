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
  for (const action of ["read", "edit", "shell", "execute", "webfetch", "repomix_pack"]) expect(permissionEffect(rules, action)).toBe("allow")
  for (const skill of ["repomix", "lang-go", "quality-code-policy", "toolchain-guide", "shell-language"])
    expect(permissionEffect(rules, "skill", skill)).toBe("allow")
  for (const skill of ["design-guide", "beads-guide", "delivery-fan-out"]) expect(permissionEffect(rules, "skill", skill)).toBe("deny")
  expect(permissionEffect(rules, "external_directory")).toBe("ask")
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
