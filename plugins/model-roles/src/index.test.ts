import { describe, expect, test } from "bun:test"
import plugin, { MAX_REREGISTER, type ModelRef, spawnTarget } from "./index.ts"

type Agent = { id: string; model?: ModelRef; request?: { headers?: Record<string, string> } }
type Model = { providerID: string; id: string; variants: { id: string }[]; cost?: { input: number }[] }
type Editor = {
  list: () => Agent[]
  get: (id: string) => Agent | undefined
  update: (id: string, fn: (agent: Agent) => void) => void
}

/** A host that replays agent transforms in registration order and emits `agent.updated` after each change. */
function createHost(input: { agents: Agent[]; models: Model[]; options: unknown; sessionModel?: ModelRef }) {
  const toolHooks: Array<{ name: string; callback: (payload: unknown) => Promise<void> }> = []
  let sessionGet: (id: string) => Promise<unknown> = async (id) => ({ id, model: input.sessionModel })
  const transforms: Array<{ callback: (editor: Editor) => void }> = []
  const hooks: Array<{ name: string; callback: (payload: unknown) => void }> = []
  let agents = new Map<string, Agent>()
  let models = input.models
  let registrations = 0
  let transformCalls = 0
  let listOverride: (() => Agent[]) | undefined
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let closed = false

  const emit = (event: unknown) => {
    queue.push(event)
    wake?.()
  }
  const replay = () => {
    agents = new Map(input.agents.map((a) => [a.id, structuredClone(a)]))
    const editor: Editor = {
      list: () => [...agents.values()],
      get: (id) => agents.get(id),
      update: (id, fn) => {
        const agent = agents.get(id) ?? { id }
        fn(agent)
        agents.set(id, agent)
      },
    }
    for (const t of transforms) t.callback(editor)
    emit({ type: "agent.updated" })
  }
  const transform = async (callback: (editor: Editor) => void) => {
    transformCalls++
    registrations++
    const entry = { callback }
    transforms.push(entry)
    replay()
    let live = true
    return {
      dispose: async () => {
        if (!live) return
        live = false
        registrations--
        transforms.splice(transforms.indexOf(entry), 1)
        replay()
      },
    }
  }
  const context = {
    options: input.options,
    agent: {
      transform,
      list: async () => ({ data: listOverride ? listOverride() : [...agents.values()].map((a) => structuredClone(a)) }),
    },
    model: { list: async () => ({ data: models }) },
    tool: {
      hook: async (name: string, callback: (payload: unknown) => Promise<void>) => {
        registrations++
        const entry = { name, callback }
        toolHooks.push(entry)
        return {
          dispose: async () => {
            registrations--
            toolHooks.splice(toolHooks.indexOf(entry), 1)
          },
        }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessionGet(sessionID),
      hook: async (name: string, callback: (payload: unknown) => void) => {
        registrations++
        const entry = { name, callback }
        hooks.push(entry)
        return {
          dispose: async () => {
            registrations--
            hooks.splice(hooks.indexOf(entry), 1)
          },
        }
      },
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            while (queue.length === 0 && !closed) await new Promise<void>((r) => (wake = r))
            wake = undefined
            if (queue.length > 0) return { value: queue.shift(), done: false }
            return { value: undefined, done: true }
          },
        }),
      }),
    },
  }
  return {
    context,
    agents: () => agents,
    transform,
    fireModelRequest: (headers: Record<string, string>) => {
      for (const hook of hooks) if (hook.name === "model.request") hook.callback({ headers })
      return headers
    },
    setModels: (next: Model[]) => {
      models = next
      emit({ type: "model.updated" })
    },
    emit,
    toolHooks: () => toolHooks.length,
    spawn: async (tool: string, payload: unknown, agent = "build") => {
      for (const hook of toolHooks)
        if (hook.name === "execute.before") await hook.callback({ tool, sessionID: "s1", agent, id: "c1", input: payload })
    },
    setSessionGet: (fn: (id: string) => Promise<unknown>) => {
      sessionGet = fn
    },
    setListOverride: (fn: () => Agent[]) => {
      listOverride = fn
    },
    close: () => {
      closed = true
      wake?.()
    },
    registrations: () => registrations,
    transformCalls: () => transformCalls,
    activeTransforms: () => transforms.length,
  }
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0))
}

const sonnet = { providerID: "amazon-bedrock", id: "claude-sonnet", variant: "high" }
const haiku = { providerID: "anthropic", id: "claude-haiku" }
const flint = { providerID: "opencode", id: "flint" }
const models: Model[] = [
  { providerID: "amazon-bedrock", id: "claude-sonnet", variants: [{ id: "high" }] },
  { providerID: "anthropic", id: "claude-haiku", variants: [] },
  { providerID: "opencode", id: "flint", variants: [] },
]
const options = {
  roles: { task: ["nope-provider/x", "amazon-bedrock/claude-sonnet#high"], smol: "anthropic/claude-haiku", fake: ["nope-provider/x"] },
  agents: { general: "task" },
}
const header = (role: string) => ({ headers: { "x-opencode-model-role": role } })

// biome-ignore lint/suspicious/noExplicitAny: fake host context
const setup = async (host: ReturnType<typeof createHost>) => (await plugin.setup(host.context as any)) as () => Promise<void>

/** Simulate config agents that load after user plugins and set their own models. */
const configAgents = (host: ReturnType<typeof createHost>, agents: Agent[]) =>
  host.transform((editor) => {
    for (const agent of agents) editor.update(agent.id, (draft) => Object.assign(draft, structuredClone(agent)))
  })

describe("setup", () => {
  test("applies roles to builtins at setup", async () => {
    const host = createHost({ agents: [{ id: "general" }, { id: "build" }], models, options })
    const cleanup = await setup(host)
    expect(host.agents().get("general")?.model).toEqual(sonnet)
    expect(host.agents().get("build")?.model).toBeUndefined()
    host.close()
    await cleanup()
  })

  test("does not create agents mapped in options that do not exist", async () => {
    const host = createHost({ agents: [], models, options: { ...options, agents: { ghost: "task" } } })
    const cleanup = await setup(host)
    expect(host.agents().has("ghost")).toBe(false)
    host.close()
    await cleanup()
  })

  test("re-registers after config agents load so roles win over config models", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    await configAgents(host, [
      { id: "j4", model: flint, request: header("task") },
      { id: "j5", model: flint, request: header("unknown") },
      { id: "j6", model: flint, request: header("fake") },
      { id: "j3", request: header("smol") },
    ])
    await settle()
    const agents = host.agents()
    expect(agents.get("j4")?.model).toEqual(sonnet)
    expect(agents.get("j3")?.model).toEqual(haiku)
    expect(agents.get("j5")?.model).toEqual(flint)
    expect(agents.get("j6")?.model).toEqual(flint)
    expect(agents.get("general")?.model).toEqual(sonnet)
    // config transform + exactly one live plugin transform; converged after one re-register
    expect(host.activeTransforms()).toBe(2)
    expect(host.transformCalls()).toBe(3)
    host.close()
    await cleanup()
  })

  test("stops re-registering when agents never converge", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    host.setListOverride(() => [{ id: "general", model: flint }])
    for (let i = 0; i < 10; i++) host.emit({ type: "agent.updated" })
    await settle()
    expect(host.transformCalls()).toBe(1 + MAX_REREGISTER)
    expect(host.activeTransforms()).toBe(1)
    host.close()
    await cleanup()
  })

  test("re-resolves when model availability changes", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    expect(host.agents().get("general")?.model).toEqual(sonnet)
    host.setModels([...models, { providerID: "nope-provider", id: "x", variants: [] }])
    await settle()
    expect(host.agents().get("general")?.model).toEqual({ providerID: "nope-provider", id: "x" })
    host.close()
    await cleanup()
  })

  test("losing every candidate restores the agent's own model", async () => {
    const host = createHost({ agents: [{ id: "general", model: flint }], models, options })
    const cleanup = await setup(host)
    expect(host.agents().get("general")?.model).toEqual(sonnet)
    host.setModels([models[2] as Model])
    await settle()
    expect(host.agents().get("general")?.model).toEqual(flint)
    expect(host.activeTransforms()).toBe(1)
    host.close()
    await cleanup()
  })

  test("strips the role header from model requests", async () => {
    const host = createHost({ agents: [], models, options })
    const cleanup = await setup(host)
    expect(host.fireModelRequest({ "x-opencode-model-role": "task", other: "1" })).toEqual({ other: "1" })
    host.close()
    await cleanup()
  })

  test("cleanup disposes every registration", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    await configAgents(host, [{ id: "j4", model: flint, request: header("task") }])
    await settle()
    await cleanup()
    // only the simulated config transform remains
    expect(host.registrations()).toBe(1)
    expect(host.agents().get("general")?.model).toBeUndefined()
    host.close()
  })

  test("survives a failing model list", async () => {
    const host = createHost({ agents: [{ id: "general", model: flint }], models, options })
    host.context.model.list = async () => {
      throw new Error("boom")
    }
    const cleanup = await setup(host)
    expect(host.agents().get("general")?.model).toEqual(flint)
    host.close()
    await cleanup()
  })
})

describe("subagent model guard", () => {
  const opus = { providerID: "amazon-bedrock", id: "claude-opus" }
  const priced: Model[] = [
    { ...opus, variants: [], cost: [{ input: 4.4 }] },
    { providerID: "amazon-bedrock", id: "claude-sonnet", variants: [{ id: "high" }], cost: [{ input: 2 }] },
    { providerID: "anthropic", id: "claude-haiku", variants: [], cost: [{ input: 0.1 }] },
  ]
  const agents: Agent[] = [{ id: "general" }, { id: "plain" }, { id: "explore", model: haiku }, { id: "build", model: opus }]
  const guarded = { ...options, guard: true }

  test("spawnTarget skips resumed and malformed spawns", () => {
    expect(spawnTarget({ agent: "general", prompt: "x" })).toBe("general")
    expect(spawnTarget({ agent: "general", prompt: "x", sessionID: "ses_1" })).toBeUndefined()
    expect(spawnTarget({ prompt: "x" })).toBeUndefined()
    expect(spawnTarget(null)).toBeUndefined()
  })

  test("no hook without the guard option", async () => {
    const host = createHost({ agents, models: priced, options })
    const cleanup = await setup(host)
    expect(host.toolHooks()).toBe(0)
    host.close()
    await cleanup()
  })

  test("denies an inheriting spawn under an expensive session model", async () => {
    const host = createHost({ agents, models: priced, options: guarded, sessionModel: opus })
    const cleanup = await setup(host)
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(/explore \(anthropic\/claude-haiku\)/)
    await host.spawn("subagent", { agent: "general", prompt: "x" })
    await host.spawn("subagent", { agent: "explore", prompt: "x" })
    await host.spawn("subagent", { agent: "plain", prompt: "x", sessionID: "ses_2" })
    await host.spawn("shell", { agent: "plain", prompt: "x" })
    host.close()
    await cleanup()
    expect(host.toolHooks()).toBe(0)
  })

  test("falls back to the calling agent's model when the session has none", async () => {
    const host = createHost({ agents, models: priced, options: guarded })
    const cleanup = await setup(host)
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x" }, "build")).rejects.toThrow(/inherit/)
    await host.spawn("subagent", { agent: "plain", prompt: "x" }, "explore")
    host.close()
    await cleanup()
  })

  test("fails open when a lookup throws", async () => {
    const host = createHost({ agents, models: priced, options: guarded, sessionModel: opus })
    const cleanup = await setup(host)
    host.setSessionGet(async () => {
      throw new Error("gone")
    })
    await host.spawn("subagent", { agent: "plain", prompt: "x" })
    host.close()
    await cleanup()
  })
})
