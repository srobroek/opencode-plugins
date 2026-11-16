import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { summarise } from "./format.ts"
import { MAX_ATTEMPTS, outboxKey } from "./outbox.ts"
import { OPEN_TTL_MS, roundKey, type StoredRound, toStored } from "./persist.ts"
import type { Question } from "./questions.ts"
import { RELOADED_REASON, type Round } from "./rounds.ts"
import type { RoundEvent } from "./rpc.ts"
import { CLOSED_TTL_MS, Parley, type RoundStore, type SessionMessage, type Settings } from "./service.ts"
import { submitRound } from "./submit.ts"
import { readUpload, removeUpload, saveUpload, uploadRoot } from "./uploads.ts"

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
  readUpload?: (stored: string) => string | undefined
  removeUpload?: (stored: string) => void
  now?: () => number
  save?: (file: { name: string }, roundID?: string) => string | undefined
  closeUploads?: (roundID: string, at: number) => void
  sweepUploads?: (now: number) => void
  warn?: (message: string) => void
  deliver?: (message: SessionMessage) => Promise<void>
  emit?: (event: RoundEvent) => Promise<void>
  retryDelaysMs?: readonly number[]
}

/**
 * A parley instance over `store`. Its fake host admits a message id once, as the real host does
 * (specs/v2/session.md: the first admission wins): `messages` holds what the agent sees, `posts` every call.
 */
function instance(store: RoundStore, extras: Extras = {}) {
  const messages: SessionMessage[] = []
  const posts: SessionMessage[] = []
  const events: RoundEvent[] = []
  const service = new Parley({
    settings,
    emit: async (event) => {
      events.push(event)
      await extras.emit?.(event)
    },
    store,
    now: extras.now ?? (() => 1_000),
    retryDelaysMs: extras.retryDelaysMs ?? [],
    deliver: async (message) => {
      posts.push(message)
      if (extras.deliver) await extras.deliver(message)
      if (!messages.some((admitted) => admitted.id === message.id)) messages.push(message)
    },
    ...(extras.save ? { save: extras.save as never } : {}),
    ...(extras.warn ? { warn: extras.warn } : {}),
    ...(extras.closeUploads ? { closeUploads: extras.closeUploads } : {}),
    ...(extras.sweepUploads ? { sweepUploads: extras.sweepUploads } : {}),
    ...(extras.readUpload ? { readUpload: extras.readUpload } : {}),
    ...(extras.removeUpload ? { removeUpload: extras.removeUpload } : {}),
  })
  service.attach({ clientID: "tui" })
  return { service, messages, posts, events }
}

const down = async (_message?: SessionMessage): Promise<void> => {
  throw new Error("host down")
}

/** A promise with its resolve and reject in hand. */
function deferred() {
  let resolve = () => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const stored = (data: Data, roundID: string) => data.get(roundKey(roundID)) as StoredRound

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

  test("the message is planned in the round record, under a host id, before it is sent; answers are marked delivered only once admitted", async () => {
    const { data, store, first, roundID } = await openRound()
    let atSend: StoredRound | undefined
    const second = instance(store, {
      deliver: async () => {
        atSend = stored(data, roundID)
      },
    })
    await first.service.suspend()
    await second.service.restore()
    await second.service.submit({ roundID, answers: both })
    expect(atSend?.status).toBe("submitted")
    expect(atSend?.delivery).toMatchObject({ status: "pending", answerIDs: ["ssh.host", "ssh.port"] })
    expect(atSend?.delivery?.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(atSend?.delivered).toEqual([])
    expect(stored(data, roundID).delivered.sort()).toEqual(["ssh.host", "ssh.port"])
    expect(stored(data, roundID).delivery?.status).toBe("sent")
    expect(second.messages[0]?.id).toBe(atSend?.delivery?.messageID)
  })

  test("a reload while the submit waits on its event still delivers: the closure and its message are saved in one write", async () => {
    const { data, store, first, roundID } = await openRound()
    const hang = deferred()
    const stuck = instance(store, { emit: (event) => (event.action === "closed" ? hang.promise : Promise.resolve()) })
    await first.service.suspend()
    await stuck.service.restore()
    const submitting = stuck.service.submit({ roundID, answers: both })
    await tick()
    expect(stuck.posts).toEqual([])
    expect(stored(data, roundID)).toMatchObject({ status: "submitted", delivery: { status: "pending" } })
    await stuck.service.suspend()
    const next = instance(store)
    await next.service.restore()
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]?.text).toContain("Parley round 1: submitted — 2 answers, 0 pending")
    // The old instance's submit wakes after the reload and sends nothing.
    hang.resolve()
    await submitting
    expect(stuck.posts).toEqual([])
  })

  test("a reload between the user's submit and the host admitting the message sends it again under the same id, and hides nothing", async () => {
    const { data, store, first, roundID } = await openRound()
    const failing = instance(store, { deliver: down })
    await first.service.suspend()
    await failing.service.restore()
    const failed = await failing.service.submit({ roundID, answers: both })
    expect(failed.errors[0]).toContain("host down")
    const planned = stored(data, roundID).delivery
    expect(planned).toMatchObject({ status: "pending", attempts: 1 })
    expect(stored(data, roundID).delivered).toEqual([])
    const third = await reload(failing, store)
    expect(third.posts.map((message) => message.id)).toEqual([planned?.messageID ?? ""])
    expect(third.service.rounds.get(roundID)?.delivered.size).toBe(2)
    expect(stored(data, roundID).delivery?.status).toBe("sent")
  })

  test("a reload after the host admitted the message does not send it again", async () => {
    const { store, first, roundID } = await openRound()
    const second = await reload(first, store)
    await second.service.submit({ roundID, answers: both })
    expect(second.messages).toHaveLength(1)
    const third = await reload(second, store)
    expect(third.posts).toEqual([])
    await third.service.cancel({ roundID })
    expect(third.posts).toEqual([])
  })

  test("a lost acknowledgement retried under the same id reaches the agent once", async () => {
    const { store, first, roundID } = await openRound()
    let calls = 0
    const flaky = instance(store, {
      deliver: async () => {
        calls++
        // The host admits the first call, but its answer never arrives.
        if (calls === 1) throw new Error("connection reset")
      },
    })
    await first.service.suspend()
    await flaky.service.restore()
    await flaky.service.submit({ roundID, answers: both })
    const next = await reload(flaky, store, {
      deliver: async (message) => {
        // The same host: it already holds this id.
        expect(message.id).toBe(flaky.posts[0]?.id ?? "")
      },
    })
    expect(next.posts).toHaveLength(1)
    expect(next.posts[0]?.id).toBe(flaky.posts[0]?.id ?? "")
  })

  test("before the message's first send, parley_wait may take the answers and the message is dropped", async () => {
    const { data, store, first, roundID } = await openRound()
    const hang = deferred()
    const held = instance(store, { emit: (event) => (event.action === "closed" ? hang.promise : Promise.resolve()) })
    await first.service.suspend()
    await held.service.restore()
    const submitting = held.service.submit({ roundID, answers: both })
    await tick()
    const { result } = await held.service.wait({}, { sessionID: "s" })
    expect(result.answers.map((answer) => answer.id)).toEqual(["ssh.host", "ssh.port"])
    expect(result.as_message).toBeUndefined()
    hang.resolve()
    await submitting
    expect(held.posts).toEqual([])
    expect(stored(data, roundID).delivery).toBeUndefined()
    const next = await reload(held, store)
    expect(next.posts).toEqual([])
  })

  test("a host that admits the message and then fails the call: parley_wait finishes the send and reports the answers by id only", async () => {
    const { store, first, roundID } = await openRound()
    const admitted = new Set<string>()
    const host = instance(store, {
      deliver: async (message) => {
        // The host records the message, then the call fails as if the acknowledgement were lost.
        const known = admitted.has(message.id)
        admitted.add(message.id)
        if (!known) throw new Error("connection reset")
      },
    })
    await first.service.suspend()
    await host.service.restore()
    const outcome = await host.service.submit({ roundID, answers: both })
    expect(outcome.errors[0]).toContain("connection reset")
    const { result } = await host.service.wait({}, { sessionID: "s" })
    expect(result.answers).toEqual([])
    expect(result.as_message).toEqual({ status: "delivered", ids: ["ssh.host", "ssh.port"] })
    expect(new Set(host.posts.map((message) => message.id)).size).toBe(1)
    expect(admitted.size).toBe(1)
    expect((await host.service.wait({}, { sessionID: "s" })).result.answers).toEqual([])
    const next = await reload(host, store)
    expect(next.posts).toEqual([])
  })

  test("a wait while a started send is in flight takes its turn, then sends again under the same id and returns no answers", async () => {
    const { store, first, roundID } = await openRound()
    const gate = deferred()
    let calls = 0
    const slow = instance(store, {
      deliver: () => {
        calls++
        return calls === 1 ? gate.promise : Promise.resolve()
      },
    })
    await first.service.suspend()
    await slow.service.restore()
    const submitting = slow.service.submit({ roundID, answers: both })
    await tick()
    expect(slow.posts).toHaveLength(1)
    let waited = false
    const waiting = slow.service.wait({}, { sessionID: "s" }).then((outcome) => {
      waited = true
      return outcome
    })
    await tick()
    expect(waited).toBe(false)
    gate.reject(new Error("host down"))
    await submitting
    const { result } = await waiting
    expect(result.answers).toEqual([])
    expect(result.as_message).toEqual({ status: "delivered", ids: ["ssh.host", "ssh.port"] })
    expect(slow.posts.map((message) => message.id)).toEqual([slow.posts[0]?.id ?? "", slow.posts[0]?.id ?? ""])
    expect(slow.messages).toHaveLength(1)
  })

  test("a send that succeeds while parley_wait waits leaves the wait nothing new", async () => {
    const { store, first, roundID } = await openRound()
    const gate = deferred()
    const slow = instance(store, { deliver: () => gate.promise })
    await first.service.suspend()
    await slow.service.restore()
    const submitting = slow.service.submit({ roundID, answers: both })
    await tick()
    const waiting = slow.service.wait({}, { sessionID: "s" })
    await tick()
    gate.resolve()
    await submitting
    const { result } = await waiting
    expect(result.answers).toEqual([])
    expect(result.as_message).toEqual({ status: "delivered", ids: ["ssh.host", "ssh.port"] })
    expect(slow.messages).toHaveLength(1)
  })

  test("a scoped parley_wait before the first send takes only its answers out of the message; the others are still sent", async () => {
    const { store, first, roundID } = await openRound()
    const hang = deferred()
    const held = instance(store, { emit: (event) => (event.action === "closed" ? hang.promise : Promise.resolve()) })
    await first.service.suspend()
    await held.service.restore()
    const submitting = held.service.submit({ roundID, answers: both })
    await tick()
    const scoped = (await held.service.wait({ ids: ["ssh.host"] }, { sessionID: "s" })).result
    expect(scoped.answers.map((answer) => answer.id)).toEqual(["ssh.host"])
    hang.resolve()
    await submitting
    expect(held.messages).toHaveLength(1)
    const text = held.messages[0]?.text ?? ""
    expect(text).toContain("Parley round 1: submitted — 1 answer, 0 pending")
    expect(text).toContain("ssh.port")
    expect(text).not.toContain("ssh.host")
    const rest = (await held.service.wait({}, { sessionID: "s" })).result
    expect(rest.answers).toEqual([])
    expect(rest.as_message).toEqual({ status: "delivered", ids: ["ssh.port"] })
  })

  test("after the attempt limit the card comes back with the error, and sending it again uses the same message", async () => {
    const { store, first, roundID } = await openRound()
    let host: (message: SessionMessage) => Promise<void> = down
    const failing = instance(store, { deliver: (message) => host(message), retryDelaysMs: [0, 0] })
    await first.service.suspend()
    await failing.service.restore()
    await failing.service.submit({ roundID, answers: both })
    for (let i = 0; i < 20 && failing.posts.length < MAX_ATTEMPTS; i++) await tick()
    await tick()
    expect(failing.posts).toHaveLength(MAX_ATTEMPTS)
    expect(failing.events.at(-1)).toMatchObject({ roundID, action: "opened", status: "undelivered" })
    const [card] = failing.service.pending({ sessionID: "s" }).rounds
    expect(card).toMatchObject({ roundID, status: "submitted" })
    expect(card?.undelivered).toContain("host down")
    expect(card?.answers.map((answer) => answer.id)).toEqual(["ssh.host", "ssh.port"])
    host = async () => {}
    const notices: string[] = []
    const problems = await submitRound({
      submit: () => failing.service.submit({ roundID, answers: both }),
      deliver: () => failing.service.deliver({ sessionID: "s", roundID, questions, answers: both }),
      choose: async () => true,
      dismiss: async () => {},
      notify: (message) => void notices.push(message),
      settle: async () => {},
    })
    expect(problems).toEqual([])
    expect(notices[0]).toContain("host down")
    expect(failing.service.pending({ sessionID: "s" }).rounds).toEqual([])
    expect(new Set(failing.posts.map((message) => message.id)).size).toBe(1)
    expect(failing.messages).toHaveLength(1)
  })

  test("dismissing a card that came back sends nothing more, and parley_wait reports its answers by id only", async () => {
    const { store, first, roundID } = await openRound()
    const failing = instance(store, { deliver: down, retryDelaysMs: [0, 0] })
    await first.service.suspend()
    await failing.service.restore()
    await failing.service.submit({ roundID, answers: both })
    for (let i = 0; i < 20 && failing.posts.length < MAX_ATTEMPTS; i++) await tick()
    await tick()
    const problems = await submitRound({
      submit: () => failing.service.submit({ roundID, answers: both }),
      deliver: async () => ({ ok: false }),
      choose: async () => false,
      dismiss: async () => void (await failing.service.cancel({ roundID, reason: "dismissed" })),
      notify: () => {},
      settle: async () => {},
    })
    expect(problems).toEqual([])
    expect(failing.service.pending({ sessionID: "s" }).rounds).toEqual([])
    const next = await reload(failing, store)
    expect(next.posts).toEqual([])
    expect(next.service.pending({}).rounds).toEqual([])
    const { result } = await next.service.wait({}, { sessionID: "s" })
    expect(result.answers).toEqual([])
    expect(result.as_message).toMatchObject({ status: "dismissed", ids: ["ssh.host", "ssh.port"] })
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

  test("after a failed send, parley_wait retries it and reports the answers as on their way, never as answers", async () => {
    const { store, first, roundID } = await openRound()
    const second = await reload(first, store, { deliver: down })
    const outcome = await second.service.submit({ roundID, answers: both })
    expect(outcome.errors[0]).toContain("host down")
    const { result } = await second.service.wait({}, { sessionID: "s" })
    expect(result.answers).toEqual([])
    expect(result.as_message).toMatchObject({ status: "sending", ids: ["ssh.host", "ssh.port"] })
    expect(result.as_message?.error).toContain("host down")
    expect(second.posts).toHaveLength(2)
    const next = await reload(second, store)
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]?.id).toBe(second.posts[0]?.id ?? "")
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
    const saved: Array<string | undefined> = []
    const { second } = await restoredFiles({
      save: (file, roundID) => {
        saved.push(roundID)
        return `/tmp/parley/${file.name}`
      },
    })
    // Each upload is copied once, under its round, when it arrives; the message names the copy.
    const id = second.service.rounds.list()[0]?.id
    expect(saved).toEqual([id, id])
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

describe("uploads submitted before the final submit", () => {
  test("a non-final upload survives a reload: storage keeps a private copy's path, and a later wait returns the contents", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "parley-reload-"))
    try {
      const data: Data = new Map()
      const extras: Extras = {
        save: (file, roundID) => saveUpload(file as never, roundID, base),
        readUpload: (copy) => readUpload(copy, base),
      }
      const fileQuestions: Question[] = [
        { id: "key", title: "Key", kind: "ask_file" },
        { id: "ok", title: "OK", kind: "confirm", recommended: "yes" },
      ]
      const first = instance(storeOver(data), extras)
      const asking = first.service.ask({ questions: fileQuestions }, { sessionID: "s" })
      await tick()
      const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
      const bytes = Buffer.from("ssh-ed25519 AAAA").toString("base64")
      await first.service.submit({
        roundID,
        answers: [{ id: "key", status: "answered", value: { files: [{ name: "id.pub", mime: "application/octet-stream", data: bytes }] } }],
        final: false,
      })
      await first.service.suspend()
      await asking
      const record = JSON.stringify(stored(data, roundID))
      expect(record).not.toContain(bytes)
      const files = (answer: { value?: unknown } | undefined) => (answer?.value as { files?: Array<{ stored?: string; data?: string }> } | undefined)?.files ?? []
      const copy = files(stored(data, roundID).answers[0])[0]?.stored ?? ""
      expect(copy.startsWith(uploadRoot(base))).toBe(true)
      expect(statSync(copy).mode & 0o777).toBe(0o600)

      const next = instance(storeOver(data), extras)
      await next.service.restore()
      const waiting = next.service.wait({}, { sessionID: "s" })
      await tick()
      await next.service.submit({ roundID, answers: [{ id: "ok", status: "accepted" }] })
      const { result } = await waiting
      const key = result.answers.find((answer) => answer.id === "key")
      expect(files(key)[0]?.data).toBe(bytes)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("a failed upload copy", () => {
  const fileQuestions: Question[] = [
    { id: "one", title: "One", kind: "ask_file" },
    { id: "two", title: "Two", kind: "ask_file" },
  ]
  const upload = (id: string, name: string, text: string) => ({
    id,
    status: "answered" as const,
    value: { files: [{ name, mime: "text/plain", data: Buffer.from(text).toString("base64") }] },
  })
  const copies = (base: string) => {
    try {
      return readdirSync(path.join(uploadRoot(base), readdirSync(uploadRoot(base))[0] ?? ""))
    } catch {
      return []
    }
  }

  test("nothing is committed: the round stays open and unsubmitted, the error names the upload and errno, and partial copies are removed; a retry succeeds", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "parley-fail-"))
    try {
      let failing = true
      const extras: Extras = {
        save: (file, roundID) => {
          if (failing && file.name === "b.txt") throw Object.assign(new Error(`ENOSPC: no space left on device, write '${base}/secret/path'`), { code: "ENOSPC" })
          return saveUpload(file as never, roundID, base)
        },
        removeUpload: (copy) => removeUpload(copy, base),
        readUpload: (copy) => readUpload(copy, base),
      }
      const data: Data = new Map()
      const { service } = instance(storeOver(data), extras)
      const asking = service.ask({ questions: fileQuestions }, { sessionID: "s" })
      await tick()
      const roundID = service.pending({}).rounds[0]?.roundID ?? ""
      const answers = [upload("one", "a.txt", "first"), upload("two", "b.txt", "second")]
      const failed = await service.submit({ roundID, answers })
      expect(failed.ok).toBe(false)
      expect(failed.errors).toEqual(['Could not save the upload "b.txt" (ENOSPC). Nothing was submitted; send it again.'])
      expect(failed.errors.join(" ")).not.toContain(base)
      expect(service.rounds.get(roundID)?.status).toBe("open")
      expect(service.rounds.get(roundID)?.answers.size).toBe(0)
      expect(copies(base)).toEqual([])
      failing = false
      const retried = await service.submit({ roundID, answers })
      expect(retried).toMatchObject({ ok: true })
      expect((await asking).result.status).toBe("submitted")
      expect(copies(base)).toHaveLength(2)
      expect(JSON.stringify(stored(data, roundID))).not.toContain(Buffer.from("first").toString("base64"))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("an invalid submission removes the copies it made", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "parley-fail-"))
    try {
      const { service } = instance(storeOver(new Map()), {
        save: (file, roundID) => saveUpload(file as never, roundID, base),
        removeUpload: (copy) => removeUpload(copy, base),
      })
      void service.ask({ questions: fileQuestions }, { sessionID: "s" })
      await tick()
      const roundID = service.pending({}).rounds[0]?.roundID ?? ""
      const outcome = await service.submit({ roundID, answers: [upload("one", "a.txt", "first"), { id: "ghost", status: "accepted" }] })
      expect(outcome.ok).toBe(false)
      expect(copies(base)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
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
    const { service, posts } = instance(storeOver(new Map()))
    await service.deliver({ sessionID: "s", questions, answers, deliveryID: "d1" })
    expect((await service.deliver({ sessionID: "s", questions, answers, deliveryID: "d1" })).ok).toBe(true)
    expect(posts).toHaveLength(1)
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
    expect(second.posts).toEqual([])
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
      dismiss: async () => {},
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

  test("answers that reach the agent as a message are named by id, without content", () => {
    const text = summarise(
      { status: "submitted", round: 1, answers: [], pending: [], as_message: { status: "delivered", ids: ["ssh.host", "ssh.port"] } },
      questions,
    )
    expect(text).toContain("Delivered to you as a session message (read them there; they are not repeated here): ssh.host, ssh.port")
  })
})

describe("upload files outlive the round record", () => {
  test("closing a round marks its uploads closed at that time, and a sweep hands the files to the upload sweeper", async () => {
    let now = 1_000
    const closed: Array<[string, number]> = []
    const swept: number[] = []
    const extras: Extras = {
      now: () => now,
      closeUploads: (id, at) => void closed.push([id, at]),
      sweepUploads: (at) => void swept.push(at),
      save: () => "/tmp/x",
    }
    const { store, first, roundID } = await openRound(extras)
    await first.service.suspend()
    now = 5_000
    const second = instance(store, extras)
    await second.service.restore()
    await second.service.submit({ roundID, answers: both })
    expect(closed).toEqual([[roundID, 5_000]])
    now += CLOSED_TTL_MS + 1
    second.service.sweep()
    // The round record goes after 30 minutes; its files are the upload sweeper's, 24 h from the close.
    expect(second.service.rounds.get(roundID)).toBeUndefined()
    expect(swept.at(-1)).toBe(now)
    expect(closed).toEqual([[roundID, 5_000]])
  })

  test("an upload saved for a result after the round closed is marked with the round's close time", async () => {
    const closed: Array<[string, number]> = []
    const { service } = instance(storeOver(new Map()), { save: () => "/tmp/x", closeUploads: (id, at) => void closed.push([id, at]) })
    const asking = service.ask({ questions: [{ id: "shot", title: "Shot", kind: "ask_image" }] }, { sessionID: "s" })
    await tick()
    const roundID = service.pending({}).rounds[0]?.roundID ?? ""
    await service.submit({
      roundID,
      answers: [{ id: "shot", status: "answered", value: { files: [{ name: "a.png", mime: "image/png", data: "UE5H" }] } }],
    })
    await asking
    closed.length = 0
    expect(service.saveUpload({ name: "a.png", mime: "image/png", size: 3, data: "UE5H" }, roundID)).toBe("/tmp/x")
    expect(closed).toEqual([[roundID, 1_000]])
  })

  test("a stale round pruned at restore marks its uploads closed now, so the files stay 24 h longer", async () => {
    const closed: Array<[string, number]> = []
    const data: Data = new Map()
    const first = instance(storeOver(data), { now: () => 1_000 })
    void first.service.ask({ questions }, { sessionID: "s" })
    await tick()
    const roundID = first.service.pending({}).rounds[0]?.roundID ?? ""
    await first.service.suspend()
    const later = 1_000 + OPEN_TTL_MS + 1
    const next = instance(storeOver(data), { now: () => later, closeUploads: (id, at) => void closed.push([id, at]) })
    await next.service.restore()
    expect(closed).toEqual([[roundID, later]])
  })
})
