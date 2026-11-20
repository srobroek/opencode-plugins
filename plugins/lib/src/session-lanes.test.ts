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

  test("a listing that never ends within the 20-page cap is incomplete", async () => {
    let calls = 0
    const client = tree(
      {},
      {
        list: async (query) => {
          if (query.parentID !== "r") return { data: [] }
          calls++
          return calls <= 20 ? { data: [{ id: `p${calls}` }], cursor: { next: `c${calls}` } } : { data: [{ id: "last" }] }
        },
      },
    )
    const found = await laneSessions(client, "r")
    expect(found.complete).toBe(false)
    expect(found.ids).not.toContain("last")
  })

  test("a non-array page payload is incomplete", async () => {
    const client = tree({}, { list: async () => ({ data: "nope" }) })
    expect(await laneSessions(client, "r")).toEqual({ ids: ["r"], complete: false })
  })

  test("a page entry without a string id makes the listing incomplete and keeps the valid ids", async () => {
    const client = tree({}, { list: async (query) => ({ data: query.parentID === "r" ? [{ id: "a" }, { name: "no id" }, null] : [] }) })
    expect(await laneSessions(client, "r")).toEqual({ ids: ["r", "a"], complete: false })
  })

  test.each([[undefined], [null]])("an absent next cursor (%p) ends paging cleanly", async (next) => {
    const client = tree({}, { list: async (query) => ({ data: query.parentID === "r" ? [{ id: "a" }] : [], cursor: { next } }) })
    expect(await laneSessions(client, "r")).toEqual({ ids: ["r", "a"], complete: true })
  })

  test.each([[0], [false], [""], [{}], [7]])("an invalid next cursor (%p) stops paging as incomplete", async (next) => {
    let calls = 0
    const client = tree(
      {},
      {
        list: async (query) => {
          if (query.parentID === "r") calls++
          return { data: query.parentID === "r" ? [{ id: "a" }] : [], cursor: { next } }
        },
      },
    )
    expect(await laneSessions(client, "r")).toEqual({ ids: ["r", "a"], complete: false })
    expect(calls).toBe(1)
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

  test("a rejection with an odd value is reported with a fixed reason and the rest still move", async () => {
    const client = tree(
      {},
      {
        move: async (input) => {
          if (input.sessionID === "a") throw Object.assign(Object.create(null), { message: 1 })
        },
      },
    )
    expect(await moveSessionsHome(client, ["a", "b"], "/home")).toEqual([
      { id: "a", status: "error", reason: "move failed" },
      { id: "b", status: "moved" },
    ])
  })

  test("a rejection that throws when inspected is reported with a fixed reason and the rest still move", async () => {
    const hostile = {
      get status(): never {
        throw new Error("getter")
      },
    }
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const client = tree(
      {},
      {
        move: async (input) => {
          if (input.sessionID === "a") throw hostile
          if (input.sessionID === "b") throw revoked.proxy
        },
      },
    )
    expect(await moveSessionsHome(client, ["a", "b", "c"], "/home")).toEqual([
      { id: "a", status: "error", reason: "move failed" },
      { id: "b", status: "error", reason: "move failed" },
      { id: "c", status: "moved" },
    ])
  })
})
