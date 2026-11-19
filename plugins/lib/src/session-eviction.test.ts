import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canonicalCheckout,
  evictSessions,
  insideDirectory,
  listProjectSessions,
  pathExists,
  repairStrandedSessions,
  type SessionLike,
  sessionRunning,
} from "./session-eviction.ts"

const idle = { busy: 1, idle: 2 }
const session = (id: string, directory: string, time: SessionLike["time"] = idle, projectID = "prj"): SessionLike => ({
  id,
  projectID,
  location: { directory },
  time,
})
const archived = (id: string, directory: string, time: SessionLike["time"] = idle) => session(id, directory, { ...time, archived: 3 })

/** A fake `ctx.session` with pages of `sessions`, recording moves. */
const api = (
  pages: SessionLike[][],
  over: { move?: (input: { sessionID: string; directory: string }) => Promise<void>; list?: () => Promise<unknown>; ignoreProject?: boolean } = {},
) => {
  const moves: Array<{ sessionID: string; directory: string }> = []
  const queries: Array<Record<string, unknown>> = []
  const ignoreProject = over.ignoreProject === true
  return {
    moves,
    queries,
    list:
      over.list ??
      (async (query: { cursor?: string; archived?: boolean; project?: string }) => {
        queries.push(query)
        const index = query.cursor === undefined ? 0 : Number(query.cursor)
        // The real API: `archived: true` lists archived sessions, `archived: false` the others; `project` filters.
        const visible = (pages[index] ?? []).filter((entry) => {
          const isArchived = (entry.time as { archived?: unknown } | undefined)?.archived !== undefined
          if (query.archived === true && !isArchived) return false
          if (query.archived === false && isArchived) return false
          if (query.project !== undefined && entry.projectID !== query.project && !ignoreProject) return false
          return true
        })
        return { data: visible, ...(index + 1 < pages.length ? { cursor: { next: String(index + 1) } } : {}) }
      }),
    move: async (input: { sessionID: string; directory: string }) => {
      await over.move?.(input)
      moves.push(input)
    },
  } as { moves: typeof moves; queries: typeof queries; list: never; move: never }
}

describe("pure helpers", () => {
  test("sessionRunning: busy after idle, or busy with no idle", () => {
    expect(sessionRunning({ time: { busy: 5, idle: 2 } })).toBe(true)
    expect(sessionRunning({ time: { busy: 5 } })).toBe(true)
    expect(sessionRunning({ time: { busy: 1, idle: 2 } })).toBe(false)
    expect(sessionRunning({})).toBe(false)
  })

  test("an archived session counts as idle, whatever its times say", () => {
    expect(sessionRunning({ time: { busy: 9, idle: 2, archived: 3 } })).toBe(false)
  })

  test("insideDirectory: the directory itself and below it, never a sibling with the same prefix", () => {
    expect(insideDirectory("/wt/a", "/wt/a")).toBe(true)
    expect(insideDirectory("/wt/a/sub/dir", "/wt/a")).toBe(true)
    expect(insideDirectory("/wt/ab", "/wt/a")).toBe(false)
  })

  test("canonicalCheckout: the parent of .git, else the fallback", () => {
    expect(canonicalCheckout("/repo/.git", "/fallback")).toBe("/repo")
    expect(canonicalCheckout("/store/repo.git", "/fallback")).toBe("/fallback")
    expect(canonicalCheckout(undefined, "/fallback")).toBe("/fallback")
  })
})

describe("listProjectSessions", () => {
  test("reads every page", async () => {
    const found = await listProjectSessions(api([[session("a", "/x")], [session("b", "/y")]]), "prj")
    expect(found?.map((entry) => entry.id)).toEqual(["a", "b"])
  })

  test("archived sessions are listed too, once", async () => {
    const fake = api([[session("live", "/x"), archived("old", "/y")]])
    const found = await listProjectSessions(fake, "prj")
    expect(found?.map((entry) => entry.id).sort()).toEqual(["live", "old"])
  })

  test("an error or a malformed page is unknown, not empty", async () => {
    expect(await listProjectSessions(api([], { list: async () => Promise.reject(new Error("down")) }), "prj")).toBeUndefined()
    expect(await listProjectSessions(api([], { list: async () => ({ data: "nope" }) }), "prj")).toBeUndefined()
  })
})

describe("evictSessions", () => {
  const options = { projectID: "prj", directory: "/wt/a", destination: "/repo" }

  test("an idle session inside is moved to the destination, one outside is left", async () => {
    const fake = api([[session("in", "/wt/a"), session("deeper", "/wt/a/pkg"), session("out", "/wt/other")]])
    const result = await evictSessions(fake, options)
    expect(result).toEqual({ ok: true, moved: ["in", "deeper"] })
    expect(fake.moves).toEqual([
      { sessionID: "in", directory: "/repo" },
      { sessionID: "deeper", directory: "/repo" },
    ])
  })

  test("a running session inside blocks, and nothing is moved", async () => {
    const fake = api([[session("idle", "/wt/a"), session("busy", "/wt/a", { busy: 9, idle: 2 })]])
    const result = await evictSessions(fake, options)
    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.reason).toContain("busy is running")
    expect(fake.moves).toEqual([])
  })

  test("a failed move blocks and says which session", async () => {
    const fake = api([[session("in", "/wt/a")]], { move: async () => Promise.reject(new Error("refused")) })
    const result = await evictSessions(fake, options)
    expect(result.ok === false && result.reason).toContain("session in could not be moved")
    expect(result.ok === false && result.reason).toContain("nothing was removed")
  })

  test("an incomplete listing blocks: who is inside is unknown", async () => {
    const result = await evictSessions(api([], { list: async () => Promise.reject(new Error("down")) }), options)
    expect(result.ok === false && result.reason).toContain("could not all be listed")
  })

  test("a session on the second page is found", async () => {
    const fake = api([[session("p1", "/elsewhere")], [session("p2", "/wt/a")]])
    expect(await evictSessions(fake, options)).toEqual({ ok: true, moved: ["p2"] })
  })

  test("an archived idle session inside is moved too, so unarchiving it later does not fail", async () => {
    const fake = api([[archived("shelved", "/wt/a"), session("in", "/wt/a")]])
    expect(await evictSessions(fake, options)).toEqual({ ok: true, moved: ["in", "shelved"] })
    expect(fake.moves.map((move) => move.sessionID).sort()).toEqual(["in", "shelved"])
  })

  test("an archived session never blocks as running", async () => {
    const fake = api([[archived("shelved", "/wt/a", { busy: 9, idle: 2 })]])
    expect(await evictSessions(fake, options)).toEqual({ ok: true, moved: ["shelved"] })
  })

  test("excluded sessions (a lane child moved home separately) are skipped", async () => {
    const fake = api([[session("child", "/wt/a"), session("other", "/wt/a")]])
    expect(await evictSessions(fake, { ...options, exclude: new Set(["child"]) })).toEqual({ ok: true, moved: ["other"] })
  })
})

describe("repairStrandedSessions", () => {
  const present = new Set(["/repo", "/wt/alive"])
  const exists = (path: string) => present.has(path)
  const base = { projectID: "prj", destinationsFor: () => ["/repo"], exists }

  test("moves a session whose directory is gone and leaves one whose directory exists", async () => {
    const fake = api([[session("stranded", "/wt/gone"), session("fine", "/wt/alive")]])
    const log: string[] = []
    const result = await repairStrandedSessions(fake, { ...base, log: (line) => log.push(line) })
    expect(result).toEqual({ moved: [{ sessionID: "stranded", from: "/wt/gone", to: "/repo" }], failed: [] })
    expect(fake.moves).toEqual([{ sessionID: "stranded", directory: "/repo" }])
    expect(log).toEqual(["moved session stranded out of /wt/gone (gone) to /repo"])
  })

  test("an archived stranded session is repaired too", async () => {
    const fake = api([[archived("shelved", "/wt/gone")]])
    const result = await repairStrandedSessions(fake, base)
    expect(result).toMatchObject({ moved: [{ sessionID: "shelved" }] })
  })

  test("a running stranded session is never moved", async () => {
    const fake = api([[session("busy", "/wt/gone", { busy: 9, idle: 2 }), session("idle", "/wt/gone2")]])
    const result = await repairStrandedSessions(fake, base)
    expect(fake.moves.map((move) => move.sessionID)).toEqual(["idle"])
    expect(result).toMatchObject({ moved: [{ sessionID: "idle" }] })
  })

  test.each(["EACCES", "EIO", "ELOOP"])("a %s from the existence check is unknown, not gone: nothing is moved", async (code) => {
    const fake = api([[session("unsure", "/wt/unreadable")]])
    const log: string[] = []
    const result = await repairStrandedSessions(fake, {
      ...base,
      exists: async () => {
        throw Object.assign(new Error("cannot stat"), { code })
      },
      log: (line) => log.push(line),
    })
    expect(fake.moves).toEqual([])
    expect(result).toEqual({ moved: [], failed: [] })
    expect(log.join("\n")).toContain("could not be checked")
  })

  test("a stranded session of another project is excluded (the query filters)", async () => {
    const fake = api([[session("mine", "/wt/gone"), session("theirs", "/wt/gone", idle, "other")]])
    await repairStrandedSessions(fake, base)
    expect(fake.moves.map((move) => move.sessionID)).toEqual(["mine"])
    expect(fake.queries.every((query) => query.project === "prj")).toBe(true)
  })

  test("and again if the host's listing ignores the project filter: the result is filtered locally", async () => {
    const fake = api([[session("mine", "/wt/gone"), session("theirs", "/wt/gone", idle, "other")]], { ignoreProject: true })
    await repairStrandedSessions(fake, base)
    expect(fake.moves.map((move) => move.sessionID)).toEqual(["mine"])
  })

  test("a failed move is reported and the others still go", async () => {
    const fake = api([[session("a", "/wt/gone1"), session("b", "/wt/gone2")]], {
      move: async (input) => {
        if (input.sessionID === "a") throw new Error("nope")
      },
    })
    const result = await repairStrandedSessions(fake, base)
    expect(result).toMatchObject({ moved: [{ sessionID: "b" }], failed: [{ sessionID: "a", reason: "nope" }] })
  })

  test("a listing that cannot be read repairs nothing", async () => {
    const result = await repairStrandedSessions(api([], { list: async () => Promise.reject(new Error("down")) }), base)
    expect(result).toHaveProperty("error")
  })

  test("the destination is the first candidate that exists: a missing parent checkout falls through", async () => {
    const fake = api([[session("a", "/wt/gone")]])
    const log: string[] = []
    const result = await repairStrandedSessions(fake, {
      ...base,
      destinationsFor: () => ["/gone/parent-checkout", "/repo"],
      log: (line) => log.push(line),
    })
    expect(fake.moves).toEqual([{ sessionID: "a", directory: "/repo" }])
    expect(result).toMatchObject({ moved: [{ to: "/repo" }] })
  })

  test("a candidate inside a removed worktree does not exist and is skipped like any other", async () => {
    const fake = api([[session("a", "/wt/gone")]])
    await repairStrandedSessions(fake, { ...base, destinationsFor: () => ["/wt/gone/sub", "/repo"] })
    expect(fake.moves).toEqual([{ sessionID: "a", directory: "/repo" }])
  })

  test("with no destination that exists the session is left alone and the failure is reported", async () => {
    const fake = api([[session("a", "/wt/gone")]])
    const result = await repairStrandedSessions(fake, { ...base, destinationsFor: () => ["/nope", "/nowhere"] })
    expect(fake.moves).toEqual([])
    expect(result).toMatchObject({ moved: [], failed: [{ sessionID: "a" }] })
    expect((result as { failed: Array<{ reason: string }> }).failed[0]?.reason).toContain("no existing destination")
  })

  test("the destination can depend on the session", async () => {
    const present2 = new Set(["/repo-for-a"])
    const fake = api([[session("a", "/wt/gone")]])
    await repairStrandedSessions(fake, { ...base, exists: (path) => present2.has(path), destinationsFor: (entry) => [`/repo-for-${entry.id}`] })
    expect(fake.moves).toEqual([{ sessionID: "a", directory: "/repo-for-a" }])
  })
})

describe("pathExists", () => {
  test("present, and gone only on ENOENT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exists-"))
    try {
      expect(await pathExists(dir)).toBe(true)
      expect(await pathExists(join(dir, "missing"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("any other error throws instead of reading as gone", async () => {
    if (process.getuid?.() === 0) return
    const dir = mkdtempSync(join(tmpdir(), "exists-"))
    mkdirSync(join(dir, "locked"))
    chmodSync(join(dir, "locked"), 0o000) // check-test-executables: directory permission, not a script
    try {
      await expect(pathExists(join(dir, "locked", "inside"))).rejects.toMatchObject({ code: "EACCES" })
    } finally {
      chmodSync(join(dir, "locked"), 0o755) // check-test-executables: directory permission, not a script
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
