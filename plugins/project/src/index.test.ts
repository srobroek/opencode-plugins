import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers license-picker with its references beside it", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["license-picker"])
  const skill = fake.skills.get("license-picker") as unknown as { path: string; content: string }
  for (const reference of skill.content.matchAll(/`(references\/[\w-]+\.md)`/g))
    expect(existsSync(join(dirname(skill.path), reference[1] ?? ""))).toBe(true)
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
