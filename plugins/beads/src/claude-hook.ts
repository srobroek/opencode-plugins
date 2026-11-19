/**
 * Claude Code hooks for the beads plugin, run by `hooks/claude-hooks.json`:
 *
 *   bun dist/claude-hook.js session-start  # SessionStart: `bd prime` and the session-start
 *                                          # advisories as context, BEADS_DIR for later shells
 *   bun dist/claude-hook.js pre-tool-use   # PreToolUse on Bash: the shell gates
 *   bun dist/claude-hook.js verify <store>  # detached by pre-tool-use: verifies one store's gates
 *
 * The gates are the ones the OpenCode plugin runs on `shell` (`decideShell`), with every
 * gate on: a refusal becomes `permissionDecision: "deny"`, a rewrite becomes
 * `updatedInput`, and advisories become `additionalContext`. Claims, lease heartbeats,
 * the stop nudge, subagent routing and goal handling stay OpenCode-only.
 *
 * Each hook is a new process cut off by its budget, so it never verifies gates itself:
 * `bd gate check` writes under the embedded store's lock, which must outlive the call. One
 * detached `verify` worker per store does it and stores the verdict in a short-lived on-disk
 * cache (`gate-verdict-cache.ts`) that the hook and its retries wait on. Without a stored
 * verified verdict the gates still refuse.
 *
 * Every failure of the hook itself is non-blocking: it writes to stderr and exits 0, so
 * Claude Code goes on as if the plugin were absent.
 */

import { randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import {
  type BdRun,
  EMBEDDED_PIN_ENV,
  GateAdmitter,
  type GateVerdict,
  lifecycleBdEnvironment,
  runBdResult,
  verifyGates,
} from "./gate-admission.ts"
import { delegatedVerifier, FileVerdictCache } from "./gate-verdict-cache.ts"
import { readPrime } from "./prime.ts"
import { type StartDeps, sessionStartAdvisories } from "./session-start.ts"
import { decideShell, type ShellGateDeps, TOOL_CALL_BUDGET_MS, withActorPrefix } from "./shell-gates.ts"
import { pinnedEnvironment, shellPin } from "./store-pin.ts"

/** The fields of Claude Code's hook input this hook reads. */
export type HookInput = {
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
  agent_id?: string
  agent_type?: string
}

export type PreToolUseOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse"
    permissionDecision?: "deny"
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
    additionalContext?: string
  }
}

export type SessionStartOutput = { hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string } }

/** Claude Code caps `additionalContext` at 10,000 characters and moves the rest to a file. */
export const CONTEXT_CAP = 10_000

const TRUNCATED = "\n\n[beads context truncated; run `bd prime` for the rest]"

/** Commands no gate looks at skip the gates: no `bd`, `git` or `gh` word anywhere. */
const GATED_WORD = /(?:^|[^\w.-])(?:bd|git|gh)(?=$|[^\w.-])/

/**
 * The actor a subagent writes under, prefixed onto each of its shell calls as the OpenCode
 * plugin does: `claude/<session>/<agent type>/<agent id>`. A main session has none.
 */
export function claudeActor(input: HookInput): string | undefined {
  if (input.agent_id === undefined || input.agent_id === "") return undefined
  const session = input.session_id !== undefined && input.session_id !== "" ? input.session_id : "session"
  const agent = input.agent_type !== undefined && input.agent_type !== "" ? input.agent_type : "subagent"
  return `claude/${session}/${agent}/${input.agent_id}`
}

export type ClaudeDeps = {
  env: NodeJS.ProcessEnv
  admitter: GateAdmitter
  /** Overrides the time the gates may take; defaults to `TOOL_CALL_BUDGET_MS`. */
  budgetMs?: number
  pinFor?: (cwd: string) => string | undefined
  runnerLookup?: ShellGateDeps["runnerLookup"]
  repositoryControl?: ShellGateDeps["repositoryControl"]
}

/** The PreToolUse answer for one Bash call, or `undefined` to leave it to Claude Code. */
export async function claudeDecision(input: HookInput, deps: ClaudeDeps): Promise<PreToolUseOutput | undefined> {
  if (input.tool_name !== "Bash") return undefined
  const toolInput = input.tool_input ?? {}
  const command = toolInput.command
  if (typeof command !== "string" || command.trim() === "") return undefined
  const actor = claudeActor(input)
  // No gate looks at a command without bd, git or gh, but a script or tool it runs may call `bd`,
  // so a subagent's command still starts with its actor.
  if (!GATED_WORD.test(command))
    return actor === undefined
      ? undefined
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { ...toolInput, command: withActorPrefix(command, actor) },
          },
        }
  const cwd = input.cwd ?? process.cwd()
  const env = pinnedEnvironment(cwd, deps.env, deps.pinFor)
  const decision = await decideShell(command, cwd, {
    options: undefined,
    actor,
    env,
    admitter: deps.admitter,
    callID: input.tool_use_id ?? randomUUID(),
    deadline: Date.now() + (deps.budgetMs ?? TOOL_CALL_BUDGET_MS),
    runnerLookup: deps.runnerLookup,
    repositoryControl: deps.repositoryControl,
  })
  if (decision.kind === "block")
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${decision.cause}; ${decision.resolution}. (beads gate ${decision.gate})`,
      },
    }
  const rewritten = decision.command !== command
  if (!rewritten && decision.advisories.length === 0) return undefined
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(rewritten ? { updatedInput: { ...toolInput, command: decision.command } } : {}),
      ...(decision.advisories.length > 0 ? { additionalContext: decision.advisories.join("\n\n") } : {}),
    },
  }
}

/** `bd prime` and the advisories within `cap`: advisories go first, from the last, then `bd prime` is cut. */
export function sessionContext(prime: string, advisories: readonly string[], cap = CONTEXT_CAP): string {
  const text = (kept: readonly string[]) => [prime, ...kept].filter((part) => part !== "").join("\n\n")
  const kept = [...advisories]
  while (kept.length > 0 && text(kept).length > cap) kept.pop()
  const joined = text(kept)
  return joined.length <= cap ? joined : `${joined.slice(0, cap - TRUNCATED.length)}${TRUNCATED}`
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** The `export` lines that pin later Bash calls to the session's store, as the OpenCode plugin pins `shell`. */
export function pinExports(cwd: string, env: NodeJS.ProcessEnv, pinFor?: (cwd: string) => string | undefined): string[] {
  const pin = shellPin(cwd, env, pinFor)
  if (pin === undefined) return []
  const vars: Record<string, string> = { ...EMBEDDED_PIN_ENV, BEADS_DIR: pin }
  return Object.entries(vars).map(([name, value]) => `export ${name}=${shellQuote(value)}`)
}

export type StartHookDeps = {
  env: NodeJS.ProcessEnv
  run?: BdRun
  pinFor?: (cwd: string) => string | undefined
  start?: Pick<StartDeps, "hooksAdvisory" | "identity">
}

/** The SessionStart answer and the environment lines for `CLAUDE_ENV_FILE`. */
export async function sessionStart(
  input: HookInput,
  deps: StartHookDeps,
): Promise<{ output?: SessionStartOutput; exports: string[] }> {
  const cwd = input.cwd ?? process.cwd()
  const exports = pinExports(cwd, deps.env, deps.pinFor)
  const prime = await readPrime(cwd, lifecycleBdEnvironment(cwd, deps.env), deps.run ?? runBdResult).catch(() => "")
  const advisories = sessionStartAdvisories(cwd, {
    env: deps.env,
    binaryHooks: true,
    pinFor: deps.pinFor,
    ...deps.start,
  })
  const context = sessionContext(prime, advisories)
  return {
    ...(context === "" ? {} : { output: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } }),
    exports,
  }
}

/** The hook budget `BEADS_CLAUDE_HOOK_BUDGET_MS` asks for, when it is a positive number below the default. */
export function hookBudgetMs(env: NodeJS.ProcessEnv): number | undefined {
  const asked = Number(env.BEADS_CLAUDE_HOOK_BUDGET_MS)
  return Number.isFinite(asked) && asked > 0 && asked < TOOL_CALL_BUDGET_MS ? asked : undefined
}

const verdictCache = () => new FileVerdictCache(process.env.BEADS_GATE_VERDICT_DIR)

/**
 * An admitter that never runs `bd gate` in the hook process: one detached `verify` worker per
 * store does, and the hook waits for its verdict in `cache` within its budget.
 */
export function hookAdmitter(cache: FileVerdictCache = verdictCache(), script: string = process.argv[1] ?? ""): GateAdmitter {
  return new GateAdmitter(undefined, {
    verifier: delegatedVerifier(cache, (cwd, env, storeDir) => {
      if (script === "") return undefined
      const worker = Bun.spawn([process.execPath, script, "verify", storeDir], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      })
      worker.unref()
      return worker.pid
    }),
  })
}

/**
 * The `verify` worker: verify the store's gates and store the verdict. It owns the embedded
 * write lock and every bd child, and it exits only once `verifyGates` has returned: each bd
 * child has exited, or was killed at bd's own ceiling. Then it gives up its claim.
 */
async function verify(storeDir: string | undefined): Promise<void> {
  if (storeDir === undefined || storeDir === "") return
  const cache = verdictCache()
  // bd reads are unreferenced so they cannot hold an OpenCode host open; this keeps the worker alive.
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    const verdict = await verifyGates(process.cwd(), process.env).catch(
      (error: unknown): GateVerdict => ({
        verified: false,
        notice: `Beads gates could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      }),
    )
    cache.write(storeDir, verdict)
  } finally {
    cache.release(storeDir, process.pid)
    clearInterval(keepAlive)
  }
}

async function main(argv: string[]): Promise<void> {
  const subcommand = argv[0]
  try {
    if (subcommand === "verify") return await verify(argv[1])
    const input = JSON.parse(await Bun.stdin.text()) as HookInput
    if (subcommand === "pre-tool-use") {
      const output = await claudeDecision(input, { env: process.env, admitter: hookAdmitter(), budgetMs: hookBudgetMs(process.env) })
      if (output !== undefined) await Bun.write(Bun.stdout, JSON.stringify(output))
    } else if (subcommand === "session-start") {
      const { output, exports } = await sessionStart(input, { env: process.env })
      const envFile = process.env.CLAUDE_ENV_FILE
      if (envFile !== undefined && envFile !== "" && exports.length > 0) appendFileSync(envFile, `${exports.join("\n")}\n`)
      if (output !== undefined) await Bun.write(Bun.stdout, JSON.stringify(output))
    } else {
      console.error(`srobroek beads hook: unknown subcommand ${JSON.stringify(subcommand ?? "")}`)
    }
  } catch (error) {
    console.error(`srobroek beads hook: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Exit right away: the wait for a worker's verdict must not hold the hook open. The hook
// process runs no bd write and holds no lock, so ending it cannot cut one short. The verify
// worker reaches this line only after its verification has returned.
if (import.meta.main) await main(process.argv.slice(2)).finally(() => process.exit(0))

export default main
