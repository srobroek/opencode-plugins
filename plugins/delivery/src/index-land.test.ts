import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import type { CleanupDeps, CleanupResult } from "./cleanup.ts"
import * as realCleanup from "./cleanup.ts"
import * as realLand from "./land.ts"

// Landing needs a forge; cleanup needs a repository. Both are replaced so the test sees
// only how the registered delivery_land tool chains them.
const originalCleanup = { ...realCleanup }
const originalLand = { ...realLand }
let ledgerActive = false
let cleanupResult: CleanupResult
let cleanupCalls: Array<{ params: unknown; deps: CleanupDeps }> = []

beforeAll(() => {
  mock.module("./cleanup.ts", () => ({
    ...originalCleanup,
    cleanupDelivery: async (params: unknown, _cwd: string, deps: CleanupDeps) => {
      cleanupCalls.push({ params, deps })
      await deps.authorize?.({ worktree: "/w/a", branch: "b", pr: 7 })
      return cleanupResult
    },
  }))
  mock.module("./land.ts", () => ({
    ...originalLand,
    landPullRequest: async () => ({
      ok: true,
      receiptPath: "/r/receipt.json",
      receipt: { receiptId: "r7", pr: { number: 7, mergeCommitOid: "abc" }, worktree: { path: "/w/a" }, repo: { nameWithOwner: "o/r" }, beads: { ledgerActive } },
      text: "landed\nnext: run delivery_cleanup to remove the worktree and the local branch.",
      next: ["delivery_cleanup"],
    }),
  }))
})
afterAll(() => {
  mock.module("./cleanup.ts", () => originalCleanup)
  mock.module("./land.ts", () => originalLand)
})
beforeEach(() => {
  ledgerActive = false
  cleanupCalls = []
  cleanupResult = { ok: true, receipt: { worktree: { path: "/w/a" } }, path: "/r", remoteBranchAbsence: "absent" } as never
})

type Result = { output: { ok: boolean; next: string[]; cleanup?: Record<string, unknown> }; content: string }

async function land(
  options: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
  fakeOptions: Parameters<typeof createFakeContext>[0] = {},
): Promise<{ result: Result; removed: unknown[]; fake: ReturnType<typeof createFakeContext> }> {
  const removed: unknown[] = []
  const fake = createFakeContext(fakeOptions)
  const context = fake.context as unknown as { location: unknown; worktree: unknown; options: unknown }
  context.location = { ...(context.location as object), project: { id: "prj" } }
  context.options = options
  context.worktree = {
    list: async () => [{ directory: "/w/a" }],
    remove: async (input: unknown) => {
      removed.push(input)
    },
  }
  const { default: plugin, LAND_ACTION } = await import("./index.ts")
  await plugin.setup(fake.context)
  const execute = fake.tools.get(LAND_ACTION)?.execute as (i: unknown, c: unknown) => Promise<Result>
  const result = await execute(
    { pr: 7, ...input },
    { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal },
  )
  return { result, removed, fake }
}

test("a successful land cleans up with the receipt it wrote and reports cleanup.ok", async () => {
  const { result } = await land()
  expect(cleanupCalls.map((c) => c.params)).toEqual([{ receipt: "/r/receipt.json" }])
  expect(result.output.cleanup).toEqual({ ok: true, removed: "/w/a", localRefDeleted: true })
  expect(result.output.next).toEqual([])
})

test("the cleanup it runs removes through the host registry without force", async () => {
  cleanupResult = { ok: false, reason: "stub" }
  const { removed } = await land()
  await cleanupCalls[0]?.deps.host?.remove("/w/a")
  expect(removed).toEqual([{ projectID: "prj", directory: "/w/a", force: false }])
})

test("a cleanup refusal keeps the land successful and keeps delivery_cleanup in next", async () => {
  cleanupResult = { ok: false, reason: "worktree dirty" }
  const { result } = await land()
  expect(result.output.ok).toBe(true)
  expect(result.output.cleanup).toEqual({ ok: false, reason: "worktree dirty" })
  expect(result.output.next).toEqual(["delivery_cleanup"])
  expect(result.content).toContain("worktree dirty")
})

test("autoCleanup false runs no cleanup and reports none", async () => {
  const { result } = await land({ autoCleanup: false })
  expect(cleanupCalls).toEqual([])
  expect(result.output.cleanup).toBeUndefined()
  expect(result.output.next).toEqual(["delivery_cleanup"])
})

test("an active ledger skips inline cleanup so the closeout commands run first", async () => {
  ledgerActive = true
  const { result } = await land()
  expect(cleanupCalls).toEqual([])
  expect(result.output.cleanup).toMatchObject({ ok: false, skipped: true })
  expect(result.output.next).toEqual(["delivery_cleanup"])
})

test("a worktree held by an integration is not cleaned inline and reports the deferral", async () => {
  const { result } = await land({}, { cleanupHold: [{ directory: "/w/a", reason: "lane lane/x still active" }] })
  expect(cleanupCalls).toEqual([])
  expect(result.output.ok).toBe(true)
  expect(result.output.cleanup).toEqual({ ok: false, deferred: "lane lane/x still active" })
  expect(result.output.next).toEqual(["delivery_cleanup"])
})

test("a hold on another worktree does not stop cleanup", async () => {
  const { result } = await land({}, { cleanupHold: [{ directory: "/w/other", reason: "busy" }] })
  expect(result.output.cleanup).toMatchObject({ ok: true })
})

test("a denied inline cleanup is recorded as denied, still lands, and is never retried in the background", async () => {
  const deny = (assert: { action: string }) => {
    if (assert.action === "delivery_cleanup") throw new Error("denied by the user")
  }
  const { result, fake } = await land({}, {}, { assert: deny as never })
  expect(result.output.ok).toBe(true)
  expect(result.output.cleanup).toMatchObject({ ok: false, denied: true })
  expect(result.output.next).toEqual(["delivery_cleanup"])
  expect(fake.storage.get("delivery/pending/r7")).toMatchObject({ sessionID: "s", denied: { sessionID: "s" } })
})

test("a cleanup that is refused for another reason is not recorded as denied", async () => {
  cleanupResult = { ok: false, reason: "worktree.status: dirty" }
  const { result, fake } = await land()
  expect(result.output.cleanup).not.toHaveProperty("denied")
  expect((fake.storage.get("delivery/pending/r7") as { denied?: unknown }).denied).toBeUndefined()
})
