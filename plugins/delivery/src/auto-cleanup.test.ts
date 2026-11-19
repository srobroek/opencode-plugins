import { expect, test } from "bun:test"
import pkg from "../package.json" with { type: "json" }
import {
  inlineCleanupDecision,
  nextAfterCleanup,
  reportFromCleanup,
  runInlineCleanup,
  textAfterCleanup,
} from "./auto-cleanup.ts"
import type { CleanupResult } from "./cleanup.ts"
import { buildReceipt } from "./landing-receipt.ts"

const receipt = (ledgerActive: boolean, path: string | null = "/w/a") =>
  ({ beads: { ledgerActive }, worktree: { path } }) as never
const landed = buildReceipt({
  now: 1_800_000_000_000,
  emitter: { plugin: pkg.name, version: pkg.version, tool: "delivery_land" },
  repo: { key: "0123456789abcdef", canonicalRoot: "/repo", remote: "origin", forge: "github", nameWithOwner: "o/r" },
  pr: {
    number: 1,
    url: "https://github.com/o/r/pull/1",
    state: "MERGED",
    baseRefName: "main",
    headRefName: "b",
    headRefOid: "a".repeat(40),
    mergeCommitOid: "b".repeat(40),
    mergedAt: "2027-01-15T08:00:00.000Z",
  },
  branch: { name: "b", deletedRemote: true, remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z", autoDeleteSetting: "on" },
  worktree: { path: "/w/a", removed: true, localRefDeleted: true, absenceVerifiedAt: "2027-01-15T08:00:02.000Z" },
  beads: { ids: [], ledgerActive: false },
  proof: { method: "gh pr view", observedAt: "2027-01-15T08:00:00.000Z", evidence: { state: "MERGED" } },
  outcome: "cleaned",
})
const success: CleanupResult = {
  ok: true,
  receipt: landed,
  path: "/r",
  remoteBranchAbsence: "absent",
  alreadyCleaned: false,
  localRefDeleted: true,
  report: { removed: ["worktree /w/a", "local branch b"], skipped: [] },
}

test.each([
  [true, false, true],
  [false, false, false],
  [true, true, false],
])("inline cleanup enabled=%p ledgerActive=%p runs=%p", (enabled, ledgerActive, runs) => {
  expect(inlineCleanupDecision(receipt(ledgerActive), enabled).run).toBe(runs)
})

test("a successful cleanup reports the removed path and the local ref", () => {
  expect(reportFromCleanup(success)).toEqual({ ok: true, removed: "/w/a", localRefDeleted: true, alreadyCleaned: false, kept: [] })
})

test.each(["worktree.status", "worktree.operation", "worktree.stash"])("a %s refusal is reported as dirty", (gate) => {
  expect(reportFromCleanup({ ok: false, reason: `${gate}: observed x, expected y` })).toEqual({
    ok: false,
    reason: `dirty: ${gate}: observed x, expected y`,
  })
})

test("a refusal and a throw both become a failed report, never an error", async () => {
  expect(await runInlineCleanup(async () => ({ ok: false, reason: "dirty" }))).toEqual({ ok: false, reason: "dirty" })
  expect(
    await runInlineCleanup(async () => {
      throw new Error("denied")
    }),
  ).toEqual({ ok: false, reason: "denied" })
})

test("next drops delivery_cleanup only when cleanup finished", () => {
  const next = ["bd close x", "delivery_cleanup"]
  expect(nextAfterCleanup(next, { ok: true })).toEqual(["bd close x"])
  expect(nextAfterCleanup(next, { ok: false, reason: "r" })).toEqual(next)
  expect(nextAfterCleanup(next, undefined)).toEqual(next)
})

test("the text swaps the cleanup instruction for the outcome", () => {
  const text = "landed\nnext: run delivery_cleanup to remove the worktree and the local branch."
  expect(textAfterCleanup(text, { ok: true, removed: "/w/a" })).toBe(
    "landed\ncleanup: removed /w/a and its local branch; nothing left to run.",
  )
  expect(textAfterCleanup(text, { ok: false, reason: "dirty" })).toContain("cleanup: not finished (dirty)")
  expect(textAfterCleanup(text, { ok: false, skipped: true, reason: "x" })).toBe(text)
})

test("the text states what happened: removed with the ref kept, or already cleaned", () => {
  const text = "landed\nnext: run delivery_cleanup to remove the worktree and the local branch."
  expect(textAfterCleanup(text, { ok: true, removed: "/w/a", localRefDeleted: false, kept: ["local branch b left in place"] })).toBe(
    "landed\ncleanup: removed /w/a; kept: local branch b left in place.",
  )
  expect(textAfterCleanup(text, { ok: true, alreadyCleaned: true, kept: ["worktree /w/a is already gone"] })).toBe(
    "landed\ncleanup: nothing to remove (worktree /w/a is already gone).",
  )
})

test("a lane's claim defers cleanup", () => {
  const claim = { directory: "/w/a", branch: "lane", sessionID: "c", parentID: "p", createdAt: 1, generation: 1 }
  expect(inlineCleanupDecision(receipt(false), true, { owner: "lane", claim })).toEqual({
    run: false,
    reason: "owned by subagent-worktree lane",
    deferred: "owned by subagent-worktree lane",
  })
})

test("an unreadable claim defers cleanup too: nobody removes what they cannot place", () => {
  const decision = inlineCleanupDecision(receipt(false), true, { owner: "unknown", reason: "EACCES" })
  expect(decision).toMatchObject({ run: false })
  expect((decision as { deferred?: string }).deferred).toContain("lane claim unreadable (EACCES)")
})

test("no claim leaves cleanup to the proofs", () => {
  expect(inlineCleanupDecision(receipt(false), true, { owner: "none" }).run).toBe(true)
})

test("a deferred report keeps the instruction and says why", () => {
  const text = "landed\nnext: run delivery_cleanup to remove the worktree and the local branch."
  expect(textAfterCleanup(text, { ok: false, deferred: "owned by subagent-worktree lane" })).toContain(
    "cleanup: deferred (owned by subagent-worktree lane)",
  )
})
