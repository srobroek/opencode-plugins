import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import type { CleanupDeps } from "./cleanup.ts"
import * as realCleanup from "./cleanup.ts"

// The tool needs a real repository, receipt and forge to reach the host. This test
// replaces only cleanupDelivery, to see the deps the registered tool hands it.
const original = { ...realCleanup }
let seen: CleanupDeps | undefined

beforeAll(() => {
  mock.module("./cleanup.ts", () => ({
    ...original,
    cleanupDelivery: async (_params: unknown, _cwd: string, deps: CleanupDeps) => {
      seen = deps
      return { ok: false, reason: "stubbed" }
    },
  }))
})
afterAll(() => {
  mock.module("./cleanup.ts", () => original)
})

test("the registered delivery_cleanup tool passes the host worktree adapter for its project", async () => {
  const calls: unknown[] = []
  const fake = createFakeContext()
  const context = fake.context as unknown as {
    location: { project?: { id: string } }
    worktree: unknown
  }
  context.location = { ...context.location, project: { id: "prj_1" } }
  context.worktree = {
    list: async (input: unknown) => {
      calls.push(["list", input])
      return [{ directory: "/w/a" }]
    },
    remove: async (input: unknown) => {
      calls.push(["remove", input])
    },
  }
  const { default: plugin, CLEANUP_ACTION } = await import("./index.ts")
  await plugin.setup(fake.context)
  const execute = fake.tools.get(CLEANUP_ACTION)?.execute as (i: unknown, c: unknown) => Promise<unknown>
  await execute(
    {},
    { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal },
  )
  expect(seen?.host).toBeDefined()
  expect(await seen?.host?.list()).toEqual([{ directory: "/w/a" }])
  await seen?.host?.remove("/w/a")
  expect(calls).toEqual([
    ["list", { projectID: "prj_1" }],
    ["remove", { projectID: "prj_1", directory: "/w/a", force: false }],
  ])
})
