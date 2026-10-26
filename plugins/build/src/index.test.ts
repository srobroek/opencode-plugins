import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers external-repo-worker without skills", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect(fake.skills.size).toBe(0)
  expect(fake.agents.get("external-repo-worker")).toMatchObject({
    mode: "subagent",
    permissions: [{ action: "subagent", resource: "*", effect: "deny" }],
  })
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
