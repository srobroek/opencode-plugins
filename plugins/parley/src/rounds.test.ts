import { describe, expect, test } from "bun:test"
import { Presence } from "./presence.ts"
import type { Question } from "./questions.ts"
import { collect, Rounds, settled, view, waitFor } from "./rounds.ts"

const q = (id: string): Question => ({
  id,
  title: id,
  kind: "confirm",
  recommended: "yes",
})

const fresh = () => {
  let n = 0
  return new Rounds(() => `rnd_${++n}`)
}

describe("Rounds", () => {
  test("opens, joins and numbers rounds per session", () => {
    const rounds = fresh()
    const first = rounds.open("s1", { questions: [q("a")] }, 1)
    expect("round" in first && first.round.number).toBe(1)
    const joined = rounds.open("s1", { questions: [q("b")] }, 2)
    expect("round" in joined && joined.joined).toBe(true)
    expect(rounds.current("s1")?.questions.map((x) => x.id)).toEqual(["a", "b"])
    expect(rounds.open("s1", { questions: [q("a")] }, 3)).toHaveProperty("errors")
    const other = rounds.open("s2", { questions: [q("a")] }, 3)
    expect("round" in other && other.round.number).toBe(1)
  })

  test("partial submit closes the round and leaves the rest pending", () => {
    const rounds = fresh()
    rounds.open("s", { questions: [q("a"), q("b"), q("c")], round: 3 }, 0)
    const round = rounds.current("s")
    if (!round) throw new Error("no round")
    expect(rounds.submit(round.id, [{ id: "a", status: "accepted" }, { id: "b", status: "deferred" }], true, 1).ok).toBe(true)
    const result = collect(round)
    expect(result.status).toBe("submitted")
    expect(result.round).toBe(3)
    expect(result.answers.map((a) => [a.id, a.status])).toEqual([
      ["a", "accepted"],
      ["b", "deferred"],
    ])
    expect(result.pending).toEqual(["c"])
    expect(collect(round).answers).toEqual([])
    expect(rounds.submit(round.id, [], true, 2).ok).toBe(false)
  })

  test("a submission with an invalid entry is rejected whole", () => {
    const rounds = fresh()
    rounds.open("s", { questions: [q("a"), q("b")] }, 0)
    const round = rounds.current("s")
    if (!round) throw new Error("no round")
    const outcome = rounds.submit(
      round.id,
      [
        { id: "a", status: "accepted" },
        { id: "b", status: "answered", value: { choice: "maybe" } },
      ],
      true,
      1,
    )
    expect(outcome.ok).toBe(false)
    expect(round.answers.size).toBe(0)
    expect(round.status).toBe("open")
  })

  test("settled and non-final submits", () => {
    const rounds = fresh()
    rounds.open("s", { questions: [q("a"), q("b")] }, 0)
    const round = rounds.current("s")
    if (!round) throw new Error("no round")
    expect(settled(round, "none")).toBe(true)
    expect(settled(round, "any")).toBe(false)
    rounds.submit(round.id, [{ id: "a", status: "accepted" }], false, 1)
    expect(settled(round, "any")).toBe(true)
    expect(settled(round, "all")).toBe(false)
    expect(settled(round, "all", ["a"])).toBe(true)
    expect(collect(round).status).toBe("partial")
    expect(collect(round, { timedOut: true }).status).toBe("timeout")
  })

  test("cancel and view", () => {
    const rounds = fresh()
    rounds.open("s", { questions: [q("a")], title: "Plan" }, 0)
    const round = rounds.current("s")
    if (!round) throw new Error("no round")
    expect(view(round)).toMatchObject({ roundID: "rnd_1", title: "Plan", status: "open" })
    expect(rounds.cancel(round.id, "aborted", 1)).toBe(true)
    expect(collect(round)).toMatchObject({ status: "cancelled", reason: "aborted", pending: ["a"] })
    expect(rounds.pending()).toEqual([])
    rounds.sweep(10_000, 1000)
    expect(rounds.get(round.id)).toBeUndefined()
  })
})

describe("waitFor", () => {
  test("resolves on submit, timeout and abort", async () => {
    const rounds = fresh()
    rounds.open("s", { questions: [q("a")] }, 0)
    const round = rounds.current("s")
    if (!round) throw new Error("no round")
    expect(await waitFor(rounds, round, { mode: "all", timeoutMs: 10 })).toBe("timeout")
    const controller = new AbortController()
    const aborted = waitFor(rounds, round, { mode: "all", timeoutMs: 0, signal: controller.signal })
    controller.abort()
    expect(await aborted).toBe("aborted")
    const waiting = waitFor(rounds, round, { mode: "all", timeoutMs: 1000 })
    rounds.submit(round.id, [{ id: "a", status: "accepted" }], true, 1)
    expect(await waiting).toBe("settled")
  })
})

describe("Presence", () => {
  test("counts clients seen within the window", () => {
    const presence = new Presence(30_000)
    expect(presence.attached(0)).toBe(false)
    presence.attach("tui", 1000)
    expect(presence.attached(30_000)).toBe(true)
    expect(presence.attached(31_001)).toBe(false)
    presence.attach("tui", 40_000, ["s1"])
    expect(presence.attached(40_000, "s1")).toBe(true)
    expect(presence.attached(40_000, "s2")).toBe(false)
    presence.detach("tui")
    expect(presence.attached(40_000)).toBe(false)
  })
})
