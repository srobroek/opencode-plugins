/**
 * `delivery_land`: prove a pull request landed, then emit exactly one receipt.
 *
 * The tool is the sequencing layer over two library modules and owns no proof
 * logic of its own. `forge-adapter.ts` classifies the remote, reads and writes
 * the deletion-on-merge setting, builds the merge argv, and owns the single
 * observation that can answer "is the branch gone". `landing-receipt.ts` owns the
 * receipt's shape, its identity, its validation, and its atomic publication. What
 * is left here is order, refusal, and the mapping from two forge dialects onto the
 * receipt's `pr` fields.
 *
 * Trust model: the GitHub API is trusted; these checks guard against races and mistakes,
 * not a malicious forge.
 *
 * Five properties this file exists to hold.
 *
 * A merge is issued at most once, and only against the exact subject that was
 * read and the head the caller reviewed. A pull request the forge already reports
 * as MERGED is proved, not merged again: no merge argv is built, and the receipt
 * says so in its notes. A merge needs `expectHeadSha` to name the observed head;
 * only that already-MERGED proof may omit it. On the merge path every command
 * binds its repository with `--repo` and the merge binds the first observed head —
 * `--match-head-commit` on GitHub, `--sha` on GitLab — so neither the working
 * directory nor an ambient `GH_REPO` or `GH_HOST` chooses what lands, and a push
 * between the read and the merge fails the merge at the forge instead of landing a
 * commit nobody here observed. A squash takes the pull request title as its
 * subject. Every payload is checked to carry the requested number, and the re-read
 * must still show that head on that base. The proof is the re-read, never the
 * merge's own exit status: a zero exit is a request that was accepted, not an
 * observation of state. A rebase landing rewrites commit SHAs, so it is proved by
 * ordered `git patch-id --stable` equivalence between the reviewed commits and the
 * landed ones, not by the reviewed head's ancestry.
 *
 * The forge merges on its side, so the commits that proof reads are fetched first.
 * Each commit the shape proof needs is checked locally with `git cat-file -e`, and a
 * missing one is fetched by id from the landing's remote, falling back to the base
 * branch, on a short bounded schedule for a forge whose Git service lags its API.
 * The fetch writes objects only and moves no ref, so the proof still reads exact ids.
 *
 * A merge this call issued is never left unaccounted for. If anything after the
 * forge accepted it refuses — the re-read, the fetch, the shape proof, the receipt —
 * no receipt is written, because cleanup acts on every receipt it accepts, and the
 * refusal carries `mergeIssued: true` and says the request is merged: re-running with
 * the same inputs reads it as MERGED, issues no merge, and writes the receipt once
 * the proof completes. Merging at most once and writing nothing unproved both hold
 * across that retry.
 *
 * Nothing is written before the proof exists. An `expectHeadSha` that is missing
 * or disagrees with the observed head, a `worktree` whose HEAD is not that head, a
 * payload for another pull request, a head or base that moved between the two
 * reads, a re-read that is not MERGED, a merge commit oid that is absent, and a
 * receipt the validator refuses each end the call with no merge issued past that
 * point and no file created. Every refusal names the field, the observed value,
 * and what was expected.
 *
 * A setting changes only when a caller asks for it, and only once nothing is left
 * to refuse. `setupAutoDelete` must be exactly `true` to reach
 * {@link enableAutoDelete}; absent, false, or any other value issues no
 * repository-setting write, and the observed setting is recorded either way.
 * `"unknown"` is recorded as `"unknown"` and never promoted. The setting is neither
 * read nor written until the landing is proved and its receipt has passed the
 * validator, because it governs every later merge by every contributor: a landing
 * this call refused, or that the forge rejected, leaves the repository as it was.
 *
 * Every command can be interrupted. Each child process runs through an abortable
 * runner that carries the tool call's signal as well as its deadline, so an
 * interrupt ends a hung `gh` instead of waiting out its timeout, and an abort
 * observed between steps stops the call before its next merge or write.
 *
 * The ledger is not this package's to write, and not this call's directory to
 * classify. Delivery proves and beads records, so this tool runs no `bd` verb at
 * all — the receipt is the hand-off, and the result text names the native bead
 * update and close commands before `delivery_cleanup`. `beads.ledgerActive` is classified at the repository's canonical root, so a
 * nested retired `.beads` under the directory this tool was called in cannot record
 * a landing as ledger-free and send cleanup past a reconciliation that never
 * happened. On an active ledger the landing must also be able to name the bead it
 * closes, from the branch convention or from `beadId`, because a receipt with an
 * active ledger and no ids is a gate with nothing to check.
 */

import { resolve } from "node:path"
import { type GitPin, physical, verifyCheckout } from "@srobroek/opencode-lib/checkout-marker"
import pkg from "../package.json" with { type: "json" }
import { readApproval, readChecks } from "./approval.ts"
import { parseWorktreeList, type WorktreeRecord } from "./cleanup.ts"
import {
  allowMergeCommit,
  autoDeleteSetting,
  type CliResult,
  type CliRunner,
  enableAutoDelete,
  FETCH_TIMEOUT_MS,
  FORGE_TIMEOUT_MS,
  fetchCommitsArgv,
  forgeEnvironment,
  forgeTarget,
  type GitlabHost,
  gitObservationEnvironment,
  MERGE_METHODS,
  type MergeMethod,
  mergeArgs,
  normalizeRepoPath,
  REMOTE_NAME,
  redactRemote,
  remoteBranchAbsent,
  remoteBranchTipArgv,
  repoPathFromRemote,
  runCli,
  SAFE_GIT_ARGS,
  singleRemoteRecord,
} from "./forge-adapter.ts"
import {
  buildReceipt,
  type CanonicalLedger,
  closeoutCommands,
  type LandingReceipt,
  listReceipts,
  RECEIPT_METHOD_UNKNOWN,
  REPOSITORY_OBSERVATION_ARGS,
  type ReceiptAutoDelete,
  receiptDirectory,
  repositoryContext,
  validateReceipt,
  writeReceipt,
} from "./landing-receipt.ts"
import {
  acquireEnqueueLock,
  awaitQueue,
  bindingFailure,
  branchContains,
  clearPending,
  containmentArgv,
  decideQueue,
  enqueueAnswer,
  enqueueArgv,
  newGeneration,
  PLAN_GATE_MESSAGE,
  queueBudgetMs,
  readPending,
  readQueueRule,
  readSnapshot,
  removePendingLocked,
  writePending,
} from "./merge-queue.ts"

/** Wall-clock ceiling for the local Git reads this file issues itself. */
const GIT_TIMEOUT_MS = 5_000

/**
 * What a pull request number may be before it becomes an argv element.
 *
 * {@link mergeArgs} applies the same rule to the merge argv. It is applied here
 * too, and earlier, because the read that precedes the merge also puts the number
 * on a command line, and a value beginning with `-` is read as an option there
 * just as readily.
 */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/

/**
 * The branch convention that names the work a landing closes.
 *
 * `omp/agent/<bead-id>` and `opencode/agent/<bead-id>` are where agent worktrees put
 * bead ids, so a branch following either needs no `beadId` argument. A branch that does not follow it records no id from
 * the convention, and on a repository whose canonical ledger is active the landing
 * then refuses unless the caller supplies one: a receipt claiming an active ledger
 * with nothing to reconcile would send cleanup past a gate that never ran.
 */
const AGENT_BRANCH = /^(?:omp|opencode)\/agent\/([A-Za-z0-9][A-Za-z0-9._-]*)$/

/**
 * What an explicit `beadId` may be.
 *
 * The value is recorded in a receipt that `delivery_cleanup` passes to `bd show` as
 * an argv element, so it is shape-checked here rather than where it is spent: the
 * same charset the branch convention captures, and never a leading `-`.
 */
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The GitHub fields a landing proof needs, in one `--json` projection. */
const PR_FIELDS = "id,number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,title"

/**
 * A whole Git object id, in the lower-case hex both forges print.
 *
 * Only a whole id can bind a merge: `gh pr merge --match-head-commit` and
 * `glab mr merge --sha` compare the value they are given against the source head,
 * and an abbreviation or a ref name is a value the forge will not match, which is
 * indistinguishable from not binding at all.
 */
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export type LandParams = {
  pr: number | string
  repo?: string
  remote?: string
  expectHeadSha?: string
  setupAutoDelete?: boolean
  worktree?: string
  /**
   * The bead this landing closes, for a branch the `<omp|opencode>/agent/<bead-id>`
   * convention does not name; it is not a way to override the convention's answer.
   */
  beadId?: string
  /** The forge landing strategy; defaults to squash for compatibility. */
  merge_method?: MergeMethod | string
  /** Before merging, require an approval artifact on the PR for the exact head. */
  requireApproval?: boolean
  /** Before merging, require every check on the PR head to have passed. */
  requireGreenChecks?: boolean
  /**
   * How long to wait for a GitHub merge queue to merge the enqueued head, in seconds
   * (0 to 3600, default 600). Ignored when the base branch takes direct merges.
   */
  queueWaitSeconds?: number
}

/** What a landing is about to do, handed to {@link LandDeps.authorize} before any write. */
export type LandAuthorization = {
  /** `owner/name#number`. */
  resource: string
  forge: "github" | "gitlab"
  head: string
  /** The merge method, or null when the request is already MERGED and nothing is merged. */
  merge: MergeMethod | null
  setupAutoDelete: boolean
}

/**
 * Injected surroundings.
 *
 * One `run` seam covers every child process — the forge CLIs and Git alike — so a
 * test that records calls records all of them, which is what makes "issued no
 * merge argv" and "issued no `bd` argv" observable rather than argued.
 */
export type LandDeps = {
  run?: CliRunner
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** The single millisecond the receipt id, `emittedAt`, and every proof timestamp share. */
  now?: () => number
  /** Receipt directory override. Absent, {@link receiptDirectory} decides. */
  receiptsDirectory?: string
  /**
   * Called once every read has passed and before the first write (merge, setting,
   * receipt). A throw ends the call with nothing written; the error propagates.
   */
  authorize?: (request: LandAuthorization) => Promise<void>
  /** The tool call's abort signal: it ends the running command and stops every later step. */
  signal?: AbortSignal
  /** The wait between attempts to fetch landed commits; tests replace it to observe the schedule. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export type LandOutcome =
  | { ok: true; receipt: LandingReceipt; receiptPath: string; text: string; next: readonly string[] }
  /**
   * `mergeIssued` is true only when this call's merge was accepted by the forge and a
   * later step refused: the forge holds the landing, no receipt exists, and re-running
   * with the same inputs proves the MERGED request without merging it again.
   */
  | { ok: false; reason: string; text: string; mergeIssued?: true; queued?: true }
  /**
   * The merge queue still holds the pull request when the wait budget ran out: nothing
   * is merged yet and nothing is wrong. Calling again with the same inputs waits on the
   * existing entry (it is not enqueued twice) and writes the receipt once it merges.
   */

/** One observed pull request, in receipt spelling, from either forge's dialect. */
type PrObservation = {
  /** The forge's node id (GitHub only); the merge queue enqueue is pinned to it. */
  nodeId: string | null
  number: number
  url: string
  /** Only a squash spends it, as the commit subject, so only a squash requires it. */
  title: string | null
  state: string
  baseRefName: string
  headRefName: string
  headRefOid: string
  mergeCommitOid: string | null
  mergedAt: string | null
}

/** The observed value, named so a refusal is actionable without re-running anything. */
function show(value: unknown): string {
  if (value === undefined) return "absent"
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "object") return Array.isArray(value) ? `an array of ${value.length}` : "an object"
  return String(value)
}

function landingMethod(value: unknown): { method: MergeMethod } | { reason: string } {
  const method = value === undefined ? "squash" : value
  if (typeof method === "string" && MERGE_METHODS.includes(method as MergeMethod))
    return { method: method as MergeMethod }
  return { reason: `merge_method: observed ${show(value)}, expected one of "squash", "merge", "rebase"` }
}

/**
 * Read an own, enumerable data property.
 *
 * A forge CLI's JSON is untrusted input, so `in` and a plain member read are both
 * wrong: each consults the prototype chain, and a polluted `Object.prototype`
 * would supply a `state` or a `mergeCommit` the forge never sent. An accessor is
 * skipped rather than invoked — reading a payload must execute nothing.
 */
function ownValue(holder: unknown, key: string): unknown {
  if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(holder, key)
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined
  return descriptor.value
}

function stringField(holder: unknown, key: string): string | null {
  const value = ownValue(holder, key)
  return typeof value === "string" ? value : null
}

function integerField(holder: unknown, key: string): number | null {
  const value = ownValue(holder, key)
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

/**
 * A merge commit oid in canonical spelling, or null when the payload holds none.
 *
 * Case is normalised because the receipt id is built from the first 12 characters
 * and `landing-receipt.ts` mints and validates them lowercase. An empty or
 * whitespace-only field becomes null: a forge that returns `""` for an unmerged
 * request has not named a commit, and carrying `""` forward would let an empty
 * string stand in for proof.
 */
function mergeOid(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim().toLowerCase()
  return trimmed === "" ? null : trimmed
}

/**
 * Map one forge's pull-request payload onto {@link PrObservation}.
 *
 * Refuses by field name when a required field is not the type the receipt needs.
 * Emptiness is deliberately not judged here: `validateReceipt` is the one place
 * that decides what a receipt field may hold, and duplicating its rules would
 * create a second, drifting opinion.
 */
function observePr(forge: "github" | "gitlab", payload: unknown): PrObservation | { reason: string } {
  const keys =
    forge === "github"
      ? {
          number: "number",
          url: "url",
          state: "state",
          base: "baseRefName",
          head: "headRefName",
          oid: "headRefOid",
          mergedAt: "mergedAt",
        }
      : {
          number: "iid",
          url: "web_url",
          state: "state",
          base: "target_branch",
          head: "source_branch",
          oid: "sha",
          mergedAt: "merged_at",
        }
  const number = integerField(payload, keys.number)
  if (number === null)
    return {
      reason: `pr.number: observed ${show(ownValue(payload, keys.number))}, expected an integer in field ${keys.number}`,
    }
  for (const [field, key] of [
    ["pr.url", keys.url],
    ["pr.state", keys.state],
    ["pr.baseRefName", keys.base],
    ["pr.headRefName", keys.head],
    ["pr.headRefOid", keys.oid],
  ] as const) {
    if (stringField(payload, key) === null) {
      return { reason: `${field}: observed ${show(ownValue(payload, key))}, expected a string in field ${key}` }
    }
  }
  const merge =
    forge === "github"
      ? mergeOid(stringField(ownValue(payload, "mergeCommit"), "oid"))
      : (mergeOid(stringField(payload, "merge_commit_sha")) ?? mergeOid(stringField(payload, "squash_commit_sha")))
  const mergedAt = stringField(payload, keys.mergedAt)
  return {
    nodeId: forge === "github" ? stringField(payload, "id") : null,
    number,
    url: stringField(payload, keys.url) ?? "",
    title: stringField(payload, "title"),
    state: stringField(payload, keys.state) ?? "",
    baseRefName: stringField(payload, keys.base) ?? "",
    headRefName: stringField(payload, keys.head) ?? "",
    headRefOid: stringField(payload, keys.oid) ?? "",
    mergeCommitOid: merge,
    mergedAt: mergedAt === null || mergedAt.trim() === "" ? null : mergedAt,
  }
}

/**
 * Why a forge or Git invocation did not succeed, or null when it exited 0. The
 * joined argv is a label for prose, never a command to run.
 */
function cliFailure(argv: readonly string[], result: CliResult): string | null {
  if (result.ok && result.error === undefined && result.exitCode === 0) return null
  const observed = result.error ?? (result.exitCode === null ? "no exit status" : `exit ${result.exitCode}`)
  const stderr = result.stderr.trim()
  const detail = stderr === "" ? "" : `; stderr: ${stderr.slice(0, 400)}`
  return `${argv.join(" ")}: observed ${observed}, expected exit 0${detail}`
}

/** Read and normalise one pull request, or say why it could not be read. */
async function readPr(
  run: CliRunner,
  forge: "github" | "gitlab",
  repo: string,
  pr: string,
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
): Promise<{ argv: string[]; pr: PrObservation } | { argv: string[]; reason: string }> {
  const argv =
    forge === "github"
      ? ["gh", "pr", "view", pr, "--repo", repo, "--json", PR_FIELDS]
      : ["glab", "mr", "view", pr, "--repo", repo, "--output", "json"]
  const result = await run(argv, { timeoutMs, env })
  const failure = cliFailure(argv, result)
  if (failure !== null) return { argv, reason: failure }
  const text = result.stdout.trim()
  if (text === "") return { argv, reason: `${argv.join(" ")}: observed empty output, expected one JSON object` }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { argv, reason: `${argv.join(" ")}: observed unparseable output, expected one JSON object` }
  }
  const observed = observePr(forge, parsed)
  if ("reason" in observed) return { argv, reason: `${argv.join(" ")}: ${observed.reason}` }
  return { argv, pr: observed }
}

/**
 * Whether a payload still describes the pull request this call is landing.
 *
 * `number` is checked on every read, against the number that was requested. A
 * payload for a different pull request is not a partial answer: a forge that
 * resolved the request against the wrong repository, or a `--repo` that was
 * ignored, would otherwise produce a receipt naming a landing nobody asked for.
 *
 * With `previous` given — the read the merge was bound to — the head and the base
 * must match it as well. The merge is bound to that head, so a differing head in
 * the re-read means the answer describes some other state than the one that
 * merged, and a differing base means the request was re-targeted between the two
 * reads. Both refuse: a receipt may name only what one continuous observation
 * supports.
 */
function subjectDrift(
  observed: PrObservation,
  requested: number,
  previous: PrObservation | null,
  source: string,
): string | null {
  if (observed.number !== requested) {
    return `${source}: observed pr.number ${show(observed.number)}, expected ${requested}`
  }
  if (previous === null) return null
  if (observed.headRefOid.trim().toLowerCase() !== previous.headRefOid.trim().toLowerCase()) {
    return `${source}: observed pr.headRefOid ${show(observed.headRefOid)}, expected ${show(previous.headRefOid)} — the head moved after the merge was bound to it`
  }
  if (observed.baseRefName !== previous.baseRefName) {
    return `${source}: observed pr.baseRefName ${show(observed.baseRefName)}, expected ${show(previous.baseRefName)} — the pull request was re-targeted`
  }
  return null
}

/**
 * How a rebase landing was shown to carry the reviewed commits.
 *
 * `identical`: the forge fast-forwarded, so the landed tip is the reviewed head
 * itself. `patch-id`: the commits were rewritten, and the landed range holds the
 * reviewed range's patches in order. Both ranges are recorded so a reader can
 * repeat the comparison; the commit lists are not, because a long branch would
 * push the receipt past the size its readers accept.
 */
type RebaseEquivalence =
  | { method: "identical"; commit: string }
  | { method: "patch-id"; reviewed: string; landed: string; commits: number }

type MergeShapeProof = { oid: string; parents: string[]; rebase: RebaseEquivalence | null } | { reason: string }

/** One local Git read bound to the landing's repository and environment; stdout, or null when Git did not complete it. */
type GitRead = (argv: readonly string[], input?: string) => Promise<string | null>

/** The whole object ids one per line, or null when any line is something else. */
function oidLines(output: string | null): string[] | null {
  if (output === null) return null
  const lines = output.split("\n").filter((line) => line !== "")
  return lines.every((line) => FULL_OID.test(line)) ? lines : null
}

/**
 * Each commit's `git patch-id --stable`, in the order given; null for a commit whose
 * diff is empty, which `patch-id` prints nothing for.
 *
 * The diffs come from `git diff-tree --stdin -p -U0`, the plumbing form, with external
 * diff drivers and textconv filters off: the same command produces both sides of a
 * comparison, so what is compared is the patch itself and not a repository's
 * display configuration, and no configured program runs. Zero context lines, because
 * `patch-id` hashes context: a base edit near a reviewed hunk changes the landed
 * commit's context, not its patch, and a clean rebase must still compare equal.
 */
async function patchIds(commits: readonly string[], git: GitRead): Promise<Array<string | null> | { reason: string }> {
  const diff = await git(
    ["diff-tree", "--stdin", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv"],
    `${commits.join("\n")}\n`,
  )
  if (diff === null)
    return { reason: "git diff-tree --stdin -p -U0: observed no completed read, expected each commit's patch" }
  const printed = await git(["patch-id", "--stable"], diff)
  if (printed === null)
    return { reason: "git patch-id --stable: observed no completed read, expected one patch id per commit with a diff" }
  const wanted = new Set(commits)
  const byCommit = new Map<string, string>()
  for (const line of printed.split("\n")) {
    if (line === "") continue
    const [id, commit, extra] = line.split(" ")
    if (
      id === undefined ||
      commit === undefined ||
      extra !== undefined ||
      !FULL_OID.test(id) ||
      !wanted.has(commit) ||
      byCommit.has(commit)
    ) {
      return {
        reason: `git patch-id --stable: observed record ${show(line)}, expected "<patch-id> <commit>" once for a requested commit`,
      }
    }
    byCommit.set(commit, id)
  }
  return commits.map((commit) => byCommit.get(commit) ?? null)
}

/**
 * Prove a rebase landing carried the reviewed commits, in order.
 *
 * A rebase-and-merge rewrites every commit — GitHub always does, with a new
 * committer — so the reviewed head is never reachable from what landed, and SHAs
 * cannot be compared. Patches can. The reviewed commits are those between the
 * point the reviewed branch forked from the landed history and the reviewed head;
 * the landed commits are as many single-parent commits ending at the merge commit.
 * Each landed commit's stable patch id must equal the reviewed commit's at the same
 * position. A dropped, added, reordered, or edited commit fails that comparison,
 * and so does a landing whose chain holds a merge commit.
 */
async function rebaseEquivalence(
  head: string,
  oid: string,
  git: GitRead,
): Promise<RebaseEquivalence | { reason: string }> {
  if (head === oid) return { method: "identical", commit: oid }
  const forkRead = await git(["merge-base", head, oid])
  const fork = forkRead?.trim() ?? null
  if (fork === null || !FULL_OID.test(fork)) {
    return {
      reason: `git merge-base ${head} ${oid}: observed ${fork === null ? "no completed read" : show(fork)}, expected the commit the reviewed branch forked from`,
    }
  }
  const reviewed = oidLines(await git(["rev-list", "--reverse", "--topo-order", "--no-merges", "--end-of-options", `${fork}..${head}`]))
  if (reviewed === null || reviewed.length === 0) {
    return {
      reason: `git rev-list ${fork}..${head}: observed ${reviewed === null ? "no completed read" : "no commits"}, expected the reviewed commits`,
    }
  }
  const chain = await git(["rev-list", "--first-parent", "--parents", `--max-count=${reviewed.length}`, "--end-of-options", oid])
  const records =
    chain === null
      ? null
      : chain
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => line.split(" "))
  if (
    records === null ||
    records.length !== reviewed.length ||
    records.some((ids) => ids.length !== 2 || !ids.every((id) => FULL_OID.test(id)))
  ) {
    return {
      reason: `git rev-list --first-parent --parents ${oid}: observed ${records === null ? "no completed read" : `${records.length} records`}, expected ${reviewed.length} single-parent commits ending at the merge commit, one per reviewed commit`,
    }
  }
  const landed = records.map((ids) => ids[0] ?? "").reverse()
  const landedBase = records.at(-1)?.[1] ?? ""
  const reviewedIds = await patchIds(reviewed, git)
  if ("reason" in reviewedIds) return reviewedIds
  // Empty commits carry no patch id, so a branch of nothing but empty commits — or a
  // diff read that came back empty — would make every position compare equal. That is
  // no evidence of anything, so it refuses.
  if (reviewedIds.every((id) => id === null)) {
    return {
      reason: `git patch-id --stable: observed no patch id for any of the ${reviewed.length} reviewed commits in ${fork}..${head}, expected at least one commit with a diff`,
    }
  }
  const landedIds = await patchIds(landed, git)
  if ("reason" in landedIds) return landedIds
  for (let index = 0; index < reviewed.length; index++) {
    if (reviewedIds[index] !== landedIds[index]) {
      return {
        reason: `git patch-id --stable: observed landed commit ${landed[index]} with patch id ${show(landedIds[index])}, expected ${show(reviewedIds[index])} from reviewed commit ${reviewed[index]} at position ${index + 1} of ${reviewed.length}; the landed commits are not the reviewed patches in order`,
      }
    }
  }
  // Stable patch ids ignore whitespace, so they cannot say the bytes are the reviewed ones:
  // the final tree must also equal the reviewed head replayed onto the chain's base.
  const unproven = await contentFailure(head, oid, landedBase, git, false)
  if (unproven !== null) return unproven
  return { method: "patch-id", reviewed: `${fork}..${head}`, landed: `${landedBase}..${oid}`, commits: reviewed.length }
}

/** The tree id of `commit`, or null when Git does not name exactly one. */
async function treeOf(commit: string, git: GitRead): Promise<string | null> {
  const printed = (await git(["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]))?.trim().toLowerCase() ?? null
  return printed !== null && FULL_OID.test(printed) ? printed : null
}

/**
 * Why `oid` is not the reviewed `head` applied to `parent`, or null when it is.
 *
 * Shape and the forge's compare API say nothing about content, so the landed tree must equal
 * the tree `git merge-tree --write-tree` writes for merging the reviewed head into the
 * landed commit's parent. Git finds the merge base itself, so a grouped queue entry (whose
 * parent is the previous group commit) works too. `requireChange` additionally refuses a
 * landing whose tree is its parent's: a squash that changed nothing is not the review.
 */
async function contentFailure(
  head: string,
  oid: string,
  parent: string,
  git: GitRead,
  requireChange: boolean,
): Promise<{ reason: string } | null> {
  const landedTree = await treeOf(oid, git)
  const parentTree = await treeOf(parent, git)
  if (landedTree === null || parentTree === null) {
    return { reason: `git rev-parse ${landedTree === null ? oid : parent}^{tree}: observed no tree id, expected one` }
  }
  if (requireChange && landedTree === parentTree) {
    return { reason: `landed commit ${oid}: observed the same tree as its parent ${parent}, expected the reviewed change` }
  }
  const merged = (await git(["merge-tree", "--write-tree", parent, head]))?.split("\n")[0]?.trim().toLowerCase() ?? null
  if (merged === null || !FULL_OID.test(merged)) {
    return {
      reason: `git merge-tree --write-tree ${parent} ${head}: observed ${merged === null ? "a conflict or no completed read" : show(merged)}, expected a clean merge tree to compare with the landed tree`,
    }
  }
  if (merged !== landedTree) {
    return {
      reason: `landed commit ${oid}: observed tree ${landedTree}, expected ${merged}, the reviewed head ${head} applied to its parent ${parent}; the landed content is not the reviewed change`,
    }
  }
  return null
}

/** Why `oid` is not in the history of the base tip this call fetched, or null when it is. */
async function baseContainmentFailure(
  oid: string,
  baseTip: () => Promise<string | { reason: string }>,
  git: GitRead,
): Promise<{ reason: string } | null> {
  const tip = await baseTip()
  if (typeof tip !== "string") return tip
  if ((await git(["merge-base", "--is-ancestor", oid, tip])) === null) {
    return {
      reason: `git merge-base --is-ancestor ${oid} ${tip}: observed the landed commit outside the fetched base branch, expected it in the history of ${tip}`,
    }
  }
  return null
}

/**
 * Prove that the observed commit is the reviewed change, landed the way `method` says.
 *
 * Every proof path, whichever method and whoever merged (this call, the queue, or an earlier
 * call that is being resumed), checks the same three things:
 * - the forge-supplied ids are whole lowercase hex object ids before any Git command sees
 *   them, so none can be read as an option;
 * - the landed commit is in the history of the base tip this call fetched;
 * - its tree is the reviewed head merged onto its (first) parent, see {@link contentFailure}.
 *
 * Shape is checked first: a merge commit has two parents and, outside a queue, the reviewed
 * head as the second; squash and rebase are linear. A rebase additionally needs the ordered
 * patch equivalence of {@link rebaseEquivalence}. A request that was already MERGED names no
 * method, so a single-parent commit is accepted as a squash or, failing that, as a rebase chain.
 */
async function mergeProof(
  pr: PrObservation,
  method: MergeMethod | null,
  git: GitRead,
  queued: boolean,
  baseTip: () => Promise<string | { reason: string }>,
): Promise<MergeShapeProof> {
  if (pr.state.trim().toUpperCase() !== "MERGED" || pr.mergeCommitOid === null) {
    return {
      reason: `observed pr.state ${show(pr.state)} and pr.mergeCommitOid ${show(pr.mergeCommitOid)}, expected state "MERGED" and a non-empty merge commit oid`,
    }
  }
  const oid = pr.mergeCommitOid.trim().toLowerCase()
  const head = pr.headRefOid.trim().toLowerCase()
  for (const [field, value] of [
    ["pr.mergeCommitOid", oid],
    ["pr.headRefOid", head],
  ] as const) {
    if (!FULL_OID.test(value)) {
      return { reason: `${field}: observed ${show(value)}, expected a 40- or 64-character lowercase hex object id; no Git command was run` }
    }
  }
  const output = await git(["-c", "log.showSignature=false", "show", "-s", "--format=%P", "--end-of-options", oid])
  if (output === null)
    return { reason: `git show -s --format=%P ${oid}: observed no completed read, expected the merge commit's parents` }
  const text = output.trim()
  const parents = text === "" ? [] : text.split(/\s+/)
  if (parents.some((parent) => !FULL_OID.test(parent))) {
    return {
      reason: `git show -s --format=%P ${oid}: observed malformed parent ids ${show(text)}, expected full hexadecimal object ids`,
    }
  }
  const first = parents[0] ?? ""
  const label = method === null ? "pre-merged request" : `merge_method "${method}"`

  // Shape.
  if (method === null) {
    if (parents.length === 2 && parents[1] !== head) {
      return {
        reason: `pre-merged request: observed second parent ${show(parents[1])}, expected the reviewed head ${show(head)}`,
      }
    }
    if (parents.length !== 1 && parents.length !== 2) {
      return {
        reason: `pre-merged request: observed ${parents.length} parents, expected one parent or two with the reviewed head as the second parent`,
      }
    }
  } else if (method === "merge") {
    if (parents.length !== 2) {
      return {
        reason: `merge_method "merge": observed ${parents.length} parents, expected exactly 2 with the reviewed head as the second parent`,
      }
    }
    if (queued) {
      // The queue builds the merge on its own branch, so the reviewed head need not be the
      // second parent (a grouped entry merges onto its predecessors). It must still be part
      // of what landed.
      if ((await git(["merge-base", "--is-ancestor", head, oid])) === null) {
        return {
          reason: `merge_method "merge": observed reviewed head ${show(pr.headRefOid)} not an ancestor of the queue's merge commit ${oid}, expected the head in what landed`,
        }
      }
    } else if (parents[1] !== head) {
      return {
        reason: `merge_method "merge": observed second parent ${show(parents[1])}, expected reviewed head ${show(pr.headRefOid)}`,
      }
    }
  } else if (parents.length !== 1) {
    return {
      reason: `merge_method "${method}": observed ${parents.length} parents, expected exactly 1 for a linear landing`,
    }
  }

  const outside = await baseContainmentFailure(oid, baseTip, git)
  if (outside !== null) return { reason: `${label}: ${outside.reason}` }

  // Content.
  if (parents.length === 2) {
    const unproven = await contentFailure(head, oid, first, git, false)
    return unproven === null ? { oid, parents, rebase: null } : { reason: `${label}: ${unproven.reason}` }
  }
  if (method === "rebase") {
    const rebase = await rebaseEquivalence(head, oid, git)
    return "reason" in rebase ? { reason: `merge_method "rebase": ${rebase.reason}` } : { oid, parents, rebase }
  }
  const single = await contentFailure(head, oid, first, git, true)
  if (single === null) return { oid, parents, rebase: null }
  if (method === "squash") return { reason: `merge_method "squash": ${single.reason}` }
  // Already MERGED, so the method is not known: a rebase chain lands several commits whose
  // last one does not merge cleanly onto its own parent, so it gets the rebase proof.
  const rebase = await rebaseEquivalence(head, oid, git)
  if (!("reason" in rebase)) return { oid, parents, rebase }
  return { reason: `pre-merged request: ${single.reason}; as a rebase landing: ${rebase.reason}` }
}

/**
 * Waits before each attempt to bring the landed commits into the local object store.
 *
 * A merge the forge just accepted can be named by its API before its Git service
 * serves the commit, so the first fetch may miss it. Three attempts over about seven
 * seconds cover that replication lag; a commit still missing after them is a
 * refusal, never a guess.
 */
const FETCH_ATTEMPT_DELAYS_MS: readonly number[] = [0, 2_000, 5_000]

/** An abortable wait: the abort resolves it early, and the caller then observes the signal. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
}

/** What bringing the landed commits local took, recorded in the receipt's evidence. */
type LocalCommits = { required: string[]; fetches: string[] }

/**
 * Make every commit the shape proof reads present locally, fetching it from `remote`
 * when it is not.
 *
 * The forge merged on its side, so the merge commit — and, for a rebase, the
 * reviewed head the patch ids are read from — is not in a checkout that has not
 * fetched since. Without this step `git show` of the merge commit fails and a
 * landing the forge holds is refused for want of a fetch. Each attempt fetches the
 * missing ids directly and, if the forge will not serve them by id, the base branch
 * the landing went to. The fetch writes objects only, so the proof that follows
 * still reads exact ids and no ref is ever trusted in their place.
 */
async function ensureLocalCommits(
  required: readonly string[],
  baseBranch: string,
  remote: string,
  git: GitRead,
  fetch: (argv: string[]) => Promise<CliResult>,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<LocalCommits | { reason: string }> {
  const present = async (oid: string): Promise<boolean> => (await git(["cat-file", "-e", `${oid}^{commit}`])) !== null
  const missing = async (): Promise<string[]> => {
    const absent: string[] = []
    for (const oid of required) if (!(await present(oid))) absent.push(oid)
    return absent
  }
  const fetches: string[] = []
  const failures: string[] = []
  let absent = await missing()
  for (const delay of FETCH_ATTEMPT_DELAYS_MS) {
    if (absent.length === 0) break
    const halted = (): { reason: string } | null =>
      signal?.aborted === true
        ? { reason: `signal: observed an abort while fetching ${absent.join(", ")} from ${remote}` }
        : null
    const before = halted()
    if (before !== null) return before
    await sleep(delay, signal)
    const after = halted()
    if (after !== null) return after
    const byId = fetchCommitsArgv(remote, { oids: absent })
    if (byId === null)
      return {
        reason: `git fetch ${remote}: observed operands ${show(absent.join(" "))} it will not issue, expected whole object ids and a remote name`,
      }
    fetches.push(byId.join(" "))
    const fetchedById = cliFailure(byId, await fetch(byId))
    if (fetchedById !== null) failures.push(fetchedById)
    absent = await missing()
    if (absent.length === 0) break
    const byBranch = fetchCommitsArgv(remote, { branch: baseBranch })
    if (byBranch === null) continue
    fetches.push(byBranch.join(" "))
    const fetchedByBranch = cliFailure(byBranch, await fetch(byBranch))
    if (fetchedByBranch !== null) failures.push(fetchedByBranch)
    absent = await missing()
  }
  if (absent.length > 0) {
    const last = failures.at(-1)
    return {
      reason: `git cat-file -e: observed ${absent.join(", ")} absent locally after ${fetches.length} fetches from ${remote} over ${FETCH_ATTEMPT_DELAYS_MS.length} attempts, expected the commits the shape proof reads${last === undefined ? "" : `; last fetch: ${last}`}`,
    }
  }
  return { required: [...required], fetches }
}

/** The oldest Git whose `merge-tree --write-tree` the content proof reads (added in 2.38). */
export const MIN_GIT_VERSION = { major: 2, minor: 38 } as const

/**
 * Why the Git that printed `output` for `--version` cannot run the content proof, or null.
 *
 * The proof compares the landed tree with `git merge-tree --write-tree`, which older Git
 * rejects. Finding that out after the merge was issued would leave a merged request with
 * no receipt, so the version is read first and an unreadable or older one refuses.
 */
export function gitVersionFailure(output: string | null): string | null {
  const need = `${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}`
  const match = output === null ? null : /^git version (\d+)\.(\d+)/.exec(output.trim())
  if (match === null) {
    return `git --version: observed ${show(output)}, expected "git version <major>.<minor>"; delivery_land needs Git ${need} or newer for git merge-tree --write-tree`
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major > MIN_GIT_VERSION.major || (major === MIN_GIT_VERSION.major && minor >= MIN_GIT_VERSION.minor)) return null
  return `git --version: observed ${major}.${minor}, expected ${need} or newer, which git merge-tree --write-tree needs to prove the landed content; upgrade Git`
}

/** Exact stdout of one successful local Git read, or null when Git did not complete it. */
async function gitOutput(
  run: CliRunner,
  cwd: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  input?: string,
): Promise<string | null> {
  const result = await run(["git", ...SAFE_GIT_ARGS, ...argv], { cwd, timeoutMs: GIT_TIMEOUT_MS, env, input })
  if (!result.ok || result.error !== undefined || result.exitCode !== 0) return null
  return result.stdout
}

/**
 * The repository's stable key, canonical checkout root, and ledger verdict.
 *
 * {@link repositoryContext} is the producer/consumer seam: this producer feeds it
 * the exact stdout from one combined common-dir/top-level Git read, while cleanup
 * invokes the same seam directly. The key, recorded root, and ledger verdict cannot
 * therefore come from different observations or layout heuristics.
 *
 * The seam reads through a synchronous callback and asks for exactly that one
 * observation, so the read is made here, through the abortable runner, and its
 * stdout is what the callback answers. Any other request is answered as a failed
 * read, which the seam turns into a refusal rather than a guess.
 */
async function observeRepository(
  git: GitRead,
  cwd: string,
): Promise<{ key: string; canonicalRoot: string; commonDir: string; ledger: CanonicalLedger } | { reason: string }> {
  const printed = await git(REPOSITORY_OBSERVATION_ARGS)
  const repository = repositoryContext(cwd, (argv) =>
    argv.length === REPOSITORY_OBSERVATION_ARGS.length &&
    argv.every((part, index) => part === REPOSITORY_OBSERVATION_ARGS[index])
      ? printed
      : null,
  )
  if (repository === null) {
    return {
      reason: `git ${REPOSITORY_OBSERVATION_ARGS.join(" ")} in ${cwd}: observed no unambiguous repository paths, expected absolute git common directory and checkout top level`,
    }
  }
  return {
    key: repository.key,
    canonicalRoot: repository.ledger.root,
    commonDir: repository.commonDir,
    ledger: repository.ledger,
  }
}

/**
 * The commit a worktree has checked out, or why it could not be read.
 *
 * A recorded worktree is what `delivery_cleanup` later removes, so it has to be the
 * checkout holding the landed head; a path at any other head names work this
 * landing did not land. `HEAD^{commit}` peels to the commit and `--verify` refuses
 * anything that is not exactly one object, so the answer is one whole id or nothing.
 */
async function worktreeHead(
  run: CliRunner,
  path: string,
  env: Readonly<Record<string, string>>,
  pin: GitPin,
): Promise<{ head: string } | { reason: string }> {
  const argv = ["rev-parse", "--verify", "HEAD^{commit}"]
  const printed = await gitOutput(run, path, argv, { ...env, ...pin })
  const head = printed?.trim().toLowerCase() ?? null
  if (head === null || !FULL_OID.test(head)) {
    return {
      reason: `worktree: git ${argv.join(" ")} in ${show(path)} observed ${head === null ? "no completed read" : show(head)}, expected one whole commit id`,
    }
  }
  return { head }
}

/** The bead ids a landing closes, read from the agent branch convention. */
export function beadIdsFromBranch(branch: string): string[] {
  const id = AGENT_BRANCH.exec(branch.trim())?.[1]
  return id === undefined ? [] : [id]
}

/**
 * The bead ids this landing closes: an explicit `beadId` when the caller gave one,
 * otherwise whatever the branch convention names.
 *
 * An explicit id wins over the convention only when the branch carries none, because
 * the two agreeing is the normal case and the two disagreeing is a caller naming a
 * bead other than the one its own branch is for — which is a mistake to report, not
 * to pick a side in.
 */
function beadIdentity(beadId: string | undefined, branch: string): { ids: string[] } | { reason: string } {
  const fromBranch = beadIdsFromBranch(branch)
  const explicit = beadId?.trim() ?? ""
  if (explicit === "") return { ids: fromBranch }
  if (!BEAD_ID.test(explicit)) {
    return {
      reason: `beadId: observed ${show(beadId)}, expected a bead id of letters, digits, ".", "_" or "-", starting with a letter or digit`,
    }
  }
  if (fromBranch.length > 0 && fromBranch[0] !== explicit) {
    return {
      reason: `beadId: observed ${show(explicit)}, expected ${show(fromBranch[0])} from branch ${show(branch)}, which already names the bead this landing closes`,
    }
  }
  return { ids: [explicit] }
}

function nativeCloseoutSteps(receipt: LandingReceipt, receiptPath: string, mergeSha: string): readonly string[] {
  const commands = receipt.beads.ids.flatMap((id) => {
    const { update, close } = closeoutCommands(id, receipt.pr.number, mergeSha, receiptPath)
    return [update, close]
  })
  return [...commands, "delivery_cleanup"]
}

/**
 * Why a landing with no bead identity may not be recorded, or null when it may.
 *
 * A receipt whose ledger is active and whose id list is empty claims that work was
 * landed into a repository that tracks it, and names nothing for the native close-out
 * commands. `delivery_cleanup` would then ask `bd` about an empty list and pass a
 * gate that verified nothing, so the landing refuses here instead — before the merge
 * when the branch is already known, and again before the receipt is built.
 */
function missingBeadIdentity(ids: readonly string[], branch: string, ledger: CanonicalLedger): string | null {
  if (!ledger.active || ids.length > 0) return null
  return `beads.ids: observed no bead identity for branch ${show(branch)}, expected an "omp/agent/<bead-id>" or "opencode/agent/<bead-id>" branch or an explicit beadId; the ledger at canonical root ${show(ledger.root)} is active, so this landing has no bead for the native close-out commands`
}

/**
 * The merge method of the queue that landed this pull request at this head and merge commit,
 * as a receipt this tool wrote and its validator accepts records it; null when none does.
 *
 * The pending-queue record that chose the queue-aware proof is cleared once the receipt is
 * written, so a later re-proof (to record a worktree, say) learns the provenance here instead,
 * and does not hold a queue's merge commit to the direct-merge shape.
 */
function receiptQueueMethod(
  directory: string,
  expected: { repository: string; number: number; head: string; baseRefName: string; mergeCommitOid: string | null },
): MergeMethod | null {
  const landed = expected.mergeCommitOid?.trim().toLowerCase() ?? ""
  if (!FULL_OID.test(landed)) return null
  let receipts: LandingReceipt[]
  try {
    receipts = listReceipts(directory, { pr: expected.number })
  } catch {
    // An unreadable directory lends no provenance; the stricter direct-merge proof applies.
    return null
  }
  for (const receipt of receipts) {
    // Only this tool's own landing receipt for the same GitHub pull request, head, base and
    // merge commit counts, and its queue evidence must agree with the method it landed with.
    if (
      receipt.emitter.tool !== "delivery_land" ||
      receipt.outcome !== "landed" ||
      receipt.repo.forge !== "github" ||
      receipt.repo.nameWithOwner.toLowerCase() !== expected.repository.toLowerCase() ||
      receipt.pr.baseRefName !== expected.baseRefName ||
      receipt.pr.headRefOid.trim().toLowerCase() !== expected.head ||
      receipt.pr.mergeCommitOid?.trim().toLowerCase() !== landed
    ) {
      continue
    }
    const evidence = receipt.proof.evidence
    const recorded = ownValue(evidence, "queue")
    const method = stringField(recorded, "method")
    const known = MERGE_METHODS.find((candidate) => candidate === method)
    if (stringField(recorded, "rule") === "merge_queue" && known !== undefined && stringField(evidence, "mergeMethod") === known) {
      return known
    }
  }
  return null
}

/**
 * The provider CLI and verb that observed this landing — `gh pr view`,
 * `glab mr view` — taken from the argv of the read that proved it.
 *
 * Read off the issued command rather than composed from the forge name, so
 * `proof.method` cannot describe a command this tool did not run. An argv that names
 * no CLI and verb yields {@link RECEIPT_METHOD_UNKNOWN}, which `validateReceipt`
 * refuses to combine with `outcome: "landed"`.
 */
function observationMethod(argv: readonly string[]): string {
  const head = argv.slice(0, 3)
  const named = head.length === 3 && head.every((element) => element !== "" && !/\s/.test(element))
  return named ? head.join(" ") : RECEIPT_METHOD_UNKNOWN
}

/** One configured remote and the normalized repository path its URL names, or null when it names none. */
export type RemotePath = { name: string; path: string | null }

/**
 * The remote that names `repo`, or null. `origin` wins when it matches, then the first
 * match in the order given. The comparison is on normalized paths only; a remote that
 * names no repository never matches, so the caller cannot be steered to a repository
 * nobody named.
 */
export function selectRemoteForRepo(remotes: readonly RemotePath[], repo: string): string | null {
  const matching = remotes.filter((remote) => remote.path !== null && remote.path === repo)
  return matching.find((remote) => remote.name === "origin")?.name ?? matching[0]?.name ?? null
}

/**
 * The linked worktree that has `branch` checked out at exactly `head`, or null. The
 * main worktree is skipped: `delivery_cleanup` never removes it, so recording it
 * would only make a later cleanup refuse. A prunable, detached or differently-headed
 * record is skipped too, because the receipt must name a checkout holding the landed head.
 */
export function inferWorktree(records: readonly WorktreeRecord[], branch: string, head: string): string | null {
  const found = records
    .slice(1)
    .find(
      (record) =>
        !record.prunable &&
        !record.detached &&
        record.branch === `refs/heads/${branch}` &&
        record.head.toLowerCase() === head.toLowerCase(),
    )
  return found?.path ?? null
}

/** The remotes of the repository `git` reads, each with the normalized path its URL names. */
async function remotePaths(git: GitRead): Promise<RemotePath[]> {
  const listed = await git(["remote"])
  if (listed === null) return []
  const remotes: RemotePath[] = []
  for (const name of listed.split("\n").filter((line) => REMOTE_NAME.test(line))) {
    const printed = await git(["remote", "get-url", name])
    const url = printed === null ? null : singleRemoteRecord(printed)
    const target = url === null ? null : forgeTarget(url)
    const raw = url === null ? null : repoPathFromRemote(url)
    remotes.push({ name, path: target === null || raw === null ? null : normalizeRepoPath(target.forge, raw) })
  }
  return remotes
}

/** Where one landing's forge commands go, resolved from the configured remote before anything is merged. */
export type LandingTarget = {
  remote: string
  /** The remote URL as a receipt or refusal may print it: credentials redacted. */
  remoteUrl: string
  forge: "github" | "gitlab"
  /** The canonical API host {@link forgeTarget} resolved for the remote's transport host. */
  forgeHost: "github.com" | GitlabHost
  nameWithOwner: string
  repository: { key: string; canonicalRoot: string; commonDir: string; ledger: CanonicalLedger }
  /** `HOST/PATH`: the `--repo` every forge command is given. */
  cliRepo: string
  /** The forge environment with that verified host pinned. */
  forgeCommandEnv: Readonly<Record<string, string>>
}

/**
 * Resolve the repository a landing addresses, or the first reason it cannot be
 * trusted. The refusals keep one fixed order: the explicit `repo` shape before any
 * read, then the remote name, the repository observation, the remote URL, its forge,
 * and last the agreement between the remote's path and an explicit `repo`.
 */
export async function resolveLandingTarget(
  params: Pick<LandParams, "repo" | "remote">,
  git: GitRead,
  cwd: string,
  forgeEnv: Readonly<Record<string, string>>,
): Promise<LandingTarget | { reason: string }> {
  // Before reading any repository state, reject an explicit identity that cannot
  // be valid for either supported forge. GitLab's bounded nested-group form is
  // the superset; the forge-specific boundary below tightens GitHub to exactly
  // two segments once the trusted remote identifies the forge.
  const explicitRepo = params.repo === undefined || params.repo.trim() === "" ? null : params.repo.trim()
  if (explicitRepo !== null && normalizeRepoPath("gitlab", explicitRepo) === null) {
    return {
      reason: `repo: observed ${show(explicitRepo)}, expected an unqualified "<owner>/<name>" or bounded GitLab "<group>/.../<project>" path`,
    }
  }

  let remote = params.remote === undefined || params.remote.trim() === "" ? "origin" : params.remote.trim()
  if (!REMOTE_NAME.test(remote))
    return { reason: `remote: observed ${show(params.remote)}, expected a git remote name` }
  // An explicit `repo` with no explicit `remote` selects the remote of this checkout
  // that names that repository. The branch absence is still verified against the
  // remote chosen here, so the repository verified is always the one `repo` names.
  if (explicitRepo !== null && (params.remote === undefined || params.remote.trim() === "")) {
    const wanted = normalizeRepoPath("gitlab", explicitRepo)
    const picked = wanted === null ? null : selectRemoteForRepo(await remotePaths(git), wanted)
    if (picked !== null) remote = picked
  }

  const repository = await observeRepository(git, cwd)
  if ("reason" in repository) return repository

  // The raw stdout, parsed as exactly one record rather than trimmed: `URL` deletes
  // embedded tabs and newlines before parsing, so a remote spelled with one, or a
  // remote printing two URLs, would classify here as an ordinary forge URL while Git
  // contacts something else. This identity binds the merge argv, so the disagreement
  // would not merely misreport — it would merge somewhere nobody named.
  //
  // The refusal names the shape, never the bytes: a remote URL may carry userinfo or a
  // token query, and output no parser here accepts cannot be redacted, because
  // `redactRemote` can only locate a secret in a spelling it understands.
  const printed = await git(["remote", "get-url", remote])
  const remoteText = printed === null ? null : singleRemoteRecord(printed)
  if (remoteText === null) {
    const observed = printed === null ? "no completed read" : "malformed Git remote output"
    return {
      reason: `git remote get-url ${remote}: observed ${observed}, expected exactly one URL record for a configured remote in ${cwd}`,
    }
  }
  const target = forgeTarget(remoteText)
  // The URL is classified before it is redacted: `forgeTarget` owns that
  // judgement and must see the spelling Git will actually contact.
  const remoteUrl = redactRemote(remoteText)
  if (target === null) {
    return {
      reason: `repo.forge: observed "unknown" for remote ${remote} at ${show(remoteUrl)}, expected "github" or "gitlab"`,
    }
  }
  const { forge } = target

  const fromRemote = repoPathFromRemote(remoteText)
  if (fromRemote === null && explicitRepo === null) {
    return {
      reason: `repo.nameWithOwner: observed no owner/name in remote ${remote} at ${show(remoteUrl)}, expected "<owner>/<name>"`,
    }
  }
  const normalizedRemote = fromRemote === null ? null : normalizeRepoPath(forge, fromRemote)
  if (fromRemote !== null && normalizedRemote === null) {
    const expected = forge === "github" ? 'exactly "<owner>/<name>"' : 'a bounded "<group>/.../<project>" path'
    return { reason: `repo: observed ${show(fromRemote)} from remote ${remote}, expected ${expected}` }
  }
  const candidate = explicitRepo ?? normalizedRemote
  if (candidate === null) {
    return {
      reason: `repo.nameWithOwner: observed no owner/name in remote ${remote} at ${show(remoteUrl)}, expected "<owner>/<name>"`,
    }
  }
  // This adapter-owned normalization is the one path boundary every forge
  // command below shares, and it runs before any host is prefixed: an explicit
  // `repo` is reduced to exactly two segments on GitHub and a bounded group path
  // on GitLab, so no caller-supplied string can occupy the host position.
  const nameWithOwner = normalizeRepoPath(forge, candidate)
  if (nameWithOwner === null) {
    const expected = forge === "github" ? 'exactly "<owner>/<name>"' : 'a bounded "<group>/.../<project>" path'
    return { reason: `repo: observed ${show(candidate)}, expected ${expected}` }
  }
  // A `repo` override that disagrees with the remote is still refused, naming both:
  // the remote is what `git ls-remote` will be asked about when the branch's absence
  // is verified, so a receipt built from two different repositories would be proof
  // of neither.
  if (normalizedRemote !== null && nameWithOwner !== normalizedRemote) {
    return {
      reason: `repo: observed ${show(nameWithOwner)}, expected ${show(normalizedRemote)} from remote ${remote}; the branch absence is verified against ${remote}, so both must name one repository; to land a pull request of another repository, run delivery_land from a session in that repository`,
    }
  }
  // Only now, on top of a normalized path, is the host added — and it is added to
  // both forges. `gh` documents `--repo [HOST/]OWNER/REPO` and `glab` the same
  // shape, so each CLI is told the host explicitly rather than resolving a bare
  // path against whichever host it has configured. The value is not caller data:
  // it is what `forgeTarget` returned for the transport host Git will contact, so
  // an alternate SSH endpoint such as `altssh.gitlab.com` still addresses the
  // vendor's canonical API host. The same verified host is pinned in the
  // environment, which is where a CLI would otherwise read a default from.
  const cliRepo = `${target.canonicalHost}/${nameWithOwner}`
  const forgeCommandEnv = Object.assign(
    Object.create(null) as Record<string, string>,
    forgeEnv,
    forge === "github"
      ? { GH_HOST: target.canonicalHost }
      : { GITLAB_HOST: target.canonicalHost, GITLAB_API_HOST: target.canonicalHost },
  )
  return {
    remote,
    remoteUrl,
    forge,
    forgeHost: target.canonicalHost,
    nameWithOwner,
    repository,
    cliRepo,
    forgeCommandEnv,
  }
}

/**
 * Land one pull request and emit its receipt.
 *
 * The whole tool, as a function, so every refusal and every issued argv is
 * observable from a test without a host session.
 */
export async function landPullRequest(params: LandParams, deps: LandDeps = {}): Promise<LandOutcome> {
  const { signal } = deps
  const baseRun = deps.run ?? runCli
  // Every child process carries the tool call's signal, so an interrupt ends whichever
  // command is running and keeps the next one from starting.
  // Critical section: from the moment the merge is issued until the receipt is recorded the
  // signal no longer reaches commands. Killing the re-read or the proof there would leave a
  // merged request with no receipt, so the call finishes first and the stop is honored after.
  let merging = false
  const run: CliRunner = (argv, options) => baseRun(argv, { ...options, signal: merging ? undefined : signal })
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const forgeEnv = forgeEnvironment(env)
  const gitEnv = gitObservationEnvironment(env)
  // Every local Git read, fetch and remote probe runs in the session directory: a
  // checkout of any other repository is untrusted, since even object-only Git commands
  // can start programs its config names (promisor lazy fetch, alternate-refs helpers).
  const explicitWorktree =
    params.worktree === undefined || params.worktree.trim() === "" ? null : resolve(cwd, params.worktree.trim())
  const git: GitRead = (argv, input) => gitOutput(run, cwd, argv, gitEnv, input)
  // Every adapter call runs with the same neutralised environment, except where the
  // adapter passes one of its own: `remoteBranchAbsent` hardens Git's environment
  // itself, and that choice belongs to the module that owns the observation.
  const forgeRun: CliRunner = (argv, options) => run(argv, { ...options, env: options.env ?? forgeEnv })
  const now = deps.now?.() ?? Date.now()
  const observedAt = new Date(now).toISOString()
  const refuse = (reason: string): LandOutcome => ({ ok: false, reason, text: `delivery_land refused: ${reason}` })
  // A command the abort ended already refuses through its own failed read. This is
  // for the gaps between commands, where the next step would be a merge or a write.
  const interrupted = (where: string): LandOutcome | null =>
    signal?.aborted === true ? refuse(`signal: observed an abort ${where}`) : null
  const unstarted = interrupted("before the first command; nothing was read, merged, or written")
  if (unstarted !== null) return unstarted
  const selected = landingMethod(params.merge_method)
  if ("reason" in selected) return refuse(selected.reason)
  const mergeMethod = selected.method
  const budget = queueBudgetMs(params.queueWaitSeconds)
  if ("reason" in budget) return refuse(budget.reason)

  const number =
    typeof params.pr === "number" ? String(params.pr) : typeof params.pr === "string" ? params.pr.trim() : ""
  if (!POSITIVE_INTEGER.test(number)) return refuse(`pr: observed ${show(params.pr)}, expected a positive integer`)
  const requested = Number(number)
  if (!Number.isSafeInteger(requested)) {
    return refuse(`pr: observed ${show(params.pr)}, expected a positive integer of at most ${Number.MAX_SAFE_INTEGER}`)
  }

  const resolved = await resolveLandingTarget(params, git, cwd, forgeEnv)
  if ("reason" in resolved) return refuse(resolved.reason)
  const oldGit = gitVersionFailure(await git(["--version"]))
  if (oldGit !== null) return refuse(`${oldGit}; no merge was issued and no receipt was written`)
  const { remote, remoteUrl, forge, forgeHost, nameWithOwner, repository, cliRepo, forgeCommandEnv } = resolved
  const gitlabHost: GitlabHost | undefined = forgeHost === "github.com" ? undefined : forgeHost
  // A worktree is read with Git, so it must provably belong to the session repository
  // first; this looks only at its `.git` entry and runs no Git process there.
  const sessionCommonDir = repository.commonDir
  // Only a worktree that provably belongs to this repository is read, and it is resolved
  // exactly once: the verification, the pin and the HEAD read all use that one physical
  // path. Anything else, a path that does not exist yet included, is refused before Git runs.
  let explicitCheckout: { real: string; pin: GitPin } | null = null
  if (explicitWorktree !== null) {
    const real = physical(explicitWorktree)
    const verdict = real === null ? ({ state: "absent" } as const) : verifyCheckout(real, sessionCommonDir)
    if (real === null || verdict.state !== "same") {
      const what =
        verdict.state === "foreign"
          ? "a checkout of another repository"
          : verdict.state === "absent"
            ? "not an existing checkout"
            : "not a checkout owned by this repository"
      return refuse(
        `worktree: observed ${show(explicitWorktree)} as ${what}, expected a worktree of the session repository ${show(nameWithOwner)}; run delivery_land from a session in the pull request's repository; no Git ran there, no merge was issued and no receipt was written`,
      )
    }
    explicitCheckout = { real, pin: verdict.pin }
  }
  const boundForgeRun: CliRunner = (argv, options) => run(argv, { ...options, env: options.env ?? forgeCommandEnv })

  const first = await readPr(run, forge, cliRepo, number, FORGE_TIMEOUT_MS, forgeCommandEnv)
  if ("reason" in first) return refuse(first.reason)
  const subject = subjectDrift(first.pr, requested, null, first.argv.join(" "))
  if (subject !== null) return refuse(`${subject}; no merge was issued and no receipt was written`)
  const alreadyMerged = first.pr.state.trim().toUpperCase() === "MERGED"
  const head = first.pr.headRefOid.trim().toLowerCase()

  // A merge is issued only against a head the caller names: the reviewed head, which
  // must be the forge's own `headRefOid`. Without one the call would merge whatever
  // the branch held at read time, and nothing would tie the landing to the review.
  // Only proving a request that is already MERGED may omit it, because that path
  // issues nothing.
  const expected = params.expectHeadSha?.trim() ?? ""
  if (expected === "") {
    if (params.expectHeadSha !== undefined || !alreadyMerged) {
      return refuse(
        `expectHeadSha: observed ${show(params.expectHeadSha)}, expected the reviewed head sha; pr.headRefOid is ${show(first.pr.headRefOid)}, and only an already-MERGED request may be proved without one; no merge was issued and no receipt was written`,
      )
    }
  } else if (expected.toLowerCase() !== head) {
    return refuse(
      `expectHeadSha: observed pr.headRefOid ${show(first.pr.headRefOid)}, expected ${show(expected)}; no merge was issued and no receipt was written`,
    )
  }

  // The worktree is recorded for `delivery_cleanup` to remove, so it is read before
  // anything is merged or written, on either path: it must hold the head that lands.
  let worktree: { path: string; head: string } | null = null
  const worktreePath = explicitWorktree
  if (worktreePath === null || explicitCheckout === null) {
    // No worktree named: record the linked worktree that holds the PR's branch at the
    // PR's head, so `delivery_cleanup` has something to remove. Finding none is not a
    // refusal; the receipt then records no worktree, as it always did.
    const listed = await git(["worktree", "list", "--porcelain"])
    const inferred = listed === null ? null : inferWorktree(parseWorktreeList(listed), first.pr.headRefName, head)
    const real = inferred === null ? null : physical(inferred)
    const verdict = real === null ? null : verifyCheckout(real, sessionCommonDir)
    if (inferred !== null && real !== null && verdict?.state === "same") {
      const held = await worktreeHead(run, real, gitEnv, verdict.pin)
      if (!("reason" in held) && held.head === head) worktree = { path: inferred, head: held.head }
    }
  } else {
    const held = await worktreeHead(run, explicitCheckout.real, gitEnv, explicitCheckout.pin)
    if ("reason" in held) {
      return refuse(
        `${held.reason} to compare with pr.headRefOid ${show(first.pr.headRefOid)}; no merge was issued and no receipt was written`,
      )
    }
    if (held.head !== head) {
      return refuse(
        `worktree: observed HEAD ${show(held.head)} in ${show(worktreePath)}, expected pr.headRefOid ${show(first.pr.headRefOid)}; a recorded worktree must hold the landed head; no merge was issued and no receipt was written`,
      )
    }
    worktree = { path: worktreePath, head: held.head }
  }

  // The bead identity is settled before anything is merged: the branch the forge
  // just named is the branch the receipt will record, so a landing that cannot name
  // the work it closes refuses while refusing is still free.
  const identity = beadIdentity(params.beadId, first.pr.headRefName)
  if ("reason" in identity) return refuse(`${identity.reason}; no merge was issued and no receipt was written`)
  const unnamed = missingBeadIdentity(identity.ids, first.pr.headRefName, repository.ledger)
  if (unnamed !== null) return refuse(`${unnamed}; no merge was issued and no receipt was written`)

  // The shepherd's preconditions, read from the forge for the head the merge is bound
  // to. Only a merge needs them: an already-MERGED request is proved, not approved.
  const preconditions: { approval?: Record<string, unknown>; checks?: Record<string, unknown> } = {}
  if (!alreadyMerged && (params.requireApproval === true || params.requireGreenChecks === true)) {
    const bound = {
      forge,
      cliRepo,
      nameWithOwner,
      forgeHost,
      number,
      head,
      env: forgeCommandEnv,
      timeoutMs: FORGE_TIMEOUT_MS,
    }
    if (params.requireApproval === true) {
      const approval = await readApproval(run, bound)
      if (!approval.ok) return refuse(`${approval.reason}; no merge was issued and no receipt was written`)
      preconditions.approval = approval.evidence
    }
    if (params.requireGreenChecks === true) {
      const checks = await readChecks(run, bound)
      if (!checks.ok) return refuse(`${checks.reason}; no merge was issued and no receipt was written`)
      preconditions.checks = checks.evidence
    }
  }

  // A base branch with a merge queue takes no direct merge: `gh pr merge` would enqueue it
  // by itself, so the rules are read first and an unreadable answer refuses.
  let queue: { method: MergeMethod } | null = null
  const pendingDirectory = deps.receiptsDirectory ?? receiptDirectory(env, repository.key)
  // A record that exists but cannot be read may be the only trace of an enqueue GitHub
  // accepted, so it is never taken for "never enqueued": the call refuses and names it.
  const pending = forge === "github" ? readPending(pendingDirectory, nameWithOwner, requested, head) : ({ kind: "absent" } as const)
  if (pending.kind === "unreadable") {
    return refuse(
      `the pending-queue record ${pending.path} is unreadable (${pending.reason}), so whether an earlier call enqueued ${nameWithOwner}#${number} at ${head} cannot be told; check the pull request's merge queue on GitHub, then delete that file and call delivery_land again; nothing was enqueued or merged and no receipt was written`,
    )
  }
  // The generation of the pending-queue record this call wrote or observed: the only record it
  // may delete, so a call acting on an older view never deletes a newer call's record.
  let ownedRecord: string | null = null
  if (alreadyMerged && forge === "github") {
    // A merge this tool enqueued earlier and the queue has since landed reads as MERGED, and the
    // direct-merge proof cannot recognise the queue's integration commit. The record of that
    // enqueue (kept until the receipt is written) carries the method; once the receipt is
    // written, a re-proof finds the method in that validated receipt instead.
    const method =
      pending.kind === "record"
        ? pending.record.method
        : receiptQueueMethod(pendingDirectory, {
            repository: nameWithOwner,
            number: requested,
            head,
            baseRefName: first.pr.baseRefName,
            mergeCommitOid: first.pr.mergeCommitOid,
          })
    if (method !== null) queue = { method }
    if (pending.kind === "record") ownedRecord = pending.record.generation
  }
  let planGated = false
  if (!alreadyMerged && forge === "github") {
    const path = normalizeRepoPath("github", nameWithOwner)
    if (path === null) return refuse(`repo: observed ${show(nameWithOwner)}, expected "<owner>/<name>"`)
    const rules = await readQueueRule(run, path, first.pr.baseRefName, forgeCommandEnv)
    if ("reason" in rules) return refuse(`${rules.reason}; no merge was issued and no receipt was written`)
    planGated = !rules.required && rules.planGated === true
    if (rules.required) {
      if (params.merge_method !== undefined && params.merge_method !== rules.method) {
        return refuse(
          `merge_method: observed ${show(params.merge_method)}, expected ${show(rules.method)} or no value; the merge queue of ${show(first.pr.baseRefName)} lands with ${rules.method}; no merge was issued and no receipt was written`,
        )
      }
      queue = { method: rules.method }
    }
  }
  const landMethod = queue?.method ?? mergeMethod

  // Every read above passed; nothing has been written yet.
  const unasked = interrupted("before authorization; nothing was merged or written")
  if (unasked !== null) return unasked
  await deps.authorize?.({
    resource: `${nameWithOwner}#${number}`,
    forge,
    head,
    merge: alreadyMerged ? null : landMethod,
    setupAutoDelete: params.setupAutoDelete === true,
  })

  const notes: string[] = []
  if (planGated) {
    notes.push(
      `No merge queue was found: the branch rules of ${first.pr.baseRefName} are plan-gated (HTTP 403, "${PLAN_GATE_MESSAGE}"), so merge queues are unavailable on this repository and the merge was direct.`,
    )
  }
  let mergeArgv: string[] | null = null
  let proved: PrObservation = first.pr
  let rereadArgv = null as string[] | null
  let mergePolicy: boolean | "unknown" | null = null
  // Why the record of a queue landing could not be written; a retry then reads the request as
  // MERGED with no trace of the queue, so a refusal must say so.
  let queueTraceLost: string | null = null
  // A refusal once a landing exists on the forge. No receipt is written for a landing
  // this call could not prove, so cleanup never acts on one; instead the refusal says
  // the forge holds it and that re-running is safe: the next call reads the request as
  // MERGED, takes the no-merge proof path, and writes the receipt. That keeps "merge at
  // most once" and "nothing written before the proof" both true across the retry.
  const refuseMerged = (reason: string): LandOutcome => {
    if (mergeArgv === null) {
      const retry = alreadyMerged ? "; the request is already MERGED, so re-running delivery_land issues no merge" : ""
      return refuse(`${reason}; no receipt was written${retry}`)
    }
    const lost =
      queueTraceLost === null
        ? ""
        : `. ${queueTraceLost}, so a re-run cannot tell the queue landed it and holds it to the direct-merge proof: make the receipts directory writable first`
    const text = `${reason}; no receipt was written${lost}. The forge accepted ${mergeArgv.join(" ")}, so the request is merged and must not be merged again: re-run delivery_land with the same pr and expectHeadSha ${head}; it reads the request as MERGED, issues no merge, and writes the receipt once the proof completes`
    return { ok: false, reason: text, text: `delivery_land refused: ${text}`, mergeIssued: true }
  }
  // The re-read after the forge reports the landing. It must describe the same pull
  // request, at the same head, on the same base. A merge proves a landing only of what
  // was read: a re-target or a push between the two reads would otherwise let this
  // receipt name a head and a base that never merged.
  const rereadLanded = async (): Promise<LandOutcome | null> => {
    const second = await readPr(run, forge, cliRepo, number, FORGE_TIMEOUT_MS, forgeCommandEnv)
    rereadArgv = second.argv
    if ("reason" in second) return refuseMerged(second.reason)
    const drift = subjectDrift(second.pr, requested, first.pr, second.argv.join(" "))
    if (drift !== null) return refuse(`${drift}; no receipt was written`)
    proved = second.pr
    return null
  }
  if (alreadyMerged) {
    notes.push(
      `The pull request was already MERGED when it was read, so no merge argv was issued: ${first.argv.join(" ")} is the proof.`,
    )
  } else if (queue !== null) {
    const [owner = "", repoName = ""] = nameWithOwner.split("/")
    if (!FULL_OID.test(head)) {
      return refuse(
        `pr.headRefOid: observed ${show(first.pr.headRefOid)}, expected a 40- or 64-character hex object id to bind the enqueue to; nothing was enqueued`,
      )
    }
    if (first.pr.nodeId === null || first.pr.nodeId === "") {
      return refuse(
        `pr.id: observed ${show(first.pr.nodeId)}, expected the pull request node id from ${first.argv.join(" ")} to pin the enqueue to; nothing was enqueued and no receipt was written`,
      )
    }
    const nodeId = first.pr.nodeId
    // Every read is checked against the independent read the landing was authorized from, so
    // the node id the enqueue mutation takes is that read's id, and the repository, number
    // and base match it too.
    const read = async () => {
      const observed = await readSnapshot(run, owner, repoName, number, forgeCommandEnv)
      if ("reason" in observed) return observed
      const unbound = bindingFailure(observed.snapshot, {
        repository: nameWithOwner,
        number: requested,
        baseRefName: first.pr.baseRefName,
        id: nodeId,
      })
      return unbound === null ? observed : { reason: unbound }
    }
    const sleep = (ms: number): Promise<void> => (deps.sleep ?? abortableSleep)(ms, signal)
    const queueLabel = ["gh", "api", "graphql", "enqueuePullRequest", `expectedHeadOid=${head}`]
    const nowMs = (): number => deps.now?.() ?? Date.now()
    // The generation of the record that says this head is, or may be, in the queue, so a call
    // that finds no entry can tell "removed" from "never enqueued"; null when there is none.
    // Read again right before each decision: another call may have recorded this head since.
    const recordedNow = (): { generation: string | null } | { reason: string } => {
      const now = readPending(pendingDirectory, nameWithOwner, requested, head)
      if (now.kind === "unreadable") {
        return {
          reason: `the pending-queue record ${now.path} is unreadable (${now.reason}), so whether an earlier call enqueued ${nameWithOwner}#${number} at ${head} cannot be told; check the pull request's merge queue on GitHub, then delete that file and call delivery_land again; nothing was enqueued and no receipt was written`,
        }
      }
      return { generation: now.kind === "record" ? now.record.generation : null }
    }
    // Claims the record without replacing one: `exists` means another call recorded this head.
    const recordEnqueue = (generation: string): "created" | "exists" | { reason: string } => {
      try {
        return writePending(pendingDirectory, {
          repository: nameWithOwner,
          number: requested,
          head,
          method: queue?.method ?? mergeMethod,
          enqueuedAt: observedAt,
          generation,
        })
      } catch (error) {
        return {
          reason: `the pending-queue record could not be written (${error instanceof Error ? error.message : String(error)})`,
        }
      }
    }
    // Writes this call's record, or adopts the one another call made, and owns its generation.
    const adoptRecord = (): { reason: string } | null => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const generation = newGeneration()
        const written = recordEnqueue(generation)
        if (typeof written !== "string") return written
        if (written === "created") {
          ownedRecord = generation
          return null
        }
        const now = recordedNow()
        if ("reason" in now) return now
        if (now.generation !== null) {
          ownedRecord = now.generation
          return null
        }
        // Another call removed the record between the claim and the read: claim again.
      }
      return { reason: "the pending-queue record could not be written (it was removed after each of three claims)" }
    }
    const current = await read()
    if ("reason" in current) return refuse(`${current.reason}; nothing was enqueued and no receipt was written`)
    // An entry for this head already exists, or the request merged since the first read:
    // wait on it instead of enqueuing again. Anything else about the head refuses here.
    const standing = decideQueue(current.snapshot, head, 0)
    if (standing.kind === "refused") {
      if (pending.kind === "record") {
        clearPending(pendingDirectory, nameWithOwner, requested, head, pending.record.generation, nowMs())
      }
      return refuse(`${standing.reason}; nothing was enqueued and no receipt was written`)
    }
    // Waiting on an entry, whether this call enqueued it or someone else did, records it; a
    // record another call already made is kept as it is, and this call owns that generation.
    const joinEntry = (): LandOutcome | null => {
      const failed = adoptRecord()
      return failed === null
        ? null
        : refuse(
            `${failed.reason} while the head is in the merge queue; call delivery_land again with the same pr and expectHeadSha ${head} to wait on the entry; no receipt was written`,
          )
    }
    if (standing.kind === "wait" && current.snapshot.entry !== null) {
      const unjoined = joinEntry()
      if (unjoined !== null) return unjoined
    }
    // Already merged by the queue: the record (and so the queue's method) is kept before the
    // re-read below, which can fail, so a retry still proves the queue shape.
    if (standing.kind === "merged") queueTraceLost = adoptRecord()?.reason ?? null
    if (standing.kind === "wait" && current.snapshot.entry === null) {
      // The whole no-entry decision runs under a per-head lock, so a call that sees no entry
      // while another call's enqueue is in flight cannot take that call's record for a removal.
      let lock: ReturnType<typeof acquireEnqueueLock>
      try {
        lock = acquireEnqueueLock(pendingDirectory, requested, head, nowMs())
      } catch (error) {
        return refuse(
          `the pending-queue lock could not be written (${error instanceof Error ? error.message : String(error)}); nothing was enqueued and no receipt was written`,
        )
      }
      if (lock.kind === "held") {
        return refuse(
          `the enqueue lock ${lock.path} for ${nameWithOwner}#${number} at ${head} is held ${lock.detail}, so another call is enqueuing it; this call did not enqueue. Call delivery_land again with the same pr and expectHeadSha ${head} to wait on that entry. If no delivery_land call is running, an interrupted call left the lock: check the pull request's merge queue on GitHub, then delete the lock; no receipt was written`,
        )
      }
      const decided = await (async (): Promise<LandOutcome | null> => {
        // Decided on a read made under the lock: the read above may predate an enqueue another
        // call has since made, recorded and released the lock on, and taking that call's record
        // for a removal would lose it.
        const locked = await read()
        if ("reason" in locked) return refuse(`${locked.reason}; nothing was enqueued and no receipt was written`)
        const now = decideQueue(locked.snapshot, head, 0)
        if (now.kind === "refused") {
          const seen = recordedNow()
          if (!("reason" in seen) && seen.generation !== null) {
            removePendingLocked(pendingDirectory, nameWithOwner, requested, head, seen.generation)
          }
          return refuse(`${now.reason}; nothing was enqueued and no receipt was written`)
        }
        // An entry, or a merge, appeared since: wait on it as a call that saw it first would.
        if (now.kind === "merged" || locked.snapshot.entry !== null) return joinEntry()
        // No entry. If an earlier call enqueued (or tried to enqueue) this head, the entry was
        // removed since, by the queue or by hand, or never made: re-enqueuing would override a
        // removal, so it refuses once and the next call, which finds no record, decides afresh.
        const history = recordedNow()
        if ("reason" in history) return refuse(history.reason)
        if (history.generation !== null) {
          removePendingLocked(pendingDirectory, nameWithOwner, requested, head, history.generation)
          return refuse(
            "mergeQueueEntry: observed no entry for a pull request an earlier call enqueued, expected a queued or merged one; the entry was removed from the merge queue and was not enqueued again (an earlier enqueue whose answer was lost may also never have made one). Call delivery_land again only if the pull request should be re-enqueued; nothing was merged and no receipt was written",
          )
        }
        const unenqueued = interrupted("before the enqueue; nothing was enqueued and no receipt was written")
        if (unenqueued !== null) return unenqueued
        // The intent is recorded before the mutation is sent: GitHub can accept it and the answer
        // still be lost, and without the record a retry would read that as "never enqueued".
        const generation = newGeneration()
        const claimed = recordEnqueue(generation)
        if (typeof claimed !== "string") return refuse(`${claimed.reason}; nothing was enqueued and no receipt was written`)
        if (claimed === "exists") {
          // Another call recorded this head between the read and the claim: it is enqueuing or
          // enqueued it, so this call does not, and leaves that call's record alone.
          return refuse(
            `the pending-queue record for ${nameWithOwner}#${number} at ${head} appeared while this call was deciding, so another call is enqueuing it; this call did not enqueue. Call delivery_land again with the same pr and expectHeadSha ${head} to wait on that entry; no receipt was written`,
          )
        }
        ownedRecord = generation
        const answer = enqueueAnswer(
          await run(enqueueArgv(nodeId, head), { cwd, timeoutMs: FORGE_TIMEOUT_MS, env: forgeCommandEnv }),
        )
        if (answer.kind === "rejected") {
          removePendingLocked(pendingDirectory, nameWithOwner, requested, head, generation)
          return refuse(`${queueLabel.join(" ")}: ${answer.reason}; nothing was enqueued and no receipt was written`)
        }
        if (answer.kind === "uncertain") {
          return refuse(
            `${queueLabel.join(" ")}: ${answer.reason}; the enqueue may have been accepted, so its pending-queue record is kept. Call delivery_land again with the same pr and expectHeadSha ${head}: it waits on the entry if GitHub queued it, and otherwise refuses as removed without enqueuing, after which the next call enqueues afresh; no receipt was written`,
          )
        }
        return null
      })().finally(lock.release)
      if (decided !== null) return decided
    }
    const waited = await awaitQueue({
      read,
      sleep,
      stopped: () => signal?.aborted === true,
      expected: head,
      budgetMs: budget.ms,
    })
    if (waited.kind === "refused") {
      // Only a confirmed end (closed, head changed, entry removed) forgets the enqueue. A read
      // that failed observed nothing, and the entry may still be queued: the record stays so a
      // retry does not enqueue over it. Only the record this call wrote or joined is forgotten:
      // a newer call may have recorded a fresh enqueue since this call last read the queue.
      if (waited.terminal && ownedRecord !== null) {
        clearPending(pendingDirectory, nameWithOwner, requested, head, ownedRecord, nowMs())
      }
      return refuse(`${waited.reason}; no direct merge was attempted and no receipt was written`)
    }
    if (waited.kind === "pending") {
      const reason = `the merge queue holds ${nameWithOwner}#${number} (${waited.detail}) and has not merged it within ${budget.ms / 1000} seconds; nothing else was merged and no receipt was written. Call delivery_land again with the same pr and expectHeadSha ${head}: it waits on the existing queue entry and does not enqueue twice`
      return { ok: false, reason, text: `delivery_land pending: ${reason}`, queued: true }
    }
    // The record stays until the receipt is written: a retry after a failed proof reads the
    // request as MERGED and needs it to choose the queue-aware proof. It is written here, before
    // any fallible proof step, also when the queue merged an entry this call never saw.
    mergeArgv = queueLabel
    queueTraceLost = adoptRecord()?.reason ?? null
    notes.push(
      `The base branch ${first.pr.baseRefName} requires a merge queue, so the reviewed head ${head} was enqueued with enqueuePullRequest(expectedHeadOid) and merged by the queue with ${queue.method}.`,
    )
    const reread = await rereadLanded()
    if (reread !== null) return reread
  } else {
    if (mergeMethod === "merge") {
      mergePolicy = await allowMergeCommit(forge, nameWithOwner, boundForgeRun)
      if (mergePolicy === false) {
        return refuse(
          `merge_method "merge": repository policy allow_merge_commit observed false, expected true; no merge was issued and no receipt was written`,
        )
      }
    }
    // The merge is bound to the head that was just read and checked against
    // `expectHeadSha`. A push between the read and the merge then fails the merge at
    // the forge instead of landing a commit nobody in this call observed, so the
    // binding must be a whole object id: a value the forge would not match exactly
    // is no binding, and merging without one is the race itself.
    if (!FULL_OID.test(head)) {
      return refuse(
        `pr.headRefOid: observed ${show(first.pr.headRefOid)}, expected a 40- or 64-character hex object id to bind the merge to; no merge was issued`,
      )
    }
    // A squash lands as one commit, and its subject is the reviewed title. Left to
    // the forge, a one-commit pull request would land under that commit's message.
    const title = first.pr.title?.trim() ?? ""
    if (mergeMethod === "squash" && title === "") {
      return refuse(
        `pr.title: observed ${show(first.pr.title)}, expected a non-empty title to pass as the squash commit subject; no merge was issued and no receipt was written`,
      )
    }
    try {
      // `gh pr merge --match-head-commit` and `glab mr merge --sha` each fail the merge
      // unless the source head is still this commit. Neither is a default.
      const binding = forge === "github" ? ["--match-head-commit", head] : ["--sha", head]
      const options = mergeMethod === "squash" ? { mergeMethod, squashSubject: title } : { mergeMethod }
      mergeArgv = [...mergeArgs(forge, number, options), "--repo", cliRepo, ...binding]
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
    const unmerged = interrupted("before the merge; no merge was issued and no receipt was written")
    if (unmerged !== null) return unmerged
    merging = true
    const mergeFailure = cliFailure(
      mergeArgv,
      await run(mergeArgv, { cwd, timeoutMs: FORGE_TIMEOUT_MS, env: forgeCommandEnv }),
    )
    if (mergeFailure !== null) return refuse(`${mergeFailure}; no receipt was written`)
    const reread = await rereadLanded()
    if (reread !== null) return reread
  }

  // A queue landing, whether this call waited on it or resumes one, is also checked against
  // the forge's compare API: the merge commit must be in the base branch's history there, as
  // it must be in the fetched base tip's history below.
  if (queue !== null) {
    const landedOid = proved.mergeCommitOid?.trim().toLowerCase() ?? ""
    const base = normalizeRepoPath("github", nameWithOwner)
    if (!FULL_OID.test(landedOid) || base === null) {
      return refuseMerged(
        `pr.mergeCommitOid: observed ${show(proved.mergeCommitOid)} in ${show(nameWithOwner)}, expected a whole object id to compare with ${proved.baseRefName}`,
      )
    }
    const contains = containmentArgv(base, landedOid, proved.baseRefName)
    const result = await run(contains, { timeoutMs: FORGE_TIMEOUT_MS, env: forgeCommandEnv })
    const failure = cliFailure(contains, result)
    if (failure !== null) return refuseMerged(failure)
    if (!branchContains(result.stdout)) {
      return refuseMerged(
        `${contains.join(" ")}: observed ${show(result.stdout.trim())}, expected "ahead" or "identical": the merge commit ${landedOid} is not in the history of ${proved.baseRefName}`,
      )
    }
    notes.push(`The merge commit ${landedOid} is in the history of ${proved.baseRefName} (compare status ${result.stdout.trim()}).`)
  }

  const proofMethod = queue !== null ? queue.method : alreadyMerged ? null : landMethod
  const provedOid = proved.mergeCommitOid?.trim().toLowerCase() ?? ""
  let localCommits: LocalCommits | null = null
  const fetchRun = (argv: string[]): Promise<CliResult> =>
    Promise.resolve(run(argv, { cwd, timeoutMs: FETCH_TIMEOUT_MS, env: gitEnv }))
  if (proved.state.trim().toUpperCase() === "MERGED" && FULL_OID.test(provedOid)) {
    // Every proof reads the reviewed head locally: the content proof merges it onto the
    // landed commit's parent, and the rebase patch ids and queue ancestry check read it too.
    const required = FULL_OID.test(head) && head !== provedOid ? [provedOid, head] : [provedOid]
    const local = await ensureLocalCommits(
      required,
      proved.baseRefName,
      remote,
      git,
      fetchRun,
      deps.sleep ?? abortableSleep,
      merging ? undefined : signal,
    )
    if ("reason" in local) {
      const source = alreadyMerged ? "the pull request read" : `the re-read after ${(mergeArgv ?? []).join(" ")}`
      return refuseMerged(`${source}: ${local.reason}`)
    }
    localCommits = local
  }

  // The base branch's tip, named by `ls-remote` as an exact id and fetched by that id, so the
  // landed commit's place in base history is judged locally and no ref is trusted.
  const baseTip = async (): Promise<string | { reason: string }> => {
    const listing = remoteBranchTipArgv(remote, proved.baseRefName)
    if (listing === null) {
      return { reason: `git ls-remote ${remote}: observed operands it will not issue, expected a remote name and the base branch ${show(proved.baseRefName)}` }
    }
    const result = await run(listing, { cwd, timeoutMs: FORGE_TIMEOUT_MS, env: gitEnv })
    const failure = cliFailure(listing, result)
    if (failure !== null) return { reason: failure }
    const wanted = `refs/heads/${proved.baseRefName}`
    const lines = result.stdout.split("\n").filter((line) => line.trim() !== "")
    const fields = lines.length === 1 ? (lines[0] ?? "").split(/\s+/) : []
    const tip = fields[0]?.toLowerCase() ?? ""
    if (fields.length !== 2 || fields[1] !== wanted || !FULL_OID.test(tip)) {
      return { reason: `${listing.join(" ")}: observed ${show(result.stdout.trim().slice(0, 200))}, expected exactly one line "<oid> ${wanted}"` }
    }
    const tipLocal = await ensureLocalCommits([tip], proved.baseRefName, remote, git, fetchRun, deps.sleep ?? abortableSleep, merging ? undefined : signal)
    return "reason" in tipLocal ? { reason: tipLocal.reason } : tip
  }

  const proof = await mergeProof(proved, proofMethod, git, queue !== null, baseTip)
  if ("reason" in proof) {
    const source = alreadyMerged ? "the pull request read" : `the re-read after ${(mergeArgv ?? []).join(" ")}`
    return refuseMerged(`${source}: ${proof.reason}`)
  }

  // Re-derived from the branch the re-read proved, which need not be the branch the
  // first read named, and checked again: no receipt claims an active ledger with
  // nothing for the native close-out commands to process.
  const proven = beadIdentity(params.beadId, proved.headRefName)
  if ("reason" in proven) return refuseMerged(proven.reason)
  const unproven = missingBeadIdentity(proven.ids, proved.headRefName, repository.ledger)
  if (unproven !== null) return refuseMerged(unproven)

  // The probe is asked from the checkout that configures `remote`: a name only
  // resolves in the repository that owns it.
  const verdict = await remoteBranchAbsent(remote, proved.headRefName, cwd, forgeRun, env)
  if (verdict !== "absent") {
    notes.push(
      `The remote branch ${proved.headRefName} on ${remote} is ${verdict}, not proved absent, so branch.deletedRemote stays false and remoteAbsenceVerifiedAt stays null.`,
    )
  }

  // Read only now that the landing is proved, and written below only once its receipt
  // has passed the validator: the setting governs every later merge by every
  // contributor, so a landing that refused anywhere above leaves it as it was.
  const observedAutoDelete: ReceiptAutoDelete = await autoDeleteSetting(forge, nameWithOwner, boundForgeRun, gitlabHost)

  // The proof of the landing is the read that observed it: the re-read when a merge
  // was issued here, the first read when the forge had already merged it.
  const observingArgv = rereadArgv ?? first.argv
  const evidence: Record<string, unknown> = {
    remote,
    mergeMethod: landMethod,
    queue: queue === null ? null : { rule: "merge_queue", method: queue.method },
    mergePolicy,
    // The URL lives here and not in `repo.remote`, which records the configured
    // remote NAME: the name is what a later `git ls-remote` is given, and the URL is
    // the redacted spelling of what was contacted.
    remoteUrl,
    // Both the repository and the head the merge was bound to are recorded, because a
    // reader of this receipt cannot otherwise tell a bound merge from an ambient one.
    boundRepo: nameWithOwner,
    ledger: { root: repository.ledger.root, active: repository.ledger.active },
    prView: {
      argv: first.argv.join(" "),
      number: first.pr.number,
      state: first.pr.state,
      headRefOid: first.pr.headRefOid,
      baseRefName: first.pr.baseRefName,
    },
    expectHeadSha: expected === "" ? null : expected,
    worktree,
    autoDelete: { observed: observedAutoDelete, requested: params.setupAutoDelete === true },
    merge: mergeArgv === null ? null : { argv: mergeArgv.join(" "), method: landMethod, boundHead: head },
    mergeShape: { parents: proof.parents, rebase: proof.rebase },
    // The commits the shape proof read and the fetches that brought them local; an
    // empty list means they were already present.
    localCommits,
    reread:
      rereadArgv === null
        ? null
        : {
            argv: rereadArgv.join(" "),
            number: proved.number,
            state: proved.state,
            headRefOid: proved.headRefOid,
            baseRefName: proved.baseRefName,
            mergeCommitOid: proved.mergeCommitOid,
          },
    remoteBranch: { ref: `refs/heads/${proved.headRefName}`, verdict },
    preconditions: Object.keys(preconditions).length === 0 ? null : preconditions,
  }

  // Built and validated before the setting write, and again after it with the write's
  // outcome in the notes, so a receipt the validator refuses has written nothing.
  const compose = (settingNote: string): { receipt: LandingReceipt } | { reason: string } => {
    let built: LandingReceipt
    try {
      built = buildReceipt({
        emitter: { plugin: pkg.name, version: pkg.version, tool: "delivery_land" },
        repo: { key: repository.key, canonicalRoot: repository.canonicalRoot, remote, forge, nameWithOwner },
        pr: {
          number: proved.number,
          url: proved.url,
          state: proved.state,
          baseRefName: proved.baseRefName,
          headRefName: proved.headRefName,
          headRefOid: proved.headRefOid,
          mergeCommitOid: proof.oid,
          mergedAt: proved.mergedAt,
        },
        branch: {
          name: proved.headRefName,
          deletedRemote: verdict === "absent",
          remoteAbsenceVerifiedAt: verdict === "absent" ? observedAt : null,
          autoDeleteSetting: observedAutoDelete,
        },
        worktree: { path: worktree?.path ?? null, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
        beads: { ids: proven.ids, ledgerActive: repository.ledger.active },
        proof: { method: observationMethod(observingArgv), observedAt, evidence },
        outcome: "landed",
        now,
        notes: [...notes, settingNote].join(" "),
      })
    } catch (error) {
      return { reason: `the receipt could not be built: ${error instanceof Error ? error.message : String(error)}` }
    }
    const validation = validateReceipt(built)
    return validation.ok
      ? { receipt: validation.receipt }
      : { reason: `the receipt was refused by its validator, so no file was written: ${validation.reason}` }
  }

  let composed = compose(
    params.setupAutoDelete === true
      ? `setupAutoDelete: the deletion-on-merge write was not issued; the setting observed was ${observedAutoDelete}.`
      : `setupAutoDelete was not requested, so no repository setting was written; autoDeleteSetting was observed as ${observedAutoDelete}.`,
  )
  if ("reason" in composed) return refuseMerged(composed.reason)
  const landedState = alreadyMerged ? "the request was already MERGED" : "the pull request is merged"
  if (params.setupAutoDelete === true) {
    // After a merge issued here the receipt must be written, so a stop skips the optional
    // setting write instead of returning: the receipt records that no write was issued.
    const unwritten = merging
      ? null
      : interrupted(
          `before the deletion-on-merge write; no setting was written and no receipt was written, and ${landedState}, so delivery_land proves it again without merging`,
        )
    if (unwritten !== null) return unwritten
    if (merging && signal?.aborted === true) {
      notes.push("The stop arrived after the merge, so the requested deletion-on-merge write was skipped; the receipt was still written.")
      composed = compose(
        `setupAutoDelete: the deletion-on-merge write was not issued because the call was stopped; the setting observed was ${observedAutoDelete}.`,
      )
      if ("reason" in composed) return refuseMerged(composed.reason)
    } else {
    const enabled = await enableAutoDelete(forge, nameWithOwner, boundForgeRun, gitlabHost)
    composed = compose(
      enabled.ok
        ? `setupAutoDelete: the forge accepted a deletion-on-merge write; the setting observed before the request was ${observedAutoDelete}, which is what this receipt records because acceptance is not a re-read.`
        : `setupAutoDelete: the deletion-on-merge write was refused: ${enabled.reason ?? "no reason reported"}. The setting observed before the request was ${observedAutoDelete}.`,
    )
    if ("reason" in composed) return refuseMerged(composed.reason)
    }
  }
  // After a merge issued here the receipt is part of the critical section: the stop waits for it.
  const unrecorded = merging ? null : interrupted(
    `before the receipt was written; no receipt was written, and ${landedState}, so delivery_land proves it again without merging`,
  )
  if (unrecorded !== null) return unrecorded

  const receipt = composed.receipt
  let receiptPath: string
  try {
    receiptPath = writeReceipt(receipt, deps.receiptsDirectory ?? receiptDirectory(env, receipt.repo.key))
  } catch (error) {
    return refuseMerged(`the receipt could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
  // The landing is recorded, so the enqueue record this call wrote or read has done its work.
  if (ownedRecord !== null) {
    clearPending(pendingDirectory, nameWithOwner, requested, head, ownedRecord, deps.now?.() ?? Date.now())
  }

  const next = receipt.beads.ledgerActive
    ? nativeCloseoutSteps(receipt, receiptPath, proof.oid)
    : (["delivery_cleanup"] as const)
  const text = [
    `delivery_land proved ${nameWithOwner}#${proved.number} merged as ${proof.oid.slice(0, 12)} on ${forge}.`,
    `branch ${proved.headRefName}: remote ${verdict}, deletedRemote ${verdict === "absent"}, autoDeleteSetting ${observedAutoDelete}.`,
    `receipt: ${receiptPath}`,
    receipt.beads.ledgerActive
      ? `next (children before parents):\n${next
          .slice(0, -1)
          .map((step) => `  ${step}`)
          .join("\n")}\n  delivery_cleanup to remove the worktree and the local branch.`
      : "next: run delivery_cleanup to remove the worktree and the local branch.",
  ].join("\n")
  return { ok: true, receipt, receiptPath, text, next }
}
