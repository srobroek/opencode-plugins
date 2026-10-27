import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import plugin from "./index.ts"
import tui from "./tui.tsx"

test("server cleanup starts every unregister without waiting for stalled disposers", async () => {
  const started: string[] = []
  const never = new Promise<void>(() => {})
  const context = {
    options: {},
    rpc: {
      register: async () => ({
        events: { emit: async () => {} },
        dispose: () => { started.push("rpc"); return never },
      }),
    },
    tool: {
      transform: async () => ({ dispose: () => { started.push("tools"); return never } }),
    },
  } as unknown as Plugin.Context
  const cleanup = await plugin.setup(context)
  expect(typeof cleanup).toBe("function")
  expect(cleanup?.()).toBeUndefined()
  expect(started.sort()).toEqual(["rpc", "tools"])
})

test("TUI cleanup returns synchronously despite stalled detach and renderer idle", async () => {
  const terminal = await createTestRenderer({ width: 40, height: 10 })
  const released: string[] = []
  const never = new Promise<void>(() => {})
  let finishIdle = () => {}
  const idle = new Promise<void>((resolve) => { finishIdle = resolve })
  const colour = RGBA.fromHex("#ffffff")
  const palette = new Proxy({}, { get: () => colour })
  let detach = 0
  const context = {
    location: { directory: "/repo" },
    theme: new Proxy({}, { get: () => palette }),
    renderer: { nativeScene: terminal.renderer.nativeScene, idle: () => idle },
    client: { rpc: () => ({
      attach: (input: { detach?: boolean }) => { if (input.detach) detach++; return never },
      pending: () => never,
      events: { on: () => () => released.push("events") },
    }) },
    data: { listen: () => () => released.push("reconnect") },
    ui: { tabs: { enabled: () => false }, slot: () => () => released.push("slot") },
  } as unknown as TuiPlugin.Context
  try {
    const cleanup = await tui.setup(context)
    expect(cleanup?.()).toBeUndefined()
    expect(detach).toBe(1)
    expect(released).toEqual(["events", "reconnect", "slot", "slot", "slot"])
  } finally {
    finishIdle()
    await idle
    await terminal.dispose()
  }
})
