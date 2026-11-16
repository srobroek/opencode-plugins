import { describe, expect, test } from "bun:test"
import type { LandingReceipt } from "./landing-receipt.ts"
import { nudgeText, type PendingFacts, pendingCleanupAction, pendingReceipts } from "./pending-cleanup.ts"

const receipt = (over: Record<string, unknown> = {}) =>
  ({
    receiptId: "r1",
    supersedes: null,
    outcome: "landed",
    pr: { number: 17, mergeCommitOid: "m".repeat(40) },
    beads: { ids: ["delivery-17"], ledgerActive: true },
    worktree: { path: "/wt/a", removed: false },
    ...over,
  }) as unknown as LandingReceipt

const facts = (over: Partial<PendingFacts> = {}): PendingFacts => ({
  worktreeGone: false,
  done: false,
  hold: undefined,
  beads: "closed",
  recentlyTried: false,
  landingSession: true,
  idle: true,
  nudged: false,
  denied: false,
  ...over,
})

describe("pendingCleanupAction", () => {
  const rows: Array<[string, Partial<PendingFacts>, string]> = [
    ["beads open, landing session idle", { beads: "open" }, "nudge"],
    ["beads open, nudge already sent", { beads: "open", nudged: true }, "skip"],
    ["beads open, another session", { beads: "open", landingSession: false }, "skip"],
    ["beads open, turn ended but not idle", { beads: "open", idle: false }, "skip"],
    ["beads closed", { beads: "closed" }, "retry"],
    ["ledger state unknown", { beads: "unknown" }, "retry"],
    ["a hold is active", { hold: "lane x still active" }, "hold"],
    ["a hold wins over open beads", { hold: "busy", beads: "open" }, "hold"],
    ["already done", { done: true }, "skip"],
    ["the inline cleanup was denied", { denied: true }, "skip"],
    ["denied, even with the beads closed", { denied: true, beads: "closed" }, "skip"],
    ["denied, even with open beads", { denied: true, beads: "open" }, "skip"],
    ["tried a moment ago", { recentlyTried: true }, "skip"],
    ["the worktree is already gone", { worktreeGone: true }, "done"],
  ]
  for (const [name, over, action] of rows) {
    test(name, () => {
      expect(pendingCleanupAction(receipt(), facts(over)).action).toBe(action as never)
    })
  }

  test("a receipt without a worktree has nothing to retry", () => {
    expect(pendingCleanupAction(receipt({ worktree: { path: null, removed: false } }), facts()).action).toBe("skip")
  })
})

test("pending receipts exclude cleaned, superseded and worktree-less ones", () => {
  const list = [
    receipt({ receiptId: "c2", supersedes: "r1", outcome: "cleaned", worktree: { path: "/wt/a", removed: true } }),
    receipt({ receiptId: "r1" }),
    receipt({ receiptId: "r3", worktree: { path: null, removed: false } }),
    receipt({ receiptId: "r4", worktree: { path: "/wt/b", removed: false } }),
  ]
  expect(pendingReceipts(list).map((entry) => entry.receiptId)).toEqual(["r4"])
})

test("the nudge names the beads and their close-out commands", () => {
  const text = nudgeText(receipt(), "/r/r1.json")
  expect(text).toContain("Landed PR #17: close beads delivery-17 (commands: bd update delivery-17")
  expect(text).toContain("bd close delivery-17")
  expect(text).toContain("so its worktree can be cleaned up.")
})
