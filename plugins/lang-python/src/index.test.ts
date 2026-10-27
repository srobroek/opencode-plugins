import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the python skills and disposes them", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()].sort()).toEqual([
    "lang-python",
    "lang-python-profiling",
    "lang-python-quality",
  ])
  for (const skill of fake.skills.values())
    expect(String(skill.content)).not.toMatch(/skill:\/\/|rule:\/\/|_quality`? tool|\bbash\b|TTSR/)
  await cleanup?.()
  expect(fake.active()).toBe(0)
  expect(fake.skills.size).toBe(0)
})

test("keeps a user's skill of the same id", async () => {
  const fake = createFakeContext({ skills: [{ id: "lang-python-profiling", content: "mine" }] })
  await plugin.setup(fake.context)
  expect(fake.skills.get("lang-python-profiling")?.content).toBe("mine")
})
