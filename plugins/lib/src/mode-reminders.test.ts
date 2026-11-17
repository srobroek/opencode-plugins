import { describe, expect, test } from "bun:test"
import { defineMode, enterReminder, leaveReminder, missingReminders, registerModeReminders, reminderFor } from "./mode-reminders.ts"
import { createFakeContext } from "./testing.ts"

const alpha = defineMode({ id: "alpha", name: "Alpha", purpose: "you do a.", allowed: "`a/`", redirect: "switch to `build`" })
const beta = defineMode({ id: "beta", name: "Beta", purpose: "you do b.", allowed: "`b/`", redirect: "switch to `build`" })
const modes = [alpha, beta]
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })

describe("reminderFor", () => {
  test("entering a mode gives its enter text", () => {
    expect(reminderFor("build", "alpha", modes)).toEqual([enterReminder(alpha)])
  })
  test("a new session in a mode gives its enter text", () => {
    expect(reminderFor(undefined, "alpha", modes)).toEqual([enterReminder(alpha)])
  })
  test("leaving a mode gives its leave text", () => {
    expect(reminderFor("alpha", "build", modes)).toEqual([leaveReminder(alpha)])
  })
  test("mode to mode gives leave then enter", () => {
    expect(reminderFor("alpha", "beta", modes)).toEqual([leaveReminder(alpha), enterReminder(beta)])
  })
  test("unrelated switches and no-op switches give nothing", () => {
    expect(reminderFor("build", "plan", modes)).toEqual([])
    expect(reminderFor(undefined, "build", modes)).toEqual([])
    expect(reminderFor("alpha", "alpha", modes)).toEqual([])
  })
})

describe("missingReminders", () => {
  test("a mode agent with no reminder in the history gets its enter text", () => {
    expect(missingReminders("alpha", [user("hi")], modes)).toEqual([enterReminder(alpha)])
  })
  test("nothing is missing while the last reminder is the agent's enter text", () => {
    expect(missingReminders("alpha", [user(enterReminder(alpha)), user("hi")], modes)).toEqual([])
  })
  test("a non-mode agent after an enter text gets the leave text", () => {
    expect(missingReminders("build", [user(enterReminder(alpha))], modes)).toEqual([leaveReminder(alpha)])
  })
  test("a left mode needs nothing more", () => {
    expect(missingReminders("build", [user(enterReminder(alpha)), user(leaveReminder(alpha))], modes)).toEqual([])
  })
  test("a different mode agent gets leave then enter", () => {
    expect(missingReminders("beta", [user(enterReminder(alpha))], modes)).toEqual([leaveReminder(alpha), enterReminder(beta)])
  })
})

describe("defineMode", () => {
  test("the enter text names the mode, the allowed edits and the exit", () => {
    expect(alpha.enter).toStartWith("<system-reminder>")
    expect(alpha.enter).toContain("You are in Alpha mode")
    expect(alpha.enter).toContain("`a/`")
    expect(alpha.enter).toContain("until the user switches agents")
  })
})

describe("registerModeReminders", () => {
  const started = async () => {
    const fake = createFakeContext({ sessions: [{ id: "ses_1" }] })
    const dispose = await registerModeReminders(fake.context, modes)
    return { fake, dispose }
  }
  const synthetic = (fake: ReturnType<typeof createFakeContext>) =>
    fake.calls.filter((call) => call.method === "session.synthetic").map((call) => (call.input as { text: string }).text)

  test("an agent switch into a mode stores its enter text without resuming", async () => {
    const { fake, dispose } = await started()
    fake.emit({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "alpha", previous: "build" } })
    await Bun.sleep(0)
    expect(synthetic(fake)).toEqual([enterReminder(alpha)])
    expect(fake.calls.find((call) => call.method === "session.synthetic")?.input).toMatchObject({ resume: false })
    await dispose()
  })

  test("session creation with a mode agent stores its enter text", async () => {
    const { fake, dispose } = await started()
    fake.emit({ type: "session.created", data: { sessionID: "ses_1", agent: "beta" } })
    await Bun.sleep(0)
    expect(synthetic(fake)).toEqual([enterReminder(beta)])
    await dispose()
  })

  test("the context hook adds a stripped reminder before the last user prompt", async () => {
    const { fake, dispose } = await started()
    const payload = await fake.fire.session("context", { sessionID: "ses_1", agent: "alpha", messages: [user("hi")] })
    expect(payload.messages).toEqual([user(enterReminder(alpha)), user("hi")])
    expect(synthetic(fake)).toEqual([enterReminder(alpha)])
    await dispose()
  })

  test("a correction goes after a trailing obsolete reminder, and a second pass adds nothing", async () => {
    const { fake, dispose } = await started()
    const messages = [user("hi"), user(enterReminder(alpha))]
    await fake.fire.session("context", { sessionID: "ses_1", agent: "build", messages })
    expect(messages).toEqual([user("hi"), user(enterReminder(alpha)), user(leaveReminder(alpha))])
    await fake.fire.session("context", { sessionID: "ses_1", agent: "build", messages })
    expect(messages).toHaveLength(3)
    expect(synthetic(fake)).toEqual([leaveReminder(alpha)])
    await dispose()
  })

  test("a context payload without a messages array does nothing", async () => {
    const { fake, dispose } = await started()
    const payload = await fake.fire.session("context", { sessionID: "ses_1", agent: "alpha", system: [] as unknown[] })
    expect(payload).toEqual({ sessionID: "ses_1", agent: "alpha", system: [] })
    expect(synthetic(fake)).toEqual([])
    await dispose()
  })

  test("the cleanup removes the context hook", async () => {
    const { fake, dispose } = await started()
    await dispose()
    expect(fake.hooks("session")).toEqual([])
  })
})
