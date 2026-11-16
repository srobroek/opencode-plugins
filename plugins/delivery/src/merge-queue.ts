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

import { type CliRunner, FORGE_TIMEOUT_MS, type MergeMethod } from "./forge-adapter.ts"

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

const QUEUE_METHODS: Readonly<Record<string, MergeMethod>> = { MERGE: "merge", SQUASH: "squash", REBASE: "rebase" }

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
  const queue = payload.find((rule) => text(rule, "type") === "merge_queue")
  if (queue === undefined) return { required: false }
  const raw = text(own(queue, "parameters"), "merge_method")
  const method = QUEUE_METHODS[raw ?? ""]
  if (method === undefined) {
    return {
      reason: `rules: observed merge_queue merge_method ${JSON.stringify(raw)}, expected MERGE, SQUASH or REBASE`,
    }
  }
  return { required: true, method }
}

/** Read the branch's active rules and say whether it requires a merge queue. */
export async function readQueueRule(
  run: CliRunner,
  repoPath: string,
  branch: string,
  env: Readonly<Record<string, string>>,
): Promise<QueueRule | { reason: string }> {
  const argv = rulesArgv(repoPath, branch)
  const result = await run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env })
  if (!result.ok || result.exitCode !== 0 || result.error !== undefined) {
    return {
      reason: `${argv.join(" ")}: observed ${result.error ?? `exit ${result.exitCode}`}, expected exit 0 to learn whether the branch requires a merge queue; ${result.stderr.trim().slice(0, 300)}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { reason: `${argv.join(" ")}: observed unparseable output, expected a JSON array of rules` }
  }
  return queueRuleFrom(parsed)
}

const ENTRY_FIELDS = "state position headCommit { oid }"

const STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id state headRefOid mergeQueueEntry { ${ENTRY_FIELDS} } } } }`

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

export type QueueEntry = { state: string; position: number | null; headOid: string | null }

/** One observation of the pull request: its state, its head, and its queue entry if any. */
export type QueueSnapshot = { id: string; state: string; headRefOid: string; entry: QueueEntry | null }

function entryFrom(value: unknown): QueueEntry | null {
  const state = text(value, "state")
  if (state === null) return null
  const position = own(value, "position")
  return {
    state,
    position: typeof position === "number" ? position : null,
    headOid: text(own(value, "headCommit"), "oid")?.toLowerCase() ?? null,
  }
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
  const pr = own(own(own(payload, "data"), "repository"), "pullRequest")
  const id = text(pr, "id")
  const state = text(pr, "state")
  const head = text(pr, "headRefOid")
  if (id === null || state === null || head === null) {
    return { reason: "graphql: observed no pull request with id, state and headRefOid, expected one" }
  }
  return {
    id,
    state: state.toUpperCase(),
    headRefOid: head.toLowerCase(),
    entry: entryFrom(own(pr, "mergeQueueEntry")),
  }
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
    if (snapshot.entry.headOid !== null && snapshot.entry.headOid !== expected) {
      return {
        kind: "refused",
        reason: `mergeQueueEntry.headCommit: observed ${snapshot.entry.headOid}, expected ${expected}; the queued entry is not the reviewed head`,
      }
    }
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
  | { kind: "refused"; reason: string }

/**
 * Poll until the queue merges the pull request, removes it, or the budget is spent.
 *
 * The budget is the sum of the delays slept, so it is deterministic and a test needs no
 * clock. Out of budget is `pending`, not a failure: the entry is still queued and a later
 * call resumes the wait. `absent` carries over a poll already made by the caller.
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
    if ("reason" in observed) return { kind: "refused", reason: observed.reason }
    const decision = decideQueue(observed.snapshot, options.expected, absent)
    if (decision.kind !== "wait") return decision
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
