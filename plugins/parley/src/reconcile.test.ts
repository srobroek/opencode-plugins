import { describe, expect, test } from "bun:test"
import { instanceChanged, reconcileRounds } from "./reconcile.ts"
import type { RoundView } from "./rounds.ts"

const view = (roundID: string): RoundView => ({ roundID, sessionID: `s_${roundID}`, number: 1, status: "open", questions: [], answers: [] })
const entry = (roundID: string) => ({ view: view(roundID) })
const merge = (current: string[], server: string[], reloaded: boolean, lost: string[] = []) =>
  reconcileRounds({ current: current.map(entry), server: server.map(view), lost: new Set(lost), reloaded, toEntry: (v) => ({ view: v }) })

describe("reconcileRounds", () => {
  test("a round closed elsewhere drops with its draft", () => {
    const merged = merge(["r1", "r2"], ["r2"], false)
    expect(merged.entries.map((e) => e.view.roundID)).toEqual(["r2"])
    expect(merged.forget).toEqual(["r1"])
  })

  test("after a reload a round the server no longer lists stays, and its draft is not forgotten", () => {
    const merged = merge(["r1", "r2"], ["r2"], true)
    expect(merged.entries.map((e) => e.view.roundID).sort()).toEqual(["r1", "r2"])
    expect(merged.forget).toEqual([])
    expect([...merged.lost]).toEqual(["r1"])
  })

  test("a lost round survives later ordinary refreshes until it is recovered", () => {
    const merged = merge(["r1"], [], false, ["r1"])
    expect(merged.entries.map((e) => e.view.roundID)).toEqual(["r1"])
    expect(merged.forget).toEqual([])
  })

  test("a lost round the server lists again is no longer lost", () => {
    const merged = merge(["r1"], ["r1"], false, ["r1"])
    expect([...merged.lost]).toEqual([])
    expect(merged.entries).toHaveLength(1)
  })

  test("a restored round is replaced by the server's copy and keeps no stale state", () => {
    const fresh = { ...view("r1"), answers: [{ id: "q", status: "answered" as const }] }
    const merged = reconcileRounds({ current: [entry("r1")], server: [fresh], lost: new Set(), reloaded: true, toEntry: (v) => ({ view: v }) })
    expect(merged.entries).toEqual([{ view: fresh }])
    expect(merged.forget).toEqual([])
    expect([...merged.lost]).toEqual([])
  })
})

describe("instanceChanged", () => {
  test("the first answer from a location is not a change; a different instance is", () => {
    const known = new Map<string, string>()
    expect(instanceChanged(known, "/repo", "i1")).toBe(false)
    expect(instanceChanged(known, "/repo", "i1")).toBe(false)
    expect(instanceChanged(known, "/repo", "i2")).toBe(true)
    expect(instanceChanged(known, "/repo", "i2")).toBe(false)
  })

  test("a server that reports no instance is never a change", () => {
    expect(instanceChanged(new Map([["/repo", "i1"]]), "/repo", undefined)).toBe(false)
  })

  test("locations are tracked apart", () => {
    const known = new Map<string, string>()
    instanceChanged(known, "/a", "i1")
    expect(instanceChanged(known, "/b", "i9")).toBe(false)
  })
})
