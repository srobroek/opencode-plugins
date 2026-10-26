import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers aws-guidance and adds no MCP servers", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["aws-guidance"])
  expect(fake.active()).toBe(1)
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
