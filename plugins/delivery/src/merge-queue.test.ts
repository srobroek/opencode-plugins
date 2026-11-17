import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliResult } from "./forge-adapter.ts"
import {
  acquireEnqueueLock,
  awaitQueue,
  bindingFailure,
  branchContains,
  clearPending,
  decideQueue,
  PLAN_GATE_MESSAGE,
  parseSnapshot,
  pollDelayMs,
  type QueueRule,
  type QueueSnapshot,
  queueBudgetMs,
  queueRuleFrom,
  readPending,
  readQueueRule,
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

  test("an abort raised while sleeping ends the wait as pending without another read", async () => {
    const controller = new AbortController()
    let reads = 0
    const waited = await awaitQueue({
      // Like the real runner, a read made after the abort is refused rather than answered.
      read: async () => {
        reads++
        return controller.signal.aborted
          ? { reason: "signal: observed an abort before the read" }
          : { snapshot: snapshot({ entry: entry() }) }
      },
      sleep: async () => controller.abort(),
      stopped: () => controller.signal.aborted,
      expected: HEAD,
      budgetMs: 600_000,
    })

    expect(waited.kind).toBe("pending")
    expect(reads).toBe(1)
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

  test("round-trips the record, and a clear removes it only under the generation it carries", () => {
    withDirectory((directory) => {
      writePending(directory, record)
      expect(readdirSync(directory)).toEqual([`pending-queue-7-${HEAD.slice(0, 12)}.json`])
      expect(readPending(directory, "o/r", 7, HEAD)).toMatchObject({
        kind: "record",
        record: { number: 7, head: HEAD, method: "merge" },
      })
      clearPending(directory, "o/r", 7, HEAD, "", 0)
      expect(readdirSync(directory)).toEqual([`pending-queue-7-${HEAD.slice(0, 12)}.json`])
      const generation = readPending(directory, "o/r", 7, HEAD)
      if (generation.kind !== "record") throw new Error("expected the record")
      expect(clearPending(directory, "o/r", 7, HEAD, generation.record.generation, 0)).toBe("cleared")
      expect(readdirSync(directory)).toEqual([])
    })
  })

  test("a clear while another call holds the enqueue lock keeps the record", () => {
    withDirectory((directory) => {
      writePending(directory, { ...record, generation: "g1" })
      const lock = acquireEnqueueLock(directory, 7, HEAD, 0)
      expect(clearPending(directory, "o/r", 7, HEAD, "g1", 0)).toBe("kept")
      if (lock.kind === "acquired") lock.release()
      expect(clearPending(directory, "o/r", 7, HEAD, "g1", 0)).toBe("cleared")
    })
  })

  test("a second write never replaces the first record", () => {
    withDirectory((directory) => {
      expect(writePending(directory, record)).toBe("created")
      expect(writePending(directory, { ...record, method: "squash", enqueuedAt: "2026-02-02T00:00:00Z" })).toBe("exists")
      expect(readPending(directory, "o/r", 7, HEAD)).toMatchObject({ kind: "record", record: { method: "merge" } })
      expect(readdirSync(directory)).toEqual([`pending-queue-7-${HEAD.slice(0, 12)}.json`])
    })
  })

  test("no record file reads as absent", () => {
    withDirectory((directory) => {
      expect(readPending(directory, "o/r", 7, HEAD)).toEqual({ kind: "absent" })
    })
  })

  test.each([
    ["a truncated write", (path: string) => writeFileSync(path, '{"schema":1,"repository":"O/R","num')],
    ["an empty file", (path: string) => writeFileSync(path, "")],
    ["a method that is not a merge method", (path: string) => writeFileSync(path, JSON.stringify({ schema: 1, repository: "O/R", number: 7, head: HEAD, method: "constructor" }))],
    ["another repository", (path: string) => writeFileSync(path, JSON.stringify({ schema: 1, repository: "other/r", number: 7, head: HEAD, method: "merge" }))],
    ["another head with the same prefix", (path: string) => writeFileSync(path, JSON.stringify({ schema: 1, repository: "O/R", number: 7, head: `${HEAD.slice(0, 12)}${"f".repeat(28)}`, method: "merge" }))],
    ["a directory in the record's place", (path: string) => mkdirSync(path)],
  ])("%s reads as unreadable, never as absent", (_name, plant) => {
    withDirectory((directory) => {
      const path = join(directory, `pending-queue-7-${HEAD.slice(0, 12)}.json`)
      plant(path)
      expect(readPending(directory, "o/r", 7, HEAD)).toMatchObject({ kind: "unreadable", path })
    })
  })
})

describe("enqueue lock", () => {
  const NOW = 1_800_000_000_000
  const withDirectory = (check: (directory: string) => void): void => {
    const directory = mkdtempSync(join(tmpdir(), "enqueue-lock-"))
    try {
      check(directory)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  test("a live holder keeps it until it releases, and release leaves nothing behind", () => {
    withDirectory((directory) => {
      const first = acquireEnqueueLock(directory, 7, HEAD, NOW)
      if (first.kind !== "acquired") throw new Error("expected the lock")
      expect(acquireEnqueueLock(directory, 7, HEAD, NOW + 1_000).kind).toBe("held")
      first.release()
      expect(readdirSync(directory)).toEqual([])
      expect(acquireEnqueueLock(directory, 7, HEAD, NOW + 2_000).kind).toBe("acquired")
    })
  })

  test.each([
    ["whose process has ended", () => false, "which has ended without releasing it"],
    ["held far longer than an enqueue takes", () => true, "by process"],
  ])("a lock %s is reported, never taken over", (_name, alive, detail) => {
    withDirectory((directory) => {
      expect(acquireEnqueueLock(directory, 7, HEAD, NOW).kind).toBe("acquired")
      const later = acquireEnqueueLock(directory, 7, HEAD, NOW + 86_400_000, alive)
      expect(later).toMatchObject({ kind: "held", path: join(directory, `pending-queue-7-${HEAD.slice(0, 12)}.lock`) })
      expect(later.kind === "held" && later.detail).toContain(detail)
    })
  })
})

describe("readQueueRule", () => {
  const rules = (result: CliResult) => {
    const argvs: string[][] = []
    const run = async (argv: string[]): Promise<CliResult> => {
      argvs.push(argv)
      return result
    }
    return { read: () => readQueueRule(run, "o/r", "main", {}), argvs }
  }

  test("the plan-gate 403 reads as no queue possible, with the reason", async () => {
    const { read, argvs } = rules({ ok: true, exitCode: 1, stdout: "", stderr: `gh: ${PLAN_GATE_MESSAGE}. (HTTP 403)` })

    expect(await read()).toEqual({ required: false, planGated: true })
    expect(argvs).toHaveLength(1)
  })

  test("the plan-gate message at a 404 takes the 404 path, which an unconfirmed second signal refuses", async () => {
    const { read } = rules({ ok: true, exitCode: 1, stdout: "", stderr: `${PLAN_GATE_MESSAGE} (HTTP 404)` })

    const answer = await read()
    expect(answer).toHaveProperty("reason")
    expect(answer).not.toHaveProperty("planGated")
  })

  test.each<[string, CliResult]>([
    ["a runner that timed out", { ok: false, exitCode: null, stdout: "", stderr: "", error: "timed out after 10000ms" }],
    ["a 404 spelled by a runner that also failed to start", { ok: false, exitCode: null, stdout: "", stderr: "HTTP 404", error: "spawn failed" }],
    ["a server error", { ok: true, exitCode: 1, stdout: "", stderr: "gh: HTTP 502" }],
    ["a zero exit with unparseable output", { ok: true, exitCode: 0, stdout: "<html>", stderr: "" }],
    ["a zero exit with an empty body", { ok: true, exitCode: 0, stdout: "", stderr: "" }],
    ["an object where a rule array belongs", { ok: true, exitCode: 0, stdout: "{}", stderr: "" }],
    ["a 403 with another message", { ok: true, exitCode: 1, stdout: "", stderr: "gh: Must have admin rights (HTTP 403)" }],
    ["the plan-gate message at a 500 status", { ok: true, exitCode: 1, stdout: "", stderr: `${PLAN_GATE_MESSAGE} (HTTP 500)` }],
    ["the plan-gate message from a runner that errored", { ok: false, exitCode: null, stdout: "", stderr: `${PLAN_GATE_MESSAGE} (HTTP 403)`, error: "timed out" }],
  ])("%s refuses and never reads as 'no merge queue'", async (_name, result) => {
    const { read, argvs } = rules(result)
    const answer = await read()

    expect(answer).toHaveProperty("reason")
    expect(answer).not.toHaveProperty("required")
    // Nothing but the one rules read ran: no second signal was taken as an answer.
    expect(argvs).toHaveLength(1)
  })
})
