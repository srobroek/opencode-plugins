import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "./index.ts"
import type { StoredRound } from "./persist.ts"

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

function host(directory: string, data: Map<string, unknown>, writeMs: number) {
  const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<{ output: { status: string } }> }>()
  let handlers: Record<string, (input: unknown) => Promise<unknown>> = {}
  const context = {
    options: {},
    location: { directory },
    storage: {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => {
        await tick(writeMs)
        data.set(key, JSON.parse(JSON.stringify(value)))
      },
      remove: async (key: string) => void data.delete(key),
      scan: async (options: { prefix: string }) => ({ entries: [...data].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => ({ key, value })) }),
    },
    session: { get: async () => ({ location: { directory } }), synthetic: async () => ({}) },
    rpc: {
      register: async (_definition: unknown, registered: typeof handlers) => {
        handlers = registered
        return { events: { emit: async () => {} }, dispose: async () => {} }
      },
    },
    tool: {
      transform: async (edit: (editor: { add: (tool: never) => void; update: () => void }) => void) => {
        edit({ add: (tool: { name: string }) => void tools.set(tool.name, tool as never), update: () => {} })
        return { dispose: async () => {} }
      },
      list: async () => [],
    },
  } as unknown as Plugin.Context
  return { context, tools, call: (name: string, input: unknown) => handlers[name]?.(input) }
}

const question = { id: "q", title: "Q", kind: "confirm", recommended: "yes" }
const second = { id: "q2", title: "Q2", kind: "confirm", recommended: "yes" }
const toolContext = { sessionID: "s", id: "call-1", signal: new AbortController().signal, progress: async () => {} }

test("the cleanup waits for queued saves, so the next instance restores the final state", async () => {
  const data = new Map<string, unknown>()
  const first = host("/repo", data, 20)
  const cleanup = await plugin.setup(first.context)
  await first.call("attach", { clientID: "tui" })
  const asking = first.tools.get("parley_ask")?.execute({ questions: [question, second] }, toolContext)
  await tick()
  const { rounds } = (await first.call("pending", {})) as { rounds: Array<{ roundID: string }> }
  const roundID = rounds[0]?.roundID ?? ""
  await first.call("submit", { roundID, answers: [{ id: "q", status: "accepted" }], final: false })
  const draining = typeof cleanup === "function" ? cleanup() : undefined
  expect(draining).toBeInstanceOf(Promise)
  await draining
  expect((await asking)?.output.status).toBe("unavailable")
  const stored = data.get(`round:${roundID}`) as StoredRound
  expect(stored.status).toBe("open")
  expect(stored.answers.map((answer) => answer.id)).toEqual(["q"])

  const next = host("/repo", data, 0)
  await plugin.setup(next.context)
  const restored = (await next.call("pending", {})) as { rounds: Array<{ roundID: string; answers: unknown[] }> }
  expect(restored.rounds.map((round) => round.roundID)).toEqual([roundID])
  expect(restored.rounds[0]?.answers).toHaveLength(1)
})

test("a second location does not restore the first location's rounds", async () => {
  const data = new Map<string, unknown>()
  const a = host("/a", data, 0)
  const cleanupA = await plugin.setup(a.context)
  await a.call("attach", { clientID: "tui" })
  void a.tools.get("parley_ask")?.execute({ questions: [question] }, toolContext)
  await tick()
  await (typeof cleanupA === "function" ? cleanupA() : undefined)
  const b = host("/b", data, 0)
  // The session is visible, but belongs to location /a.
  b.context.session.get = (async () => ({ location: { directory: "/a" } })) as never
  await plugin.setup(b.context)
  expect(((await b.call("pending", {})) as { rounds: unknown[] }).rounds).toEqual([])
})
