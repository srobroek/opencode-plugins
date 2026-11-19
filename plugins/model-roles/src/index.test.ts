import { describe, expect, jest, setSystemTime, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import { BACKGROUND_HOLD_MS } from "../../lib/src/idle-background.ts"
import { withOptionalString } from "../../lib/src/tool-schema.ts"
import { WORKTREE_PARAM, WORKTREE_PARAM_DESCRIPTION } from "../../subagent-worktree/src/lane.ts"
import { type AgentAssessment, assessmentRows } from "./assess.ts"
import reference from "./fixtures/reference.json"
import work from "./fixtures/work-models.json"
import plugin, { CHILD_LOOKUP_MS, MAX_REREGISTER, type ModelRef, readAgents, readTiers, setExploreRandom, setHoldTimer, spawnTarget } from "./index.ts"
import { adoptPlan } from "./tiers-draft.ts"
import type { TierRow } from "./tiers-ui.ts"

type Agent = { id: string; model?: ModelRef; request?: { headers?: Record<string, string> } }
type Model = { providerID: string; id: string; variants: { id: string }[]; cost?: { input: number }[]; limit?: { context: number } }
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
  directory?: string
  plugin?: unknown
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
    ...(input.directory === undefined ? {} : { location: { directory: input.directory } }),
    plugin: input.plugin ?? { list: async () => ({ data: [{ id: "srobroek.model-roles", source: { type: "package", target: "/x/plugins/model-roles" } }] }) },
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
      remove: async (key: string) => void storage.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
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
    /** Run the `experimental.idle` hooks as the host does just before a Session's execution ends. */
    fireIdle: async (event: { sessionID: string; background?: unknown[] }) => {
      for (const hook of hooks) if (hook.name === "experimental.idle") await hook.callback(event)
    },
    fireModelRequest: (headers: Record<string, string>, extra: { sessionID?: string; model?: ModelRef; kind?: string } = {}) => {
      for (const hook of hooks) if (hook.name === "model.request") hook.callback({ headers, ...extra })
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
    /** Run `execute.after` for any tool in `sessionID` (a child's own shell call). */
    toolDone: async (tool: string, payload: unknown, metadata: unknown, sessionID: string, id: string) => {
      for (const hook of toolHooks)
        if (hook.name === "execute.after")
          await hook.callback({ tool, sessionID, agent: "plain", id, input: payload, status: "completed", result: { metadata } })
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
    /** Tool transforms still registered: a late registration that was never disposed shows up here. */
    liveToolTransforms: () => toolTransforms.length,
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
    const check = await host.tools.get("model_roles_check")?.execute({})
    expect(check?.content).toContain(`Agents general still run another model than their tier resolves to: re-registering gave up after ${MAX_REREGISTER} tries`)
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
    // A resume of a child with no snapshot is judged on the child's own model too.
    await expect(host.spawn("subagent", { agent: "plain", prompt: "x", sessionID: "ses_2" })).rejects.toThrow(/resume would run on .*claude-opus/)
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

    describe("without a guard, a lookup that runs past the default bound lets the spawn go on and says which lookup it was", () => {
      const cases: Array<[string, string, (host: ReturnType<typeof createHost>) => void, Record<string, unknown>, Record<string, unknown>]> = [
        [
          "agent",
          "the agent lookup",
          (host) => {
            const original = host.context.agent.list
            let calls = 0
            host.context.agent.list = async () => {
              if (++calls === 1) await new Promise((resolve) => setTimeout(resolve, 6000))
              return original()
            }
          },
          {},
          { agent: "plain", prompt: "x" },
        ],
        [
          "caller-vendor",
          "the caller-vendor lookup",
          (host) => host.setSessionGet(() => new Promise((resolve) => setTimeout(() => resolve({ id: "s1" }), 6000))),
          {},
          { agent: "plain", prompt: "x", role: "reviewer" },
        ],
        [
          "routing",
          "the routing lookup",
          (host) => {
            const original = host.context.agent.list
            let calls = 0
            host.context.agent.list = async () => {
              if (++calls === 2) await new Promise((resolve) => setTimeout(resolve, 6000))
              return original()
            }
          },
          { auto: { decider: "@tiny" } },
          { agent: "plain", description: "d", prompt: "x" },
        ],
      ]
      for (const [site, text, fault, extra, input] of cases) {
        test(
          `${site} lookup`,
          async () => {
            const lines: string[] = []
            const capture = Logger.make(({ message }) => {
              lines.push(String(message))
            })
            const host = createHost({ agents, models: priced, options: { ...options, roles: { ...options.roles, tiny: "anthropic/claude-haiku" }, ...extra }, sessionModel: opus })
            const cleanup = await Effect.runPromise(Effect.promise(() => setup(host)).pipe(Effect.provide(Logger.layer([capture]))))
            fault(host)
            await host.spawn("subagent", input)
            expect(lines.join("\n")).toContain(`${text} did not answer within 5000 ms; the spawn goes on without it`)
            host.close()
            await cleanup()
          },
          20_000,
        )
      }
    })

  describe("guard.requireExplicit", () => {
    const strict = (extra: object = {}) => ({ ...options, guard: { requireExplicit: true, ...extra } })
    const cheap = { providerID: "anthropic", id: "claude-haiku" }
    // Settles long after the injected 20 ms bound. A lookup that never settles would spin bun when the bound is missing, so this one ends on its own.
    const slowLookup = () => new Promise<unknown>((resolve) => setTimeout(() => resolve({ id: "s1" }), 500))

    test("a spawn that would inherit is refused under a cheap session model, naming the tiers", async () => {
      const host = createHost({ agents, models: priced, options: strict(), sessionModel: cheap })
      const cleanup = await setup(host)
      await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(
        /would inherit this session's model anthropic\/claude-haiku[\s\S]*cheap → anthropic\/claude-haiku; standard → amazon-bedrock\/claude-sonnet#high/,
      )
      host.close()
      await cleanup()
    })

    test("a configured tier, a pinned model, a tier, a model, a resume and allowInherit all pass", async () => {
      const host = createHost({ agents, models: priced, options: strict({ allowInherit: ["fork"] }), sessionModel: cheap })
      const cleanup = await setup(host)
      await host.spawn("subagent", { agent: "general", prompt: "x" })
      await host.spawn("subagent", { agent: "explore", prompt: "x" })
      await host.spawn("subagent", { agent: "plain", prompt: "x", role: "cheap" })
      await host.spawn("subagent", { agent: "plain", prompt: "x", model: "amazon-bedrock/claude-sonnet" })
      await host.spawn("subagent", { agent: "plain", prompt: "x", sessionID: "ses_9" })
      host.close()
      await cleanup()
      const again = createHost({ agents: [...agents, { id: "fork" }], models: priced, options: strict({ allowInherit: ["fork"] }), sessionModel: cheap })
      const cleanupAgain = await setup(again)
      await again.spawn("subagent", { agent: "fork", prompt: "x" })
      again.close()
      await cleanupAgain()
    })

    const lookups: Array<[string, (host: ReturnType<typeof createHost>) => void]> = [
      [
        "session",
        (host) =>
          host.setSessionGet(async () => {
            throw new Error("gone")
          }),
      ],
      [
        "agent",
        (host) => {
          host.context.agent.list = async () => {
            throw new Error("gone")
          }
        },
      ],
    ]
    for (const [name, fault] of lookups) {
      test(`a failing ${name} lookup is refused, asking for tier or model`, async () => {
        const host = createHost({ agents, models: priced, options: strict(), sessionModel: cheap })
        const cleanup = await setup(host)
        fault(host)
        await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(
          /could not verify which model[\s\S]*Re-issue the spawn with tier or model/,
        )
        host.close()
        await cleanup()
      })

      test(`a failing ${name} lookup still lets a spawn that names its tier through`, async () => {
        const host = createHost({ agents, models: priced, options: strict(), sessionModel: cheap })
        const cleanup = await setup(host)
        fault(host)
        await host.spawn("subagent", { agent: "plain", prompt: "x", role: "cheap" })
        host.close()
        await cleanup()
      })

      test(`a failing ${name} lookup fails open without requireExplicit`, async () => {
        const host = createHost({ agents, models: priced, options: guarded, sessionModel: opus })
        const cleanup = await setup(host)
        fault(host)
        await host.spawn("subagent", { agent: "plain", prompt: "x" })
        host.close()
        await cleanup()
      })
    }

    test("a target missing from the agent list is refused as unverifiable, unless allowInherit lists it", async () => {
      for (const listed of [[], [{ id: "general" }]]) {
        const host = createHost({ agents, models: priced, options: strict({ allowInherit: ["fork"] }), sessionModel: cheap })
        const cleanup = await setup(host)
        const original = host.context.agent.list
        host.context.agent.list = async () => ({ ...(await original()), data: listed }) as never
        await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(
          /could not verify which model[\s\S]*Re-issue the spawn with tier or model/,
        )
        await host.spawn("subagent", { agent: "plain", prompt: "x", role: "cheap" })
        await host.spawn("subagent", { agent: "fork", prompt: "x" })
        host.close()
        await cleanup()
      }
    })

    test("a target missing from the agent list is allowed without requireExplicit", async () => {
      const host = createHost({ agents, models: priced, options: guarded, sessionModel: opus })
      const cleanup = await setup(host)
      const original = host.context.agent.list
      host.context.agent.list = async () => ({ ...(await original()), data: [] }) as never
      await host.spawn("subagent", { agent: "plain", prompt: "x" })
      host.close()
      await cleanup()
    })

    test("a lookup that never settles is refused after the timeout, asking for tier or model", async () => {
      const host = createHost({ agents, models: priced, options: strict({ lookupTimeoutMs: 20 }), sessionModel: cheap })
      const cleanup = await setup(host)
      host.setSessionGet(slowLookup)
      await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(
        /could not verify which model[\s\S]*Re-issue the spawn with tier or model/,
      )
      host.close()
      await cleanup()
    }, 15_000)

    test("a lookup that never settles lets the spawn through without requireExplicit", async () => {
      const host = createHost({ agents, models: priced, options: { ...options, guard: { lookupTimeoutMs: 20 } }, sessionModel: opus })
      const cleanup = await setup(host)
      host.setSessionGet(slowLookup)
      await host.spawn("subagent", { agent: "plain", prompt: "x" })
      host.close()
      await cleanup()
    }, 15_000)

    test("a stalled agent lookup before the guard is refused fast under requireExplicit", async () => {
      const host = createHost({ agents, models: priced, options: strict({ lookupTimeoutMs: 20 }), sessionModel: cheap })
      const cleanup = await setup(host)
      const original = host.context.agent.list
      let stalls = true
      host.context.agent.list = async () => {
        if (stalls) await new Promise((resolve) => setTimeout(resolve, 500))
        return original()
      }
      const started = Date.now()
      await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(/could not verify which model[\s\S]*Re-issue the spawn with tier or model/)
      expect(Date.now() - started).toBeLessThan(400)
      stalls = false
      host.close()
      await cleanup()
    }, 15_000)

    test("a stalled agent lookup before the guard does not hold up a spawn without requireExplicit", async () => {
      const host = createHost({ agents, models: priced, options: { ...options, guard: { lookupTimeoutMs: 20 } }, sessionModel: opus })
      const cleanup = await setup(host)
      const original = host.context.agent.list
      let stalls = true
      host.context.agent.list = async () => {
        if (stalls) await new Promise((resolve) => setTimeout(resolve, 500))
        return original()
      }
      const started = Date.now()
      await host.spawn("subagent", { agent: "plain", prompt: "x", role: "cheap" })
      expect(Date.now() - started).toBeLessThan(400)
      stalls = false
      host.close()
      await cleanup()
    }, 15_000)

    describe("bounded lookups and bound model", () => {
      /** Serve `first` on the first agent lookup and `later` on every one after it. */
      const lists = (host: ReturnType<typeof createHost>, first: Agent[], later: Agent[]) => {
        let calls = 0
        host.context.agent.list = async () => ({ data: (++calls === 1 ? first : later).map((a) => structuredClone(a)) }) as never
      }
      const tierHeader = { "x-opencode-model-role": "cheap" }
      const plain: Agent = { id: "plain" }
      const withTier: Agent = { id: "plain", request: { headers: tierHeader } }
      const verification = /could not verify which model[\s\S]*Re-issue the spawn with tier or model/

      test("a tier the guard saw but that is gone at spawn time is refused, not inherited", async () => {
        const host = createHost({ agents, models: priced, options: strict(), sessionModel: cheap })
        const cleanup = await setup(host)
        lists(host, [plain], [withTier])
        await expect(host.spawn("subagent", { agent: "plain", prompt: "x" })).rejects.toThrow(verification)
        host.close()
        await cleanup()
      }, 15_000)

      test("the same change leaves the old behaviour without requireExplicit", async () => {
        const host = createHost({ agents, models: priced, options: guarded, sessionModel: cheap })
        const cleanup = await setup(host)
        lists(host, [plain], [withTier])
        expect(await host.spawn("subagent", { agent: "plain", prompt: "x" })).toEqual({ agent: "plain", prompt: "x" })
        host.close()
        await cleanup()
      }, 15_000)

      test("an approved spawn carries the verified model, from the agent's pin or its tier", async () => {
        const host = createHost({ agents, models: priced, options: strict(), sessionModel: cheap })
        const cleanup = await setup(host)
        expect((await host.spawn("subagent", { agent: "explore", prompt: "x" })).model).toBe("anthropic/claude-haiku")
        expect((await host.spawn("subagent", { agent: "general", prompt: "x" }, "build", "s1", "c2")).model).toBe("amazon-bedrock/claude-sonnet#high")
        host.close()
        await cleanup()
      }, 15_000)

      test("a pin that disappears after the first lookup never lets the spawn inherit", async () => {
        const pinned: Agent = { id: "explore", model: haiku }
        const host = createHost({ agents, models: priced, options: strict(), sessionModel: cheap })
        const cleanup = await setup(host)
        lists(host, [pinned], [{ id: "explore" }])
        await expect(host.spawn("subagent", { agent: "explore", prompt: "x" })).rejects.toThrow(/would inherit/)
        host.close()
        await cleanup()
      }, 15_000)

      const stalls: Array<[string, (host: ReturnType<typeof createHost>) => void, Record<string, unknown>]> = [
        [
          "pre-spawn agent",
          (host) => {
            const original = host.context.agent.list
            let calls = 0
            host.context.agent.list = async () => {
              if (++calls === 1) await new Promise((resolve) => setTimeout(resolve, 500))
              return original()
            }
          },
          { agent: "plain", prompt: "x" },
        ],
        ["caller-vendor session", (host) => host.setSessionGet(slowLookup), { agent: "plain", prompt: "x", role: "reviewer" }],
      ]
      for (const [site, stall, input] of stalls) {
        test(`a stalled ${site} lookup is refused within the bound under requireExplicit`, async () => {
          const host = createHost({ agents, models: priced, options: strict({ lookupTimeoutMs: 20 }), sessionModel: cheap })
          const cleanup = await setup(host)
          stall(host)
          const started = Date.now()
          await expect(host.spawn("subagent", input)).rejects.toThrow(verification)
          expect(Date.now() - started).toBeLessThan(400)
          host.close()
          await cleanup()
        }, 15_000)

        test(`a stalled ${site} lookup lets the spawn proceed within the bound without requireExplicit`, async () => {
          const host = createHost({ agents, models: priced, options: { ...options, guard: { lookupTimeoutMs: 20 } }, sessionModel: cheap })
          const cleanup = await setup(host)
          stall(host)
          const started = Date.now()
          await host.spawn("subagent", input)
          expect(Date.now() - started).toBeLessThan(400)
          host.close()
          await cleanup()
        }, 15_000)
      }
    })

    describe("lookups that stall mid-decision", () => {
      const verification = /could not verify which model[\s\S]*Re-issue the spawn with tier or model/
      const slow = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 500))
      const cases: Array<[string, (host: ReturnType<typeof createHost>) => void, () => [string, unknown, string, string]]> = [
        [
          "the second agent lookup, behind an explicit expensive model",
          (host) => {
            const original = host.context.agent.list
            let calls = 0
            host.context.agent.list = async () => {
              if (++calls === 2) await new Promise((resolve) => setTimeout(resolve, 500))
              return original()
            }
          },
          () => ["subagent", { agent: "plain", prompt: "x", model: "amazon-bedrock/claude-opus" }, "build", "s1"],
        ],
        [
          "the ancestry (parent session) lookup",
          (host) => {
            host.sessions.set("root", { id: "root" })
            host.sessions.set("child", { id: "child", parentID: "root", agent: "plain" })
            host.setSessionGet(async (id) => (id === "root" ? slow() : host.sessions.get(id)))
          },
          () => ["subagent", { agent: "plain", prompt: "x" }, "plain", "child"],
        ],
        [
          "the default model lookup",
          (host) => {
            host.sessions.set("root", { id: "root" })
            host.context.model.default = async () => slow() as never
          },
          () => ["subagent", { agent: "plain", prompt: "x" }, "plain", "root"],
        ],
      ]
      for (const [site, fault, call] of cases) {
        test(`${site} stalling is refused within the bound under requireExplicit`, async () => {
          const host = createHost({ agents, models: priced, options: strict({ lookupTimeoutMs: 20 }) })
          const cleanup = await setup(host)
          fault(host)
          const [tool, payload, caller, session] = call()
          const started = Date.now()
          await expect(host.spawn(tool, payload, caller, session)).rejects.toThrow(verification)
          expect(Date.now() - started).toBeLessThan(400)
          host.close()
          await cleanup()
        }, 15_000)

        test(`${site} stalling lets the spawn through within the bound without requireExplicit`, async () => {
          const host = createHost({ agents, models: priced, options: { ...options, guard: { lookupTimeoutMs: 20 } } })
          const cleanup = await setup(host)
          fault(host)
          const [tool, payload, caller, session] = call()
          const started = Date.now()
          await host.spawn(tool, payload, caller, session)
          expect(Date.now() - started).toBeLessThan(400)
          host.close()
          await cleanup()
        }, 15_000)
      }
    })

    test("without requireExplicit a cheap session model may be inherited", async () => {
      const host = createHost({ agents, models: priced, options: guarded, sessionModel: cheap })
      const cleanup = await setup(host)
      await host.spawn("subagent", { agent: "plain", prompt: "x" })
      host.close()
      await cleanup()
    })
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
    // A resume without a role or model keeps the child's model; a role on it is a deliberate reroute.
    expect(await host.spawn("subagent", { agent: "general", prompt: "x", sessionID: "ses_1" })).toEqual({
      agent: "general",
      prompt: "x",
      sessionID: "ses_1",
    })
    expect(await host.spawn("subagent", { agent: "general", prompt: "x", role: "task", sessionID: "ses_1" })).toEqual({
      agent: "general",
      prompt: "x",
      sessionID: "ses_1",
      model: "amazon-bedrock/claude-sonnet#high",
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

  // The host's shape for an overflow its compaction could not fix: `session.execution.failed` carries
  // `toSessionError` of an InvalidRequest (opencode core `session/to-session-error.ts`, `providerError`).
  const overflow = (message: string) => ({
    type: "provider.invalid-request",
    message,
    status: 400,
    response: { body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }) },
  })
  const tooLong = overflow("prompt is too long: 213462 tokens > 200000 maximum")
  const windows = (...limits: number[]) => models.map((m, i) => ({ ...m, limit: { context: limits[i] ?? 200_000 } })) as Model[]
  const wide = { ...fallbackOptions, roles: { task: ["amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku", "opencode/flint"] } }
  const notes = (host: ReturnType<typeof createHost>) => methods(host, "synthetic").map((c) => c.input as { sessionID: string; text: string })
  const childHost = (models: Model[], options: typeof fallbackOptions, children = ["c"]) => {
    const host = createHost({ agents: [{ id: "general" }], models, options })
    host.sessions.set("r", { id: "r" })
    for (const id of children) host.sessions.set(id, { id, parentID: "r", agent: "general", model: sonnet })
    return host
  }

  test("a child that overflows is switched to the tier's larger-context candidate for its next request, with one note and a receipt", async () => {
    const host = childHost(windows(200_000, 1_000_000, 2_000_000), wide)
    const cleanup = await setup(host)
    host.emit(failed("c", tooLong))
    await settle()
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: haiku }])
    expect(notes(host)).toEqual([
      {
        ...notes(host)[0],
        sessionID: "r",
        text: "context too long for amazon-bedrock/claude-sonnet#high (200000 tokens); the session now runs anthropic/claude-haiku (1000000 tokens). Resume it with sessionID c to continue on the larger context.",
      },
    ])
    expect(host.storage.has("health")).toBe(false)
    const check = (await host.tools.get("model_roles_check")?.execute({}))?.content ?? ""
    expect(check).toContain("anthropic/claude-haiku by model default; fell back past amazon-bedrock/claude-sonnet#high: context-length")
    expect(check).not.toContain("Recent health")
    host.close()
    await cleanup()
  })

  test("a candidate whose variant is unknown is not a larger-context target", async () => {
    const roles = { ...fallbackOptions, roles: { task: ["amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku#nope", "opencode/flint"] } }
    const host = childHost(windows(200_000, 1_000_000, 2_000_000), roles)
    const cleanup = await setup(host)
    host.emit(failed("c", tooLong))
    await settle()
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: flint }])
    host.close()
    await cleanup()
  })

  test("with no larger-context candidate nothing is switched and the note says so", async () => {
    const host = childHost(windows(200_000, 200_000, 200_000), wide)
    const cleanup = await setup(host)
    host.emit(failed("c", overflow("Input is too long for requested model.")))
    await settle()
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(notes(host).map((n) => n.text)).toEqual([
      "context too long for amazon-bedrock/claude-sonnet#high (200000 tokens); no larger-context candidate in tier task. Compact the session or use a tier with a larger-context model",
    ])
    expect(host.storage.has("health")).toBe(false)
    host.close()
    await cleanup()
  })

  test("a root session that overflows is not switched; the note names the larger candidate", async () => {
    const host = createHost({ agents: [{ id: "general" }], models: windows(200_000, 1_000_000), options: fallbackOptions })
    host.sessions.set("r", { id: "r", agent: "general", model: sonnet })
    const cleanup = await setup(host)
    host.emit(failed("r", tooLong))
    await settle()
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(notes(host)).toEqual([
      {
        ...notes(host)[0],
        sessionID: "r",
        text: "context too long for amazon-bedrock/claude-sonnet#high (200000 tokens); tier task has a larger-context candidate, anthropic/claude-haiku (1000000 tokens). Switch to it or compact the session.",
      },
    ])
    host.close()
    await cleanup()
  })

  const resumeNote =
    "context too long for amazon-bedrock/claude-sonnet#high (200000 tokens); the session now runs anthropic/claude-haiku (1000000 tokens). Resume it with sessionID c to continue on the larger context."
  const pendingNote =
    "context too long for amazon-bedrock/claude-sonnet#high (200000 tokens); model-roles moves it to anthropic/claude-haiku (1000000 tokens) when its failure is reported."
  const overflowSteps = (host: ReturnType<typeof createHost>) => ({
    event: async () => {
      host.emit(failed("c", tooLong))
      await settle()
    },
    tool: async () => {
      await host.spawnFailed({ agent: "general", prompt: "x" }, `Subagent failed (sessionID: c): ${tooLong.message}`, "r")
      await settle()
    },
  })

  test.each([
    ["the failure event first", ["event", "tool"], resumeNote],
    ["the tool error first", ["tool", "event"], pendingNote],
  ])("a child's overflow is switched by its failure event only and the parent hears once, with %s", async (_name, order, text) => {
    const host = childHost(windows(200_000, 1_000_000), fallbackOptions)
    const cleanup = await setup(host)
    const steps = overflowSteps(host)
    for (const step of order as Array<"event" | "tool">) await steps[step]()
    expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: haiku }])
    expect(notes(host).map((n) => [n.sessionID, n.text])).toEqual([["r", text]])
    host.close()
    await cleanup()
  })

  test("a tool error whose failure event never arrives switches nothing and does not claim a switch", async () => {
    const host = childHost(windows(200_000, 1_000_000), fallbackOptions)
    const cleanup = await setup(host)
    await overflowSteps(host).tool()
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(notes(host).map((n) => n.text)).toEqual([pendingNote])
    expect(notes(host)[0]?.text).not.toContain("now runs")
    host.close()
    await cleanup()
  })

  test("two children that overflow on one model each get a note in the parent", async () => {
    const host = childHost(windows(200_000, 1_000_000), fallbackOptions, ["c1", "c2"])
    const cleanup = await setup(host)
    host.emit(failed("c1", tooLong))
    host.emit(failed("c2", tooLong))
    await settle()
    expect(notes(host).map((n) => n.text.match(/sessionID (\w+)/)?.[1])).toEqual(["c1", "c2"])
    host.close()
    await cleanup()
  })

  test("the retry hook leaves an overflow to the host", async () => {
    const host = createHost({ agents: [{ id: "build" }], models: windows(200_000, 1_000_000), options: fallbackOptions })
    const cleanup = await setup(host)
    expect(await host.fireRetry({ sessionID: "r", agent: "build", model: sonnet, error: tooLong, attempt: 2 }, declined)).toEqual(declined)
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(host.storage.has("health")).toBe(false)
    host.close()
    await cleanup()
  })

  test("model_roles_check lists recent cooldowns, then their recovery", async () => {
    const host = createHost({ agents: [{ id: "build" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    const run = async () => (await host.tools.get("model_roles_check")?.execute({}))?.content ?? ""
    expect(await run()).not.toContain("Recent health")
    const quota = { type: "provider.quota", message: "You exceeded your current quota", status: 429 }
    await host.fireRetry({ sessionID: "r", agent: "build", model: sonnet, error: quota, attempt: 2 })
    expect(await run()).toMatch(/Recent health[\s\S]*provider amazon-bedrock: quota, cooldown 6 h, still out/)
    await new Promise((resolve) => setTimeout(resolve, 5))
    host.fireModelRequest({}, { sessionID: "r", model: sonnet, kind: "primary" })
    host.emit({ type: "session.execution.succeeded", data: { sessionID: "r" } })
    await settle()
    const after = await run()
    expect(after).toMatch(/provider amazon-bedrock: quota, cooldown 6 h, recovered \d\d:\d\d:\d\d/)
    expect(after).not.toContain("still out")
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

  test("repeated credential failures across sessions are one outage notice, then one recovery on the first success", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options: fallbackOptions })
    host.sessions.set("r", { id: "r" })
    for (const id of ["c1", "c2"]) host.sessions.set(id, { id, parentID: "r", agent: "general", model: sonnet })
    const cleanup = await setup(host)
    const error = { type: "provider.auth", message: "Unable to locate credentials" }
    for (let i = 0; i < 6; i++) {
      host.emit(failed(i % 2 === 0 ? "c1" : "c2", error))
      await settle()
    }
    const texts = () => methods(host, "synthetic").map((c) => (c.input as { text: string }).text)
    expect(texts()).toHaveLength(2)
    expect(texts()[0]).toContain("Provider amazon-bedrock is")
    expect(texts()[0]).toContain("resume it with sessionID c1")
    expect(texts()[1]).toContain("Subagent 'general' stopped by the amazon-bedrock outage (credentials): resume it with sessionID c2")
    host.fireModelRequest({}, { sessionID: "c1", model: sonnet, kind: "primary" })
    host.emit({ type: "session.execution.succeeded", data: { sessionID: "c1" } })
    await settle()
    expect(texts()).toHaveLength(3)
    // c1 ran again and succeeded, so only c2 still needs resuming.
    expect(texts()[2]).toContain("Provider amazon-bedrock recovered (credentials). Resume the stopped subagents: general (c2).")
    host.close()
    await cleanup()
  })

  const outageHost = async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options: fallbackOptions })
    host.sessions.set("r", { id: "r", agent: "general", model: sonnet })
    const cleanup = await setup(host)
    host.emit(failed("r", { type: "provider.auth", message: "Unable to locate credentials" }))
    await settle()
    const texts = () => methods(host, "synthetic").map((c) => (c.input as { text: string }).text)
    return { host, cleanup, texts }
  }

  test("a success on the failed provider ends its outage even after the session moved to another provider", async () => {
    const { host, cleanup, texts } = await outageHost()
    host.fireModelRequest({}, { sessionID: "r", model: sonnet, kind: "primary" })
    // The session is moved off the provider before the success is handled.
    host.sessions.set("r", { id: "r", agent: "general", model: haiku })
    host.emit({ type: "session.execution.succeeded", data: { sessionID: "r" } })
    await settle()
    expect(texts()).toHaveLength(2)
    expect(texts()[1]).toContain("Provider amazon-bedrock recovered (credentials)")
    host.close()
    await cleanup()
  })

  test("a success on another provider does not end the outage, even if the session was on the failed one", async () => {
    const { host, cleanup, texts } = await outageHost()
    host.fireModelRequest({}, { sessionID: "r", model: haiku, kind: "primary" })
    host.emit({ type: "session.execution.succeeded", data: { sessionID: "r" } })
    await settle()
    expect(texts()).toHaveLength(1)
    // A success that no request was seen for is credited to nobody.
    host.emit({ type: "session.execution.succeeded", data: { sessionID: "r" } })
    await settle()
    expect(texts()).toHaveLength(1)
    host.close()
    await cleanup()
  })

  test("a success is credited to its own execution's provider when a later execution already made its request", async () => {
    const { host, cleanup, texts } = await outageHost()
    host.fireModelRequest({}, { sessionID: "r", model: sonnet, kind: "primary" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const ended = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 5))
    // The next execution is on another provider and has asked before the first success is handled.
    host.fireModelRequest({}, { sessionID: "r", model: haiku, kind: "primary" })
    host.emit({ type: "session.execution.succeeded", created: ended, data: { sessionID: "r" } })
    await settle()
    expect(texts()).toHaveLength(2)
    expect(texts()[1]).toContain("Provider amazon-bedrock recovered")
    // The second execution's success is credited to its own provider, which had no outage.
    host.emit({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "r" } })
    await settle()
    expect(texts()).toHaveLength(2)
    host.close()
    await cleanup()
  })

  test("the earlier execution is on the other provider: its success must not end the outage", async () => {
    const { host, cleanup, texts } = await outageHost()
    host.fireModelRequest({}, { sessionID: "r", model: haiku, kind: "primary" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const ended = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 5))
    host.fireModelRequest({}, { sessionID: "r", model: sonnet, kind: "primary" })
    host.emit({ type: "session.execution.succeeded", created: ended, data: { sessionID: "r" } })
    await settle()
    expect(texts()).toHaveLength(1)
    host.close()
    await cleanup()
  })

  test("an interrupted execution is neither a success nor a failure and clears its request", async () => {
    const { host, cleanup, texts } = await outageHost()
    const health = structuredClone(host.storage.get("health"))
    host.fireModelRequest({}, { sessionID: "r", model: sonnet, kind: "primary" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    host.emit({ type: "session.execution.interrupted", created: Date.now(), data: { sessionID: "r", reason: "user" } })
    await settle()
    expect(texts()).toHaveLength(1)
    // A success with no request of its own recovers nothing: the interrupted request is gone.
    await new Promise((resolve) => setTimeout(resolve, 5))
    host.emit({ type: "session.execution.succeeded", created: Date.now(), data: { sessionID: "r" } })
    await settle()
    expect(texts()).toHaveLength(1)
    expect(host.storage.get("health")).toEqual(health)
    host.close()
    await cleanup()
  })

  test("a root session's credential failures give one notice from the first failure, with no cooldown, and none after", async () => {
    const host = createHost({ agents: [{ id: "general" }], models, options: fallbackOptions })
    host.sessions.set("r", { id: "r", agent: "general", model: sonnet })
    const cleanup = await setup(host)
    const error = { type: "provider.auth", message: "Unable to locate credentials" }
    host.emit(failed("r", error))
    await settle()
    const texts = () => methods(host, "synthetic").map((c) => c.input as { sessionID: string; text: string })
    expect(texts()).toHaveLength(1)
    expect(texts()[0]?.sessionID).toBe("r")
    expect(texts()[0]?.text).toContain("Provider amazon-bedrock is failing (credentials)")
    expect(texts()[0]?.text).toContain("stays in use")
    for (let i = 0; i < 4; i++) {
      host.emit(failed("r", error))
      await settle()
    }
    expect(texts()).toHaveLength(1)
    host.close()
    await cleanup()
  })

  test("a provider's failure text never reaches health storage, receipts or the check: only its class", async () => {
    const host = createHost({ agents: [{ id: "general" }, { id: "plain" }], models, options: fallbackOptions })
    const cleanup = await setup(host)
    const secret = "sk-live-FAKE0123456789"
    const prompt = "PROMPT: summarise the merger memo for Alice"
    await host.spawnFailed(
      { agent: "general", prompt: "x" },
      `Subagent failed (c): Model unavailable: amazon-bedrock/claude-sonnet (key ${secret}; request ${prompt})`,
    )
    await settle()
    await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" })
    const check = (await host.tools.get("model_roles_check")?.execute({}))?.content ?? ""
    expect(check).toContain("amazon-bedrock/claude-sonnet#high: unhealthy until")
    expect(check).toContain("(unavailable)")
    for (const text of [JSON.stringify([...host.storage.entries()]), check]) {
      expect(text).not.toContain(secret)
      expect(text).not.toContain("merger memo")
    }
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
    host.emit(failed("r", { type: "unknown", message: "file not found: src/x.ts" }))
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

  test("records an outcome per child: usage and success, then a credentials failure", async () => {
    // `ms` is the end event's time minus the spawn's: pin the clock so a millisecond tick between them cannot change it.
    setSystemTime(new Date(1_800_000_000_000))
    try {
      const host = createHost({ agents: [{ id: "plain" }], models, options: fallbackOptions })
      host.sessions.set("r", { id: "r" })
      host.sessions.set("c1", { id: "c1", parentID: "r", agent: "plain", model: sonnet })
      host.sessions.set("c2", { id: "c2", parentID: "r", agent: "plain", model: sonnet })
      const cleanup = await setup(host)
      const usage = (sessionID: string, input: number, cost: number) => ({
        type: "session.step.ended",
        data: { sessionID, cost, tokens: { input, output: 10, reasoning: 2, cache: { read: 5, write: 1 } } },
      })
      const input1 = await host.spawn("subagent", { agent: "plain", prompt: "secret prompt", role: "task" }, "build", "r", "call-1")
      host.emit({ type: "session.created", data: { sessionID: "c1", parentID: "r", agent: "plain", model: sonnet } })
      host.emit(usage("c1", 100, 0.5))
      host.emit(usage("c1", 200, 0.25))
      const succeeded = { type: "session.execution.succeeded", created: Date.now() + 1000, data: { sessionID: "c1" } }
      host.emit(succeeded)
      await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-2")
      host.emit({ type: "session.created", data: { sessionID: "c2", parentID: "r", agent: "plain", model: sonnet } })
      host.emit({ type: "session.execution.failed", data: { sessionID: "c2", error: { type: "api", message: "invalid credentials", status: 401 } } })
      await settle()
      // c1 is resumed: it counts as running from the start of that run, not from its end.
      await host.spawn("subagent", { agent: "plain", prompt: "again", sessionID: "c1" }, "build", "r", "call-3")
      expect(host.storage.get("outcome:c1")).toMatchObject({ resumes: 1, steps: 2 })
      expect(host.storage.get("outcome:c1")).not.toHaveProperty("outcome")
      host.emit(succeeded)
      await settle()
      await host.spawnDone({ ...input1, sessionID: "c1" }, { sessionID: "c1" }, "r", "call-3")
      const first = host.storage.get("outcome:c1") as Record<string, unknown>
      expect(first).toMatchObject({
        agent: "plain",
        tier: "standard",
        model: "amazon-bedrock/claude-sonnet#high",
        source: "role-param",
        ms: 1000,
        parentID: "r",
        inputTokens: 300,
        outputTokens: 20,
        reasoningTokens: 4,
        cacheReadTokens: 10,
        cacheWriteTokens: 2,
        cost: 0.75,
        steps: 2,
        outcome: "succeeded",
        resumes: 1,
      })
      expect(JSON.stringify(first)).not.toContain("secret prompt")
      expect(host.storage.get("outcome:c2")).toMatchObject({ outcome: "failed:auth", steps: 0 })
      const check = (await host.tools.get("model_roles_check")?.execute({}))?.content
      expect(check).toContain("Usage per tier (last 90 days):")
      expect(check).toContain("  standard: 2 runs: 1 ok, 1 failed, 0 interrupted (50%)")
      expect(check).toContain("cost 1/2 $0.750 ($0.750/success)") // c2 reported no usage at all
      host.close()
      await cleanup()
    } finally {
      setSystemTime()
    }
  })

  describe("usage rpc", () => {
    const DAY = 24 * 60 * 60 * 1000
    const stored = (ago: number, over: Record<string, unknown> = {}) => ({
      v: 2,
      at: Date.now() - ago * DAY,
      agent: "explore",
      tier: "cheap",
      model: "secret-provider/secret-model#high",
      parentID: "secret-parent-session",
      resumes: 0,
      inputTokens: 10,
      outputTokens: 1,
      cost: 0.5,
      steps: 1,
      ms: 100,
      outcome: "succeeded",
      ...over,
    })

    test("forwards the window and returns aggregates only", async () => {
      const host = createHost({ agents: [{ id: "plain" }], models, options: fallbackOptions })
      host.storage.set("outcome:session-recent-AAA", stored(1))
      host.storage.set("outcome:session-old-BBB", stored(40, { outcome: "failed:server" }))
      host.storage.set("outcome:session-running-CCC", stored(1, { outcome: undefined }))
      const cleanup = await setup(host)
      const all = (await host.rpc("usage", {})) as { days: number; tiers: Array<{ tier: string; total: { n: number; succeeded: number; failed: number }; agents: unknown[] }> }
      expect(all.days).toBe(90)
      expect(all.tiers).toHaveLength(1)
      expect(all.tiers[0]).toMatchObject({ tier: "cheap", total: { n: 2, succeeded: 1, failed: 1 } })
      const week = (await host.rpc("usage", { days: 7 })) as typeof all
      expect(week.days).toBe(7)
      expect(week.tiers[0]?.total).toMatchObject({ n: 1, succeeded: 1, failed: 0 })
      expect(((await host.rpc("usage", { days: "7" })) as typeof all).days).toBe(90)
      const text = JSON.stringify(all)
      for (const secret of ["session-recent", "session-old", "secret-parent", "secret-provider", "secret-model", "outcome:"]) expect(text).not.toContain(secret)
      host.close()
      await cleanup()
    })

    const explored = { agent: "coder", tests: "pass", policy: "explore-v1", eligible: ["p/m#medium", "p/m#high"] }
    const withExplored = (options: Record<string, unknown>) => {
      const host = createHost({ agents: [{ id: "plain" }], models, options })
      for (let i = 0; i < 12; i++) host.storage.set(`outcome:c${i}`, stored(1, { ...explored, arm: "p/m#high", p: 0.05 }))
      for (let i = 0; i < 40; i++) host.storage.set(`outcome:k${i}`, stored(1, { ...explored, arm: "p/m#medium", p: 0.95 }))
      return host
    }

    test("explored runs give an assessment in the reply and in model_roles_check while coder explores", async () => {
      const host = withExplored({ ...fallbackOptions, evaluate: { agents: ["coder"], explore: 0.05 } })
      const cleanup = await setup(host)
      const reply = (await host.rpc("usage", {})) as { assessments?: Array<{ tier: string; agent: string; text: string }> }
      expect(reply.assessments).toEqual([expect.objectContaining({ tier: "cheap", agent: "coder", text: "keep (n=12/30)" })])
      expect((await host.tools.get("model_roles_check")?.execute({}))?.content).toContain("  cheap/coder assessment: keep (n=12/30)")
      host.close()
      await cleanup()
    })

    test.each([
      ["no evaluate option", fallbackOptions],
      ["explore: 0", { ...fallbackOptions, evaluate: { agents: ["coder"], explore: 0 } }],
      ["coder not in evaluate.agents", { ...fallbackOptions, evaluate: { agents: ["plain"], explore: 0.05 } }],
    ])("with %s, past explored runs give no assessment and no adopt action", async (_name, options) => {
      const host = withExplored(options)
      const cleanup = await setup(host)
      // The adopt action in /tiers comes only from the reply's assessments.
      expect(((await host.rpc("usage", {})) as { assessments?: unknown[] }).assessments).toEqual([])
      expect((await host.tools.get("model_roles_check")?.execute({}))?.content).not.toContain("assessment")
      host.close()
      await cleanup()
    })
  })

  describe("outcome ledger", () => {
    const created = (id: string, model: ModelRef = sonnet) => ({ type: "session.created", data: { sessionID: id, parentID: "r", agent: "plain", model } })
    const withChild = async (opts: Record<string, unknown> = fallbackOptions, model: ModelRef = sonnet) => {
      const host = createHost({ agents: [{ id: "plain" }], models, options: opts })
      host.sessions.set("r", { id: "r" })
      host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model })
      const cleanup = await setup(host)
      await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-1")
      host.emit(created("c", model))
      await settle()
      return { host, cleanup }
    }

    test("a failover by a failed execution marks the child", async () => {
      const { host, cleanup } = await withChild({ ...fallbackOptions, flapCount: 1 })
      host.emit(failed("c", { type: "api", message: "ThrottlingException", status: 429 }))
      await settle()
      expect(host.storage.get("outcome:c")).toMatchObject({ outcome: "failed:rate-limit", failedOver: true })
      host.close()
      await cleanup()
    })

    test("a failover by the retry hook marks the child", async () => {
      const roles = { ...fallbackOptions, roles: { ...fallbackOptions.roles, cheap: ["anthropic/claude-haiku", "opencode/flint"] } }
      const host = createHost({ agents: [{ id: "plain" }], models, options: roles })
      const cleanup = await setup(host)
      await host.spawn("subagent", { agent: "plain", prompt: "x", role: "cheap" }, "build", "r", "call-1")
      host.emit(created("c", haiku))
      await settle()
      expect(host.storage.get("outcome:c")).not.toHaveProperty("failedOver")
      const error = { type: "provider.internal", message: "Overloaded", status: 529 }
      await host.fireRetry({ sessionID: "c", agent: "plain", model: haiku, error, attempt: 4 })
      await settle()
      expect(host.storage.get("outcome:c")).toMatchObject({ failedOver: true })
      host.close()
      await cleanup()
    })

    test("a switch that lands after the timeout still marks the child", async () => {
      const host = createHost({ agents: [{ id: "plain" }], models, options: { ...fallbackOptions, switchTimeoutMs: 20 } })
      let land: (() => void) | undefined
      host.context.session.switchModel = () =>
        new Promise<undefined>((resolve) => {
          land = () => resolve(undefined)
        })
      const cleanup = await setup(host)
      await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-1")
      host.emit(created("c"))
      await settle()
      const auth = { type: "provider.auth", message: "Unauthorized", status: 401 }
      await host.fireRetry({ sessionID: "c", agent: "plain", model: sonnet, error: auth, attempt: 2 })
      expect(host.storage.get("outcome:c")).not.toHaveProperty("failedOver")
      land?.()
      await settle()
      expect(host.storage.get("outcome:c")).toMatchObject({ failedOver: true })
      host.close()
      await cleanup()
    })

    test("slow ledger storage never turns a landed switch into a late one", async () => {
      const roles = { ...fallbackOptions, switchTimeoutMs: 20, roles: { ...fallbackOptions.roles, cheap: ["anthropic/claude-haiku", "opencode/flint"] } }
      const host = createHost({ agents: [{ id: "plain" }], models, options: roles })
      const cleanup = await setup(host)
      await host.spawn("subagent", { agent: "plain", prompt: "x", role: "cheap" }, "build", "r", "call-1")
      host.emit(created("c", haiku))
      await settle()
      const set = host.context.storage.set
      host.context.storage.set = async (key: string, value: unknown) => {
        if (key.startsWith("outcome:")) await new Promise((r) => setTimeout(r, 200))
        return set(key, value)
      }
      const error = { type: "provider.internal", message: "Overloaded", status: 529 }
      const decision = await host.fireRetry({ sessionID: "c", agent: "plain", model: haiku, error, attempt: 4 })
      expect(decision).toEqual({ retry: true, delay: 0 })
      expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: flint }])
      host.close()
      await cleanup()
      expect(host.storage.get("outcome:c")).toMatchObject({ failedOver: true })
    })

    test("an interrupted execution is recorded as interrupted", async () => {
      const { host, cleanup } = await withChild()
      host.emit({ type: "session.execution.interrupted", created: Date.now() + 500, data: { sessionID: "c" } })
      await settle()
      expect(host.storage.get("outcome:c")).toMatchObject({ outcome: "interrupted" })
      host.close()
      await cleanup()
    })

    test("a compaction adds its cost and tokens without counting a step, and is flushed at shutdown", async () => {
      const { host, cleanup } = await withChild()
      host.emit({
        type: "session.compaction.ended",
        data: { sessionID: "c", cost: 0.4, tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 7, write: 3 } } },
      })
      await settle()
      host.close()
      await cleanup()
      expect(host.storage.get("outcome:c")).toMatchObject({ cost: 0.4, inputTokens: 50, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, steps: 0 })
    })

    describe("outcome signals", () => {
      const text = (text: string) => ({ type: "session.text.ended", data: { sessionID: "c", assistantMessageID: "m", ordinal: 0, text } })
      const finish = (host: Awaited<ReturnType<typeof withChild>>["host"]) => host.emit({ type: "session.execution.succeeded", data: { sessionID: "c" } })

      test("a child idle with background work still running is not its end; its later test run counts", async () => {
        const { host, cleanup } = await withChild()
        const spawned = (host.storage.get("outcome:c") as { at: number }).at
        await host.fireIdle({ sessionID: "c", background: [{ kind: "shell", sessionID: "c", shellID: "sh_1", command: "bun test" }] })
        host.emit({ type: "session.execution.succeeded", created: spawned + 1_000, data: { sessionID: "c" } })
        await settle()
        expect(host.storage.get("outcome:c")).not.toHaveProperty("outcome")
        expect(host.storage.get("outcome:c")).not.toHaveProperty("tests")
        await host.toolDone("bash", { command: "bun test" }, { exit: 0 }, "c", "t1")
        await host.fireIdle({ sessionID: "c", background: [] })
        host.emit({ type: "session.execution.succeeded", created: spawned + 60_000, data: { sessionID: "c" } })
        await settle()
        expect(host.storage.get("outcome:c")).toMatchObject({ outcome: "succeeded", tests: "pass", ms: 60_000 })
        host.close()
        await cleanup()
      })

      test("a child held open by background work ends when its session is deleted", async () => {
        const { host, cleanup } = await withChild()
        const spawned = (host.storage.get("outcome:c") as { at: number }).at
        await host.fireIdle({ sessionID: "c", background: [{ kind: "subagent", sessionID: "c", childSessionID: "g", agent: "x", description: "y" }] })
        host.emit({ type: "session.execution.succeeded", created: spawned + 1_000, data: { sessionID: "c" } })
        host.emit({ type: "session.deleted", created: spawned + 5_000, data: { sessionID: "c" } })
        await settle()
        expect(host.storage.get("outcome:c")).toMatchObject({ outcome: "succeeded", tests: "none", ms: 5_000 })
        host.close()
        await cleanup()
      })

      /** A wall-clock time strictly after the last idle report and strictly before the next one. */
      const between = async () => {
        await Bun.sleep(2)
        const at = Date.now()
        await Bun.sleep(2)
        return at
      }

      test("each end meets its own idle report when the events are read after both idles", async () => {
        const { host, cleanup } = await withChild()
        const spawned = (host.storage.get("outcome:c") as { at: number }).at
        await host.fireIdle({ sessionID: "c", background: [{ kind: "shell", sessionID: "c", shellID: "sh_1", command: "bun test" }] })
        const firstEnd = await between()
        await host.fireIdle({ sessionID: "c", background: [] })
        const secondEnd = await between()
        host.emit({ type: "session.execution.succeeded", created: firstEnd, data: { sessionID: "c" } })
        await settle()
        expect(host.storage.get("outcome:c")).not.toHaveProperty("outcome")
        host.emit({ type: "session.execution.succeeded", created: secondEnd, data: { sessionID: "c" } })
        await settle()
        expect(host.storage.get("outcome:c")).toMatchObject({ outcome: "succeeded", ms: secondEnd - spawned })
        host.close()
        await cleanup()
      })

      test("work only a descendant owns does not hold the child open, since it never wakes the child", async () => {
        const { host, cleanup } = await withChild()
        const spawned = (host.storage.get("outcome:c") as { at: number }).at
        await host.fireIdle({ sessionID: "c", background: [{ kind: "shell", sessionID: "g", shellID: "sh_2", command: "bun test" }] })
        host.emit({ type: "session.execution.succeeded", created: spawned + 1_000, data: { sessionID: "c" } })
        await settle()
        expect(host.storage.get("outcome:c")).toMatchObject({ outcome: "succeeded", ms: 1_000 })
        host.close()
        await cleanup()
      })

      test("a child that never idles again ends at the hold timeout, at its first end, marked heldExpired", async () => {
        const timers = new Map<number, () => void>()
        let next = 0
        setHoldTimer({
          setTimeout: (callback, ms) => {
            expect(ms).toBe(BACKGROUND_HOLD_MS)
            timers.set(++next, callback)
            return next
          },
          clearTimeout: (timer) => void timers.delete(timer as number),
        })
        try {
          const { host, cleanup } = await withChild()
          const spawned = (host.storage.get("outcome:c") as { at: number }).at
          await host.fireIdle({ sessionID: "c", background: [{ kind: "shell", sessionID: "c", shellID: "sh_1", command: "sleep 240" }] })
          host.emit({ type: "session.execution.succeeded", created: spawned + 1_000, data: { sessionID: "c" } })
          await settle()
          expect(host.storage.get("outcome:c")).not.toHaveProperty("outcome")
          expect(timers.size).toBe(1)
          for (const expire of timers.values()) expire()
          await settle()
          expect(host.storage.get("outcome:c")).toMatchObject({ outcome: "succeeded", ms: 1_000, tests: "none", heldExpired: true })
          host.close()
          await cleanup()
        } finally {
          setHoldTimer(undefined)
        }
      })

      test("a reviewer's last VERDICT line is kept as an enum and no text", async () => {
        const { host, cleanup } = await withChild()
        host.emit(text("looks fine\nVERDICT: APPROVE"))
        host.emit(text("On second thought, secret finding\nVERDICT: REQUEST-CHANGES"))
        finish(host)
        await settle()
        const record = host.storage.get("outcome:c")
        expect(record).toMatchObject({ verdict: "request-changes", tests: "none", touchedTests: false })
        expect(JSON.stringify(record)).not.toContain("secret finding")
        host.close()
        await cleanup()
      })

      test("the last test run wins: a failing then a passing bun test", async () => {
        const { host, cleanup } = await withChild()
        await host.toolDone("bash", { command: "cd /repo && bun test", secret: "token-123" }, { exit: 1 }, "c", "t1")
        await host.toolDone("bash", { command: "ls" }, { exit: 0 }, "c", "t2")
        await host.toolDone("bash", { command: "CI=1 bun test" }, { exit: 0 }, "c", "t3")
        await host.toolDone("bash", { command: "bun test" }, {}, "c", "t4")
        finish(host)
        await settle()
        const record = host.storage.get("outcome:c")
        expect(record).toMatchObject({ tests: "pass", touchedTests: false })
        expect(record).not.toHaveProperty("verdict")
        expect(JSON.stringify(record)).not.toContain("bun test")
        host.close()
        await cleanup()
      })

      test("a failing last run is recorded as fail", async () => {
        const { host, cleanup } = await withChild()
        await host.toolDone("bash", { command: "bun test" }, { exit: 0 }, "c", "t1")
        await host.toolDone("bash", { command: "bun test" }, { exit: 1 }, "c", "t2")
        finish(host)
        await settle()
        expect(host.storage.get("outcome:c")).toMatchObject({ tests: "fail" })
        host.close()
        await cleanup()
      })

      test("a step that edits a test file sets touchedTests for good", async () => {
        const { host, cleanup } = await withChild()
        const step = (files: string[]) => ({ type: "session.step.ended", data: { sessionID: "c", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, files } })
        host.emit(step(["src/a.ts"]))
        host.emit(step(["src/a.test.ts"]))
        host.emit(step(["src/b.ts"]))
        finish(host)
        await settle()
        const record = host.storage.get("outcome:c")
        expect(record).toMatchObject({ touchedTests: true, tests: "none", steps: 3 })
        expect(JSON.stringify(record)).not.toContain("a.test.ts")
        host.close()
        await cleanup()
      })

      test("a session with no ledger record stores nothing", async () => {
        const { host, cleanup } = await withChild()
        host.emit({ type: "session.text.ended", data: { sessionID: "other", text: "VERDICT: APPROVE" } })
        await host.toolDone("bash", { command: "bun test" }, { exit: 0 }, "other", "t1")
        await settle()
        expect(host.storage.has("outcome:other")).toBe(false)
        host.close()
        await cleanup()
      })

      test("evaluate.testCommands replaces the default list", async () => {
        const { host, cleanup } = await withChild({ ...fallbackOptions, evaluate: { testCommands: ["make verify"] } })
        await host.toolDone("bash", { command: "make verify" }, { exit: 0 }, "c", "t1")
        await host.toolDone("bash", { command: "bun test" }, { exit: 1 }, "c", "t2")
        finish(host)
        await settle()
        expect(host.storage.get("outcome:c")).toMatchObject({ tests: "pass" })
        host.close()
        await cleanup()
      })
    })

    test("concurrent spawns of one agent and model each keep their own tier", async () => {
      const roles = { ...fallbackOptions, roles: { ...fallbackOptions.roles, extra: ["amazon-bedrock/claude-sonnet#high"] } }
      const host = createHost({ agents: [{ id: "plain" }], models, options: roles })
      const cleanup = await setup(host)
      await host.spawn("subagent", { agent: "plain", prompt: "x", role: "task" }, "build", "r", "call-1")
      await host.spawn("subagent", { agent: "plain", prompt: "x", role: "extra" }, "build", "r", "call-2")
      host.emit(created("c1"))
      host.emit(created("c2"))
      await settle()
      const tiers = ["c1", "c2"].map((id) => (host.storage.get(`outcome:${id}`) as { tier: string }).tier)
      expect(tiers[0]).not.toBe(tiers[1])
      expect(tiers[1]).toBe("extra")
      host.close()
      await cleanup()
    })
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

describe("runtimeFallback: false", () => {
  const off = {
    roles: { task: ["amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku"] },
    agents: { general: "task", build: "task" },
    runtimeFallback: false,
  }
  const failed = (sessionID: string, error: Record<string, unknown>) => ({ type: "session.execution.failed", data: { sessionID, error } })
  const methods = (host: ReturnType<typeof createHost>, method: string) => host.calls.filter((c) => c.method === method)
  const childHost = () => {
    const host = createHost({ agents: [{ id: "general" }, { id: "build" }], models, options: off })
    host.sessions.set("r", { id: "r" })
    for (const id of ["c1", "c2"]) host.sessions.set(id, { id, parentID: "r", agent: "general", model: sonnet })
    return host
  }

  test("the host's retry decision stands: no switch, no health", async () => {
    const host = childHost()
    const cleanup = await setup(host)
    const error = { type: "provider.internal", message: "Service Unavailable", status: 503 }
    const decision = await host.fireRetry({ sessionID: "r", agent: "build", model: sonnet, error, attempt: 4 })
    expect(decision).toEqual({ retry: true, delay: 1_500 })
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(host.storage.has("health")).toBe(false)
    host.close()
    await cleanup()
  })

  test("a failed execution marks no health, switches nothing and posts no notice", async () => {
    const host = childHost()
    const cleanup = await setup(host)
    const long = { type: "provider.invalid-request", message: "prompt is too long: 213462 tokens > 200000 maximum", status: 400 }
    for (const error of [{ type: "api", message: "ThrottlingException", status: 429 }, long]) {
      host.emit(failed("c1", error))
      await settle()
    }
    await host.spawnFailed({ agent: "general", prompt: "x" }, "Subagent failed (c1): ThrottlingException", "r")
    await settle()
    expect(methods(host, "switchModel")).toHaveLength(0)
    expect(methods(host, "synthetic")).toHaveLength(0)
    expect(host.storage.has("health")).toBe(false)
    expect(host.agents().get("general")?.model).toEqual(sonnet)
    host.close()
    await cleanup()
  })

  test("repeated credential failures raise no outage, stop or recovery notice", async () => {
    const host = childHost()
    const cleanup = await setup(host)
    const error = { type: "provider.auth", message: "Unable to locate credentials" }
    for (let i = 0; i < 6; i++) {
      host.emit(failed(i % 2 === 0 ? "c1" : "c2", error))
      await settle()
    }
    host.emit({ type: "session.execution.succeeded", data: { sessionID: "c1" } })
    await settle()
    expect(methods(host, "synthetic")).toHaveLength(0)
    host.close()
    await cleanup()
  })

  test("a stored, unexpired cooldown is ignored: the agent and a tier spawn use the first configured model", async () => {
    const host = childHost()
    host.storage.set("health", { "amazon-bedrock/claude-sonnet": { failedAt: Date.now(), until: Date.now() + 60_000, reason: "x" } })
    const cleanup = await setup(host)
    expect(host.agents().get("general")?.model).toEqual(sonnet)
    const input = await host.spawn("subagent", { agent: "general", prompt: "x", tier: "task" }, "build", "r", "call-1")
    expect(input.model).toBe("amazon-bedrock/claude-sonnet#high")
    host.close()
    await cleanup()
  })

  test("a tier still resolves its first configured model for a spawn", async () => {
    const host = childHost()
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "general", prompt: "x", tier: "task" }, "build", "r", "call-1")
    expect(input.model).toBe("amazon-bedrock/claude-sonnet#high")
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

  test("a stalled routing lookup ends within the guard's lookup bound", async () => {
    const options = autoOptions(undefined, { guard: { mode: "auto", lookupTimeoutMs: 20 } })
    const host = createHost({ agents, models: priced, options, sessionModel: opus })
    const cleanup = await setup(host)
    host.setGenerate(async () => ({ text: '{"role": "task", "confident": true}' }))
    const original = host.context.agent.list
    let calls = 0
    // Calls 1 and 2 are the pre-spawn lookup and the guard's; the third is the routing lookup.
    host.context.agent.list = async () => {
      if (++calls >= 3) await new Promise((resolve) => setTimeout(resolve, 500))
      return original()
    }
    const started = Date.now()
    await expect(host.spawn("subagent", { agent: "plain", description: "d", prompt: "x" })).rejects.toThrow(/inherit/)
    expect(Date.now() - started).toBeLessThan(400)
    host.close()
    await cleanup()
  }, 15_000)

  test("without a guard, a stalled parent-session cap lookup lets the routed spawn go on and says which lookup it was", async () => {
    const lines: string[] = []
    const capture = Logger.make(({ message }) => {
      lines.push(String(message))
    })
    const host = createHost({ agents, models: priced, options: autoOptions({ decider: "@tiny" }), sessionModel: opus })
    const cleanup = await Effect.runPromise(Effect.promise(() => setup(host)).pipe(Effect.provide(Logger.layer([capture]))))
    host.setSessionGet(() => new Promise((resolve) => setTimeout(() => resolve({ id: "s1" }), 6000)))
    const input = await host.spawn("subagent", { agent: "general", description: "find parser", prompt: "x" })
    expect(input.model).toBe("anthropic/claude-haiku")
    expect(lines.join("\n")).toContain("the parent-session cap lookup did not answer within 5000 ms; the spawn goes on without it")
    host.close()
    await cleanup()
  }, 20_000)

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
    // No valid pick: the tier's default effort, not the bare model.
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "standard" })).model).toBe(
      "amazon-bedrock/global.openai.gpt-6.1-sol#medium",
    )
    host.close()
    await cleanup()
  })

  test("effort auto without the auto option runs at the tier's default effort", async () => {
    const options = { tiers: { standard: { effort: "auto" }, coding: { effort: "auto", purpose: "code" } } }
    const host = createHost({ agents: [{ id: "plain" }], models: workModels, references, options, sessionModel: opus55 })
    const cleanup = await setup(host)
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "standard" })).model).toBe(
      "amazon-bedrock/global.openai.gpt-6.1-sol#medium",
    )
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "coding" })).model).toBe(
      "amazon-bedrock/global.openai.gpt-6.1-sol#medium",
    )
    expect(generations(host)).toHaveLength(0)
    const check = await host.tools.get("model_roles_check")?.execute({})
    expect(check?.content).toContain("by built-in effort; warning: effort auto fell back to medium: auto routing is off")
    host.close()
    await cleanup()
  })

  test("an auto-routed spawn and an agent on an auto-effort tier ask the decider for the effort", async () => {
    const options = { tiers: { standard: { effort: "auto" } }, auto: true }
    const agents: Agent[] = [{ id: "general" }, { id: "worker", request: header("standard") }]
    const host = createHost({ agents, models: workModels, references, options, sessionModel: opus55 })
    host.setGenerate(async () => ({ text: '{"role": "standard", "confident": true, "effort": "xhigh"}' }))
    const cleanup = await setup(host)
    expect((await host.spawn("subagent", { agent: "general", description: "d", prompt: "x" })).model).toBe(
      "amazon-bedrock/global.openai.gpt-6.1-sol#xhigh",
    )
    expect((await host.spawn("subagent", { agent: "worker", prompt: "x" })).model).toBe("amazon-bedrock/global.openai.gpt-6.1-sol#xhigh")
    const check = await host.tools.get("model_roles_check")?.execute({})
    expect(check?.content).toContain("worker: tier standard (agent tier) → amazon-bedrock/global.openai.gpt-6.1-sol#xhigh by auto effort")
    expect(check?.content).toContain("general: tier standard (auto routing) → amazon-bedrock/global.openai.gpt-6.1-sol#xhigh by auto effort")
    host.close()
    await cleanup()
  })

  test("a candidate's own variant wins over effort auto; a variant a linked tier sets does not", async () => {
    const sol = "amazon-bedrock/global.openai.gpt-6.1-sol"
    const options = { tiers: { standard: { model: [`${sol}#low`], effort: "auto" }, docs: { model: ["@strong"], effort: "auto", purpose: "d" } }, auto: true }
    const host = createHost({ agents: [{ id: "plain" }], models: workModels, references, options, sessionModel: opus55 })
    host.setGenerate(async () => ({ text: '{"effort": "xhigh"}' }))
    const cleanup = await setup(host)
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "standard" })).model).toBe(`${sol}#low`)
    expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "docs" })).model).toBe(
      "amazon-bedrock/global.anthropic.claude-opus-5-5#xhigh",
    )
    const check = await host.tools.get("model_roles_check")?.execute({})
    expect(check?.content).toContain(`plain: tier standard (tier param) → ${sol}#low by candidate variant`)
    host.close()
    await cleanup()
  })

  test("a spawn model wins over a pinned agent's tier in the receipt too", async () => {
    const haiku55 = { providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5" }
    const host = createHost({ agents: [{ id: "critic", model: haiku55, request: header("reviewer") }], models: workModels, references, options: {}, sessionModel: opus55 })
    const cleanup = await setup(host)
    await host.spawn("subagent", { agent: "critic", prompt: "x", model: "amazon-bedrock/global.openai.gpt-6.1-sol" })
    const check = await host.tools.get("model_roles_check")?.execute({})
    expect(check?.content).toContain(
      "critic: tier reviewer (agent tier) → amazon-bedrock/global.openai.gpt-6.1-sol by explicit model; warning: the spawn's own model wins over tier reviewer",
    )
    host.close()
    await cleanup()
  })

  test("warnings after setup's awaits reach the logger of the fiber that ran setup", async () => {
    const lines: unknown[] = []
    const capture = Logger.make(({ message }) => {
      lines.push(message)
    })
    const host = createHost({ agents: [{ id: "worker", request: header("cheap") }], models: workModels, references, options: {} })
    const cleanup = await Effect.runPromise(Effect.promise(() => setup(host)).pipe(Effect.provide(Logger.layer([capture]))))
    await host.spawn("subagent", { agent: "worker", prompt: "x", model: "amazon-bedrock/global.openai.gpt-6.1-sol" })
    await settle()
    expect(lines).toContainEqual(["srobroek.model-roles: spawn of 'worker' (tier cheap): the spawn's own model wins over tier cheap"])
    host.close()
    await cleanup()
  })

  test("a passed tier on an agent with its own tier leaves one receipt, for the tier", async () => {
    const host = createHost({ agents: [{ id: "worker", request: header("cheap") }], models: workModels, references, options: {}, sessionModel: opus55 })
    const cleanup = await setup(host)
    await host.spawn("subagent", { agent: "worker", prompt: "x", tier: "strong" })
    expect(host.storage.get("receipts")).toEqual([
      expect.objectContaining({ agent: "worker", source: "tier-param", tier: "strong", rule: "builtin-effort", warnings: [] }),
    ])
    host.close()
    await cleanup()
  })

  test("each routed spawn leaves a receipt: tier, source, model, winning rule and dropped settings", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models: workModels, references, options: {}, sessionModel: opus55 })
    const cleanup = await setup(host)
    await host.spawn("subagent", { agent: "plain", prompt: "x", role: "smol" })
    await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap", model: "amazon-bedrock/global.openai.gpt-6.1-sol" })
    const check = await host.tools.get("model_roles_check")?.execute({})
    const lines = (check?.content ?? "").split("\n")
    const at = lines.indexOf("Recent spawns (newest first):")
    expect(lines[at + 1]).toEndWith(
      "plain: tier cheap (tier param) → amazon-bedrock/global.openai.gpt-6.1-sol by explicit model; warning: the spawn's own model wins over tier cheap",
    )
    expect(lines[at + 2]).toEndWith("plain: tier cheap (smol, role param) → amazon-bedrock/global.anthropic.claude-haiku-5-5#low by built-in effort")
    expect(host.storage.get("receipts")).toHaveLength(2)
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

  /** Run `body` against a plugin whose global config dir holds a model-roles entry. */
  const withConfig = async (
    body: (host: ReturnType<typeof createHost>, file: string) => Promise<void>,
    agents: Agent[] = [],
    given: { options?: unknown; fileText?: string; project?: Record<string, string>; plugin?: unknown; seed?: (host: ReturnType<typeof createHost>) => void } = {},
  ) => {
    const dir = mkdtempSync(path.join(tmpdir(), "model-roles-rpc-"))
    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = dir
    const file = path.join(dir, "opencode.json")
    try {
      writeFileSync(file, given.fileText ?? '{ "plugins": [{ "package": "/x/plugins/model-roles", "options": {} }] }\n')
      const projectDir = path.join(dir, "project", "sub")
      mkdirSync(projectDir, { recursive: true })
      for (const [name, text] of Object.entries(given.project ?? {})) {
        mkdirSync(path.dirname(path.join(projectDir, name)), { recursive: true })
        writeFileSync(path.join(projectDir, name), text)
      }
      const host = createHost({ agents, models: work as unknown as Model[], references: reference as unknown as Model[], options: given.options ?? {}, directory: projectDir, plugin: given.plugin })
      given.seed?.(host)
      const cleanup = await setup(host)
      try {
        await body(host, file)
      } finally {
        host.close()
        await cleanup()
      }
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const sonnet55 = "amazon-bedrock/global.anthropic.claude-sonnet-5-5"

  describe("adopt", () => {
    const opus = "amazon-bedrock/global.anthropic.claude-opus-5-5"
    const explore = { roles: { strong: [`${opus}#low`] }, evaluate: { agents: ["coder"], explore: 0.05 } }
    /** Coder on `tier`: the control passes 20 of 40, the arm 30 of 30, both at $0.10 a run. */
    const seedFor =
      (tier: string, control: string, armLabel: string) =>
      (host: ReturnType<typeof createHost>) => {
        const run = (i: string, arm: string, p: number, outcome: string) =>
          host.storage.set(`outcome:${i}`, {
            v: 2,
            at: Date.now() - 1000,
            agent: "coder",
            tier,
            model: arm,
            parentID: `parent-${i}`,
            resumes: 0,
            cost: 0.1,
            steps: 1,
            ms: 10,
            outcome,
            tests: outcome === "succeeded" ? "pass" : "none",
            policy: "explore-v1",
            eligible: [control, armLabel],
            arm,
            p,
          })
        for (let i = 0; i < 40; i++) run(`k${i}`, control, 0.95, i < 20 ? "succeeded" : "failed:other")
        for (let i = 0; i < 30; i++) run(`a${i}`, armLabel, 0.025, "succeeded")
      }
    const seed = seedFor("strong", `${opus}#low`, `${opus}#medium`)
    type State = { tiers: TierRow[] }
    const evaluate = { evaluate: { agents: ["coder"], explore: 0.05 } }
    /** What the derived `standard` tier resolves to on the fixture catalog. */
    const standardControl = async (): Promise<string> => {
      let control = ""
      await withConfig(
        async (host) => {
          control = ((await host.rpc("state")) as State).tiers.find((t) => t.name === "standard")?.resolved ?? ""
        },
        [],
        { options: evaluate },
      )
      return control
    }

    test("a tier routing knows only by an old role name (`task`) still resolves its live control", async () => {
      const control = await standardControl()
      const arm = `${control.split("#")[0]}#${control.endsWith("#low") ? "high" : "low"}`
      await withConfig(
        async (host) => {
          const reply = (await host.rpc("usage", {})) as { assessments: AgentAssessment[] }
          expect(reply.assessments[0]).toMatchObject({ tier: "task", live: control })
          expect(reply.assessments[0]).not.toHaveProperty("removed")
        },
        [],
        { options: evaluate, seed: seedFor("task", control, arm) },
      )
    })

    test("a derived tier with no config of its own resolves its live control, and its recommendation is adopted", async () => {
      const control = await standardControl()
      expect(control).toMatch(/#/)
      const base = control.split("#")[0]
      const arm = `${base}#${control.endsWith("#low") ? "high" : "low"}`
      await withConfig(
        async (host) => {
          const reply = (await host.rpc("usage", {})) as { assessments: AgentAssessment[] }
          expect(reply.assessments[0]).toMatchObject({ tier: "standard", live: control, assessment: { decision: "recommend", control, arm } })
          expect(assessmentRows("standard", reply.assessments).map((r) => r.value)).toContain("\u0000adopt:coder")
          const row = ((await host.rpc("state")) as State).tiers.find((t) => t.name === "standard") as TierRow
          const plan = adoptPlan(row, control, arm)
          await host.rpc("set", { tier: "standard", value: plan.config ?? null, adopt: { agent: "coder", from: plan.from, to: plan.to } })
          expect(((await host.rpc("state")) as State).tiers.find((t) => t.name === "standard")?.resolved).toBe(arm)
        },
        [],
        { options: evaluate, seed: seedFor("standard", control, arm) },
      )
    })

    describe("announcements", () => {
      type Stored = { tier: string; agent: string; verdict: string; arm: string; seen: boolean }
      /** An open outcome of a child, so that its interruption ends a scored outcome. */
      const withOpen = (host: ReturnType<typeof createHost>) => {
        seed(host)
        host.storage.set("outcome:c", { v: 2, at: Date.now() - 1000, agent: "coder", tier: "strong", model: `${opus}#low`, parentID: "r", resumes: 0 })
      }
      const end = async (host: ReturnType<typeof createHost>) => {
        host.emit({ type: "session.execution.interrupted", created: Date.now() + 500, data: { sessionID: "c" } })
        await settle()
      }

      test("an ended outcome announces the recommendation once; the RPC lists it until seen", async () => {
        await withConfig(
          async (host) => {
            expect(await host.rpc("findings")).toEqual({ findings: [] })
            await end(host)
            const stored = host.storage.get("findings") as Stored[]
            expect(stored).toEqual([expect.objectContaining({ tier: "strong", agent: "coder", verdict: "recommend", arm: `${opus}#medium`, seen: false })])
            expect(((await host.rpc("findings")) as { findings: Stored[] }).findings).toHaveLength(1)
            await host.rpc("seen", { tier: "strong", agent: "coder" })
            expect(await host.rpc("findings")).toEqual({ findings: [] })
            expect((host.storage.get("findings") as Stored[])[0]?.seen).toBe(true)
          },
          [],
          { options: explore, seed: withOpen },
        )
      })

      test("seen refuses a call without a tier and an agent", async () => {
        await withConfig(
          async (host) => {
            await expect(host.rpc("seen", { tier: "strong" })).rejects.toThrow("seen needs a tier and an agent")
          },
          [],
          { options: explore },
        )
      })

      test("adopting the recommendation marks its finding seen", async () => {
        await withConfig(
          async (host) => {
            await end(host)
            const row = ((await host.rpc("state")) as State).tiers.find((t) => t.name === "strong") as TierRow
            const plan = adoptPlan(row, `${opus}#low`, `${opus}#medium`)
            await host.rpc("set", { tier: "strong", value: plan.config ?? null, adopt: { agent: "coder", from: plan.from, to: plan.to } })
            expect((host.storage.get("findings") as Stored[])[0]?.seen).toBe(true)
            expect(await host.rpc("findings")).toEqual({ findings: [] })
          },
          [],
          { options: explore, seed: withOpen },
        )
      })

      test("a tier changed since the assessment leaves the unseen findings at once", async () => {
        await withConfig(
          async (host) => {
            await end(host)
            expect(((await host.rpc("findings")) as { findings: unknown[] }).findings).toHaveLength(1)
            const row = ((await host.rpc("state")) as State).tiers.find((t) => t.name === "strong") as TierRow
            await host.rpc("set", { tier: "strong", value: adoptPlan(row, `${opus}#low`, `${opus}#high`).config ?? null })
            expect(await host.rpc("findings")).toEqual({ findings: [] })
          },
          [],
          { options: explore, seed: withOpen },
        )
      })

      test("with exploration off nothing is announced and the RPC lists nothing", async () => {
        await withConfig(
          async (host) => {
            await end(host)
            expect(host.storage.has("findings")).toBe(false)
            host.storage.set("findings", [{ tier: "strong", agent: "coder", verdict: "recommend", arm: "x", control: "y", pts: "+1.0", lb: "+0.5", cost: "$1", cost0: "$2", at: 1, seen: false }])
            expect(await host.rpc("findings")).toEqual({ findings: [] })
          },
          [],
          { options: { roles: explore.roles }, seed: withOpen },
        )
      })
    })

    test("a tier that no longer exists is reported as removed, and its adopt is refused", async () => {
      await withConfig(
        async (host, file) => {
          const reply = (await host.rpc("usage", {})) as { assessments: AgentAssessment[] }
          expect(reply.assessments[0]).toMatchObject({ tier: "gone", removed: true, assessment: { decision: "recommend" } })
          expect(assessmentRows("gone", reply.assessments)[0]?.description).toStartWith("tier no longer exists; the recommendation no longer applies")
          const before = readFileSync(file, "utf8")
          await expect(host.rpc("set", { tier: "gone", value: { model: [`${opus}#medium`] }, adopt: { agent: "coder", from: `${opus}#low`, to: `${opus}#medium` } })).rejects.toThrow(
            "Tier gone not saved: the tier no longer exists; the recommendation no longer applies.",
          )
          expect(readFileSync(file, "utf8")).toBe(before)
        },
        [],
        { options: explore, seed: seedFor("gone", `${opus}#low`, `${opus}#medium`) },
      )
    })

    test("adopting an effort arm of a roles tier that pins a variant makes the tier resolve to the new variant, and is recorded", async () => {
      await withConfig(
        async (host) => {
          const reply = (await host.rpc("usage", {})) as { assessments: Array<{ agent: string; assessment: { decision: string; control: string; arm: string } }> }
          expect(reply.assessments[0]?.assessment).toMatchObject({ decision: "recommend", control: `${opus}#low`, arm: `${opus}#medium` })
          const row = ((await host.rpc("state")) as State).tiers.find((t) => t.name === "strong") as TierRow
          expect(row.resolved).toBe(`${opus}#low`)
          const plan = adoptPlan(row, `${opus}#low`, `${opus}#medium`)
          await host.rpc("set", { tier: "strong", value: plan.config ?? null, adopt: { agent: "coder", from: plan.from, to: plan.to } })
          expect(((await host.rpc("state")) as State).tiers.find((t) => t.name === "strong")?.resolved).toBe(`${opus}#medium`)
          expect(host.storage.get("adoptions")).toEqual([{ tier: "strong", agent: "coder", from: `${opus}#low`, to: `${opus}#medium`, at: expect.any(Number) }])
        },
        [],
        { options: explore, seed },
      )
    })

    test.each([
      ["an invented predecessor", { agent: "coder", from: `${opus}#high`, to: `${opus}#medium` }],
      ["an arm the assessment does not recommend", { agent: "coder", from: `${opus}#low`, to: `${opus}#max` }],
      ["an agent with no assessment", { agent: "other", from: `${opus}#low`, to: `${opus}#medium` }],
    ])("set refuses an adoption with %s and writes nothing", async (_name, adopt) => {
      await withConfig(
        async (host, file) => {
          const before = readFileSync(file, "utf8")
          await expect(host.rpc("set", { tier: "strong", value: { model: [adopt.to] }, adopt })).rejects.toThrow(/Tier strong not saved: the assessment/)
          expect(readFileSync(file, "utf8")).toBe(before)
          expect(host.storage.get("adoptions")).toBeUndefined()
        },
        [],
        { options: explore, seed },
      )
    })

    test.each([
      ["a reset to auto", { model: "auto" }],
      ["an edit of its model list", { model: [sonnet55] }],
    ])("after %s the tier resolves elsewhere: the assessment is marked stale and a crafted adopt is refused", async (_name, edit) => {
      await withConfig(
        async (host, file) => {
          await host.rpc("set", { tier: "strong", value: edit })
          const reply = (await host.rpc("usage", {})) as { assessments: AgentAssessment[] }
          const [found] = reply.assessments
          expect(found?.assessment).toMatchObject({ decision: "recommend", control: `${opus}#low` })
          expect(found?.live).not.toBe(`${opus}#low`)
          expect(assessmentRows("strong", reply.assessments).some((r) => r.value.startsWith("\u0000adopt:"))).toBe(false)
          const before = readFileSync(file, "utf8")
          await expect(host.rpc("set", { tier: "strong", value: { model: [`${opus}#medium`] }, adopt: { agent: "coder", from: `${opus}#low`, to: `${opus}#medium` } })).rejects.toThrow(
            /Tier strong not saved: the tier changed since this assessment/,
          )
          expect(readFileSync(file, "utf8")).toBe(before)
          expect(host.storage.get("adoptions")).toBeUndefined()
        },
        [],
        { options: explore, seed },
      )
    })

    test("a plain set records no adoption", async () => {
      await withConfig(async (host) => {
        await host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })
        expect(host.storage.get("adoptions")).toBeUndefined()
      })
    })
  })

  test("set refuses an unknown model or variant and writes nothing; it warns about an unavailable one", async () => {
    await withConfig(async (host, file) => {
      const before = readFileSync(file, "utf8")
      await expect(host.rpc("set", { tier: "cheap", value: { model: [`${sonnet55}#bogus`] } })).rejects.toThrow(
        /global\.anthropic\.claude-sonnet-5-5 has no variant bogus \(it has: /,
      )
      await expect(host.rpc("set", { tier: "cheap", value: { model: ["nope/x"] } })).rejects.toThrow("Unknown model nope/x: no provider lists it.")
      expect(readFileSync(file, "utf8")).toBe(before)
      // openai/gpt-daybreak-blue-latest is in the catalog, not on this machine.
      const result = (await host.rpc("set", { tier: "cheap", value: { model: ["openai/gpt-daybreak-blue-latest", sonnet55] } })) as { warnings?: string[] }
      expect(result.warnings).toEqual([
        "openai/gpt-daybreak-blue-latest is not available now (provider not connected, or disabled); the tier skips it until it is.",
      ])
    })
  })

  test("setAgent writes options.agents, applies it at once and removes it again", async () => {
    await withConfig(
      async (host, file) => {
        const cheapModel = { providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "low" }
        expect(host.agents().get("worker")?.model).toEqual(cheapModel)
        await host.rpc("setAgent", { agent: "worker", tier: "strong" })
        expect(readAgents(readFileSync(file, "utf8"))).toEqual({ worker: "strong" })
        expect(host.agents().get("worker")?.model).not.toEqual(cheapModel)
        const state = (await host.rpc("state")) as { agents: Array<{ id: string; tier?: string; source?: string }> }
        expect(state.agents.find((a) => a.id === "worker")).toMatchObject({ tier: "strong", source: "options" })
        await host.rpc("setAgent", { agent: "worker", tier: null })
        expect(readAgents(readFileSync(file, "utf8"))).toEqual({})
        expect(host.agents().get("worker")?.model).toEqual(cheapModel)
      },
      [{ id: "worker", request: header("cheap") }],
    )
  })

  test("setAgent refuses an unknown tier or agent and writes nothing", async () => {
    await withConfig(
      async (host, file) => {
        const before = readFileSync(file, "utf8")
        await expect(host.rpc("setAgent", { agent: "worker", tier: "nope" })).rejects.toThrow('Agent worker not saved: Unknown tier "nope".')
        await expect(host.rpc("setAgent", { agent: "ghost", tier: "cheap" })).rejects.toThrow("the host lists no such agent")
        await expect(host.rpc("setAgent", { agent: "", tier: "cheap" })).rejects.toThrow(/Invalid agent/)
        expect(readFileSync(file, "utf8")).toBe(before)
      },
      [{ id: "worker", request: header("cheap") }],
    )
  })

  test("state lists an agent without a tier", async () => {
    await withConfig(async (host) => {
      const state = (await host.rpc("state")) as { agents: Array<Record<string, unknown>> }
      expect(state.agents).toEqual([{ id: "plain" }])
    }, [{ id: "plain" }])
  })

  type AgentView = { id: string; tier?: string; source?: string; resolved?: string }
  const agentRow = async (host: ReturnType<typeof createHost>, id: string) =>
    ((await host.rpc("state")) as { agents: AgentView[] }).agents.find((a) => a.id === id)
  const entry = (agents: Record<string, string>) =>
    `{ "plugins": [{ "package": "/x/plugins/model-roles", "options": { "agents": ${JSON.stringify(agents)} } }] }\n`
  const agentFixtures: Agent[] = [
    { id: "proj", request: header("cheap") },
    { id: "glob", request: header("cheap") },
  ]

  const projectEntry = (agents: Record<string, string>) => entry(agents)

  test("a project entry owns the agents: it stays across global saves, edits and removals, even at the same value", async () => {
    await withConfig(
      async (host, file) => {
        // The project says glob is reviewer, the same as the global file; it leaves proj out of its map.
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "reviewer", source: "options" })
        await host.rpc("set", { tier: "docs", value: { purpose: "docs" } })
        const saved = (await host.rpc("setAgent", { agent: "proj", tier: "strong" })) as { shadowedBy?: string }
        expect(saved.shadowedBy).toEndWith(path.join("project", "sub", "opencode.json"))
        expect(readAgents(readFileSync(file, "utf8"))).toEqual({ glob: "reviewer", proj: "strong" })
        // A global edit and a global removal change neither the project's glob nor give proj back its global tier.
        await host.rpc("setAgent", { agent: "glob", tier: "standard" })
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "reviewer", source: "options" })
        await host.rpc("setAgent", { agent: "glob", tier: null })
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "reviewer", source: "options" })
        expect(await agentRow(host, "proj")).toMatchObject({ tier: "cheap", source: "header" })
        const state = (await host.rpc("state")) as { agentConfig?: { origin: string; path?: string } }
        expect(state.agentConfig).toMatchObject({ origin: "project" })
      },
      agentFixtures,
      { options: { agents: { glob: "reviewer" } }, fileText: entry({ glob: "reviewer" }), project: { "opencode.json": projectEntry({ glob: "reviewer" }) } },
    )
  })

  test("a hand edit of the global file does not touch the agents a project entry owns", async () => {
    await withConfig(
      async (host, file) => {
        writeFileSync(file, entry({ glob: "strong" }))
        host.emit({ type: "config.updated", data: {} })
        await settle()
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "reviewer", source: "options" })
      },
      agentFixtures,
      { options: { agents: { glob: "reviewer" } }, fileText: entry({ glob: "reviewer" }), project: { "opencode.json": projectEntry({ glob: "reviewer" }) } },
    )
  })

  const tierEntry = (tiers: Record<string, unknown>) =>
    `{ "plugins": [{ "package": "/x/plugins/model-roles", "options": { "tiers": ${JSON.stringify(tiers)} } }] }\n`
  const workerModel = (host: ReturnType<typeof createHost>) => host.agents().get("worker")?.model
  const haikuLow = { providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "low" }
  const projectTiers = { cheap: { model: [`${sonnet55}#low`] } }
  const projectOnly = { options: { tiers: projectTiers }, fileText: tierEntry({}), project: { "opencode.json": tierEntry(projectTiers) } }
  const worker: Agent[] = [{ id: "worker", request: header("cheap") }]

  test("a project entry owns the tiers: a global save does not replace them, and state says the save is shadowed", async () => {
    await withConfig(
      async (host, file) => {
        const projectModel = workerModel(host)
        expect(projectModel).toMatchObject({ id: "global.anthropic.claude-sonnet-5-5" })
        const saved = (await host.rpc("set", { tier: "cheap", value: { model: ["amazon-bedrock/global.anthropic.claude-haiku-5-5#low"] } })) as { shadowedBy?: string }
        expect(saved.shadowedBy).toEndWith(path.join("project", "sub", "opencode.json"))
        expect(readTiers(readFileSync(file, "utf8"))).toEqual({ cheap: { model: ["amazon-bedrock/global.anthropic.claude-haiku-5-5#low"] } })
        expect(workerModel(host)).toEqual(projectModel)
        const state = (await host.rpc("state")) as { agentConfig?: { origin: string } }
        expect(state.agentConfig?.origin).toBe("project")
      },
      worker,
      projectOnly,
    )
  })

  test("a hand edit of the global tiers does not replace the tiers of a project entry", async () => {
    await withConfig(
      async (host, file) => {
        const projectModel = workerModel(host)
        writeFileSync(file, tierEntry({ cheap: { model: ["amazon-bedrock/global.anthropic.claude-haiku-5-5#low"] } }))
        host.emit({ type: "config.updated", data: {} })
        await settle()
        expect(workerModel(host)).toEqual(projectModel)
      },
      worker,
      projectOnly,
    )
  })

  const haikuId = "global.anthropic.claude-haiku-5-5"
  const sonnetId = "global.anthropic.claude-sonnet-5-5"
  const projectFile = (globalFile: string) => path.join(path.dirname(globalFile), "project", "sub", "opencode.json")
  const reload = async (host: ReturnType<typeof createHost>) => {
    host.emit({ type: "config.updated", data: {} })
    await settle()
  }
  /** The model a `role: "cheap"` spawn is sent to. */
  const spawnModel = async (host: ReturnType<typeof createHost>) => (await host.spawn("subagent", { agent: "worker", prompt: "x", role: "cheap" })).model

  test("an edit of the project entry's tiers applies on the next config reload, with a global entry present", async () => {
    await withConfig(
      async (host, file) => {
        expect(workerModel(host)).toMatchObject({ id: sonnetId })
        expect(await spawnModel(host)).toBe(`amazon-bedrock/${sonnetId}#low`)
        writeFileSync(projectFile(file), tierEntry({ cheap: { model: [`amazon-bedrock/${haikuId}#low`] } }))
        await reload(host)
        expect(workerModel(host)).toEqual(haikuLow)
        expect(await spawnModel(host)).toBe(`amazon-bedrock/${haikuId}#low`)
      },
      worker,
      projectOnly,
    )
  })

  test("an edit of the project entry's tiers applies when the global config has no entry at all", async () => {
    await withConfig(
      async (host, file) => {
        expect(workerModel(host)).toMatchObject({ id: sonnetId })
        writeFileSync(projectFile(file), tierEntry({ cheap: { model: [`amazon-bedrock/${haikuId}#low`] } }))
        await reload(host)
        expect(workerModel(host)).toEqual(haikuLow)
        expect(await spawnModel(host)).toBe(`amazon-bedrock/${haikuId}#low`)
      },
      worker,
      { ...projectOnly, fileText: '{ "plugins": [] }\n' },
    )
  })

  test("project tiers wait for a unique identity: until the host names this instance the startup tiers stay", async () => {
    let listed = false
    const plugin = { list: async () => ({ data: listed ? [row("/x/plugins/model-roles")] : [] }) }
    await withConfig(
      async (host, file) => {
        expect(workerModel(host)).toMatchObject({ id: sonnetId })
        writeFileSync(projectFile(file), tierEntry({ cheap: { model: [`amazon-bedrock/${haikuId}#low`] } }))
        await reload(host)
        // Unknown identity: a guess must not apply the project's new tiers.
        expect(workerModel(host)).toMatchObject({ id: sonnetId })
        expect(await spawnModel(host)).toBe(`amazon-bedrock/${sonnetId}#low`)
        listed = true
        await reload(host)
        expect(workerModel(host)).toEqual(haikuLow)
        expect(await spawnModel(host)).toBe(`amazon-bedrock/${haikuId}#low`)
      },
      worker,
      { ...projectOnly, plugin },
    )
  })

  test("without a project entry a global tier save still applies at once and is not shadowed", async () => {
    await withConfig(
      async (host) => {
        expect(workerModel(host)).toEqual(haikuLow)
        const saved = (await host.rpc("set", { tier: "cheap", value: { model: [`${sonnet55}#low`] } })) as { shadowedBy?: string }
        expect(saved.shadowedBy).toBeUndefined()
        expect(workerModel(host)).toMatchObject({ id: "global.anthropic.claude-sonnet-5-5" })
      },
      worker,
      { fileText: tierEntry({}) },
    )
  })

  test("a project entry under another package string does not shadow the global one; the list is told", async () => {
    await withConfig(
      async (host) => {
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "reviewer", source: "options" })
        await host.rpc("setAgent", { agent: "glob", tier: "standard" })
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "standard", source: "options" })
        const state = (await host.rpc("state")) as { agentConfig?: { origin: string; alsoLoads?: string } }
        expect(state.agentConfig?.origin).toBe("global")
        expect(state.agentConfig?.alsoLoads).toEndWith(path.join("project", "sub", "opencode.json"))
      },
      agentFixtures,
      {
        options: { agents: { glob: "reviewer" } },
        fileText: entry({ glob: "reviewer" }),
        project: { "opencode.json": entry({ glob: "strong" }).replace("/x/plugins/model-roles", "/y/plugins/model-roles") },
      },
    )
  })

  test("the host's own package target picks and writes only the entry with that exact string", async () => {
    const two = `{ "plugins": [{ "package": "/x/plugins/model-roles", "options": { "agents": { "glob": "cheap" } } }, { "package": "/z/plugins/model-roles", "options": { "agents": { "glob": "reviewer" } } }] }\n`
    await withConfig(
      async (host, file) => {
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "reviewer", source: "options" })
        await host.rpc("setAgent", { agent: "glob", tier: "strong" })
        const written = JSON.parse(readFileSync(file, "utf8")).plugins
        expect(written[0].options.agents).toEqual({ glob: "cheap" })
        expect(written[1].options.agents).toEqual({ glob: "strong" })
      },
      agentFixtures,
      {
        options: { agents: { glob: "reviewer" } },
        fileText: two,
        plugin: { list: async () => ({ data: [{ id: "srobroek.model-roles", source: { type: "package", target: "/z/plugins/model-roles" } }] }) },
      },
    )
  })

  test("a project-only config (no global entry): a hand edit and a reload apply", async () => {
    await withConfig(
      async (host, file) => {
        const projectFile = path.join(path.dirname(file), "project", "sub", "opencode.json")
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "reviewer", source: "options" })
        writeFileSync(projectFile, entry({ glob: "strong" }))
        host.emit({ type: "config.updated", data: {} })
        await settle()
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "strong", source: "options" })
        writeFileSync(projectFile, entry({}))
        host.emit({ type: "config.updated", data: {} })
        await settle()
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "cheap", source: "header" })
      },
      agentFixtures,
      { options: { agents: { glob: "reviewer" } }, fileText: "{}\n", project: { "opencode.json": entry({ glob: "reviewer" }) } },
    )
  })

  const row = (target: string) => ({ id: "srobroek.model-roles", source: { type: "package", target } })
  const refused = async (plugin: unknown, message: RegExp) => {
    const two = `{ "plugins": [{ "package": "/x/plugins/model-roles", "options": { "agents": { "glob": "cheap" } } }, { "package": "/z/plugins/model-roles", "options": { "agents": { "glob": "reviewer" } } }] }\n`
    await withConfig(
      async (host, file) => {
        const before = readFileSync(file, "utf8")
        await expect(host.rpc("setAgent", { agent: "glob", tier: "strong" })).rejects.toThrow(message)
        await expect(host.rpc("set", { tier: "cheap", value: { effort: "high" } })).rejects.toThrow(message)
        expect(readFileSync(file, "utf8")).toBe(before)
        // A reload keeps the startup assignments instead of applying another entry's.
        writeFileSync(file, two.replace('"glob": "reviewer"', '"glob": "strong"'))
        host.emit({ type: "config.updated", data: {} })
        await settle()
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "reviewer", source: "options" })
      },
      agentFixtures,
      { options: { agents: { glob: "reviewer" } }, fileText: two, plugin },
    )
  }

  test("two loaded instances with this id: saves refuse before writing, reloads keep the startup agents", async () => {
    await refused({ list: async () => ({ data: [row("/x/plugins/model-roles"), row("/z/plugins/model-roles")] }) }, /Two model-roles entries are loaded \(\/x\/plugins\/model-roles, \/z\/plugins\/model-roles\); \/tiers can't tell which one to edit/)
  })

  test("the host lists this plugin only after setup: the first save after that works, and the identity is kept", async () => {
    let listed = false
    const plugin = { list: async () => ({ data: listed ? [row("/x/plugins/model-roles")] : [] }) }
    await withConfig(
      async (host, file) => {
        await expect(host.rpc("setAgent", { agent: "glob", tier: "strong" })).rejects.toThrow(/did not say which model-roles entry/)
        listed = true
        await host.rpc("setAgent", { agent: "glob", tier: "strong" })
        expect(readAgents(readFileSync(file, "utf8"))).toEqual({ glob: "strong" })
        // A unique answer is cached: later saves do not depend on the host listing again.
        listed = false
        await host.rpc("setAgent", { agent: "glob", tier: "standard" })
        expect(readAgents(readFileSync(file, "utf8"))).toEqual({ glob: "standard" })
      },
      agentFixtures,
      { plugin },
    )
  })

  test("an ambiguous answer is not cached: a later unique one lets saves through", async () => {
    let rows = [row("/x/plugins/model-roles"), row("/z/plugins/model-roles")]
    const plugin = { list: async () => ({ data: rows }) }
    await withConfig(
      async (host, file) => {
        await expect(host.rpc("setAgent", { agent: "glob", tier: "strong" })).rejects.toThrow(/Two model-roles entries are loaded/)
        rows = [row("/x/plugins/model-roles")]
        await host.rpc("setAgent", { agent: "glob", tier: "strong" })
        expect(readAgents(readFileSync(file, "utf8"))).toEqual({ glob: "strong" })
      },
      agentFixtures,
      { plugin },
    )
  })

  test("no host answer: saves refuse too", async () => {
    await refused({ list: async () => Promise.reject(new Error("down")) }, /did not say which model-roles entry/)
  })

  test("one row whose target names no config entry refuses without writing", async () => {
    await withConfig(
      async (host, file) => {
        const before = readFileSync(file, "utf8")
        await expect(host.rpc("setAgent", { agent: "glob", tier: "strong" })).rejects.toThrow(/No model-roles plugin entry/)
        expect(readFileSync(file, "utf8")).toBe(before)
      },
      agentFixtures,
      { plugin: { list: async () => ({ data: [row("/nowhere/model-roles")] }) } },
    )
  })

  test("a hand edit of the project file applies", async () => {
    await withConfig(
      async (host, file) => {
        const projectFile = path.join(path.dirname(file), "project", "sub", "opencode.json")
        writeFileSync(projectFile, projectEntry({ glob: "strong" }))
        host.emit({ type: "config.updated", data: {} })
        await settle()
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "strong", source: "options" })
      },
      agentFixtures,
      { options: { agents: { glob: "reviewer" } }, fileText: entry({ glob: "reviewer" }), project: { "opencode.json": projectEntry({ glob: "reviewer" }) } },
    )
  })

  test("with no project entry, global saves, Agent default and edits apply; assignments from another source stay", async () => {
    await withConfig(
      async (host) => {
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "reviewer", source: "options" })
        const state = (await host.rpc("state")) as { agentConfig?: { origin: string } }
        expect(state.agentConfig?.origin).toBe("global")
        await host.rpc("setAgent", { agent: "proj", tier: "strong" })
        expect(await agentRow(host, "proj")).toMatchObject({ tier: "strong", source: "options" })
        await host.rpc("setAgent", { agent: "glob", tier: null })
        expect(await agentRow(host, "glob")).toMatchObject({ tier: "cheap", source: "header" })
        expect(await agentRow(host, "other")).toMatchObject({ tier: "strong", source: "options" })
      },
      [...agentFixtures, { id: "other", request: header("cheap") }],
      { options: { agents: { glob: "reviewer", other: "strong" } }, fileText: entry({ glob: "reviewer" }), project: { "opencode.json": '{ "plugins": ["other"] }' } },
    )
  })

  test("a hand edit of only the global agents fires config.updated and applies", async () => {
    await withConfig(
      async (host, file) => {
        expect(await agentRow(host, "worker")).toMatchObject({ tier: "cheap", source: "header" })
        writeFileSync(file, entry({ worker: "strong" }))
        host.emit({ type: "config.updated", data: {} })
        await settle()
        expect(await agentRow(host, "worker")).toMatchObject({ tier: "strong", source: "options" })
        expect(host.agents().get("worker")?.model).not.toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "low" })
      },
      [{ id: "worker", request: header("cheap") }],
    )
  })

  test("a setAgent whose reload fails restores every agent's tier, source and model; a retry succeeds", async () => {
    await withConfig(
      async (host) => {
        const views = async () => ({ rows: [await agentRow(host, "worker"), await agentRow(host, "other")], models: [host.agents().get("worker")?.model, host.agents().get("other")?.model] })
        const before = await views()
        const original = host.context.tool.transform
        let fail = true
        host.context.tool.transform = async (callback) => {
          if (fail) {
            fail = false
            throw new Error("tool refresh refused")
          }
          return original(callback)
        }
        await expect(host.rpc("setAgent", { agent: "worker", tier: "strong" })).rejects.toThrow(/not applied: tool refresh refused/)
        expect(await views()).toEqual(before)
        await host.rpc("setAgent", { agent: "worker", tier: "strong" })
        expect(await agentRow(host, "worker")).toMatchObject({ tier: "strong", source: "options" })
        expect(await agentRow(host, "other")).toEqual(before.rows[1])
      },
      [
        { id: "worker", request: header("cheap") },
        { id: "other", request: header("standard") },
      ],
    )
  })

  test("a saved tier applies to the running instance at once, and so does a config reload", async () => {
    await withConfig(
      async (host, file) => {
        const before = await host.fireContext("s1")
        await host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })
        expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" })).model).toBe(`${sonnet55}#low`)
        // Agents on the tier move, a new session sees the new tier, a running one keeps its parameter.
        expect(host.agents().get("worker")?.model).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5-5", variant: "low" })
        await host.rpc("set", { tier: "coding", value: { purpose: "writing code" } })
        expect((await host.fireContext("s2")).input.properties.tier?.enum).toContain("coding")
        expect(JSON.stringify(await host.fireContext("s1"))).toBe(JSON.stringify(before))
        writeFileSync(file, `{ "plugins": [{ "package": "/x/plugins/model-roles", "options": { "tiers": { "cheap": { "model": ["${sonnet55}"], "effort": "high" } } } }] }\n`)
        host.emit({ type: "config.updated", data: {} })
        await settle()
        expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" })).model).toBe(`${sonnet55}#high`)
      },
      [{ id: "worker", request: header("cheap") }],
    )
  })

  test("a spawn during a reload waits for it, then resolves and records the new tier", async () => {
    await withConfig(
      async (host) => {
        const original = host.context.agent.transform
        let release = () => {}
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        host.context.agent.transform = async (callback) => {
          await held
          return original(callback)
        }
        const saving = host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })
        await settle()
        let model: unknown = "pending"
        const spawning = host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" }).then((input) => {
          model = input.model
        })
        await settle()
        expect(model).toBe("pending")
        release()
        await saving
        await spawning
        expect(model).toBe(`${sonnet55}#low`)
        expect((host.storage.get("receipts") as Array<{ model: string }>)[0]?.model).toBe(`${sonnet55}#low`)
      },
      [{ id: "worker", request: header("cheap") }],
    )
  })

  describe("a stalled lookup while a tier reload holds the gate", () => {
    const oldModel = { providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "low" }
    const lateAgents = (host: ReturnType<typeof createHost>, armed: () => boolean, disarm: () => void) => {
      const original = host.context.agent.list
      host.context.agent.list = async () => {
        if (armed()) {
          disarm()
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        return original()
      }
    }
    const guarded = { guard: { lookupTimeoutMs: 20 } }

    test("releases the gate within the bound, keeps the previous tiers, and ignores the late answer", async () => {
      await withConfig(
        async (host) => {
          let stalls = 2
          lateAgents(host, () => stalls > 0, () => stalls--)
          const started = Date.now()
          await expect(host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })).rejects.toThrow(/not applied/)
          expect(Date.now() - started).toBeLessThan(400)
          expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" })).model).toBe("amazon-bedrock/global.anthropic.claude-haiku-5-5#low")
          // The stalled lookups answer after their deadline; the answer applies nothing.
          await new Promise((resolve) => setTimeout(resolve, 700))
          expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" }, "build", "s1", "c2")).model).toBe("amazon-bedrock/global.anthropic.claude-haiku-5-5#low")
          expect(host.agents().get("worker")?.model).toEqual(oldModel)
        },
        [{ id: "worker", request: header("cheap") }],
        { options: guarded },
      )
    }, 15_000)

    for (const [what, lifecycle] of [
      ["agent registration", "agent"],
      ["tool registration", "tool"],
    ] as const) {
      test(`a stalled ${what} releases the gate within the bound and its late answer is dropped`, async () => {
        await withConfig(
          async (host) => {
            const target = lifecycle === "agent" ? host.context.agent : host.context.tool
            const original = target.transform as (callback: unknown) => Promise<{ dispose: () => Promise<void> }>
            let stalls = true
            ;(target as { transform: unknown }).transform = async (callback: unknown) => {
              if (stalls) {
                stalls = false
                await new Promise((resolve) => setTimeout(resolve, 500))
              }
              return original(callback)
            }
            const live = () => (lifecycle === "agent" ? host.activeTransforms() : host.liveToolTransforms())
            const active = live()
            const started = Date.now()
            await expect(host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })).rejects.toThrow(/not applied/)
            expect(Date.now() - started).toBeLessThan(400)
            expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" })).model).toBe("amazon-bedrock/global.anthropic.claude-haiku-5-5#low")
            // The stalled registration answers after its deadline; it is disposed, so no extra one stays active.
            await new Promise((resolve) => setTimeout(resolve, 700))
            expect(live()).toBe(active)
          },
          [{ id: "worker", request: header("cheap") }],
          { options: guarded },
        )
      }, 15_000)
    }

    for (const lifecycle of ["agent", "tool"] as const) {
      test(`a stalled ${lifecycle} registration disposal releases the gate within the bound`, async () => {
        await withConfig(
          async (host) => {
            const target = lifecycle === "agent" ? host.context.agent : host.context.tool
            const original = target.transform as (callback: unknown) => Promise<{ dispose: () => Promise<void> }>
            // Every registration made from here on has a disposal that takes far longer than the bound.
            ;(target as { transform: unknown }).transform = async (callback: unknown) => {
              const registration = await original(callback)
              return { dispose: () => new Promise<void>((resolve) => setTimeout(() => registration.dispose().then(resolve), 500)) }
            }
            // A first reload makes the stalling registration the current one; the second disposes it.
            await host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })?.catch(() => {})
            const started = Date.now()
            await host.rpc("set", { tier: "cheap", value: { model: ["amazon-bedrock/global.anthropic.claude-haiku-5-5"] } })?.catch(() => {})
            expect(Date.now() - started).toBeLessThan(400)
            await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" })
          },
          [{ id: "worker", request: header("cheap") }],
          { options: guarded },
        )
      }, 15_000)
    }

    test("when the forward registration applied and the whole rollback stalled, an un-tiered spawn is refused, never run on the rejected model", async () => {
      await withConfig(
        async (host) => {
          const agentTransform = host.context.agent.transform
          let agentCalls = 0
          let stall = false
          lateAgents(host, () => stall, () => {})
          host.context.agent.transform = async (callback) => {
            // The first call is the reload's forward registration; every later one (the rollback's) stalls.
            if (++agentCalls > 1) await new Promise((resolve) => setTimeout(resolve, 500))
            return agentTransform(callback)
          }
          host.context.tool.transform = async () => {
            stall = true
            throw new Error("tool refresh refused")
          }
          await expect(host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })).rejects.toThrow(/not applied/)
          // The forward registration moved the agents to the rejected tier ...
          expect(host.agents().get("worker")?.model).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5-5", variant: "low" })
          // ... and the rollback never got in, so a spawn that would run on the agent's own model is refused.
          await expect(host.spawn("subagent", { agent: "worker", prompt: "x" })).rejects.toThrow(/previous tiers could not be restored/)
          // A spawn that names its tier still goes through.
          expect((await host.spawn("subagent", { agent: "worker", prompt: "x", tier: "cheap" }, "build", "s1", "c2")).model).toBe("amazon-bedrock/global.anthropic.claude-haiku-5-5#low")
        },
        [{ id: "worker", request: header("cheap") }],
        { options: guarded },
      )
    }, 15_000)

    test("after a failed reload with a stalled rollback lookup the agents are back on their previous models", async () => {
      await withConfig(
        async (host) => {
          let stall = false
          lateAgents(host, () => stall, () => (stall = false))
          // Every tool refresh fails, the restore's too, so nothing but the agents' own re-registration can put them back.
          host.context.tool.transform = async () => {
            stall = true
            throw new Error("tool refresh refused")
          }
          const registered = host.transformCalls()
          await expect(host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })).rejects.toThrow(/not applied: tool refresh refused/)
          // The reload registered the agents once; the restore registers them again without the stalled lookup.
          expect(host.transformCalls()).toBeGreaterThanOrEqual(registered + 2)
          expect(host.agents().get("worker")?.model).toEqual(oldModel)
          // An agent on a tier, spawned with no tier of its own on the call, runs on the restored model.
          await host.spawn("subagent", { agent: "worker", prompt: "x" })
          expect((host.storage.get("receipts") as Array<{ model: string }>).at(-1)?.model).toBe("amazon-bedrock/global.anthropic.claude-haiku-5-5#low")
        },
        [{ id: "worker", request: header("cheap") }],
        { options: guarded },
      )
    }, 15_000)

    test("a stalled rollback lookup releases the gate too", async () => {
      await withConfig(
        async (host) => {
          const original = host.context.tool.transform
          let fail = true
          let stall = false
          lateAgents(host, () => stall, () => (stall = false))
          host.context.tool.transform = async (callback) => {
            if (fail) {
              fail = false
              stall = true
              throw new Error("tool refresh refused")
            }
            return original(callback)
          }
          const started = Date.now()
          await expect(host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })).rejects.toThrow(/not applied: tool refresh refused/)
          expect(Date.now() - started).toBeLessThan(400)
          expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" })).model).toBe("amazon-bedrock/global.anthropic.claude-haiku-5-5#low")
          await new Promise((resolve) => setTimeout(resolve, 700))
          expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" }, "build", "s1", "c2")).model).toBe("amazon-bedrock/global.anthropic.claude-haiku-5-5#low")
        },
        [{ id: "worker", request: header("cheap") }],
        { options: guarded },
      )
    }, 15_000)
  })

  for (const site of ["pre-spawn agent", "caller-vendor session"]) {
    test(`a stalled ${site} lookup does not hold up a later reload`, async () => {
      await withConfig(
        async (host, file) => {
          const original = host.context.agent.list
          let calls = 0
          if (site === "pre-spawn agent")
            host.context.agent.list = async () => {
              if (++calls === 1) await new Promise((resolve) => setTimeout(resolve, 500))
              return original()
            }
          else host.setSessionGet(() => new Promise((resolve) => setTimeout(() => resolve({ id: "s1" }), 500)))
          const started = Date.now()
          const spawning = host.spawn("subagent", { agent: "plain", prompt: "x", ...(site === "pre-spawn agent" ? {} : { tier: "reviewer" }) }).catch(() => {})
          await settle()
          writeFileSync(file, `{ "plugins": [{ "package": "/x/plugins/model-roles", "options": { "guard": { "lookupTimeoutMs": 20 }, "tiers": { "cheap": { "model": ["${sonnet55}"], "effort": "high" } } } }] }\n`)
          host.emit({ type: "config.updated", data: {} })
          await spawning
          await settle()
          expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" }, "build", "s1", "c2")).model).toBe(`${sonnet55}#high`)
          expect(Date.now() - started).toBeLessThan(400)
        },
        [],
        { options: { guard: { lookupTimeoutMs: 20 } } },
      )
    }, 15_000)
  }

  test("a reload waits for a spawn already running, which keeps the old tier in its model and receipt", async () => {
    await withConfig(
      async (host) => {
        const haiku55 = "amazon-bedrock/global.anthropic.claude-haiku-5-5"
        const original = host.context.agent.list
        let release = () => {}
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        let holdNext = true
        host.context.agent.list = async () => {
          if (holdNext) {
            holdNext = false
            await held
          }
          return original()
        }
        let model: unknown = "pending"
        const spawning = host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" }).then((input) => {
          model = input.model
        })
        await settle()
        let saved = false
        const saving = Promise.resolve(host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })).then(() => {
          saved = true
        })
        await settle()
        // The reload is queued behind the running spawn: nothing has moved.
        expect(saved).toBe(false)
        expect(host.agents().get("worker")?.model).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "low" })
        release()
        await spawning
        await saving
        expect(model).toBe(`${haiku55}#low`)
        expect((host.storage.get("receipts") as Array<{ model: string }>)[0]?.model).toBe(`${haiku55}#low`)
        expect(host.agents().get("worker")?.model).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5-5", variant: "low" })
        expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" }, "build", "s1", "c2")).model).toBe(`${sonnet55}#low`)
      },
      [{ id: "worker", request: header("cheap") }],
    )
  })

  test("a reload whose tool refresh fails after the agents moved puts agents, spawns and the tool back", async () => {
    await withConfig(
      async (host) => {
        const haiku55 = "amazon-bedrock/global.anthropic.claude-haiku-5-5"
        const toolBefore = JSON.stringify(host.subagent())
        const original = host.context.tool.transform
        let fail = true
        let movedWhenRefreshFailed: unknown
        let beforeToolRestore: unknown
        let toolRestores = 0
        host.context.tool.transform = async (callback) => {
          if (fail) {
            fail = false
            movedWhenRefreshFailed = host.agents().get("worker")?.model
            throw new Error("tool refresh refused")
          }
          // The restore re-registers the tool right after it put the agents back. Event-driven checks
          // cannot run yet (the reload holds the queue), so this view is the restore's own work.
          if (++toolRestores === 1) beforeToolRestore = host.agents().get("worker")?.model
          return original(callback)
        }
        await expect(host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })).rejects.toThrow(/not applied: tool refresh refused/)
        // The agents had moved to the new tier when the refresh failed ...
        expect(movedWhenRefreshFailed).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5-5", variant: "low" })
        // ... the restore itself put them back before it re-registered the tool, ...
        expect(beforeToolRestore).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "low" })
        // ... and agents, spawns, their receipts and the tool are back.
        expect(host.agents().get("worker")?.model).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "low" })
        expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" })).model).toBe(`${haiku55}#low`)
        expect((host.storage.get("receipts") as Array<{ model: string }>)[0]?.model).toBe(`${haiku55}#low`)
        expect(JSON.stringify(host.subagent())).toBe(toolBefore)
        expect(host.activeTransforms()).toBe(1)
      },
      [{ id: "worker", request: header("cheap") }],
    )
  })

  test("a reload whose agent update fails restores the previous tiers", async () => {
    await withConfig(
      async (host) => {
        const original = host.context.agent.transform
        let fail = true
        host.context.agent.transform = async (callback) => {
          if (fail) {
            fail = false
            throw new Error("transform refused")
          }
          return original(callback)
        }
        await expect(host.rpc("set", { tier: "cheap", value: { model: [sonnet55] } })).rejects.toThrow(/not applied: transform refused/)
        const haiku55 = "amazon-bedrock/global.anthropic.claude-haiku-5-5"
        expect((await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "cheap" })).model).toBe(`${haiku55}#low`)
        expect(host.agents().get("worker")?.model).toEqual({ providerID: "amazon-bedrock", id: "global.anthropic.claude-haiku-5-5", variant: "low" })
      },
      [{ id: "worker", request: header("cheap") }],
    )
  })

  test("state previews a draft without saving it, and lists every tiered agent", async () => {
    await withConfig(
      async (host) => {
        const state = (await host.rpc("state", { draft: { cheap: { model: [sonnet55] }, coding: { purpose: "code" } } })) as {
          tiers: Array<{ name: string; resolved?: string; health?: Array<{ entry: string; status: string }> }>
          agents: Array<{ id: string; tier: string; source: string; resolved?: string }>
        }
        const cheap = state.tiers.find((t) => t.name === "cheap")
        expect(cheap?.resolved).toBe(`${sonnet55}#low`)
        expect(cheap?.health).toEqual([{ entry: `${sonnet55}#low`, status: "available" }])
        expect(state.tiers.find((t) => t.name === "coding")?.resolved).toBe("amazon-bedrock/global.openai.gpt-6.1-sol#medium")
        expect(state.agents).toContainEqual({ id: "worker", tier: "strong", source: "header", resolved: "amazon-bedrock/global.anthropic.claude-opus-5-5#high" })
        // Nothing was saved: a spawn still gets the running cheap tier.
        expect((await host.spawn("subagent", { agent: "worker", prompt: "x", tier: "cheap" })).model).toBe(
          "amazon-bedrock/global.anthropic.claude-haiku-5-5#low",
        )
      },
      [{ id: "worker", request: header("strong") }],
    )
  })
})

describe("a child keeps its resolved model", () => {
  const sonnetHigh = "amazon-bedrock/claude-sonnet#high"
  const first: { roles: Record<string, string[]>; agents: Record<string, string> } = { roles: { task: ["amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku"] }, agents: { general: "task" } }
  const changed = { roles: { task: ["amazon-bedrock/claude-sonnet", "anthropic/claude-haiku"] }, agents: { general: "task" } }
  const withSonnetHigh: Model[] = models
  const resume = { agent: "plain", prompt: "again", sessionID: "c" }
  const methods = (host: ReturnType<typeof createHost>, method: string) => host.calls.filter((c) => c.method === method)
  const receipts = (host: ReturnType<typeof createHost>) => host.storage.get("receipts") as Array<{ rule: string; model?: string; configRevision?: string; warnings: string[] }>

  /** A host that spawned child `c` on tier `task`, then restarted on `next` options with the same storage. */
  const spawnThenReload = async (next: typeof first, nextModels: Model[] = withSonnetHigh) => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: first })
    host.sessions.set("r", { id: "r" })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-1")
    created(host, "c", "plain", sonnet)
    await settle()
    await host.spawnDone(input, { sessionID: "c" }, "r", "call-1")
    host.close()
    await cleanup()
    const again = createHost({ agents: [{ id: "plain" }], models: nextModels, options: next })
    for (const [key, value] of host.storage) again.storage.set(key, value)
    again.sessions.set("r", { id: "r" })
    return { host, again, cleanupAgain: await setup(again) }
  }

  test("is written when the spawn resolves, and survives a plugin reload", async () => {
    const { host, again, cleanupAgain } = await spawnThenReload(first)
    expect(host.storage.get("spawn-model:c")).toMatchObject({ model: sonnetHigh, tier: "task" })
    expect(again.storage.get("spawn-model:c")).toEqual(host.storage.get("spawn-model:c"))
    expect(typeof (host.storage.get("spawn-model:c") as { configRevision: string }).configRevision).toBe("string")
    again.close()
    await cleanupAgain()
  })

  test("a resume after a tiers change keeps the snapshot's variant, and the receipt says so", async () => {
    const { host, again, cleanupAgain } = await spawnThenReload(changed)
    const snapshot = host.storage.get("spawn-model:c") as { configRevision: string }
    // A fresh spawn on the changed tiers resolves to a different variant ...
    expect((await again.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-2")).model).not.toBe(sonnetHigh)
    // ... but the resume stays on the snapshot's.
    const input = await again.spawn("subagent", resume, "build", "r", "call-3")
    expect(input).toEqual({ ...resume, model: sonnetHigh })
    const [receipt] = receipts(again)
    expect(receipt).toMatchObject({ rule: "snapshot", model: sonnetHigh, configRevision: snapshot.configRevision })
    expect(again.storage.get("spawn-model:c")).toEqual(snapshot)
    again.close()
    await cleanupAgain()
  })

  test("a tier on the resume reroutes and replaces the snapshot", async () => {
    const { again, cleanupAgain } = await spawnThenReload({ ...first, roles: { ...first.roles, smol: ["anthropic/claude-haiku"] } })
    const input = await again.spawn("subagent", { ...resume, tier: "smol" }, "build", "r", "call-2")
    expect(input).toEqual({ ...resume, model: "anthropic/claude-haiku" })
    expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", tier: "smol" })
    expect(receipts(again)[0]?.rule).not.toBe("snapshot")
    again.close()
    await cleanupAgain()
  })

  test("a model on the resume reroutes and replaces the snapshot", async () => {
    const { again, cleanupAgain } = await spawnThenReload(first)
    const input = await again.spawn("subagent", { ...resume, model: "opencode/flint" }, "build", "r", "call-2")
    expect(input).toEqual({ ...resume, model: "opencode/flint" })
    expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "opencode/flint" })
    expect((again.storage.get("spawn-model:c") as { tier?: string }).tier).toBeUndefined()
    again.close()
    await cleanupAgain()
  })

  test("a snapshot model that is no longer available falls back to normal resolution with a warning", async () => {
    const { again, cleanupAgain } = await spawnThenReload(first, models.filter((m) => m.id !== "claude-sonnet"))
    const input = await again.spawn("subagent", resume, "build", "r", "call-2")
    expect(input).toEqual(resume)
    const [receipt] = receipts(again)
    expect(receipt?.rule).not.toBe("snapshot")
    expect(receipt?.warnings[0]).toContain(`snapshot model ${sonnetHigh} is not usable (the model is unknown)`)
    again.close()
    await cleanupAgain()
  })

  test("failover updates the snapshot and marks it failed over; a resume continues on the model that worked", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: { ...first, flapCount: 1 } })
    host.sessions.set("r", { id: "r" })
    host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-1")
    host.emit({ type: "session.created", data: { sessionID: "c", parentID: "r", agent: "plain", model: sonnet } })
    await settle()
    expect((host.storage.get("spawn-model:c") as { failedOver?: true }).failedOver).toBeUndefined()
    host.emit({ type: "session.execution.failed", data: { sessionID: "c", error: { type: "api", message: "ThrottlingException", status: 429 } } })
    await settle()
    expect(methods(host, "switchModel")).toHaveLength(1)
    expect(host.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", tier: "task", failedOver: true })
    // The spawn's own completion does not undo it.
    await host.spawnDone(input, { sessionID: "c" }, "r", "call-1")
    expect(host.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", failedOver: true })
    expect((await host.spawn("subagent", resume, "build", "r", "call-2")).model).toBe("anthropic/claude-haiku")
    host.close()
    await cleanup()
  })


  describe("a context overflow of a snapshotted child", () => {
    const long = { type: "provider.invalid-request", message: "prompt is too long: 213462 tokens > 200000 maximum", status: 400 }
    const limited = [
      { ...models[0], limit: { context: 200_000 } },
      { ...models[1], limit: { context: 1_000_000 } },
      { ...models[2], limit: { context: 2_000_000 } },
    ] as Model[]
    // `aaa` lists the failed model first by name, so routing by "the first tier that lists it" would pick flint.
    const overlapping = {
      roles: { aaa: ["amazon-bedrock/claude-sonnet#high", "opencode/flint"], task: ["amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku"] },
      agents: { general: "task" },
    }
    const event = async (host: ReturnType<typeof createHost>) => {
      host.emit({ type: "session.execution.failed", data: { sessionID: "c", error: long } })
      await settle()
    }
    const tool = async (host: ReturnType<typeof createHost>) => {
      await host.spawnFailed({ agent: "plain", prompt: "x" }, `Subagent failed (sessionID: c): ${long.message}`, "r")
      await settle()
    }
    const reopen = async (from: ReturnType<typeof createHost>, nextModels: Model[], next: object) => {
      const host = createHost({ agents: [{ id: "plain" }], models: nextModels, options: next as never })
      for (const [key, value] of from.storage) host.storage.set(key, value)
      host.sessions.set("r", { id: "r" })
      return { host, cleanupHost: await setup(host) }
    }

    test.each([
      ["failure event", [event, tool], "the session now runs anthropic/claude-haiku (1000000 tokens)"],
      ["tool error", [tool, event], "model-roles moves it to anthropic/claude-haiku (1000000 tokens) when its failure is reported"],
    ] as const)("a resumed child with no pending spawn routes by its stored tier when the %s comes first", async (_name, order, wording) => {
      const { again, cleanupAgain } = await spawnThenReload(overlapping, limited)
      again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
      for (const step of order) await step(again)
      // Only the failure event switches; the parent hears once, and a tool error first only names the candidate of the child's tier.
      expect(methods(again, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: haiku }])
      const notes = methods(again, "synthetic").map((c) => c.input as { sessionID: string; text: string })
      expect(notes.map((n) => n.sessionID)).toEqual(["r"])
      expect(notes[0]?.text).toContain(wording)
      again.close()
      await cleanupAgain()
    })

    test("a delayed tool error of an earlier execution changes nothing; the next execution's overflow is still handled", async () => {
      const { again, cleanupAgain } = await spawnThenReload(three, limited)
      again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
      await started(again, "e1")
      await event(again)
      // e2 runs on haiku; e1's tool error reaches the parent late and names the session's current model.
      again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: haiku })
      await started(again, "e2")
      await tool(again)
      expect(methods(again, "switchModel")).toHaveLength(1)
      expect(methods(again, "synthetic")).toHaveLength(1)
      expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", overflowed: [sonnetHigh] })
      await event(again)
      expect(methods(again, "switchModel").map((c) => c.input)).toEqual([
        { sessionID: "c", model: haiku },
        { sessionID: "c", model: flint },
      ])
      expect(methods(again, "synthetic")).toHaveLength(2)
      expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "opencode/flint", overflowed: [sonnetHigh, "anthropic/claude-haiku"] })
      again.close()
      await cleanupAgain()
    })

    test("a tool error with no failure event notes once, switches nothing and records no overflow", async () => {
      const { again, cleanupAgain } = await spawnThenReload(first, limited)
      again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
      await tool(again)
      await tool(again)
      expect(methods(again, "switchModel")).toHaveLength(0)
      expect(methods(again, "synthetic")).toHaveLength(1)
      expect(again.storage.get("spawn-model:c")).not.toHaveProperty("overflowed")
      expect(again.storage.get("spawn-model:c")).not.toHaveProperty("failedOver")
      again.close()
      await cleanupAgain()
    })

    test("the switch is stored with the snapshot and the ledger, and a resume after a reload continues on the larger model", async () => {
      const { again, cleanupAgain } = await spawnThenReload(first, limited)
      again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
      await event(again)
      expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", tier: "task", failedOver: true, overflowed: [sonnetHigh] })
      expect(again.storage.get("outcome:c")).toMatchObject({ failedOver: true })
      again.close()
      await cleanupAgain()
      const { host, cleanupHost } = await reopen(again, limited, first)
      expect(await host.spawn("subagent", resume, "build", "r", "call-2")).toEqual({ ...resume, model: "anthropic/claude-haiku" })
      expect(methods(host, "switchModel")).toHaveLength(0)
      expect(receipts(host)[0]).toMatchObject({ rule: "snapshot", model: "anthropic/claude-haiku" })
      host.close()
      await cleanupHost()
    })

    const started = async (host: ReturnType<typeof createHost>, id: string) => {
      host.emit({ type: "session.execution.started", id, data: { sessionID: "c" } })
      await settle()
    }
    const three = { roles: { task: ["amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku", "opencode/flint"] }, agents: { general: "task" } }

    test("a resume that overflows the larger model too is switched and noted again, once per execution", async () => {
      const { again, cleanupAgain } = await spawnThenReload(three, limited)
      again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
      await started(again, "e1")
      await event(again)
      await again.spawn("subagent", resume, "build", "r", "call-2")
      again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: haiku })
      await started(again, "e2")
      await event(again)
      // The tool error of the same execution adds nothing.
      await tool(again)
      expect(methods(again, "switchModel").map((c) => c.input)).toEqual([
        { sessionID: "c", model: haiku },
        { sessionID: "c", model: flint },
      ])
      const texts = methods(again, "synthetic").map((c) => (c.input as { text: string }).text)
      expect(texts).toHaveLength(2)
      expect(texts[0]).toContain("the session now runs anthropic/claude-haiku (1000000 tokens)")
      expect(texts[1]).toContain("the session now runs opencode/flint (2000000 tokens)")
      expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "opencode/flint", overflowed: [sonnetHigh, "anthropic/claude-haiku"] })
      again.close()
      await cleanupAgain()
    })

    test("a guard reroute keeps the overflow history, so a later guard change never selects the overflowed model", async () => {
      const { again, cleanupAgain } = await spawnThenReload(three, limited)
      again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
      await event(again)
      again.close()
      await cleanupAgain()
      // The guard refuses haiku, where the child runs: it is rerouted past the overflowed sonnet, to flint.
      const second = await reopen(again, limited, { ...three, guard: { expensive: ["anthropic/claude-haiku"] } })
      await second.host.spawn("subagent", resume, "build", "r", "call-2")
      await settle()
      expect(methods(second.host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: flint }])
      expect(second.host.storage.get("spawn-model:c")).toMatchObject({ model: "opencode/flint", rule: "guard-reroute", overflowed: [sonnetHigh] })
      second.host.close()
      await second.cleanupHost()
      // Now flint is refused and haiku allowed: the reroute goes to haiku, not back to sonnet.
      const third = await reopen(second.host, limited, { ...three, guard: { expensive: ["opencode/flint"] } })
      await third.host.spawn("subagent", resume, "build", "r", "call-3")
      expect(methods(third.host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: haiku }])
      third.host.close()
      await third.cleanupHost()
    })

    describe("a model the user chose is never switched", () => {
      const tiered = { roles: { task: [sonnetHigh, "anthropic/claude-haiku"] }, agents: { plain: "task" } }
      const pinnedNote = `context too long for ${sonnetHigh} (200000 tokens); ${sonnetHigh} was chosen explicitly, so model-roles does not switch it. Compact the session, or spawn with a larger-context model.`
      const overflowOf = async (agents: Array<{ id: string; model?: ModelRef }>, input: Record<string, unknown>) => {
        const host = createHost({ agents, models: limited, options: tiered as never })
        host.sessions.set("r", { id: "r" })
        host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
        const cleanup = await setup(host)
        const spawned = await host.spawn("subagent", { agent: "plain", prompt: "x", ...input }, "build", "r", "call-1")
        host.emit({ type: "session.created", data: { sessionID: "c", parentID: "r", agent: "plain", model: sonnet } })
        await settle()
        await host.spawnDone(spawned, { sessionID: "c" }, "r", "call-1")
        host.emit({ type: "session.execution.failed", data: { sessionID: "c", error: long } })
        await settle()
        return { host, cleanup }
      }
      const noted = (host: ReturnType<typeof createHost>) => methods(host, "synthetic").map((c) => (c.input as { text: string }).text)

      test.each([
        ["an explicit spawn model", [{ id: "plain" }], { model: sonnetHigh }],
        ["an agent pin", [{ id: "plain", model: sonnet }], {}],
      ])("a child on %s gets the note and no switch", async (_name, agents, input) => {
        const { host, cleanup } = await overflowOf(agents, input)
        expect(methods(host, "switchModel")).toHaveLength(0)
        expect(noted(host)).toEqual([pinnedNote])
        host.close()
        await cleanup()
      })

      test("a tier-routed child of the same agent is still switched", async () => {
        const { host, cleanup } = await overflowOf([{ id: "plain" }], { tier: "task" })
        expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: haiku }])
        host.close()
        await cleanup()
      })
    })

    describe("with the guard on", () => {
      const priced = [
        { providerID: "amazon-bedrock", id: "claude-opus", variants: [], cost: [{ input: 12 }], limit: { context: 2_000_000 } },
        { providerID: "amazon-bedrock", id: "claude-sonnet", variants: [{ id: "high" }], cost: [{ input: 2 }], limit: { context: 200_000 } },
        { providerID: "anthropic", id: "claude-haiku", variants: [], cost: [{ input: 0.1 }], limit: { context: 1_000_000 } },
      ] as Model[]
      const guarded = (expensive: string[]) => ({ ...first, roles: { task: ["amazon-bedrock/claude-sonnet#high", "amazon-bedrock/claude-opus", "anthropic/claude-haiku"] }, guard: { expensive } })

      test("a guarded larger-context candidate is skipped for the next allowed one", async () => {
        const host = createHost({ agents: [{ id: "plain" }], models: priced, options: guarded(["amazon-bedrock/claude-opus"]) as never })
        host.sessions.set("r", { id: "r" })
        host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
        const cleanup = await setup(host)
        const input = await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-1")
        created(host, "c", "plain", sonnet)
        await settle()
        await host.spawnDone(input, { sessionID: "c" }, "r", "call-1")
        await event(host)
        expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: haiku }])
        host.close()
        await cleanup()
      })

      describe("when another variant of the tier's own model is the larger candidate", () => {
        // Every gem variant is guarded, but tier task resolves to gem#low: the old pin exemption let any gem variant through.
        const variants = [
          { providerID: "amazon-bedrock", id: "gem", variants: [{ id: "low" }, { id: "high" }], cost: [{ input: 2 }], limit: { context: 1_000_000 } },
          { providerID: "amazon-bedrock", id: "small", variants: [], cost: [{ input: 0.1 }], limit: { context: 200_000 } },
          { providerID: "anthropic", id: "big", variants: [], cost: [{ input: 0.2 }], limit: { context: 2_000_000 } },
        ] as Model[]
        const small = { providerID: "amazon-bedrock", id: "small" }
        const big = { providerID: "anthropic", id: "big" }
        const run = async (task: string[]) => {
          const options = { roles: { task }, agents: { plain: "task" }, guard: { expensive: ["amazon-bedrock/gem"] } }
          const host = createHost({ agents: [{ id: "plain" }], models: variants, options: options as never })
          host.sessions.set("r", { id: "r" })
          host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: small })
          const cleanup = await setup(host)
          const input = await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-1")
          created(host, "c", "plain", small)
          await settle()
          await host.spawnDone(input, { sessionID: "c" }, "r", "call-1")
          await event(host)
          return { host, cleanup }
        }

        test("the guard-refused variant is skipped for the next allowed larger candidate", async () => {
          const { host, cleanup } = await run(["amazon-bedrock/gem#low", "amazon-bedrock/gem#high", "amazon-bedrock/small", "anthropic/big"])
          expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: big }])
          host.close()
          await cleanup()
        })

        test("with no other allowed larger candidate the child is not switched and the note names none", async () => {
          const { host, cleanup } = await run(["amazon-bedrock/gem#low", "amazon-bedrock/gem#high", "amazon-bedrock/small"])
          expect(methods(host, "switchModel")).toHaveLength(0)
          const notes = methods(host, "synthetic").map((c) => c.input as { text: string })
          expect(notes).toHaveLength(1)
          expect(notes[0]?.text).not.toContain("gem#high")
          host.close()
          await cleanup()
        })
      })

      test("a resume never goes back to the model that overflowed, even when the larger one is refused later", async () => {
        const { again, cleanupAgain } = await spawnThenReload(first, limited)
        again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
        await event(again)
        again.close()
        await cleanupAgain()
        // The guard now refuses haiku, where the child runs; sonnet is allowed but overflowed.
        const { host, cleanupHost } = await reopen(again, limited, { ...first, guard: { expensive: ["anthropic/claude-haiku"] } })
        await expect(host.spawn("subagent", resume, "build", "r", "call-2")).rejects.toThrow(
          /resume would run on anthropic\/claude-haiku, which the guard refuses\. The only allowed candidate, amazon-bedrock\/claude-sonnet#high \(200000 tokens\), already overflowed its context; compact the session or start a new one\./,
        )
        expect(methods(host, "switchModel")).toHaveLength(0)
        host.close()
        await cleanupHost()
      })
    })
  })

  test("a failover is visible to a resume at once, even when the stored snapshot is slow to read and write", async () => {
    const { again, cleanupAgain } = await spawnThenReload(first)
    again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
    // The stored snapshot (still the old model) is slow to read, and writes never land during the test.
    const { get, set } = again.context.storage
    again.context.storage.get = async (key: string) => {
      if (key.startsWith("spawn-model:")) await new Promise((r) => setTimeout(r, 150))
      return get(key)
    }
    again.context.storage.set = async (key: string, value: unknown) => {
      if (key.startsWith("spawn-model:")) await new Promise((r) => setTimeout(r, 400))
      return set(key, value)
    }
    const auth = { type: "provider.auth", message: "Unauthorized", status: 401 }
    expect(await again.fireRetry({ sessionID: "c", agent: "plain", model: sonnet, error: auth, attempt: 2 })).toEqual({ retry: true, delay: 0 })
    expect(methods(again, "switchModel")).toHaveLength(1)
    expect((await again.spawn("subagent", resume, "build", "r", "call-2")).model).toBe("anthropic/claude-haiku")
    again.close()
    await cleanupAgain()
  })

  const slowSnapshotStorage = (host: ReturnType<typeof createHost>, readMs: number, writeMs: number) => {
    const { get, set } = host.context.storage
    host.context.storage.get = async (key: string) => {
      if (key.startsWith("spawn-model:")) await new Promise((r) => setTimeout(r, readMs))
      return get(key)
    }
    host.context.storage.set = async (key: string, value: unknown) => {
      if (key.startsWith("spawn-model:")) await new Promise((r) => setTimeout(r, writeMs))
      return set(key, value)
    }
  }
  const auth = { type: "provider.auth", message: "Unauthorized", status: 401 }

  test("a reloaded child with no stored spawn tier is also on its new model at once", async () => {
    const { again, cleanupAgain } = await spawnThenReload({ ...first, agents: { ...first.agents, plain: "task" } })
    again.storage.delete("spawn-role:c")
    again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
    slowSnapshotStorage(again, 150, 400)
    expect(await again.fireRetry({ sessionID: "c", agent: "plain", model: sonnet, error: auth, attempt: 2 })).toEqual({ retry: true, delay: 0 })
    expect(methods(again, "switchModel")).toHaveLength(1)
    expect((await again.spawn("subagent", resume, "build", "r", "call-2")).model).toBe("anthropic/claude-haiku")
    again.close()
    await cleanupAgain()
  })

  test("shutdown waits for the failover snapshot write, so a reload keeps the new model", async () => {
    const { again, cleanupAgain } = await spawnThenReload(first)
    again.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: sonnet })
    slowSnapshotStorage(again, 0, 150)
    await again.fireRetry({ sessionID: "c", agent: "plain", model: sonnet, error: auth, attempt: 2 })
    again.close()
    await cleanupAgain()
    expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", failedOver: true })
  })

  test("memory drops snapshots older than the storage limit when a child ends, and reads storage again", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: first })
    host.sessions.set("r", { id: "r" })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-1")
    host.emit({ type: "session.created", data: { sessionID: "c", parentID: "r", agent: "plain", model: sonnet } })
    await settle()
    await host.spawnDone(input, { sessionID: "c" }, "r", "call-1")
    host.storage.set("spawn-model:c", { ...(host.storage.get("spawn-model:c") as object), model: "opencode/flint" })
    // Still in memory: the resume uses the memory snapshot, not the changed storage.
    expect((await host.spawn("subagent", resume, "build", "r", "call-2")).model).toBe(sonnetHigh)
    setSystemTime(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))
    try {
      host.emit({ type: "session.execution.succeeded", data: { sessionID: "other" } })
      await settle()
      expect((await host.spawn("subagent", resume, "build", "r", "call-3")).model).toBe("opencode/flint")
    } finally {
      setSystemTime()
    }
    host.close()
    await cleanup()
  })

  test("a call that completes while the child's snapshot is being written still leaves its ledger record", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: first })
    host.sessions.set("r", { id: "r" })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-1")
    const set = host.context.storage.set
    let release: () => void = () => {}
    const slow = new Promise<void>((resolve) => {
      release = resolve
    })
    host.context.storage.set = async (key: string, value: unknown) => {
      if (key.startsWith("spawn-model:")) await slow
      return set(key, value)
    }
    host.emit({ type: "session.created", data: { sessionID: "c", parentID: "r", agent: "plain", model: sonnet } })
    await settle()
    await host.spawnDone(input, { sessionID: "c" }, "r", "call-1") // drops the pending spawn while the snapshot write waits
    release()
    await settle()
    expect(host.storage.get("outcome:c")).toMatchObject({ agent: "plain", source: "tier-param", parentID: "r" })
    expect(host.storage.get("spawn-role:c")).toBe("task")
    host.close()
    await cleanup()
  })

  const created = (host: ReturnType<typeof createHost>, sessionID: string, agent: string, model: ModelRef) =>
    host.emit({ type: "session.created", data: { sessionID, parentID: "r", agent, model } })

  test("concurrent spawns of one agent on different variants each snapshot their own, created out of order", async () => {
    const two: Model[] = [{ providerID: "amazon-bedrock", id: "claude-sonnet", variants: [{ id: "high" }, { id: "low" }] }, ...models.slice(1)]
    const host = createHost({
      agents: [{ id: "plain" }],
      models: two,
      options: { roles: { hi: ["amazon-bedrock/claude-sonnet#high"], lo: ["amazon-bedrock/claude-sonnet#low"] }, agents: {} },
    })
    host.sessions.set("r", { id: "r" })
    const cleanup = await setup(host)
    const one = await host.spawn("subagent", { agent: "plain", prompt: "a", tier: "hi" }, "build", "r", "call-1")
    const other = await host.spawn("subagent", { agent: "plain", prompt: "b", tier: "lo" }, "build", "r", "call-2")
    created(host, "c2", "plain", { providerID: "amazon-bedrock", id: "claude-sonnet", variant: "low" })
    created(host, "c1", "plain", { providerID: "amazon-bedrock", id: "claude-sonnet", variant: "high" })
    await settle()
    await host.spawnDone(one, { sessionID: "c1" }, "r", "call-1")
    await host.spawnDone(other, { sessionID: "c2" }, "r", "call-2")
    expect(host.storage.get("spawn-model:c1")).toMatchObject({ model: "amazon-bedrock/claude-sonnet#high", tier: "hi" })
    expect(host.storage.get("spawn-model:c2")).toMatchObject({ model: "amazon-bedrock/claude-sonnet#low", tier: "lo" })
    expect(host.storage.get("spawn-role:c1")).toBe("hi")
    expect(host.storage.get("spawn-role:c2")).toBe("lo")
    host.close()
    await cleanup()
  })

  test("the snapshot holds the model the child was created with, not the one planned", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: first })
    host.sessions.set("r", { id: "r" })
    const cleanup = await setup(host)
    await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-1")
    created(host, "c", "plain", haiku)
    await settle()
    expect(host.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", tier: "task" })
    host.close()
    await cleanup()
  })

  describe("every spawn path leaves a snapshot", () => {
    const paths: Array<[string, Record<string, unknown>, ModelRef, string, string | undefined]> = [
      ["a tier", { tier: "task" }, sonnet, sonnetHigh, "task"],
      ["an explicit model", { model: "anthropic/claude-haiku" }, haiku, "anthropic/claude-haiku", undefined],
      ["the agent's own tier", {}, sonnet, sonnetHigh, "task"],
      ["no tier, the host decides", {}, flint, "opencode/flint", undefined],
    ]
    for (const [name, extra, actual, label, tier] of paths) {
      test(name, async () => {
        const agent = name === "the agent's own tier" ? "general" : "plain"
        const host = createHost({ agents: [{ id: "general" }, { id: "plain" }], models, options: first })
        host.sessions.set("r", { id: "r" })
        const cleanup = await setup(host)
        const input = await host.spawn("subagent", { agent, prompt: "x", ...extra }, "build", "r", "call-1")
        created(host, "c", agent, actual)
        await settle()
        await host.spawnDone(input, { sessionID: "c" }, "r", "call-1")
        const snapshot = host.storage.get("spawn-model:c") as { model: string; tier?: string; configRevision: string }
        expect(snapshot.model).toBe(label)
        expect(snapshot.tier).toBe(tier)
        expect(snapshot.configRevision).toMatch(/^[0-9a-f]{8}$/)
        host.close()
        await cleanup()
      })
    }

    test("without a creation event, the completed call falls back to the child's session model", async () => {
      const host = createHost({ agents: [{ id: "plain" }], models, options: first })
      host.sessions.set("r", { id: "r" })
      host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: haiku })
      const cleanup = await setup(host)
      const input = await host.spawn("subagent", { agent: "plain", prompt: "x" }, "build", "r", "call-1")
      await host.spawnDone(input, { sessionID: "c" }, "r", "call-1")
      expect(host.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku" })
      host.close()
      await cleanup()
    })
  })

  describe("the guard on a resumed child", () => {
    const priced: Model[] = [
      { providerID: "amazon-bedrock", id: "claude-opus", variants: [], cost: [{ input: 12 }] },
      { providerID: "amazon-bedrock", id: "claude-sonnet", variants: [{ id: "high" }], cost: [{ input: 2 }] },
      { providerID: "anthropic", id: "claude-haiku", variants: [], cost: [{ input: 0.1 }] },
    ]
    const opus = { providerID: "amazon-bedrock", id: "claude-opus" }
    const opusOptions = (task: string[]) => ({ roles: { task }, agents: { general: "task" } })

    /** A child spawned on the tier's first model while the guard was off, then resumed with the guard on. */
    const guardedReload = async (task: string[], guard: unknown = true, extra: object = {}) => {
      const host = createHost({ agents: [{ id: "plain" }], models: priced, options: opusOptions(task) })
      host.sessions.set("r", { id: "r" })
      const cleanup = await setup(host)
      const input = await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-1")
      created(host, "c", "plain", opus)
      await settle()
      await host.spawnDone(input, { sessionID: "c" }, "r", "call-1")
      host.close()
      await cleanup()
      const again = createHost({ agents: [{ id: "plain" }], models: priced, options: { ...opusOptions(task), guard, ...extra } as never })
      for (const [key, value] of host.storage) again.storage.set(key, value)
      again.sessions.set("r", { id: "r" })
      return { again, cleanupAgain: await setup(again) }
    }

    test("a resumed child on a now-guarded model is switched to the tier's first allowed candidate, and the receipt warns", async () => {
      const { again, cleanupAgain } = await guardedReload(["amazon-bedrock/claude-opus", "amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku"])
      const input = await again.spawn("subagent", resume, "build", "r", "call-2")
      expect(methods(again, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: { providerID: "amazon-bedrock", id: "claude-sonnet", variant: "high" } }])
      expect(input).toEqual({ ...resume, model: sonnetHigh })
      const [receipt] = receipts(again)
      expect(receipt).toMatchObject({ rule: "guard-reroute", model: sonnetHigh })
      expect(receipt?.warnings[0]).toContain("amazon-bedrock/claude-opus is refused by the guard; switched to amazon-bedrock/claude-sonnet#high (tier task)")
      again.close()
      await cleanupAgain()
    })

    test("the switch updates the snapshot with the guard-reroute rule and stores it", async () => {
      const { again, cleanupAgain } = await guardedReload(["amazon-bedrock/claude-opus", "anthropic/claude-haiku"])
      await again.spawn("subagent", resume, "build", "r", "call-2")
      await settle()
      expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", tier: "task", rule: "guard-reroute" })
      // The next resume reuses the new model without another switch.
      expect((await again.spawn("subagent", resume, "build", "r", "call-3")).model).toBe("anthropic/claude-haiku")
      expect(methods(again, "switchModel")).toHaveLength(1)
      again.close()
      await cleanupAgain()
    })

    test("a tier with no candidate the guard accepts refuses the resume, naming the model and the tier", async () => {
      const { again, cleanupAgain } = await guardedReload(["amazon-bedrock/claude-opus"])
      await expect(again.spawn("subagent", resume, "build", "r", "call-2")).rejects.toThrow(/resume would run on amazon-bedrock\/claude-opus.*no candidate of tier 'task'/s)
      expect(methods(again, "switchModel")).toHaveLength(0)
      again.close()
      await cleanupAgain()
    })

    test("a guard-refused resume is not marked running: the child's outcome record is unchanged", async () => {
      const { again, cleanupAgain } = await guardedReload(["amazon-bedrock/claude-opus"])
      const before = structuredClone(again.storage.get("outcome:c"))
      expect(before).toMatchObject({ agent: "plain" })
      await expect(again.spawn("subagent", resume, "build", "r", "call-2")).rejects.toThrow(/resume would run on/)
      await settle()
      expect(again.storage.get("outcome:c")).toEqual(before)
      again.close()
      await cleanupAgain()
    })

    test("a model the guard still allows resumes unchanged", async () => {
      const { again, cleanupAgain } = await guardedReload(["amazon-bedrock/claude-opus", "anthropic/claude-haiku"], { allowModels: ["amazon-bedrock/claude-opus"] })
      expect(await again.spawn("subagent", resume, "build", "r", "call-2")).toEqual({ ...resume, model: "amazon-bedrock/claude-opus" })
      expect(methods(again, "switchModel")).toHaveLength(0)
      expect(receipts(again)[0]?.rule).toBe("snapshot")
      again.close()
      await cleanupAgain()
    })

    test("an explicit model on the resume that the guard refuses is refused", async () => {
      const { again, cleanupAgain } = await guardedReload(["amazon-bedrock/claude-sonnet#high"])
      await expect(again.spawn("subagent", { ...resume, model: "amazon-bedrock/claude-opus" }, "build", "r", "call-2")).rejects.toThrow(/sets model amazon-bedrock\/claude-opus itself/)
      expect(methods(again, "switchModel")).toHaveLength(0)
      again.close()
      await cleanupAgain()
    })

    const failing = (again: ReturnType<typeof createHost>, how: "reject" | "hang") => {
      let land: (() => void) | undefined
      again.context.session.switchModel = (payload: unknown) => {
        again.calls.push({ method: "switchModel", input: payload })
        if (how === "reject") return Promise.reject(new Error("host refused"))
        return new Promise<undefined>((resolve) => {
          land = () => resolve(undefined)
        })
      }
      return () => land?.()
    }
    const tiers = ["amazon-bedrock/claude-opus", "anthropic/claude-haiku"]

    test("a guard switch the host rejects refuses the resume and keeps the old snapshot", async () => {
      const { again, cleanupAgain } = await guardedReload(tiers)
      failing(again, "reject")
      await expect(again.spawn("subagent", resume, "build", "r", "call-2")).rejects.toThrow(/did not complete \(failed\)/)
      await settle()
      expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "amazon-bedrock/claude-opus" })
      expect(again.storage.get("spawn-model:c")).not.toHaveProperty("rule")
      again.close()
      await cleanupAgain()
    })

    test("a guard switch that times out refuses the resume", async () => {
      const { again, cleanupAgain } = await guardedReload(tiers, true, { switchTimeoutMs: 20 })
      failing(again, "hang")
      await expect(again.spawn("subagent", resume, "build", "r", "call-2")).rejects.toThrow(/did not complete \(late\)/)
      again.close()
      await cleanupAgain()
    })

    test("a guard switch that lands after the timeout still persists the snapshot as guard-reroute", async () => {
      const { again, cleanupAgain } = await guardedReload(tiers, true, { switchTimeoutMs: 20 })
      const land = failing(again, "hang")
      await expect(again.spawn("subagent", resume, "build", "r", "call-2")).rejects.toThrow(/\(late\)/)
      expect(again.storage.get("spawn-model:c")).not.toHaveProperty("rule")
      land()
      await settle()
      expect(again.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", tier: "task", rule: "guard-reroute" })
      again.close()
      await cleanupAgain()
    })

    describe("a child with no snapshot", () => {
      /** Child `c` was never snapshotted; its session says which model it runs on. */
      const unsnapshotted = async (task: string[], session: Record<string, unknown> | undefined, spawnRole = "task") => {
        const host = createHost({ agents: [{ id: "plain" }], models: priced, options: { ...opusOptions(task), guard: true } as never })
        host.sessions.set("r", { id: "r" })
        if (session !== undefined) host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", ...session })
        host.storage.set("spawn-role:c", spawnRole)
        return { host, cleanup: await setup(host) }
      }

      test("a known allowed model resumes unchanged and gets a fresh snapshot", async () => {
        const { host, cleanup } = await unsnapshotted(tiers, { model: { providerID: "anthropic", id: "claude-haiku" } })
        expect(await host.spawn("subagent", resume, "build", "r", "call-2")).toEqual({ ...resume, model: "anthropic/claude-haiku" })
        await settle()
        expect(methods(host, "switchModel")).toHaveLength(0)
        expect(host.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", tier: "task" })
        host.close()
        await cleanup()
      })

      test("a known guarded model is switched to the tier's allowed candidate and snapshotted as guard-reroute", async () => {
        const { host, cleanup } = await unsnapshotted(tiers, { model: opus })
        const input = await host.spawn("subagent", resume, "build", "r", "call-2")
        expect(methods(host, "switchModel").map((c) => c.input)).toEqual([{ sessionID: "c", model: { providerID: "anthropic", id: "claude-haiku" } }])
        expect(input).toEqual({ ...resume, model: "anthropic/claude-haiku" })
        await settle()
        expect(host.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", rule: "guard-reroute" })
        expect(receipts(host)[0]).toMatchObject({ rule: "guard-reroute" })
        host.close()
        await cleanup()
      })

      test("a known guarded model with no allowed candidate refuses the resume", async () => {
        const { host, cleanup } = await unsnapshotted(["amazon-bedrock/claude-opus"], { model: opus })
        await expect(host.spawn("subagent", resume, "build", "r", "call-2")).rejects.toThrow(/no candidate of tier 'task'/)
        expect(methods(host, "switchModel")).toHaveLength(0)
        host.close()
        await cleanup()
      })

      test("a child lookup that never settles is bounded: the resume proceeds, a reload completes, and a late answer writes nothing", async () => {
        const { host, cleanup } = await unsnapshotted(tiers, { model: opus })
        let answer: (session: unknown) => void = () => {}
        host.setSessionGet((id) => (id === "c" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve({ id })))
        jest.useFakeTimers()
        try {
          const resumed = host.spawn("subagent", resume, "build", "r", "call-2")
          const flush = async () => {
            for (let i = 0; i < 20; i++) await Promise.resolve()
          }
          await flush()
          host.emit({ type: "config.updated", data: {} })
          await flush()
          jest.advanceTimersByTime(CHILD_LOOKUP_MS)
          expect(await resumed).toEqual(resume)
          await flush()
          // The reload that waited on the resume is done: a spawn no longer waits on it.
          await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-3")
          expect(receipts(host).some((r) => r.warnings.includes("model unknown; guard not applied"))).toBe(true)
          answer({ id: "c", parentID: "r", agent: "plain", model: opus })
          await flush()
        } finally {
          jest.useRealTimers()
        }
        await settle()
        expect(host.storage.get("spawn-model:c")).toBeUndefined()
        expect(methods(host, "switchModel")).toHaveLength(0)
        host.close()
        await cleanup()
      })

      test("an unknown model resumes with an explicit warning that the guard was not applied", async () => {
        const { host, cleanup } = await unsnapshotted(tiers, undefined)
        expect(await host.spawn("subagent", resume, "build", "r", "call-2")).toEqual(resume)
        expect(receipts(host)[0]?.warnings).toEqual(["model unknown; guard not applied"])
        expect(methods(host, "switchModel")).toHaveLength(0)
        host.close()
        await cleanup()
      })
    })
  })

  test("a switch that lands after the timeout still updates the snapshot", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: { ...first, switchTimeoutMs: 20 } })
    host.sessions.set("r", { id: "r" })
    let land: (() => void) | undefined
    host.context.session.switchModel = (payload: unknown) => {
      host.calls.push({ method: "switchModel", input: payload })
      return new Promise<undefined>((resolve) => {
        land = () => resolve(undefined)
      })
    }
    const cleanup = await setup(host)
    await host.spawn("subagent", { agent: "plain", prompt: "x", tier: "task" }, "build", "r", "call-1")
    created(host, "c", "plain", sonnet)
    await settle()
    const auth = { type: "provider.auth", message: "Unauthorized", status: 401 }
    await host.fireRetry({ sessionID: "c", agent: "plain", model: sonnet, error: auth, attempt: 2 })
    expect(methods(host, "switchModel")).toHaveLength(1)
    expect((host.storage.get("spawn-model:c") as { failedOver?: true }).failedOver).toBeUndefined()
    land?.()
    await settle()
    expect(host.storage.get("spawn-model:c")).toMatchObject({ model: "anthropic/claude-haiku", tier: "task", failedOver: true })
    host.close()
    await cleanup()
  })

  test("model_roles_check shows a resume that reused its snapshot, with the config revision", async () => {
    const { host, again, cleanupAgain } = await spawnThenReload(first)
    const snapshot = host.storage.get("spawn-model:c") as { configRevision: string }
    await again.spawn("subagent", resume, "build", "r", "call-2")
    const check = (await again.tools.get("model_roles_check")?.execute({}))?.content ?? ""
    expect(check).toContain(`plain: tier task (agent tier) → ${sonnetHigh} by the child's snapshot (config ${snapshot.configRevision})`)
    again.close()
    await cleanupAgain()
  })

  test("a model on the resume also clears the child's spawn role, so a retry cannot go back to the old tier", async () => {
    const { again, cleanupAgain } = await spawnThenReload(first)
    expect(again.storage.get("spawn-role:c")).toBe("task")
    await again.spawn("subagent", { ...resume, model: "opencode/flint" }, "build", "r", "call-2")
    expect(again.storage.has("spawn-role:c")).toBe(false)
    again.close()
    await cleanupAgain()
  })

  test("a restart keeps the snapshot of a child that never ended and prunes ended and old ones", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: first })
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000
    const entry = { model: sonnetHigh, configRevision: "x", at: old }
    const outcome = (extra: Record<string, unknown>) => ({ at: old, agent: "plain", model: sonnetHigh, parentID: "r", resumes: 0, steps: 0, ms: 0, ...extra })
    for (const id of ["open", "ended", "orphan"]) host.storage.set(`spawn-model:${id}`, entry)
    host.storage.set("outcome:open", outcome({}))
    host.storage.set("outcome:ended", outcome({ outcome: "succeeded" }))
    const cleanup = await setup(host)
    const kept = [...host.storage.keys()].filter((key) => key.startsWith("spawn-model:"))
    expect(kept).toEqual(["spawn-model:open"])
    host.close()
    await cleanup()
  })

  test("setup prunes expired and surplus snapshots", async () => {
    const host = createHost({ agents: [{ id: "plain" }], models, options: first })
    const now = Date.now()
    const entry = (at: number) => ({ model: sonnetHigh, configRevision: "x", at })
    host.storage.set("spawn-model:old", entry(now - 31 * 24 * 60 * 60 * 1000))
    host.storage.set("spawn-model:junk", "nope")
    host.storage.set("spawn-model:fresh", entry(now - 1000))
    for (let i = 0; i < 1000; i++) host.storage.set(`spawn-model:n${i}`, entry(now - 2000 - i))
    const cleanup = await setup(host)
    const kept = [...host.storage.keys()].filter((key) => key.startsWith("spawn-model:"))
    expect(kept).toHaveLength(1000)
    expect(kept).toContain("spawn-model:fresh")
    expect(kept).not.toContain("spawn-model:old")
    expect(kept).not.toContain("spawn-model:junk")
    expect(kept).not.toContain("spawn-model:n999")
    host.close()
    await cleanup()
  })
})

describe("exploration inside a tier", () => {
  const sonnetModel = { providerID: "amazon-bedrock", id: "claude-sonnet" }
  const ref = (variant: string): ModelRef => ({ ...sonnetModel, variant })
  const tierModels: Model[] = [{ ...sonnetModel, variants: [{ id: "low" }, { id: "medium" }, { id: "high" }] }, models[1] as Model]
  const base = { roles: { task: ["amazon-bedrock/claude-sonnet#medium", "anthropic/claude-haiku"] }, agents: { coder: "task", plain: "task" } }
  const on = { agents: ["plain", "coder"], explore: 0.1 }
  const label = (variant: string) => `amazon-bedrock/claude-sonnet#${variant}`
  const haikuLabel = "anthropic/claude-haiku"
  const receipts = (host: ReturnType<typeof createHost>) => host.storage.get("receipts") as Array<Record<string, unknown>>
  const spawnTier = (host: ReturnType<typeof createHost>, id = "call-1", agent = "plain") => host.spawn("subagent", { agent, prompt: "x", tier: "task" }, "build", "r", id)
  const born = async (host: ReturnType<typeof createHost>, model: ModelRef, agent = "plain") => {
    host.emit({ type: "session.created", data: { sessionID: "c", parentID: "r", agent, model } })
    await settle()
  }

  /** Run `body` on a host with exploration `evaluate` and an injected draw. */
  const withHost = async (
    evaluate: unknown,
    draw: number,
    body: (host: ReturnType<typeof createHost>) => Promise<void>,
    extra: Record<string, unknown> = {},
    storage: Map<string, unknown> = new Map(),
  ) => {
    setExploreRandom(() => draw)
    const host = createHost({ agents: [{ id: "plain" }, { id: "coder" }], models: tierModels, options: { ...base, ...extra, ...(evaluate === undefined ? {} : { evaluate }) } })
    for (const [key, value] of storage) host.storage.set(key, value)
    host.sessions.set("r", { id: "r" })
    const cleanup = await setup(host)
    try {
      await body(host)
    } finally {
      host.close()
      await cleanup()
      setExploreRandom(undefined)
    }
  }

  /** Everything observable from a fixed set of spawns, with the clock pinned. */
  const trace = async (evaluate: unknown) => {
    setSystemTime(new Date(1_800_000_000_000))
    try {
      let result: { inputs: unknown[]; storage: [string, unknown][]; calls: unknown[] } | undefined
      await withHost(evaluate, 0, async (host) => {
        const inputs: unknown[] = []
        inputs.push(await spawnTier(host, "call-1", "plain"))
        await born(host, ref("medium"))
        inputs.push(await host.spawn("subagent", { agent: "coder", prompt: "own tier" }, "build", "r", "call-2"))
        inputs.push(await host.spawn("subagent", { agent: "plain", prompt: "x", model: haikuLabel }, "build", "r", "call-3"))
        inputs.push(await host.spawn("subagent", { agent: "plain", prompt: "again", sessionID: "c" }, "build", "r", "call-4"))
        await settle()
        result = { inputs, storage: [...host.storage].sort(([a], [b]) => (a < b ? -1 : 1)), calls: structuredClone(host.calls) }
      })
      return result
    } finally {
      setSystemTime()
    }
  }

  test.each([
    ["an empty agent list", { agents: [], explore: 0.1 }],
    ["explore 0", { agents: ["plain", "coder"], explore: 0 }],
    ["agents that never match", { agents: ["other"], explore: 0.1 }],
  ])("with %s, receipts, model arguments, storage and host calls equal a run without evaluate", async (_name, evaluate) => {
    const plain = await trace(undefined)
    expect(plain?.inputs).toHaveLength(4)
    expect(await trace(evaluate)).toEqual(plain)
  })

  test("an exploring tier spawn runs on the arm, with the receipt rule kept and the facts in the ledger and snapshot", async () => {
    await withHost(on, 0, async (host) => {
      const input = await spawnTier(host)
      // The first alternative is the control model one step up.
      expect(input.model).toBe(label("high"))
      await born(host, ref("high"))
      const facts = { policy: "explore-v1", eligible: [label("medium"), label("high"), label("low"), haikuLabel], arm: label("high"), p: 0.1 / 3 }
      expect(host.storage.get("outcome:c")).toMatchObject(facts)
      expect(host.storage.get("spawn-model:c")).toMatchObject({ model: label("high"), tier: "task", explore: facts })
      expect(receipts(host)[0]).toMatchObject({ model: label("high"), explore: label("high"), source: "tier-param", tier: "standard", rule: "candidate-variant" })
      expect((await host.tools.get("model_roles_check")?.execute({}))?.content).toContain("exploration: on for plain, coder, ε=0.1")
    })
  })

  test("a draw above ε keeps the control and logs p of the control", async () => {
    await withHost(on, 0.5, async (host) => {
      expect((await spawnTier(host)).model).toBe(label("medium"))
      await born(host, ref("medium"))
      expect(host.storage.get("outcome:c")).toMatchObject({ policy: "explore-v1", arm: label("medium"), p: 0.9 })
      expect(receipts(host)[0]).not.toHaveProperty("explore")
    })
  })

  test("after a reload, a failover rewrites the stored snapshot and every exploration fact survives", async () => {
    let kept = new Map<string, unknown>()
    await withHost(on, 0, async (host) => {
      await spawnTier(host)
      await born(host, ref("high"))
      kept = new Map(host.storage)
    })
    const facts = { policy: "explore-v1", eligible: [label("medium"), label("high"), label("low"), haikuLabel], arm: label("high"), p: 0.1 / 3 }
    expect(kept.get("spawn-model:c")).toMatchObject({ explore: facts })
    await withHost(
      on,
      0.5,
      async (host) => {
        host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: ref("high") })
        host.emit({ type: "session.execution.failed", data: { sessionID: "c", error: { type: "api", message: "ThrottlingException", status: 429 } } })
        await settle()
        // The failover moved the child off the arm and rewrote the snapshot; the facts stayed.
        expect(host.storage.get("spawn-model:c")).toMatchObject({ model: haikuLabel, failedOver: true, tier: "task", explore: facts })
      },
      { flapCount: 1 },
      kept,
    )
  })

  test("a context-overflow switch of an explored child ends its arm: the ledger and snapshot say it failed over, the facts stay", async () => {
    setExploreRandom(() => 0)
    const wideModels = tierModels.map((m, i) => ({ ...m, limit: { context: i === 0 ? 200_000 : 1_000_000 } })) as Model[]
    const host = createHost({ agents: [{ id: "plain" }], models: wideModels, options: { ...base, evaluate: on } })
    host.sessions.set("r", { id: "r" })
    host.sessions.set("c", { id: "c", parentID: "r", agent: "plain", model: ref("high") })
    const cleanup = await setup(host)
    try {
      await spawnTier(host)
      await born(host, ref("high"))
      expect(host.storage.get("outcome:c")).not.toHaveProperty("failedOver")
      const message = "prompt is too long: 213462 tokens > 200000 maximum"
      host.emit({
        type: "session.execution.failed",
        data: { sessionID: "c", error: { type: "provider.invalid-request", message, status: 400, response: { body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }) } } },
      })
      await settle()
      const facts = { policy: "explore-v1", arm: label("high"), p: 0.1 / 3 }
      expect(host.storage.get("outcome:c")).toMatchObject({ ...facts, failedOver: true })
      expect(host.storage.get("spawn-model:c")).toMatchObject({ model: haikuLabel, failedOver: true, overflowed: [label("high")], explore: facts })
    } finally {
      host.close()
      await cleanup()
      setExploreRandom(undefined)
    }
  })

  test("a resume reroute ends the arm: the ledger keeps the facts and marks leftArm, for a model, a tier and a guard switch", async () => {
    const reroutes: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["an explicit model", { model: label("low") }, {}],
      ["an explicit tier", { tier: "task" }, {}],
      ["a guard switch", {}, { guard: { expensive: [haikuLabel] } }],
    ]
    for (const [name, change, extra] of reroutes) {
      let kept = new Map<string, unknown>()
      // The last alternative is the next candidate, haiku.
      await withHost(on, 0.0999, async (host) => {
        await spawnTier(host)
        await born(host, { providerID: "anthropic", id: "claude-haiku" })
        expect(host.storage.get("outcome:c"), name).toMatchObject({ arm: haikuLabel })
        expect(host.storage.get("outcome:c"), name).not.toHaveProperty("leftArm")
        kept = new Map(host.storage)
      })
      await withHost(
        on,
        0.5,
        async (host) => {
          await host.spawn("subagent", { agent: "plain", prompt: "again", sessionID: "c", ...change }, "build", "r", "call-2")
          await settle()
          expect(host.storage.get("outcome:c"), name).toMatchObject({ policy: "explore-v1", arm: haikuLabel, p: 0.1 / 3, leftArm: true, resumes: 1 })
        },
        extra,
        kept,
      )
    }
  })

  test("a resume that keeps the child's model leaves it on its arm", async () => {
    let kept = new Map<string, unknown>()
    await withHost(on, 0, async (host) => {
      await spawnTier(host)
      await born(host, ref("high"))
      kept = new Map(host.storage)
    })
    await withHost(
      on,
      0.5,
      async (host) => {
        await host.spawn("subagent", { agent: "plain", prompt: "again", sessionID: "c" }, "build", "r", "call-2")
        await settle()
        expect(host.storage.get("outcome:c")).not.toHaveProperty("leftArm")
      },
      {},
      kept,
    )
  })

  test("a resume after a reload goes through the stored snapshot and keeps the arm", async () => {
    let kept = new Map<string, unknown>()
    await withHost(on, 0, async (host) => {
      await spawnTier(host)
      await born(host, ref("high"))
      kept = new Map(host.storage)
    })
    expect(kept.get("spawn-model:c")).toMatchObject({ explore: { arm: label("high") } })
    await withHost(
      on,
      0.5,
      async (host) => {
        const input = await host.spawn("subagent", { agent: "plain", prompt: "again", sessionID: "c" }, "build", "r", "call-2")
        expect(input.model).toBe(label("high"))
        expect(receipts(host)[0]).toMatchObject({ rule: "snapshot", model: label("high") })
        await settle()
        expect(host.storage.get("outcome:c")).toMatchObject({ arm: label("high"), p: 0.1 / 3, resumes: 1 })
        expect(host.storage.get("spawn-model:c")).toMatchObject({ model: label("high"), explore: { arm: label("high"), p: 0.1 / 3 } })
      },
      {},
      kept,
    )
  })

  test("a guard that refuses the effort-up variant keeps it out of the offer, even for a tier-assigned agent", async () => {
    const guard = { expensive: [label("high")] }
    for (const draw of [0, 0.0499, 0.0999]) {
      await withHost(
        on,
        draw,
        async (host) => {
          const input = await spawnTier(host)
          expect(input.model).not.toBe(label("high"))
          await born(host, input.model === label("low") ? ref("low") : { providerID: "anthropic", id: "claude-haiku" })
          expect((host.storage.get("outcome:c") as { eligible: string[] }).eligible).toEqual([label("medium"), label("low"), haikuLabel])
        },
        { guard },
      )
    }
  })

  test("a guard-allowlisted variant stays an arm", async () => {
    await withHost(
      on,
      0,
      async (host) => {
        expect((await spawnTier(host)).model).toBe(label("high"))
      },
      { guard: { expensive: [label("high")], allowModels: [label("high")] } },
    )
  })

  test("p is the probability under the arms actually offered: filtered alternatives leave the set", async () => {
    const one = { guard: { expensive: [label("high")] } }
    await withHost(on, 0, async (host) => {
      expect((await spawnTier(host)).model).toBe(label("low"))
      await born(host, ref("low"))
      const record = host.storage.get("outcome:c") as { eligible: string[]; p: number }
      expect(record.eligible).toEqual([label("medium"), label("low"), haikuLabel])
      expect(record.p).toBeCloseTo(0.05, 10)
    }, one)
    const two = { guard: { expensive: [label("high"), label("low")] } }
    await withHost(on, 0, async (host) => {
      expect((await spawnTier(host)).model).toBe(haikuLabel)
      await born(host, { providerID: "anthropic", id: "claude-haiku" })
      const record = host.storage.get("outcome:c") as { eligible: string[]; arm: string; p: number }
      expect(record.eligible).toEqual([label("medium"), haikuLabel])
      expect(record).toMatchObject({ arm: haikuLabel })
      expect(record.p).toBeCloseTo(0.1, 10)
    }, two)
    await withHost(on, 0.5, async (host) => {
      expect((await spawnTier(host)).model).toBe(label("medium"))
      await born(host, ref("medium"))
      expect((host.storage.get("outcome:c") as { p: number }).p).toBeCloseTo(0.9, 10)
    }, two)
  })

  test("when the guard refuses every alternative the spawn stays on the control and logs no arm", async () => {
    const guard = { expensive: [label("high"), label("low"), haikuLabel] }
    await withHost(
      on,
      0,
      async (host) => {
        expect((await spawnTier(host)).model).toBe(label("medium"))
        await born(host, ref("medium"))
        expect(host.storage.get("outcome:c")).not.toHaveProperty("arm")
        expect(receipts(host)[0]).not.toHaveProperty("explore")
      },
      { guard },
    )
  })

  test("a cooled-down model is not an arm", async () => {
    const now = Date.now()
    const cooled = new Map<string, unknown>([["health", { [haikuLabel]: { failedAt: now, until: now + 600_000, reason: "x" } }]])
    await withHost(on, 0.0999, async (host) => {
      expect((await spawnTier(host)).model).toBe(label("low"))
      await born(host, ref("low"))
      expect((host.storage.get("outcome:c") as { eligible: string[] }).eligible).toEqual([label("medium"), label("high"), label("low")])
    }, {}, cooled)
  })

  test("a cooled-down provider leaves a single arm, so the spawn is not explored", async () => {
    const now = Date.now()
    const cooled = new Map<string, unknown>([["health", { "amazon-bedrock/*": { failedAt: now, until: now + 600_000, reason: "x" } }]])
    await withHost(on, 0, async (host) => {
      const input = await spawnTier(host)
      expect(input.model).toBe(haikuLabel)
      await born(host, { providerID: "anthropic", id: "claude-haiku" })
      expect(host.storage.get("outcome:c")).not.toHaveProperty("arm")
    }, {}, cooled)
  })

  test("a reviewer agent never explores", async () => {
    setExploreRandom(() => 0)
    const host = createHost({ agents: [{ id: "code-reviewer" }], models: tierModels, options: { ...base, evaluate: { agents: ["code-reviewer"], explore: 0.1 } } })
    host.sessions.set("r", { id: "r" })
    const cleanup = await setup(host)
    const input = await host.spawn("subagent", { agent: "code-reviewer", prompt: "x", tier: "task" }, "build", "r", "call-1")
    expect(input.model).toBe(label("medium"))
    host.close()
    await cleanup()
    setExploreRandom(undefined)
  })

  test("a spawn with its own model is not touched", async () => {
    await withHost(on, 0, async (host) => {
      const input = await host.spawn("subagent", { agent: "plain", prompt: "x", model: haikuLabel }, "build", "r", "call-1")
      expect(input.model).toBe(haikuLabel)
    })
  })

  describe("a spawn without a tier parameter whose agent has its own tier", () => {
    const spawnOwn = (host: ReturnType<typeof createHost>, agent = "coder") => host.spawn("subagent", { agent, prompt: "x" }, "build", "r", "call-1")

    test("explores like an explicit tier: the arm runs, and the ledger and snapshot carry the facts", async () => {
      await withHost(on, 0, async (host) => {
        const input = await spawnOwn(host)
        expect(input.model).toBe(label("high"))
        await born(host, ref("high"), "coder")
        const facts = { policy: "explore-v1", eligible: [label("medium"), label("high"), label("low"), haikuLabel], arm: label("high"), p: 0.1 / 3 }
        expect(host.storage.get("outcome:c")).toMatchObject({ agent: "coder", tier: "standard", source: "agent", ...facts })
        expect(host.storage.get("spawn-model:c")).toMatchObject({ model: label("high"), explore: facts })
        expect(receipts(host)[0]).toMatchObject({ agent: "coder", source: "agent", model: label("high"), explore: label("high") })
      })
    })

    test("a control draw leaves the spawn alone, and logs the control with its p", async () => {
      await withHost(on, 0.5, async (host) => {
        const input = await spawnOwn(host)
        expect(input).toEqual({ agent: "coder", prompt: "x" })
        await born(host, ref("medium"), "coder")
        expect(host.storage.get("outcome:c")).toMatchObject({ arm: label("medium"), p: 0.9 })
      })
    })

    test("an agent not in evaluate.agents is not explored and leaves no ledger record", async () => {
      await withHost({ agents: ["plain"], explore: 0.1 }, 0, async (host) => {
        expect(await spawnOwn(host)).toEqual({ agent: "coder", prompt: "x" })
        await born(host, ref("medium"), "coder")
        expect(host.storage.has("outcome:c")).toBe(false)
      })
    })
  })
})
