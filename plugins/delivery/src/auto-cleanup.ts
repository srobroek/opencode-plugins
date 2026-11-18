/**
 * `delivery_land` closes its own landing: after the receipt is written it runs the
 * same cleanup `delivery_cleanup` runs, in-process, with that receipt. This file holds
 * the decision and the result shape; the proofs and the non-force removal stay in
 * `cleanup.ts`, so there is one copy of the safety logic.
 *
 * A worktree a lane owns is never removed here. `subagent-worktree` writes a claim file for
 * every lane under the git common directory (`@srobroek/opencode-lib/worktree-claims`);
 * while one exists, or cannot be read, delivery only records the landing and reports the
 * cleanup as deferred. The owner removes it once the lane is finished and landed.
 *
 * Inline cleanup is skipped when the receipt's Beads ledger is active: cleanup proves
 * every receipt bead is closed with `metadata.merge_sha`, and those closes are the
 * agent's next steps, so an inline run would always refuse before them.
 */
import type { Ownership } from "@srobroek/opencode-lib/worktree-claims"
import type { CleanupResult } from "./cleanup.ts"
import type { LandingReceipt } from "./landing-receipt.ts"

export type CleanupReport = {
  ok: boolean
  reason?: string
  removed?: string
  localRefDeleted?: boolean
  /** True when cleanup was not attempted (option off or ledger work first). */
  skipped?: boolean
  /** Why a holder kept the worktree for now; set instead of running cleanup. */
  deferred?: string
  /** The user (or policy) refused the inline cleanup. It is not retried in the background. */
  denied?: boolean
}

export type InlineDecision = { run: true } | { run: false; reason: string; deferred?: string }

/** Why a lane keeps the worktree, or undefined when nobody does. Pure. */
export function ownershipDeferral(ownership: Ownership): string | undefined {
  if (ownership.owner === "lane") return "owned by subagent-worktree lane"
  if (ownership.owner === "unknown") return `lane claim unreadable (${ownership.reason})`
  return undefined
}

/** Whether landing may run cleanup now. Pure. */
export function inlineCleanupDecision(
  receipt: Pick<LandingReceipt, "beads" | "worktree">,
  enabled: boolean,
  ownership: Ownership = { owner: "none" },
): InlineDecision {
  if (!enabled) return { run: false, reason: "autoCleanup is off" }
  const deferred = ownershipDeferral(ownership)
  if (deferred !== undefined) return { run: false, reason: deferred, deferred }
  if (receipt.beads.ledgerActive) {
    return {
      run: false,
      reason: "the Beads ledger is active: close the beads in next first, then delivery_cleanup can prove the closeout",
    }
  }
  return { run: true }
}

/** The clean-check refusals of `cleanup.ts`: tracked/untracked changes, an operation in progress, a stash. */
const DIRTY_GATE = /^worktree\.(?:status|operation|stash):/

/** Fold a cleanup result into the report a land result carries. Pure. */
export function reportFromCleanup(result: CleanupResult): CleanupReport {
  if (!result.ok) return { ok: false, reason: DIRTY_GATE.test(result.reason) ? `dirty: ${result.reason}` : result.reason }
  // cleanupDelivery verifies the registration, path, local ref and remote ref absences before it succeeds.
  return { ok: true, removed: result.receipt.worktree.path ?? "", localRefDeleted: true }
}

/** Run cleanup, turning any throw (a denied prompt, a host fault) into a failed report. */
export async function runInlineCleanup(run: () => Promise<CleanupResult>): Promise<CleanupReport> {
  try {
    return reportFromCleanup(await run())
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** `next` after landing: the cleanup step stays only while cleanup has not finished. */
export function nextAfterCleanup(next: readonly string[], report: CleanupReport | undefined): string[] {
  return report?.ok === true ? next.filter((step) => step !== "delivery_cleanup") : [...next]
}

const NEXT_CLEANUP_LINE = "next: run delivery_cleanup to remove the worktree and the local branch."

/**
 * The land text with the cleanup outcome. A finished cleanup replaces the "run
 * delivery_cleanup" line; a refusal appends why; a skipped run leaves the text as is.
 */
export function textAfterCleanup(text: string, report: CleanupReport): string {
  if (report.skipped) return text
  if (report.deferred !== undefined) {
    return [...text.split("\n"), `cleanup: deferred (${report.deferred}); its owner removes it once the lane is finished and landed, or call delivery_cleanup.`].join("\n")
  }
  const lines = text.split("\n")
  if (report.ok) {
    const at = lines.indexOf(NEXT_CLEANUP_LINE)
    const kept = at >= 0 ? lines.slice(0, at) : lines
    return [...kept, `cleanup: removed ${report.removed} and its local branch; nothing left to run.`].join("\n")
  }
  return [...lines, `cleanup: not finished (${report.reason}); the landing stands. Fix that and call delivery_cleanup.`].join("\n")
}
