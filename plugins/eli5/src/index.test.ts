import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the eli5 skill and disposes it", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["eli5"])
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
