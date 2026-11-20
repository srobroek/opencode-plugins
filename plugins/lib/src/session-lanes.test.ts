import { describe, expect, test } from "bun:test"
import { type LaneSessionClient, laneSessions, moveSessionsHome } from "./session-lanes.ts"

// A fake client: `children` maps a parent id to its direct child ids; listings are one page each.
const tree = (children: Record<string, string[]>, over: Partial<LaneSessionClient> = {}): LaneSessionClient => ({
  list: async (query) => ({ data: (children[query.parentID] ?? []).map((id) => ({ id })) }),
  move: async () => {},
  ...over,
})

describe("laneSessions", () => {
  test("returns the root and every descendant, breadth first", async () => {
    const client = tree({ r: ["a", "b"], a: ["c"], b: ["d"], c: ["e"] })
    expect(await laneSessions(client, "r")).toEqual({ ids: ["r", "a", "b", "c", "d", "e"], complete: true })
  })

  test("follows list cursors", async () => {
    const client = tree(
      {},
      {
        list: async (query) =>
          query.parentID !== "r"
            ? { data: [] }
            : query.cursor === undefined
              ? { data: [{ id: "a" }], cursor: { next: "n" } }
              : { data: [{ id: "b" }] },
      },
    )
    expect((await laneSessions(client, "r")).ids).toEqual(["r", "a", "b"])
  })

  test("stops at the depth cap and reports the answer incomplete", async () => {
    const client = tree({ r: ["a"], a: ["b"], b: ["c"] })
    expect(await laneSessions(client, "r", { maxDepth: 2 })).toEqual({ ids: ["r", "a", "b"], complete: false })
  })

  test("a chain of exactly the cap depth is complete", async () => {
    const client = tree({ r: ["a"], a: ["b"] })
    expect(await laneSessions(client, "r", { maxDepth: 2 })).toEqual({ ids: ["r", "a", "b"], complete: true })
  })

  test("defaults to depth 8", async () => {
    const chain: Record<string, string[]> = {}
    for (let i = 0; i < 10; i++) chain[`s${i}`] = [`s${i + 1}`]
    const found = await laneSessions(tree(chain), "s0")
    expect(found.ids).toHaveLength(9)
    expect(found.complete).toBe(false)
  })

  test("a listing that outlasts the timeout is incomplete, keeping what was found", async () => {
    const client = tree(
      {},
      { list: (query) => (query.parentID === "r" ? Promise.resolve({ data: [{ id: "a" }] }) : new Promise(() => {})) },
    )
    expect(await laneSessions(client, "r", { timeoutMs: 20 })).toEqual({ ids: ["r", "a"], complete: false })
  })

  test("a failing listing is incomplete", async () => {
    const client = tree(
      {},
      {
        list: async () => {
          throw new Error("boom")
        },
      },
    )
    expect(await laneSessions(client, "r")).toEqual({ ids: ["r"], complete: false })
  })

  test("a cycle does not repeat ids", async () => {
    expect((await laneSessions(tree({ r: ["a"], a: ["r"] }), "r")).ids).toEqual(["r", "a"])
  })
})

describe("moveSessionsHome", () => {
  test("moves every id to the destination", async () => {
    const moved: unknown[] = []
    const client = tree({}, { move: async (input) => void moved.push(input) })
    expect(await moveSessionsHome(client, ["a", "b"], "/home")).toEqual([
      { id: "a", status: "moved" },
      { id: "b", status: "moved" },
    ])
    expect(moved).toEqual([
      { sessionID: "a", directory: "/home" },
      { sessionID: "b", directory: "/home" },
    ])
  })

  test("reports a missing session and keeps moving the rest", async () => {
    const client = tree(
      {},
      {
        move: async (input) => {
          if (input.sessionID === "a") throw Object.assign(new Error("Session a not found"), { name: "SessionNotFound", sessionID: "a" })
        },
      },
    )
    expect(await moveSessionsHome(client, ["a", "b"], "/home")).toEqual([
      { id: "a", status: "not-found" },
      { id: "b", status: "moved" },
    ])
  })

  test("reports another failure as an error with its message", async () => {
    const client = tree(
      {},
      {
        move: async () => {
          throw new Error("Location not found: /home")
        },
      },
    )
    expect(await moveSessionsHome(client, ["a"], "/home")).toEqual([{ id: "a", status: "error", reason: "Location not found: /home" }])
  })

  test("a session whose source directory is gone moves like any other", async () => {
    // The host resolves the source from the session record, so the client never passes the source path.
    const calls: unknown[] = []
    const client = tree({}, { move: async (input) => void calls.push(input) })
    expect(await moveSessionsHome(client, ["gone"], "/home")).toEqual([{ id: "gone", status: "moved" }])
    expect(calls).toEqual([{ sessionID: "gone", directory: "/home" }])
  })
})
