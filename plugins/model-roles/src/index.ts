import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { checkRoles, formatCheck } from "./check.ts"
import { decideFallback, failureNote, fallbackTarget, type NoteFacts, retryPrompt, SOURCE, subagentNote } from "./fallback.ts"
import { type GuardAgent, type GuardModel, judgeSpawn, parseGuard, pinnedModel } from "./guard.ts"
import {
  childSessionID,
  classifyFailure,
  type FailureClass,
  HEALTH_KEY,
  type HealthState,
  healthKey,
  healthView,
  markUnhealthy,
  modelFromError,
  nextExpiry,
  pruneHealth,
  RETRY_KEY_PREFIX,
  readHealth,
} from "./health.ts"
import {
  type AvailableModel,
  desiredModels,
  type ModelRef,
  parseOptions,
  roleOf,
  sameModel,
  staleAgents,
  stripRoleHeader,
} from "./resolve.ts"
import {
  inputModel,
  parseRuntime,
  planSpawn,
  roleChoices,
  roleParamDescription,
  SPAWN_ROLE_KEY_PREFIX,
  toJsonSchema,
  withRoleNote,
  withRoleParam,
} from "./spawn-role.ts"

export * from "./check.ts"
export * from "./fallback.ts"
export * from "./guard.ts"
export * from "./health.ts"
export * from "./resolve.ts"
export * from "./spawn-role.ts"

/** Re-registrations allowed in a row without the agents converging, before giving up until inputs change. */
export const MAX_REREGISTER = 3

/** A parent hears about one failed model once in this window, from either the tool error or the child's event. */
export const NOTICE_DEDUPE_MS = 60_000

export const CHECK_TOOL = "model_roles_check"

/** How far up the parent chain a session's inherited model is looked for. */
export const MAX_SESSION_DEPTH = 8

const REFRESH_EVENTS = new Set(["model.updated", "provider.updated"])
const CHECK_EVENTS = new Set(["agent.updated", ...REFRESH_EVENTS])
const FAILED_EVENT = "session.execution.failed"
const CREATED_EVENT = "session.created"

/** How long a spawn waits to be matched with the child session it creates. */
export const PENDING_SPAWN_MS = 10 * 60_000

type AgentEditor = Parameters<Parameters<Context["agent"]["transform"]>[0]>[0]
type ToolEditor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0]
type FieldSchema = { annotate?: (annotations: { description: string }) => unknown }
type StructSchema = { fields?: Record<string, FieldSchema>; mapFields?: (f: (fields: object) => object) => unknown }

/**
 * Fallback when the `subagent` input is an Effect struct this plugin cannot express as
 * JSON Schema: add `role` as another optional string, shaped like `model`. Unknown
 * roles are then refused in `execute.before` instead of by the schema.
 */
function withRoleField(input: unknown, description: string): unknown {
  const schema = input as StructSchema | undefined
  const model = schema?.fields?.model
  if (typeof schema?.mapFields !== "function" || typeof model?.annotate !== "function") return undefined
  const role = model.annotate({ description })
  return schema.mapFields((fields) => ({ ...fields, role }))
}

const SUBAGENT_TOOL = "subagent"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The agent a fresh `subagent` spawn names; a resumed one (`sessionID`) keeps its session and is not judged. */
export function spawnTarget(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.agent !== "string" || input.agent === "") return undefined
  if (typeof input.sessionID === "string" && input.sessionID !== "") return undefined
  return input.agent
}

const availabilityKey = (models: ReadonlyArray<AvailableModel>): string =>
  models
    .filter((m) => m.enabled !== false)
    .map((m) => `${m.providerID}/${m.id}#${(m.variants ?? []).map((v) => v.id).join(",")}`)
    .sort()
    .join("\n")

const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}

/** Run tasks one at a time, in call order. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task)
    tail = next.catch(() => undefined)
    return next
  }
}

export default Plugin.define({
  id: "srobroek.model-roles",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const runtime = parseRuntime(ctx.options, options)
    const guard = parseGuard(isRecord(ctx.options) ? ctx.options.guard : undefined)
    let available: GuardModel[] = []
    let availableKey = ""
    let health: HealthState = {}
    try {
      health = pruneHealth(readHealth(await ctx.storage.get(HEALTH_KEY)), Date.now())
    } catch {
      health = {}
    }
    const view = () => healthView(health, Date.now())
    const queue = serial()
    const notices = new Map<string, number>()
    /** When a child of each parent last reported a model failure through its own event. */
    const childFailures = new Map<string, number>()

    const refresh = async (): Promise<boolean> => {
      try {
        available = (await ctx.model.list()).data
      } catch {
        available = []
      }
      const key = availabilityKey(available)
      const changed = key !== availableKey
      availableKey = key
      return changed
    }

    const apply = (editor: AgentEditor) => {
      const desired = desiredModels(editor.list(), options, available, healthView(health, Date.now()))
      for (const [id, ref] of desired) {
        const agent = editor.get(id)
        if (agent === undefined || sameModel(agent.model, ref)) continue
        editor.update(id, (draft) => {
          draft.model = { ...ref } as typeof draft.model
        })
      }
    }

    await refresh()
    let registration = await ctx.agent.transform(apply)
    let attempts = 0
    const controller = new AbortController()

    // Config and markdown agents load after user plugins, so their `model:` can
    // replace ours. Re-registering puts this transform last.
    // A change in availability or health re-registers even when nothing looks stale,
    // so a model that just became unavailable or unhealthy is replaced.
    const check = async (force: boolean) => {
      const agents = (await ctx.agent.list()).data
      const desired: Map<string, ModelRef> = desiredModels(agents, options, available, view())
      if (!force && staleAgents(agents, desired).length === 0) {
        attempts = 0
        return
      }
      if (attempts >= MAX_REREGISTER || controller.signal.aborted) return
      attempts++
      const next = await ctx.agent.transform(apply)
      if (controller.signal.aborted) {
        await next.dispose()
        return
      }
      const previous = registration
      registration = next
      await previous.dispose()
    }

    let expiry: ReturnType<typeof setTimeout> | undefined
    const scheduleExpiry = () => {
      if (expiry !== undefined) clearTimeout(expiry)
      expiry = undefined
      const now = Date.now()
      const at = nextExpiry(health, now)
      if (at === undefined || controller.signal.aborted) return
      expiry = setTimeout(
        () =>
          void queue(async () => {
            health = pruneHealth(health, Date.now())
            attempts = 0
            await check(true)
            scheduleExpiry()
          }).catch(() => {}),
        at - now + 10,
      )
      ;(expiry as { unref?: () => void }).unref?.()
    }
    scheduleExpiry()

    const markFailed = async (ref: ModelRef, kind: FailureClass, message: string) => {
      health = markUnhealthy(health, ref, Date.now(), runtime.cooldownMs, `${kind}: ${oneLine(message)}`)
      try {
        await ctx.storage.set(HEALTH_KEY, health)
      } catch {
        // In-memory health still steers this instance.
      }
      attempts = 0
      await check(true)
      scheduleExpiry()
    }

    const notify = async (sessionID: string, text: string, kind: string) => {
      console.warn(`${SOURCE}: ${text}`)
      try {
        await ctx.session.synthetic({
          sessionID,
          text,
          description: text.split(". ", 1)[0] ?? text,
          metadata: { source: SOURCE, kind },
          delivery: "steer",
          resume: false,
        } as never)
      } catch {
        // The log line above is the record when the session cannot take a note.
      }
    }

    const notifyParentOnce = async (parentID: string, failed: ModelRef, text: string) => {
      const key = `${parentID}\0${healthKey(failed)}`
      const now = Date.now()
      const last = notices.get(key)
      if (last !== undefined && now - last < NOTICE_DEDUPE_MS) return
      notices.set(key, now)
      await notify(parentID, text, "subagent-fallback")
    }

    /** The model of the child session a `Subagent failed (sessionID: <id>)` message names. */
    const childModel = async (message: string): Promise<ModelRef | undefined> => {
      const id = childSessionID(message)
      if (id === undefined) return undefined
      try {
        return ((await ctx.session.get({ sessionID: id })) as { model?: ModelRef } | undefined)?.model
      } catch {
        return undefined
      }
    }

    type SessionLike = { parentID?: string; agent?: string; model?: ModelRef } | undefined

    const defaultModel = async (): Promise<ModelRef | undefined> => {
      try {
        const model = (await ctx.model.default()).data
        return model == null ? undefined : { providerID: model.providerID, id: model.id }
      } catch {
        return undefined
      }
    }

    /**
     * The model a session runs on. A session on the default model, or one that
     * inherits, carries no `model`: walk its agent, then its parents, then the default.
     */
    const runningModel = async (session: SessionLike, agents: Agents, agentID?: string): Promise<ModelRef | undefined> => {
      const facts = { options, available, health: view() }
      let current = session
      let id = agentID ?? session?.agent
      for (let depth = 0; current !== undefined && depth < MAX_SESSION_DEPTH; depth++) {
        if (current.model !== undefined) return current.model
        const agent = agents.find((a) => a.id === id)
        const pinned = agent === undefined ? undefined : pinnedModel(agent, facts)
        if (pinned !== undefined) return pinned
        if (typeof current.parentID !== "string" || current.parentID === "") break
        current = (await ctx.session.get({ sessionID: current.parentID }).catch(() => undefined)) as SessionLike
        id = current?.agent
      }
      return defaultModel()
    }

    /**
     * The target agent's model, unless a child of this parent just reported its own
     * failure: the agent has been moved to the next model since, and blaming that one
     * would be wrong.
     */
    const recentOr = (parentID: string, model: ModelRef | undefined): ModelRef | undefined => {
      const last = childFailures.get(parentID)
      return last !== undefined && Date.now() - last < NOTICE_DEDUPE_MS ? undefined : model
    }

    type Agents = ReadonlyArray<GuardAgent>
    const listAgents = async (): Promise<Agents> => (await ctx.agent.list()).data as Agents

    /** Spawns that passed a role, by tool call id, until they finish. */
    type PendingSpawn = { parentID: string; agent: string; role: string; model: ModelRef; at: number; childID?: string }
    const pending = new Map<string, PendingSpawn>()
    /** The role each child session was spawned with. */
    const childRoles = new Map<string, string>()

    const recordChildRole = async (childID: string, role: string) => {
      if (childRoles.get(childID) === role) return
      childRoles.set(childID, role)
      try {
        await ctx.storage.set(`${SPAWN_ROLE_KEY_PREFIX}${childID}`, role)
      } catch {
        // The in-memory record still steers this instance.
      }
    }

    const spawnRoleOf = async (childID: string): Promise<string | undefined> => {
      const known = childRoles.get(childID)
      if (known !== undefined) return known
      const stored = await ctx.storage.get(`${SPAWN_ROLE_KEY_PREFIX}${childID}`).catch(() => undefined)
      return typeof stored === "string" && Object.hasOwn(options.roles, stored) ? stored : undefined
    }

    /** Match a new child session to the role spawn that created it: same parent, agent and model. */
    const onSessionCreated = async (data: { sessionID?: unknown; parentID?: unknown; agent?: unknown; model?: unknown }) => {
      if (typeof data.sessionID !== "string" || typeof data.parentID !== "string" || !isRecord(data.model)) return
      const model = data.model as ModelRef
      const now = Date.now()
      for (const [id, spawn] of pending) {
        if (now - spawn.at > PENDING_SPAWN_MS) pending.delete(id)
      }
      for (const spawn of pending.values()) {
        if (spawn.childID !== undefined || spawn.parentID !== data.parentID || spawn.agent !== data.agent) continue
        if (healthKey(spawn.model) !== healthKey(model)) continue
        spawn.childID = data.sessionID
        await recordChildRole(data.sessionID, spawn.role)
        return
      }
    }

    const onSessionFailed = async (sessionID: string, error: { type?: string; message?: string; status?: number }) => {
      const kind = classifyFailure(error)
      if (kind === undefined) return
      const session = (await ctx.session.get({ sessionID })) as SessionLike & {}
      const agents = await listAgents()
      const agent = agents.find((a) => a.id === session.agent)
      const failed = modelFromError(error.message ?? "") ?? (await runningModel(session, agents))
      if (failed === undefined) {
        console.warn(`${SOURCE}: session ${sessionID} failed (${kind}) on an unknown model; nothing marked unhealthy`)
        return
      }
      await markFailed(failed, kind, error.message ?? "")
      const isChild = typeof session.parentID === "string" && session.parentID !== ""
      const spawnRole = isChild ? await spawnRoleOf(sessionID) : undefined
      const role = spawnRole ?? (agent === undefined ? undefined : roleOf(agent, options.agents))
      const target = fallbackTarget(options, available, view(), role, failed)
      const facts: NoteFacts = { failed, kind, cooldownMs: runtime.cooldownMs, target }
      const retryKey = `${RETRY_KEY_PREFIX}${sessionID}`
      const lastRetryAt = isChild ? undefined : await ctx.storage.get(retryKey).catch(() => undefined)
      const now = Date.now()
      const action = decideFallback({
        isChild,
        retryOnFallback: runtime.retryOnFallback,
        failed,
        next: target?.model,
        lastRetryAt,
        now,
        windowMs: runtime.cooldownMs,
      })
      if (action === "notify-parent") {
        childFailures.set(session.parentID as string, Date.now())
        // A child spawned with a role follows that role: move it on, so resuming it continues on the next model.
        let resumable: string | undefined
        if (spawnRole !== undefined && target !== undefined) {
          try {
            await ctx.session.switchModel({ sessionID, model: target.model })
            resumable = sessionID
          } catch {
            // Spawning again with the role still works.
          }
        }
        const note = subagentNote({ ...facts, agent: session.agent, spawnRole, resumable })
        await notifyParentOnce(session.parentID as string, failed, note)
        return
      }
      if (action === "retry" && target !== undefined) {
        await ctx.storage.set(retryKey, now)
        const text = retryPrompt({ ...facts, target })
        console.warn(`${SOURCE}: ${text}`)
        await ctx.session.switchModel({ sessionID, model: target.model })
        await ctx.session.prompt({
          sessionID,
          text,
          metadata: { source: SOURCE, kind: "fallback-retry" },
          delivery: "queue",
        } as never)
        return
      }
      await notify(sessionID, failureNote(facts), "fallback")
    }

    const strip = await ctx.session.hook("model.request", (request) => {
      stripRoleHeader(request.headers)
    })

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: CHECK_TOOL,
        description:
          "Read-only. List every model role's candidates with their status (available, unknown id, unknown variant, provider unavailable, unhealthy until a time) against all providers, the model each role-bearing agent resolves to, and the roles the subagent tool's `role` parameter offers.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await refresh()
          const agents = await listAgents()
          const report = checkRoles(options, available, agents, health, Date.now(), runtime.purposes)
          return { content: formatCheck(report), metadata: { roles: report.roles.length, agents: report.agents.length } }
        },
      })
    })

    /**
     * Offer `role` on the built-in `subagent` tool. The enum and the cost tiers follow
     * availability, not health, so the tool list only changes when models come or go.
     */
    const applySubagentTool = (editor: ToolEditor) => {
      const choices = roleChoices(options, available, runtime.purposes)
      if (choices.length === 0) return
      const description = roleParamDescription(choices)
      editor.update(SUBAGENT_TOOL, (tool) => {
        const schema = toJsonSchema(tool.input)
        const input =
          schema === undefined
            ? withRoleField(tool.input, description)
            : withRoleParam(
                schema,
                choices.map((choice) => choice.role),
                description,
              )
        if (input === undefined) return
        tool.input = input as typeof tool.input
        tool.description = withRoleNote(tool.description)
      })
    }
    let subagentTool = await ctx.tool.transform(applySubagentTool)
    const refreshSubagentTool = async () => {
      if (controller.signal.aborted) return
      const next = await ctx.tool.transform(applySubagentTool)
      if (controller.signal.aborted) {
        await next.dispose()
        return
      }
      const previous = subagentTool
      subagentTool = next
      await previous.dispose()
    }

    const judge = async (event: { sessionID: string; agent: string }, target: string): Promise<string | undefined> => {
      if (guard === undefined) return undefined
      try {
        const [agents, session] = await Promise.all([listAgents(), ctx.session.get({ sessionID: event.sessionID })])
        const facts = { options, available, health: view() }
        const sessionModel = await runningModel(session as SessionLike, agents, event.agent)
        const decision = judgeSpawn({ ...facts, guard, target, agents, sessionModel })
        return decision.allow ? undefined : decision.reason
      } catch {
        // Fail open: a broken lookup must never block delegation.
        return undefined
      }
    }

    const spawns = await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== SUBAGENT_TOOL) return
      const plan = planSpawn(event.input, options, available, view())
      if (plan.error !== undefined) throw new Error(plan.error)
      if (plan.input !== event.input) event.input = plan.input
      const target = spawnTarget(plan.input)
      if (target === undefined) return
      if (plan.role !== undefined && plan.model !== undefined) {
        pending.set(event.id, { parentID: event.sessionID, agent: target, role: plan.role, model: plan.model, at: Date.now() })
        return
      }
      if (inputModel(plan.input) !== undefined) return
      const reason = await judge(event, target)
      if (reason !== undefined) throw new Error(reason)
    })

    const spawnResults = await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== SUBAGENT_TOOL) return
      const spawn = pending.get(event.id)
      pending.delete(event.id)
      if (event.status === "completed") {
        const childID = (event.result.metadata as { sessionID?: unknown } | undefined)?.sessionID
        if (spawn !== undefined && typeof childID === "string") await recordChildRole(childID, spawn.role)
        return
      }
      const message = event.error.message
      const kind = classifyFailure({ message })
      if (kind === undefined) return
      const agentID = isRecord(event.input) && typeof event.input.agent === "string" ? event.input.agent : undefined
      try {
        await queue(async () => {
          const agents = await listAgents()
          const agent = agents.find((a) => a.id === agentID)
          const failed =
            modelFromError(message) ??
            (await childModel(message)) ??
            inputModel(event.input) ??
            recentOr(event.sessionID, agent?.model)
          if (failed === undefined) return
          await markFailed(failed, kind, message)
          const role = spawn?.role ?? (agent === undefined ? undefined : roleOf(agent, options.agents))
          const target = fallbackTarget(options, available, view(), role, failed)
          const facts: NoteFacts = { failed, kind, cooldownMs: runtime.cooldownMs, target }
          await notifyParentOnce(event.sessionID, failed, subagentNote({ ...facts, agent: agentID, spawnRole: spawn?.role }))
        })
      } catch (error) {
        console.warn(`${SOURCE}: could not record the subagent failure`, error)
      }
    })

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break
        const type = isRecord(event) ? event.type : undefined
        if (type === FAILED_EVENT) {
          const data = (event as { data?: { sessionID?: unknown; error?: unknown } }).data
          if (typeof data?.sessionID !== "string" || !isRecord(data.error)) continue
          const sessionID = data.sessionID
          const error = data.error as { type?: string; message?: string; status?: number }
          await queue(() => onSessionFailed(sessionID, error)).catch((error) =>
            console.warn(`${SOURCE}: fallback after a failed execution did not complete`, error),
          )
          continue
        }
        if (type === CREATED_EVENT) {
          const data = (event as { data?: unknown }).data
          if (isRecord(data)) await onSessionCreated(data).catch(() => {})
          continue
        }
        if (typeof type !== "string" || !CHECK_EVENTS.has(type)) continue
        try {
          await queue(async () => {
            const changed = REFRESH_EVENTS.has(type) && (await refresh())
            if (changed) attempts = 0
            await check(changed)
            if (changed) await refreshSubagentTool()
          })
        } catch {
          // A failed list or transform leaves the current mapping in place; the next event retries.
        }
      }
    })().catch(() => {})

    return async () => {
      controller.abort()
      if (expiry !== undefined) clearTimeout(expiry)
      await spawnResults.dispose()
      await spawns.dispose()
      await subagentTool.dispose()
      await tools.dispose()
      await strip.dispose()
      await registration.dispose()
      notices.clear()
      childFailures.clear()
      pending.clear()
      childRoles.clear()
    }
  },
})
