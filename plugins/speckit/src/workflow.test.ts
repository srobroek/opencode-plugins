import { expect, test } from "bun:test"
import { workflowLatch } from "./workflow.ts"

test("the workflow text, once on for a session, stays on without another lookup", async () => {
  let speckit = false
  const latch = workflowLatch(() => speckit)
  let lookups = 0
  const directory = async () => {
    lookups++
    return "/repo"
  }
  expect(await latch.include("ses_a", "build", directory)).toBe(false)
  speckit = true
  expect(await latch.include("ses_a", "build", directory)).toBe(true)
  speckit = false
  expect(await latch.include("ses_a", "build", directory)).toBe(true)
  expect(lookups).toBe(2)
  expect(await latch.include("ses_b", "build", directory)).toBe(false)
})

test("the speckit agents never get the workflow text", async () => {
  const latch = workflowLatch(() => true)
  expect(await latch.include("ses_a", "speckit-verify", async () => "/repo")).toBe(false)
  expect(await latch.include("ses_a", "speckit-sync", async () => "/repo")).toBe(false)
})
