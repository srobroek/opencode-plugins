import { isAbsolute, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Result } from "@opencode/plugin/promise/tool"
import { appendResultText, shellExit } from "@srobroek/opencode-lib/shell-result"
import { bdInvocations, isMutatingBdCommand } from "./bd-actor-gate.ts"
import { claimResultOutput } from "./bd-lease-gate.ts"
import { sessionPinFor } from "./beads-store.ts"
import { contentionAdvisory, readClaimState, recordClaimTransitions } from "./claims.ts"
import {
  type BdRun,
  bdStoreDir,
  EMBEDDED_PIN_ENV,
  environmentForCommand,
  GateAdmitter,
  lifecycleBdEnvironment,
  staleSkipNotice,
} from "./gate-admission.ts"
import {
  agentActor,
  GateRefusal,
  gateEnabled,
  type Options,
  type SessionChain,
  sessionChain,
  shellInput,
} from "./host.ts"
import { PRIME_WAIT_MS, readPrime, storedPrime } from "./prime.ts"
import { decideShell, type ShellGateDeps, TOOL_CALL_BUDGET_MS } from "./shell-gates.ts"

export { decideShell } from "./shell-gates.ts"

const SUBAGENT_TOOL = "subagent"
const PIN_CACHE_MS = 5_000

/**
 * The store a shell child in `cwd` should open: the checkout's own `.beads`, or the
 * primary checkout's from a linked worktree. `undefined` when `env` already chooses one
 * or there is none.
 */
export function shellPin(cwd: string, env: Record<string, string | undefined>, pinFor = sessionPinFor): string | undefined {
  const explicit = env.BEADS_DIR
  if (explicit !== undefined && explicit !== "") return undefined
  return pinFor(cwd)
}

/** The environment a gate should assume the child shell gets: `base` plus the pin. */
export function pinnedEnvironment(cwd: string, base: NodeJS.ProcessEnv, pinFor = sessionPinFor): NodeJS.ProcessEnv {
  const pin = shellPin(cwd, base, pinFor)
  return pin === undefined ? { ...base } : { ...base, ...EMBEDDED_PIN_ENV, BEADS_DIR: pin }
}

type PendingCall = { command: string; cwd: string; actor?: string; advisories: string[] }

/** Serialise read-modify-write on one storage key within this instance. */
function keyedQueue() {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch(() => undefined)
    tails.set(key, settled)
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key)
    })
    return next
  }
}

async function bounded<T>(pending: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Seams for tests; production passes none. */
export type AdapterDeps = {
  run?: BdRun
  pinFor?: (cwd: string) => string | undefined
  runnerLookup?: ShellGateDeps["runnerLookup"]
  repositoryControl?: ShellGateDeps["repositoryControl"]
  env?: NodeJS.ProcessEnv
}

export async function setupBeads(ctx: Context, deps: AdapterDeps = {}): Promise<() => Promise<void>> {
  const options = ctx.options as Options
  const directory = ctx.location.directory
  const on = (gate: Parameters<typeof gateEnabled>[1]) => gateEnabled(options, gate)
  const admitter = new GateAdmitter(deps.run)
  const pinFor = deps.pinFor ?? sessionPinFor
  const baseEnv = (): NodeJS.ProcessEnv => deps.env ?? process.env
  const pending = new Map<string, PendingCall>()
  const chains = new Map<string, Promise<SessionChain>>()
  const pins = new Map<string, { at: number; pin: string | undefined }>()
  const queue = keyedQueue()

  const cachedPinFor = (cwd: string): string | undefined => {
    const hit = pins.get(cwd)
    if (hit !== undefined && Date.now() - hit.at < PIN_CACHE_MS) return hit.pin
    const pin = pinFor(cwd)
    pins.set(cwd, { at: Date.now(), pin })
    return pin
  }

  const chainFor = (sessionID: string, agent: string): Promise<SessionChain> => {
    const key = `${sessionID}\0${agent}`
    let chain = chains.get(key)
    if (chain === undefined) {
      chain = sessionChain(sessionID, agent, async (id) => {
        const session = (await ctx.session.get({ sessionID: id } as never)) as { parentID?: string } | undefined
        return session
      })
      chains.set(key, chain)
    }
    return chain
  }

  // Start the location's gate verification now, so the first mutation rarely waits.
  const locationEnv = lifecycleBdEnvironment(directory, baseEnv())
  if (on("beads-gate-admission") && bdStoreDir(directory, locationEnv) !== undefined)
    admitter.verify(directory, locationEnv)
  const prime = on("beads-prime") ? readPrime(directory, locationEnv, deps.run).catch(() => "") : Promise.resolve("")

  const before = await ctx.tool.hook("execute.before", async (event) => {
    const deadline = Date.now() + TOOL_CALL_BUDGET_MS
    if (event.tool === SUBAGENT_TOOL) {
      if (!on("beads-gate-admission")) return
      const admission = await admitter.admit(directory, lifecycleBdEnvironment(directory, baseEnv()), true, deadline)
      if (admission?.block === true)
        throw new GateRefusal(
          "beads-gate-admission",
          admission.reason,
          "retry the operation; verification continues and the next attempt waits on the same read",
        )
      return
    }
    if (event.tool !== "shell") return
    const call = shellInput(event.input, directory)
    if (call === undefined || call.command.trim() === "") return
    const chain = await chainFor(event.sessionID, event.agent)
    const actor = agentActor(chain)
    const env = pinnedEnvironment(call.cwd, baseEnv(), cachedPinFor)
    const decision = await decideShell(call.command, call.cwd, {
      options,
      actor,
      env,
      admitter,
      callID: event.id,
      deadline,
      runnerLookup: deps.runnerLookup,
      repositoryControl: deps.repositoryControl,
    })
    if (decision.kind === "block") throw new GateRefusal(decision.gate, decision.cause, decision.resolution)
    if (decision.command !== call.command) event.input = { ...(event.input as object), command: decision.command }
    pending.set(event.id, { command: call.command, cwd: call.cwd, actor, advisories: decision.advisories })
  })

  const pin = await ctx.shell.hook("create.before", (event) => {
    if (!on("beads-dir-pin")) return
    const cwd = isAbsolute(event.cwd) ? event.cwd : resolve(directory, event.cwd)
    const store = shellPin(cwd, event.env, cachedPinFor)
    if (store === undefined) return
    Object.assign(event.env, EMBEDDED_PIN_ENV, { BEADS_DIR: store })
  })

  const after = await ctx.tool.hook("execute.after", async (event) => {
    if (event.tool !== "shell") return
    const call = pending.get(event.id)
    pending.delete(event.id)
    if (event.status !== "completed") return
    const result: Result = event.result
    const advisories = [...(call?.advisories ?? [])]
    const output = claimResultOutput(result)
    const contention = contentionAdvisory(output)
    if (contention !== undefined) advisories.push(contention)
    if (call !== undefined && bdInvocations(call.command).length > 0) {
      const stale = staleSkipNotice(output)
      if (stale !== undefined) {
        const key = `stale-advised/${event.sessionID}`
        if ((await ctx.storage.get(key)) !== true) {
          await ctx.storage.set(key, true)
          advisories.push(stale)
        }
      }
      if (on("beads-claim-tracking") && isMutatingBdCommand(call.command) && shellExit(result) === 0) {
        const key = `claims/${event.sessionID}`
        const env = environmentForCommand(call.command, pinnedEnvironment(call.cwd, baseEnv(), cachedPinFor))
        if (call.actor !== undefined) env.BEADS_ACTOR = call.actor
        await queue(key, async () => {
          const state = readClaimState(await ctx.storage.get(key))
          const before = JSON.stringify(state)
          recordClaimTransitions(state, call.command, call.cwd, env, output, bdInvocations(call.command))
          if (JSON.stringify(state) !== before) await ctx.storage.set(key, state)
        })
      }
    }
    if (advisories.length > 0) event.result = appendResultText(result, advisories.join("\n\n"))
  })

  const context = await ctx.session.hook("context", async (event) => {
    if (!on("beads-prime")) return
    const key = `prime/${event.sessionID}`
    const text = await queue(key, async () => {
      const stored = storedPrime(await ctx.storage.get(key))
      if (stored !== undefined) return stored
      const fresh = await bounded(prime, PRIME_WAIT_MS, "")
      await ctx.storage.set(key, { text: fresh })
      return fresh
    })
    if (text !== "") event.system.push({ type: "text", text })
  })

  return async () => {
    await context.dispose()
    await after.dispose()
    await pin.dispose()
    await before.dispose()
    pending.clear()
    chains.clear()
  }
}

export default Plugin.define({
  id: "srobroek.beads",
  setup: (ctx) => setupBeads(ctx),
})
