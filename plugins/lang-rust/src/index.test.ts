import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the rust skills and disposes them", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()].sort()).toEqual([
    "lang-rust",
    "lang-rust-ci",
    "lang-rust-contract-boundary",
    "lang-rust-crate-boundaries",
    "lang-rust-domain-modeling",
    "lang-rust-persistence",
    "lang-rust-profiling",
    "lang-rust-quality",
    "lang-rust-safe-mutation",
    "lang-rust-tauri",
    "lang-rust-workspace",
  ])
  for (const skill of fake.skills.values())
    expect(String(skill.content)).not.toMatch(/skill:\/\/|rule:\/\/|_quality`? tool|\bbash\b|TTSR/)
    expect(fake.hooks("tool")).toEqual([])
    expect(String(fake.skills.get("lang-rust-persistence")?.content)).toContain("safety plugin")
  await cleanup?.()
  expect(fake.active()).toBe(0)
  expect(fake.skills.size).toBe(0)
})

test("keeps a user's skill of the same id", async () => {
  const fake = createFakeContext({ skills: [{ id: "lang-rust-ci", content: "mine" }] })
  await plugin.setup(fake.context)
  expect(fake.skills.get("lang-rust-ci")?.content).toBe("mine")
})
