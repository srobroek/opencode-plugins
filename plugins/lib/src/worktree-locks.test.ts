import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bumpClaim,
  claimGeneration,
  readClaim,
  writeClaim,
} from "./worktree-claims.ts"
import {
  HOLD_EXPIRY_MS,
  holdBlock,
  type LockInfo,
  LockTimeout,
  lockFile,
  lockIsStale,
  parseHold,
  readHolds,
  setHold,
  withDiskLock,
} from "./worktree-locks.ts"

const roots: string[] = []
const common = () => {
  const root = mkdtempSync(join(tmpdir(), "locks-"))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const info = (over: Partial<LockInfo> = {}): LockInfo => ({ pid: 4242, host: "h", sessionID: "s", acquiredAt: 0, token: "t", ...over })
const stale = (over: Partial<LockInfo>, facts: Partial<Parameters<typeof lockIsStale>[1]> = {}) =>
  lockIsStale(info(over), { now: 10 * 60_000, ttlMs: 2 * 60_000, host: "h", alive: () => false, ...facts })

describe("lockIsStale", () => {
  test("old and its pid is gone: stale", () => expect(stale({})).toBe(true))
  test("old but its pid is alive: kept", () => expect(stale({}, { alive: () => true })).toBe(false))
  test("young, pid gone: kept until the TTL", () => expect(stale({ acquiredAt: 9 * 60_000 })).toBe(false))
  test("old but taken on another host: never broken", () => expect(stale({ host: "other" })).toBe(false))
  test("an unparseable lock is judged by its mtime alone", () => {
    const facts = { now: 10 * 60_000, ttlMs: 2 * 60_000, host: "h", alive: () => true }
    expect(lockIsStale(undefined, { ...facts, mtimeMs: 0 })).toBe(true)
    expect(lockIsStale(undefined, { ...facts, mtimeMs: 9 * 60_000 })).toBe(false)
    expect(lockIsStale(undefined, facts)).toBe(false)
  })
})

describe("withDiskLock", () => {
  const fast = { attempts: 4, delayMs: () => 0, sleep: async () => {} }

  test("runs the work, holds the lock meanwhile, and releases it", async () => {
    const dir = common()
    let during = false
    await withDiskLock(dir, "/wt/a", { sessionID: "s" }, async () => {
      during = readdirSync(join(dir, "opencode", "locks")).some((name) => name.endsWith(".lock"))
    })
    expect(during).toBe(true)
    expect(readdirSync(join(dir, "opencode", "locks")).filter((name) => name.endsWith(".lock"))).toEqual([])
  })

  test("releases when the work throws", async () => {
    const dir = common()
    await expect(
      withDiskLock(dir, "/wt/a", { sessionID: "s" }, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    await withDiskLock(dir, "/wt/a", { sessionID: "s" }, async () => {})
  })

  test("a second holder waits for the first (two instances, one lock)", async () => {
    const dir = common()
    const order: string[] = []
    const first = withDiskLock(dir, "/wt/a", { sessionID: "a" }, async () => {
      order.push("a-in")
      await new Promise((done) => setTimeout(done, 40))
      order.push("a-out")
    })
    await new Promise((done) => setTimeout(done, 5))
    const second = withDiskLock(dir, "/wt/a", { sessionID: "b" }, async () => {
      order.push("b-in")
    })
    await Promise.all([first, second])
    expect(order).toEqual(["a-in", "a-out", "b-in"])
  })

  test("a live lock is kept: the waiter times out and the holder's file is untouched", async () => {
    const dir = common()
    mkdirSync(join(dir, "opencode", "locks"), { recursive: true })
    const path = lockFile(dir, "/wt/a")
    writeFileSync(path, JSON.stringify(info({ pid: process.pid, host: "h", acquiredAt: 0 })))
    await expect(
      withDiskLock(dir, "/wt/a", { ...fast, sessionID: "s", host: "h", now: () => 10 * 60_000, alive: () => true }, async () => {}),
    ).rejects.toBeInstanceOf(LockTimeout)
    expect(JSON.parse(require("node:fs").readFileSync(path, "utf8")).token).toBe("t")
  })

  test("a dead holder's old lock is broken and the work runs", async () => {
    const dir = common()
    mkdirSync(join(dir, "opencode", "locks"), { recursive: true })
    writeFileSync(lockFile(dir, "/wt/a"), JSON.stringify(info({ host: "h", acquiredAt: 0 })))
    let ran = false
    await withDiskLock(dir, "/wt/a", { ...fast, sessionID: "s", host: "h", now: () => 10 * 60_000, alive: () => false }, async () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(readdirSync(join(dir, "opencode", "locks"))).toEqual([])
  })

  test("a different directory is a different lock", async () => {
    const dir = common()
    let inner = false
    await withDiskLock(dir, "/wt/a", { sessionID: "s" }, async () => {
      await withDiskLock(dir, "/wt/b", { ...fast, sessionID: "s" }, async () => {
        inner = true
      })
    })
    expect(inner).toBe(true)
  })
})

describe("holds", () => {
  test("one file per session; a session with no jobs clears its own entry only", () => {
    const dir = common()
    setHold(dir, "/wt/a", "ses_c", [{ kind: "shell", id: "sh1" }], 100)
    setHold(dir, "/wt/a", "ses_p", [{ kind: "subagent", id: "ses_c" }], 200)
    expect(readHolds(dir, "/wt/a").holds.map((hold) => hold.sessionID).sort()).toEqual(["ses_c", "ses_p"])
    setHold(dir, "/wt/a", "ses_c", [], 300)
    expect(readHolds(dir, "/wt/a").holds.map((hold) => hold.sessionID)).toEqual(["ses_p"])
  })

  test("no holds is not unreadable; a corrupt entry is", () => {
    const dir = common()
    expect(readHolds(dir, "/wt/a")).toEqual({ holds: [], unreadable: false })
    setHold(dir, "/wt/a", "ses_c", [{ kind: "shell", id: "x" }], 1)
    const holdsRoot = join(dir, "opencode", "holds")
    const sub = readdirSync(holdsRoot)[0] as string
    writeFileSync(join(holdsRoot, sub, "bad.json"), "garbage")
    expect(readHolds(dir, "/wt/a").unreadable).toBe(true)
  })

  test("holdBlock: a live job blocks, an expired one does not, unreadable blocks", () => {
    const hold = { sessionID: "s", directory: "/wt/a", jobs: [{ kind: "shell", id: "x" }], updatedAt: 1000 }
    expect(holdBlock({ holds: [hold], unreadable: false }, 2000)).toContain("1 background job(s)")
    expect(holdBlock({ holds: [hold], unreadable: false }, 1000 + HOLD_EXPIRY_MS + 1)).toBeUndefined()
    expect(holdBlock({ holds: [{ ...hold, jobs: [] }], unreadable: false }, 2000)).toBeUndefined()
    expect(holdBlock({ holds: [], unreadable: true }, 2000)).toContain("cannot be read")
    expect(holdBlock({ holds: [], unreadable: false }, 2000)).toBeUndefined()
  })

  test("parseHold rejects a malformed job", () => {
    expect(parseHold({ sessionID: "s", directory: "d", updatedAt: 1, jobs: [{ kind: 1 }] })).toBeUndefined()
  })
})

describe("the resume generation lives in the claim", () => {
  const claim = { directory: "/wt/a", branch: "b", sessionID: "c", parentID: "p", createdAt: 7 }

  test("a bump increments the generation and records when", () => {
    const dir = common()
    writeClaim(dir, claim)
    const before = claimGeneration(readClaim(dir, "/wt/a"))
    expect(bumpClaim(dir, "/wt/a", 1234)).toBe(before + 1)
    const after = readClaim(dir, "/wt/a")
    expect(after.kind === "present" && after.value.resumedAt).toBe(1234)
    expect(claimGeneration(after)).toBe(before + 1)
  })

  test("no claim has generation -1 and cannot be bumped", () => {
    const dir = common()
    expect(claimGeneration(readClaim(dir, "/wt/a"))).toBe(-1)
    expect(bumpClaim(dir, "/wt/a", 1)).toBe(-1)
  })
})
