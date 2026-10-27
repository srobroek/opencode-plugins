import { expect, test } from "bun:test"
import { workflowLatch } from "./workflow.ts"

test("a session's first request decides the workflow text, and later requests keep it", async () => {
  let speckit = false
  const latch = workflowLatch(() => speckit)
  let lookups = 0
  const directory = async () => {
    lookups++
    return "/repo"
  }
  expect(await latch.include("ses_a", "build", directory)).toBe(false)
  speckit = true
  expect(await latch.include("ses_a", "build", directory)).toBe(false)
  expect(await latch.lacks("ses_a")).toBe(true)
  expect(await latch.include("ses_b", "build", directory)).toBe(true)
  speckit = false
  expect(await latch.include("ses_b", "build", directory)).toBe(true)
  expect(await latch.lacks("ses_b")).toBe(false)
  expect(await latch.lacks("ses_c")).toBe(false)
  expect(lookups).toBe(2)
})

test("decisions persist through the store, so a restart keeps them", async () => {
  const stored = new Map<string, boolean>()
  const store = { get: async (id: string) => stored.get(id), set: async (id: string, value: boolean) => void stored.set(id, value) }
  expect(await workflowLatch(() => false, store).include("ses_a", "build", async () => "/repo")).toBe(false)
  const restarted = workflowLatch(() => true, store)
  expect(await restarted.lacks("ses_a")).toBe(true)
  expect(await restarted.include("ses_a", "build", async () => "/repo")).toBe(false)
  expect(await restarted.include("ses_b", "build", async () => "/repo")).toBe(true)
})

test("the speckit agents never get the workflow text", async () => {
  const latch = workflowLatch(() => true)
  expect(await latch.include("ses_a", "speckit-verify", async () => "/repo")).toBe(false)
  expect(await latch.include("ses_a", "speckit-sync", async () => "/repo")).toBe(false)
})
