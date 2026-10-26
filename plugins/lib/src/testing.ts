/**
 * An in-memory stand-in for the `@opencode/plugin` 2.x plugin context, for tests.
 *
 * It implements the domains this repository's plugins use and records what a
 * plugin registers, so a test can call `setup`, fire hooks the way the host would,
 * and check that the cleanup disposed every registration. Only the shapes are
 * faked: no hook here runs unless the test fires it.
 *
 * ```ts
 * const fake = createFakeContext()
 * const cleanup = await plugin.setup(fake.context)
 * await fake.fire.tool("execute.before", { tool: "shell", input: { command: "ls" } })
 * await cleanup?.()
 * expect(fake.active()).toBe(0)
 * ```
 */

import type { Context } from "@opencode/plugin/promise/plugin"

type Callback = (input: never) => Promise<void> | void
type Registration = { dispose: () => Promise<void> }
type Hook = { name: string; callback: Callback }
type Domain = "tool" | "shell" | "permission" | "session"
type Loose = Record<string, unknown>

export type FakeTool = Loose & { name: string; id: string }
export type FakeAgent = Loose & { id: string }
export type FakeSession = Loose & { id: string }
export type FakeCall = { method: string; input: unknown }

export type FakeContextOptions = {
  /** The project directory reported as `context.location.directory`. */
  directory?: string
  /** Tools the host already has before any transform runs. */
  tools?: ReadonlyArray<Loose & { name: string }>
  /** Agents the host already has before any transform runs. */
  agents?: ReadonlyArray<FakeAgent>
  /** Sessions `session.get` can return. */
  sessions?: ReadonlyArray<FakeSession>
  /** Initial storage contents. */
  storage?: Record<string, unknown>
  /** Plugin options passed as `context.options`. */
  options?: Loose
}

export type FakeContext = {
  /** Pass this to `plugin.setup`. */
  context: Context
  /** Tools after every transform, keyed by name. */
  tools: Map<string, FakeTool>
  /** Agents after every transform, keyed by id. */
  agents: Map<string, FakeAgent>
  /** Every agent id passed to an agent editor's `update`, in call order. */
  agentUpdates: string[]
  /** Every agent editor `default(id)` call, in call order. */
  agentDefaults: Array<string | undefined>
  /** Storage contents. */
  storage: Map<string, unknown>
  /** Sessions by id; `session.create` adds to it. */
  sessions: Map<string, FakeSession>
  /** Calls to faked client methods (`session.*`, `event.subscribe`), in order. */
  calls: FakeCall[]
  /** Run every registered hook of one domain and name in order, as the host does; resolves to the payload. */
  fire: {
    tool: <T>(name: string, payload: T) => Promise<T>
    shell: <T>(name: string, payload: T) => Promise<T>
    permission: <T>(name: string, payload: T) => Promise<T>
    session: <T>(name: string, payload: T) => Promise<T>
  }
  /** Names of the hooks currently registered per domain, in registration order. */
  hooks: (domain: Domain) => string[]
  /** Deliver an event to every open `event.subscribe` iterator. */
  emit: (event: unknown) => void
  /** End every open `event.subscribe` iterator. */
  closeEvents: () => void
  /** Number of registrations not yet disposed. */
  active: () => number
}

/** Create a fake plugin context. */
export function createFakeContext(options: FakeContextOptions = {}): FakeContext {
  const directory = options.directory ?? "/fake/project"
  const tools = new Map<string, FakeTool>()
  for (const tool of options.tools ?? []) tools.set(tool.name, { ...tool, id: tool.name })
  const agents = new Map<string, FakeAgent>((options.agents ?? []).map((agent) => [agent.id, { ...agent }]))
  const sessions = new Map<string, FakeSession>((options.sessions ?? []).map((session) => [session.id, { ...session }]))
  const storage = new Map<string, unknown>(Object.entries(options.storage ?? {}))
  const agentUpdates: string[] = []
  const agentDefaults: Array<string | undefined> = []
  const calls: FakeCall[] = []
  const hooks: Record<Domain, Hook[]> = { tool: [], shell: [], permission: [], session: [] }
  const live = new Set<object>()
  let sequence = 0

  const register = (onDispose: () => void = () => {}): Registration => {
    const token = {}
    live.add(token)
    return {
      dispose: async () => {
        if (!live.delete(token)) return
        onDispose()
      },
    }
  }

  const hook =
    (domain: Domain) =>
    async (name: string, callback: Callback): Promise<Registration> => {
      const entry: Hook = { name, callback }
      hooks[domain].push(entry)
      return register(() => {
        const list = hooks[domain]
        const at = list.indexOf(entry)
        if (at >= 0) list.splice(at, 1)
      })
    }

  const fire =
    (domain: Domain) =>
    async <T>(name: string, payload: T): Promise<T> => {
      for (const entry of [...hooks[domain]]) {
        if (entry.name === name) await (entry.callback as (input: T) => Promise<void> | void)(payload)
      }
      return payload
    }

  const toolTransform = async (callback: (editor: unknown) => void): Promise<Registration> => {
    const added: string[] = []
    const editor = {
      list: () => [...tools.values()],
      get: (id: string) => tools.get(id),
      namespace: () => {},
      add: (tool: Loose & { name: string }) => {
        tools.set(tool.name, { ...tool, id: tool.name })
        added.push(tool.name)
      },
      update: (id: string, update: (tool: FakeTool) => void) => {
        const tool = tools.get(id)
        if (tool !== undefined) update(tool)
      },
      remove: (id: string) => void tools.delete(id),
    }
    callback(editor)
    return register(() => {
      for (const name of added) tools.delete(name)
    })
  }

  const agentTransform = async (callback: (editor: unknown) => void): Promise<Registration> => {
    const editor = {
      list: () => [...agents.values()],
      get: (id: string) => agents.get(id),
      default: (id: string | undefined) => void agentDefaults.push(id),
      update: (id: string, update: (agent: FakeAgent) => void) => {
        agentUpdates.push(id)
        const agent = agents.get(id) ?? { id }
        update(agent)
        agents.set(id, agent)
      },
      remove: (id: string) => void agents.delete(id),
    }
    callback(editor)
    return register()
  }

  type Subscriber = { queue: unknown[]; closed: boolean; wake?: () => void }
  const subscribers = new Set<Subscriber>()
  const subscribe = (input?: unknown): AsyncIterable<unknown> => {
    calls.push({ method: "event.subscribe", input })
    const subscriber: Subscriber = { queue: [], closed: false }
    subscribers.add(subscriber)
    const done = { value: undefined, done: true as const }
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (subscriber.queue.length === 0 && !subscriber.closed) {
            await new Promise<void>((resolve) => {
              subscriber.wake = resolve
            })
          }
          subscriber.wake = undefined
          if (subscriber.queue.length > 0) return { value: subscriber.queue.shift(), done: false as const }
          return done
        },
        return: async () => {
          subscriber.closed = true
          subscribers.delete(subscriber)
          return done
        },
      }),
    }
  }

  const sessionGet = async (input: { sessionID: string }): Promise<FakeSession> => {
    calls.push({ method: "session.get", input })
    const session = sessions.get(input.sessionID)
    if (session === undefined) throw new Error(`fake context: no session ${input.sessionID}`)
    return session
  }
  const sessionCreate = async (input: Loose = {}): Promise<FakeSession> => {
    calls.push({ method: "session.create", input })
    const id = typeof input.id === "string" ? input.id : `ses_fake${++sequence}`
    const location = (input.location as Loose | undefined) ?? { directory }
    const session: FakeSession = { ...input, id, location }
    sessions.set(id, session)
    return session
  }
  const sessionMove = async (input: { sessionID: string; directory: string }): Promise<void> => {
    calls.push({ method: "session.move", input })
    const session = sessions.get(input.sessionID)
    if (session !== undefined) session.location = { directory: input.directory }
  }
  const sessionSynthetic = async (input: Loose & { sessionID: string }): Promise<Loose> => {
    calls.push({ method: "session.synthetic", input })
    return {
      id: `msg_fake${++sequence}`,
      sessionID: input.sessionID,
      time: { created: Date.now() },
      type: "synthetic",
      payload: input,
      delivery: input.delivery ?? "queue",
    }
  }

  const scan = async (input: { prefix: string; after?: string; limit?: number }) => {
    const keys = [...storage.keys()]
      .filter((key) => key.startsWith(input.prefix) && (input.after === undefined || key > input.after))
      .sort()
    const page = input.limit === undefined ? keys : keys.slice(0, input.limit)
    const entries = page.map((key) => ({ key, value: storage.get(key) }))
    const next = page.length < keys.length ? page[page.length - 1] : undefined
    return next === undefined ? { entries } : { entries, next }
  }

  const context = {
    location: { directory },
    options: options.options ?? {},
    tool: {
      transform: toolTransform,
      hook: hook("tool"),
      reload: async () => {},
      list: async () => [...tools.values()],
    },
    shell: { hook: hook("shell") },
    permission: { hook: hook("permission") },
    session: {
      hook: hook("session"),
      get: sessionGet,
      create: sessionCreate,
      move: sessionMove,
      synthetic: sessionSynthetic,
    },
    agent: {
      transform: agentTransform,
      reload: async () => {},
      list: async () => [...agents.values()],
      get: async (input: { agentID?: string; id?: string }) => agents.get(input.agentID ?? input.id ?? ""),
    },
    event: { subscribe },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      remove: async (key: string) => void storage.delete(key),
      scan,
    },
  }

  return {
    context: context as unknown as Context,
    tools,
    agents,
    agentUpdates,
    agentDefaults,
    storage,
    sessions,
    calls,
    fire: { tool: fire("tool"), shell: fire("shell"), permission: fire("permission"), session: fire("session") },
    hooks: (domain) => hooks[domain].map((entry) => entry.name),
    emit: (event) => {
      for (const subscriber of subscribers) {
        subscriber.queue.push(event)
        subscriber.wake?.()
      }
    },
    closeEvents: () => {
      for (const subscriber of subscribers) {
        subscriber.closed = true
        subscriber.wake?.()
      }
      subscribers.clear()
    },
    active: () => live.size,
  }
}
