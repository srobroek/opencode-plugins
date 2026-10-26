import { describe, expect, test } from "bun:test"
import { render, summarise } from "./format.ts"
import type { Question } from "./questions.ts"
import type { RoundEvent } from "./rpc.ts"
import { Parley, type QuestionTool, type Settings, settingsFrom } from "./service.ts"

const settings: Settings = { fallback: "none", disabled: false, heartbeatWindowMs: 30_000 }
const questions: Question[] = [
  { id: "auth.storage", title: "Storage", kind: "pick_one", options: [{ id: "sqlite", label: "SQLite" }, { id: "pg", label: "Postgres" }], recommended: "sqlite" },
  { id: "auth.ttl", title: "TTL", kind: "slider", min: 0, max: 60, recommended: 30 },
]

function setup(overrides: Partial<Settings> = {}, questionTool?: QuestionTool) {
  const events: RoundEvent[] = []
  const service = new Parley({
    settings: { ...settings, ...overrides },
    emit: async (event) => {
      events.push(event)
    },
    ...(questionTool ? { questionTool: async () => questionTool } : {}),
  })
  return { service, events }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("settingsFrom", () => {
  test("reads options and env", () => {
    expect(settingsFrom({ fallback: "question" }, {})).toMatchObject({ fallback: "question", disabled: false })
    expect(settingsFrom({}, { PARLEY_DISABLE: "1" }).disabled).toBe(true)
    expect(settingsFrom({ heartbeat_window_s: 5 }, {}).heartbeatWindowMs).toBe(5000)
  })
})

describe("Parley", () => {
  test("returns unavailable at once without an attached TUI", async () => {
    const { service, events } = setup()
    const started = Date.now()
    const { result } = await service.ask({ questions }, { sessionID: "s" })
    expect(result).toMatchObject({ status: "unavailable", reason: "no_tui" })
    expect(Date.now() - started).toBeLessThan(100)
    expect(events).toEqual([])
    expect((await setup({ disabled: true }).service.ask({ questions }, { sessionID: "s" })).result.reason).toBe("disabled")
  })

  test("round trip through attach, pending and submit with ids preserved", async () => {
    const { service, events } = setup()
    service.attach({ clientID: "tui" })
    const progress: unknown[] = []
    const asking = service.ask(
      { questions, title: "Auth" },
      { sessionID: "s", progress: async (update) => void progress.push(update) },
    )
    await tick()
    expect(events[0]).toMatchObject({ sessionID: "s", action: "opened" })
    const [round] = service.pending({ sessionID: "s" }).rounds
    if (!round) throw new Error("no pending round")
    expect(round.questions.map((q) => q.id)).toEqual(["auth.storage", "auth.ttl"])
    expect(
      (
        await service.submit({
          roundID: round.roundID,
          answers: [
            { id: "auth.storage", status: "answered", value: { selected: "pg" }, note: "only for v1" },
            { id: "auth.ttl", status: "deferred", note: "ask ops" },
          ],
        })
      ).ok,
    ).toBe(true)
    const { result, questions: asked } = await asking
    expect(result).toMatchObject({ status: "submitted", round: 1, channel: "tui", pending: [] })
    expect(result.answers).toEqual([
      { id: "auth.storage", status: "answered", value: { selected: "pg" }, accepted_recommendation: false, note: "only for v1" },
      { id: "auth.ttl", status: "deferred", note: "ask ops" },
    ])
    expect(events.at(-1)).toMatchObject({ action: "closed", status: "submitted" })
    expect(progress.at(-1)).toEqual({ round: 1, answered: 2, total: 2 })
    expect(summarise(result, asked)).toContain("Q1 auth.storage [answered] → Postgres (note: only for v1)")
  })

  test("abort cancels the round in the UI", async () => {
    const { service, events } = setup()
    service.attach({ clientID: "tui" })
    const controller = new AbortController()
    const asking = service.ask({ questions }, { sessionID: "s", signal: controller.signal })
    await tick()
    controller.abort()
    const { result } = await asking
    expect(result).toMatchObject({ status: "cancelled", reason: "aborted" })
    expect(events.at(-1)).toMatchObject({ action: "closed", status: "cancelled", reason: "aborted" })
    expect(service.pending({}).rounds).toEqual([])
  })

  test("timeout keeps the round open and wait picks it up", async () => {
    const { service } = setup()
    service.attach({ clientID: "tui" })
    const first = await service.ask({ questions, wait: "none" }, { sessionID: "s" })
    expect(first.result.status).toBe("open")
    const timed = await service.wait({ timeout_s: 0.01 } as never, { sessionID: "s" })
    expect(timed.result.status).toBe("timeout")
    const waiting = service.wait({}, { sessionID: "s" })
    await tick()
    const roundID = service.pending({}).rounds[0]?.roundID ?? ""
    await service.submit({ roundID, answers: [{ id: "auth.storage", status: "accepted" }] })
    const { result } = await waiting
    expect(result).toMatchObject({ status: "submitted", pending: ["auth.ttl"] })
    expect(result.answers[0]).toMatchObject({ id: "auth.storage", status: "accepted", value: { selected: "sqlite" } })
    expect((await service.wait({}, { sessionID: "other" })).result.status).toBe("none")
  })

  test("questions asked mid-round join the open round", async () => {
    const { service, events } = setup()
    service.attach({ clientID: "tui" })
    await service.ask({ questions: [questions[0] as Question], wait: "none" }, { sessionID: "s" })
    await service.ask({ questions: [questions[1] as Question], wait: "none" }, { sessionID: "s" })
    expect(events.map((event) => event.action)).toEqual(["opened", "updated"])
    expect(service.pending({}).rounds[0]?.questions).toHaveLength(2)
  })

  test("invalid questions throw", async () => {
    const { service } = setup()
    service.attach({ clientID: "tui" })
    await expect(service.ask({ questions: [{ ...questions[0], recommended: "nope" } as Question] }, { sessionID: "s" })).rejects.toThrow(
      "unknown option",
    )
  })

  test("end cancels the open round and notifies", async () => {
    const { service, events } = setup()
    service.attach({ clientID: "tui" })
    await service.ask({ questions, wait: "none" }, { sessionID: "s" })
    expect(await service.end("s", "Thanks")).toEqual({ ok: true, closed: 1 })
    expect(events.at(-1)).toMatchObject({ action: "ended", message: "Thanks" })
  })

  test("user cancel returns cancelled", async () => {
    const { service } = setup()
    service.attach({ clientID: "tui" })
    const asking = service.ask({ questions }, { sessionID: "s" })
    await tick()
    await service.cancel({ roundID: service.pending({}).rounds[0]?.roundID ?? "" })
    expect((await asking).result).toMatchObject({ status: "cancelled", reason: "user_closed" })
  })
})

describe("question-tool fallback", () => {
  const choice: Question[] = [questions[0] as Question, { id: "go", title: "Go?", kind: "confirm", recommended: "yes" }]

  test("asks through the question tool when no TUI is attached", async () => {
    let received: unknown
    const tool: QuestionTool = {
      execute: async (input) => {
        received = input
        return { output: { answers: [["Postgres"], ["Yes (Recommended)"]] } }
      },
    }
    const { service } = setup({ fallback: "question" }, tool)
    const { result } = await service.ask({ questions: choice }, { sessionID: "s", tool: { id: "call" } })
    expect((received as { questions: unknown[] }).questions).toHaveLength(2)
    expect(result).toMatchObject({ status: "submitted", channel: "question" })
    expect(result.answers.map((a) => [a.id, a.status])).toEqual([
      ["auth.storage", "answered"],
      ["go", "accepted"],
    ])
  })

  test("maps a dismissal to cancelled", async () => {
    const tool: QuestionTool = {
      execute: async () => {
        throw new Error("The user dismissed this question")
      },
    }
    const { result } = await setup({ fallback: "question" }, tool).service.ask({ questions: choice }, { sessionID: "s" })
    expect(result).toMatchObject({ status: "cancelled", reason: "dismissed" })
  })

  test("unsupported kinds stay unavailable", async () => {
    const tool: QuestionTool = { execute: async () => ({}) }
    const { result } = await setup({ fallback: "question" }, tool).service.ask({ questions }, { sessionID: "s" })
    expect(result.status).toBe("unavailable")
    expect(result.reason).toContain("auth.ttl")
  })
})

describe("render", () => {
  test("strips file data from output and sends it as file content", () => {
    const { output, content } = render(
      {
        status: "submitted",
        round: 1,
        answers: [
          { id: "shot", status: "answered", value: { files: [{ name: "a.png", mime: "image/png", size: 3, data: "aGk=" }] } },
        ],
        pending: [],
      },
      [{ id: "shot", title: "Shot", kind: "ask_image" }],
    )
    expect(JSON.stringify(output)).not.toContain("aGk=")
    expect(Array.isArray(content) && content[1]).toEqual({
      type: "file",
      uri: "data:image/png;base64,aGk=",
      mime: "image/png",
      name: "a.png",
    })
  })
})

describe("close", () => {
  test("releases blocked calls", async () => {
    const { service } = setup()
    service.attach({ clientID: "tui" })
    const asking = service.ask({ questions }, { sessionID: "s" })
    await tick()
    service.close()
    expect((await asking).result).toMatchObject({ status: "cancelled", reason: "plugin_unloaded" })
  })
})

describe("render uploads", () => {
  const files = (file: object) => ({
    status: "submitted" as const,
    answers: [{ id: "f", status: "answered" as const, value: { files: [file] } }],
    pending: [],
  })
  const question: Question[] = [{ id: "f", title: "F", kind: "ask_file" }]
  test("inlines text files", () => {
    const { content } = render(files({ name: "n.txt", mime: "text/plain;charset=utf-8", size: 2, data: "aGk=" }), question)
    expect(content).toContain("--- f: n.txt ---\nhi")
  })
  test("hands other files to save", () => {
    const { content } = render(files({ name: "a.bin", mime: "application/zip", size: 2, data: "aGk=" }), question, () => "/tmp/a.bin")
    expect(content).toContain("saved to /tmp/a.bin")
  })
})
