/**
 * GitHub merge queue support for `delivery_land`.
 *
 * A base branch whose rules include `merge_queue` takes no direct merge: `gh pr merge`
 * would add the pull request to the queue (or, with `--auto`, wait for it), so landing
 * there means enqueuing the reviewed head and waiting for GitHub to merge it. This module
 * holds the parts of that which are decisions rather than orchestration:
 *
 * - {@link queueRuleFrom} reads the branch's active rules (`GET /repos/{o}/{r}/rules/branches/{b}`)
 *   and says whether the queue is required and which method it lands with.
 * - {@link enqueueArgv} builds the `enqueuePullRequest` mutation bound to `expectedHeadOid`,
 *   which GitHub refuses when the head is anything else.
 * - {@link parseSnapshot} and {@link decideQueue} turn one read of the pull request and its
 *   `mergeQueueEntry` into a verdict: merged, still waiting, or refused.
 * - {@link awaitQueue} polls with a bounded, backed-off wait and reports a non-final
 *   `pending` result when the budget runs out, so a later call can resume.
 *
 * Nothing here merges by any other means: a dequeued pull request is a refusal.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type CliRunner, FORGE_TIMEOUT_MS, MERGE_METHODS, type MergeMethod } from "./forge-adapter.ts"

/** The default wait for the queue to merge an entry, in seconds. */
export const DEFAULT_QUEUE_WAIT_SECONDS = 600
/** The largest wait one call may ask for, in seconds. */
export const MAX_QUEUE_WAIT_SECONDS = 3600
/** Delays between polls double from the first and stop growing at the last. */
const FIRST_POLL_DELAY_MS = 5_000
const MAX_POLL_DELAY_MS = 60_000
/** An open pull request must be seen without an entry this many polls in a row to count as removed. */
const ABSENCES_BEFORE_REMOVED = 2
/** The page size of the rules read; a full page may hide a rule, so it is not trusted. */
const RULES_PAGE = 100

/** A Map, not an object: a payload's `"constructor"` must never resolve through a prototype. */
const QUEUE_METHODS: ReadonlyMap<string, MergeMethod> = new Map<string, MergeMethod>([
  ["MERGE", "merge"],
  ["SQUASH", "squash"],
  ["REBASE", "rebase"],
])

/** An own, enumerable data property; a forge payload is untrusted, so no prototype read. */
function own(holder: unknown, key: string): unknown {
  if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(holder, key)
  return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined
}

function text(holder: unknown, key: string): string | null {
  const value = own(holder, key)
  return typeof value === "string" ? value : null
}

/** The argv that lists the active rules that apply to `branch`. */
export function rulesArgv(repoPath: string, branch: string): string[] {
  return ["gh", "api", `repos/${repoPath}/rules/branches/${encodeURIComponent(branch)}?per_page=${RULES_PAGE}`]
}

export type QueueRule = { required: false } | { required: true; method: MergeMethod }

/**
 * Whether the rules payload requires a merge queue, and the method it lands with.
 *
 * A payload that is not a rule array, or that fills a whole page, is refused rather than read
 * as "no queue": treating an unreadable answer as "direct merge allowed" is the failure this
 * detection exists to prevent.
 */
export function queueRuleFrom(payload: unknown): QueueRule | { reason: string } {
  if (!Array.isArray(payload)) return { reason: "rules: observed a payload that is not an array of rules" }
  if (payload.length >= RULES_PAGE) {
    return { reason: `rules: observed ${payload.length} rules, a full page; the merge queue rule cannot be ruled out` }
  }
  // A rule this code cannot read is not "no queue": a response with a malformed element
  // is refused whole, so it can never fall through to a direct merge.
  for (const [index, rule] of payload.entries()) {
    if (text(rule, "type") === null) {
      return { reason: `rules: observed element ${index} without a string type, expected an object with a type` }
    }
  }
  const queue = payload.find((rule) => text(rule, "type") === "merge_queue")
  if (queue === undefined) return { required: false }
  const raw = text(own(queue, "parameters"), "merge_method")
  const method = raw === null ? undefined : QUEUE_METHODS.get(raw)
  if (method === undefined) {
    return {
      reason: `rules: observed merge_queue merge_method ${JSON.stringify(raw)}, expected MERGE, SQUASH or REBASE`,
    }
  }
  return { required: true, method }
}

const NO_QUEUE_QUERY = `query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { nameWithOwner mergeQueue(branch: $branch) { id } } }`

/** The argv that asks GraphQL for the merge queue of `branch`; the answer is null when it has none. */
export function mergeQueueArgv(repoPath: string, branch: string): string[] {
  const [owner = "", name = ""] = repoPath.split("/")
  return ["gh", "api", "graphql", "-f", `query=${NO_QUEUE_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `branch=${branch}`]
}

/** The argv that lists the repository's rulesets, which proves the caller may read them. */
export function rulesetsArgv(repoPath: string): string[] {
  return ["gh", "api", `repos/${repoPath}/rulesets?per_page=${RULES_PAGE}`]
}

function succeeded(result: Awaited<ReturnType<CliRunner>>): boolean {
  return result.ok && result.exitCode === 0 && result.error === undefined
}

/**
 * Whether two rule-specific signals both say the branch has no merge queue, or why not.
 *
 * A 404 from the branch rules read does not say that: it is also what a caller without
 * access sees, and a readable repository does not prove the absence of branch rules. So
 * the repository's `mergeQueue(branch:)` must read back as an explicit null, and its
 * rulesets list must be readable (the same permission the rules read needed); either
 * failing refuses.
 */
async function noQueueConfirmed(
  run: CliRunner,
  repoPath: string,
  branch: string,
  env: Readonly<Record<string, string>>,
): Promise<string | null> {
  const graphql = mergeQueueArgv(repoPath, branch)
  const queue = await run(graphql, { timeoutMs: FORGE_TIMEOUT_MS, env })
  if (!succeeded(queue)) return `gh api graphql (mergeQueue of ${branch}) observed ${queue.error ?? `exit ${queue.exitCode}`}, expected exit 0`
  let payload: unknown
  try {
    payload = JSON.parse(queue.stdout)
  } catch {
    return "gh api graphql (mergeQueue): observed unparseable output, expected one JSON object"
  }
  const errors = graphqlErrors(payload)
  if (errors !== null) return errors
  const repository = own(own(payload, "data"), "repository")
  if (text(repository, "nameWithOwner")?.toLowerCase() !== repoPath.toLowerCase()) {
    return `gh api graphql (mergeQueue): observed repository ${JSON.stringify(text(repository, "nameWithOwner"))}, expected ${JSON.stringify(repoPath)}`
  }
  const field = typeof repository === "object" && repository !== null ? Object.getOwnPropertyDescriptor(repository, "mergeQueue") : undefined
  if (field === undefined || !("value" in field) || field.value !== null) {
    return "gh api graphql (mergeQueue): observed a merge queue or no mergeQueue field, expected an explicit null"
  }
  const rulesets = rulesetsArgv(repoPath)
  const listed = await run(rulesets, { timeoutMs: FORGE_TIMEOUT_MS, env })
  if (!succeeded(listed)) return `${rulesets.join(" ")}: observed ${listed.error ?? `exit ${listed.exitCode}`}, expected a readable rulesets list`
  try {
    if (!Array.isArray(JSON.parse(listed.stdout))) return `${rulesets.join(" ")}: observed a payload that is not an array`
  } catch {
    return `${rulesets.join(" ")}: observed unparseable output, expected a JSON array`
  }
  return null
}

/**
 * Read the branch's active rules and say whether it requires a merge queue.
 *
 * GitHub answers `200 []` for a branch with no rules. A 404 is ambiguous (no access, or no
 * such repository), so it counts as "no queue rule" only when {@link noQueueConfirmed} finds
 * a second, rule-specific signal; every other failure refuses.
 */
export async function readQueueRule(
  run: CliRunner,
  repoPath: string,
  branch: string,
  env: Readonly<Record<string, string>>,
): Promise<QueueRule | { reason: string }> {
  const argv = rulesArgv(repoPath, branch)
  const result = await run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env })
  if (!result.ok || result.exitCode !== 0 || result.error !== undefined) {
    const detail = `${argv.join(" ")}: observed ${result.error ?? `exit ${result.exitCode}`}, expected exit 0 to learn whether the branch requires a merge queue; ${result.stderr.trim().slice(0, 300)}`
    if (result.error === undefined && /\b404\b|not found/i.test(result.stderr)) {
      const unconfirmed = await noQueueConfirmed(run, repoPath, branch, env)
      return unconfirmed === null
        ? { required: false }
        : {
            reason: `${detail}; the 404 is not taken as "no merge queue" because ${unconfirmed}. Check that the gh token may read branch rules (repository administration read access), or land through the GitHub UI`,
          }
    }
    return { reason: detail }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { reason: `${argv.join(" ")}: observed unparseable output, expected a JSON array of rules` }
  }
  return queueRuleFrom(parsed)
}

// `headCommit` is deliberately not read: it is the queue's own integration commit, never the
// pull request's head, so nothing about review identity can be derived from it.
const ENTRY_FIELDS = "state position"

const STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { nameWithOwner pullRequest(number: $number) { id number baseRefName state headRefOid mergeQueueEntry { ${ENTRY_FIELDS} } } } }`

const ENQUEUE_MUTATION = `mutation($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { ${ENTRY_FIELDS} } } }`

/** The argv that reads the pull request's state and queue entry. */
export function stateArgv(owner: string, name: string, number: string): string[] {
  return [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${STATE_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]
}

/** The argv that enqueues the pull request; GitHub refuses it unless the head is `head`. */
export function enqueueArgv(pullRequestId: string, head: string): string[] {
  return ["gh", "api", "graphql", "-f", `query=${ENQUEUE_MUTATION}`, "-f", `id=${pullRequestId}`, "-f", `head=${head}`]
}

export type QueueEntry = { state: string; position: number | null }

/** One observation of the pull request: its state, its head, and its queue entry if any. */
export type QueueSnapshot = {
  id: string
  repository: string
  number: number
  baseRefName: string
  state: string
  headRefOid: string
  entry: QueueEntry | null
}

function entryFrom(value: unknown): QueueEntry | null {
  const state = text(value, "state")
  if (state === null) return null
  const position = own(value, "position")
  return { state, position: typeof position === "number" ? position : null }
}

/** The GraphQL `errors` of a response as a refusal reason, or null when there are none. */
export function graphqlErrors(payload: unknown): string | null {
  const errors = own(payload, "errors")
  return Array.isArray(errors) && errors.length > 0
    ? `graphql: observed errors ${JSON.stringify(errors).slice(0, 300)}`
    : null
}

/** The queue entry an enqueue mutation reports, or null when the response names none. */
export function enqueuedEntry(payload: unknown): QueueEntry | null {
  return entryFrom(own(own(own(payload, "data"), "enqueuePullRequest"), "mergeQueueEntry"))
}

/** Read a `stateArgv` response; refuses a payload that names no pull request. */
export function parseSnapshot(payload: unknown): QueueSnapshot | { reason: string } {
  const errors = graphqlErrors(payload)
  if (errors !== null) return { reason: errors }
  const repository = own(own(payload, "data"), "repository")
  const pr = own(repository, "pullRequest")
  const name = text(repository, "nameWithOwner")
  const number = own(pr, "number")
  const base = text(pr, "baseRefName")
  const id = text(pr, "id")
  const state = text(pr, "state")
  const head = text(pr, "headRefOid")
  if (id === null || state === null || head === null || name === null || base === null || typeof number !== "number") {
    return {
      reason:
        "graphql: observed no pull request with repository, id, number, baseRefName, state and headRefOid, expected one",
    }
  }
  return {
    id,
    repository: name,
    number,
    baseRefName: base,
    state: state.toUpperCase(),
    headRefOid: head.toLowerCase(),
    entry: entryFrom(own(pr, "mergeQueueEntry")),
  }
}

/**
 * Whether the snapshot describes the pull request that was authorized.
 *
 * The node id the enqueue mutation takes is opaque, and a forged response could pair a
 * foreign id with the right labels. So the id must equal the one the independent
 * `pr view` read (the read the landing was authorized from) named, and the repository,
 * number and base must equal that read too. The head is judged by {@link decideQueue}.
 */
export function bindingFailure(
  snapshot: QueueSnapshot,
  expected: { repository: string; number: number; baseRefName: string; id: string },
): string | null {
  if (snapshot.repository.toLowerCase() !== expected.repository.toLowerCase()) {
    return `graphql: observed repository ${JSON.stringify(snapshot.repository)}, expected ${JSON.stringify(expected.repository)}`
  }
  if (snapshot.number !== expected.number) {
    return `graphql: observed pull request number ${snapshot.number}, expected ${expected.number}`
  }
  if (snapshot.baseRefName !== expected.baseRefName) {
    return `graphql: observed baseRefName ${JSON.stringify(snapshot.baseRefName)}, expected ${JSON.stringify(expected.baseRefName)}; the pull request was re-targeted or the read is for another pull request`
  }
  if (snapshot.id !== expected.id) {
    return `graphql: observed pull request node id ${JSON.stringify(snapshot.id)}, expected ${JSON.stringify(expected.id)} from the independent pr view read; the enqueue would act on another pull request`
  }
  return null
}

export type QueueDecision =
  | { kind: "merged" }
  | { kind: "wait"; detail: string; absent: number }
  | { kind: "refused"; reason: string }

/**
 * What one snapshot means for a landing of `expected`.
 *
 * `absent` counts the polls in a row that found an open pull request with no entry. One such
 * poll can be the gap between GitHub accepting the enqueue and showing it, so the entry counts
 * as removed only on the second. A head that is not `expected` refuses at once: GitHub removes
 * a queued pull request whose head changes, and what would land is not what was reviewed.
 */
export function decideQueue(snapshot: QueueSnapshot, expected: string, absent: number): QueueDecision {
  if (snapshot.state === "MERGED") return { kind: "merged" }
  if (snapshot.state !== "OPEN") {
    return {
      kind: "refused",
      reason: `pr.state: observed ${snapshot.state} while queued, expected OPEN or MERGED; the pull request was closed without merging`,
    }
  }
  if (snapshot.headRefOid !== expected) {
    return {
      kind: "refused",
      reason: `pr.headRefOid: observed ${snapshot.headRefOid}, expected ${expected}; the head changed after review, so GitHub removes it from the merge queue and nothing was merged`,
    }
  }
  if (snapshot.entry !== null) {
    const place = snapshot.entry.position === null ? "" : ` at position ${snapshot.entry.position}`
    return { kind: "wait", detail: `queued${place}, entry state ${snapshot.entry.state}`, absent: 0 }
  }
  if (absent + 1 >= ABSENCES_BEFORE_REMOVED) {
    return {
      kind: "refused",
      reason:
        "mergeQueueEntry: observed no entry on an open pull request, expected a queued or merged one; the merge queue removed it (failed checks, a conflict, or a manual removal) and nothing was merged",
    }
  }
  return { kind: "wait", detail: "not in the queue yet", absent: absent + 1 }
}

/** The delay before poll `attempt` (0-based): 5 s doubling, capped at 60 s. */
export function pollDelayMs(attempt: number): number {
  return Math.min(MAX_POLL_DELAY_MS, FIRST_POLL_DELAY_MS * 2 ** attempt)
}

export type QueueRead = { snapshot: QueueSnapshot } | { reason: string }

/** One read of the pull request: the snapshot, or why it could not be read. */
export async function readSnapshot(
  run: CliRunner,
  owner: string,
  name: string,
  number: string,
  env: Readonly<Record<string, string>>,
): Promise<QueueRead> {
  const argv = stateArgv(owner, name, number)
  const result = await run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env })
  if (!result.ok || result.exitCode !== 0 || result.error !== undefined) {
    return {
      reason: `gh api graphql (merge queue state of pull request ${number}): observed ${result.error ?? `exit ${result.exitCode}`}, expected exit 0; ${result.stderr.trim().slice(0, 300)}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { reason: "gh api graphql: observed unparseable output, expected one JSON object" }
  }
  const snapshot = parseSnapshot(parsed)
  return "reason" in snapshot ? { reason: snapshot.reason } : { snapshot }
}

export type QueueWait =
  | { kind: "merged" }
  | { kind: "pending"; detail: string }
  | { kind: "refused"; reason: string; terminal: boolean }

/**
 * Poll until the queue merges the pull request, removes it, or the budget is spent.
 *
 * The budget is the sum of the delays slept, so it is deterministic and a test needs no
 * clock. Out of budget is `pending`, not a failure: the entry is still queued and a later
 * call resumes the wait. `absent` carries over a poll already made by the caller. A refusal
 * is `terminal` only when a read confirmed the end (closed, head changed, entry removed); a
 * failed read is not, so the caller keeps its record of the enqueue.
 */
export async function awaitQueue(options: {
  read: () => Promise<QueueRead>
  sleep: (ms: number) => Promise<void>
  stopped: () => boolean
  expected: string
  budgetMs: number
  absent?: number
}): Promise<QueueWait> {
  let absent = options.absent ?? 0
  let spent = 0
  for (let attempt = 0; ; attempt++) {
    const observed = await options.read()
    // A failed read observed nothing: the entry may still be queued, so it is not terminal.
    if ("reason" in observed) return { kind: "refused", reason: observed.reason, terminal: false }
    const decision = decideQueue(observed.snapshot, options.expected, absent)
    if (decision.kind === "merged") return decision
    if (decision.kind === "refused") return { ...decision, terminal: true }
    absent = decision.absent
    const delay = pollDelayMs(attempt)
    if (options.stopped() || spent + delay > options.budgetMs) return { kind: "pending", detail: decision.detail }
    spent += delay
    await options.sleep(delay)
  }
}

/** A wait in seconds as milliseconds, or why the value is not one. */
export function queueBudgetMs(value: unknown): { ms: number } | { reason: string } {
  const seconds = value === undefined ? DEFAULT_QUEUE_WAIT_SECONDS : value
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0 || seconds > MAX_QUEUE_WAIT_SECONDS) {
    return {
      reason: `queueWaitSeconds: observed ${JSON.stringify(value)}, expected an integer from 0 to ${MAX_QUEUE_WAIT_SECONDS}`,
    }
  }
  return { ms: seconds * 1000 }
}

/** The argv that asks whether `oid` is in the history of `branch`: compare `oid...branch`. */
export function containmentArgv(repoPath: string, oid: string, branch: string): string[] {
  const ref = branch.split("/").map(encodeURIComponent).join("/")
  return ["gh", "api", `repos/${repoPath}/compare/${oid}...${ref}?per_page=1`, "--jq", ".status"]
}

/** Whether a compare status says the branch contains the commit (it is identical to or ahead of it). */
export function branchContains(status: string): boolean {
  return status.trim() === "ahead" || status.trim() === "identical"
}

/**
 * A record that an earlier call enqueued this pull request at this head.
 *
 * Without it a resumed call that finds no entry cannot tell "not enqueued yet" from "enqueued
 * and since removed", and would enqueue again over a removal someone made on purpose. It lives
 * beside the receipts under a name the receipt scan ignores.
 */
export type PendingRecord = {
  schema: 1
  repository: string
  number: number
  head: string
  /** The merge method the queue lands with, so a resume after the merge can pick the queue-aware proof. */
  method: MergeMethod
  enqueuedAt: string
}

export function pendingPath(directory: string, number: number, head: string): string {
  return join(directory, `pending-queue-${number}-${head.slice(0, 12)}.json`)
}

/** The record of an earlier enqueue of this pull request at this head, or null when none matches. */
export function readPending(directory: string, repository: string, number: number, head: string): PendingRecord | null {
  const path = pendingPath(directory, number, head)
  if (!existsSync(path)) return null
  try {
    const record: unknown = JSON.parse(readFileSync(path, "utf8"))
    const raw = text(record, "method")
    const method = raw === null ? undefined : MERGE_METHODS.find((known) => known === raw)
    const holder = text(record, "repository")
    if (
      holder?.toLowerCase() !== repository.toLowerCase() ||
      own(record, "number") !== number ||
      text(record, "head") !== head ||
      method === undefined
    ) {
      return null
    }
    return { schema: 1, repository: holder, number, head, method, enqueuedAt: text(record, "enqueuedAt") ?? "" }
  } catch {
    return null
  }
}

export function hasPending(directory: string, repository: string, number: number, head: string): boolean {
  return readPending(directory, repository, number, head) !== null
}

export function writePending(directory: string, record: Omit<PendingRecord, "schema">): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = pendingPath(directory, record.number, record.head)
  writeFileSync(path, `${JSON.stringify({ schema: 1, ...record })}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function clearPending(directory: string, number: number, head: string): void {
  rmSync(pendingPath(directory, number, head), { force: true })
}
