import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { claimFile, readLanding, removeClaim, removeLanding, writeClaim, writeLanding } from "@srobroek/opencode-lib/worktree-claims"
import type { CleanupDeps, CleanupResult } from "./cleanup.ts"
import * as realCleanup from "./cleanup.ts"
import * as realLand from "./land.ts"
import { repositoryContext } from "./landing-receipt.ts"

// Landing needs a forge; cleanup needs a repository. Both are replaced so the test sees
// only how the registered delivery_land tool chains them.
const originalCleanup = { ...realCleanup }
const originalLand = { ...realLand }
let ledgerActive = false
let cleanupResult: CleanupResult
let cleanupCalls: Array<{ params: unknown; deps: CleanupDeps }> = []
let repo = ""
let common = ""

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "land-repo-"))
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo })
  common = repositoryContext(repo)?.commonDir as string
  mock.module("./cleanup.ts", () => ({
    ...originalCleanup,
    cleanupDelivery: async (params: unknown, _cwd: string, deps: CleanupDeps) => {
      cleanupCalls.push({ params, deps })
      await deps.authorize?.({ worktree: "/w/a", branch: "b", pr: 7 })
      // The removal runs inside the caller's critical section, as cleanupDelivery does.
      const run = async () => cleanupResult as never
      return deps.removalSection ? deps.removalSection("/w/a", run) : run()
    },
  }))
  mock.module("./land.ts", () => ({
    ...originalLand,
    landPullRequest: async () => ({
      ok: true,
      receiptPath: "/r/receipt.json",
      receipt: { receiptId: "r7", pr: { number: 7, mergeCommitOid: "abc", headRefOid: "h".repeat(40) }, worktree: { path: "/w/a" }, repo: { nameWithOwner: "o/r" }, beads: { ledgerActive } },
      text: "landed\nnext: run delivery_cleanup to remove the worktree and the local branch.",
      next: ["delivery_cleanup"],
    }),
  }))
})
afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  mock.module("./cleanup.ts", () => originalCleanup)
  mock.module("./land.ts", () => originalLand)
})
beforeEach(() => {
  removeLanding(common, "r7")
  ledgerActive = false
  cleanupCalls = []
  cleanupResult = { ok: true, receipt: { worktree: { path: "/w/a" }, branch: { name: "b" } }, path: "/r", remoteBranchAbsence: "absent" } as never
})

type Result = { output: { ok: boolean; next: string[]; cleanup?: Record<string, unknown> }; content: string }

async function land(
  options: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
  fakeOptions: Parameters<typeof createFakeContext>[0] = {},
): Promise<{ result: Result; removed: unknown[]; fake: ReturnType<typeof createFakeContext> }> {
  const removed: unknown[] = []
  const fake = createFakeContext({ directory: repo, ...fakeOptions })
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

const claimLane = () =>
  writeClaim(common, { directory: "/w/a", branch: "lane-a", sessionID: "c", parentID: "p", createdAt: 1 })

test("a lane's claim keeps cleanup from running and reports the deferral", async () => {
  claimLane()
  const { result } = await land()
  expect(cleanupCalls).toEqual([])
  expect(result.output.ok).toBe(true)
  expect(result.output.cleanup).toEqual({ ok: false, deferred: "owned by subagent-worktree lane" })
  expect(result.output.next).toEqual(["delivery_cleanup"])
  removeClaim(common, "/w/a")
})

test("an unreadable claim defers too", async () => {
  mkdirSync(join(common, "opencode", "lane-claims"), { recursive: true })
  writeFileSync(claimFile(common, "/w/a"), "{broken")
  const { result } = await land()
  expect(cleanupCalls).toEqual([])
  expect(JSON.stringify(result.output.cleanup)).toContain("lane claim unreadable")
  removeClaim(common, "/w/a")
})

test("a claim on another worktree does not stop cleanup", async () => {
  writeClaim(common, { directory: "/w/other", branch: "x", sessionID: "c", parentID: "p", createdAt: 1 })
  const { result } = await land()
  expect(result.output.cleanup).toMatchObject({ ok: true })
  removeClaim(common, "/w/other")
})

test("a lane claimed between the decision and the removal is refused at the last check", async () => {
  cleanupResult = { ok: true, receipt: { worktree: { path: "/w/a" }, branch: { name: "b" } }, path: "/r", remoteBranchAbsence: "absent" } as never
  const claimBeforeAuthorize = (assert: { action: string }) => {
    if (assert.action === "delivery_cleanup") claimLane()
  }
  const { result } = await land({}, {}, { assert: claimBeforeAuthorize as never })
  expect(result.output.ok).toBe(true)
  expect(result.output.cleanup).toMatchObject({ ok: false })
  expect(JSON.stringify(result.output.cleanup)).toContain("owned by subagent-worktree lane")
  removeClaim(common, "/w/a")
})

test("a denied inline cleanup is recorded as denied, still lands, and is never retried in the background", async () => {
  const deny = (assert: { action: string }) => {
    if (assert.action === "delivery_cleanup") throw new Error("denied by the user")
  }
  const { result, fake } = await land({}, {}, { assert: deny as never })
  expect(result.output.ok).toBe(true)
  expect(result.output.cleanup).toMatchObject({ ok: false, denied: true })
  expect(result.output.next).toEqual(["delivery_cleanup"])
  void fake
  expect(readLanding(common, "r7")).toMatchObject({ kind: "present", value: { sessionID: "s", worktree: "/w/a", denied: { sessionID: "s" } } })
})

test("a cleanup that is refused for another reason is not recorded as denied", async () => {
  cleanupResult = { ok: false, reason: "worktree.status: dirty" }
  const { result } = await land()
  expect(result.output.cleanup).not.toHaveProperty("denied")
  const record = readLanding(common, "r7")
  expect(record.kind === "present" && record.value.denied).toBeFalsy()
})

type Tools = { fake: ReturnType<typeof createFakeContext>; land: () => Promise<Result>; cleanup: (input?: Record<string, unknown>) => Promise<{ output: Record<string, unknown>; content: string }> }

async function plugin(options: Record<string, unknown> = {}, fakeOptions: Parameters<typeof createFakeContext>[0] = {}): Promise<Tools> {
  const fake = createFakeContext({ directory: repo, ...fakeOptions })
  const context = fake.context as unknown as { location: unknown; worktree: unknown; options: unknown }
  context.location = { ...(context.location as object), project: { id: "prj" } }
  context.options = options
  context.worktree = { list: async () => [{ directory: "/w/a" }], remove: async () => {} }
  const { default: definition, LAND_ACTION, CLEANUP_ACTION } = await import("./index.ts")
  await definition.setup(fake.context)
  const call = { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal }
  const run = <T>(name: string, input: unknown): Promise<T> => {
    const execute = fake.tools.get(name)?.execute as ((i: unknown, c: unknown) => Promise<T>) | undefined
    if (!execute) throw new Error(`${name} is not registered`)
    return execute(input, call)
  }
  return {
    fake,
    land: () => run<Result>(LAND_ACTION, { pr: 7 }),
    cleanup: (input = {}) => run<{ output: Record<string, unknown>; content: string }>(CLEANUP_ACTION, input),
  }
}

const aLanding = (over: Record<string, unknown> = {}) => ({
  receiptId: "r7",
  worktree: "/w/a",
  headRefOid: "h".repeat(40),
  sessionID: "s",
  landedAt: 1,
  ...over,
})

test("an explicit delivery_cleanup of a claimed lane removes nothing, re-arms the denial and reports the deferral", async () => {
  claimLane()
  writeLanding(common, aLanding({ denied: { at: 2, sessionID: "s" } }))
  const { cleanup } = await plugin()
  const result = await cleanup()
  expect(result.output).toMatchObject({ ok: true, deferred: "owned by subagent-worktree lane; removed by its owner once finished" })
  expect(result.output).not.toHaveProperty("receipt")
  const record = readLanding(common, "r7")
  expect(record.kind).toBe("present")
  expect(record.kind === "present" && record.value.denied).toBeUndefined()
  removeClaim(common, "/w/a")
})

test("an explicit delivery_cleanup of a worktree whose claim cannot be read removes nothing either", async () => {
  mkdirSync(join(common, "opencode", "lane-claims"), { recursive: true })
  writeFileSync(claimFile(common, "/w/a"), "{broken")
  const { cleanup } = await plugin()
  const result = await cleanup()
  expect(result.output.ok).toBe(true)
  expect(String(result.output.deferred)).toContain("lane claim unreadable")
  removeClaim(common, "/w/a")
})

test("an explicit delivery_cleanup of an unclaimed worktree runs as before", async () => {
  const { cleanup } = await plugin()
  const result = await cleanup()
  expect(result.output).toMatchObject({ ok: true, worktree: "/w/a" })
  expect(result.output).not.toHaveProperty("deferred")
})

test("with autoCleanup false a rejected explicit prompt still writes a denial the owner can read", async () => {
  const rejectCleanup = (assert: { action: string }) => {
    if (assert.action === "delivery_cleanup") throw new Error("denied by the user")
  }
  const { land, cleanup } = await plugin({ autoCleanup: false }, { assert: rejectCleanup as never })
  const landed = await land()
  expect(landed.output.cleanup).toBeUndefined()
  expect(readLanding(common, "r7").kind).toBe("present")
  await expect(cleanup()).rejects.toThrow("denied by the user")
  expect(readLanding(common, "r7")).toMatchObject({ kind: "present", value: { denied: { sessionID: "s" } } })
})

test("with autoCleanup false an authorized explicit call clears the denial", async () => {
  const { cleanup } = await plugin({ autoCleanup: false })
  writeLanding(common, aLanding({ denied: { at: 2, sessionID: "s" } }))
  await cleanup()
  // Cleared by the authorized call (and then dropped with the cleaned receipt's record).
  const record = readLanding(common, "r7")
  expect(record.kind === "present" ? record.value.denied : undefined).toBeUndefined()
})
