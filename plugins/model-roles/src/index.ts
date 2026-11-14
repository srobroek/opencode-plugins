import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionRetry } from "@opencode/plugin/promise/session"
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
import { candidateStatus, checkRoles, formatCheck } from "./check.ts"
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
import { type ConfigFile, type EffectiveConfig, effectiveConfig, globalConfigDir, pickConfigFile, readConfigFiles, readProjectFiles, readTiers, writeAgentTier, writeTier } from "./config-edit.ts"
import {
  duration,
  failureNote,
  fallbackTarget,
  type NoteFacts,
  retriesOnModel,
  retryDelay,
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
  type FailureClass,
  type FailureInput,
  failureScope,
  HEALTH_KEY,
  type HealthState,
  healthKey,
  healthView,
  modelFromError,
  nextExpiry,
  pruneHealth,
  RECENT_MS,
  readHealth,
  recordFailure,
} from "./health.ts"
import { hostWarn } from "./log.ts"
import { decideFailureNotice, decideRecovery, type FailureReport, forgetSession, NOTICE_DEDUPE_MS, newNoticeState, type RequestLog, recordRequest, settleRequest } from "./outage.ts"
import { explainSpawn, formatReceipts, pushReceipt, RECEIPTS_KEY, type Receipt, readReceipts, type SpawnRule, type SpawnSource } from "./receipt.ts"
import {
  type AvailableModel,
  desiredModels,
  FALLBACK_HEADER,
  type ModelRef,
  type Options,
  parseCandidate,
  parseOptions,
  ROLE_HEADER,
  resolveRole,
  roleOf,
  sameModel,
  staleAgents,
  stripRoleHeader,
  userPin,
} from "./resolve.ts"
import { TiersRpc } from "./rpc.ts"
import { configRevision, type ModelSnapshot, readSnapshot, SPAWN_MODEL_KEY_PREFIX, snapshotModel, staleSnapshots, unavailableReason } from "./snapshot.ts"
import {
  applyFrozenTierParam,
  captureTierParam,
  choicesFor,
  type FrozenTierParam,
  inputModel,
  modelLabel,
  parseRuntime,
  planSpawn,
  ROLE_ALIAS_DESCRIPTION,
  ROLE_PARAM,
  readFrozenTierParam,
  roleChoices,
  roleParamDescription,
  SPAWN_ROLE_KEY_PREFIX,
  TIER_FREEZE_KEY_PREFIX,
  TIER_PARAM,
  toJsonSchema,
  withRoleNote,
  withRoleParam,
} from "./spawn-role.ts"
import {
  buildTiers,
  candidateOrder,
  explicitCandidates,
  INHERIT_NAMES,
  parseTierConfig,
  parseTierSettings,
  rankOf,
  resolveTier,
  TIER_ALIASES,
  type TierConfig,
  tierMeta,
  tierOf,
  tierWarnings,
} from "./tiers.ts"
import { agentTierError, applyDraft, compact, readDraft, TIER_NAME, tierState, validateTierConfig } from "./tiers-ui.ts"

export * from "./auto.ts"
export * from "./catalog.ts"
export * from "./check.ts"
export * from "./classify.ts"
export * from "./config-edit.ts"
export * from "./fallback.ts"
export * from "./guard.ts"
export * from "./health.ts"
export * from "./receipt.ts"
export * from "./resolve.ts"
export { TiersRpc } from "./rpc.ts"
export * from "./spawn-role.ts"
export * from "./tiers.ts"
export * from "./tiers-ui.ts"

/** Re-registrations allowed in a row without the agents converging, before giving up until inputs change. */
export const MAX_REREGISTER = 3

export { NOTICE_DEDUPE_MS }

export const CHECK_TOOL = "model_roles_check"

/** How far up the parent chain a session's inherited model is looked for. */
export const MAX_SESSION_DEPTH = 8

const REFRESH_EVENTS = new Set(["model.updated", "provider.updated"])
const CHECK_EVENTS = new Set(["agent.updated", ...REFRESH_EVENTS])
const FAILED_EVENT = "session.execution.failed"
const INTERRUPTED_EVENT = "session.execution.interrupted"
const DELETED_EVENT = "session.deleted"
/** When an event happened (`created`, ms), else unbounded, so every recorded request counts. */
const endedAt = (event: unknown): number => {
  const created = (event as { created?: unknown }).created
  return typeof created === "number" && Number.isFinite(created) ? created : Number.POSITIVE_INFINITY
}
const SUCCEEDED_EVENT = "session.execution.succeeded"
const CREATED_EVENT = "session.created"
/** The host reloaded its config; a `/tiers` save or a hand edit of the global file lands here too. */
const CONFIG_EVENT = "config.updated"

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
    // Bound to the fiber running setup, so it must come before the first await.
    const warn = hostWarn(SOURCE)
    let settings = parseTierSettings(ctx.options)
    const options: Options = { ...parseOptions(ctx.options), tiers: {}, classes: {}, implicit: {} }
    const runtime = parseRuntime(ctx.options, options)
    const guard = parseGuard(isRecord(ctx.options) ? ctx.options.guard : undefined)
    let autoHistory: AutoRecord[] = []
    let available: GuardModel[] = []
    let availableKey = ""
    let refs: ReferenceIndex = new Map()
    /** Every model the provider definitions know, connected or not, for validating `/tiers` saves. */
    let catalog: CatalogModel[] = []
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
        catalog = editor.provider.list().flatMap((definition) => [...definition.models.values()] as CatalogModel[])
        refs = buildReferenceIndex(catalog)
      } catch {
        // Keep the last index.
      }
    })
    let health: HealthState = {}
    try {
      health = pruneHealth(readHealth(await ctx.storage.get(HEALTH_KEY)), Date.now(), runtime.flapWindowMs)
    } catch {
      health = {}
    }
    const view = () => healthView(health, Date.now())
    const queue = serial()
    const noticeState = newNoticeState()
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
          // Marks the model as this plugin's, so a later look at the agent does not take it for a user pin.
          const shape = draft as { request?: { headers?: Record<string, string> } }
          shape.request ??= {}
          shape.request.headers = { ...shape.request.headers, [FALLBACK_HEADER]: modelLabel(ref) }
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
    // Child snapshots are bounded: expired and surplus entries go at startup.
    try {
      const entries: Array<{ key: string; value: unknown }> = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix: SPAWN_MODEL_KEY_PREFIX, ...(after === undefined ? {} : { after }) })
        entries.push(...page.entries)
        after = page.next
      } while (after !== undefined)
      for (const key of staleSnapshots(entries, Date.now())) await ctx.storage.remove(key)
    } catch {
      // Stale snapshots wait for the next start.
    }
    let registration = await ctx.agent.transform(apply)
    let attempts = 0
    /** Agents still off their tier's model after re-registering gave up. */
    let stuck: string[] = []
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
      const stale = staleAgents(agents, desired)
      if (!force && stale.length === 0) {
        attempts = 0
        stuck = []
        return
      }
      if (controller.signal.aborted) return
      if (attempts >= MAX_REREGISTER) {
        if (stale.join("\0") !== stuck.join("\0") && stale.length > 0)
          warn(`re-registering gave up after ${MAX_REREGISTER} tries; agents ${stale.join(", ")} still run another model than their tier resolves to`)
        stuck = stale
        return
      }
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
            health = pruneHealth(health, Date.now(), runtime.flapWindowMs)
            attempts = 0
            await check(true)
            scheduleExpiry()
          }).catch(() => {}),
        at - now + 10,
      )
      ;(expiry as { unref?: () => void }).unref?.()
    }
    scheduleExpiry()

    /**
     * Record a failure of `ref` (or its provider); returns how long it now sits out, 0
     * while it stays in use. Tiers are resolved again only when that changed.
     */
    const markFailed = async (ref: ModelRef, kind: FailureClass, error: FailureInput): Promise<number> => {
      // Health keeps the failure class only: the provider's message can hold prompt text or credentials.
      const record = recordFailure(health, ref, kind, error, Date.now(), runtime)
      health = record.state
      try {
        await ctx.storage.set(HEALTH_KEY, health)
      } catch {
        // In-memory health still steers this instance.
      }
      if (record.tripped) {
        attempts = 0
        await check(true)
        scheduleExpiry()
      }
      return record.cooldownMs
    }

    const notify = async (sessionID: string, text: string, kind: string) => {
      warn(text)
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

    /** Tell `report.notifyTo` about a failure unless an outage or an earlier note already did. */
    const announce = async (report: FailureReport) => {
      const notice = decideFailureNotice(noticeState, report)
      if (notice === undefined) return
      await notify(notice.sessionID, notice.text, report.subagent === undefined ? "fallback" : "subagent-fallback")
    }

    /**
     * Primary requests by session, from the `model.request` hook. An execution's end event
     * carries only its session and `created` time, so it is matched to the request started by then.
     */
    const requestLog: RequestLog = new Map()

    /** A request succeeded on `model`: end the provider outages it was in, and forget `sessionID` as stopped. */
    const onSessionSucceeded = async (sessionID: string, model: ModelRef | undefined) => {
      forgetSession(noticeState, sessionID)
      if (model === undefined) return
      for (const notice of decideRecovery(noticeState, model)) await notify(notice.sessionID, notice.text, "recovery")
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
    type PendingSpawn = { parentID: string; agent: string; role: string; model: ModelRef; revision: string; at: number; childID?: string }
    const pending = new Map<string, PendingSpawn>()
    /** The role each child session was spawned with. */
    const childRoles = new Map<string, string>()

    /** The last spawns this plugin routed, newest first. */
    let receipts: Receipt[] = readReceipts(await ctx.storage.get(RECEIPTS_KEY).catch(() => undefined))
    const recordReceipt = async (receipt: Receipt) => {
      receipts = pushReceipt(receipts, receipt)
      const asked = receipt.tier === undefined ? "" : ` (tier ${receipt.tier})`
      for (const warning of receipt.warnings) warn(`spawn of '${receipt.agent}'${asked}: ${warning}`)
      try {
        await ctx.storage.set(RECEIPTS_KEY, receipts as never)
      } catch {
        // The in-memory receipts still show in the check.
      }
    }

    const recordChildRole = async (childID: string, role: string) => {
      if (childRoles.get(childID) === role) return
      childRoles.set(childID, role)
      try {
        await ctx.storage.set(`${SPAWN_ROLE_KEY_PREFIX}${childID}`, role)
      } catch {
        // The in-memory record still steers this instance.
      }
    }

    /** A child rerouted to a bare model has no tier any more: a retry must not read the old one. */
    const forgetChildRole = async (childID: string) => {
      childRoles.delete(childID)
      await ctx.storage.remove(`${SPAWN_ROLE_KEY_PREFIX}${childID}`).catch(() => {})
    }

    const spawnRoleOf = async (childID: string): Promise<string | undefined> => {
      const known = childRoles.get(childID)
      if (known !== undefined) return known
      const stored = await ctx.storage.get(`${SPAWN_ROLE_KEY_PREFIX}${childID}`).catch(() => undefined)
      return typeof stored === "string" && Object.hasOwn(options.roles, stored) ? stored : undefined
    }

    /** The model each child resolved to, by child id; storage keeps it across reloads. */
    const childModels = new Map<string, ModelSnapshot>()

    const snapshotOf = async (childID: string): Promise<ModelSnapshot | undefined> => {
      const known = childModels.get(childID)
      if (known !== undefined) return known
      return readSnapshot(await ctx.storage.get(`${SPAWN_MODEL_KEY_PREFIX}${childID}`).catch(() => undefined))
    }

    const writeSnapshot = async (childID: string, snapshot: ModelSnapshot) => {
      childModels.set(childID, snapshot)
      try {
        await ctx.storage.set(`${SPAWN_MODEL_KEY_PREFIX}${childID}`, snapshot as never)
      } catch {
        // The in-memory snapshot still steers this instance.
      }
    }

    /**
     * Every fresh spawn that will create a child, by tool call id, until the child is matched or the call ends.
     * `planned` is what the plugin resolved (none when the host decides); the child's own model is what counts.
     */
    type ExpectedChild = { parentID: string; agent: string; planned?: ModelRef; tier?: string; configRevision: string; at: number; childID?: string }
    const expectedChildren = new Map<string, ExpectedChild>()
    const expectChild = (callID: string, event: { sessionID: string }, agent: string, planned: ModelRef | undefined, tier: string | undefined) => {
      expectedChildren.set(callID, { parentID: event.sessionID, agent, ...(planned === undefined ? {} : { planned }), ...(tier === undefined ? {} : { tier }), configRevision: configRevision(options), at: Date.now() })
    }

    /** Keep the model a child really got for its lifetime. The first record wins: failover may have updated it since. */
    const recordChildModel = async (childID: string, spawn: ExpectedChild, actual: ModelRef | undefined) => {
      const model = actual ?? spawn.planned
      if (model === undefined || (await snapshotOf(childID)) !== undefined) return
      await writeSnapshot(childID, { model: modelLabel(model), ...(spawn.tier === undefined ? {} : { tier: spawn.tier }), configRevision: spawn.configRevision, at: Date.now() })
    }

    /** Pair a new child with its own spawn call: the exact model and variant first, then the model, then a spawn the host decides, then the only one left. */
    const matchExpected = async (data: { sessionID?: unknown; parentID?: unknown; agent?: unknown; model?: unknown }): Promise<boolean> => {
      if (typeof data.sessionID !== "string" || typeof data.parentID !== "string" || !isRecord(data.model)) return false
      const actual = data.model as ModelRef
      const now = Date.now()
      for (const [id, spawn] of expectedChildren) {
        if (now - spawn.at > PENDING_SPAWN_MS) expectedChildren.delete(id)
      }
      const open = [...expectedChildren].filter(([, e]) => e.childID === undefined && e.parentID === data.parentID && e.agent === data.agent)
      const picked =
        open.find(([, e]) => e.planned !== undefined && modelLabel(e.planned) === modelLabel(actual)) ??
        open.find(([, e]) => e.planned !== undefined && healthKey(e.planned) === healthKey(actual)) ??
        open.find(([, e]) => e.planned === undefined) ??
        (open.length === 1 ? open[0] : undefined)
      if (picked === undefined) return false
      const [callID, spawn] = picked
      spawn.childID = data.sessionID
      await recordChildModel(data.sessionID, spawn, actual)
      const roleSpawn = pending.get(callID)
      if (roleSpawn !== undefined) {
        roleSpawn.childID = data.sessionID
        await recordChildRole(data.sessionID, roleSpawn.role)
      }
      return true
    }

    /** Failover moved a child: a resume continues on the model that worked, and an evaluation can tell. */
    const recordFailover = async (childID: string, model: ModelRef, role: string | undefined) => {
      const known = await snapshotOf(childID)
      if (known === undefined && role === undefined) return
      await writeSnapshot(childID, {
        ...(known ?? { configRevision: configRevision(options) }),
        ...(known?.tier === undefined && role !== undefined ? { tier: role } : {}),
        model: modelLabel(model),
        at: Date.now(),
        failedOver: true,
      })
    }

    /** Match a new child session to the role spawn that created it: same parent, agent and model. */
    const onSessionCreated = async (data: { sessionID?: unknown; parentID?: unknown; agent?: unknown; model?: unknown }) => {
      if (await matchExpected(data)) return
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
        warn(`session ${sessionID} failed (${kind}) on an unknown model; nothing marked unhealthy`)
        return
      }
      const cooldownMs = await markFailed(failed, kind, error)
      const isChild = typeof session.parentID === "string" && session.parentID !== ""
      const spawnRole = isChild ? await spawnRoleOf(sessionID) : undefined
      const role = spawnRole ?? (agent === undefined ? undefined : roleOf(agent, options.agents, options.implicit))
      // A model that stays in use keeps its tier where it was: nothing moves.
      const target = cooldownMs > 0 ? fallbackTarget(options, available, view(), role, failed) : undefined
      const facts: NoteFacts = { failed, kind, cooldownMs, target }
      if (isChild) {
        childFailures.set(session.parentID as string, Date.now())
        // A child spawned with a role follows that role: move it on, so resuming it continues on the next model.
        let resumable: string | undefined = cooldownMs > 0 ? undefined : sessionID
        if (spawnRole !== undefined && target !== undefined) {
          try {
            await ctx.session.switchModel({ sessionID, model: target.model })
            await recordFailover(sessionID, target.model, spawnRole)
            resumable = sessionID
          } catch {
            // Spawning again with the role still works.
          }
        }
        const note = subagentNote({ ...facts, agent: session.agent, spawnRole, resumable })
        await announce({
          ...facts,
          now: Date.now(),
          notifyTo: session.parentID as string,
          subagent: { agent: session.agent, sessionID },
          plain: note,
        })
        return
      }
      if (failureScope(kind) === "provider" || cooldownMs > 0) await announce({ ...facts, now: Date.now(), notifyTo: sessionID })
      else warn(`session ${sessionID}: ${failureNote(facts)}`)
    }

    /**
     * Move a failing request to the next healthy model of its session's role, inside
     * the same turn: the host reloads the session before each attempt, so the retry
     * goes to the switched model and nothing is replayed.
     */
    /** Model switches still landing, by session. A late one is never doubled. */
    const switching = new Map<string, Promise<boolean>>()

    /** `session.switchModel` bounded by `switchTimeoutMs`: "late" leaves it landing in the background. */
    const switchWithin = async (sessionID: string, model: ModelRef, role: string | undefined): Promise<"switched" | "late" | "failed"> => {
      const tracked: Promise<boolean> = Promise.resolve()
        .then(() => ctx.session.switchModel({ sessionID, model }))
        .then(
          // A switch that lands after the timeout still moved the child: its snapshot follows.
          async () => {
            await recordFailover(sessionID, model, role).catch(() => {})
            return true
          },
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

    /** Retry a transient failure on its model with backoff when the host would not retry it. */
    const keepOnModel = (event: SessionRetry, kind: FailureClass, failed: ModelRef) => {
      if (event.decision.retry || !retriesOnModel(kind, event.attempt, runtime.hostRetries)) return
      const delay = retryDelay(event.attempt)
      event.decision = { retry: true, delay }
      warn(`session ${event.sessionID}: ${modelLabel(failed)} failed (${kind}); retrying it in ${duration(delay)}.`)
    }

    /**
     * The models each session's current run of retries already failed on, by health key. A
     * request never goes back to one, however slowly they fail, so switching ends.
     */
    const triedModels = new Map<string, Set<string>>()

    const retries = await ctx.session.hook("retry", async (event) => {
      // The first retry of a request starts a fresh run.
      if (event.attempt <= 2) triedModels.delete(event.sessionID)
      const error = event.error as FailureInput
      const kind = classifyFailure(error)
      if (kind === undefined) return
      const { providerID, id, variant } = event.model as { providerID: string; id: string; variant?: string }
      const failed: ModelRef = variant ? { providerID, id, variant } : { providerID, id }
      if (staysOnModel(kind, event.attempt, runtime.hostRetries)) return keepOnModel(event, kind, failed)
      // A switch from an earlier retry is still landing: the host's next attempt reloads it.
      if (switching.has(event.sessionID)) return keepOnModel(event, kind, failed)
      try {
        await queue(async () => {
          const cooldownMs = await markFailed(failed, kind, error)
          const agent = (await listAgents()).find((a) => a.id === event.agent)
          const spawnRole = await spawnRoleOf(event.sessionID)
          const role = spawnRole ?? (agent === undefined ? undefined : roleOf(agent, options.agents, options.implicit))
          const tried = triedModels.get(event.sessionID) ?? new Set<string>()
          triedModels.set(event.sessionID, tried.add(healthKey(failed)))
          const recent = healthView(health, Date.now(), RECENT_MS)
          const target = retryTarget({
            options,
            available,
            health: (ref) => (tried.has(healthKey(ref)) ? 0 : recent(ref)),
            role,
            failed,
            kind,
            attempt: event.attempt,
            hostRetries: runtime.hostRetries,
          })
          if (target === undefined) return keepOnModel(event, kind, failed)
          const outcome = await switchWithin(event.sessionID, target.model, spawnRole)
          const note = switchNote({ failed, kind, cooldownMs, target })
          if (outcome === "switched") {
            event.decision = { retry: true, delay: 0 }
            warn(`session ${event.sessionID}: ${note}`)
            return
          }
          warn(
            `session ${event.sessionID}: switching to ${target.model.providerID}/${target.model.id} ${outcome === "late" ? "is still pending" : "failed"}.`,
          )
          // The switch did not happen this time: a transient failure still gets its retry.
          keepOnModel(event, kind, failed)
        })
      } catch (error) {
        // The host's own retry decision stands.
        warn(`could not switch the failing request to another model`, { error: String(error) })
      }
    })

    const strip = await ctx.session.hook("model.request", (request) => {
      stripRoleHeader(request.headers)
      const { sessionID, model, kind } = request as { sessionID?: string; model?: ModelRef; kind?: string }
      if (typeof sessionID === "string" && model !== undefined && (kind === undefined || kind === "primary"))
        recordRequest(requestLog, sessionID, model, Date.now())
    })

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: CHECK_TOOL,
        description:
          "Read-only report of every model tier's candidates, the model each tiered agent resolves to, and recent routing.\n" +
          "Lists every model tier's candidates with their status (available, unknown id, unknown variant, provider unavailable, unhealthy until a time) against all providers, the model each tiered agent resolves to, the tiers the subagent tool's `tier` parameter offers, the derived lineups and dropped models, warnings about candidates that drop the tier effort, recent spawn receipts (tier and where from, model, winning precedence rule, fallbacks), and recent auto routing decisions.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await refresh()
          const agents = await listAgents()
          const report = checkRoles(options, available, agents, health, Date.now(), runtime.purposes, derived)
          report.warnings.push(...tierWarnings(settings, { roles: options.roles, tiers: options.tiers ?? {} }, available as CatalogModel[]))
          if (stuck.length > 0)
            report.warnings.push(
              `Agents ${stuck.join(", ")} still run another model than their tier resolves to: re-registering gave up after ${MAX_REREGISTER} tries (a later plugin or config keeps setting their model).`,
            )
          const content = [formatCheck(report), ...formatReceipts(receipts), ...formatHistory(autoHistory)].join("\n")
          return { content, metadata: { roles: report.roles.length, agents: report.agents.length, auto: autoHistory.length, spawns: receipts.length } }
        },
      })
    })

    /**
     * Offer `role` on the built-in `subagent` tool. The enum and the cost tiers follow
     * availability, not health, so the tool list only changes when models come or go, and
     * then only for new sessions (see the session hooks below).
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

    // The transform above is global, but each request's tools pass through the session hooks:
    // a session keeps the tier parameter it first saw, so availability or `/tiers` changes
    // never rewrite the cached tool prefix of a running session.
    const frozenTiers = new Map<string, Promise<FrozenTierParam>>()
    const frozenTier = (sessionID: string, input: unknown): Promise<FrozenTierParam> => {
      const known = frozenTiers.get(sessionID)
      if (known !== undefined) return known
      const key = `${TIER_FREEZE_KEY_PREFIX}${sessionID}`
      const loaded = (async () => {
        const stored = readFrozenTierParam(await ctx.storage.get(key).catch(() => undefined))
        if (stored !== undefined) return stored
        const fresh = captureTierParam(input)
        await ctx.storage.set(key, fresh as never).catch(() => {})
        return fresh
      })()
      frozenTiers.set(sessionID, loaded)
      return loaded
    }
    const freezeTiers = async (event: { sessionID: string; tools: Record<string, { description: string; input: unknown }> }) => {
      const tool = event.tools[SUBAGENT_TOOL]
      if (tool === undefined) return
      const next = applyFrozenTierParam(tool, await frozenTier(event.sessionID, tool.input))
      tool.description = next.description
      tool.input = next.input as typeof tool.input
    }
    const freezeHooks = [
      await ctx.session.hook("context", freezeTiers),
      await ctx.session.hook("compaction", freezeTiers),
      await ctx.session.hook("generate", freezeTiers),
    ]

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
        warn(`could not classify agent '${agent.id}' (${reply.failure ?? "invalid reply"}); it runs on the standard tier for now`)
        return true
      }
      const value: Classification = { hash, tier }
      classified[agent.id] = value
      try {
        await ctx.storage.set(storageKey, value)
      } catch {
        // The in-memory classification still steers this instance.
      }
      warn(`classified agent '${agent.id}' as tier ${tier}`)
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
          .catch((error) => warn(`classifying agent '${agent.id}' failed`, { error: String(error) }))
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

    /** What `withAutoEffort` decided, for the receipt: the rule, and why `auto` fell back if it did. */
    type AutoEffort = { rule: SpawnRule; fallback?: string }
    type Tuned = { input: Record<string, unknown>; model: ModelRef; effort?: AutoEffort }

    /**
     * For a tier whose effort is `"auto"`, let the decider pick the model's variant. When it
     * cannot (auto routing off, no decider model, a failed, slow or invalid reply), the spawn
     * runs at the effort the tier would have without `auto`. A candidate's own variant wins.
     */
    const withAutoEffort = async (input: Record<string, unknown>, role: string, model: ModelRef): Promise<Tuned> => {
      const meta = tierMeta(options, role)
      // An old role name with an effort of its own (`tiny`) keeps it.
      if (meta?.effort !== "auto" || TIER_ALIASES[role]?.effort !== undefined) return { input, model }
      // Only a variant the tier's own candidate names wins; one a linked tier set is the decider's to pick.
      const explicit = explicitCandidates(settings, tierOf(role)).some((entry) => {
        const candidate = parseCandidate(entry)
        return candidate?.kind === "model" && candidate.ref.variant !== undefined && sameModel(candidate.ref, model)
      })
      if (explicit) return { input, model }
      const listed = available.find((m) => m.providerID === model.providerID && m.id === model.id)
      const variants = (listed?.variants ?? []).map((v) => v.id)
      if (variants.length === 0) return { input, model }
      const at = (variant: string, effort: AutoEffort): Tuned => {
        const next: ModelRef = { providerID: model.providerID, id: model.id, variant }
        return { input: { ...input, model: modelLabel(next) }, model: next, effort }
      }
      const fallBack = (reason: string): Tuned => {
        const fallback = `effort auto fell back to ${meta.autoFallback ?? "the model default"}: ${reason}`
        const variant = meta.autoFallback === undefined ? undefined : nearestVariant(listed?.variants, meta.autoFallback)
        if (variant === undefined) return { input, model, effort: { rule: "model-default", fallback } }
        return at(variant, { rule: meta.autoFallbackFrom === "base" ? "base-tier-effort" : "builtin-effort", fallback })
      }
      if (auto === undefined) return fallBack("auto routing is off")
      const decider = deciderModel(auto, options, available, view())
      if (decider === undefined) return fallBack("no decider model is available")
      const prompt = buildEffortPrompt({
        tier: role,
        variants,
        description: typeof input.description === "string" ? input.description : undefined,
        prompt: typeof input.prompt === "string" ? input.prompt : "",
      })
      const reply = await decide(auto, decider, prompt)
      if (reply.failure !== undefined) return fallBack(`the decider ${reply.failure === "timeout" ? "timed out" : "failed"}`)
      const effort = parseEffort(reply.text ?? "", variants)
      if (effort === undefined) return fallBack("the decider gave no valid effort")
      return at(nearestVariant(listed?.variants, effort) ?? effort, { rule: "auto-effort" })
    }

    /** Where a spawn's tier came from, and the old role name when it passed one. */
    type Asked = { source: SpawnSource; name: string }

    /** The receipt for a spawn that runs on a tier's model. */
    const tierReceipt = (agent: string, asked: Asked, tuned: Tuned, callerVendor?: string): Receipt => {
      const tier = tierOf(asked.name)
      const aliasEffort = TIER_ALIASES[asked.name]?.effort
      const base = tierMeta(options, asked.name)
      const meta = base === undefined || aliasEffort === undefined ? base : { ...base, effort: aliasEffort, effortFrom: "tier" as const }
      const explained = explainSpawn({
        tier,
        model: tuned.model,
        meta,
        explicit: explicitCandidates(settings, tier),
        order: candidateOrder(options, asked.name, callerVendor),
        models: available,
        roles: options.roles,
        health,
        now: Date.now(),
      })
      const receipt: Receipt = { at: Date.now(), agent, source: asked.source, tier, model: modelLabel(tuned.model), ...explained }
      if (asked.name !== tier) receipt.alias = asked.name
      if (tuned.effort !== undefined) {
        receipt.rule = tuned.effort.rule
        if (tuned.effort.fallback !== undefined) receipt.warnings = [...receipt.warnings, tuned.effort.fallback]
      }
      return receipt
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
      warn(`auto-routed '${target}' to role ${role} (${picked.reason}${capped ? `, capped from ${capped}` : ""})`)
      return { input: { ...plan.input, description: withAutoTag(input.description, record) }, role, model: plan.model }
    }

    /** The tier a spawn passes (`tier`, else the deprecated `role`), and which parameter it came in. */
    const passedTier = (input: unknown): Asked | undefined => {
      if (!isRecord(input)) return undefined
      for (const [key, source] of [
        [TIER_PARAM, "tier-param"],
        [ROLE_PARAM, "role-param"],
      ] as const) {
        const value = input[key]
        if (typeof value === "string" && value.trim() !== "") return { name: value.trim(), source }
      }
      return undefined
    }

    /**
     * Each spawn resolves against one tier state, model and receipt alike: a reload waits for
     * the spawns already running, and spawns that arrive during a reload wait for it.
     */
    let reloading: Promise<void> | undefined
    let inFlight = 0
    let idle: (() => void) | undefined
    const whileSpawning = async (task: () => Promise<void>): Promise<void> => {
      while (reloading !== undefined) await reloading
      inFlight++
      try {
        await task()
      } finally {
        inFlight--
        if (inFlight === 0) idle?.()
      }
    }
    const exclusive = async (task: () => Promise<void>): Promise<void> => {
      while (reloading !== undefined) await reloading
      let done = () => {}
      reloading = new Promise<void>((resolve) => {
        done = resolve
      })
      try {
        if (inFlight > 0)
          await new Promise<void>((resolve) => {
            idle = resolve
          })
        await task()
      } finally {
        idle = undefined
        reloading = undefined
        done()
      }
    }

    type SpawnEvent = { id: string; sessionID: string; agent: string; input: unknown }

    /**
     * A resume (`sessionID` naming a child) keeps the model and effort the child resolved to, even when
     * the tiers changed since. A `model` or `tier` on the resume is a deliberate reroute and replaces
     * the snapshot. Returns true when it handled the spawn.
     */
    const handleResume = async (event: SpawnEvent): Promise<boolean> => {
      if (!isRecord(event.input) || typeof event.input.sessionID !== "string" || event.input.sessionID === "") return false
      const childID = event.input.sessionID
      const agent = typeof event.input.agent === "string" ? event.input.agent : "(resumed)"
      const explicitModel = inputModel(event.input)
      const asked = passedTier(event.input)
      const revision = configRevision(options)
      // Whatever the resume passes, the tier parameters themselves never reach the tool.
      const stripped = planSpawn(event.input, options, available, view()).input
      if (explicitModel !== undefined) {
        event.input = stripped
        await writeSnapshot(childID, { model: modelLabel(explicitModel), configRevision: revision, at: Date.now() })
        await forgetChildRole(childID)
        await recordReceipt({ at: Date.now(), agent, source: "agent", model: modelLabel(explicitModel), rule: "explicit-model", fallbacks: [], warnings: [] })
        return true
      }
      if (asked !== undefined && !INHERIT_NAMES.includes(asked.name)) {
        // Resolve as a fresh spawn would, then keep the sessionID.
        const { sessionID: _kept, ...fresh } = event.input
        const plan = planSpawn(fresh, options, available, view(), tierMeta(options, asked.name)?.distinctVendor ? await callerVendor(event) : undefined)
        if (plan.error !== undefined) throw new Error(plan.error)
        if (plan.role !== undefined && plan.model !== undefined && isRecord(plan.input)) {
          const tuned = await withAutoEffort(plan.input, plan.role, plan.model).catch(() => ({ input: plan.input as Record<string, unknown>, model: plan.model as ModelRef }) as Tuned)
          event.input = { ...tuned.input, sessionID: childID }
          await writeSnapshot(childID, { model: modelLabel(tuned.model), tier: plan.role, configRevision: revision, at: Date.now() })
          await recordChildRole(childID, plan.role)
          await recordReceipt(tierReceipt(agent, asked, tuned))
          return true
        }
      }
      event.input = stripped
      const snapshot = await snapshotOf(childID)
      if (snapshot === undefined) return true
      const model = snapshotModel(snapshot)
      const reason = model === undefined ? "the snapshot names no model" : unavailableReason(model, available)
      // A model that was allowed when the child was spawned may be guarded now.
      const refused = model === undefined || reason !== undefined ? undefined : await judge(event, agent, model)
      if (model === undefined || reason !== undefined || refused !== undefined) {
        await recordReceipt({
          at: Date.now(),
          agent,
          source: "agent",
          ...(snapshot.tier === undefined ? {} : { tier: snapshot.tier }),
          rule: "model-default",
          fallbacks: [],
          warnings: [`the child's snapshot model ${snapshot.model} is not usable (${reason ?? refused}); the resume resolves normally`],
        })
        return true
      }
      if (isRecord(event.input)) event.input = { ...event.input, model: snapshot.model }
      await recordReceipt({
        at: Date.now(),
        agent,
        source: "agent",
        ...(snapshot.tier === undefined ? {} : { tier: snapshot.tier }),
        model: snapshot.model,
        rule: "snapshot",
        configRevision: snapshot.configRevision,
        fallbacks: [],
        warnings: [],
      })
      return true
    }

    const handleSpawn = async (event: SpawnEvent) => {
      if (await handleResume(event)) return
      // Read before the tier rewrites `model`: only a model the caller passed counts as explicit.
      const explicitModel = inputModel(event.input)
      const asked = passedTier(event.input)
      const passed = asked?.name
      const named = spawnTarget(event.input)
      const agent = named === undefined ? undefined : (await listAgents().catch(() => [] as Agents)).find((a) => a.id === named)
      // A model the user pinned on the target wins over any tier, passed or its own.
      const pin = agent === undefined ? undefined : userPin(agent)
      const pinned = pin !== undefined
      const vendor = passed !== undefined && !pinned && tierMeta(options, passed)?.distinctVendor ? await callerVendor(event) : undefined
      let plan = planSpawn(event.input, options, available, view(), vendor, pinned)
      if (plan.error !== undefined) throw new Error(plan.error)
      if (plan.input !== event.input) event.input = plan.input
      const target = spawnTarget(plan.input)
      if (target === undefined) return
      const own = agent === undefined ? undefined : roleOf(agent, options.agents, options.implicit)
      // The tier that does not apply when the spawn's own model or the agent's pin wins.
      const dropped = asked !== undefined && !INHERIT_NAMES.includes(asked.name) && plan.role === undefined ? asked : undefined
      const bypassed: Asked | undefined = dropped ?? (own === undefined ? undefined : { source: "agent", name: own })
      const bypass = (rule: "explicit-model" | "agent-pin", model: ModelRef, warning: string): Receipt | undefined => {
        if (bypassed === undefined) return undefined
        const tier = tierOf(bypassed.name)
        return {
          at: Date.now(),
          agent: target,
          source: bypassed.source,
          tier,
          ...(bypassed.name === tier ? {} : { alias: bypassed.name }),
          model: modelLabel(model),
          rule,
          fallbacks: [],
          warnings: [`${warning} ${tier}`],
        }
      }
      if (explicitModel !== undefined) {
        // The caller's model runs as given; only the guard may refuse it.
        const reason = await judge(event, target, explicitModel)
        if (reason !== undefined) throw new Error(reason)
        const receipt = bypass("explicit-model", explicitModel, "the spawn's own model wins over tier")
        if (receipt !== undefined) await recordReceipt(receipt)
        expectChild(event.id, event, target, explicitModel, undefined)
        return
      }
      let source: SpawnSource | undefined = asked?.source
      let tierName = passed
      // An agent on a tier that wants another vendor than the caller's, or whose effort the decider picks, is moved per spawn.
      if (plan.role === undefined && !pinned && isRecord(plan.input) && own !== undefined) {
        const meta = tierMeta(options, own)
        if (meta?.distinctVendor || meta?.effort === "auto") {
          const callerVendorOf = meta.distinctVendor ? await callerVendor(event) : undefined
          const model = resolveTier(options, available, own, view(), callerVendorOf).model
          if (model !== undefined) {
            plan = { input: { ...plan.input, model: modelLabel(model) }, role: own, model }
            event.input = plan.input
            source = "agent"
            tierName = own
          }
        }
      }
      if (plan.role !== undefined && plan.model !== undefined) {
        let tuned: Tuned = { input: isRecord(plan.input) ? plan.input : {}, model: plan.model }
        if (isRecord(plan.input)) {
          tuned = await withAutoEffort(plan.input, plan.role, plan.model).catch(() => ({ input: tuned.input, model: plan.model as ModelRef }))
          event.input = tuned.input
        }
        pending.set(event.id, { parentID: event.sessionID, agent: target, role: plan.role, model: tuned.model, revision: configRevision(options), at: Date.now() })
        expectChild(event.id, event, target, tuned.model, plan.role)
        const vendorOfCaller = tierMeta(options, plan.role)?.distinctVendor ? await callerVendor(event) : undefined
        await recordReceipt(tierReceipt(target, { source: source ?? "agent", name: tierName ?? plan.role }, tuned, vendorOfCaller))
        return
      }
      const unroled = plan.role === undefined
      const accept = async (routed: Routed) => {
        const tuned = await withAutoEffort(routed.input, routed.role, routed.model).catch(() => ({ input: routed.input, model: routed.model }) as Tuned)
        event.input = tuned.input
        pending.set(event.id, { parentID: event.sessionID, agent: target, role: routed.role, model: tuned.model, revision: configRevision(options), at: Date.now() })
        expectChild(event.id, event, target, tuned.model, routed.role)
        const vendorOfCaller = tierMeta(options, routed.role)?.distinctVendor ? await callerVendor(event) : undefined
        await recordReceipt(tierReceipt(target, { source: "auto", name: routed.role }, tuned, vendorOfCaller))
      }
      if (unroled && auto !== undefined) {
        const routed = await route(event, target, plan.input, auto, false).catch(() => undefined)
        if (routed !== undefined) return accept(routed)
      }
      const reason = await judge(event, target, undefined)
      if (reason === undefined) {
        // The spawn goes ahead on the agent's own model: its pin, or the model this plugin set for its tier, else the host decides.
        const ownModel = pin ?? (own === undefined ? undefined : resolveTier(options, available, own, view()).model)
        expectChild(event.id, event, target, ownModel, pin === undefined ? own : undefined)
        if (pin !== undefined) {
          const receipt = bypass("agent-pin", pin, "the agent's own model (config or frontmatter) wins over tier")
          if (receipt !== undefined) await recordReceipt(receipt)
        } else if (own !== undefined && agent !== undefined) {
          const model = resolveTier(options, available, own, view()).model
          if (model !== undefined) {
            const receipt = tierReceipt(target, { source: "agent", name: own }, { input: {}, model })
            if (agent.model !== undefined && !sameModel(agent.model, model))
              receipt.warnings = [...receipt.warnings, `the agent still runs ${modelLabel(agent.model)}: its model has not caught up with the tier`]
            await recordReceipt(receipt)
          }
        }
        return
      }
      if (unroled && guardAuto !== undefined) {
        const routed = await route(event, target, plan.input, guardAuto, true).catch(() => undefined)
        if (routed !== undefined) return accept(routed)
      }
      throw new Error(reason)
    }

    const spawns = await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== SUBAGENT_TOOL) return
      await whileSpawning(() => handleSpawn(event))
    })

    // The `/tiers` TUI dialog reads the tier table and writes `options.tiers` through these.
    const configDir = () => globalConfigDir(process.env, homedir())
    /**
     * Which config entry this instance is, from the host: exactly one loaded plugin with this id whose
     * `package` source target is the entry's exact string. Anything else (two instances, no answer) leaves
     * the identity open, and then nothing may be written or reloaded on a guess. The host lists a plugin only
     * after its batch has set up (`plugin.ts:50-51,184`), so this is looked up when needed, not in setup;
     * only a unique answer is kept.
     */
    type Identity = { kind: "unique"; spec: string } | { kind: "ambiguous"; targets: string[] } | { kind: "unknown" }
    const lookupIdentity = async (): Promise<Identity> => {
      try {
        const listed = (await ctx.plugin.list()) as unknown
        const rows = (Array.isArray(listed) ? listed : isRecord(listed) && Array.isArray(listed.data) ? listed.data : []) as Array<{
          id?: unknown
          source?: { type?: unknown; target?: unknown }
        }>
        const mine = rows.filter((row) => row.id === "srobroek.model-roles")
        if (mine.length > 1) return { kind: "ambiguous", targets: mine.map((row) => String(row.source?.target ?? row.source?.type ?? "unknown")) }
        const source = mine[0]?.source
        return source?.type === "package" && typeof source.target === "string" ? { kind: "unique", spec: source.target } : { kind: "unknown" }
      } catch {
        return { kind: "unknown" }
      }
    }
    let known: Identity = { kind: "unknown" }
    const resolveIdentity = async (): Promise<Identity> => {
      if (known.kind === "unique") return known
      const found = await lookupIdentity()
      if (found.kind === "unique") known = found
      return found
    }
    /** For display and reads only; a loose match (no spec) may stand in when the identity is open. */
    const ownSpec = () => (known.kind === "unique" ? known.spec : undefined)
    /** The exact package string a write may target, or an error: a guess never authorises a write. */
    const writableSpec = async (): Promise<string> => {
      const identity = await resolveIdentity()
      if (identity.kind === "ambiguous")
        throw new Error(`Two model-roles entries are loaded (${identity.targets.join(", ")}); /tiers can't tell which one to edit. Edit the config by hand or remove one entry.`)
      if (identity.kind === "unknown") throw new Error("The host did not say which model-roles entry this instance is, so /tiers can't tell which one to edit. Edit the config by hand.")
      return identity.spec
    }
    const globalFile = () => {
      try {
        return pickConfigFile(readConfigFiles(configDir()), ownSpec())
      } catch {
        return undefined
      }
    }
    const pluginOptions = isRecord(ctx.options) ? ctx.options : {}
    /**
     * Where the `tiers` and `agents` options come from: the model-roles entry of the highest-precedence project
     * config that has one (it replaces the global entry as a whole), else the global file's.
     */
    const agentConfig = (): EffectiveConfig => {
      let project: ConfigFile[] = []
      try {
        const directory = (ctx as { location?: { directory?: unknown } }).location?.directory
        if (typeof directory === "string") project = readProjectFiles(directory, configDir())
      } catch {
        // No project files.
      }
      return effectiveConfig(project, globalFile(), ownSpec())
    }
    const agentsKeyOf = (config: EffectiveConfig) => JSON.stringify({ origin: config.origin, path: config.path, agents: parseOptions({ agents: config.agents }).agents })
    const startupConfig = agentConfig()
    /** The effective entry's tiers as last applied (or seen at setup), so an unrelated config change keeps the options this instance got. */
    let fileTiers = startupConfig.path === undefined ? undefined : JSON.stringify(startupConfig.tiers)
    const startupAgents = parseOptions({ agents: startupConfig.agents }).agents
    /** Assignments in `ctx.options` that neither config file held at startup (another source); a global edit keeps them. */
    const otherAgents = Object.fromEntries(Object.entries(options.agents).filter(([agent]) => !Object.hasOwn(startupAgents, agent)))
    /** The effective `agents` as last applied. */
    let fileAgents = agentsKeyOf(startupConfig)

    /**
     * Apply the effective entry's tiers to the running instance when they changed (or always with
     * `force`): resolution, agent models and the `tier` parameter for new sessions follow;
     * running sessions keep the parameter they first saw.
     */
    const reloadTiers = async (force: boolean) => {
      const identity = await resolveIdentity()
      const config = agentConfig()
      const agentsKey = agentsKeyOf(config)
      const wanted = parseOptions({ agents: config.agents }).agents
      // A reload caused by the tiers alone keeps the agents it has.
      const agentsChanged = identity.kind === "unique" && agentsKey !== fileAgents
      // A project entry's tiers count only when the host named this instance: on a guess they stay as they are.
      // With no entry anywhere only the agents can change.
      const tiers = config.path === undefined || (config.origin === "project" && identity.kind !== "unique") ? undefined : config.tiers
      const key = tiers === undefined ? fileTiers : JSON.stringify(tiers)
      if (tiers === undefined ? !agentsChanged : !force && key === fileTiers && !agentsChanged) return
      await exclusive(async () => {
        const previous = { settings, agents: options.agents, roles: options.roles, tiers: options.tiers, classes: options.classes, derived }
        const restore = () => {
          settings = previous.settings
          options.agents = previous.agents
          options.roles = previous.roles
          options.tiers = previous.tiers
          options.classes = previous.classes
          derived = previous.derived
        }
        try {
          // Spawns wait in `exclusive`, so they see either the old tiers or the new ones once agents and tools follow.
          if (tiers !== undefined) settings = parseTierSettings({ ...pluginOptions, tiers })
          if (agentsChanged) options.agents = config.origin === "project" ? wanted : { ...otherAgents, ...wanted }
          rebuild()
          attempts = 0
          await check(true)
          await refreshSubagentTool()
        } catch (error) {
          restore()
          attempts = 0
          await check(true).catch(() => {})
          await refreshSubagentTool().catch(() => {})
          throw error
        }
      })
      // Marked applied only once everything above went through, so a failed reload is retried on the next event.
      fileTiers = key
      fileAgents = agentsKey
      warn(`applied the tiers from ${config.path ?? "the project config"}`)
    }

    const rpc = await ctx.rpc.register(TiersRpc, {
      state: async (input) => {
        await queue(async () => {
          await refresh()
        })
        const file = globalFile()
        const saved: Record<string, TierConfig> = {}
        for (const [name, value] of Object.entries(file === undefined ? settings.tiers : readTiers(file.text, ownSpec()))) saved[name] = parseTierConfig(value)
        // The file with the draft laid over it, resolved fresh, so the dialog can preview an edit.
        const configured = applyDraft(saved, readDraft(input))
        const preview = buildTiers(parseTierSettings({ ...pluginOptions, tiers: configured }), available as CatalogModel[], refs)
        const now = Date.now()
        return tierState({
          options: { ...options, roles: preview.roles, tiers: preview.tiers, classes: preview.classes },
          available,
          configured,
          agents: await listAgents().catch(() => [] as Agents),
          health: view(),
          status: (entry) => candidateStatus(entry, available, preview.roles, health, now),
          ...(file === undefined
            ? { error: `No model-roles plugin entry in the global config (${configDir()}); /tiers cannot save.` }
            : { config: file.path }),
          agentConfig: (({ origin, path: from, alsoLoads }) => ({
            origin,
            ...(from === undefined ? {} : { path: from }),
            ...(alsoLoads === undefined ? {} : { alsoLoads }),
          }))(agentConfig()),
        })
      },
      set: async (input) => {
        const { tier, value } = (input ?? {}) as { tier?: unknown; value?: unknown }
        const spec = await writableSpec()
        if (typeof tier !== "string" || !TIER_NAME.test(tier)) throw new Error(`Invalid tier name ${JSON.stringify(tier)}`)
        const config = value === null || value === undefined ? undefined : compact(parseTierConfig(value))
        await queue(async () => {
          await refresh()
        })
        const { errors, warnings } = validateTierConfig(config, available, catalog)
        if (errors.length > 0) throw new Error(`Tier ${tier} not saved: ${errors.join(" ")}`)
        const result = writeTier(configDir(), tier, config, spec)
        warn(`${config === undefined ? "removed" : "set"} tier ${tier} in ${result.path}`)
        for (const warning of warnings) warn(`tier ${tier}: ${warning}`)
        for (const warning of result.warnings) warn(`tier ${tier}: ${warning}`)
        try {
          await queue(() => reloadTiers(true))
        } catch (error) {
          warn(`tier ${tier} was written to ${result.path} but not applied`, { error: String(error) })
          throw new Error(`Tier ${tier} was written to ${result.path} but not applied: ${(error as Error).message}. The previous tiers stay in use until the config reloads.`)
        }
        const effective = agentConfig()
        const all = [...result.warnings, ...warnings]
        return effective.origin === "project" ? { ...result, warnings: all, shadowedBy: effective.path } : { ...result, warnings: all }
      },
      setAgent: async (input) => {
        const { agent, tier } = (input ?? {}) as { agent?: unknown; tier?: unknown }
        const spec = await writableSpec()
        if (typeof agent !== "string" || agent.trim() === "") throw new Error(`Invalid agent ${JSON.stringify(agent)}`)
        const value = tier === null || tier === undefined ? undefined : tier
        await queue(async () => {
          await refresh()
        })
        if (value !== undefined) {
          const error = agentTierError(value, options.tiers ?? {})
          if (error !== undefined) throw new Error(`Agent ${agent} not saved: ${error}`)
        }
        if (!(await listAgents()).some((a) => a.id === agent)) throw new Error(`Agent ${agent} not saved: the host lists no such agent.`)
        const result = writeAgentTier(configDir(), agent, value as string | undefined, spec)
        warn(`${value === undefined ? "removed the tier of" : "set the tier of"} agent ${agent} in ${result.path}`)
        for (const warning of result.warnings) warn(`agent ${agent}: ${warning}`)
        try {
          await queue(() => reloadTiers(true))
        } catch (error) {
          warn(`agent ${agent} was written to ${result.path} but not applied`, { error: String(error) })
          throw new Error(`Agent ${agent} was written to ${result.path} but not applied: ${(error as Error).message}. The previous tiers stay in use until the config reloads.`)
        }
        const effective = agentConfig()
        return effective.origin === "project" ? { ...result, shadowedBy: effective.path } : result
      },
    })

    const spawnResults = await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== SUBAGENT_TOOL) return
      const spawn = pending.get(event.id)
      pending.delete(event.id)
      const expected = expectedChildren.get(event.id)
      expectedChildren.delete(event.id)
      if (event.status === "completed") {
        const childID = (event.result.metadata as { sessionID?: unknown } | undefined)?.sessionID
        if (spawn !== undefined && typeof childID === "string") await recordChildRole(childID, spawn.role)
        // The child's own model, when its creation event was missed.
        if (expected !== undefined && typeof childID === "string" && (await snapshotOf(childID)) === undefined) {
          const session = (await ctx.session.get({ sessionID: childID }).catch(() => undefined)) as SessionLike
          await recordChildModel(childID, expected, session?.model)
        }
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
          const target = cooldownMs > 0 ? fallbackTarget(options, available, view(), role, failed) : undefined
          const facts: NoteFacts = { failed, kind, cooldownMs, target }
          const resumable = cooldownMs > 0 ? undefined : childSessionID(message)
          await announce({
            ...facts,
            now: Date.now(),
            notifyTo: event.sessionID,
            subagent: { agent: agentID, sessionID: childSessionID(message) },
            plain: subagentNote({ ...facts, agent: agentID, spawnRole: spawn?.role, resumable }),
          })
        })
      } catch (error) {
        warn(`could not record the subagent failure`, { error: String(error) })
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
          settleRequest(requestLog, sessionID, endedAt(event))
          const error = data.error as { type?: string; message?: string; status?: number }
          await queue(() => onSessionFailed(sessionID, error)).catch((error) =>
            warn(`fallback after a failed execution did not complete`, { error: String(error) }),
          )
          continue
        }
        if (type === SUCCEEDED_EVENT) {
          const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
          if (typeof sessionID !== "string") continue
          const model = settleRequest(requestLog, sessionID, endedAt(event))
          if (noticeState.outages.size > 0) await queue(() => onSessionSucceeded(sessionID, model)).catch(() => {})
          continue
        }
        if (type === INTERRUPTED_EVENT) {
          // Neither a success nor a failure: the interrupted request only leaves the log.
          const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
          if (typeof sessionID === "string") settleRequest(requestLog, sessionID, endedAt(event))
          continue
        }
        if (type === DELETED_EVENT) {
          const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
          if (typeof sessionID === "string") {
            requestLog.delete(sessionID)
            forgetSession(noticeState, sessionID)
          }
          continue
        }
        if (type === CREATED_EVENT) {
          const data = (event as { data?: unknown }).data
          if (isRecord(data)) await onSessionCreated(data).catch(() => {})
          continue
        }
        if (type === CONFIG_EVENT) {
          await queue(() => reloadTiers(false)).catch((error) => warn("could not apply the reloaded config", { error: String(error) }))
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
      for (const hook of freezeHooks) await hook.dispose()
      frozenTiers.clear()
      await subagentTool.dispose()
      await tools.dispose()
      await strip.dispose()
      await retries.dispose()
      await registration.dispose()
      await references.dispose()
      noticeState.outages.clear()
      noticeState.notices.clear()
      childFailures.clear()
      requestLog.clear()
      triedModels.clear()
      pending.clear()
      childRoles.clear()
      childModels.clear()
      expectedChildren.clear()
      autoHistory = []
    }
  },
})
