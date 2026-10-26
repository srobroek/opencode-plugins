/**
 * Branch recovery, ported unchanged from omp-plugins `session/extensions/store.ts`.
 *
 * No record carries a git branch, so the branch a session worked on is recovered
 * from what it ran. Only a switch confirmation states that this session moved onto
 * a branch. Status output is real git output but describes whatever directory the
 * command ran in. A bare command is weaker still: it may have failed. The latest
 * sighting in the strongest tier wins.
 */

export type BranchTier = "switched" | "status" | "created" | "mentioned"

/** `git` tolerates global options before the subcommand (`git -C dir …`, `dgit push …`). */
const GIT = String.raw`\b[a-z]*git(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+`

const BRANCH_PATTERNS: Record<BranchTier, RegExp[]> = {
  switched: [/Switched to (?:a new )?branch '([^']+)'/g, /^branch '([^']+)' set up to track/gm],
  status: [/^On branch (\S+)$/gm, /Your branch is (?:up to date with|ahead of) '[^'/]+\/([^']+)'/g],
  created: [
    new RegExp(`${GIT}worktree\\s+add\\b[^\\n;&|]*?\\s-b\\s+(\\S+)`, "g"),
    new RegExp(`${GIT}(?:checkout|switch)\\s+(?:-b|-c|-B)\\s+(\\S+)`, "g"),
  ],
  mentioned: [
    new RegExp(`${GIT}(?:checkout|switch)\\s+(?!-)(\\S+)`, "g"),
    new RegExp(`${GIT}push\\s+(?:--?\\S+\\s+)*\\S+\\s+(\\S+)`, "g"),
  ],
}

/** Tiers below this are labelled `(inferred)`: git never confirmed them. */
export const EXACT_TIERS: Record<BranchTier, boolean> = {
  switched: true,
  status: true,
  created: false,
  mentioned: false,
}

const TIER_RANK: Record<BranchTier, number> = { switched: 4, status: 3, created: 2, mentioned: 1 }
const NOT_A_BRANCH: Record<string, true> = {
  HEAD: true,
  "--": true,
  "-": true,
  "@": true,
  FETCH_HEAD: true,
  ORIG_HEAD: true,
}

function cleanBranch(raw: string): string | null {
  // A `src:dst` push names the remote branch on the right.
  let value = raw.includes(":") ? (raw.split(":").pop() ?? "") : raw
  value = value.replace(/["'`]/g, "").replace(/^refs\/heads\//, "")
  if (!value || NOT_A_BRANCH[value] || /^[-/~$]/.test(value)) return null
  if (/\.[a-z]{1,5}$/.test(value)) return null // `git checkout package.json`
  if (/^[0-9a-f]{7,40}$/.test(value)) return null // a sha, not a branch
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return null
  return value
}

export type BranchEvidence = { branch: string; tier: BranchTier }

/** Accumulates branch evidence, keeping the latest sighting from the strongest tier seen so far. */
export class BranchTracker {
  private best: BranchEvidence | null = null

  offer(text: string, tier: BranchTier): void {
    if (this.best && TIER_RANK[this.best.tier] > TIER_RANK[tier]) return
    let found: string | null = null
    for (const pattern of BRANCH_PATTERNS[tier]) {
      for (const match of text.matchAll(pattern)) {
        const raw = match[1]
        if (raw === undefined) continue
        const value = cleanBranch(raw)
        if (value) found = value // later evidence within one text wins
      }
    }
    if (found) this.best = { branch: found, tier }
  }

  /** A command the session ran: creating and mentioning tiers. */
  command(command: string): void {
    this.offer(command, "created")
    this.offer(command, "mentioned")
  }

  /** Output git printed: switching and status tiers. */
  output(output: string): void {
    this.offer(output, "switched")
    this.offer(output, "status")
  }

  get(): BranchEvidence | null {
    return this.best
  }
}
