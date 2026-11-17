import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
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
  holdsState,
  type LockInfo,
  LockTimeout,
  lockedWorktreeRemoval,
  lockFile,
  lockIsStale,
  parseHold,
  readHolds,
  sameLock,
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
    expect(readHolds(dir, "/wt/a")).toMatchObject({ holds: [], unreadable: false })
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

describe("breaking a stale lock is itself exclusive", () => {
  const NOW = 10 * 60_000
  const opts = (sessionID: string, extra: Record<string, unknown> = {}) => ({
    sessionID,
    host: "h",
    now: () => NOW,
    alive: () => false,
    attempts: 3,
    delayMs: () => 0,
    sleep: async () => {},
    ...extra,
  })
  const plant = (dir: string, over: Partial<LockInfo> = {}) => {
    mkdirSync(join(dir, "opencode", "locks"), { recursive: true })
    writeFileSync(lockFile(dir, "/wt/a"), JSON.stringify(info({ host: "h", acquiredAt: 0, ...over })))
  }
  const tokenOnDisk = (dir: string) => JSON.parse(readFileSync(lockFile(dir, "/wt/a"), "utf8")).token as string

  test("a slow breaker that validated the old lock cannot remove the fresh lock a faster one created", async () => {
    const dir = common()
    plant(dir, { token: "old" })
    let release!: () => void
    const gate = new Promise<void>((done) => (release = done))
    let aInside!: () => void
    const entered = new Promise<void>((done) => (aInside = done))
    let a: Promise<void> | undefined
    let tokenWhileHeld = ""
    const b = withDiskLock(
      dir,
      "/wt/a",
      opts("b", {
        seams: {
          // B has judged the old lock stale and is about to break it. A runs to completion first: it breaks the
          // same old lock, takes a fresh one and holds it.
          afterValidate: async () => {
            a = withDiskLock(dir, "/wt/a", opts("a"), async () => {
              tokenWhileHeld = tokenOnDisk(dir)
              aInside()
              await gate
            })
            await entered
          },
        },
      }),
      async () => {},
    )
    await expect(b).rejects.toBeInstanceOf(LockTimeout)
    // B's delayed break did not touch A's fresh lock.
    expect(tokenOnDisk(dir)).toBe(tokenWhileHeld)
    expect(tokenWhileHeld).not.toBe("old")
    release()
    await a
    expect(readdirSync(join(dir, "opencode", "locks")).filter((name) => name.endsWith(".lock"))).toEqual([])
  })

  test("release unlinks only a lock that still carries its own token", async () => {
    const dir = common()
    await withDiskLock(dir, "/wt/a", { sessionID: "s" }, async () => {
      // Someone else's lock replaced ours while the work ran.
      writeFileSync(lockFile(dir, "/wt/a"), JSON.stringify(info({ token: "someone-else", acquiredAt: Date.now() })))
    })
    expect(tokenOnDisk(dir)).toBe("someone-else")
  })

  test("a .break file older than 30 s belongs to a crashed breaker and is removed; the next try breaks the lock", async () => {
    const dir = common()
    plant(dir)
    const breakFile = `${lockFile(dir, "/wt/a")}.break`
    writeFileSync(breakFile, "{}")
    const old = new Date(Date.now() - 120_000)
    utimesSync(breakFile, old, old)
    let ran = false
    await withDiskLock(dir, "/wt/a", opts("s", { attempts: 6, now: () => Date.now() }), async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test("a young .break file is respected: a breaker is at work, so this one does not break", async () => {
    const dir = common()
    plant(dir)
    writeFileSync(`${lockFile(dir, "/wt/a")}.break`, "{}")
    await expect(withDiskLock(dir, "/wt/a", opts("s", { now: () => Date.now() }), async () => {})).rejects.toBeInstanceOf(LockTimeout)
    expect(tokenOnDisk(dir)).toBe("t")
  })

  test("normal acquisition never creates a .break file", async () => {
    const dir = common()
    await withDiskLock(dir, "/wt/a", { sessionID: "s" }, async () => {
      expect(readdirSync(join(dir, "opencode", "locks")).some((name) => name.endsWith(".break"))).toBe(false)
    })
  })
})

describe("sameLock", () => {
  test("token, pid, host and acquiredAt must all match", () => {
    expect(sameLock(info(), info())).toBe(true)
    for (const over of [{ token: "x" }, { pid: 1 }, { host: "z" }, { acquiredAt: 1 }]) expect(sameLock(info(), info(over))).toBe(false)
  })
  test("unparseable locks compare by their raw text", () => {
    expect(sameLock(undefined, undefined, "garbage", "garbage")).toBe(true)
    expect(sameLock(undefined, undefined, "garbage", "other")).toBe(false)
    expect(sameLock(info(), undefined)).toBe(false)
  })
})

describe("lockedWorktreeRemoval", () => {
  test("rechecks under the lock and removes only when nothing refuses", async () => {
    const dir = common()
    const seen: string[] = []
    const inLock = () => readdirSync(join(dir, "opencode", "locks")).some((name) => name.endsWith(".lock"))
    const out = await lockedWorktreeRemoval(dir, "/wt/a", { sessionID: "s" }, {
      recheck: async () => {
        seen.push(`recheck:${inLock()}`)
        return undefined
      },
      remove: async () => {
        seen.push(`remove:${inLock()}`)
        return 42
      },
    })
    expect(out).toEqual({ removed: true, value: 42 })
    expect(seen).toEqual(["recheck:true", "remove:true"])
  })

  test("a refusal from the recheck means no removal", async () => {
    const dir = common()
    let removed = false
    const out = await lockedWorktreeRemoval(dir, "/wt/a", { sessionID: "s" }, {
      recheck: async () => "a hold",
      remove: async () => {
        removed = true
      },
    })
    expect(out).toEqual({ removed: false, reason: "a hold" })
    expect(removed).toBe(false)
  })

  test("a lock held by someone else is a refusal, not an error, and nothing runs", async () => {
    const dir = common()
    mkdirSync(join(dir, "opencode", "locks"), { recursive: true })
    writeFileSync(lockFile(dir, "/wt/a"), JSON.stringify(info({ pid: process.pid, acquiredAt: Date.now(), host: hostname() })))
    let ran = false
    const out = await lockedWorktreeRemoval(dir, "/wt/a", { sessionID: "s", attempts: 2, delayMs: () => 0, sleep: async () => {} }, {
      recheck: async () => {
        ran = true
        return undefined
      },
      remove: async () => {
        ran = true
      },
    })
    expect(out.removed).toBe(false)
    expect(ran).toBe(false)
  })
})

describe("holdsState", () => {
  test("no holds directory and a writable store: nothing running", () => {
    expect(holdsState(common(), "/wt/a", 1)).toBeUndefined()
  })

  test("no holds directory and an unwritable store is unsafe, not empty", () => {
    if (process.getuid?.() === 0) return
    const dir = common()
    mkdirSync(join(dir, "opencode"), { recursive: true })
    chmodSync(join(dir, "opencode"), 0o555)
    try {
      expect(holdsState(dir, "/wt/a", 1)).toContain("not writable")
    } finally {
      chmodSync(join(dir, "opencode"), 0o755)
    }
  })

  test("a live hold blocks even when the store is writable", () => {
    const dir = common()
    setHold(dir, "/wt/a", "s", [{ kind: "shell", id: "x" }], 10)
    expect(holdsState(dir, "/wt/a", 11)).toContain("background job")
  })
})
