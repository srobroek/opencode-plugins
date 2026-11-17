import { describe, expect, test } from "bun:test"
import {
  canonicalCheckout,
  evictSessions,
  insideDirectory,
  listProjectSessions,
  repairStrandedSessions,
  type SessionLike,
  sessionRunning,
} from "./session-eviction.ts"

const idle = { busy: 1, idle: 2 }
const session = (id: string, directory: string, time: SessionLike["time"] = idle): SessionLike => ({ id, location: { directory }, time })

/** A fake `ctx.session` with pages of `sessions`, recording moves. */
const api = (pages: SessionLike[][], over: { move?: (input: { sessionID: string; directory: string }) => Promise<void>; list?: () => Promise<unknown> } = {}) => {
  const moves: Array<{ sessionID: string; directory: string }> = []
  return {
    moves,
    list: over.list ?? (async (query: { cursor?: string }) => {
      const index = query.cursor === undefined ? 0 : Number(query.cursor)
      return { data: pages[index] ?? [], ...(index + 1 < pages.length ? { cursor: { next: String(index + 1) } } : {}) }
    }),
    move: async (input: { sessionID: string; directory: string }) => {
      await over.move?.(input)
      moves.push(input)
    },
  } as { moves: typeof moves; list: never; move: never }
}

describe("pure helpers", () => {
  test("sessionRunning: busy after idle, or busy with no idle", () => {
    expect(sessionRunning({ time: { busy: 5, idle: 2 } })).toBe(true)
    expect(sessionRunning({ time: { busy: 5 } })).toBe(true)
    expect(sessionRunning({ time: { busy: 1, idle: 2 } })).toBe(false)
    expect(sessionRunning({})).toBe(false)
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

  test("excluded sessions (a lane child moved home separately) are skipped", async () => {
    const fake = api([[session("child", "/wt/a"), session("other", "/wt/a")]])
    expect(await evictSessions(fake, { ...options, exclude: new Set(["child"]) })).toEqual({ ok: true, moved: ["other"] })
  })
})

describe("repairStrandedSessions", () => {
  const present = new Set(["/repo", "/wt/alive"])
  const exists = (path: string) => present.has(path)
  const base = { projectID: "prj", destinationFor: () => "/repo", exists }

  test("moves a session whose directory is gone and leaves one whose directory exists", async () => {
    const fake = api([[session("stranded", "/wt/gone"), session("fine", "/wt/alive")]])
    const log: string[] = []
    const result = await repairStrandedSessions(fake, { ...base, log: (line) => log.push(line) })
    expect(result).toEqual({ moved: [{ sessionID: "stranded", from: "/wt/gone", to: "/repo" }], failed: [] })
    expect(fake.moves).toEqual([{ sessionID: "stranded", directory: "/repo" }])
    expect(log).toEqual(["moved session stranded out of /wt/gone (gone) to /repo"])
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

  test("the destination can depend on the session", async () => {
    const fake = api([[session("a", "/wt/gone")]])
    await repairStrandedSessions(fake, { ...base, destinationFor: (entry) => `/repo-for-${entry.id}` })
    expect(fake.moves).toEqual([{ sessionID: "a", directory: "/repo-for-a" }])
  })
})
