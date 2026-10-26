import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { checkRoles, formatCheck } from "./check.ts"
import { decideFallback, failureNote, fallbackTarget, type NoteFacts, retryPrompt, SOURCE, subagentNote } from "./fallback.ts"
import { type GuardAgent, type GuardModel, inputCost, judgeSpawn, parseGuard, pinnedModel } from "./guard.ts"
import {
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
  resolveRole,
  roleOf,
  sameModel,
  staleAgents,
  stripRoleHeader,
} from "./resolve.ts"
import { type CloneableAgent, parseRuntime, roleAgentDescription, roleAgentId, shapeRoleAgent } from "./role-agents.ts"

export * from "./check.ts"
export * from "./fallback.ts"
export * from "./guard.ts"
export * from "./health.ts"
export * from "./resolve.ts"
export * from "./role-agents.ts"

/** Re-registrations allowed in a row without the agents converging, before giving up until inputs change. */
export const MAX_REREGISTER = 3

/** A parent hears about one failed model once in this window, from either the tool error or the child's event. */
export const NOTICE_DEDUPE_MS = 60_000

export const CHECK_TOOL = "model_roles_check"

const REFRESH_EVENTS = new Set(["model.updated", "provider.updated"])
const CHECK_EVENTS = new Set(["agent.updated", ...REFRESH_EVENTS])
const FAILED_EVENT = "session.execution.failed"

type AgentEditor = Parameters<Parameters<Context["agent"]["transform"]>[0]>[0]

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
    const roleAgentIds = runtime.roleAgents.map(roleAgentId)
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
      const now = healthView(health, Date.now())
      const general = editor.get("general") as CloneableAgent | undefined
      for (const role of runtime.roleAgents) {
        const id = roleAgentId(role)
        const created = editor.get(id) === undefined
        const model = resolveRole(options.roles, available, role, now).model
        const description = roleAgentDescription(role, model, model && inputCost(model, available))
        editor.update(id, (draft) => shapeRoleAgent(draft as CloneableAgent, general, role, description, created))
      }
      const desired = desiredModels(editor.list(), options, available, now)
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

    /** The model of the child session a `Subagent failed (<id>)` message names. */
    const childModel = async (message: string): Promise<ModelRef | undefined> => {
      const id = /subagent failed \(([^)\s]+)\)/i.exec(message)?.[1]
      if (id === undefined) return undefined
      try {
        return ((await ctx.session.get({ sessionID: id })) as { model?: ModelRef } | undefined)?.model
      } catch {
        return undefined
      }
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

    const onSessionFailed = async (sessionID: string, error: { type?: string; message?: string; status?: number }) => {
      const kind = classifyFailure(error)
      if (kind === undefined) return
      const session = (await ctx.session.get({ sessionID })) as {
        parentID?: string
        agent?: string
        model?: ModelRef
      }
      const agents = await listAgents()
      const agent = agents.find((a) => a.id === session.agent)
      const failed = modelFromError(error.message ?? "") ?? session.model ?? agent?.model
      if (failed === undefined) {
        console.warn(`${SOURCE}: session ${sessionID} failed (${kind}) on an unknown model; nothing marked unhealthy`)
        return
      }
      await markFailed(failed, kind, error.message ?? "")
      const role = agent === undefined ? undefined : roleOf(agent, options.agents)
      const target = fallbackTarget(options, available, view(), role, failed)
      const facts: NoteFacts = { failed, kind, cooldownMs: runtime.cooldownMs, target }
      const isChild = typeof session.parentID === "string" && session.parentID !== ""
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
        await notifyParentOnce(session.parentID as string, failed, subagentNote({ ...facts, agent: session.agent }))
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
          "Read-only. List every model role's candidates with their status (available, unknown id, unknown variant, provider unavailable, unhealthy until a time) against all providers, and the model each role-bearing agent resolves to.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await refresh()
          const agents = await listAgents()
          const report = checkRoles(options, available, agents, health)
          return { content: formatCheck(report), metadata: { roles: report.roles.length, agents: report.agents.length } }
        },
      })
    })

    const guarded =
      guard === undefined
        ? undefined
        : await ctx.tool.hook("execute.before", async (event) => {
            if (event.tool !== SUBAGENT_TOOL) return
            const target = spawnTarget(event.input)
            if (target === undefined) return
            let reason: string | undefined
            try {
              const [agents, session] = await Promise.all([listAgents(), ctx.session.get({ sessionID: event.sessionID })])
              const caller = agents.find((agent) => agent.id === event.agent)
              const facts = { options, available, health: view() }
              const sessionModel = session?.model ?? (caller === undefined ? undefined : pinnedModel(caller, facts))
              const decision = judgeSpawn({ ...facts, guard, target, agents, sessionModel, roleAgents: roleAgentIds })
              if (!decision.allow) reason = decision.reason
            } catch {
              // Fail open: a broken lookup must never block delegation.
              return
            }
            if (reason !== undefined) throw new Error(reason)
          })

    const spawnFailures = await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== SUBAGENT_TOOL || event.status !== "error") return
      const message = event.error.message
      const kind = classifyFailure({ message })
      if (kind === undefined) return
      const agentID = isRecord(event.input) && typeof event.input.agent === "string" ? event.input.agent : undefined
      try {
        await queue(async () => {
          const agents = await listAgents()
          const agent = agents.find((a) => a.id === agentID)
          const failed = modelFromError(message) ?? (await childModel(message)) ?? recentOr(event.sessionID, agent?.model)
          if (failed === undefined) return
          await markFailed(failed, kind, message)
          const role = agent === undefined ? undefined : roleOf(agent, options.agents)
          const target = fallbackTarget(options, available, view(), role, failed)
          const facts: NoteFacts = { failed, kind, cooldownMs: runtime.cooldownMs, target }
          await notifyParentOnce(event.sessionID, failed, subagentNote({ ...facts, agent: agentID }))
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
        if (typeof type !== "string" || !CHECK_EVENTS.has(type)) continue
        try {
          await queue(async () => {
            const changed = REFRESH_EVENTS.has(type) && (await refresh())
            if (changed) attempts = 0
            await check(changed)
          })
        } catch {
          // A failed list or transform leaves the current mapping in place; the next event retries.
        }
      }
    })().catch(() => {})

    return async () => {
      controller.abort()
      if (expiry !== undefined) clearTimeout(expiry)
      await spawnFailures.dispose()
      await guarded?.dispose()
      await tools.dispose()
      await strip.dispose()
      await registration.dispose()
      notices.clear()
      childFailures.clear()
    }
  },
})
