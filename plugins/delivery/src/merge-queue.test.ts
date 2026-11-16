import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  awaitQueue,
  bindingFailure,
  branchContains,
  clearPending,
  decideQueue,
  parseSnapshot,
  pollDelayMs,
  type QueueRule,
  type QueueSnapshot,
  queueBudgetMs,
  queueRuleFrom,
  readPending,
  rulesArgv,
  writePending,
} from "./merge-queue.ts"

const HEAD = "0123456789abcdef0123456789abcdef01234567"
const OTHER = "1111111111111111111111111111111111111111"

const snapshot = (overrides: Partial<QueueSnapshot> = {}): QueueSnapshot => ({
  id: "PR_1",
  repository: "o/r",
  number: 7,
  baseRefName: "main",
  state: "OPEN",
  headRefOid: HEAD,
  entry: null,
  ...overrides,
})
const entry = () => ({ state: "QUEUED", position: 2 })

describe("queueRuleFrom", () => {
  test.each<[string, unknown, QueueRule]>([
    ["no rules", [], { required: false }],
    ["rules without a queue", [{ type: "pull_request" }], { required: false }],
    ["a squash queue", [{ type: "merge_queue", parameters: { merge_method: "SQUASH" } }], { required: true, method: "squash" }],
    ["a merge queue", [{ type: "merge_queue", parameters: { merge_method: "MERGE" } }], { required: true, method: "merge" }],
    ["a rebase queue", [{ type: "merge_queue", parameters: { merge_method: "REBASE" } }], { required: true, method: "rebase" }],
  ])("%s", (_name, payload, expected) => {
    expect(queueRuleFrom(payload)).toEqual(expected)
  })

  test.each([
    ["an object payload", { message: "Not Found" }],
    ["a queue rule with no method", [{ type: "merge_queue", parameters: {} }]],
    ["a string element", ["merge_queue"]],
    ["a null element", [null]],
    ["an inherited property name as the method", [{ type: "merge_queue", parameters: { merge_method: "constructor" } }]],
    ["a prototype key as the method", [{ type: "merge_queue", parameters: { merge_method: "__proto__" } }]],
    ["a lower-case method", [{ type: "merge_queue", parameters: { merge_method: "squash" } }]],
    ["a non-string method", [{ type: "merge_queue", parameters: { merge_method: 7 } }]],
    ["a malformed element beside a queue rule", [{ type: "merge_queue", parameters: { merge_method: "SQUASH" } }, 5]],
    ["a full page of rules", Array.from({ length: 100 }, () => ({ type: "creation" }))],
  ])("refuses %s rather than assume a direct merge", (_name, payload) => {
    expect(queueRuleFrom(payload)).toHaveProperty("reason")
  })

  test("encodes a branch name with a slash into one path segment", () => {
    expect(rulesArgv("o/r", "omp/integration/x")[2]).toBe("repos/o/r/rules/branches/omp%2Fintegration%2Fx?per_page=100")
  })
})

describe("decideQueue", () => {
  test("a MERGED pull request is merged", () => {
    expect(decideQueue(snapshot({ state: "MERGED" }), HEAD, 0)).toEqual({ kind: "merged" })
  })

  test("a queued entry for the expected head waits and resets the absence count", () => {
    expect(decideQueue(snapshot({ entry: entry() }), HEAD, 1)).toEqual({
      kind: "wait",
      detail: "queued at position 2, entry state QUEUED",
      absent: 0,
    })
  })

  test("an entry's headCommit is the queue's integration commit and never judged as the PR head", () => {
    const withIntegration = snapshot({ entry: { ...entry(), headCommit: { oid: OTHER } } as never })
    expect(decideQueue(withIntegration, HEAD, 0)).toMatchObject({ kind: "wait" })
  })

  test("an entry missing once waits, and missing twice in a row is a removal", () => {
    expect(decideQueue(snapshot(), HEAD, 0)).toMatchObject({ kind: "wait", absent: 1 })
    expect(decideQueue(snapshot(), HEAD, 1)).toMatchObject({ kind: "refused" })
  })

  test.each([
    ["a changed pull request head", snapshot({ headRefOid: OTHER })],
    ["a closed pull request", snapshot({ state: "CLOSED" })],
  ])("%s refuses", (_name, observed) => {
    expect(decideQueue(observed, HEAD, 0)).toMatchObject({ kind: "refused" })
  })
})

describe("bindingFailure", () => {
  const expected = { repository: "O/R", number: 7, baseRefName: "main", id: "PR_1" }

  test("accepts the authorized repository (case-insensitive), number and base", () => {
    expect(bindingFailure(snapshot(), expected)).toBeNull()
  })

  test.each([
    ["repository", { repository: "evil/r" }],
    ["number", { number: 8 }],
    ["base", { baseRefName: "release" }],
    ["node id, with every label correct", { id: "PR_forged" }],
  ])("refuses a different %s", (_name, overrides) => {
    expect(bindingFailure(snapshot(overrides), expected)).toContain("graphql: observed")
  })
})

test.each([
  ["ahead", true],
  ["identical", true],
  ["behind", false],
  ["diverged", false],
  ["", false],
])("compare status %p means the base contains the commit: %p", (status, contained) => {
  expect(branchContains(status)).toBe(contained)
})

test("poll delays double from 5 s and stop at 60 s", () => {
  expect([0, 1, 2, 3, 4, 5, 9].map(pollDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000])
})

test.each([
  [undefined, 600_000],
  [0, 0],
  [3600, 3_600_000],
])("queueWaitSeconds %p is %p ms", (value, ms) => {
  expect(queueBudgetMs(value)).toEqual({ ms })
})

test.each([[-1], [3601], [1.5], ["60"]])("queueWaitSeconds %p is refused", (value) => {
  expect(queueBudgetMs(value)).toHaveProperty("reason")
})

test("parseSnapshot reads the entry and refuses a payload with errors", () => {
  const payload = {
    data: {
      repository: {
        nameWithOwner: "o/r",
        pullRequest: {
          id: "PR_1",
          number: 7,
          baseRefName: "main",
          state: "OPEN",
          headRefOid: HEAD.toUpperCase(),
          mergeQueueEntry: { state: "QUEUED", position: 3, headCommit: { oid: OTHER } },
        },
      },
    },
  }
  expect(parseSnapshot(payload)).toEqual({
    id: "PR_1",
    repository: "o/r",
    number: 7,
    baseRefName: "main",
    state: "OPEN",
    headRefOid: HEAD,
    entry: { state: "QUEUED", position: 3 },
  })
  expect(parseSnapshot({ errors: [{ message: "x" }] })).toHaveProperty("reason")
})

describe("awaitQueue", () => {
  const run = (reads: Array<{ snapshot: QueueSnapshot } | { reason: string }>) => {
    const queue = [...reads]
    return awaitQueue({
      read: async () => queue.shift() ?? { reason: "no more reads" },
      sleep: async () => {},
      stopped: () => false,
      expected: HEAD,
      budgetMs: 600_000,
    })
  }

  test("a failed read refuses without being terminal, so the enqueue record survives", async () => {
    expect(await run([{ reason: "gh: exit 1" }])).toEqual({ kind: "refused", reason: "gh: exit 1", terminal: false })
  })

  test("a removed entry, a closed pull request and a moved head are terminal refusals", async () => {
    for (const observed of [snapshot({ state: "CLOSED" }), snapshot({ headRefOid: OTHER })]) {
      expect(await run([{ snapshot: observed }])).toMatchObject({ kind: "refused", terminal: true })
    }
    expect(await run([{ snapshot: snapshot() }, { snapshot: snapshot() }])).toMatchObject({
      kind: "refused",
      terminal: true,
    })
  })
})

describe("pending record", () => {
  const record = { repository: "O/R", number: 7, head: HEAD, method: "merge", enqueuedAt: "2026-01-01T00:00:00Z" } as const
  const withDirectory = (check: (directory: string) => void): void => {
    const directory = mkdtempSync(join(tmpdir(), "pending-queue-"))
    try {
      check(directory)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  test("round-trips the repository, number, head and merge method", () => {
    withDirectory((directory) => {
      writePending(directory, record)
      expect(readPending(directory, "o/r", 7, HEAD)).toMatchObject({ number: 7, head: HEAD, method: "merge" })
      expect(readPending(directory, "other/r", 7, HEAD)).toBeNull()
      clearPending(directory, 7, HEAD)
      expect(readdirSync(directory)).toEqual([])
    })
  })

  test("a record whose method is not a merge method reads as absent", () => {
    withDirectory((directory) => {
      writePending(directory, { ...record, method: "constructor" as never })
      expect(readPending(directory, "o/r", 7, HEAD)).toBeNull()
    })
  })
})
