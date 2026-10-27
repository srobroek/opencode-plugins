import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import {
  type AutoOptions,
  type AutoReason,
  type AutoRecord,
  autoEligible,
  buildDeciderPrompt,
  buildEffortPrompt,
  capRole,
  deciderModel,
  formatHistory,
  parseAuto,
  parseDecision,
  parseEffort,
  pickRole,
  pushHistory,
  roleCosts,
  withAutoTag,
} from "./auto.ts"
import { buildReferenceIndex, type CatalogModel, type Derived, nearestVariant, type ReferenceIndex, vendorOf } from "./catalog.ts"
import { checkRoles, formatCheck } from "./check.ts"
import {
  AUTO_AGENT,
  agentHash,
  buildClassifyPrompt,
  CLASSIFY_KEY_PREFIX,
  CLASSIFY_TIMEOUT_MS,
  type Classification,
  type ClassifyAgent,
  parseClassification,
  planImplicit,
  readClassification,
} from "./classify.ts"
import { globalConfigDir, pickConfigFile, readConfigFiles, readTiers, writeTier } from "./config-edit.ts"
import {
  failureNote,
  fallbackTarget,
  type NoteFacts,
  retryTarget,
  SOURCE,
  staysOnModel,
  subagentNote,
  switchNote,
} from "./fallback.ts"
import {
  type GuardAgent,
  type GuardModel,
  isExpensive,
  judgeModelOverride,
  judgeSpawn,
  parseGuard,
  pinnedModel,
} from "./guard.ts"
import {
  childSessionID,
  classifyFailure,
  cooldownFor,
  type FailureClass,
  type FailureInput,
  failureScope,
  HEALTH_KEY,
  type HealthState,
  healthKey,
  healthView,
  markUnhealthy,
  modelFromError,
  nextExpiry,
  pruneHealth,
  readHealth,
} from "./health.ts"
import {
  type AvailableModel,
  desiredModels,
  type ModelRef,
  type Options,
  parseOptions,
  ROLE_HEADER,
  resolveRole,
  roleOf,
  sameModel,
  staleAgents,
  stripRoleHeader,
} from "./resolve.ts"
import { TiersRpc } from "./rpc.ts"
import {
  choicesFor,
  inputModel,
  modelLabel,
  parseRuntime,
  planSpawn,
  ROLE_ALIAS_DESCRIPTION,
  ROLE_PARAM,
  roleChoices,
  roleParamDescription,
  SPAWN_ROLE_KEY_PREFIX,
  TIER_PARAM,
  toJsonSchema,
  withRoleNote,
  withRoleParam,
} from "./spawn-role.ts"
import { buildTiers, parseTierConfig, parseTierSettings, rankOf, resolveTier, type TierConfig, tierMeta } from "./tiers.ts"
import { compact, tierState } from "./tiers-ui.ts"

export * from "./auto.ts"
export * from "./catalog.ts"
export * from "./check.ts"
export * from "./classify.ts"
export * from "./config-edit.ts"
export * from "./fallback.ts"
export * from "./guard.ts"
export * from "./health.ts"
export * from "./resolve.ts"
export { TiersRpc } from "./rpc.ts"
export * from "./spawn-role.ts"
export * from "./tiers.ts"
export * from "./tiers-ui.ts"

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
 * JSON Schema: add `tier` and `role` as more optional strings, shaped like `model`.
 * Unknown tiers are then refused in `execute.before` instead of by the schema.
 */
function withRoleField(input: unknown, description: string): unknown {
  const schema = input as StructSchema | undefined
  const model = schema?.fields?.model
  if (typeof schema?.mapFields !== "function" || typeof model?.annotate !== "function") return undefined
  const tier = model.annotate({ description })
  const role = model.annotate({ description: ROLE_ALIAS_DESCRIPTION })
  return schema.mapFields((fields) => ({ ...fields, [TIER_PARAM]: tier, [ROLE_PARAM]: role }))
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
    const settings = parseTierSettings(ctx.options)
    const options: Options = { ...parseOptions(ctx.options), tiers: {}, classes: {}, implicit: {} }
    const runtime = parseRuntime(ctx.options, options)
    const guard = parseGuard(isRecord(ctx.options) ? ctx.options.guard : undefined)
    let autoHistory: AutoRecord[] = []
    let available: GuardModel[] = []
    let availableKey = ""
    let refs: ReferenceIndex = new Map()
    let derived: Derived | undefined
    /** Cached classifications of agents that declare no tier, by agent id. */
    const classified: Record<string, Classification> = {}
    /** `id\0hash` of agents the decider could not classify this run; they get the standard tier. */
    const unclassifiable = new Set<string>()
    const classifying = new Set<string>()

    const rebuild = () => {
      const set = buildTiers(settings, available as CatalogModel[], refs)
      options.roles = set.roles
      options.tiers = set.tiers
      options.classes = set.classes
      derived = set.derived
    }

    // models.dev first-party records (anthropic, openai, google), connected or not, price
    // subscription models. Read-only: nothing is edited.
    const references = await ctx.model.transform((editor) => {
      try {
        refs = buildReferenceIndex(editor.provider.list().flatMap((definition) => [...definition.models.values()] as CatalogModel[]))
      } catch {
        // Keep the last index.
      }
    })
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
      const key = `${availabilityKey(available)}\n${refs.size}`
      const changed = key !== availableKey
      availableKey = key
      rebuild()
      return changed
    }

    /** Agents waiting for a classification until the classifier below is ready. */
    let unscheduled: ReadonlyArray<ClassifyAgent> = []
    let scheduleClassify: (agents: ReadonlyArray<ClassifyAgent>) => void = (agents) => {
      unscheduled = agents
    }

    const apply = (editor: AgentEditor) => {
      const agents = editor.list() as ReadonlyArray<ClassifyAgent>
      const plan = planImplicit({
        agents,
        configured: options.agents,
        header: ROLE_HEADER,
        classified,
        failed: unclassifiable,
        autoGeneral: auto !== undefined,
      })
      options.implicit = plan.implicit
      if (plan.pending.length > 0) scheduleClassify(plan.pending)
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
    const auto = parseAuto(isRecord(ctx.options) ? ctx.options.auto : undefined, options)
    /** The decider settings `guard.mode: "auto"` and classification use when `auto` itself is off. */
    const deciderSettings = auto ?? parseAuto(true, options)
    const guardAuto = guard?.mode === "auto" ? deciderSettings : undefined
    try {
      const scan = await ctx.storage.scan({ prefix: CLASSIFY_KEY_PREFIX })
      for (const entry of scan.entries) {
        const value = readClassification(entry.value)
        if (value !== undefined) classified[entry.key.slice(CLASSIFY_KEY_PREFIX.length)] = value
      }
    } catch {
      // Classifications are looked up one by one instead.
    }
    let registration = await ctx.agent.transform(apply)
    let attempts = 0
    const controller = new AbortController()

    // Config and markdown agents load after user plugins, so their `model:` can
    // replace ours. Re-registering puts this transform last.
    // A change in availability or health re-registers even when nothing looks stale,
    // so a model that just became unavailable or unhealthy is replaced.
    const check = async (force: boolean) => {
      const agents = (await ctx.agent.list()).data
      // Config and markdown agents may have loaded after this transform ran, unseen by it.
      const late = planImplicit({
        agents: agents as ReadonlyArray<ClassifyAgent>,
        configured: options.agents,
        header: ROLE_HEADER,
        classified,
        failed: unclassifiable,
        autoGeneral: auto !== undefined,
      })
      options.implicit = { ...options.implicit, ...late.implicit }
      if (late.pending.length > 0) scheduleClassify(late.pending)
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

    /** Mark `ref` (or its provider) unhealthy; returns the cooldown it got. */
    const markFailed = async (ref: ModelRef, kind: FailureClass, error: FailureInput): Promise<number> => {
      const now = Date.now()
      const cooldownMs = cooldownFor(kind, error, now, runtime)
      const reason = `${kind}: ${oneLine(error.message ?? "")}`
      health = markUnhealthy(health, ref, now, cooldownMs, reason, failureScope(kind))
      try {
        await ctx.storage.set(HEALTH_KEY, health)
      } catch {
        // In-memory health still steers this instance.
      }
      attempts = 0
      await check(true)
      scheduleExpiry()
      return cooldownMs
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
      const cooldownMs = await markFailed(failed, kind, error)
      const isChild = typeof session.parentID === "string" && session.parentID !== ""
      const spawnRole = isChild ? await spawnRoleOf(sessionID) : undefined
      const role = spawnRole ?? (agent === undefined ? undefined : roleOf(agent, options.agents, options.implicit))
      const target = fallbackTarget(options, available, view(), role, failed)
      const facts: NoteFacts = { failed, kind, cooldownMs, target }
      if (isChild) {
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
      await notify(sessionID, failureNote(facts), "fallback")
    }

    /**
     * Move a failing request to the next healthy model of its session's role, inside
     * the same turn: the host reloads the session before each attempt, so the retry
     * goes to the switched model and nothing is replayed.
     */
    /** Model switches still landing, by session. A late one is never doubled. */
    const switching = new Map<string, Promise<boolean>>()

    /** `session.switchModel` bounded by `switchTimeoutMs`: "late" leaves it landing in the background. */
    const switchWithin = async (sessionID: string, model: ModelRef): Promise<"switched" | "late" | "failed"> => {
      const tracked: Promise<boolean> = Promise.resolve()
        .then(() => ctx.session.switchModel({ sessionID, model }))
        .then(
          () => true,
          () => false,
        )
        .finally(() => {
          if (switching.get(sessionID) === tracked) switching.delete(sessionID)
        })
      switching.set(sessionID, tracked)
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), runtime.switchTimeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
      })
      const outcome = await Promise.race([tracked.then((ok): "switched" | "failed" => (ok ? "switched" : "failed")), late])
      clearTimeout(timer)
      return outcome
    }

    const retries = await ctx.session.hook("retry", async (event) => {
      const error = event.error as FailureInput
      const kind = classifyFailure(error)
      if (kind === undefined || staysOnModel(kind, event.attempt, runtime.hostRetries)) return
      // A switch from an earlier retry is still landing: the host's next attempt reloads it.
      if (switching.has(event.sessionID)) return
      const { providerID, id, variant } = event.model as { providerID: string; id: string; variant?: string }
      const failed: ModelRef = variant ? { providerID, id, variant } : { providerID, id }
      try {
        await queue(async () => {
          const cooldownMs = await markFailed(failed, kind, error)
          const agent = (await listAgents()).find((a) => a.id === event.agent)
          const role = (await spawnRoleOf(event.sessionID)) ?? (agent === undefined ? undefined : roleOf(agent, options.agents, options.implicit))
          const target = retryTarget({
            options,
            available,
            health: view(),
            role,
            failed,
            kind,
            attempt: event.attempt,
            hostRetries: runtime.hostRetries,
          })
          if (target === undefined) return
          const outcome = await switchWithin(event.sessionID, target.model)
          const note = switchNote({ failed, kind, cooldownMs, target })
          if (outcome === "switched") {
            event.decision = { retry: true, delay: 0 }
            console.warn(`${SOURCE}: session ${event.sessionID}: ${note}`)
          } else
            console.warn(
              `${SOURCE}: session ${event.sessionID}: switching to ${target.model.providerID}/${target.model.id} ${outcome === "late" ? "is still pending" : "failed"}; the host's retry decision stands.`,
            )
        })
      } catch (error) {
        // The host's own retry decision stands.
        console.warn(`${SOURCE}: could not switch the failing request to another model`, error)
      }
    })

    const strip = await ctx.session.hook("model.request", (request) => {
      stripRoleHeader(request.headers)
    })

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: CHECK_TOOL,
        description:
          "Read-only report of every model tier's candidates, the model each tiered agent resolves to, and recent routing.\n" +
          "Lists every model tier's candidates with their status (available, unknown id, unknown variant, provider unavailable, unhealthy until a time) against all providers, the model each tiered agent resolves to, the tiers the subagent tool's `tier` parameter offers, the derived lineups and dropped models, and recent auto routing decisions.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await refresh()
          const agents = await listAgents()
          const report = checkRoles(options, available, agents, health, Date.now(), runtime.purposes, derived)
          const content = [formatCheck(report), ...formatHistory(autoHistory)].join("\n")
          return { content, metadata: { roles: report.roles.length, agents: report.agents.length, auto: autoHistory.length } }
        },
      })
    })

    /**
     * Offer `role` on the built-in `subagent` tool. The enum and the cost tiers follow
     * availability, not health, so the tool list only changes when models come or go.
     */
    const applySubagentTool = (editor: ToolEditor) => {
      const choices = roleChoices(options, available, runtime.purposes)
      if (!choices.some((choice) => choice.available)) return
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

    const judge = async (
      event: { sessionID: string; agent: string },
      target: string,
      override: ModelRef | undefined,
    ): Promise<string | undefined> => {
      if (guard === undefined) return undefined
      if (override !== undefined) {
        try {
          const agents = await listAgents()
          const decision = judgeModelOverride({ options, available, health: view(), guard, target, agents, sessionModel: undefined, model: override })
          return decision.allow ? undefined : decision.reason
        } catch {
          return undefined
        }
      }
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

    /** Ask the decider, bounded by `timeoutMs`. The host ignores abort signals here, so a late reply is dropped. */
    const decide = async (settings: AutoOptions, model: ModelRef, prompt: string): Promise<{ text?: string; failure?: "timeout" | "error" }> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<{ failure: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ failure: "timeout" }), settings.timeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
      })
      const call = ctx.generate.text({ prompt, model }).then(
        (result) => ({ text: result.text }),
        () => ({ failure: "error" as const }),
      )
      const outcome = await Promise.race([call, late])
      clearTimeout(timer)
      return outcome
    }

    const classifyQueue = serial()

    /** Classify one agent from its description, once per description: storage first, then the decider. */
    const classifyOne = async (agent: ClassifyAgent): Promise<boolean> => {
      const hash = agentHash(agent)
      const storageKey = `${CLASSIFY_KEY_PREFIX}${agent.id}`
      const stored = readClassification(await ctx.storage.get(storageKey).catch(() => undefined))
      const tiers = options.tiers ?? {}
      if (stored !== undefined && stored.hash === hash && Object.hasOwn(tiers, stored.tier)) {
        classified[agent.id] = stored
        return true
      }
      const model = deciderSettings === undefined ? undefined : deciderModel(deciderSettings, options, available, view())
      const reply =
        model === undefined || deciderSettings === undefined
          ? { failure: "error" as const }
          : await decide(
              { ...deciderSettings, timeoutMs: Math.max(deciderSettings.timeoutMs, CLASSIFY_TIMEOUT_MS) },
              model,
              buildClassifyPrompt(agent, tiers),
            )
      const tier = reply.text === undefined ? undefined : parseClassification(reply.text, Object.keys(tiers))
      if (tier === undefined) {
        unclassifiable.add(`${agent.id}\0${hash}`)
        console.warn(`${SOURCE}: could not classify agent '${agent.id}' (${reply.failure ?? "invalid reply"}); it runs on the standard tier for now`)
        return true
      }
      const value: Classification = { hash, tier }
      classified[agent.id] = value
      try {
        await ctx.storage.set(storageKey, value)
      } catch {
        // The in-memory classification still steers this instance.
      }
      console.warn(`${SOURCE}: classified agent '${agent.id}' as tier ${tier}`)
      return true
    }

    scheduleClassify = (agents) => {
      for (const agent of agents) {
        const key = `${agent.id}\0${agentHash(agent)}`
        if (classifying.has(key) || controller.signal.aborted) continue
        classifying.add(key)
        void classifyQueue(() => classifyOne(agent))
          .then(async (changed) => {
            if (!changed || controller.signal.aborted) return
            await queue(async () => {
              attempts = 0
              await check(true)
            })
          })
          .catch((error) => console.warn(`${SOURCE}: classifying agent '${agent.id}' failed`, error))
          .finally(() => classifying.delete(key))
      }
    }
    scheduleClassify(unscheduled)
    unscheduled = []

    /** The vendor of the model a spawning session runs on, for tiers that want another vendor. */
    const callerVendor = async (event: { sessionID: string; agent: string }): Promise<string | undefined> => {
      try {
        const [agents, session] = await Promise.all([listAgents(), ctx.session.get({ sessionID: event.sessionID })])
        const model = await runningModel(session as SessionLike, agents, event.agent)
        return model === undefined ? undefined : vendorOf(model)
      } catch {
        return undefined
      }
    }

    /** For a tier whose effort is `"auto"`, let the decider pick the model's variant. */
    const withAutoEffort = async (
      input: Record<string, unknown>,
      role: string,
      model: ModelRef,
    ): Promise<{ input: Record<string, unknown>; model: ModelRef }> => {
      if (auto === undefined || tierMeta(options, role)?.effort !== "auto") return { input, model }
      const listed = available.find((m) => m.providerID === model.providerID && m.id === model.id)
      const variants = (listed?.variants ?? []).map((v) => v.id)
      if (variants.length === 0) return { input, model }
      const decider = deciderModel(auto, options, available, view())
      if (decider === undefined) return { input, model }
      const prompt = buildEffortPrompt({
        tier: role,
        variants,
        description: typeof input.description === "string" ? input.description : undefined,
        prompt: typeof input.prompt === "string" ? input.prompt : "",
      })
      const reply = await decide(auto, decider, prompt)
      const effort = reply.text === undefined ? undefined : parseEffort(reply.text, variants)
      if (effort === undefined) return { input, model }
      const variant = nearestVariant(listed?.variants, effort) ?? effort
      const next: ModelRef = { providerID: model.providerID, id: model.id, variant }
      return { input: { ...input, model: modelLabel(next) }, model: next }
    }

    type Routed = { input: Record<string, unknown>; role: string; model: ModelRef }

    /**
     * Pick a role for a spawn that names none. `cheapOnly` (the guard's auto mode)
     * offers only roles whose model is not expensive. Returns `undefined` when the
     * spawn is not eligible or no allowed role resolves; the spawn then goes on as is.
     */
    const route = async (
      event: { sessionID: string; agent: string },
      target: string,
      input: unknown,
      settings: AutoOptions,
      cheapOnly: boolean,
    ): Promise<Routed | undefined> => {
      const agents = await listAgents()
      const agent = agents.find((a) => a.id === target)
      if (!cheapOnly && target !== AUTO_AGENT) return undefined
      if (!autoEligible(input, agent, options) || !isRecord(input)) return undefined
      const health = view()
      const choices = choicesFor(settings.roles, options, available, runtime.purposes).filter((choice) => {
        if (!choice.available) return false
        if (!cheapOnly || guard === undefined) return true
        const model = resolveRole(options.roles, available, choice.role, health).model
        return model !== undefined && !isExpensive(model, guard, options.classes)
      })
      const allowed = choices.map((choice) => choice.role)
      const fallback = allowed.includes(settings.default) ? settings.default : allowed[0]
      if (fallback === undefined) return undefined
      const started = Date.now()
      const decider = deciderModel(settings, options, available, health)
      let picked: { role: string; reason: AutoReason }
      if (decider === undefined) picked = pickRole(undefined, { default: fallback }, "no-decider")
      else {
        const prompt = buildDeciderPrompt({
          agent: { id: target, description: agent?.description },
          description: typeof input.description === "string" ? input.description : undefined,
          prompt: typeof input.prompt === "string" ? input.prompt : "",
          choices,
        })
        const reply = await decide(settings, decider, prompt)
        picked =
          reply.failure !== undefined
            ? pickRole(undefined, { default: fallback }, reply.failure)
            : pickRole(parseDecision(reply.text ?? "", allowed), { default: fallback })
      }
      let role = picked.role
      let capped: string | undefined
      if (settings.capAtParent) {
        const session = (await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)) as SessionLike
        const parent = await runningModel(session, agents, event.agent).catch(() => undefined)
        const parentCost = parent === undefined ? undefined : rankOf(parent, options.classes)
        const next = capRole(role, roleCosts(allowed, options, available, health), parentCost)
        if (next !== role) {
          capped = role
          role = next
        }
      }
      const vendor = tierMeta(options, role)?.distinctVendor ? await callerVendor(event) : undefined
      const plan = planSpawn({ ...input, tier: role }, options, available, health, vendor)
      if (plan.model === undefined || !isRecord(plan.input)) return undefined
      const record: AutoRecord = { at: started, agent: target, role, reason: picked.reason, model: plan.model, ms: Date.now() - started }
      if (capped !== undefined) record.capped = capped
      autoHistory = pushHistory(autoHistory, record)
      console.warn(`${SOURCE}: auto-routed '${target}' to role ${role} (${picked.reason}${capped ? `, capped from ${capped}` : ""})`)
      return { input: { ...plan.input, description: withAutoTag(input.description, record) }, role, model: plan.model }
    }

    /** The tier a spawn passes (`tier`, else the deprecated `role`). */
    const passedTier = (input: unknown): string | undefined => {
      if (!isRecord(input)) return undefined
      for (const key of [TIER_PARAM, ROLE_PARAM]) {
        const value = input[key]
        if (typeof value === "string" && value.trim() !== "") return value.trim()
      }
      return undefined
    }

    const spawns = await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== SUBAGENT_TOOL) return
      const passed = passedTier(event.input)
      const vendor = passed !== undefined && tierMeta(options, passed)?.distinctVendor ? await callerVendor(event) : undefined
      let plan = planSpawn(event.input, options, available, view(), vendor)
      if (plan.error !== undefined) throw new Error(plan.error)
      if (plan.input !== event.input) event.input = plan.input
      const target = spawnTarget(plan.input)
      if (target === undefined) return
      // An agent on a tier that wants another vendor than the caller's is moved per spawn.
      if (plan.role === undefined && inputModel(plan.input) === undefined && isRecord(plan.input)) {
        const agent = (await listAgents().catch(() => [] as Agents)).find((a) => a.id === target)
        const own = agent === undefined ? undefined : roleOf(agent, options.agents, options.implicit)
        if (own !== undefined && tierMeta(options, own)?.distinctVendor) {
          const model = resolveTier(options, available, own, view(), await callerVendor(event)).model
          if (model !== undefined) {
            plan = { input: { ...plan.input, model: modelLabel(model) }, role: own, model }
            event.input = plan.input
          }
        }
      }
      if (plan.role !== undefined && plan.model !== undefined) {
        let model = plan.model
        if (isRecord(plan.input)) {
          const tuned = await withAutoEffort(plan.input, plan.role, plan.model).catch(() => undefined)
          if (tuned !== undefined) {
            event.input = tuned.input
            model = tuned.model
          }
        }
        pending.set(event.id, { parentID: event.sessionID, agent: target, role: plan.role, model, at: Date.now() })
        return
      }
      const override = inputModel(plan.input)
      const unroled = override === undefined && plan.role === undefined
      const accept = (routed: Routed) => {
        event.input = routed.input
        pending.set(event.id, { parentID: event.sessionID, agent: target, role: routed.role, model: routed.model, at: Date.now() })
      }
      if (unroled && auto !== undefined) {
        const routed = await route(event, target, plan.input, auto, false).catch(() => undefined)
        if (routed !== undefined) return accept(routed)
      }
      const reason = await judge(event, target, override)
      if (reason === undefined) return
      if (unroled && guardAuto !== undefined) {
        const routed = await route(event, target, plan.input, guardAuto, true).catch(() => undefined)
        if (routed !== undefined) return accept(routed)
      }
      throw new Error(reason)
    })

    // The `/tiers` TUI dialog reads the tier table and writes `options.tiers` through these.
    const configDir = () => globalConfigDir(process.env, homedir())
    const rpc = await ctx.rpc.register(TiersRpc, {
      state: async () => {
        await queue(async () => {
          await refresh()
        })
        const file = (() => {
          try {
            return pickConfigFile(readConfigFiles(configDir()))
          } catch {
            return undefined
          }
        })()
        const configured: Record<string, TierConfig> = {}
        for (const [name, value] of Object.entries(file === undefined ? settings.tiers : readTiers(file.text)))
          configured[name] = parseTierConfig(value)
        return tierState({
          options,
          available,
          configured,
          ...(file === undefined
            ? { error: `No model-roles plugin entry in the global config (${configDir()}); /tiers cannot save.` }
            : { config: file.path }),
        })
      },
      set: async (input) => {
        const { tier, value } = (input ?? {}) as { tier?: unknown; value?: unknown }
        if (typeof tier !== "string" || !/^[a-z][a-z0-9-]*$/.test(tier)) throw new Error(`Invalid tier name ${JSON.stringify(tier)}`)
        const config = value === null || value === undefined ? undefined : compact(parseTierConfig(value))
        const result = writeTier(configDir(), tier, config)
        console.warn(`${SOURCE}: ${config === undefined ? "removed" : "set"} tier ${tier} in ${result.path}`)
        return result
      },
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
          const cooldownMs = await markFailed(failed, kind, { message })
          const role = spawn?.role ?? (agent === undefined ? undefined : roleOf(agent, options.agents, options.implicit))
          const target = fallbackTarget(options, available, view(), role, failed)
          const facts: NoteFacts = { failed, kind, cooldownMs, target }
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
      await rpc.dispose()
      await spawns.dispose()
      await subagentTool.dispose()
      await tools.dispose()
      await strip.dispose()
      await retries.dispose()
      await registration.dispose()
      await references.dispose()
      notices.clear()
      childFailures.clear()
      pending.clear()
      childRoles.clear()
      autoHistory = []
    }
  },
})
