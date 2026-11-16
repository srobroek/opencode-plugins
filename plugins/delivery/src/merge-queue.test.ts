import { describe, expect, test } from "bun:test"
import {
  decideQueue,
  parseSnapshot,
  pollDelayMs,
  type QueueRule,
  type QueueSnapshot,
  queueBudgetMs,
  queueRuleFrom,
  rulesArgv,
} from "./merge-queue.ts"

const HEAD = "0123456789abcdef0123456789abcdef01234567"
const OTHER = "1111111111111111111111111111111111111111"

const snapshot = (overrides: Partial<QueueSnapshot> = {}): QueueSnapshot => ({
  id: "PR_1",
  state: "OPEN",
  headRefOid: HEAD,
  entry: null,
  ...overrides,
})
const entry = (headOid: string | null = HEAD) => ({ state: "QUEUED", position: 2, headOid })

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

  test("an entry missing once waits, and missing twice in a row is a removal", () => {
    expect(decideQueue(snapshot(), HEAD, 0)).toMatchObject({ kind: "wait", absent: 1 })
    expect(decideQueue(snapshot(), HEAD, 1)).toMatchObject({ kind: "refused" })
  })

  test.each([
    ["a changed pull request head", snapshot({ headRefOid: OTHER })],
    ["a queued entry for another head", snapshot({ entry: entry(OTHER) })],
    ["a closed pull request", snapshot({ state: "CLOSED" })],
  ])("%s refuses", (_name, observed) => {
    expect(decideQueue(observed, HEAD, 0)).toMatchObject({ kind: "refused" })
  })
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
        pullRequest: {
          id: "PR_1",
          state: "OPEN",
          headRefOid: HEAD.toUpperCase(),
          mergeQueueEntry: { state: "QUEUED", position: 3, headCommit: { oid: HEAD } },
        },
      },
    },
  }
  expect(parseSnapshot(payload)).toEqual({ id: "PR_1", state: "OPEN", headRefOid: HEAD, entry: { state: "QUEUED", position: 3, headOid: HEAD } })
  expect(parseSnapshot({ errors: [{ message: "x" }] })).toHaveProperty("reason")
})
