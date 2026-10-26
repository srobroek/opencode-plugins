import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the architecture skills and the read-only architect", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["architecture-docs-files", "architecture-ownership", "architecture-top-level"])
  expect(fake.agents.get("architect")).toMatchObject({ name: "architect", mode: "subagent" })
  expect(fake.agents.get("architect")?.permissions).toEqual([
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "subagent", resource: "explore", effect: "allow" },
  ])
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
