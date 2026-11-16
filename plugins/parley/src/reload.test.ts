import { describe, expect, test } from "bun:test"
import { summarise } from "./format.ts"
import { MAX_ATTEMPTS, type OutboxEntry, outboxKey } from "./outbox.ts"
import { OPEN_TTL_MS, roundKey, type StoredRound, toStored } from "./persist.ts"
import type { Question } from "./questions.ts"
import { RELOADED_REASON, type Round } from "./rounds.ts"
import { CLOSED_TTL_MS, Parley, type RoundStore, type SessionMessage, type Settings } from "./service.ts"
import { submitRound } from "./submit.ts"

const settings: Settings = { fallback: "none", questionTool: "takeover", disabled: false, heartbeatWindowMs: 30_000 }
const questions: Question[] = [
  { id: "ssh.host", title: "SSH hostname", kind: "pick_one", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], recommended: "a" },
  { id: "ssh.port", title: "Port", kind: "slider", min: 0, max: 100, recommended: 22 },
]
const both = [{ id: "ssh.host", status: "accepted" as const }, { id: "ssh.port", status: "accepted" as const }]

type Data = Map<string, unknown>

/** The plugin's storage as every location sees it: one map. `delayMs` makes each write slow. */
function storeOver(data: Data, directory = "/repo", owns: (sessionID: string) => Promise<boolean> = async () => true, delayMs = 0): RoundStore {
  const slow = () => (delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve())
  return {
    directory,
    owns,
    list: async () => [...data].filter(([key]) => key.startsWith("round:")).map(([, value]) => value),
    save: async (round) => {
      await slow()
      data.set(roundKey(round.id), JSON.parse(JSON.stringify(round)))
    },
    remove: async (id) => {
      await slow()
      data.delete(roundKey(id))
    },
    listOutbox: async () => [...data].filter(([key]) => key.startsWith("outbox:")).map(([, value]) => value),
    saveOutbox: async (entry) => {
      await slow()
      data.set(outboxKey(entry.key), JSON.parse(JSON.stringify(entry)))
    },
    removeOutbox: async (key) => {
      await slow()
      data.delete(outboxKey(key))
    },
  }
}

interface Extras {
  now?: () => number
  save?: (file: { name: string }, roundID?: string) => string | undefined
  dropUploads?: (roundID: string) => void
  warn?: (message: string) => void
  deliver?: (message: SessionMessage) => Promise<void>
}

function instance(store: RoundStore, extras: Extras = {}) {
  const messages: SessionMessage[] = []
  const service = new Parley({
    settings,
    emit: async () => {},
    store,
    now: extras.now ?? (() => 1_000),
    deliver: extras.deliver ?? (async (message) => void messages.push(message)),
    ...(extras.save ? { save: extras.save as never } : {}),
    ...(extras.warn ? { warn: extras.warn } : {}),
    ...(extras.dropUploads ? { dropUploads: extras.dropUploads } : {}),
  })
  service.attach({ clientID: "tui" })
  return { service, messages }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** A plugin reload: the first instance is disposed (which drains its writes), a second starts on the same storage. */
async function reload(first: ReturnType<typeof instance>, store: RoundStore, extras: Extras = {}) {
  await first.service.suspend()
  const second = instance(store, extras)
  await second.service.restore()
  return second
}

async function openRound(extras: Extras = {}, data: Data = new Map()) {
  const store = storeOver(data)
  const first = instance(store, extras)
  const asking = first.service.ask({ questions, title: "SSH" }, { sessionID: "s" })
  await tick()
  const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
  return { data, store, first, asking, roundID }
}

describe("reload", () => {
  test("a live wait ends as unavailable on dispose and the round stays open", async () => {
    const { first, asking } = await openRound()
    first.service.suspend()
    const { result } = await asking
    expect(result).toMatchObject({ status: "unavailable", reason: RELOADED_REASON, round: 1, pending: ["ssh.host", "ssh.port"] })
    expect(first.service.rounds.current("s")?.status).toBe("open")
  })

  test("an open round, its answers so far and its delivery state survive a reload", async () => {
    const store = storeOver(new Map())
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
    expect(second.service.rounds.get(roundID)?.delivered.has("ssh.host")).toBe(true)
  })

  test("the final submit to a restored round reaches the session as a message in the tool-result format", async () => {
    const { store, first, roundID } = await openRound()
    const second = await reload(first, store)
    const outcome = await second.service.submit({
      roundID,
      answers: [{ id: "ssh.host", status: "answered", value: { selected: "b" }, note: "use the bastion" }, { id: "ssh.port", status: "accepted" }],
    })
    expect(outcome).toMatchObject({ ok: true, errors: [] })
    expect(second.messages).toHaveLength(1)
    const [message] = second.messages
    expect(message?.sessionID).toBe("s")
    const lines = message?.text.split("\n") ?? []
    expect(lines[0]).toContain("The parley plugin reloaded")
    expect(lines).toContain("Parley round 1: submitted — 2 answers, 0 pending")
    expect(message?.text).toContain("Beta")
    expect(message?.text).toContain("use the bastion")
    expect(second.service.rounds.get(roundID)?.status).toBe("submitted")
  })

  test("the message is in the outbox, under its id, before it is sent; the answers are marked delivered only after the host admits it", async () => {
    const { data, store, first, roundID } = await openRound()
    let atSend: { round: StoredRound; entry: OutboxEntry } | undefined
    const second = instance(store, {
      deliver: async () => {
        atSend = { round: data.get(roundKey(roundID)) as StoredRound, entry: data.get(outboxKey(`round-${roundID}`)) as OutboxEntry }
      },
    })
    await first.service.suspend()
    await second.service.restore()
    await second.service.submit({ roundID, answers: both })
    expect(atSend?.entry).toMatchObject({ status: "pending", roundID, sessionID: "s" })
    expect(atSend?.entry.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(atSend?.round.delivered).toEqual([])
    const after = data.get(roundKey(roundID)) as StoredRound
    expect(after.delivered.sort()).toEqual(["ssh.host", "ssh.port"])
    expect(data.get(outboxKey(`round-${roundID}`))).toMatchObject({ status: "sent" })
  })

  test("a reload between the user's submit and the host admitting the message sends it again under the same id, and hides nothing", async () => {
    const { data, store, first, roundID } = await openRound()
    const down = instance(store, { deliver: async () => { throw new Error("host down") } })
    await first.service.suspend()
    await down.service.restore()
    const failed = await down.service.submit({ roundID, answers: both })
    expect(failed.errors[0]).toContain("host down")
    const pending = data.get(outboxKey(`round-${roundID}`)) as OutboxEntry
    expect(pending.status).toBe("pending")
    expect((data.get(roundKey(roundID)) as StoredRound).delivered).toEqual([])
    await down.service.suspend()
    const sent: SessionMessage[] = []
    const third = instance(store, { deliver: async (message) => void sent.push(message) })
    await third.service.restore()
    expect(sent.map((message) => message.id)).toEqual([pending.messageID])
    expect(sent[0]?.text).toContain(`Delivery key: ${pending.messageID}`)
    expect(third.service.rounds.get(roundID)?.delivered.size).toBe(2)
    expect(data.get(outboxKey(`round-${roundID}`))).toMatchObject({ status: "sent" })
  })

  test("a reload after the host admitted the message does not send it again", async () => {
    const { store, first, roundID } = await openRound()
    const second = await reload(first, store)
    await second.service.submit({ roundID, answers: both })
    expect(second.messages).toHaveLength(1)
    const third = await reload(second, store)
    expect(third.messages).toEqual([])
    await third.service.cancel({ roundID })
    expect(third.messages).toEqual([])
  })

  test("a delivery that keeps failing is given up after the attempt limit and its answers wait for parley_wait", async () => {
    const { data, store, first, roundID } = await openRound()
    const down = instance(store, { deliver: async () => { throw new Error("host down") } })
    await first.service.suspend()
    await down.service.restore()
    await down.service.submit({ roundID, answers: both })
    const key = outboxKey(`round-${roundID}`)
    data.set(key, { ...(data.get(key) as OutboxEntry), attempts: MAX_ATTEMPTS })
    const warnings: string[] = []
    const sent: SessionMessage[] = []
    const next = instance(store, { deliver: async (message) => void sent.push(message), warn: (message) => void warnings.push(message) })
    await down.service.suspend()
    await next.service.restore()
    await next.service.suspend()
    expect(sent).toEqual([])
    expect(warnings[0]).toContain("giving up")
    expect(data.has(key)).toBe(false)
    expect((await next.service.wait({}, { sessionID: "s" })).result.answers).toHaveLength(2)
  })

  test("parley_wait taking the answers cancels the pending delivery, so they arrive once", async () => {
    const { data, store, first, roundID } = await openRound()
    const down = instance(store, { deliver: async () => { throw new Error("host down") } })
    await first.service.suspend()
    await down.service.restore()
    await down.service.submit({ roundID, answers: both })
    expect((await down.service.wait({}, { sessionID: "s" })).result.answers).toHaveLength(2)
    await down.service.suspend()
    expect(data.has(outboxKey(`round-${roundID}`))).toBe(false)
    const next = await reload(down, store)
    expect(next.messages).toEqual([])
  })

  test("dismissing a restored round tells the session", async () => {
    const { store, first, roundID } = await openRound()
    const second = await reload(first, store)
    await second.service.cancel({ roundID })
    expect(second.messages[0]?.text).toContain("Parley round 1: cancelled (user_closed)")
  })

  test("parley_wait on a restored round gets the answers itself, without a message", async () => {
    const { store, first, roundID } = await openRound()
    const second = await reload(first, store)
    const waiting = second.service.wait({}, { sessionID: "s" })
    await tick()
    await second.service.submit({ roundID, answers: both })
    const { result } = await waiting
    expect(result).toMatchObject({ status: "submitted", round: 1 })
    expect(result.answers.map((answer) => answer.id)).toEqual(["ssh.host", "ssh.port"])
    expect(second.messages).toEqual([])
  })

  test("a round opened in the new instance is waited on as before and sends no message", async () => {
    const { service, messages } = instance(storeOver(new Map()))
    const asking = service.ask({ questions }, { sessionID: "s" })
    await tick()
    await service.submit({ roundID: service.pending({}).rounds[0]?.roundID ?? "", answers: both })
    expect((await asking).result.status).toBe("submitted")
    expect(messages).toEqual([])
  })

  test("a failed delivery keeps the answers for parley_wait", async () => {
    const { store, first, roundID } = await openRound()
    const second = await reload(first, store, { deliver: async () => { throw new Error("offline") } })
    const outcome = await second.service.submit({ roundID, answers: both })
    expect(outcome.errors[0]).toContain("offline")
    expect((await second.service.wait({}, { sessionID: "s" })).result.answers).toHaveLength(2)
  })

  test("a suspended question takeover fails the call instead of reporting an answer", async () => {
    const { service } = instance(storeOver(new Map()))
    const taking = service.takeover(
      { questions: [{ header: "Host", question: "Which host?", options: [{ label: "Alpha (Recommended)", description: "a" }, { label: "Beta", description: "b" }] }] },
      { sessionID: "s", callID: "call-1" },
    )
    const outcome = taking.then(() => "returned", (error: Error) => error.message)
    await tick()
    service.suspend()
    expect(await outcome).toContain(RELOADED_REASON)
  })
})

describe("uploads after a reload", () => {
  const upload = (id: string, name: string, mime: string, text: string) => ({
    id,
    status: "answered" as const,
    value: { files: [{ name, mime, data: Buffer.from(text).toString("base64") }] },
  })
  const fileQuestions: Question[] = [
    { id: "shot", title: "Shot", kind: "ask_image" },
    { id: "notes", title: "Notes", kind: "ask_file" },
  ]
  async function restoredFiles(extras: Extras) {
    const store = storeOver(new Map())
    const first = instance(store)
    void first.service.ask({ questions: fileQuestions }, { sessionID: "s" })
    await tick()
    const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
    const second = await reload(first, store, extras)
    const outcome = await second.service.submit({
      roundID,
      answers: [upload("shot", "a.png", "image/png", "PNGBYTES"), upload("notes", "n.txt", "text/plain", "hello notes")],
    })
    return { second, outcome }
  }

  test("uploads reach the session as text and file paths, never as bytes", async () => {
    const { second } = await restoredFiles({ save: (file) => `/tmp/parley/${file.name}` })
    const text = second.messages[0]?.text ?? ""
    expect(text).toContain("shot: a.png (image/png, 8 B) saved to /tmp/parley/a.png")
    expect(text).toContain("--- notes: n.txt ---\nhello notes")
    expect(text).not.toContain(Buffer.from("PNGBYTES").toString("base64"))
  })

  test("without a way to save them, answers with uploads are held back, said so and left for parley_wait", async () => {
    const { second, outcome } = await restoredFiles({})
    expect(outcome.ok).toBe(true)
    const text = second.messages[0]?.text ?? ""
    expect(text).toContain("Uploads in shot, notes could not be sent in a message. Call parley_wait to receive them.")
    expect(text).toContain("0 answers")
    const waited = (await second.service.wait({}, { sessionID: "s" })).result
    expect(waited.answers.map((answer) => answer.id)).toEqual(["shot", "notes"])
    expect(JSON.stringify(waited.answers)).toContain(Buffer.from("hello notes").toString("base64"))
  })
})

describe("deliver", () => {
  const answers = [{ id: "ssh.host", status: "answered" as const, value: { selected: "a" } }]

  test("sends answers for a round the server never stored", async () => {
    const { service, messages } = instance(storeOver(new Map()))
    expect((await service.deliver({ sessionID: "s", number: 3, questions, answers })).ok).toBe(true)
    expect(messages[0]?.text).toContain("Parley round 3: submitted — 1 answer, 1 pending")
    expect(messages[0]?.text).toContain("Pending: ssh.port")
    expect((await service.deliver({ sessionID: "s", questions, answers: [{ id: "nope", status: "accepted" }] })).ok).toBe(false)
  })

  test("a retry with the same delivery id after a lost acknowledgement sends once", async () => {
    const { service, messages } = instance(storeOver(new Map()))
    await service.deliver({ sessionID: "s", questions, answers, deliveryID: "d1" })
    expect((await service.deliver({ sessionID: "s", questions, answers, deliveryID: "d1" })).ok).toBe(true)
    expect(messages).toHaveLength(1)
  })

  test("a retry after a failed send does send", async () => {
    let fail = true
    const tried: string[] = []
    const { service } = instance(storeOver(new Map()), {
      deliver: async (message) => {
        tried.push(message.id)
        if (fail) throw new Error("offline")
      },
    })
    expect((await service.deliver({ sessionID: "s", questions, answers, deliveryID: "d1" })).ok).toBe(false)
    fail = false
    expect((await service.deliver({ sessionID: "s", questions, answers, deliveryID: "d1" })).ok).toBe(true)
    expect(tried).toHaveLength(2)
    expect(tried[1]).toBe(tried[0])
  })

  test("a retry after a reload that followed a successful send is recognised and not sent again", async () => {
    const data: Data = new Map()
    const first = instance(storeOver(data))
    await first.service.deliver({ sessionID: "s", questions, answers, deliveryID: "d1" })
    await first.service.suspend()
    const second = instance(storeOver(data))
    await second.service.restore()
    expect((await second.service.deliver({ sessionID: "s", questions, answers, deliveryID: "d1" })).ok).toBe(true)
    expect(second.messages).toEqual([])
  })

  test("answers with uploads fail when there is nowhere to save them, so the card keeps its draft", async () => {
    const { service, messages } = instance(storeOver(new Map()))
    const file = { id: "shot", status: "answered" as const, value: { files: [{ name: "a.png", mime: "image/png", data: "UE5H" }] } }
    const outcome = await service.deliver({ sessionID: "s", questions: [{ id: "shot", title: "Shot", kind: "ask_image" }], answers: [file] })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors[0]).toContain("nowhere to save")
    expect(messages).toEqual([])
    // End to end through the TUI flow: the error comes back on the card and the card is not settled.
    let settled = false
    const problems = await submitRound({
      submit: async () => ({ ok: false, errors: ["unknown round rnd_1"] }),
      deliver: () => service.deliver({ sessionID: "s", questions: [{ id: "shot", title: "Shot", kind: "ask_image" }], answers: [file] }),
      choose: async () => true,
      notify: () => {},
      settle: async () => {
        settled = true
      },
    })
    expect(problems[0]).toContain("nowhere to save")
    expect(settled).toBe(false)
  })
})

describe("ownership", () => {
  test("an instance restores only the rounds of its own location's sessions", async () => {
    const data: Data = new Map()
    const a = instance(storeOver(data, "/a", async (id) => id === "sA"))
    const b = instance(storeOver(data, "/b", async (id) => id === "sB"))
    void a.service.ask({ questions }, { sessionID: "sA" })
    void b.service.ask({ questions }, { sessionID: "sB" })
    await tick()
    await a.service.suspend()
    await b.service.suspend()
    const a2 = instance(storeOver(data, "/a", async (id) => id === "sA"))
    await a2.service.restore()
    expect(a2.service.pending({}).rounds.map((round) => round.sessionID)).toEqual(["sA"])
    const b2 = instance(storeOver(data, "/b", async (id) => id === "sB"))
    await b2.service.restore()
    expect(b2.service.pending({}).rounds.map((round) => round.sessionID)).toEqual(["sB"])
    expect(data.size).toBe(2)
  })

  test("a round whose session cannot be placed is not restored, and is left in storage", async () => {
    const data: Data = new Map()
    const first = instance(storeOver(data))
    void first.service.ask({ questions }, { sessionID: "s" })
    await tick()
    await first.service.suspend()
    const second = instance(storeOver(data, "/repo", async () => { throw new Error("session not found") }))
    await second.service.restore()
    expect(second.service.pending({}).rounds).toEqual([])
    expect(data.size).toBe(1)
  })

  test("a round stored by another location is not restored even when its session is visible here", async () => {
    const data: Data = new Map()
    const other = instance(storeOver(data, "/other"))
    void other.service.ask({ questions }, { sessionID: "s" })
    await tick()
    await other.service.suspend()
    const here = instance(storeOver(data, "/repo"))
    await here.service.restore()
    expect(here.service.pending({}).rounds).toEqual([])
  })
})

describe("draining writes", () => {
  test("suspend returns at once when nothing is waiting or being written", () => {
    expect(instance(storeOver(new Map())).service.suspend()).toBeUndefined()
  })

  test("suspend waits for slow writes, including the last state of a waiting call", async () => {
    const data: Data = new Map()
    const first = instance(storeOver(data, "/repo", async () => true, 20))
    const asking = first.service.ask({ questions, wait: "any" }, { sessionID: "s" })
    await tick()
    const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
    await first.service.submit({ roundID, answers: [{ id: "ssh.host", status: "accepted" }], final: false })
    const draining = first.service.suspend()
    expect(draining).toBeInstanceOf(Promise)
    expect((data.get(roundKey(roundID)) as StoredRound | undefined)?.answers ?? []).toHaveLength(0)
    await draining
    await asking
    const stored = data.get(roundKey(roundID)) as StoredRound
    expect(stored.answers.map((answer) => answer.id)).toEqual(["ssh.host"])
    expect(stored.delivered).toEqual(["ssh.host"])
  })

  test("the wait for slow storage is bounded", async () => {
    const first = instance(storeOver(new Map(), "/repo", async () => true, 500))
    void first.service.ask({ questions }, { sessionID: "s" })
    await tick()
    const started = Date.now()
    await first.service.suspend(30)
    expect(Date.now() - started).toBeLessThan(300)
  })
})

describe("pruning and validation", () => {
  const stored = (id: string, status: StoredRound["status"], updated: number): StoredRound => {
    const round: Round = {
      id, sessionID: id, number: 1, questions, answers: new Map(), delivered: new Set(), callIDs: [], status, created: updated, updated,
    }
    return toStored(round, "/repo")
  }
  const seed = (rounds: StoredRound[]): Data => new Map(rounds.map((round) => [roundKey(round.id), round]))

  test("old open rounds and closed rounds past the ttl are dropped at restore, the rest kept", async () => {
    const now = 100 * 60 * 60_000
    const data = seed([
      stored("old_open", "open", now - OPEN_TTL_MS - 1),
      stored("new_open", "open", now - OPEN_TTL_MS + 1000),
      stored("old_closed", "submitted", now - CLOSED_TTL_MS - 1),
      stored("new_closed", "cancelled", now - 1000),
    ])
    const { service } = instance(storeOver(data), { now: () => now })
    await service.restore()
    await service.suspend()
    expect(service.pending({}).rounds.map((round) => round.roundID)).toEqual(["new_open"])
    expect(service.rounds.get("new_closed")?.status).toBe("cancelled")
    expect(service.rounds.get("old_open")).toBeUndefined()
    expect(service.rounds.get("old_closed")).toBeUndefined()
    expect([...data.keys()].sort()).toEqual(["round:new_closed", "round:new_open"])
  })

  test("upload bytes are not stored", () => {
    const round: Round = {
      id: "r", sessionID: "s", number: 1, questions, delivered: new Set(), callIDs: [], status: "open", created: 1, updated: 1,
      answers: new Map([["ssh.host", { id: "ssh.host", status: "answered", value: { files: [{ name: "k.pem", mime: "text/plain", size: 3, data: "c2VjcmV0" }] } }]]),
    }
    expect(JSON.stringify(toStored(round, "/repo"))).not.toContain("c2VjcmV0")
  })

  test.each([
    ["a null question", { questions: [null] }],
    ["a question without a kind", { questions: [{ id: "x", title: "X" }] }],
    ["options that are not a list", { questions: [{ id: "x", title: "X", kind: "pick_one", options: "nope" }] }],
    ["a null option", { questions: [{ id: "x", title: "X", kind: "pick_one", options: [null] }] }],
    ["a null answer", { answers: [null] }],
    ["an answer to an unknown question", { answers: [{ id: "ghost", status: "answered" }] }],
  ])("a round with %s is dropped with a warning and the rest still restore", async (_name, damage) => {
    const good = stored("good", "open", 1_000)
    const bad = { ...stored("bad", "open", 1_000), ...damage }
    const warnings: string[] = []
    const { service } = instance(storeOver(seed([bad as StoredRound, good])), { warn: (message) => void warnings.push(message) })
    await service.restore()
    expect(service.pending({}).rounds.map((round) => round.roundID)).toEqual(["good"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("bad")
  })
})

describe("guidance after a reload", () => {
  test("the result of a call that ended in a reload tells the model to wait for the message, not to ask elsewhere", () => {
    const text = summarise(
      { status: "unavailable", reason: RELOADED_REASON, round: 1, answers: [], pending: ["ssh.host"] },
      questions,
    )
    expect(text).toContain("Do not ask again and do not use the question tool for this round")
    expect(text).not.toContain("No parley UI is available")
  })

  test("a plain unavailable result keeps the no-UI guidance", () => {
    const text = summarise({ status: "unavailable", reason: "no_tui", answers: [], pending: [] }, questions)
    expect(text).toContain("No parley UI is available")
  })
})

describe("upload files follow the round's pruning", () => {
  test("they are removed when the closed round is swept, and not when its delivery is confirmed", async () => {
    let now = 1_000
    const dropped: string[] = []
    const { store, first, roundID } = await openRound({ now: () => now, dropUploads: (id) => void dropped.push(id) })
    const second = instance(store, { now: () => now, dropUploads: (id) => void dropped.push(id), save: () => "/tmp/x" })
    await first.service.suspend()
    await second.service.restore()
    await second.service.submit({ roundID, answers: both })
    expect(second.messages).toHaveLength(1)
    second.service.sweep()
    expect(dropped).toEqual([])
    now += CLOSED_TTL_MS + 1
    second.service.sweep()
    expect(dropped).toEqual([roundID])
  })

  test("they are removed when a stale round is pruned at restore", async () => {
    const dropped: string[] = []
    const data: Data = new Map()
    const first = instance(storeOver(data), { now: () => 1_000 })
    void first.service.ask({ questions }, { sessionID: "s" })
    await tick()
    const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
    await first.service.suspend()
    const later = instance(storeOver(data), { now: () => 1_000 + OPEN_TTL_MS + 1, dropUploads: (id) => void dropped.push(id) })
    await later.service.restore()
    expect(dropped).toEqual([roundID])
  })
})
