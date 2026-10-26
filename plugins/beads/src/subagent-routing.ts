/**
 * Delivery FO-5 routing for `subagent` spawns: a bead whose metadata names an
 * `execution_agent_type` goes to that agent, and `implementer-high` only when a
 * bead says so. Reads `bd show --json` on a short budget and fails open.
 */

import { basename, dirname } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Result } from "@opencode/plugin/promise/tool"
import { appendResultText } from "@srobroek/opencode-lib/shell-result"
import { type BdRun, bdStoreDir, envelopeData, lifecycleBdEnvironment, parseTrailingJson, runBdResult } from "./gate-admission.ts"
import { GateRefusal, gateEnabled, type Options } from "./host.ts"

export const ROUTING_GATE = "bead-agent-routing"

/** The longest a spawn waits for the bead lookup. */
export const ROUTING_BUDGET_MS = 3_000

export const HIGH_TIER_AGENT = "implementer-high"

/** At most this many bead ids are looked up per spawn. */
const MAX_IDS = 8

const ID_PATTERN = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[a-z0-9]{3,8}(?:\.\d+)*\b/g

export type BeadRouting = { id: string; agentType?: string; effort?: string }

export type RoutingDecision =
  | { kind: "allow" }
  | { kind: "block"; cause: string; resolution: string }
  | { kind: "advise"; text: string }

/**
 * Bead ids a prompt names. Tokens that start with the ledger's prefix win; without
 * any, a token counts when its hash segment carries a digit or it has a `.N` child
 * suffix, so ordinary hyphenated words are not looked up.
 */
export function beadIdsIn(prompt: string, prefix?: string): string[] {
  const tokens = [...new Set(Array.from(prompt.toLowerCase().matchAll(ID_PATTERN), (match) => match[0]))]
  const known = prefix === undefined || prefix === "" ? [] : tokens.filter((id) => id.startsWith(`${prefix}-`))
  const ids =
    known.length > 0
      ? known
      : tokens.filter((id) => {
          const [base = "", ...children] = id.split(".")
          return children.length > 0 || /\d/.test(base.slice(base.lastIndexOf("-") + 1))
        })
  return ids.slice(0, MAX_IDS)
}

/** The id prefix bd derived from the repository that holds the store. */
export function ledgerPrefix(store: string | undefined): string | undefined {
  if (store === undefined) return undefined
  const name = basename(dirname(store)).toLowerCase()
  return /^[a-z][a-z0-9-]*$/.test(name) ? name : undefined
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

/** Each shown bead's routing metadata, from `bd show --json` output (bare or enveloped). */
export function readRouting(output: string): BeadRouting[] {
  const data = envelopeData(parseTrailingJson(output))
  const list = Array.isArray(data) ? data : data !== null && typeof data === "object" ? [data] : []
  const beads: BeadRouting[] = []
  for (const item of list) {
    if (item === null || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const id = text(record.id)
    if (id === undefined) continue
    const metadata =
      record.metadata !== null && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {}
    const bead: BeadRouting = { id }
    const agentType = text(metadata.execution_agent_type)
    const effort = text(metadata.execution_reasoning_effort)
    if (agentType !== undefined) bead.agentType = agentType
    if (effort !== undefined) bead.effort = effort
    beads.push(bead)
  }
  return beads
}

/** Whether `agent` is the one `agentType` names, allowing a namespace (`delivery:implementer`, `x/implementer`). */
export function agentMatches(agent: string, agentType: string): boolean {
  const a = agent.toLowerCase()
  const t = agentType.toLowerCase()
  return a === t || a.endsWith(`:${t}`) || a.endsWith(`/${t}`)
}

/** Judge one spawn of `agent` against the beads its prompt names. */
export function decideRouting(agent: string, beads: ReadonlyArray<BeadRouting>): RoutingDecision {
  const typed = beads.filter((bead) => bead.agentType !== undefined)
  if (typed.length > 0 && !typed.some((bead) => agentMatches(agent, bead.agentType as string))) {
    const named = typed.map((bead) => {
      const effort = bead.effort === undefined ? "" : `, execution_reasoning_effort=${bead.effort}`
      return `${bead.id} (execution_agent_type=${bead.agentType}${effort})`
    })
    return {
      kind: "block",
      cause: `FO-5: the spawn goes to '${agent}', but the bead it names routes elsewhere: ${named.join("; ")}`,
      resolution:
        "re-issue the subagent call to the agent the bead names, passing its execution_reasoning_effort when set; implementer-high only when the bead says so",
    }
  }
  if (agentMatches(agent, HIGH_TIER_AGENT) && !typed.some((bead) => agentMatches(HIGH_TIER_AGENT, bead.agentType as string)))
    return {
      kind: "advise",
      text: `FO-5 advisory: this spawn used ${HIGH_TIER_AGENT}, but no named bead sets execution_agent_type=${HIGH_TIER_AGENT}. Dispatch to implementer unless the brief states an implementer-high criterion (root-cause/debugging work, concurrency or data-integrity logic, cross-module contract changes, algorithmic or numeric precision rules, or acceptance that needs design judgment beyond the bead text).`,
    }
  return { kind: "allow" }
}

/** The `subagent` input fields routing reads; a resumed spawn (`sessionID`) is not judged. */
export function spawnInput(input: unknown): { agent: string; prompt: string } | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  if (typeof record.agent !== "string" || typeof record.prompt !== "string") return undefined
  if (typeof record.sessionID === "string" && record.sessionID !== "") return undefined
  return { agent: record.agent, prompt: record.prompt }
}

export type RoutingDeps = { run?: BdRun; env?: () => NodeJS.ProcessEnv }

/**
 * Register the FO-5 hooks: refuse a misrouted spawn in `execute.before`, append the
 * implementer-high advisory in `execute.after`. Registers nothing without a store at
 * the location. Returns the cleanup.
 */
export async function registerAgentRouting(ctx: Context, deps: RoutingDeps = {}): Promise<() => Promise<void>> {
  const options = ctx.options as Options
  const directory = ctx.location.directory
  const run = deps.run ?? runBdResult
  const baseEnv = deps.env ?? (() => process.env)
  if (!gateEnabled(options, ROUTING_GATE) || bdStoreDir(directory, lifecycleBdEnvironment(directory, baseEnv())) === undefined)
    return async () => {}
  const advisories = new Map<string, string>()

  const before = await ctx.tool.hook("execute.before", async (event) => {
    if (event.tool !== "subagent") return
    const spawn = spawnInput(event.input)
    if (spawn === undefined) return
    let decision: RoutingDecision = { kind: "allow" }
    try {
      const env = lifecycleBdEnvironment(directory, baseEnv())
      const ids = beadIdsIn(spawn.prompt, ledgerPrefix(bdStoreDir(directory, env)))
      let beads: BeadRouting[] = []
      if (ids.length > 0) {
        const result = await run(directory, ["show", ...ids, "--json"], Date.now() + ROUTING_BUDGET_MS, env)
        if ("output" in result) beads = readRouting(result.output)
      }
      decision = decideRouting(spawn.agent, beads)
    } catch {
      return
    }
    if (decision.kind === "block") throw new GateRefusal(ROUTING_GATE, decision.cause, decision.resolution)
    if (decision.kind === "advise") advisories.set(event.id, decision.text)
  })

  const after = await ctx.tool.hook("execute.after", (event) => {
    const advisory = advisories.get(event.id)
    if (advisory === undefined) return
    advisories.delete(event.id)
    if (event.status === "completed") event.result = appendResultText(event.result as Result, advisory)
  })

  return async () => {
    await after.dispose()
    await before.dispose()
    advisories.clear()
  }
}
