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
  LockTimeout,
  lockedWorktreeRemoval,
  lockedWrite,
  lockFile,
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

const heldByOther = () => ({
  host: hostname().split(".")[0],
  pid: process.pid,
  owner: "other remover",
  token: "theirs",
  taken: Date.now(),
  expires: Date.now() + 60_000,
})

describe("withDiskLock", () => {
  test("holds the worktree's lock file while the work runs, and writers go through it too", async () => {
    const dir = common()
    const during: boolean[] = []
    await withDiskLock(dir, "/wt/a", { sessionID: "s" }, async () => {
      during.push(readdirSync(join(dir, "opencode", "locks")).some((name) => name.endsWith(".lock")))
      // A write made inside the critical section does not wait on the section itself.
      await lockedWrite(dir, "/wt/a", { sessionID: "s", waitMs: 20 }, () => during.push(true))
    })
    expect(during).toEqual([true, true])
    expect(readdirSync(join(dir, "opencode", "locks"))).toEqual([])
  })

  test("a write from outside waits for a removal in flight, then runs", async () => {
    const dir = common()
    const order: string[] = []
    const removal = withDiskLock(dir, "/wt/a", { sessionID: "remover" }, async () => {
      order.push("remove-start")
      await new Promise((done) => setTimeout(done, 60))
      order.push("remove-end")
    })
    await new Promise((done) => setTimeout(done, 10))
    await lockedWrite(dir, "/wt/a", { sessionID: "writer", waitMs: 2000 }, () => order.push("write"))
    await removal
    expect(order).toEqual(["remove-start", "remove-end", "write"])
  })

  test("a lock that cannot be taken in time throws LockTimeout and the work does not run", async () => {
    const dir = common()
    mkdirSync(join(dir, "opencode", "locks"), { recursive: true })
    writeFileSync(lockFile(dir, "/wt/a"), JSON.stringify(heldByOther()))
    let ran = false
    await expect(
      withDiskLock(dir, "/wt/a", { sessionID: "s", waitMs: 40 }, async () => {
        ran = true
      }),
    ).rejects.toBeInstanceOf(LockTimeout)
    expect(ran).toBe(false)
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
    writeFileSync(lockFile(dir, "/wt/a"), JSON.stringify(heldByOther()))
    let ran = false
    const out = await lockedWorktreeRemoval(dir, "/wt/a", { sessionID: "s", waitMs: 60 }, {
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
    chmodSync(join(dir, "opencode"), 0o555) // check-test-executables: directory permission, not a script
    try {
      expect(holdsState(dir, "/wt/a", 1)).toContain("not writable")
    } finally {
      chmodSync(join(dir, "opencode"), 0o755) // check-test-executables: directory permission, not a script
    }
  })

  test("a holds directory that is readable but not writable is unsafe even with only expired records", () => {
    if (process.getuid?.() === 0) return
    const dir = common()
    setHold(dir, "/wt/a", "s", [{ kind: "shell", id: "x" }], 1) // long expired by `now` below
    const holdsRoot = join(dir, "opencode", "holds")
    const holds = join(holdsRoot, readdirSync(holdsRoot)[0] as string)
    chmodSync(holds, 0o555) // check-test-executables: directory permission, not a script
    try {
      expect(holdsState(dir, "/wt/a", 1 + HOLD_EXPIRY_MS + 1)).toContain("not writable")
    } finally {
      chmodSync(holds, 0o755) // check-test-executables: directory permission, not a script
    }
    expect(holdsState(dir, "/wt/a", 1 + HOLD_EXPIRY_MS + 1)).toBeUndefined()
  })

  test("opencode/ writable but opencode/holds read-only and the worktree's directory missing: unsafe", () => {
    if (process.getuid?.() === 0) return
    const dir = common()
    mkdirSync(join(dir, "opencode", "holds"), { recursive: true })
    chmodSync(join(dir, "opencode", "holds"), 0o555) // check-test-executables: directory permission, not a script
    try {
      // The probe used to land in opencode/ (writable) and call this safe; the exact holds directory cannot be created.
      expect(holdsState(dir, "/wt/a", 1)).toContain("not writable")
    } finally {
      chmodSync(join(dir, "opencode", "holds"), 0o755) // check-test-executables: directory permission, not a script
    }
    expect(holdsState(dir, "/wt/a", 1)).toBeUndefined()
  })

  test("a live hold blocks even when the store is writable", () => {
    const dir = common()
    setHold(dir, "/wt/a", "s", [{ kind: "shell", id: "x" }], 10)
    expect(holdsState(dir, "/wt/a", 11)).toContain("background job")
  })
})
