import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the quality skills and the read-only challenger", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["prototype-logic", "quality-code-design", "quality-code-policy"])
  expect(fake.agents.get("adversarial-challenger")).toMatchObject({ mode: "subagent" })
  expect(fake.agents.get("adversarial-challenger")?.permissions).toEqual([
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ])
  await cleanup?.()
  expect(fake.active()).toBe(0)
})

test("every reference the code-design skill links resolves beside it", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const skill = fake.skills.get("quality-code-design") as unknown as { path: string; content: string }
  const links = [...skill.content.matchAll(/\]\((references\/[\w-]+\.md)\)/g)].map((match) => match[1] ?? "")
  expect(links.length).toBeGreaterThan(10)
  for (const link of links) expect(existsSync(join(dirname(skill.path), link))).toBe(true)
})
