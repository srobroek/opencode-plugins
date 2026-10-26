import { describe, expect, test } from "bun:test"
import plugin, { MAX_REREGISTER, type ModelRef, spawnTarget } from "./index.ts"

type Agent = { id: string; model?: ModelRef; request?: { headers?: Record<string, string> } }
type Model = { providerID: string; id: string; variants: { id: string }[]; cost?: { input: number }[] }
type SubagentTool = { id: string; name: string; description: string; input: unknown }
type ToolEditor = {
  add: (tool: { name: string; execute: (input: unknown) => Promise<{ content: string }> }) => void
  get: (id: string) => SubagentTool | undefined
  update: (id: string, fn: (tool: SubagentTool) => void) => void
}
const baseSubagent = (): SubagentTool => ({
  id: "subagent",
  name: "subagent",
  description: "Spawns an agent in a child session.",
  input: {
    type: "object",
    properties: { agent: { type: "string" }, prompt: { type: "string" }, model: { type: "string" }, sessionID: { type: "string" } },
    required: ["agent", "prompt"],
    additionalProperties: false,
  },
})
type Editor = {
  list: () => Agent[]
  get: (id: string) => Agent | undefined
  update: (id: string, fn: (agent: Agent) => void) => void
}

/** A host that replays agent transforms in registration order and emits `agent.updated` after each change. */
function createHost(input: {
  agents: Agent[]
  models: Model[]
  options: unknown
  sessionModel?: ModelRef
  defaultModel?: ModelRef
}) {
  const toolHooks: Array<{ name: string; callback: (payload: unknown) => Promise<void> }> = []
  let sessionGet: (id: string) => Promise<unknown> = async (id) =>
    sessions.get(id) ?? { id, model: input.sessionModel }
  const sessions = new Map<string, Record<string, unknown>>()
  const storage = new Map<string, unknown>()
  const calls: Array<{ method: string; input: unknown }> = []
  const tools = new Map<string, { execute: (input: unknown) => Promise<{ content: string }> }>()
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

  const toolTransforms: Array<(editor: ToolEditor) => void> = []
  let subagent = baseSubagent()
  let toolReplays = 0
  const replayTools = () => {
    toolReplays++
    tools.clear()
    const current = baseSubagent()
    const editor: ToolEditor = {
      add: (tool) => void tools.set(tool.name, tool),
      get: (id) => (id === "subagent" ? current : undefined),
      update: (id, fn) => {
        if (id === "subagent") fn(current)
      },
    }
    for (const transform of toolTransforms) transform(editor)
    subagent = current
  }
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
    model: { list: async () => ({ data: models }), default: async () => ({ data: input.defaultModel }) },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
    },
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => {
        registrations++
        toolTransforms.push(callback)
        replayTools()
        let live = true
        return {
          dispose: async () => {
            if (!live) return
            live = false
            registrations--
            toolTransforms.splice(toolTransforms.indexOf(callback), 1)
            replayTools()
          },
        }
      },
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
      synthetic: async (payload: unknown) => void calls.push({ method: "synthetic", input: payload }),
      prompt: async (payload: unknown) => void calls.push({ method: "prompt", input: payload }),
      switchModel: async (payload: unknown) => void calls.push({ method: "switchModel", input: payload }),
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
    toolHooks: () => toolHooks.filter((hook) => hook.name === "execute.before").length,
    subagent: () => subagent,
    toolReplays: () => toolReplays,
    /** Run `execute.before`; returns the input the tool would run with. */
    spawn: async (tool: string, payload: unknown, agent = "build", sessionID = "s1", id = "c1") => {
      const event = { tool, sessionID, agent, id, input: payload }
      for (const hook of toolHooks) if (hook.name === "execute.before") await hook.callback(event)
      return event.input as Record<string, unknown>
    },
    spawnFailed: async (payload: unknown, message: string, sessionID = "s1", id = "c1") => {
      for (const hook of toolHooks)
        if (hook.name === "execute.after")
          await hook.callback({ tool: "subagent", sessionID, agent: "build", id, input: payload, status: "error", error: { message } })
    },
    spawnDone: async (payload: unknown, metadata: unknown, sessionID = "s1", id = "c1") => {
      for (const hook of toolHooks)
        if (hook.name === "execute.after")
          await hook.callback({ tool: "subagent", sessionID, agent: "build", id, input: payload, status: "completed", result: { metadata } })
    },
    sessions,
    storage,
    calls,
    tools,
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

  test("without the guard option an inheriting spawn goes ahead", async () => {
    const host = createHost({ agents, models: priced, options, sessionModel: opus })
    const cleanup = await setup(host)
    expect(await host.spawn("subagent", { agent: "plain", prompt: "x" })).toEqual({ agent: "plain", prompt: "x" })
    host.close()
    await cleanup()
    expect(host.toolHooks()).toBe(0)
  })

  test("asks for the cheapest fitting role, and allows a role or an explicit model", async () => {
    const host = createHost({ agents, models: priced, options: guarded, sessionModel: opus })
    const cleanup = await setup(host)
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(
      /role: "smol" \(runs anthropic\/claude-haiku, \$0\.1\/M input tokens\)/,
    )
    expect(await host.spawn("subagent", { agent: "plain", prompt: "x", role: "smol" })).toEqual({
      agent: "plain",
      prompt: "x",
      model: "anthropic/claude-haiku",
    })
    await host.spawn("subagent", { agent: "plain", prompt: "x", model: "amazon-bedrock/claude-opus" })
    // A role with nothing available falls through to the guard.
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x", role: "fake" })).rejects.toThrow(/inherit/)
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

  test("a session on the default model, or inheriting it from its parent, is judged on the default", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models: priced, options: guarded, defaultModel: opus })
    host.sessions.set("root", { id: "root" })
    host.sessions.set("child", { id: "child", parentID: "root", agent: "plain" })
    const cleanup = await setup(host)
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x" }, "build", "root")).rejects.toThrow(
      /inherit this session's expensive model amazon-bedrock\/claude-opus/,
    )
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x" }, "plain", "child")).rejects.toThrow(/inherit/)
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

describe("subagent role parameter", () => {
  const roleOf = (host: ReturnType<typeof createHost>) =>
    (host.subagent().input as { properties: Record<string, { enum?: string[]; description?: string }> }).properties.role

  test("adds a role enum of the configured roles to the built-in subagent tool", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    const role = roleOf(host)
    expect(role?.enum).toEqual(["fake", "smol", "task"])
    expect(role?.description).toContain("- 'smol': cheap and fast")
    expect(role?.description).toContain("- 'fake': work that suits the 'fake' model role (no model available now")
    expect(host.subagent().description).toContain("Set `role` on every new spawn")
    expect((host.subagent().input as { required: string[] }).required).toEqual(["agent", "prompt"])
    host.close()
    await cleanup()
    expect(roleOf(host)).toBeUndefined()
  })

  test("no roles, no parameter", async () => {
    const host = createHost({ agents: [], models, options: {} })
    const cleanup = await setup(host)
    expect(roleOf(host)).toBeUndefined()
    expect(host.subagent().description).toBe("Spawns an agent in a child session.")
    host.close()
    await cleanup()
  })

  test("re-describes the roles when availability changes, not on every event", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    const before = host.toolReplays()
    host.emit({ type: "agent.updated" })
    await settle()
    expect(host.toolReplays()).toBe(before)
    host.setModels([...models, { providerID: "nope-provider", id: "x", variants: [], cost: [{ input: 0.5 }] }])
    await settle()
    expect(roleOf(host)?.description).toContain("- 'fake': work that suits the 'fake' model role (low cost, $0.5/M input tokens)")
    host.close()
    await cleanup()
    expect(roleOf(host)).toBeUndefined()
  })

  test("precedence: explicit model, then role, then the agent", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    expect(await host.spawn("subagent", { agent: "general", prompt: "x", role: "smol" })).toEqual({
      agent: "general",
      prompt: "x",
      model: "anthropic/claude-haiku",
    })
    expect(await host.spawn("subagent", { agent: "general", prompt: "x", role: "smol", model: "opencode/flint" })).toEqual({
      agent: "general",
      prompt: "x",
      model: "opencode/flint",
    })
    // No role: the input is untouched and the host runs general on its role's model.
    expect(await host.spawn("subagent", { agent: "general", prompt: "x" })).toEqual({ agent: "general", prompt: "x" })
    expect(host.agents().get("general")?.model).toEqual(sonnet)
    expect(await host.spawn("subagent", { agent: "general", prompt: "x", role: "task", sessionID: "ses_1" })).toEqual({
      agent: "general",
      prompt: "x",
      sessionID: "ses_1",
    })
    await expect(host.spawn("subagent", { agent: "general", prompt: "x", role: "huge" })).rejects.toThrow(
      "Unknown model role 'huge'. Pass one of: fake, smol, task.",
    )
    host.close()
    await cleanup()
  })
})

describe("model_roles_check", () => {
  test("lists roles, candidate status and agent resolution", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    const tool = host.tools.get("model_roles_check")
    const result = await tool?.execute({})
    expect(result?.content).toContain("Role task → amazon-bedrock/claude-sonnet#high")
    expect(result?.content).toContain("  - nope-provider/x: provider unavailable")
    expect(result?.content).toContain("  - general (role task) → amazon-bedrock/claude-sonnet#high")
    expect(result?.content).toContain("subagent `role` parameter:")
    expect(result?.content).toContain("  - 'task': everyday implementation and investigation")
    host.close()
    await cleanup()
    expect(host.tools.size).toBe(0)
  })
})

describe("runtime fallback", () => {
  const fallbackOptions = {
    roles: { task: ["amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku"] },
    agents: { general: "task", build: "task" },
  }
  const failed = (sessionID: string, error: Record<string, unknown>) => ({
    type: "session.execution.failed",
    data: { sessionID, error },
  })
  const methods = (host: ReturnType<typeof createHost>, method: string) => host.calls.filter((c) => c.method === method)

  test("a root failure marks the model, moves the role and retries once per window", async () => {
    const host = createHost({ agents: [{ id: "general" }, { id: "build" }], models, options: fallbackOptions })
    host.sessions.set("r", { id: "r", agent: "build", model: sonnet })
    const cleanup = await setup(host)
    host.emit(failed("r", { type: "api", message: "Too many requests", status: 429 }))
    await settle()
    expect(host.agents().get("general")?.model).toEqual(haiku)
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/claude-sonnet"])
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "r", model: haiku }])
    const prompt = methods(host, "prompt")[0]?.input as { text: string; metadata: unknown }
    expect(prompt.text).toContain("Role task now resolves to anthropic/claude-haiku")
    expect(prompt.metadata).toEqual({ source: "srobroek.model-roles", kind: "fallback-retry" })

    // The retried model fails too: no second retry inside the window, only a visible note.
    host.sessions.set("r", { id: "r", agent: "build", model: haiku })
    host.emit(failed("r", { type: "api", message: "Overloaded", status: 529 }))
    await settle()
    expect(methods(host, "switchModel")).toHaveLength(1)
    expect(methods(host, "prompt")).toHaveLength(1)
    expect(methods(host, "synthetic")).toHaveLength(1)
    // Every candidate is unhealthy now: the least recently failed one wins.
    expect(host.agents().get("general")?.model).toEqual(sonnet)
    host.close()
    await cleanup()
  })

  test("retryOnFallback: false only notifies", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: { ...fallbackOptions, retryOnFallback: false } })
    host.sessions.set("r", { id: "r", agent: "build", model: sonnet })
    const cleanup = await setup(host)
    host.emit(failed("r", { type: "api", message: "Model unavailable: amazon-bedrock/claude-sonnet" }))
    await settle()
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(methods(host, "synthetic")).toHaveLength(1)
    host.close()
    await cleanup()
  })

  test("a subagent failure tells the parent once, from the event or the tool error", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options: fallbackOptions })
    host.sessions.set("r", { id: "r" })
    host.sessions.set("c", { id: "c", parentID: "r", agent: "general", model: sonnet })
    const cleanup = await setup(host)
    host.emit(failed("c", { type: "api", message: "ThrottlingException", status: 429 }))
    await settle()
    await host.spawnFailed({ agent: "general", prompt: "x" }, "Subagent failed (c): ThrottlingException", "r")
    await host.spawnFailed({ agent: "general", prompt: "x" }, "rate limit exceeded", "r")
    await settle()
    const notes = methods(host, "synthetic").map((c) => c.input as { sessionID: string; text: string })
    expect(notes).toHaveLength(1)
    expect(notes[0]?.sessionID).toBe("r")
    expect(notes[0]?.text).toContain("Subagent 'general' failed")
    expect(notes[0]?.text).toContain("may be retried")
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/claude-sonnet"])
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(host.agents().get("general")?.model).toEqual(haiku)
    host.close()
    await cleanup()
  })

  test("a spawn that fails with Model unavailable marks that model", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    await host.spawnFailed({ agent: "general", prompt: "x" }, "Subagent failed (c): Model unavailable: amazon-bedrock/claude-sonnet")
    await settle()
    expect(host.agents().get("general")?.model).toEqual(haiku)
    expect(methods(host, "synthetic")).toHaveLength(1)
    host.close()
    await cleanup()
  })

  test("a root session on the default model retries on the next candidate", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: fallbackOptions, defaultModel: sonnet })
    host.sessions.set("r", { id: "r" })
    const cleanup = await setup(host)
    host.emit(failed("r", { type: "provider.internal", message: "Service Unavailable", status: 503 }))
    await settle()
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/claude-sonnet"])
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "r", model: haiku }])
    host.close()
    await cleanup()
  })

  test("a spawn error names its child as sessionID: <id>", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options: fallbackOptions })
    // The child ran on haiku, not on what general resolves to now: the child's model is the one blamed.
    host.sessions.set("c", { id: "c", parentID: "r", agent: "general", model: haiku })
    const cleanup = await setup(host)
    await host.spawnFailed({ agent: "general", prompt: "x" }, "Subagent failed (sessionID: c): Service Unavailable: upstream overloaded", "r")
    await settle()
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["anthropic/claude-haiku"])
    expect(host.agents().get("general")?.model).toEqual(sonnet)
    host.close()
    await cleanup()
  })

  test("non-model failures change nothing", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options: fallbackOptions })
    host.sessions.set("r", { id: "r", agent: "general", model: sonnet })
    const cleanup = await setup(host)
    host.emit(failed("r", { type: "tool", message: "Model unavailable: x/y" }))
    host.emit(failed("r", { type: "unknown", message: "prompt is too long" }))
    await host.spawnFailed({ agent: "general", prompt: "x" }, "file not found")
    await settle()
    expect(host.storage.has("health")).toBe(false)
    expect(host.calls).toHaveLength(0)
    expect(host.agents().get("general")?.model).toEqual(sonnet)
    host.close()
    await cleanup()
  })

  test("a child spawned with a role falls back within that role and can be resumed on the next model", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: fallbackOptions })
    host.sessions.set("r", { id: "r" })
    host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-1")
    expect(input.model).toBe("amazon-bedrock/claude-sonnet#high")
    host.emit({ type: "session.created", data: { sessionID: "c", parentID: "r", agent: "plain", model: sonnet } })
    host.emit(failed("c", { type: "api", message: "ThrottlingException", status: 429 }))
    await settle()
    expect(host.storage.get("spawn-role:c")).toBe("task")
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: haiku }])
    const note = methods(host, "synthetic")[0]?.input as { sessionID: string; text: string }
    expect(note.sessionID).toBe("r")
    expect(note.text).toContain('Spawn it again with role: "task"; that role now runs anthropic/claude-haiku.')
    expect(note.text).toContain("resume it with sessionID c")
    // The same role now resolves past the unhealthy model.
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-2")).model).toBe(
      "anthropic/claude-haiku",
    )
    host.close()
    await cleanup()
  })

  test("a role spawn whose tool call fails names the role in the parent's note", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-1")
    await host.spawnFailed(input, "Subagent failed (sessionID: gone): Service Unavailable", "r", "call-1")
    await settle()
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/claude-sonnet"])
    const note = methods(host, "synthetic")[0]?.input as { text: string }
    expect(note.text).toContain('Spawn it again with role: "task"')
    host.close()
    await cleanup()
  })

  test("a completed role spawn records the child's role", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-1")
    await host.spawnDone(input, { sessionID: "c2", status: "completed" }, "r", "call-1")
    expect(host.storage.get("spawn-role:c2")).toBe("task")
    host.close()
    await cleanup()
  })

  test("stored health survives a restart", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options: fallbackOptions })
    host.storage.set("health", { "amazon-bedrock/claude-sonnet": { failedAt: Date.now(), until: Date.now() + 60_000, reason: "x" } })
    const cleanup = await setup(host)
    expect(host.agents().get("general")?.model).toEqual(haiku)
    host.close()
    await cleanup()
  })
})
