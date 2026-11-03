import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { canAutoPresent, canCloseRoundPanel } from "./presentation.ts"
import type { RoundEvent } from "./rpc.ts"
import { Parley, settingsFrom } from "./service.ts"
import tui from "./tui.tsx"

test("automatic focus yields only to a different session's pending round", () => {
  expect(canAutoPresent("B", "A", ["A", "B"])).toBe(false)
  expect(canAutoPresent("A", "A", ["A"])).toBe(true)
  expect(canAutoPresent("B", "A", ["B"])).toBe(true)
  expect(canAutoPresent("B", undefined, ["A", "B"])).toBe(true)
})

test("a late submit or dismissal cannot close another session's panel or a newer round", () => {
  expect(canCloseRoundPanel({ name: "parley", sessionID: "B" }, "parley", "A", false)).toBe(false)
  expect(canCloseRoundPanel({ name: "other", sessionID: "A" }, "parley", "A", false)).toBe(false)
  expect(canCloseRoundPanel({ name: "parley", sessionID: "A" }, "parley", "A", true)).toBe(false)
  expect(canCloseRoundPanel({ name: "parley", sessionID: "A" }, "parley", "A", false)).toBe(true)
  expect(canCloseRoundPanel(undefined, "parley", "A", false)).toBe(false)
})

for (const native of [false, true]) for (const separateLocations of [false, true]) test(`a second session's ${native ? "native question" : "parley ask"} waits without displacing the first (${separateLocations ? "different locations" : "same location"})`, async () => {
  const terminal = await createTestRenderer({ width: 40, height: 10 })
  let event: (input: { data: RoundEvent; location: { directory: string } }) => Promise<void> = async () => {}
  let openedB = () => {}
  const presentedB = new Promise<void>((resolve) => { openedB = resolve })
  const emit = async (data: RoundEvent, at: { directory: string }) => {
    await event({ data, location: at })
    if (data.action === "opened" && data.sessionID === "B") openedB()
  }
  const location = { directory: "/repo" }
  const locationB = separateLocations ? { directory: "/other-repo" } : location
  const service = new Parley({ settings: settingsFrom({}, {}), emit: (data) => emit(data, location) })
  const serviceB = separateLocations ? new Parley({ settings: settingsFrom({}, {}), emit: (data) => emit(data, locationB) }) : service
  const forLocation = (input: { location: { directory: string } }) => input.location.directory === location.directory ? service : serviceB
  let route = { type: "session" as const, sessionID: "A" }
  const focused: string[] = []
  const notices: string[] = []
  const colour = RGBA.fromHex("#ffffff")
  const palette = new Proxy({}, { get: () => colour })
  const context = {
    location,
    theme: new Proxy({}, { get: () => palette }),
    renderer: terminal.renderer,
    client: { rpc: () => ({
      attach: async (input: { clientID: string; detach?: boolean }, options: Parameters<typeof forLocation>[0]) => forLocation(options).attach(input),
      pending: async (_input: unknown, options: Parameters<typeof forLocation>[0]) => forLocation(options).pending({}),
      submit: async (input: Parameters<Parley["submit"]>[0], options: Parameters<typeof forLocation>[0]) => forLocation(options).submit(input),
      cancel: async (input: Parameters<Parley["cancel"]>[0], options: Parameters<typeof forLocation>[0]) => forLocation(options).cancel(input),
      events: { on: (_name: string, callback: typeof event) => { event = callback; return () => {} } },
    }) },
    data: { listen: () => () => {}, session: { get: (id: string) => ({ location: id === "B" ? locationB : location }) } },
    ui: {
      tabs: { enabled: () => true, list: () => [{ sessionID: "A" }, { sessionID: "B" }], focus: (id: string) => { focused.push(id); route = { type: "session", sessionID: id }; return true } },
      router: { current: () => route, navigate: () => {} },
      panel: { current: () => undefined, open: () => true, close: () => {} },
      toast: { show: (input: { sessionID?: string }) => { if (input.sessionID) notices.push(input.sessionID) } },
      slot: () => () => {},
    },
    attention: { notify: async () => ({ ok: true }) },
  } as unknown as Plugin.Context
  const cleanup = await tui.setup(context)
  const question = [{ id: "choice", title: "Choose", kind: "confirm" as const, recommended: "yes" }]
  const ask = (backend: Parley, sessionID: string) => native
    ? backend.takeover({ questions: [{ header: "Choose", question: "Choose?", options: [{ label: "Yes (Recommended)", description: "Yes" }, { label: "No", description: "No" }] }] }, { sessionID, callID: `call-${sessionID}` })
    : backend.ask({ questions: question, timeout_s: 0 }, { sessionID })
  let settledA = false
  const a = ask(service, "A").then((result) => { settledA = true; return result })
  const b = ask(serviceB, "B")
  const submitted = async (promise: typeof a) => {
    const result = await promise
    if (native) expect(result).toMatchObject({ output: { answers: [["Yes (Recommended)"]] } })
    else expect(result).toMatchObject({ result: { status: "submitted" } })
  }
  try {
    await presentedB
    expect(route.sessionID).toBe("A")
    expect(focused).toEqual([])
    expect(notices).toContain("B")
    expect(service.pending({ sessionID: "A" }).rounds).toHaveLength(1)
    expect(serviceB.pending({ sessionID: "B" }).rounds).toHaveLength(1)
    expect(settledA).toBe(false)
    const roundB = serviceB.pending({ sessionID: "B" }).rounds[0]
    if (!roundB) throw new Error("B's question disappeared")
    await serviceB.submit({ roundID: roundB.roundID, answers: [{ id: native ? "q1" : "choice", status: "accepted" }] })
    await submitted(b)
    expect(settledA).toBe(false)
    expect(service.pending({ sessionID: "A" }).rounds).toHaveLength(1)
    const roundA = service.pending({ sessionID: "A" }).rounds[0]
    if (!roundA) throw new Error("A's question disappeared")
    await service.submit({ roundID: roundA.roundID, answers: [{ id: native ? "q1" : "choice", status: "accepted" }] })
    await submitted(a)
  } finally {
    service.close()
    serviceB.close()
    await Promise.allSettled([a, b])
    cleanup?.()
    await terminal.dispose()
  }
})
