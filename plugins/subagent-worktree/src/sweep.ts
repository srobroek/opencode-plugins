/**
 * The backstop sweep's decisions. It covers what events and idle gates cannot see: a hard
 * crash or restart, a PR merged on the forge after its lead went idle, and worktrees from
 * before lanes existed. Pure: `lifecycle.ts` gathers the facts and acts on the plan.
 */

export type Verdict = "keep" | "prune" | "quarantine" | "prune-registry"

export type WorktreeFacts = {
  path: string
  branch?: string
  /** The path is under OpenCode's worktree root, an `include` root, or a lane record names it. */
  agentPath: boolean
  /** The directory exists on disk. */
  exists: boolean
  /** A live session works in it: "yes", "no", or "unknown" when ownership could not be established. */
  owner: "yes" | "no" | "unknown"
  ageMs: number | undefined
  /** Tip reached the base branch (ancestor, merged PR head or `wt` integrated). */
  landed: boolean
  /** Uncommitted/untracked changes, a stash, or an operation in progress; undefined when unreadable. */
  dirty: boolean | undefined
  /** Commits not on the base branch. */
  ahead: number | undefined
  /** Commits exist that no remote has. */
  unpushed: boolean
}

export type SweepOptions = { minAgeMs: number }

export type Classification = { verdict: Verdict; reason: string; deleteBranch?: boolean }

export function classifyWorktree(facts: WorktreeFacts, options: SweepOptions): Classification {
  if (!facts.agentPath) return { verdict: "keep", reason: "not an agent worktree" }
  if (!facts.exists) return { verdict: "prune-registry", reason: "directory is gone" }
  if (facts.owner === "yes") return { verdict: "keep", reason: "a live session owns it" }
  if (facts.owner === "unknown") return { verdict: "keep", reason: "owner unknown" }
  if (facts.ageMs === undefined || facts.ageMs < options.minAgeMs) return { verdict: "keep", reason: "too young" }
  if (facts.dirty === undefined || facts.ahead === undefined) return { verdict: "keep", reason: "state unreadable" }
  if (!facts.landed) {
    if (facts.dirty) return { verdict: "quarantine", reason: "uncommitted work, not landed" }
    if (facts.unpushed) return { verdict: "quarantine", reason: "unpushed commits, not landed" }
    return { verdict: "keep", reason: facts.ahead > 0 ? `${facts.ahead} commits, not landed` : "no work to land" }
  }
  if (facts.dirty) return { verdict: "quarantine", reason: "landed but dirty" }
  return { verdict: "prune", reason: "landed and clean", deleteBranch: facts.branch !== undefined }
}

export type PlanEntry = { path: string; branch?: string } & Classification

/** One entry per path, sorted, so a second run over the same facts gives the same plan. */
export function planSweep(list: readonly WorktreeFacts[], options: SweepOptions): PlanEntry[] {
  const seen = new Set<string>()
  const plan: PlanEntry[] = []
  for (const facts of list) {
    if (seen.has(facts.path)) continue
    seen.add(facts.path)
    plan.push({ path: facts.path, ...(facts.branch ? { branch: facts.branch } : {}), ...classifyWorktree(facts, options) })
  }
  return plan.sort((a, b) => a.path.localeCompare(b.path))
}

export function formatPlan(plan: readonly PlanEntry[], mode: "report" | "prune"): string {
  if (plan.length === 0) return "subagent_worktree_sweep: no worktrees to consider."
  const lines = plan.map((entry) => `${entry.verdict.padEnd(14)} ${entry.path}${entry.branch ? ` (${entry.branch})` : ""}: ${entry.reason}`)
  const quarantined = plan.filter((entry) => entry.verdict === "quarantine").length
  return [`subagent_worktree_sweep (${mode}):`, ...lines, quarantined > 0 ? `${quarantined} quarantined: kept, needs a person.` : ""].filter(Boolean).join("\n")
}
