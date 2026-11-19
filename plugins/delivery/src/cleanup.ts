import { existsSync, lstatSync, realpathSync, type Stats } from "node:fs"
import { basename, dirname, isAbsolute, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { type GitPin, inspectCheckoutMarker, physical, verifyCheckout } from "@srobroek/opencode-lib/checkout-marker"
import { OPERATION_MARKERS, operationsInProgress, stashesOnBranch } from "@srobroek/opencode-lib/worktree-state"
import pkg from "../package.json" with { type: "json" }
import {
  type CliResult,
  type CliRunner,
  FORGE_TIMEOUT_MS,
  forgeEnvironment,
  forgeTarget,
  gitObservationEnvironment,
  normalizeRepoPath,
  observeGithubBranch,
  REMOTE_NAME,
  redactRemote,
  remoteBranchAbsent,
  repoPathFromRemote,
  runCli,
  SAFE_GIT_ARGS,
  singleRemoteRecord,
} from "./forge-adapter.ts"
import {
  buildReceipt,
  canonicalLedger,
  closeoutCommands,
  type GitRunner,
  type LandingReceipt,
  listReceipts,
  type ReceiptPr,
  readReceipt,
  receiptDirectory,
  repoKey,
  repositoryContext,
  validateReceipt,
  writeReceipt,
} from "./landing-receipt.ts"
import { type GitReadAt, retargetRepository } from "./target-repo.ts"


/**
 * Bounds for the commands whose cost grows with the work, not with the ref count.
 * This is a registered tool, so the harness sets no deadline of its own; each bound
 * only stops a command that will never finish, and a command it stops reports its
 * step as not done.
 */
export type CleanupBounds = {
  /**
   * Ref and config reads — `rev-parse`, `rev-list`, `show-ref`, `worktree list`,
   * `remote get-url` — are cheap, but a loaded machine can stall even those for
   * seconds, and a read that runs out refuses the cleanup.
   */
  refReadMs: number
  /** `git status --porcelain` walks the whole target tree, which a large checkout makes slow. */
  treeScanMs: number
  /** Read-only `bd show`: a cold embedded store takes 30-50 s to open; matches the beads runner's 120 s wait. */
  bdShowMs: number
  /**
   * `git worktree remove` deletes the whole tree, dependency and build output
   * included, and `git branch -d` rewrites a ref under a lock. A kill mid-way leaves a
   * half-deleted worktree or a stale lock, so the bound is generous.
   */
  mutationMs: number
}

export const CLEANUP_BOUNDS: Readonly<CleanupBounds> = {
  refReadMs: 5_000,
  treeScanMs: 60_000, bdShowMs: 120_000, mutationMs: 600_000 }
const MAX_CLI_JSON_BYTES = 1024 * 1024
const MAX_DIRTY_PATHS = 8
const LOCAL_REF_PREFIX = "refs/heads/"

/** The GitHub fields this observation needs, in one `--json` projection. */
const PR_FIELDS = "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt"

export type DeliveryCleanupParams = {
  receipt?: string
  pr?: number
  branch?: string
  worktree?: string
  remote?: string
  /** `<owner>/<name>` of a repository other than the session's; needs `repoPath` or a `worktree` of it. */
  repo?: string
  /** A checkout of `repo` on this machine. */
  repoPath?: string
}

/** What a successful call removed and what it left alone, in words for the caller. */
export type CleanupReport = { removed: string[]; skipped: string[] }

export type CleanupSuccess = {
  ok: true
  receipt: LandingReceipt
  path: string
  remoteBranchAbsence: "absent" | "present" | "unknown"
  /** True when the worktree was already gone, so this call removed nothing and wrote no receipt. */
  alreadyCleaned: boolean
  /** True only when this call deleted the receipt branch's ref; false when it was already gone, left alone, or nothing ran. */
  localRefDeleted: boolean
  report: CleanupReport
}

export type CleanupFailure = { ok: false; reason: string }
export type CleanupResult = CleanupSuccess | CleanupFailure

export type CleanupDeps = {
  run?: CliRunner
  now?: () => number
  env?: NodeJS.ProcessEnv
  /** Overrides for {@link CLEANUP_BOUNDS}; tests inject short ones. */
  bounds?: Partial<CleanupBounds>
  /**
   * The tool call's abort signal. It ends every read and stops the call before the
   * removal; it is never given to the removal or anything after it, because an
   * interrupted removal is the one outcome worse than either finishing or not starting.
   */
  signal?: AbortSignal
  /**
   * Called once every read proof has passed, before the removal section (outside any lock the
   * section takes, because it may prompt a person). A throw ends the call with nothing removed;
   * the error propagates.
   */
  authorize?: (request: { worktree: string; branch: string; pr: number }) => Promise<void>
  /**
   * OpenCode's own worktree registry. A worktree it created is tracked there, and a
   * `git worktree remove` behind its back leaves an entry the host can no longer
   * remove, so a listed target is removed through `remove` instead (never forced).
   */
  host?: HostWorktrees
  /**
   * Runs the removal itself (the last identity proof, the worktree removal and the branch deletion)
   * as one critical section: the caller takes whatever lock excludes every other remover, confirms
   * what it must confirm last, then calls `run`. It returns `run`'s result, or a failure when it
   * refuses. Absent, `run` is called directly. `authorize` (a prompt) happens before and outside it.
   */
  removalSection?: (worktree: string, run: () => Promise<CleanupFailure | RemovalFacts>) => Promise<CleanupFailure | RemovalFacts>
  /**
   * The last look, called inside the removal section after every read (identity, tree, host
   * registry) and immediately before the removal call, so nothing that changed during those reads
   * can slip past it. A returned reason refuses the removal.
   */
  finalCheck?: (worktree: string) => Promise<string | undefined>
  /**
   * The synchronous Git reader behind the repository identity reads (the repository
   * key, the common directory and the canonical ledger root); each runs within
   * `bounds.refReadMs`. Tests observe it.
   */
  git?: GitRunner
}

/** What the removal section proved and did, for the continuation receipt. */
export type RemovalFacts = {
  ok: true
  registration: Absence
  pathGone: Absence
  localAbsence: Absence
  /** What was done with the receipt branch's local ref: deleted, already gone, or left because it moved. */
  localRefPlan: LocalRefPlan
  executionDir: string
}

export type HostWorktrees = {
  list: () => Promise<readonly { directory: string }[]>
  /** Non-force removal; rejects with the host's reason when it refuses. */
  remove: (directory: string) => Promise<void>
}

/**
 * Which remover owns `target`: the host when its registry lists the same directory
 * (compared by canonical path), git otherwise. Pure given `canonical`.
 */
export function removalRoute(
  listed: readonly { directory: string }[],
  target: string,
  canonical: (path: string) => string = (path) => physicalPath(path) ?? path,
): "host" | "git" {
  const want = canonical(target)
  return listed.some((entry) => canonical(entry.directory) === want) ? "host" : "git"
}

export type WorktreeRecord = {
  path: string
  head: string
  branch: string | null
  detached: boolean
  prunable: boolean
}

type TargetIdentity = {
  records: WorktreeRecord[]
  target: WorktreeRecord
  main: WorktreeRecord
  /** The session repository's common directory, from which the target was verified. */
  common: string
  /** The target's physical path, resolved once; every command in the target runs here. */
  cwd: string
  /** Pins Git to the verified admin directory and work tree, so the marker cannot redirect it later. */
  pin: GitPin
}

/**
 * One observed pull request, in receipt spelling, plus the CLI and verb that
 * observed it — which is what the continuation receipt records as `proof.method`,
 * so the field names a command this call actually issued.
 *
 * It carries no repository identity: the repository was decided, and cross-checked
 * against the receipt, before this read was issued.
 */
type PullRequestObservation = ReceiptPr & { method: string }
type ReceiptResolution =
  | { tag: "resolved"; receipt: LandingReceipt; path: string }
  | { tag: "refused"; failure: CleanupFailure }

type Absence = "absent" | "present" | "unknown"

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (value === undefined) return "missing"
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function refuse(field: string, observed: unknown, expected: string): CleanupFailure {
  return { ok: false, reason: `${field}: observed ${show(observed)}, expected ${expected}` }
}
function isFailure(value: unknown): value is CleanupFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, "ok")
  return descriptor !== undefined && "value" in descriptor && descriptor.value === false
}

/** A validated receipt and the file it was read from. */
export type ReceiptCandidate = { receipt: LandingReceipt; path: string }

/**
 * What names the receipt to clean up. Every field narrows; `head` is the HEAD of the worktree
 * the caller named (branch without `refs/heads/`, or null when detached), used to tell apart
 * receipts that the other fields leave ambiguous.
 */
export type ReceiptSelector = {
  pr?: number
  branch?: string
  worktree?: string
  head?: { branch: string | null; oid: string }
}

export type ReceiptSelection = { ok: true; candidate: ReceiptCandidate } | CleanupFailure

const MAX_LISTED_CANDIDATES = 10

function describeCandidates(candidates: readonly ReceiptCandidate[]): string {
  const shown = candidates.slice(0, MAX_LISTED_CANDIDATES).map((c) => {
    const state = c.receipt.worktree.removed ? "cleaned" : "uncleaned"
    return `pr ${c.receipt.pr.number} branch ${show(c.receipt.branch.name)} ${state} receipt ${c.path}`
  })
  const more = candidates.length > shown.length ? ` (+${candidates.length - shown.length} more)` : ""
  return `${shown.join("; ")}${more}`
}

function describeSelector(selector: ReceiptSelector, scope: string): string {
  if (selector.pr !== undefined) return `pr ${selector.pr}`
  if (selector.branch !== undefined) return `branch ${show(selector.branch)}`
  if (selector.worktree !== undefined) return `worktree ${show(selector.worktree)}`
  return scope
}

/**
 * Picks the one receipt a cleanup is about. `candidates` are validated receipts, newest first.
 * Only a PR's newest receipt counts, because a continuation supersedes the landing it continues.
 * With no selector at all uncleaned receipts are preferred, and exactly one must remain; with a
 * selector a cleaned receipt qualifies too, so a repeated cleanup finds its finished landing. `pr`,
 * `branch` and `worktree` must all match; `head` breaks a tie by reviewed head oid, then branch.
 * Zero matches or several are refused with every candidate listed, never guessed.
 */
export function selectReceipt(
  candidates: readonly ReceiptCandidate[],
  selector: ReceiptSelector,
  scope = "this repository",
): ReceiptSelection {
  const seen = new Set<number>()
  let pool = candidates.filter((c) => {
    if (seen.has(c.receipt.pr.number)) return false
    seen.add(c.receipt.pr.number)
    return true
  })
  const explicit = selector.pr !== undefined || selector.branch !== undefined || selector.worktree !== undefined
  if (!explicit && selector.head === undefined) {
    // Uncleaned landings are what a bare call is about; with none left, the cleaned ones stay candidates
    // so a repeated call on a repository with a single landing is idempotent.
    const open = pool.filter((c) => !c.receipt.worktree.removed)
    if (open.length > 0) pool = open
  }
  if (selector.pr !== undefined) pool = pool.filter((c) => c.receipt.pr.number === selector.pr)
  if (selector.branch !== undefined) pool = pool.filter((c) => c.receipt.branch.name === selector.branch)
  if (selector.worktree !== undefined) {
    const want = resolve(selector.worktree)
    pool = pool.filter((c) => c.receipt.worktree.path !== null && resolve(c.receipt.worktree.path) === want)
  }
  const head = selector.head
  if (head !== undefined && (pool.length > 1 || !explicit)) {
    const byOid = pool.filter((c) => c.receipt.pr.headRefOid === head.oid)
    pool = byOid.length > 0 ? byOid : pool.filter((c) => c.receipt.branch.name === head.branch)
  }
  const [only] = pool
  if (pool.length === 1 && only !== undefined) return { ok: true, candidate: only }
  const listing = candidates.length === 0 ? "no receipts" : `candidates: ${describeCandidates(candidates)}`
  if (pool.length === 0) {
    return refuse(
      "receipt",
      null,
      `the newest validated receipt for ${describeSelector(selector, scope)}; ${listing}`,
    )
  }
  return refuse(
    "receipt",
    `${pool.length} matching receipts`,
    `exactly one: pass receipt, pr or branch to choose; ${describeCandidates(pool)}`,
  )
}

/** What a finished removal took and left, for the caller. Pure. */
export function removalReport(
  receipt: LandingReceipt,
  path: string,
  target: { head: string; branch: string | null; detached: boolean },
  plan: LocalRefPlan,
): CleanupReport {
  const removed = [`worktree ${path}`]
  const skipped: string[] = []
  const branch = receipt.branch.name
  if (plan === "delete") removed.push(`local branch ${branch}`)
  else if (plan === "absent") skipped.push(`local branch ${branch} was already gone`)
  else skipped.push(`local branch ${branch} left in place: it no longer points at the reviewed head`)
  if (!target.detached && target.branch !== null && target.branch !== `${LOCAL_REF_PREFIX}${branch}`) {
    skipped.push(`branch ${target.branch.slice(LOCAL_REF_PREFIX.length)} (the worktree's own) left in place`)
  }
  return { removed, skipped }
}

export type WorktreeAcceptance = { ok: true; branch: "same" | "renamed" | "detached" } | CleanupFailure

/**
 * Whether a registered worktree is the landed one. Its HEAD must be the receipt's reviewed head;
 * the branch it sits on does not matter (a renamed branch, or none once the ref was deleted), and
 * any other HEAD is refused.
 */
export function acceptWorktree(
  record: { head: string; branch: string | null; detached: boolean },
  receipt: { branch: { name: string }; pr: { headRefOid: string } },
): WorktreeAcceptance {
  const failure = compare("worktree.HEAD", record.head, receipt.pr.headRefOid)
  if (failure !== null) return failure
  if (record.detached || record.branch === null) return { ok: true, branch: "detached" }
  return { ok: true, branch: record.branch === `${LOCAL_REF_PREFIX}${receipt.branch.name}` ? "same" : "renamed" }
}

/**
 * The branch names whose stash entries block removal: the receipt's branch, and the branch the
 * worktree is actually on when that differs (a rename keeps the stash under the new name). Pure.
 */
export function stashBranches(receiptBranch: string, target: { branch: string | null; detached: boolean }): string[] {
  // A stash made on a detached HEAD is subjected "WIP on (no branch)" / "On (no branch)".
  if (target.detached || target.branch === null) return [receiptBranch, DETACHED_STASH_BRANCH]
  const own = target.branch.slice(LOCAL_REF_PREFIX.length)
  return own === receiptBranch ? [receiptBranch] : [receiptBranch, own]
}

const DETACHED_STASH_BRANCH = "(no branch)"

export type LocalRefPlan = "delete" | "absent" | "moved"

/** What to do with the receipt branch's local ref: delete it only when it is still at the reviewed head. */
export function planLocalRef(observedOid: string | null, reviewedOid: string): LocalRefPlan {
  if (observedOid === null) return "absent"
  return observedOid === reviewedOid ? "delete" : "moved"
}

function commandLabel(argv: readonly string[]): string {
  return argv.map((value) => JSON.stringify(value)).join(" ")
}

function completed(result: CliResult): boolean {
  return result.ok && result.exitCode === 0 && result.error === undefined
}

function commandFailure(field: string, argv: readonly string[], result: CliResult, expected: string): CleanupFailure {
  const exit = result.exitCode === null ? "no exit status" : `exit ${result.exitCode}`
  const error = result.error === undefined ? "" : `, error ${result.error}`
  const stderr = result.stderr.trim() === "" ? "" : `, stderr ${result.stderr.trim().slice(0, 400)}`
  return refuse(field, `${commandLabel(argv)} (${exit}${error}${stderr})`, expected)
}

function own(holder: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key)
  if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined
  return descriptor.value
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(holder: Record<string, unknown>, key: string): string | null {
  const value = own(holder, key)
  return typeof value === "string" && value !== "" ? value : null
}

function integer(holder: Record<string, unknown>, key: string): number | null {
  const value = own(holder, key)
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function parseJsonObject(field: string, result: CliResult): Record<string, unknown> | CleanupFailure {
  if (!completed(result)) return commandFailure(field, [], result, "a successful bounded forge read")
  if (Buffer.byteLength(result.stdout) > MAX_CLI_JSON_BYTES) {
    return refuse(field, `JSON over ${MAX_CLI_JSON_BYTES} bytes`, `at most ${MAX_CLI_JSON_BYTES} bytes`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return refuse(field, "unparseable JSON", "a JSON object from the forge")
  }
  return record(parsed) ?? refuse(field, parsed, "a JSON object from the forge")
}

function normalizedOid(value: unknown): string | null {
  if (typeof value !== "string") return null
  const oid = value.trim().toLowerCase()
  return oid === "" ? null : oid
}

/**
 * The repository one receipt's own remote names, pinned to the forge's canonical
 * CLI host.
 *
 * `cliRepo` is what `--repo` receives, and both CLIs take `<host>/<path>` there:
 * `gh` documents `[HOST/]OWNER/REPO` and `glab` the same shape. Qualifying it is
 * what stops a bare path from being resolved against a configured host alias.
 * `nameWithOwner` stays unqualified: that is the spelling the receipt records, and
 * the spelling this identity had to equal to exist at all.
 */
type RemoteIdentity = {
  forge: "github" | "gitlab"
  nameWithOwner: string
  cliRepo: string
  /**
   * Exactly what `git remote get-url` printed in the landed worktree, rewrites
   * already expanded. Raw, not redacted: this is spent as an argv by the absence
   * probe, which returns a verdict and never quotes what it was given, so no
   * diagnostic can carry it. Nothing else may print it — {@link redactRemote} is
   * what refusal messages use.
   */
  remoteUrl: string
  env: Readonly<Record<string, string>>
}

/**
 * Resolve the repository to observe from `repo.remote` — never from whichever
 * repository a forge CLI infers from the directory it runs in.
 *
 * `gh repo view` and `glab repo view` answer about whichever repository their CLI
 * treats as the local default, which is `origin`. On a checkout whose `origin` is
 * a contributor fork and whose `upstream` is the remote the landing was run with,
 * that is not the repository the receipt proves: the pull request came out of the
 * fork, and the identity comparison then refused a valid receipt, so cleanup
 * stayed blocked after a landing that had already succeeded. The remote *name* is
 * the field the receipt records, so the URL is resolved from that name and every
 * forge command is bound to the identity that URL names. That also moves the
 * identity decision ahead of every forge call, instead of catching a foreign
 * repository only after one was issued against it.
 *
 * `cwd` is the worktree the receipt names, not the directory cleanup was called in,
 * and the caller proves that path is a live listed worktree of this repository
 * before passing it. A remote name resolves per repository, but a remote *URL*
 * resolves per worktree: `extensions.worktreeConfig` scopes `url.<other>.insteadOf`
 * to one worktree, and `git remote get-url` expands those rewrites. So the landed
 * worktree and the directory cleanup runs from can print different URLs for the
 * same name, and only one of them is the URL the landing recorded.
 *
 * The Git read runs with {@link gitObservationEnvironment}: an ambient `GIT_DIR`,
 * `GIT_WORK_TREE`, or `GIT_CONFIG_*` selector decides which repository's remotes
 * are read, which is the same substitution by another route. The forge reads run
 * with {@link forgeEnvironment} and, on GitLab, an explicitly pinned canonical
 * host, and they are given no working directory at all: the repository is named
 * in the request, and nothing about the answer may depend on any directory.
 *
 * Every part of the identity is refused rather than guessed at: a receipt whose
 * remote is not a remote name, names no configured remote, names a host no
 * adapter verifies, names a different forge than the receipt recorded, carries no
 * `<owner>/<name>`, or names a repository other than the one the receipt proves is
 * not an observation. The last of those is the cross-check that makes a receipt
 * non-transferable: it is decided here, before one forge command is issued, so a
 * receipt carried into another checkout asks that checkout's forge nothing.
 */
async function resolveRemoteIdentity(
  receipt: LandingReceipt,
  run: CliRunner,
  cwd: string,
  forgeEnv: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
  refReadMs: number,
  pin?: GitPin,
): Promise<RemoteIdentity | CleanupFailure> {
  // Tested exactly as recorded, not trimmed first: `" origin"` is not the name of a
  // remote, it is a receipt that does not say which remote, and normalising it here
  // would let this call answer a question the receipt never asked.
  const remote = receipt.repo.remote
  if (!REMOTE_NAME.test(remote)) return refuse("repo.remote", remote, "a git remote name")
  const argv = ["git", ...SAFE_GIT_ARGS, "remote", "get-url", remote]
  const expected = `exactly one URL record for the configured remote ${remote} in ${cwd}`
  const result = await run(argv, { cwd, timeoutMs: refReadMs, env: { ...gitObservationEnvironment(env), ...pin } })
  if (!completed(result)) return commandFailure("repo.remote", argv, result, expected)
  // Not trimmed: a trimmed value is what lets a malformed one through. `URL` deletes
  // embedded tabs and newlines before parsing, so a rewritten or multi-URL remote can
  // read as an ordinary forge URL here while Git contacts something else — and this
  // identity then authorises a removal whose absence probe can only ever say
  // "unknown". One terminal newline is a record terminator; everything else refuses.
  //
  // The refusal names the shape, never the bytes. A remote URL may carry userinfo or a
  // token query, and output that no parser here accepts cannot be redacted either:
  // {@link redactRemote} can only locate a secret in a spelling it understands, so
  // echoing an unparseable value would publish whatever it holds into a refusal
  // message and into any log that quotes one.
  const remoteText = singleRemoteRecord(result.stdout)
  if (remoteText === null) return refuse("repo.remote", "malformed Git remote output", expected)
  // Classified before it is redacted: `forgeTarget` owns that judgement and must
  // see the spelling Git will actually contact.
  const target = forgeTarget(remoteText)
  const remoteUrl = redactRemote(remoteText)
  if (target === null) {
    return refuse("repo.forge", `"unknown" for remote ${remote} at ${show(remoteUrl)}`, '"github" or "gitlab"')
  }
  const forgeFailure = compare("repo.forge", target.forge, receipt.repo.forge)
  if (forgeFailure !== null) return forgeFailure
  const fromRemote = repoPathFromRemote(remoteText)
  const nameWithOwner = fromRemote === null ? null : normalizeRepoPath(target.forge, fromRemote)
  if (nameWithOwner === null) {
    const shape = target.forge === "github" ? 'exactly "<owner>/<name>"' : 'a bounded "<group>/.../<project>" path'
    return refuse("repo.nameWithOwner", fromRemote, `${shape} from remote ${remote} at ${show(remoteUrl)}`)
  }
  const identityFailure = compare("repo.nameWithOwner", nameWithOwner, receipt.repo.nameWithOwner)
  if (identityFailure !== null) return identityFailure
  // Both forges are addressed by canonical host and path, and both have that host
  // pinned in the environment as well. The host is not caller data: it is the
  // verified value `forgeTarget` returned for the transport host Git will contact,
  // so `gh` and `glab` are told the same thing twice and can infer neither from a
  // configured alias nor from the directory.
  const cliRepo = `${target.canonicalHost}/${nameWithOwner}`
  const commandEnv = Object.assign(
    Object.create(null) as Record<string, string>,
    forgeEnv,
    target.forge === "github"
      ? { GH_HOST: target.canonicalHost }
      : { GITLAB_HOST: target.canonicalHost, GITLAB_API_HOST: target.canonicalHost },
  )
  // `remoteText`, not the redacted spelling: the absence probe has to contact what
  // Git contacted, and it is the one consumer allowed to hold the raw URL.
  return { forge: target.forge, nameWithOwner, cliRepo, remoteUrl: remoteText, env: commandEnv }
}

async function githubObservation(
  receipt: LandingReceipt,
  identity: RemoteIdentity,
  run: CliRunner,
): Promise<PullRequestObservation | CleanupFailure> {
  const argv = ["gh", "pr", "view", String(receipt.pr.number), "--repo", identity.cliRepo, "--json", PR_FIELDS]
  const method = argv.slice(0, 3).join(" ")
  const result = await run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env: identity.env })
  if (!completed(result)) return commandFailure("pr", argv, result, "a successful bounded GitHub pull-request read")
  const root = parseJsonObject("pr", result)
  if (isFailure(root)) return root
  const mergeCommit = record(own(root, "mergeCommit"))
  return {
    number: integer(root, "number") ?? -1,
    url: text(root, "url") ?? "",
    state: text(root, "state") ?? "",
    baseRefName: text(root, "baseRefName") ?? "",
    headRefName: text(root, "headRefName") ?? "",
    headRefOid: text(root, "headRefOid") ?? "",
    mergeCommitOid: mergeCommit === null ? null : normalizedOid(own(mergeCommit, "oid")),
    mergedAt: text(root, "mergedAt"),
    method,
  }
}

async function gitlabObservation(
  receipt: LandingReceipt,
  identity: RemoteIdentity,
  run: CliRunner,
): Promise<PullRequestObservation | CleanupFailure> {
  const argv = ["glab", "mr", "view", String(receipt.pr.number), "--repo", identity.cliRepo, "--output", "json"]
  const method = argv.slice(0, 3).join(" ")
  const result = await run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env: identity.env })
  if (!completed(result)) return commandFailure("pr", argv, result, "a successful bounded GitLab merge-request read")
  const root = parseJsonObject("pr", result)
  if (isFailure(root)) return root
  const mergeCommit = normalizedOid(own(root, "merge_commit_sha"))
  return {
    number: integer(root, "iid") ?? -1,
    url: text(root, "web_url") ?? "",
    state: text(root, "state") ?? "",
    baseRefName: text(root, "target_branch") ?? "",
    headRefName: text(root, "source_branch") ?? "",
    headRefOid: text(root, "sha") ?? "",
    mergeCommitOid: mergeCommit ?? normalizedOid(own(root, "squash_commit_sha")),
    mergedAt: text(root, "merged_at"),
    method,
  }
}

/** One resolved repository identity and the pull request read through it. */
type Observation = { identity: RemoteIdentity; pr: PullRequestObservation }

export async function observePullRequest(
  receipt: LandingReceipt,
  run: CliRunner = runCli,
  cwd: string = receipt.repo.canonicalRoot,
  env: NodeJS.ProcessEnv = process.env,
  refReadMs: number = CLEANUP_BOUNDS.refReadMs,
  pin?: GitPin,
): Promise<Observation | CleanupFailure> {
  const identity = await resolveRemoteIdentity(receipt, run, cwd, forgeEnvironment(env), env, refReadMs, pin)
  if (isFailure(identity)) return identity
  const pr =
    identity.forge === "github"
      ? await githubObservation(receipt, identity, run)
      : await gitlabObservation(receipt, identity, run)
  return isFailure(pr) ? pr : { identity, pr }
}

function compare(field: string, observed: unknown, expected: unknown): CleanupFailure | null {
  return observed === expected ? null : refuse(field, observed, `receipt value ${show(expected)}`)
}

/**
 * Whether the observation is the landing the receipt proves.
 *
 * Only the pull request is compared here. The repository it was read from is not
 * one of the comparisons, because it was never in doubt: the read was bound to the
 * identity {@link resolveRemoteIdentity} had already matched against the receipt.
 */
function verifyObservation(receipt: LandingReceipt, observed: PullRequestObservation): CleanupFailure | null {
  const observedState = observed.state.trim().toUpperCase()
  const receiptState = receipt.pr.state.trim().toUpperCase()
  const comparisons: readonly [string, unknown, unknown][] = [
    ["pr.number", observed.number, receipt.pr.number],
    ["pr.url", observed.url, receipt.pr.url],
    ["pr.state", observedState, "MERGED"],
    ["receipt.pr.state", receiptState, "MERGED"],
    ["pr.baseRefName", observed.baseRefName, receipt.pr.baseRefName],
    ["pr.headRefName", observed.headRefName, receipt.pr.headRefName],
    ["pr.headRefOid", observed.headRefOid, receipt.pr.headRefOid],
    ["pr.mergeCommitOid", observed.mergeCommitOid, receipt.pr.mergeCommitOid],
    ["pr.mergedAt", observed.mergedAt, receipt.pr.mergedAt],
  ]
  for (const [field, actual, expected] of comparisons) {
    const failure = compare(field, actual, expected)
    if (failure !== null) return failure
  }
  if (observed.headRefName !== receipt.branch.name) {
    return refuse("pr.headRefName", observed.headRefName, `receipt branch.name ${show(receipt.branch.name)}`)
  }
  return null
}
type ReceiptDirectoryState = "safe" | "absent" | "unsafe"

function receiptDirectoryState(directory: string): ReceiptDirectoryState {
  const chain: string[] = []
  let current = resolve(directory)
  for (;;) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.reverse()
  for (const path of chain) {
    let stat: Stats
    try {
      stat = lstatSync(path)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe"
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe"
  }
  return "safe"
}

function canonicalReceiptPath(raw: string, cwd: string, directory: string): string | CleanupFailure {
  const target = resolve(cwd, raw)
  if (dirname(target) !== directory) return refuse("receipt.path", target, `a direct entry under ${show(directory)}`)
  const directoryState = receiptDirectoryState(directory)
  if (directoryState !== "safe") {
    return refuse(
      "receipt.directory",
      `${directory} (${directoryState})`,
      "an existing path with only non-symlink directory parents",
    )
  }
  let stat: Stats
  try {
    stat = lstatSync(target)
  } catch {
    return refuse("receipt.path", target, "an existing canonical non-symlink receipt file")
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return refuse("receipt.path", target, "a canonical non-symlink regular receipt file")
  }
  return target
}

const FOREIGN_HINT =
  "a worktree of a repository other than this session's is never read from here: run delivery_cleanup from a session in that repository"

/** The refusal for a target repository other than the session's; nothing in the target was read. */
function foreignRepository(): CleanupFailure {
  return refuse(
    "worktree.owner",
    "a receipt or worktree of a repository other than this session's",
    "delivery_cleanup run from a session in that repository; a checkout of another repository is untrusted, so nothing was read or removed",
  )
}

function resolveReceipt(
  params: DeliveryCleanupParams,
  cwd: string,
  env: NodeJS.ProcessEnv,
  refReadMs: number,
  git: GitRunner | undefined,
  head?: ReceiptSelector["head"],
): ReceiptResolution {
  const key = repoKey(cwd, git, refReadMs)
  if (key === null) {
    return {
      tag: "refused",
      failure: refuse("repo.key", null, "a repository key derived from the current Git common directory"),
    }
  }
  const directory = resolve(receiptDirectory(env, key))
  let receipt: LandingReceipt | null = null
  let receiptPath: string | null = null
  if (params.receipt !== undefined) {
    // A receipt file sits in a directory named by its repository's key. One named for
    // another repository is refused here, from the path alone: nothing in that
    // repository's checkouts is read, because their config is not trusted.
    const named = basename(dirname(resolve(cwd, params.receipt)))
    if (/^[0-9a-f]{16}$/.test(named) && named !== key) return { tag: "refused", failure: foreignRepository() }
    const path = canonicalReceiptPath(params.receipt, cwd, directory)
    if (typeof path !== "string") return { tag: "refused", failure: path }
    const read = readReceipt(path)
    if (!read.ok) return { tag: "refused", failure: { ok: false, reason: read.reason } }
    receipt = read.receipt
    receiptPath = path
  } else {
    const state = receiptDirectoryState(directory)
    if (state === "unsafe") {
      return {
        tag: "refused",
        failure: refuse(
          "receipt.directory",
          `${directory} (unsafe)`,
          "an existing path with only non-symlink directory parents",
        ),
      }
    }
    const listed = state === "safe" ? listReceipts(directory) : []
    const candidates = listed.map((item) => ({ receipt: item, path: resolve(directory, `${item.receiptId}.json`) }))
    const selection = selectReceipt(
      candidates,
      { pr: params.pr, branch: params.branch, worktree: params.worktree, head },
      `repo.key ${key}`,
    )
    if (!selection.ok) {
      const hint = params.worktree === undefined ? "" : `; ${FOREIGN_HINT}`
      return { tag: "refused", failure: { ok: false, reason: `${selection.reason}${hint}` } }
    }
    receipt = selection.candidate.receipt
    receiptPath = selection.candidate.path
  }
  if (receipt === null) {
    return { tag: "refused", failure: refuse("receipt", null, "a validated receipt") }
  }
  if (receiptPath === null)
    return {
      tag: "refused",
      failure: refuse("receipt.path", null, "the canonical path for the selected validated receipt"),
    }
  if (receipt.repo.key !== key) {
    return { tag: "refused", failure: refuse("repo.key", receipt.repo.key, `current repository key ${key}`) }
  }
  if (receipt.worktree.path === null) {
    return { tag: "refused", failure: refuse("worktree.path", null, "a linked-worktree path recorded by the receipt") }
  }
  return { tag: "resolved", receipt, path: receiptPath }
}

function verifyArguments(params: DeliveryCleanupParams, receipt: LandingReceipt): CleanupFailure | null {
  const requested: readonly [string, unknown, unknown][] = [
    ["pr", params.pr, receipt.pr.number],
    ["branch", params.branch, receipt.branch.name],
    ["worktree", params.worktree, receipt.worktree.path],
    ["remote", params.remote, receipt.repo.remote],
  ]
  for (const [field, supplied, expected] of requested) {
    if (supplied === undefined) continue
    const failure = compare(field, supplied, expected)
    if (failure !== null) return failure
  }
  return null
}

async function runGit(
  run: CliRunner,
  cwd: string,
  args: string[],
  timeoutMs: number,
  pin?: GitPin,
): Promise<CliResult> {
  // A pin fixes `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` to what was verified, so
  // Git does not rediscover the repository through a `.git` marker that may have changed.
  return run(["git", ...SAFE_GIT_ARGS, ...args], {
    cwd,
    timeoutMs,
    env: { ...gitObservationEnvironment(process.env), ...pin },
  })
}

function worktreePathState(path: string): "directory" | "absent" | "unsafe" {
  let stat: Stats
  try {
    stat = lstatSync(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe"
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe"
  try {
    realpathSync(path)
    return "directory"
  } catch {
    return "unsafe"
  }
}

function dirtyPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => (line.length > 3 ? line.slice(3) : line))
    .slice(0, MAX_DIRTY_PATHS)
}

/**
 * The target is clean: no tracked change, no untracked file (ignored files are allowed),
 * no merge/rebase/cherry-pick/revert/bisect in progress, and no stash made on its branch.
 * `git status --porcelain` alone misses the last two when the tree is otherwise clean.
 */
async function verifyCleanTarget(
  path: string,
  run: CliRunner,
  timeoutMs: number,
  pin?: GitPin,
  branches: readonly string[] = [],
): Promise<CleanupFailure | null> {
  const state = worktreePathState(path)
  if (state !== "directory") return refuse("worktree.path", `${path} (${state})`, "a present non-symlink directory")
  const argv = ["status", "--porcelain"]
  const result = await runGit(run, path, argv, timeoutMs, pin)
  if (!completed(result)) return commandFailure("worktree.status", ["git", ...argv], result, "exit 0 with empty output")
  if (result.stdout !== "") {
    const all = result.stdout.split(/\r?\n/).filter(Boolean)
    return refuse(
      "worktree.status",
      { paths: dirtyPaths(result.stdout), total: all.length },
      "no dirty paths (empty porcelain output)",
    )
  }
  // The verified pin names this worktree's own git directory; no extra git read is needed.
  const gitDir = pin?.GIT_DIR
  if (gitDir === undefined) return refuse("worktree.operation", path, "a verified git directory to read operation markers from")
  const operations = operationsInProgress(
    OPERATION_MARKERS.map((marker) => marker.name).filter((name) => existsSync(resolve(gitDir, name))),
  )
  if (operations.length > 0) return refuse("worktree.operation", operations, "no merge, rebase, cherry-pick, revert or bisect in progress")
  if (branches.length > 0) {
    const stashArgv = ["stash", "list", "--format=%gs"]
    const stash = await runGit(run, path, stashArgv, timeoutMs, pin)
    if (!completed(stash)) return commandFailure("worktree.stash", ["git", ...stashArgv], stash, "exit 0")
    const entries = branches.flatMap((branch) => stashesOnBranch(stash.stdout, branch))
    if (entries.length > 0) {
      return refuse("worktree.stash", entries.slice(0, MAX_DIRTY_PATHS), `no stash entries on ${branches.map(show).join(" or ")}`)
    }
  }
  return null
}

/**
 * How the target's tip was shown to be on the forge: by an upstream it is not ahead
 * of, or — when the branch has no resolvable upstream — by the merged pull request's
 * own `headRefOid`.
 *
 * The fallback is not a weaker check. Before this runs, the target's HEAD has been
 * proved equal to the receipt's `pr.headRefOid`, and the forge has been read reporting
 * that request MERGED at that head; a commit the forge merged is on the forge. An
 * upstream goes missing for ordinary reasons — the forge deleted the branch on merge
 * and a fetch pruned it, or the branch was pushed without `-u` — and refusing there
 * left landed worktrees unremovable.
 */
export type PushProof = "upstream" | "pr-head"

async function verifyPushed(
  path: string,
  run: CliRunner,
  refReadMs: number,
  pin?: GitPin,
): Promise<CleanupFailure | PushProof> {
  const upstreamArgv = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]
  const upstream = await runGit(run, path, upstreamArgv, refReadMs, pin)
  if (upstream.error !== undefined || !upstream.ok) {
    return commandFailure("branch.upstream", ["git", ...upstreamArgv], upstream, "a completed upstream read")
  }
  if (upstream.exitCode !== 0 || upstream.stdout.trim() === "") return "pr-head"
  const countArgv = ["rev-list", "--count", "@{upstream}..HEAD"]
  const countResult = await runGit(run, path, countArgv, refReadMs, pin)
  if (!completed(countResult)) {
    return commandFailure("branch.unpushed", ["git", ...countArgv], countResult, "exit 0 and count 0")
  }
  const raw = countResult.stdout.trim()
  const count = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(count)) return refuse("branch.unpushed", raw, "a non-negative integer count")
  if (count !== 0) return refuse("branch.unpushed", count, "0 commits above the upstream")
  return "upstream"
}

function unwrapEnvelope(value: unknown): unknown {
  const root = record(value)
  if (root === null || own(root, "schema_version") === undefined) return value
  return own(root, "data")
}

/**
 * Whether the receipt's beads are closed with the landed merge sha, by the same read
 * `delivery_cleanup` makes. `open`: a bead is not closed (or lacks the sha) yet, which is
 * the one refusal that closing it fixes; `unknown`: the read or the classification failed.
 */
export async function ledgerState(
  receipt: LandingReceipt,
  cwd: string,
  receiptPath: string,
  run: CliRunner = runCli,
  timeoutMs: number = CLEANUP_BOUNDS.bdShowMs,
  refReadMs: number = CLEANUP_BOUNDS.refReadMs,
  git?: GitRunner,
): Promise<"closed" | "open" | "unknown"> {
  const failure = await verifyLedger(receipt, cwd, receiptPath, run, timeoutMs, refReadMs, git)
  if (failure === null) return "closed"
  return /^beads\.(?!ledgerActive)[^:]+:/.test(failure.reason) ? "open" : "unknown"
}

/**
 * The native close-out gate: classify the ledger at the canonical root, require the
 * receipt to agree, and then require every bead it names to be closed against this
 * merge.
 *
 * The stored boolean is never the gate on its own. A receipt is a file written by an
 * earlier call, possibly from a different directory and possibly tampered with, and
 * `beads.ledgerActive: false` read straight off it used to return success here — so
 * landing from a directory shadowed by a nested retired `.beads` and cleaning from
 * the repository whose canonical ledger is active removed the worktree and deleted
 * the branch while the authoritative bead stayed open. The classification is
 * therefore recomputed on every call, at the canonical root {@link canonicalLedger}
 * derives, and a disagreement refuses naming both values.
 *
 * A repository that cannot be classified refuses too: an unclassifiable ledger is
 * not an absent one, and the only irreversible step in this tool is on the other
 * side of this check.
 *
 * An active ledger with no bead ids is not handled here. `validateReceipt` refuses
 * that pair at the trust boundary, so a receipt read by this tool never carries it.
 */
async function verifyLedger(
  receipt: LandingReceipt,
  cwd: string,
  receiptPath: string,
  run: CliRunner,
  timeoutMs: number,
  refReadMs: number,
  git: GitRunner | undefined,
): Promise<CleanupFailure | null> {
  const classification = canonicalLedger(cwd, git, refReadMs)
  if (classification === null) {
    return refuse(
      "beads.ledgerActive",
      `no ledger classification from ${cwd}`,
      "a repository whose canonical root can be resolved, so the receipt's ledger claim can be recomputed rather than trusted",
    )
  }
  const landedSha = receipt.pr.mergeCommitOid ?? "missing"
  const nativeSteps = receipt.beads.ids.flatMap((id) => {
    const { update, close } = closeoutCommands(id, receipt.pr.number, landedSha, receiptPath)
    return [update, close]
  })
  if (classification.active !== receipt.beads.ledgerActive) {
    return {
      ok: false,
      reason: `beads.ledgerActive: observed ${receipt.beads.ledgerActive} stored in the receipt, expected ${classification.active}, recomputed at canonical root ${show(classification.root)}; ${
        classification.active
          ? `this repository's ledger is active, so for each receipt bead in child-before-parent order run ${nativeSteps.join("; ")}, then delivery_cleanup`
          : `the receipt was written against a ledger this repository does not have, so nothing was removed because the canonical ledger classification disagreed with the receipt; to recover, run delivery_land for PR #${receipt.pr.number} again${receipt.worktree.path === null ? "" : ` with worktree ${show(receipt.worktree.path)}`}, which proves the already-merged request without merging and writes a fresh receipt, then run delivery_cleanup with that new receipt`
      }`,
    }
  }
  if (!classification.active) return null
  const argv = ["bd", "show", ...receipt.beads.ids, "--json"]
  const result = await run(argv, {
    cwd,
    timeoutMs,
    env: { ...process.env, BD_JSON_ENVELOPE: "1", BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" },
  })
  if (!completed(result)) return commandFailure("beads", argv, result, "a successful read-only bd show")
  if (Buffer.byteLength(result.stdout) > MAX_CLI_JSON_BYTES) {
    return refuse("beads", `JSON over ${MAX_CLI_JSON_BYTES} bytes`, `at most ${MAX_CLI_JSON_BYTES} bytes`)
  }
  let parsed: unknown
  try {
    parsed = unwrapEnvelope(JSON.parse(result.stdout))
  } catch {
    return refuse("beads", "unparseable JSON", "an issue array from read-only bd show")
  }
  if (!Array.isArray(parsed)) return refuse("beads", parsed, "an issue array from read-only bd show")
  const rows = new Map<string, Record<string, unknown>>()
  for (const item of parsed) {
    const issue = record(item)
    const id = issue === null ? null : text(issue, "id")
    if (issue === null || id === null) return refuse("beads", item, "issues with string ids")
    const prior = rows.get(id)
    if (prior !== undefined && !isDeepStrictEqual(prior, issue)) {
      return refuse(`beads.${id}`, [prior, issue], "duplicate bd show rows for one bead id to be identical")
    }
    if (prior === undefined) rows.set(id, issue)
  }
  for (const id of receipt.beads.ids) {
    const issue = rows.get(id)
    const { update, close } = closeoutCommands(id, receipt.pr.number, landedSha, receiptPath)
    if (issue === undefined)
      return refuse(`beads.${id}`, null, `a bead returned by bd show before ${update} then ${close}`)
    const status = text(issue, "status")
    if (status !== "closed") return refuse(`beads.${id}.status`, status, `"closed" after ${update} then ${close}`)
    const metadata = record(own(issue, "metadata"))
    const mergeSha = metadata === null ? undefined : own(metadata, "merge_sha")
    if (typeof mergeSha !== "string" || mergeSha !== receipt.pr.mergeCommitOid) {
      return refuse(
        `beads.${id}.metadata.merge_sha`,
        mergeSha,
        `receipt pr.mergeCommitOid ${show(receipt.pr.mergeCommitOid)} after ${update} then ${close}`,
      )
    }
  }
  return null
}

export function parseWorktreeList(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  let current: WorktreeRecord | null = null
  for (const line of output.split("\n")) {
    if (line === "") {
      if (current !== null) records.push(current)
      current = null
      continue
    }
    if (line.startsWith("worktree ")) {
      if (current !== null) records.push(current)
      current = { path: line.slice(9), head: "", branch: null, detached: false, prunable: false }
      continue
    }
    if (current === null) continue
    if (line.startsWith("HEAD ")) current.head = line.slice(5)
    else if (line.startsWith("branch ")) current.branch = line.slice(7)
    else if (line === "detached") current.detached = true
    else if (line.startsWith("prunable")) current.prunable = true
  }
  if (current !== null) records.push(current)
  return records
}

async function readWorktrees(
  cwd: string,
  run: CliRunner,
  refReadMs: number,
  pin?: GitPin,
): Promise<WorktreeRecord[] | CleanupFailure> {
  const argv = ["worktree", "list", "--porcelain"]
  const result = await runGit(run, cwd, argv, refReadMs, pin)
  if (!completed(result)) return commandFailure("worktree.list", ["git", ...argv], result, "exit 0 porcelain records")
  const records = parseWorktreeList(result.stdout)
  if (records.length === 0) return refuse("worktree.list", [], "at least the repository's main worktree")
  const malformed = records.find((item) => item.path === "" || !isAbsolute(item.path))
  if (malformed !== undefined)
    return refuse("worktree.list.path", malformed.path, "a non-empty absolute path in every record")
  return records
}

/**
 * Whether `path` is provably a checkout of another repository than the session's.
 * A path the session repository itself lists is never foreign. The proof is only used
 * to choose the refusal; what lets Git run in a target is that the session lists it.
 */
async function isForeignCheckout(
  path: string,
  cwd: string,
  records: readonly WorktreeRecord[],
  run: CliRunner,
  refReadMs: number,
): Promise<boolean> {
  const real = physicalPath(path)
  if (real !== null && recordForTarget([...records], real) !== null) return false
  const argv = ["rev-parse", "--path-format=absolute", "--git-common-dir"]
  const result = await runGit(run, cwd, argv, refReadMs)
  const session = completed(result) ? physicalPath(result.stdout.trim()) : null
  return session !== null && ["foreign", "unsafe"].includes(inspectCheckoutMarker(path, session))
}

function physicalPath(path: string): string | null {
  return physical(path)
}

/**
 * Whether this call was made from inside the worktree it would remove.
 *
 * `git worktree remove` aimed at the caller's own directory leaves the process
 * standing in a deleted path, and every absence check after that point is then
 * answered from somewhere that no longer exists — so the removal is both the
 * destruction and the loss of its own proof. Comparison is by realpath and by
 * containment: a subdirectory of the target is inside the target, and a symlinked
 * alias of either resolves to the same place.
 *
 * A path that does not resolve is not treated as inside: the later listing and
 * directory checks refuse an unresolvable target by name, and guessing here would
 * hide that refusal behind a less specific one.
 */
function invocationInsideTarget(cwd: string, target: string): boolean {
  const invocation = physicalPath(cwd)
  const resolved = physicalPath(target)
  if (invocation === null || resolved === null) return false
  return invocation === resolved || invocation.startsWith(`${resolved}${sep}`)
}

/** The registered record whose physical path is `expected`, which the caller has already resolved once. */
function recordForTarget(records: WorktreeRecord[], expected: string): WorktreeRecord | null {
  for (const item of records) {
    if (physicalPath(item.path) === expected) return item
  }
  return null
}

function storedRecordForTarget(records: WorktreeRecord[], target: string): WorktreeRecord | null {
  const expected = resolve(target)
  for (const item of records) {
    if (resolve(item.path) === expected) return item
  }
  return null
}

async function verifyTargetIdentity(
  receipt: LandingReceipt,
  cwd: string,
  run: CliRunner,
  refReadMs: number,
  git: GitRunner | undefined,
): Promise<TargetIdentity | CleanupFailure> {
  const path = receipt.worktree.path as string
  const listed = await readWorktrees(cwd, run, refReadMs)
  if (!Array.isArray(listed)) return listed
  const main = listed[0]
  if (main === undefined) return refuse("worktree.list", [], "a main worktree record")
  // The caller's path is resolved exactly once. Registration matching, the marker reads,
  // the pin and every later command use this physical path and never the spelling the
  // receipt gave, so a parent directory that is a symlink switched between steps cannot
  // make them look at different trees. The path must equal a registered worktree path.
  const physicalTarget = physicalPath(path)
  if (physicalTarget === null) return refuse("worktree.path", path, "an exact live record in git worktree list --porcelain")
  if (physicalTarget === physicalPath(main.path))
    return refuse("worktree.path", path, `a linked worktree other than main ${show(main.path)}`)
  const target = recordForTarget(listed, physicalTarget)
  if (target === null && (await isForeignCheckout(path, cwd, listed, run, refReadMs)))
    return refuse("worktree.path", path, "a worktree in the current repository")
  if (target === null || target.prunable)
    return refuse("worktree.path", path, "an exact live record in git worktree list --porcelain")
  // The registration is the session repository's, but the directory behind it is
  // whatever is on disk now: a replaced checkout, or a `.git` link into another
  // repository, would make the Git commands below run in code this repository does
  // not own. Nothing runs in the target until its marker provably belongs here.
  const common = repositoryContext(cwd, git, refReadMs)?.commonDir ?? null
  const verdict = common === null ? ({ state: "unsafe" } as const) : verifyCheckout(physicalTarget, common)
  if (verdict.state !== "same" || common === null) {
    return refuse(
      "worktree.marker",
      `${path} (.git ${verdict.state})`,
      "a regular .git file naming a directory under this repository's worktrees/ whose commondir is this repository; nothing was read in the worktree",
    )
  }
  const accepted = acceptWorktree(target, receipt)
  if (!accepted.ok) return accepted
  // A receipt path whose last component is itself a link is refused as before; the check
  // only refuses, nothing after it uses the caller's spelling.
  if (worktreePathState(physicalTarget) !== "directory" || worktreePathState(path) !== "directory") {
    return refuse("worktree.path", `${path} (unsafe)`, "the listed non-symlink directory")
  }
  return { records: listed, target, main, common, pin: verdict.pin, cwd: physicalTarget }
}

/**
 * Reads the receipt branch's local ref. A ref that is gone is not a failure (the branch may have
 * been deleted or renamed away); a ref that cannot be read is.
 */
async function verifyLocalRef(
  receipt: LandingReceipt,
  cwd: string,
  run: CliRunner,
  refReadMs: number,
  pin?: GitPin,
): Promise<CleanupFailure | LocalRefPlan> {
  const presence = await localRefAbsence(cwd, receipt.branch.name, run, refReadMs, pin)
  if (presence === "unknown") return refuse("branch.localRef", "unreadable", "a readable local ref state")
  if (presence === "absent") return planLocalRef(null, receipt.pr.headRefOid)
  const ref = `${LOCAL_REF_PREFIX}${receipt.branch.name}`
  const argv = ["rev-parse", "--verify", ref]
  const result = await runGit(run, cwd, argv, refReadMs, pin)
  if (!completed(result))
    return commandFailure("branch.localRef", ["git", ...argv], result, `exit 0 and oid ${receipt.pr.headRefOid}`)
  return planLocalRef(result.stdout.trim(), receipt.pr.headRefOid)
}

async function revalidateBoundary(
  receipt: LandingReceipt,
  cwd: string,
  run: CliRunner,
  bounds: CleanupBounds,
  git: GitRunner | undefined,
): Promise<TargetIdentity | CleanupFailure> {
  const identity = await verifyTargetIdentity(receipt, cwd, run, bounds.refReadMs, git)
  if (isFailure(identity)) return identity
  const ref = await verifyLocalRef(receipt, cwd, run, bounds.refReadMs)
  if (isFailure(ref)) return ref
  const clean = await verifyCleanTarget(identity.cwd, run, bounds.treeScanMs, identity.pin, stashBranches(receipt.branch.name, identity.target))
  if (clean !== null) return clean
  const pushed = await verifyPushed(identity.cwd, run, bounds.refReadMs, identity.pin)
  return isFailure(pushed) ? pushed : identity
}

async function registrationAbsence(
  cwd: string,
  trustedPath: string,
  run: CliRunner,
  refReadMs: number,
  pin?: GitPin,
): Promise<Absence> {
  const listed = await readWorktrees(cwd, run, refReadMs, pin)
  if (!Array.isArray(listed)) return "unknown"
  return storedRecordForTarget(listed, trustedPath) === null ? "absent" : "present"
}

function pathAbsence(path: string): Absence {
  try {
    lstatSync(path)
    return "present"
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"
  }
}

async function localRefAbsence(
  cwd: string,
  branch: string,
  run: CliRunner,
  refReadMs: number,
  pin?: GitPin,
): Promise<Absence> {
  const argv = ["show-ref", "--verify", "--quiet", `${LOCAL_REF_PREFIX}${branch}`]
  const result = await runGit(run, cwd, argv, refReadMs, pin)
  if (result.error !== undefined || !result.ok) return "unknown"
  if (result.exitCode === 0) return "present"
  if (result.exitCode === 1 && result.stdout === "" && result.stderr === "") return "absent"
  return "unknown"
}

function safeExecutionCwd(receipt: LandingReceipt, records: WorktreeRecord[], invocationCwd: string): string | null {
  const target = physicalPath(receipt.worktree.path as string)
  const preferred = records.find(
    (item) => item.branch === `${LOCAL_REF_PREFIX}${receipt.pr.baseRefName}` && physicalPath(item.path) !== target,
  )
  if (preferred !== undefined && worktreePathState(preferred.path) === "directory") return preferred.path
  const invocation = records.find(
    (item) => physicalPath(item.path) === physicalPath(invocationCwd) && physicalPath(item.path) !== target,
  )
  if (invocation !== undefined && worktreePathState(invocation.path) === "directory") return invocation.path
  const main = records[0]
  return main !== undefined && physicalPath(main.path) !== target && worktreePathState(main.path) === "directory"
    ? main.path
    : null
}

function nextReceiptEpoch(receipt: LandingReceipt, now: () => number): number {
  const observed = Math.trunc(now())
  const prior = Date.parse(receipt.emittedAt)
  return Math.max(observed, Number.isFinite(prior) ? prior + 1 : observed)
}
export function branchDeleteArgs(branch: string): string[] {
  return ["branch", "-d", "--", branch]
}

/**
 * Remove a landed pull request's worktree and local branch. A `repo` that names the
 * session's repository changes nothing. A `repo` of another repository is verified
 * (its clone, named by `repoPath` or `worktree`, must have a remote naming it) and then
 * refused with {@link foreignCleanupReason}: that cleanup runs from a session there.
 */
export async function cleanupDelivery(
  params: DeliveryCleanupParams,
  sessionCwd: string,
  deps: CleanupDeps = {},
): Promise<CleanupResult> {
  const { repo, repoPath, ...rest } = params
  if (repo === undefined && repoPath === undefined) return cleanupInRepository(rest, sessionCwd, deps)
  const refReadMs = { ...CLEANUP_BOUNDS, ...deps.bounds }.refReadMs
  const run: CliRunner = (argv, options) => (deps.run ?? runCli)(argv, { ...options, signal: deps.signal })
  const read: GitReadAt = async (at, argv) => {
    const result = await runGit(run, at, [...argv], refReadMs)
    return completed(result) ? result.stdout : null
  }
  const target = await retargetRepository({ repo, repoPath, worktree: rest.worktree }, sessionCwd, read)
  if ("reason" in target) return { ok: false, reason: target.reason }
  if (target.retargeted) return { ok: false, reason: foreignCleanupReason(repo ?? "", target.cwd) }
  return cleanupInRepository(rest, target.cwd, deps)
}

/**
 * Why cleanup of another repository's landing is refused from this session. Lane claims,
 * holds, denials, the removal lock and the bead ledger it must respect all belong to
 * that repository, and this session reads only its own; removing from here could take
 * a worktree another agent in that repository still owns.
 */
export function foreignCleanupReason(repo: string, root: string): string {
  return `repo: observed ${JSON.stringify(repo.trim())}, a repository other than this session's; its lane claims, holds and bead ledger are not visible from here, so run delivery_cleanup from a session in ${root}; nothing was removed`
}

async function cleanupInRepository(
  params: Omit<DeliveryCleanupParams, "repo" | "repoPath">,
  cwd: string,
  deps: CleanupDeps,
): Promise<CleanupResult> {
  const { signal } = deps
  const bounds: CleanupBounds = { ...CLEANUP_BOUNDS, ...deps.bounds }
  // `commit` runs the removal and everything after it; `run` carries the signal, so an
  // interrupt ends whichever read is running and keeps the next one from starting.
  const commit = deps.run ?? runCli
  const run: CliRunner = (argv, options) => commit(argv, { ...options, signal })
  const now = deps.now ?? Date.now
  const env = deps.env ?? process.env
  // A target of another repository is refused from the session repository's own
  // worktree list and plain filesystem reads, before any Git process touches it. It is
  // only looked for when the selectors have already failed to name a receipt of this
  // repository, so an ordinary cleanup pays no extra read.
  // The HEAD of the worktree the caller named, from the session repository's own list, to tell
  // apart receipts that the other selectors leave ambiguous. Read only when it can matter.
  const worktreeHead = async (): Promise<ReceiptSelector["head"]> => {
    if (params.receipt !== undefined || params.worktree === undefined || params.worktree.trim() === "") return undefined
    const listed = await readWorktrees(cwd, run, bounds.refReadMs)
    if (!Array.isArray(listed)) return undefined
    const record = storedRecordForTarget(listed, resolve(cwd, params.worktree.trim()))
    if (record === null) return undefined
    const branch = record.detached || record.branch === null ? null : record.branch.slice(LOCAL_REF_PREFIX.length)
    return { branch, oid: record.head }
  }
  const foreignWorktree = async (): Promise<boolean> => {
    if (params.worktree === undefined || params.worktree.trim() === "") return false
    const listed = await readWorktrees(cwd, run, bounds.refReadMs)
    return (
      Array.isArray(listed) &&
      (await isForeignCheckout(resolve(cwd, params.worktree.trim()), cwd, listed, run, bounds.refReadMs))
    )
  }
  // A worktree that is already gone (cleaned before, or removed by hand) has nothing left to remove.
  // Success without a receipt write, because no proof was made now and a repeat must change nothing.
  const alreadyCleaned = async (receipt: LandingReceipt, receiptPath: string): Promise<CleanupSuccess | null> => {
    const target = receipt.worktree.path as string
    let note: string | null = null
    if (receipt.worktree.removed) note = `worktree ${target} was already cleaned by an earlier call`
    else if (pathAbsence(target) === "absent") {
      const listed = await readWorktrees(cwd, run, bounds.refReadMs)
      if (Array.isArray(listed) && storedRecordForTarget(listed, target) === null) {
        note = `worktree ${target} is already gone (neither on disk nor registered); nothing was removed and the landing receipt is unchanged`
      }
    }
    if (note === null) return null
    return {
      ok: true,
      receipt,
      path: receiptPath,
      remoteBranchAbsence: receipt.branch.deletedRemote ? "absent" : "unknown",
      alreadyCleaned: true,
      localRefDeleted: false,
      report: { removed: [], skipped: [note] },
    }
  }
  const resolution = resolveReceipt(params, cwd, env, bounds.refReadMs, deps.git, await worktreeHead())
  if (resolution.tag === "refused") return (await foreignWorktree()) ? foreignRepository() : resolution.failure
  const receipt = resolution.receipt

  const argsFailure = verifyArguments(params, receipt)
  if (argsFailure !== null) return (await foreignWorktree()) ? foreignRepository() : argsFailure
  const gone = await alreadyCleaned(receipt, resolution.path)
  if (gone !== null) return gone
  if (typeof receipt.pr.mergeCommitOid !== "string" || receipt.pr.mergeCommitOid.trim() === "") {
    return refuse("pr.mergeCommitOid", receipt.pr.mergeCommitOid, "a non-empty merge commit oid before cleanup")
  }
  // Before any observation, and long before the irreversible step: a call from inside
  // its own target can neither remove it safely nor verify the removal afterwards.
  if (invocationInsideTarget(cwd, receipt.worktree.path as string)) {
    return refuse(
      "worktree.invocationCwd",
      cwd,
      `a directory outside the worktree this call would remove (${receipt.worktree.path}, resolved to ${physicalPath(receipt.worktree.path as string)})`,
    )
  }
  // The target's identity is proved before the pull request is read, because the read
  // has to be made from inside the target. With `extensions.worktreeConfig`, a
  // `url.<other>.insteadOf` rewrite is worktree-scoped, and `git remote get-url`
  // expands those rewrites: the same remote name resolves to one repository in the
  // landed worktree and another here. The URL the landing recorded is the one its own
  // worktree resolves, so resolving it anywhere else refuses a valid receipt and
  // leaves that worktree permanently unremovable.
  //
  // This is a read: `git worktree list --porcelain` and one `lstat`. It proves the
  // path is a live, listed, non-symlink linked worktree of this repository on the
  // receipt's branch and head before it is used as a directory to run a command in,
  // and `revalidateBoundary` proves the same identity again immediately before the
  // irreversible step.
  const identity = await verifyTargetIdentity(receipt, cwd, run, bounds.refReadMs, deps.git)
  if (isFailure(identity)) return identity
  const observed = await observePullRequest(receipt, run, identity.cwd, env, bounds.refReadMs, identity.pin)
  if (isFailure(observed)) return observed
  const observedFailure = verifyObservation(receipt, observed.pr)
  if (observedFailure !== null) return observedFailure
  const path = receipt.worktree.path as string
  const dirty = await verifyCleanTarget(identity.cwd, run, bounds.treeScanMs, identity.pin, stashBranches(receipt.branch.name, identity.target))
  if (dirty !== null) return dirty
  const pushed = await verifyPushed(identity.cwd, run, bounds.refReadMs, identity.pin)
  if (isFailure(pushed)) return pushed
  const ledger = await verifyLedger(receipt, cwd, resolution.path, run, bounds.bdShowMs, bounds.refReadMs, deps.git)
  if (ledger !== null) return ledger

  // The prompt (if any) comes first and outside the critical section: a held lock must never wait on a person.
  await deps.authorize?.({ worktree: path, branch: receipt.branch.name, pr: receipt.pr.number })
  const removeSection = async (): Promise<CleanupFailure | RemovalFacts> => {
    const localRef = await verifyLocalRef(receipt, cwd, run, bounds.refReadMs)
    if (isFailure(localRef)) return localRef
    const boundary = await revalidateBoundary(receipt, cwd, run, bounds, deps.git)
    if (isFailure(boundary)) return boundary

    const executionCwd = safeExecutionCwd(receipt, boundary.records, cwd)
    if (executionCwd === null)
      return refuse("worktree.executionCwd", null, "a different listed worktree for the same repository")
    // The directory the removal and the branch deletion run from is pinned the same way,
    // so a marker swapped after this point cannot redirect them either.
    const executionDir = physicalPath(executionCwd)
    const executionVerdict = executionDir === null ? ({ state: "absent" } as const) : verifyCheckout(executionDir, boundary.common)
    if (executionDir === null || executionVerdict.state !== "same")
      return refuse("worktree.executionCwd", `${executionCwd} (.git ${executionVerdict.state})`, "a verified worktree of this repository")
    const executionPin = executionVerdict.pin
    const targetPath = boundary.target.path
    const removeArgv = ["worktree", "remove", targetPath]
    // Ownership is decided before the last abort check, so an interrupt during the
    // listing still stops the call. A host that is present but cannot list leaves the
    // owner unknown; removing with git could strand its registry entry, so refuse.
    let route: "host" | "git" = "git"
    if (deps.host !== undefined) {
      try {
        route = removalRoute(await deps.host.list(), targetPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return refuse(
          "worktree.owner",
          `host worktree.list failed (${message.trim().slice(0, 400)})`,
          "a readable OpenCode worktree registry; nothing was removed, so retry delivery_cleanup once the host responds",
        )
      }
    }
    // The last point an interrupt is honoured. Past it the removal runs to completion or
    // to its bound, and the steps after it record what happened instead of stopping
    // with the worktree gone and no continuation receipt.
    if (signal?.aborted === true)
      return refuse("signal", "an abort", "no interrupt before the worktree removal; nothing was removed")
    const held = await deps.finalCheck?.(targetPath)
    if (held !== undefined) {
      return refuse("worktree.held", held, "no owner, hold, denial or competing remover at the moment of removal; nothing was removed")
    }
    // An interrupt that arrived during the final lookup still stops the call; once the removal starts, nothing does.
    if ((signal as AbortSignal | undefined)?.aborted === true)
      return refuse("signal", "an abort", "no interrupt before the worktree removal; nothing was removed")
    if (route === "host" && deps.host !== undefined) {
      try {
        await deps.host.remove(targetPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return refuse(
          "worktree.removed",
          `host worktree.remove ${JSON.stringify(targetPath)} (error ${message.trim().slice(0, 400)})`,
          "host removal without force",
        )
      }
    } else {
      const removed = await runGit(commit, executionDir, removeArgv, bounds.mutationMs, executionPin)
      if (!completed(removed)) {
        return commandFailure("worktree.removed", ["git", ...removeArgv], removed, "exit 0 without --force")
      }
    }

    const registration = await registrationAbsence(executionDir, targetPath, commit, bounds.refReadMs, executionPin)
    const pathGone = pathAbsence(targetPath)
    if (registration !== "absent") return refuse("worktree.registrationAbsence", registration, '"absent" after removal')
    if (pathGone !== "absent") return refuse("worktree.pathAbsence", pathGone, '"absent" after removal')

    const refAfterWorktree = await verifyLocalRef(receipt, executionDir, commit, bounds.refReadMs, executionPin)
    if (isFailure(refAfterWorktree)) return refAfterWorktree
    // A ref that was at the reviewed head before the removal and is not now was moved by someone else.
    if (localRef === "delete" && refAfterWorktree !== "delete") {
      return refuse("branch.localRef", refAfterWorktree, `a ref still at ${receipt.pr.headRefOid}, as before the removal`)
    }
    // Only a ref still at the reviewed head is deleted; one that is gone or has moved is left as found.
    if (refAfterWorktree === "delete") {
      const deleteArgv = branchDeleteArgs(receipt.branch.name)
      const deleted = await runGit(commit, executionDir, deleteArgv, bounds.mutationMs, executionPin)
      if (!completed(deleted)) {
        return commandFailure("worktree.localRefDeleted", ["git", ...deleteArgv], deleted, "exit 0 without -D")
      }
    }
    const localAbsence = await localRefAbsence(executionDir, receipt.branch.name, commit, bounds.refReadMs, executionPin)
    // The last probe must give a definite answer that matches the plan: absent after a deletion or
    // when the ref was gone, present when it was left because it moved. An unknown answer never passes.
    const expected: Absence = refAfterWorktree === "moved" ? "present" : "absent"
    if (localAbsence !== expected) {
      return refuse("worktree.localRefAbsence", localAbsence, `"${expected}" (ref plan ${refAfterWorktree})`)
    }

    return { ok: true, registration, pathGone, localAbsence, localRefPlan: refAfterWorktree, executionDir }
  }
  const section = deps.removalSection === undefined ? await removeSection() : await deps.removalSection(path, removeSection)
  if (isFailure(section)) return section
  const { registration, pathGone, localAbsence, localRefPlan, executionDir } = section

  // The probe is given the URL the target resolved, not `repo.remote`. A name is
  // re-resolved wherever it is asked, and by now the target is gone, so the question
  // would be answered through a surviving worktree's configuration: one
  // worktree-scoped `insteadOf` there and `git ls-remote` asks a different repository,
  // whose exit 2 would be recorded as verified absence of a branch that still exists.
  // A false absence is the one verdict this tool must never invent, so the probe
  // contacts exactly what Git contacted when the identity was resolved. `cwd` is still
  // a surviving worktree: Git needs a repository for the protocol and helper pins the
  // adapter puts on this read. The verdict comes back as a word, so the URL cannot
  // reach the receipt or a refusal.
  //
  // GitHub is asked through the forge API instead, for the repository the identity bound:
  // the Git probe is pinned to plain `ssh`, which cannot reach a remote whose routing lives
  // in `core.sshCommand` (#248), and the API names the repository rather than a URL a
  // worktree's config could rewrite.
  const remoteAbsence =
    observed.identity.forge === "github"
      ? (await observeGithubBranch(observed.identity.nameWithOwner, receipt.branch.name, commit, env)).verdict
      : await remoteBranchAbsent(observed.identity.remoteUrl, receipt.branch.name, executionDir, commit)
  const issuedAt = nextReceiptEpoch(receipt, now)
  const verifiedAt = new Date(issuedAt).toISOString()
  const continued = buildReceipt({
    now: issuedAt,
    continues: receipt,
    emitter: { plugin: pkg.name, version: pkg.version, tool: "delivery_cleanup" },
    repo: receipt.repo,
    pr: {
      number: observed.pr.number,
      url: observed.pr.url,
      state: observed.pr.state,
      baseRefName: observed.pr.baseRefName,
      headRefName: observed.pr.headRefName,
      headRefOid: observed.pr.headRefOid,
      mergeCommitOid: observed.pr.mergeCommitOid,
      mergedAt: observed.pr.mergedAt,
    },
    branch: {
      name: receipt.branch.name,
      deletedRemote: remoteAbsence === "absent",
      remoteAbsenceVerifiedAt: remoteAbsence === "absent" ? verifiedAt : null,
      autoDeleteSetting: receipt.branch.autoDeleteSetting,
    },
    worktree: {
      path,
      removed: true,
      localRefDeleted: localAbsence === "absent",
      absenceVerifiedAt: verifiedAt,
    },
    beads: receipt.beads,
    proof: {
      // The same field means the same thing on every receipt: the provider CLI and
      // verb that observed this landing. What this call added — four independent
      // absence verdicts — is the evidence, and `emitter.tool` names who verified it.
      method: observed.pr.method,
      observedAt: verifiedAt,
      evidence: {
        worktreeRegistration: registration,
        worktreePath: pathGone,
        localRef: localAbsence,
        remoteBranch: remoteAbsence,
        pushed,
      },
    },
    outcome: "cleaned",
    notes: remoteAbsence === "absent" ? undefined : `remote branch absence observed ${remoteAbsence}`,
  })
  const validation = validateReceipt(continued)
  if (!validation.ok) return { ok: false, reason: `continuation receipt: ${validation.reason}` }
  let written: string
  try {
    written = writeReceipt(continued, receiptDirectory(env, continued.repo.key))
  } catch (error) {
    return refuse(
      "continuation receipt write",
      error instanceof Error ? error.message : String(error),
      "one persisted validated receipt",
    )
  }
  return {
    ok: true,
    receipt: continued,
    path: written,
    remoteBranchAbsence: remoteAbsence,
    alreadyCleaned: false,
    localRefDeleted: localRefPlan === "delete",
    report: removalReport(receipt, path, identity.target, localRefPlan),
  }
}
