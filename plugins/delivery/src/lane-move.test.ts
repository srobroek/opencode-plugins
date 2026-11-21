import { describe, expect, test } from "bun:test"
import { laneSessionsIn, moveLaneHome } from "./lane-move.ts"

type Row = { id: string; parentID?: string; directory: string }

// An in-memory session store behind the three client calls the module uses.
function store(rows: Row[], fail: { move?: Set<string>; list?: boolean; get?: Set<string> } = {}) {
  const moves: Array<{ sessionID: string; directory: string }> = []
  const lists: string[] = []
  const client = {
    list: async (query: { parentID: string }) => {
      lists.push(query.parentID)
      if (fail.list) throw new Error("list down")
      return { data: rows.filter((row) => row.parentID === query.parentID).map((row) => ({ id: row.id })) }
    },
    get: async (input: { sessionID: string }) => {
      if (fail.get?.has(input.sessionID)) throw new Error("Location not found")
      const row = rows.find((candidate) => candidate.id === input.sessionID)
      if (row === undefined) throw Object.assign(new Error("Session not found"), { name: "SessionNotFoundError", sessionID: input.sessionID })
      return { id: row.id, location: { directory: row.directory } }
    },
    move: async (input: { sessionID: string; directory: string }) => {
      moves.push(input)
      if (fail.move?.has(input.sessionID)) throw new Error("host refused")
    },
  }
  return { client, moves, lists }
}

describe("laneSessionsIn", () => {
  test("keeps the lane's sessions that sit in the worktree, including nested ones", async () => {
    const s = store([
      { id: "root", directory: "/w/lane" },
      { id: "kid", parentID: "root", directory: "/w/lane/sub" },
      { id: "grandkid", parentID: "kid", directory: "/w/lane" },
    ])
    expect(await laneSessionsIn(s.client, ["root"], ["/w/lane"])).toEqual({ ids: ["root", "kid", "grandkid"], complete: true, problems: [] })
  })

  test("leaves out a lane session that sits elsewhere, and lists only below the given roots", async () => {
    const s = store([
      { id: "lead", directory: "/repo" },
      { id: "mine", parentID: "lead", directory: "/w/lane" },
      { id: "other-lane", parentID: "lead", directory: "/w/other" },
      { id: "sibling-dir", directory: "/w/lane-two" },
    ])
    const lane = await laneSessionsIn(s.client, ["lead"], ["/w/lane"])
    expect(lane.ids).toEqual(["mine"])
    expect(s.lists).toEqual(["lead", "mine", "other-lane"])
  })

  test("a failed listing is reported as incomplete", async () => {
    const s = store([{ id: "root", directory: "/w/lane" }], { list: true })
    expect(await laneSessionsIn(s.client, ["root"], ["/w/lane"])).toEqual({ ids: ["root"], complete: false, problems: [] })
  })
})

describe("laneSessionsIn: a session that cannot be read", () => {
  test("one that does not exist is dropped without a problem", async () => {
    // Listed by its parent, then gone before it is read.
    const s = store([{ id: "root", directory: "/w/lane" }])
    const list = s.client.list
    s.client.list = async (query) => (query.parentID === "root" ? { data: [{ id: "ghost" }] } : list(query))
    expect(await laneSessionsIn(s.client, ["root"], ["/w/lane"])).toEqual({ ids: ["root"], complete: true, problems: [] })
  })

  test("any other read failure keeps the lane incomplete and names the session and the reason", async () => {
    const s = store(
      [
        { id: "root", directory: "/w/lane" },
        { id: "kid", parentID: "root", directory: "/w/lane" },
      ],
      { get: new Set(["kid"]) },
    )
    const lane = await laneSessionsIn(s.client, ["root"], ["/w/lane"])
    expect(lane.ids).toEqual(["root"])
    expect(lane.complete).toBe(false)
    expect(lane.problems).toHaveLength(1)
    expect(lane.problems[0]).toContain("kid")
    expect(lane.problems[0]).toContain("Location not found")
  })

  test("a location named by any of the given forms of the worktree counts as inside", async () => {
    const s = store([{ id: "root", directory: "/private/w/lane/sub" }])
    expect((await laneSessionsIn(s.client, ["root"], ["/w/lane", "/private/w/lane"])).ids).toEqual(["root"])
  })
})

describe("moveLaneHome", () => {
  test("carries the lane's read problems into the notes", async () => {
    const s = store([])
    const notes = await moveLaneHome(s.client, { ids: [], complete: false, problems: ["session kid could not be read: Location not found"] }, "/repo")
    expect(notes).toContain("session kid could not be read: Location not found")
  })

  test("moves each session to the destination and reports nothing when all move", async () => {
    const s = store([])
    expect(await moveLaneHome(s.client, { ids: ["a", "b"], complete: true, problems: [] }, "/repo")).toEqual([])
    expect(s.moves).toEqual([
      { sessionID: "a", directory: "/repo" },
      { sessionID: "b", directory: "/repo" },
    ])
  })

  test("reports a failed move with its reason and still moves the rest", async () => {
    const s = store([], { move: new Set(["a"]) })
    const notes = await moveLaneHome(s.client, { ids: ["a", "b"], complete: true, problems: [] }, "/repo")
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("session a")
    expect(notes[0]).toContain("host refused")
    expect(s.moves.map((move) => move.sessionID)).toEqual(["a", "b"])
  })

  test("reports an incomplete lane listing", async () => {
    const s = store([])
    const notes = await moveLaneHome(s.client, { ids: [], complete: false, problems: [] }, "/repo")
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("incompletely")
  })
})
