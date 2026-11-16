import { describe, expect, test } from "bun:test"
import { OPEN_TTL_MS, roundKey, type StoredRound, toStored } from "./persist.ts"
import type { Question } from "./questions.ts"
import { RELOADED_REASON, type Round } from "./rounds.ts"
import { CLOSED_TTL_MS, deliveryText, Parley, type RoundStore, type SessionMessage, type Settings } from "./service.ts"

const settings: Settings = { fallback: "none", questionTool: "takeover", disabled: false, heartbeatWindowMs: 30_000 }
const questions: Question[] = [
  { id: "ssh.host", title: "SSH hostname", kind: "pick_one", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], recommended: "a" },
  { id: "ssh.port", title: "Port", kind: "slider", min: 0, max: 100, recommended: 22 },
]

function fakeStore(initial: StoredRound[] = []) {
  const data = new Map<string, unknown>(initial.map((round) => [roundKey(round.id), round]))
  const store: RoundStore = {
    list: async () => [...data.values()],
    save: async (round) => void data.set(roundKey(round.id), JSON.parse(JSON.stringify(round))),
    remove: async (id) => void data.delete(roundKey(id)),
  }
  return { data, store }
}

function instance(store: RoundStore, now: () => number = () => 1_000) {
  const messages: SessionMessage[] = []
  const service = new Parley({ settings, emit: async () => {}, store, now, deliver: async (message) => void messages.push(message) })
  service.attach({ clientID: "tui" })
  return { service, messages }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** A plugin reload: the first instance is disposed, a second one starts on the same storage. */
async function reload(first: ReturnType<typeof instance>, store: RoundStore, now?: () => number) {
  first.service.suspend()
  await first.service.flush()
  const second = instance(store, now)
  await second.service.restore()
  return second
}

describe("reload", () => {
  test("a live wait ends as unavailable on dispose and the round stays open", async () => {
    const { store } = fakeStore()
    const first = instance(store)
    const asking = first.service.ask({ questions, title: "SSH" }, { sessionID: "s" })
    await tick()
    first.service.suspend()
    const { result } = await asking
    expect(result).toMatchObject({ status: "unavailable", reason: RELOADED_REASON, round: 1, pending: ["ssh.host", "ssh.port"] })
    expect(first.service.rounds.current("s")?.status).toBe("open")
  })

  test("an open round, its answers so far and its delivery state survive a reload", async () => {
    const { store } = fakeStore()
    const first = instance(store)
    const asking = first.service.ask({ questions, title: "SSH", wait: "any" }, { sessionID: "s" })
    await tick()
    const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
    await first.service.submit({ roundID, answers: [{ id: "ssh.host", status: "accepted" }], final: false })
    await asking
    const second = await reload(first, store)
    const [round] = second.service.pending({ sessionID: "s" }).rounds
    expect(round).toMatchObject({ roundID, number: 1, title: "SSH", status: "open", sessionID: "s" })
    expect(round?.questions.map((question) => question.id)).toEqual(["ssh.host", "ssh.port"])
    expect(round?.answers.map((answer) => answer.id)).toEqual(["ssh.host"])
    // The answer was returned by the first instance's wait, so it is not delivered again.
    expect(second.service.rounds.get(roundID)?.delivered.has("ssh.host")).toBe(true)
  })

  test("the final submit to a restored round reaches the session as a message in the tool-result format", async () => {
    const { store } = fakeStore()
    const first = instance(store)
    void first.service.ask({ questions, title: "SSH" }, { sessionID: "s" })
    await tick()
    const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
    const second = await reload(first, store)
    const outcome = await second.service.submit({
      roundID,
      answers: [
        { id: "ssh.host", status: "answered", value: { selected: "b" }, note: "use the bastion" },
        { id: "ssh.port", status: "accepted" },
      ],
    })
    expect(outcome).toMatchObject({ ok: true, errors: [] })
    expect(second.messages).toHaveLength(1)
    const [message] = second.messages
    expect(message?.sessionID).toBe("s")
    const lines = message?.text.split("\n") ?? []
    expect(lines[0]).toContain("The parley plugin reloaded")
    expect(lines).toContain("Parley round 1: submitted — 2 answers, 0 pending")
    expect(message?.text).toContain("ssh.host")
    expect(message?.text).toContain("Beta")
    expect(message?.text).toContain("use the bastion")
    expect(message?.text).toContain("ssh.port")
    expect(second.service.rounds.get(roundID)?.status).toBe("submitted")
  })

  test("dismissing a restored round tells the session", async () => {
    const { store } = fakeStore()
    const first = instance(store)
    void first.service.ask({ questions }, { sessionID: "s" })
    await tick()
    const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
    const second = await reload(first, store)
    await second.service.cancel({ roundID })
    expect(second.messages[0]?.text).toContain("Parley round 1: cancelled (user_closed)")
  })

  test("parley_wait on a restored round gets the answers itself, without a message", async () => {
    const { store } = fakeStore()
    const first = instance(store)
    void first.service.ask({ questions }, { sessionID: "s" })
    await tick()
    const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
    const second = await reload(first, store)
    const waiting = second.service.wait({}, { sessionID: "s" })
    await tick()
    await second.service.submit({ roundID, answers: [{ id: "ssh.host", status: "accepted" }, { id: "ssh.port", status: "accepted" }] })
    expect((await waiting).result).toMatchObject({ status: "submitted", round: 1 })
    expect((await waiting).result.answers.map((answer) => answer.id)).toEqual(["ssh.host", "ssh.port"])
    expect(second.messages).toEqual([])
  })

  test("a round opened in the new instance is waited on as before and sends no message", async () => {
    const { store } = fakeStore()
    const { service, messages } = instance(store)
    const asking = service.ask({ questions }, { sessionID: "s" })
    await tick()
    const roundID = service.pending({}).rounds[0]?.roundID ?? ""
    await service.submit({ roundID, answers: [{ id: "ssh.host", status: "accepted" }, { id: "ssh.port", status: "accepted" }] })
    expect((await asking).result.status).toBe("submitted")
    expect(messages).toEqual([])
  })

  test("a failed delivery keeps the answers for parley_wait", async () => {
    const { store } = fakeStore()
    const first = instance(store)
    void first.service.ask({ questions }, { sessionID: "s" })
    await tick()
    const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
    first.service.suspend()
    await first.service.flush()
    const service = new Parley({ settings, emit: async () => {}, store, now: () => 1_000, deliver: async () => { throw new Error("offline") } })
    service.attach({ clientID: "tui" })
    await service.restore()
    const outcome = await service.submit({ roundID, answers: [{ id: "ssh.host", status: "accepted" }, { id: "ssh.port", status: "accepted" }] })
    expect(outcome.errors[0]).toContain("offline")
    expect((await service.wait({}, { sessionID: "s" })).result.answers).toHaveLength(2)
  })

  test("deliver sends answers for a round the server never stored", async () => {
    const { store } = fakeStore()
    const { service, messages } = instance(store)
    const outcome = await service.deliver({
      sessionID: "s",
      number: 3,
      questions,
      answers: [{ id: "ssh.host", status: "answered", value: { selected: "a" } }],
    })
    expect(outcome.ok).toBe(true)
    expect(messages[0]?.text).toContain("Parley round 3: submitted — 1 answer, 1 pending")
    expect(messages[0]?.text).toContain("Pending: ssh.port")
    expect((await service.deliver({ sessionID: "s", questions, answers: [{ id: "nope", status: "accepted" }] })).ok).toBe(false)
  })
})

describe("pruning", () => {
  const stored = (id: string, status: StoredRound["status"], updated: number): StoredRound => {
    const round: Round = {
      id, sessionID: id, number: 1, questions, answers: new Map(), delivered: new Set(), callIDs: [], status, created: updated, updated,
    }
    return toStored(round)
  }

  test("old open rounds and closed rounds past the ttl are dropped at restore, the rest kept", async () => {
    const now = 100 * 60 * 60_000
    const { data, store } = fakeStore([
      stored("old_open", "open", now - OPEN_TTL_MS - 1),
      stored("new_open", "open", now - OPEN_TTL_MS + 1000),
      stored("old_closed", "submitted", now - CLOSED_TTL_MS - 1),
      stored("new_closed", "cancelled", now - 1000),
    ])
    data.set("round:garbage", { nonsense: true })
    const { service } = instance(store, () => now)
    await service.restore()
    await service.flush()
    expect(service.pending({}).rounds.map((round) => round.roundID)).toEqual(["new_open"])
    expect(service.rounds.get("new_closed")?.status).toBe("cancelled")
    expect(service.rounds.get("old_open")).toBeUndefined()
    expect(service.rounds.get("old_closed")).toBeUndefined()
    expect([...data.keys()].sort()).toEqual(["round:garbage", "round:new_closed", "round:new_open"])
  })

  test("upload bytes are not stored", () => {
    const round: Round = {
      id: "r", sessionID: "s", number: 1, questions, delivered: new Set(), callIDs: [], status: "open", created: 1, updated: 1,
      answers: new Map([["ssh.host", { id: "ssh.host", status: "answered", value: { files: [{ name: "k.pem", mime: "text/plain", size: 3, data: "c2VjcmV0" }] } }]]),
    }
    expect(JSON.stringify(toStored(round))).not.toContain("c2VjcmV0")
  })
})

test("deliveryText leads with the reload notice, then the normal result summary", () => {
  const text = deliveryText({ status: "submitted", round: 2, answers: [], pending: [] }, questions)
  expect(text.endsWith("\n\nParley round 2: submitted — 0 answers, 0 pending")).toBe(true)
})
