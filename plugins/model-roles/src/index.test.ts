import { describe, expect, setSystemTime, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { withOptionalString } from "../../lib/src/tool-schema.ts"
import { WORKTREE_PARAM, WORKTREE_PARAM_DESCRIPTION } from "../../subagent-worktree/src/lane.ts"
import reference from "./fixtures/reference.json"
import work from "./fixtures/work-models.json"
import plugin, { MAX_REREGISTER, type ModelRef, readTiers, spawnTarget } from "./index.ts"

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
  references?: Array<Model & { family?: string; time?: { released?: number } }>
}) {
  const toolHooks: Array<{ name: string; callback: (payload: unknown) => Promise<void> }> = []
  let sessionGet: (id: string) => Promise<unknown> = async (id) =>
    sessions.get(id) ?? { id, model: input.sessionModel }
  const sessions = new Map<string, Record<string, unknown>>()
  const storage = new Map<string, unknown>()
  let rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {}
  const calls: Array<{ method: string; input: unknown }> = []
  let generate: (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }> = async () => ({
    text: '{"role": "cheap", "confident": true}',
  })
  const tools = new Map<string, { execute: (input: unknown) => Promise<{ content: string }> }>()
  const transforms: Array<{ callback: (editor: Editor) => void }> = []
  const hooks: Array<{ name: string; callback: (payload: unknown) => unknown }> = []
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
    model: {
      list: async () => ({ data: models }),
      default: async () => ({ data: input.defaultModel }),
      transform: async (callback: (editor: { provider: { list: () => unknown[] } }) => void) => {
        registrations++
        callback({ provider: { list: () => [{ models: new Map((input.references ?? []).map((m) => [m.id, m])) }] } })
        return { dispose: async () => void registrations-- }
      },
    },
    generate: {
      text: async (payload: { prompt: string; model?: ModelRef }) => {
        calls.push({ method: "generate", input: payload })
        return generate(payload)
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
        registrations++
        rpcHandlers = handlers
        return { events: { emit: async () => {} }, dispose: async () => void registrations-- }
      },
    },
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
      hook: async (name: string, callback: (payload: unknown) => unknown) => {
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
    /** Run the `retry` hooks as the host does before each retry; returns the final decision. */
    fireRetry: async (
      event: { sessionID: string; agent: string; model: ModelRef; error: Record<string, unknown>; attempt: number },
      decision: { retry: boolean; delay?: number } = { retry: true, delay: 1_500 },
    ) => {
      const payload: Record<string, unknown> = { ...event, decision }
      for (const hook of hooks) if (hook.name === "retry") await hook.callback(payload)
      return payload.decision
    },
    fireModelRequest: (headers: Record<string, string>) => {
      for (const hook of hooks) if (hook.name === "model.request") hook.callback({ headers })
      return headers
    },
    /** Run the `context` hooks on the current subagent tool as the host does for one request. */
    fireContext: async (sessionID: string) => {
      const tools = { subagent: { description: subagent.description, input: structuredClone(subagent.input) } }
      for (const hook of hooks) if (hook.name === "context") await hook.callback({ sessionID, agent: "build", tools })
      return tools.subagent as { description: string; input: { properties: Record<string, { enum?: string[]; description?: string }> } }
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
    rpc: (method: string, input: unknown = {}) => rpcHandlers[method]?.(input),
    calls,
    tools,
    setGenerate: (fn: typeof generate) => {
      generate = fn
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

  test("re-registers after config agents load; their model pins win over tiers", async () => {
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
    expect(agents.get("j4")?.model).toEqual(flint)
    expect(agents.get("j3")?.model).toEqual(haiku)
    expect(agents.get("j3")?.request?.headers?.["x-opencode-model-fallback"]).toBe("anthropic/claude-haiku")
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
    host.setListOverride(() => [{ id: "general" }])
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

  test("a user pin set before the plugin wins; a fallback model gives way and comes back", async () => {
    const pinned = createHost({ agents: [{ id: "general", model: flint }], models, options })
    const stop = await setup(pinned)
    expect(pinned.agents().get("general")?.model).toEqual(flint)
    pinned.close()
    await stop()
    const fallback = { headers: { "x-opencode-model-fallback": "opencode/flint" } }
    const host = createHost({ agents: [{ id: "general", model: flint, request: fallback }], models, options })
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
    { ...opus, variants: [], cost: [{ input: 12 }] },
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

  test("asks for the cheapest fitting tier, and allows a tier or an explicit model", async () => {
    const host = createHost({ agents, models: priced, options: guarded, sessionModel: opus })
    const cleanup = await setup(host)
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(
      /tier: "cheap" \(runs anthropic\/claude-haiku, metered, \$0\.1\/M input tokens\)/,
    )
    expect(await host.spawn("subagent", { agent: "plain", prompt: "x", role: "smol" })).toEqual({
      agent: "plain",
      prompt: "x",
      model: "anthropic/claude-haiku",
    })
    await host.spawn("subagent", { agent: "plain", prompt: "x", model: "anthropic/claude-haiku" })
    // A role with nothing available falls through to the guard.
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x", role: "fake" })).rejects.toThrow(/inherit/)
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x", model: "amazon-bedrock/claude-opus" })).rejects.toThrow(
      /sets model amazon-bedrock\/claude-opus itself/,
    )
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
    (host.subagent().input as { properties: Record<string, { enum?: string[]; description?: string }> }).properties.tier

  test("adds a tier enum of the built-in and custom tiers to the built-in subagent tool", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    const role = roleOf(host)
    expect(role?.enum).toEqual(["cheap", "standard", "strong", "reviewer", "fake"])
    expect(role?.description).toContain("- 'cheap': cheap and fast")
    expect(role?.description).toContain("- 'fake': work that suits the 'fake' tier (no model available now")
    expect(host.subagent().description).toContain("Set `tier` on every new spawn")
    expect((host.subagent().input as { required: string[] }).required).toEqual(["agent", "prompt"])
    host.close()
    await cleanup()
    expect(roleOf(host)).toBeUndefined()
  })

  test("composes with subagent-worktree's worktree parameter in either load order", async () => {
    // The same transform subagent-worktree registers on the subagent tool.
    const worktree = (editor: ToolEditor) =>
      editor.update("subagent", (tool) => {
        const input = withOptionalString(tool.input, WORKTREE_PARAM, WORKTREE_PARAM_DESCRIPTION)
        if (input !== undefined) tool.input = input
      })
    for (const order of ["worktree first", "model-roles first"]) {
      const host = createHost({ agents: [{ id: "general" }], models, options })
      const tool = host.context.tool as { transform: (callback: (editor: ToolEditor) => void) => Promise<{ dispose: () => Promise<void> }> }
      const before = order === "worktree first" ? await tool.transform(worktree) : undefined
      const cleanup = await setup(host)
      const after = order === "model-roles first" ? await tool.transform(worktree) : undefined
      const input = host.subagent().input as { properties: Record<string, { enum?: string[] }>; required: string[] }
      expect({ order, keys: Object.keys(input.properties).sort() }).toEqual({
        order,
        keys: ["agent", "model", "prompt", "role", "sessionID", "tier", "worktree"],
      })
      expect(input.properties.tier?.enum).toContain("cheap")
      expect(input.required).toEqual(["agent", "prompt"])
      expect(host.subagent().description).toContain("Set `tier` on every new spawn")
      host.close()
      await cleanup()
      await (before ?? after)?.dispose()
    }
  })

  test("no tier resolves, no parameter", async () => {
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
    expect(roleOf(host)?.description).toContain("- 'fake': work that suits the 'fake' tier (metered, $0.5/M input tokens)")
    host.close()
    await cleanup()
    expect(roleOf(host)).toBeUndefined()
  })

  test("a session keeps the tier parameter it first saw; new sessions get the current one", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    const cleanup = await setup(host)
    const first = await host.fireContext("s1")
    expect(first.input.properties.tier?.description).not.toContain("$0.5/M")
    host.setModels([...models, { providerID: "nope-provider", id: "x", variants: [], cost: [{ input: 0.5 }] }])
    await settle()
    expect(roleOf(host)?.description).toContain("$0.5/M")
    expect(JSON.stringify(await host.fireContext("s1"))).toBe(JSON.stringify(first))
    expect((await host.fireContext("s2")).input.properties.tier?.description).toContain("$0.5/M")
    // A restarted plugin reads the frozen parameter back from storage.
    host.close()
    await cleanup()
    const again = createHost({ agents: [{ id: "general" }], models, options })
    for (const [key, value] of host.storage) again.storage.set(key, value)
    const cleanupAgain = await setup(again)
    expect(JSON.stringify((await again.fireContext("s1")).input)).toBe(JSON.stringify(first.input))
    again.close()
    await cleanupAgain()
  })

  test("the tier parameters go last whatever order the tool transforms ran in", async () => {
    const worktree = (editor: ToolEditor) =>
      editor.update("subagent", (tool) => {
        const input = withOptionalString(tool.input, WORKTREE_PARAM, WORKTREE_PARAM_DESCRIPTION)
        if (input !== undefined) tool.input = input
      })
    const seen: string[] = []
    for (const order of ["worktree first", "model-roles first"]) {
      const host = createHost({ agents: [{ id: "general" }], models, options })
      const tool = host.context.tool as { transform: (callback: (editor: ToolEditor) => void) => Promise<{ dispose: () => Promise<void> }> }
      const before = order === "worktree first" ? await tool.transform(worktree) : undefined
      const cleanup = await setup(host)
      const after = order === "model-roles first" ? await tool.transform(worktree) : undefined
      const sent = await host.fireContext("s1")
      expect(Object.keys(sent.input.properties).slice(-3)).toEqual(["worktree", "tier", "role"])
      seen.push(JSON.stringify(sent))
      host.close()
      await cleanup()
      await (before ?? after)?.dispose()
    }
    expect(seen[0]).toBe(seen[1] as string)
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
      "Unknown model tier 'huge'. Pass one of: cheap, standard, strong, reviewer, fake.",
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
    expect(result?.content).toContain("subagent `tier` parameter:")
    expect(result?.content).toContain("  - 'standard': everyday implementation and investigation")
    expect(result?.content).toContain("Tier fake has no purpose")
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

  test("the retry hook moves a failing request to the role's next model, in the same turn", async () => {
    const host = createHost({ agents: [{ id: "general" }, { id: "build" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    const error = { type: "provider.internal", message: "Service Unavailable", status: 503 }
    // The first two retries stay on the model: the host's budget for a transient failure.
    expect(await host.fireRetry({ sessionID: "r", agent: "build", model: sonnet, error, attempt: 3 })).toEqual({ retry: true, delay: 1_500 })
    expect(host.storage.has("health")).toBe(false)
    const decision = await host.fireRetry({ sessionID: "r", agent: "build", model: sonnet, error, attempt: 4 })
    expect(decision).toEqual({ retry: true, delay: 0 })
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "r", model: haiku }])
    expect(methods(host, "prompt")).toHaveLength(0)
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/claude-sonnet"])
    // One failure moves the request, not the tier.
    expect(host.agents().get("general")?.model).toEqual(sonnet)

    // The next model fails too, and the first one just failed: there is nowhere to switch, so the host's own decision stands.
    const again = await host.fireRetry({ sessionID: "r", agent: "build", model: haiku, error, attempt: 5 })
    expect(again).toEqual({ retry: true, delay: 1_500 })
    expect(methods(host, "switchModel")).toHaveLength(1)
    host.close()
    await cleanup()
  })

  test("a non-retryable model error is retried on the next model; other errors are left alone", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    const auth = { type: "provider.auth", message: "Unauthorized", status: 401 }
    const base = { sessionID: "r", agent: "build", model: sonnet, attempt: 2 }
    expect(await host.fireRetry({ ...base, error: { type: "tool", message: "file not found" } })).toEqual({ retry: true, delay: 1_500 })
    expect(await host.fireRetry({ ...base, error: auth })).toEqual({ retry: true, delay: 0 })
    host.close()
    await cleanup()
  })

  test("hostRetries sets the same-model budget", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: { ...fallbackOptions, hostRetries: 1 } })
    const cleanup = await setup(host)
    const error = { type: "api", message: "Too many requests", status: 429 }
    const base = { sessionID: "r", agent: "build", model: sonnet, error }
    expect(await host.fireRetry({ ...base, attempt: 2 })).toEqual({ retry: true, delay: 1_500 })
    expect(host.storage.has("health")).toBe(false)
    expect(await host.fireRetry({ ...base, attempt: 3 })).toEqual({ retry: true, delay: 0 })
    host.close()
    await cleanup()
  })

  test("a child spawned with a role is switched within that role", async () => {
    const roles = { ...fallbackOptions, roles: { ...fallbackOptions.roles, cheap: ["anthropic/claude-haiku", "opencode/flint"] } }
    const host = createHost({ agents: [{ id: "plain" }], models, options: roles })
    const cleanup = await setup(host)
    await host.spawn("subagent", { agent: "plain", prompt: "x", role: "cheap" }, "build", "r", "call-1")
    host.emit({ type: "session.created", data: { sessionID: "c", parentID: "r", agent: "plain", model: haiku } })
    await settle()
    const error = { type: "provider.internal", message: "Overloaded", status: 529 }
    expect(await host.fireRetry({ sessionID: "c", agent: "plain", model: haiku, error, attempt: 4 })).toEqual({ retry: true, delay: 0 })
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: flint }])
    host.close()
    await cleanup()
  })

  test("a provider-scoped failure moves the request past every model of that provider, without sitting it out", async () => {
    const roles = { ...fallbackOptions, roles: { task: ["amazon-bedrock/claude-sonnet#high", "amazon-bedrock/other", "anthropic/claude-haiku"] } }
    const all = [...models, { providerID: "amazon-bedrock", id: "other", variants: [] }]
    const host = createHost({ agents: [{ id: "build" }], models: all, options: roles })
    const cleanup = await setup(host)
    const sso = { type: "provider.auth", message: "The SSO session associated with this profile has expired", status: 403 }
    expect(await host.fireRetry({ sessionID: "r", agent: "build", model: sonnet, error: sso, attempt: 2 })).toEqual({ retry: true, delay: 0 })
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/*"])
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "r", model: haiku }])
    expect(host.agents().get("build")?.model).toEqual(sonnet)
    host.close()
    await cleanup()
  })

  test("a request-scoped failure cools down only that model", async () => {
    const roles = { ...fallbackOptions, roles: { task: ["amazon-bedrock/claude-sonnet#high", "amazon-bedrock/other"] } }
    const all = [...models, { providerID: "amazon-bedrock", id: "other", variants: [] }]
    const host = createHost({ agents: [{ id: "build" }], models: all, options: roles })
    const cleanup = await setup(host)
    const invalid = { type: "provider.invalid-request", message: "The provided model identifier is invalid.", status: 400 }
    await host.fireRetry({ sessionID: "r", agent: "build", model: sonnet, error: invalid, attempt: 2 })
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/claude-sonnet"])
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "r", model: { providerID: "amazon-bedrock", id: "other" } }])
    host.close()
    await cleanup()
  })

  const chain = { type: "provider.auth", message: "AWS default credential chain failed: Could not load credentials from any providers" }
  const declined = { retry: false }

  test("a credentials blip is retried on the same model with backoff though the host would not, and nothing sits out", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    const base = { sessionID: "r", agent: "build", model: sonnet, error: chain }
    expect(await host.fireRetry({ ...base, attempt: 2 }, declined)).toEqual({ retry: true, delay: 2_000 })
    expect(await host.fireRetry({ ...base, attempt: 3 }, declined)).toEqual({ retry: true, delay: 4_000 })
    expect(host.storage.has("health")).toBe(false)
    expect(methods(host, "switchModel")).toHaveLength(0)
    // Past the budget the request moves to another provider; the tier stays where it was.
    expect(await host.fireRetry({ ...base, attempt: 4 }, declined)).toEqual({ retry: true, delay: 0 })
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "r", model: haiku }])
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/*"])
    expect(host.agents().get("build")?.model).toEqual(sonnet)
    host.close()
    await cleanup()
  })

  test("with nowhere to switch, a transient failure keeps retrying on its model for about a minute", async () => {
    const roles = { ...fallbackOptions, roles: { task: ["amazon-bedrock/claude-sonnet#high", "amazon-bedrock/other"] } }
    const all = [...models, { providerID: "amazon-bedrock", id: "other", variants: [] }]
    const host = createHost({ agents: [{ id: "build" }], models: all, options: roles })
    const cleanup = await setup(host)
    const base = { sessionID: "r", agent: "build", model: sonnet, error: chain }
    const delays = []
    for (let attempt = 2; attempt <= 7; attempt++) delays.push((await host.fireRetry({ ...base, attempt }, declined)) as { delay?: number })
    expect(delays.map((decision) => decision.delay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, undefined])
    expect(methods(host, "switchModel")).toHaveLength(0)
    // A permanent failure the host gives up on is left alone.
    const auth = { type: "provider.auth", message: "Unauthorized", status: 401 }
    expect(await host.fireRetry({ ...base, error: auth, attempt: 2 }, declined)).toEqual(declined)
    host.close()
    await cleanup()
  })

  test("a provider that keeps failing sits out, and for twice as long when it fails again after", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    const start = Date.now()
    const at = async (offset: number, sessionID: string) => {
      setSystemTime(new Date(start + offset))
      await host.fireRetry({ sessionID, agent: "build", model: sonnet, error: chain, attempt: 4 }, declined)
      return (host.storage.get("health") as Record<string, { until: number }>)["amazon-bedrock/*"]?.until ?? 0
    }
    try {
      // Parallel requests failing together are one episode; three episodes ten seconds apart sit it out.
      await at(0, "r1")
      await at(500, "r2")
      await at(15_000, "r3")
      expect(host.agents().get("build")?.model).toEqual(sonnet)
      expect(await at(30_000, "r4")).toBe(start + 30_000 + 60_000)
      expect(host.agents().get("build")?.model).toEqual(haiku)
      expect(await at(95_000, "r5")).toBe(start + 95_000 + 120_000)
    } finally {
      setSystemTime()
    }
    host.close()
    await cleanup()
  })

  test("a request never switches back to a model it already failed on, however slowly they fail", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    const error = { type: "provider.internal", message: "Service Unavailable", status: 503 }
    const start = Date.now()
    const fire = (offset: number, model: ModelRef, attempt: number) => {
      setSystemTime(new Date(start + offset))
      return host.fireRetry({ sessionID: "r", agent: "build", model, error, attempt }, declined)
    }
    try {
      expect(await fire(0, sonnet, 4)).toEqual({ retry: true, delay: 0 })
      // Long after sonnet's failure stopped being recent, haiku fails too: no switch back, only same-model retries.
      expect(await fire(200_000, haiku, 5)).toEqual({ retry: true, delay: 16_000 })
      expect(await fire(400_000, haiku, 7)).toEqual(declined)
      expect(methods(host, "switchModel")).toHaveLength(1)
      // The next request starts afresh.
      await fire(500_000, haiku, 2)
      expect(await fire(510_000, haiku, 4)).toEqual({ retry: true, delay: 0 })
      expect(methods(host, "switchModel").map((c) => (c.input as { model: ModelRef }).model)).toEqual([haiku, sonnet])
    } finally {
      setSystemTime()
    }
    host.close()
    await cleanup()
  })

  test("while a switch is still landing, a transient failure the host gives up on keeps its retries", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: { ...fallbackOptions, switchTimeoutMs: 20 } })
    host.context.session.switchModel = (payload: unknown) => {
      host.calls.push({ method: "switchModel", input: payload })
      return new Promise<undefined>(() => {})
    }
    const cleanup = await setup(host)
    const base = { sessionID: "r", agent: "build", model: sonnet, error: chain }
    expect(await host.fireRetry({ ...base, attempt: 4 }, declined)).toEqual({ retry: true, delay: 8_000 })
    expect(await host.fireRetry({ ...base, attempt: 5 }, declined)).toEqual({ retry: true, delay: 16_000 })
    expect(methods(host, "switchModel")).toHaveLength(1)
    host.close()
    await cleanup()
  })

  test("a spent quota sits out until the reported reset, else quotaCooldownMs", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: { ...fallbackOptions, quotaCooldownMs: 3_600_000 } })
    const cleanup = await setup(host)
    const reset = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const weekly = { type: "api", message: `You have hit your weekly usage limit. Resets at ${reset}`, status: 429 }
    await host.fireRetry({ sessionID: "r", agent: "build", model: sonnet, error: weekly, attempt: 2 })
    const entry = (host.storage.get("health") as Record<string, { until: number }>)["amazon-bedrock/*"]
    expect(entry?.until).toBe(Date.parse(reset))
    host.close()
    await cleanup()
  })

  test("a slow switch leaves the host's decision alone and is never doubled", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: { ...fallbackOptions, switchTimeoutMs: 20 } })
    let land: (() => void) | undefined
    host.context.session.switchModel = (payload: unknown) => {
      host.calls.push({ method: "switchModel", input: payload })
      return new Promise<undefined>((resolve) => {
        land = () => resolve(undefined)
      })
    }
    const cleanup = await setup(host)
    const auth = { type: "provider.auth", message: "Unauthorized", status: 401 }
    const base = { sessionID: "r", agent: "build", model: sonnet, error: auth }
    expect(await host.fireRetry({ ...base, attempt: 2 })).toEqual({ retry: true, delay: 1_500 })
    expect(await host.fireRetry({ ...base, attempt: 3 })).toEqual({ retry: true, delay: 1_500 })
    expect(methods(host, "switchModel")).toHaveLength(1)
    land?.()
    await settle()
    // Landed: the next failure is the new model's, and is handled as usual.
    await host.fireRetry({ ...base, model: haiku, attempt: 4 })
    expect(methods(host, "switchModel")).toHaveLength(1)
    host.close()
    await cleanup()
  })

  test("a root session that still fails gets a note and no replay", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: fallbackOptions })
    host.sessions.set("r", { id: "r", agent: "build", model: sonnet })
    const cleanup = await setup(host)
    host.emit(failed("r", { type: "api", message: "Model unavailable: amazon-bedrock/claude-sonnet" }))
    await settle()
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(methods(host, "prompt")).toHaveLength(0)
    const note = methods(host, "synthetic")[0]?.input as { text: string; resume: boolean }
    expect(note.text).toContain("Tier task now resolves to anthropic/claude-haiku")
    expect(note.resume).toBe(false)
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
    expect(notes[0]?.text).toContain("stays in use")
    expect(notes[0]?.text).toContain("Resume it with sessionID c, or spawn it again.")
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/claude-sonnet"])
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(host.agents().get("general")?.model).toEqual(sonnet)
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

  test("a root session on the default model is blamed on the default", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: fallbackOptions, defaultModel: sonnet })
    host.sessions.set("r", { id: "r" })
    const cleanup = await setup(host)
    host.emit(failed("r", { type: "provider.internal", message: "Service Unavailable", status: 503 }))
    await settle()
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/claude-sonnet"])
    expect(methods(host, "switchModel")).toHaveLength(0)
    // One failure moves nothing, so the root session gets no note.
    expect(methods(host, "synthetic")).toHaveLength(0)
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
    const host = createHost({ agents: [{ id: "plain" }], models, options: { ...fallbackOptions, flapCount: 1 } })
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
    expect(note.text).toContain('Spawn it again with tier: "task"; that tier now runs anthropic/claude-haiku.')
    expect(note.text).toContain("resume it with sessionID c")
    // The same role now resolves past the unhealthy model.
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-2")).model).toBe(
      "anthropic/claude-haiku",
    )
    host.close()
    await cleanup()
  })

  test("a role spawn whose tool call fails names the role in the parent's note", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: { ...fallbackOptions, flapCount: 1 } })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-1")
    await host.spawnFailed(input, "Subagent failed (sessionID: gone): Service Unavailable", "r", "call-1")
    await settle()
    expect(Object.keys(host.storage.get("health") as object)).toEqual(["amazon-bedrock/claude-sonnet"])
    const note = methods(host, "synthetic")[0]?.input as { text: string }
    expect(note.text).toContain('Spawn it again with tier: "task"')
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

describe("auto routing", () => {
  const opus = { providerID: "amazon-bedrock", id: "claude-opus" }
  const priced: Model[] = [
    { ...opus, variants: [], cost: [{ input: 12 }] },
    { providerID: "amazon-bedrock", id: "claude-sonnet", variants: [{ id: "high" }], cost: [{ input: 2 }] },
    { providerID: "anthropic", id: "claude-haiku", variants: [], cost: [{ input: 0.1 }] },
  ]
  const agents: Agent[] = [{ id: "general" }, { id: "plain" }, { id: "explore", model: haiku }]
  const roles = { task: "amazon-bedrock/claude-sonnet#high", smol: "anthropic/claude-haiku", tiny: "anthropic/claude-haiku", slow: "amazon-bedrock/claude-opus" }
  const autoOptions = (auto: unknown, extra: Record<string, unknown> = {}) => ({ roles, agents: {}, auto, ...extra })
  const generations = (host: ReturnType<typeof createHost>) => host.calls.filter((c) => c.method === "generate")

  test("routes an unroled spawn to the decided role and records it", async () => {
    const host = createHost({ agents, models: priced, options: autoOptions({ decider: "@tiny" }), sessionModel: opus })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "general", description: "find parser", prompt: "where is parseOptions?" })
    expect(input).toEqual({
      agent: "general",
      description: "find parser [auto: cheap, confident]",
      prompt: "where is parseOptions?",
      model: "anthropic/claude-haiku",
    })
    const call = generations(host)[0]?.input as { model: ModelRef; prompt: string } | undefined
    expect(call?.model).toEqual(haiku)
    expect(call?.prompt).toContain("where is parseOptions?")
    const check = await host.tools.get("model_roles_check")?.execute({})
    expect(check?.content).toContain("general → cheap (anthropic/claude-haiku; confident;")
    host.close()
    await cleanup()
  })

  test("never overrides a role, a model, a resume or an agent with its own model", async () => {
    const host = createHost({ agents, models: priced, options: autoOptions(true), sessionModel: opus })
    const cleanup = await setup(host)
    await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" })
    await host.spawn("subagent", { agent: "plain", prompt: "x", model: "anthropic/claude-haiku" })
    await host.spawn("subagent", { agent: "plain", prompt: "x", sessionID: "ses_9" })
    expect(await host.spawn("subagent", { agent: "explore", prompt: "x" })).toEqual({ agent: "explore", prompt: "x" })
    expect(await host.spawn("subagent", { agent: "missing", prompt: "x" })).toEqual({ agent: "missing", prompt: "x" })
    expect(generations(host)).toHaveLength(0)
    host.close()
    await cleanup()
  })

  test("takes the default role when the decider is unsure, wrong, failing or slow", async () => {
    const host = createHost({ agents, models: priced, options: autoOptions({ timeoutMs: 20 }), sessionModel: opus })
    const cleanup = await setup(host)
    const replies: Array<() => Promise<{ text: string }>> = [
      async () => ({ text: '{"role": "cheap", "confident": false}' }),
      async () => ({ text: '{"role": "strong", "confident": true}' }),
      async () => {
        throw new Error("boom")
      },
      () => new Promise((resolve) => setTimeout(() => resolve({ text: '{"role": "cheap", "confident": true}' }), 200)),
    ]
    const tags: unknown[] = []
    for (const reply of replies) {
      host.setGenerate(reply)
      const input = await host.spawn("subagent", { agent: "general", description: "d", prompt: "x" })
      expect(input.model).toBe("amazon-bedrock/claude-sonnet#high")
      tags.push(input.description)
    }
    expect(tags).toEqual([
      "d [auto: standard, unsure]",
      "d [auto: standard, invalid]",
      "d [auto: standard, error]",
      "d [auto: standard, timeout]",
    ])
    host.close()
    await cleanup()
  })

  test("caps the tier at the parent's lineup rank", async () => {
    const host = createHost({
      agents,
      // Opus below the premium price, so it is the strong end of the Bedrock lineup.
      models: [{ ...opus, variants: [], cost: [{ input: 4.4 }] }, ...priced.slice(1)],
      options: autoOptions({ roles: ["smol", "task", "slow"] }),
      sessionModel: { providerID: "amazon-bedrock", id: "claude-sonnet", variant: "high" },
    })
    const cleanup = await setup(host)
    host.setGenerate(async () => ({ text: '{"role": "slow", "confident": true}' }))
    const input = await host.spawn("subagent", { agent: "general", description: "d", prompt: "design it" })
    expect(input.model).toBe("amazon-bedrock/claude-sonnet#high")
    expect(input.description).toBe("d [auto: task, capped from slow]")
    host.close()
    await cleanup()
  })

  test("guard mode auto routes a spawn it would refuse to a cheap role", async () => {
    const host = createHost({ agents, models: priced, options: autoOptions(undefined, { guard: { mode: "auto" } }), sessionModel: opus })
    const cleanup = await setup(host)
    host.setGenerate(async () => ({ text: '{"role": "task", "confident": true}' }))
    const input = await host.spawn("subagent", { agent: "plain", description: "d", prompt: "x" })
    expect(input.model).toBe("amazon-bedrock/claude-sonnet#high")
    // Under a cheap session model the guard allows, so nothing is routed.
    host.setSessionGet(async (id) => ({ id, model: haiku }))
    expect(await host.spawn("subagent", { agent: "plain", prompt: "x" })).toEqual({ agent: "plain", prompt: "x" })
    expect(generations(host)).toHaveLength(1)
    host.close()
    await cleanup()
  })

  test("guard refuse mode still refuses without auto", async () => {
    const host = createHost({ agents, models: priced, options: autoOptions(undefined, { guard: true }), sessionModel: opus })
    const cleanup = await setup(host)
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(/inherit/)
    expect(generations(host)).toHaveLength(0)
    host.close()
    await cleanup()
  })
})

describe("tiers", () => {
  const workModels = work as unknown as Model[]
  const references = reference as unknown as Model[]
  const opus55 = { providerID: "amazon-bedrock", id: "global.anthropic.claude-opus-5-5" }
  const sol = { providerID: "amazon-bedrock", id: "global.openai.gpt-6.1-sol" }
  const generations = (host: ReturnType<typeof createHost>) => host.calls.filter((c) => c.method === "generate")

  test("a spawn passes a tier; the reviewer tier puts another vendor than the caller's first", async () => {
    const agents: Agent[] = [{ id: "plain" }, { id: "critic", request: header("reviewer") }]
    const host = createHost({ agents, models: workModels, references, options: {}, sessionModel: opus55 })
    const cleanup = await setup(host)
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" })).model).toBe(
      "amazon-bedrock/global.anthropic.claude-haiku-5-5#low",
    )
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", role: "smol" })).model).toBe(
      "amazon-bedrock/global.anthropic.claude-haiku-5-5#low",
    )
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "reviewer" })).model).toBe(
      "amazon-bedrock/global.openai.gpt-6.1-sol#high",
    )
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", role: "default" })).model).toBeUndefined()
    // An agent on the reviewer tier is moved per spawn too.
    expect(host.agents().get("critic")?.model).toEqual({ ...opus55, variant: "high" })
    expect((await host.spawn("subagent", { agent: "critic", prompt: "x" })).model).toBe("amazon-bedrock/global.openai.gpt-6.1-sol#high")
    host.setSessionGet(async (id) => ({ id, model: sol }))
    expect((await host.spawn("subagent", { agent: "critic", prompt: "x" })).model).toBe(
      "amazon-bedrock/global.anthropic.claude-opus-5-5#high",
    )
    const check = await host.tools.get("model_roles_check")?.execute({})
    expect(check?.content).toContain("Tier strong (derived, effort high) → amazon-bedrock/global.anthropic.claude-opus-5-5#high")
    expect(check?.content).toContain("premium (")
    host.close()
    await cleanup()
  })

  test("a config model pin on a reviewer agent wins over its tier, a passed tier and the vendor move", async () => {
    const haiku55 = { providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5" }
    const agents: Agent[] = [
      { id: "pr-reviewer", request: header("reviewer") },
      { id: "critic", request: header("reviewer") },
    ]
    const host = createHost({ agents, models: workModels, references, options: {}, sessionModel: opus55 })
    const cleanup = await setup(host)
    await configAgents(host, [{ id: "pr-reviewer", model: haiku55, request: header("reviewer") }])
    await settle()
    expect(host.agents().get("pr-reviewer")?.model).toEqual(haiku55)
    expect(await host.spawn("subagent", { agent: "pr-reviewer", prompt: "x" })).toEqual({ agent: "pr-reviewer", prompt: "x" })
    expect(await host.spawn("subagent", { agent: "pr-reviewer", prompt: "x", tier: "strong" })).toEqual({ agent: "pr-reviewer", prompt: "x" })
    expect((await host.spawn("subagent", { agent: "pr-reviewer", prompt: "x", model: "amazon-bedrock/global.openai.gpt-6.1-sol" })).model).toBe(
      "amazon-bedrock/global.openai.gpt-6.1-sol",
    )
    // Without a pin the tier still picks.
    expect((await host.spawn("subagent", { agent: "critic", prompt: "x" })).model).toBe("amazon-bedrock/global.openai.gpt-6.1-sol#high")
    const check = await host.tools.get("model_roles_check")?.execute({})
    expect(check?.content).toContain("  - pr-reviewer (role reviewer) → amazon-bedrock/global.anthropic.claude-haiku-5-5 (pinned in config; tier not applied)")
    host.close()
    await cleanup()
  })

  test("the guard counts premium models as expensive, not strong ones such as Opus", async () => {
    const fable = { providerID: "amazon-bedrock", id: "global.anthropic.claude-fable-5-1" }
    const host = createHost({ agents: [{ id: "plain" }], models: workModels, references, options: { guard: true }, sessionModel: fable })
    const cleanup = await setup(host)
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(
      /tier: "cheap" \(runs amazon-bedrock\/global\.anthropic\.claude-haiku-5-5#low, metered, \$0\.1\/M input tokens\)/,
    )
    host.setSessionGet(async (id) => ({ id, model: opus55 }))
    expect(await host.spawn("subagent", { agent: "plain", prompt: "x" })).toEqual({ agent: "plain", prompt: "x" })
    host.close()
    await cleanup()
  })

  test("an agent with no tier is classified once from its description, and the answer is cached", async () => {
    const agents: Agent[] = [{ id: "docs", mode: "subagent", description: "Writes the changelog" } as Agent]
    const host = createHost({ agents, models: workModels, references, options: {} })
    host.setGenerate(async () => ({ text: '{"tier": "cheap"}' }))
    const cleanup = await setup(host)
    await settle()
    expect(host.agents().get("docs")?.model).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "low" })
    const call = generations(host)[0]?.input as { prompt: string; model: ModelRef } | undefined
    expect(call?.prompt).toContain("Writes the changelog")
    expect(call?.model).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "none" })
    expect(host.storage.get("classify:docs")).toMatchObject({ tier: "cheap" })
    host.close()
    await cleanup()

    const again = createHost({ agents, models: workModels, references, options: {} })
    again.storage.set("classify:docs", host.storage.get("classify:docs"))
    again.context.storage = { ...again.context.storage, scan: async () => ({ entries: [{ key: "classify:docs", value: again.storage.get("classify:docs") }] }) } as typeof again.context.storage
    const cleanupAgain = await setup(again)
    await settle()
    expect(generations(again)).toHaveLength(0)
    expect(again.agents().get("docs")?.model?.id).toBe("global.anthropic.claude-haiku-5-5")
    again.close()
    await cleanupAgain()
  })

  test("a markdown agent that loads after the plugin is classified too", async () => {
    const host = createHost({ agents: [], models: workModels, references, options: {} })
    host.setGenerate(async () => ({ text: '{"tier": "cheap"}' }))
    const cleanup = await setup(host)
    await configAgents(host, [{ id: "late", mode: "subagent", description: "Late agent" } as Agent])
    await settle()
    expect(host.agents().get("late")?.model?.id).toBe("global.anthropic.claude-haiku-5-5")
    host.close()
    await cleanup()
  })

  test("a failed classification runs the agent on standard", async () => {
    const agents: Agent[] = [{ id: "docs", mode: "subagent", description: "Writes the changelog" } as Agent]
    const host = createHost({ agents, models: workModels, references, options: {} })
    host.setGenerate(async () => ({ text: "no idea" }))
    const cleanup = await setup(host)
    await settle()
    expect(host.agents().get("docs")?.model?.id).toBe("global.openai.gpt-6.1-sol")
    expect(host.storage.has("classify:docs")).toBe(false)
    host.close()
    await cleanup()
  })

  test("effort auto lets the decider pick the variant per spawn", async () => {
    const options = { tiers: { standard: { effort: "auto" } }, auto: true }
    const host = createHost({ agents: [{ id: "plain" }], models: workModels, references, options, sessionModel: opus55 })
    host.setGenerate(async () => ({ text: '{"effort": "xhigh"}' }))
    const cleanup = await setup(host)
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "standard" })).model).toBe(
      "amazon-bedrock/global.openai.gpt-6.1-sol#xhigh",
    )
    host.setGenerate(async () => ({ text: "?" }))
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "standard" })).model).toBe("amazon-bedrock/global.openai.gpt-6.1-sol")
    host.close()
    await cleanup()
  })
})

describe("tiers rpc", () => {
  test("state reports the tiers and models; set writes the global config", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "model-roles-rpc-"))
    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = dir
    try {
      writeFileSync(path.join(dir, "opencode.jsonc"), '{\n  // mine\n  "plugins": ["/x/plugins/model-roles"]\n}\n')
      const host = createHost({ agents: [], models: work as unknown as Model[], references: reference as unknown as Model[], options: {} })
      const cleanup = await setup(host)
      const state = (await host.rpc("state")) as { tiers: Array<{ name: string; resolved?: string }>; models: unknown[]; config?: string }
      expect(state.tiers.map((t) => t.name)).toEqual(["cheap", "standard", "strong", "reviewer"])
      expect(state.tiers[0]?.resolved).toBe("amazon-bedrock/global.anthropic.claude-haiku-5-5#low")
      expect(state.models.length).toBeGreaterThan(100)
      expect(state.config).toBe(path.join(dir, "opencode.jsonc"))
      await host.rpc("set", { tier: "docs", value: { model: "auto", purpose: "docs", junk: 1 } })
      const text = readFileSync(path.join(dir, "opencode.jsonc"), "utf8")
      expect(text).toContain("// mine")
      expect(text).toContain('"package": "/x/plugins/model-roles"')
      expect(readTiers(text)).toEqual({ docs: { model: "auto", purpose: "docs" } })
      await host.rpc("set", { tier: "docs", value: null })
      expect(readTiers(readFileSync(path.join(dir, "opencode.jsonc"), "utf8"))).toEqual({})
      await expect(host.rpc("set", { tier: "Bad Name", value: {} })).rejects.toThrow(/Invalid tier name/)
      host.close()
      await cleanup()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
