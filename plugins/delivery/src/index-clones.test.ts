import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { readLanding, removeClaim, writeClaim } from "@srobroek/opencode-lib/worktree-claims"
import type { CleanupDeps, CleanupResult } from "./cleanup.ts"
import * as realCleanup from "./cleanup.ts"
import { cloneRegistryFile } from "./clone-registry.ts"
import * as realLand from "./land.ts"
import { buildReceipt, type LandingReceipt, receiptDirectory, repositoryContext, writeReceipt } from "./landing-receipt.ts"

// Landing needs a forge and cleanup needs a real remote; both are replaced so the test sees only how
// the registered tools and the turn-end retry chain them across two real repositories: the session's
// (A) and the one a landing targets (B).
const originalCleanup = { ...realCleanup }
const originalLand = { ...realLand }

let repoA = ""
let repoB = ""
let commonA = ""
let commonB = ""
let receiptsRoot = ""
let worktree = ""
let sequence = 0
let cleanupResult: CleanupResult
let cleanupCalls: Array<{ params: Record<string, unknown>; deps: CleanupDeps }> = []
const env = (): NodeJS.ProcessEnv => ({ HOME: process.env.HOME ?? "", DELIVERY_RECEIPTS_DIR: receiptsRoot })
const disposers: Array<() => Promise<void>> = []

const FAILED: CleanupResult = { ok: false, reason: "worktree.status: dirty" }
const REMOVED = { ok: true, path: "/r", receipt: { branch: { name: "feat" }, worktree: { path: "/w" } }, remoteBranchAbsence: "absent", alreadyCleaned: false, localRefDeleted: true, report: { removed: ["worktree"], skipped: [] } } as never

function receiptIn(repoRoot: string, now: number, over: Partial<Parameters<typeof buildReceipt>[0]> = {}): LandingReceipt {
  const context = repositoryContext(repoRoot)
  if (context === null) throw new Error("fixture repository has no context")
  return buildReceipt({
    now,
    emitter: { plugin: "test", version: "0", tool: "delivery_land" },
    repo: { key: context.key, canonicalRoot: context.ledger.root, remote: "origin", forge: "github", nameWithOwner: "o/b" },
    pr: {
      number: 7,
      url: "https://github.com/o/b/pull/7",
      state: "MERGED",
      baseRefName: "main",
      headRefName: "feat",
      headRefOid: "a".repeat(40),
      mergeCommitOid: "b".repeat(40),
      mergedAt: "2027-01-15T08:00:00.000Z",
    },
    branch: { name: "feat", deletedRemote: true, remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z", autoDeleteSetting: "on" },
    worktree: { path: worktree, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
    beads: { ids: [], ledgerActive: false },
    proof: { method: "gh pr view", observedAt: "2027-01-15T08:00:00.000Z", evidence: { state: "MERGED" } },
    outcome: "landed",
    ...over,
  })
}

beforeAll(() => {
  const init = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "clones-repo-"))
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
    return dir
  }
  repoA = init()
  repoB = init()
  commonA = repositoryContext(repoA)?.commonDir as string
  commonB = repositoryContext(repoB)?.commonDir as string
  mock.module("./cleanup.ts", () => ({
    ...originalCleanup,
    cleanupDelivery: async (params: Record<string, unknown>, _cwd: string, deps: CleanupDeps) => {
      cleanupCalls.push({ params, deps })
      return cleanupResult
    },
  }))
  mock.module("./land.ts", () => ({
    ...originalLand,
    landPullRequest: async () => {
      const receipt = receiptIn(repoB, Date.now() + ++sequence)
      const receiptPath = writeReceipt(receipt, receiptDirectory(env(), receipt.repo.key))
      return { ok: true, receipt, receiptPath, text: "landed", next: [] }
    },
  }))
})
afterAll(() => {
  rmSync(repoA, { recursive: true, force: true })
  rmSync(repoB, { recursive: true, force: true })
  mock.module("./cleanup.ts", () => originalCleanup)
  mock.module("./land.ts", () => originalLand)
})
beforeEach(() => {
  receiptsRoot = mkdtempSync(join(tmpdir(), "clones-receipts-"))
  worktree = mkdtempSync(join(tmpdir(), "clones-worktree-"))
  cleanupCalls = []
  cleanupResult = FAILED
})
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  removeClaim(commonB, worktree)
  rmSync(receiptsRoot, { recursive: true, force: true })
  rmSync(worktree, { recursive: true, force: true })
})

type Result = { output: Record<string, unknown>; content: string }
type Session = {
  land: () => Promise<Result>
  cleanup: (input: Record<string, unknown>) => Promise<Result>
  /** What the host does at a turn end for the session. */
  idle: () => Promise<void>
  dispose: () => Promise<void>
}

/** A fresh `setupDelivery`: a new process, as after a server restart. */
async function session(sessionID = "s"): Promise<Session> {
  const fake = createFakeContext({ directory: repoA })
  const context = fake.context as unknown as { location: unknown; worktree: unknown; options: unknown }
  context.location = { ...(context.location as object), project: { id: "prj" } }
  context.options = { receiptsDirectory: receiptsRoot }
  context.worktree = { list: async () => [], remove: async () => {} }
  const { setupDelivery, LAND_ACTION, CLEANUP_ACTION } = await import("./index.ts")
  const dispose = await setupDelivery(fake.context, { debounceMs: 0 })
  disposers.push(dispose)
  const call = { sessionID, agent: "a", messageID: "m", id: "c", signal: new AbortController().signal }
  const run = (name: string, input: unknown): Promise<Result> => {
    const execute = fake.tools.get(name)?.execute as ((i: unknown, c: unknown) => Promise<Result>) | undefined
    if (!execute) throw new Error(`${name} is not registered`)
    return execute(input, call)
  }
  return {
    land: () => run(LAND_ACTION, { pr: 7, repo: "o/b", repoPath: repoB }),
    cleanup: (input) => run(CLEANUP_ACTION, input),
    idle: async () => {
      await fake.fire.session("experimental.idle", { sessionID, background: [] })
    },
    dispose,
  }
}

const registryOf = (sessionID = "s") => {
  const file = cloneRegistryFile(env(), sessionID)
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { version: number; clones: Array<Record<string, unknown>> }) : undefined
}

test("a landing whose cleanup did not finish is registered under .clones and retried at the turn end", async () => {
  const s = await session()
  const landed = await s.land()
  expect(landed.output.cleanup).toMatchObject({ ok: false })
  expect(cloneRegistryFile(env(), "s").startsWith(join(receiptsRoot, ".clones"))).toBe(true)
  const registry = registryOf()
  expect(registry).toMatchObject({ version: 1, clones: [{ commonDir: commonB, root: repositoryContext(repoB)?.ledger.root, repo: "o/b" }] })
  expect(registry?.clones[0]?.receiptIds).toHaveLength(1)
  const [receiptId] = (registry?.clones[0]?.receiptIds as string[] | undefined) ?? []
  expect(readLanding(commonB, receiptId as string).kind).toBe("present")
  expect(readLanding(commonA, receiptId as string).kind).toBe("missing")

  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle()
  const params = cleanupCalls.map((c) => c.params)
  expect(params).toEqual([
    { receipt: join(receiptDirectory(env(), registry?.clones[0]?.key as string), `${receiptId}.json`), repo: "o/b", repoPath: repositoryContext(repoB)?.ledger.root },
  ])
  expect(registryOf()).toBeUndefined()
})

test("a fresh setupDelivery after a restart still finds the registered receipts", async () => {
  const first = await session()
  await first.land()
  await first.dispose()
  cleanupCalls = []
  cleanupResult = REMOVED
  const restarted = await session()
  await restarted.idle()
  expect(cleanupCalls).toHaveLength(1)
  expect(cleanupCalls[0]?.params).toMatchObject({ repo: "o/b" })
})

test("receipts in the target that another session landed are ignored", async () => {
  const mine = await session("s")
  await mine.land()
  const other = receiptIn(repoB, Date.now() + 1000)
  writeReceipt(other, receiptDirectory(env(), other.repo.key))
  cleanupCalls = []
  cleanupResult = REMOVED
  await mine.idle()
  expect(cleanupCalls).toHaveLength(1)
  expect(String(cleanupCalls[0]?.params.receipt)).not.toContain(other.receiptId)
})

test("a lane claim in the target keeps the retry from cleaning, and the registration stays", async () => {
  const s = await session()
  await s.land()
  writeClaim(commonB, { directory: worktree, branch: "lane-a", sessionID: "c", parentID: "p", createdAt: 1 })
  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle()
  expect(cleanupCalls).toEqual([])
  expect(registryOf()?.clones).toHaveLength(1)
})

test("gc drops the registration once the receipt is cleaned", async () => {
  const s = await session()
  await s.land()
  const registry = registryOf()
  const [receiptId] = (registry?.clones[0]?.receiptIds as string[] | undefined) ?? []
  const directory = receiptDirectory(env(), registry?.clones[0]?.key as string)
  const landed = JSON.parse(readFileSync(join(directory, `${receiptId}.json`), "utf8")) as LandingReceipt
  const cleaned = receiptIn(repoB, Date.now() + 5000, {
    continues: landed,
    outcome: "cleaned",
    worktree: { path: worktree, removed: true, localRefDeleted: true, absenceVerifiedAt: "2027-01-15T08:00:02.000Z" },
  })
  writeReceipt(cleaned, directory)
  cleanupResult = REMOVED
  await s.cleanup({ receipt: join(directory, `${receiptId}.json`), repo: "o/b", repoPath: repoB })
  expect(registryOf()).toBeUndefined()
})
