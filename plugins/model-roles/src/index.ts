import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { type GuardAgent, type GuardModel, judgeSpawn, parseGuard, pinnedModel } from "./guard.ts"
import {
  type AvailableModel,
  desiredModels,
  type ModelRef,
  parseOptions,
  sameModel,
  staleAgents,
  stripRoleHeader,
} from "./resolve.ts"

export * from "./guard.ts"
export * from "./resolve.ts"

/** Re-registrations allowed in a row without the agents converging, before giving up until inputs change. */
export const MAX_REREGISTER = 3

const REFRESH_EVENTS = new Set(["model.updated", "provider.updated"])
const CHECK_EVENTS = new Set(["agent.updated", ...REFRESH_EVENTS])

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

export default Plugin.define({
  id: "srobroek.model-roles",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const guard = parseGuard(isRecord(ctx.options) ? ctx.options.guard : undefined)
    let available: GuardModel[] = []
    let availableKey = ""

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
      const desired = desiredModels(editor.list(), options, available)
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
    // A change in availability re-registers even when nothing looks stale, so a
    // model that just became unavailable is replaced by the agent's own again.
    const check = async (force: boolean) => {
      const agents = (await ctx.agent.list()).data
      const desired: Map<string, ModelRef> = desiredModels(agents, options, available)
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

    const strip = await ctx.session.hook("model.request", (request) => {
      stripRoleHeader(request.headers)
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
              const [listed, session] = await Promise.all([
                ctx.agent.list(),
                ctx.session.get({ sessionID: event.sessionID }),
              ])
              const agents = listed.data as ReadonlyArray<GuardAgent>
              const caller = agents.find((agent) => agent.id === event.agent)
              const sessionModel =
                session?.model ?? (caller === undefined ? undefined : pinnedModel(caller, { options, available }))
              const decision = judgeSpawn({ guard, options, target, agents, available, sessionModel })
              if (!decision.allow) reason = decision.reason
            } catch {
              // Fail open: a broken lookup must never block delegation.
              return
            }
            if (reason !== undefined) throw new Error(reason)
          })

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break
        if (!CHECK_EVENTS.has(event.type)) continue
        try {
          const changed = REFRESH_EVENTS.has(event.type) && (await refresh())
          if (changed) attempts = 0
          await check(changed)
        } catch {
          // A failed list or transform leaves the current mapping in place; the next event retries.
        }
      }
    })().catch(() => {})

    return async () => {
      controller.abort()
      await guarded?.dispose()
      await strip.dispose()
      await registration.dispose()
    }
  },
})
