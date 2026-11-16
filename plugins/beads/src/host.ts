/**
 * The OpenCode side of the beads plugin: settings, refusal text, actor identity and
 * shell-call input. Everything else in this package is harness-neutral and imports
 * from here rather than from `@opencode/plugin`.
 */

import { isAbsolute, resolve } from "node:path"

/** Gates the plugin options can switch off: `{ gates: { "<gate>": { enabled: false } } }` or `{ gates: { "<gate>": false } }`. */
export const GATES = [
  "beads-gate-admission",
  "bead-agent-routing",
  "binary-git-hooks",
  "bd-update-close-gate",
  "bd-close-gate",
  "bd-unclaim-gate",
  "bd-actor-gate",
  "pr-bead-link-gate",
  "bd-embedded-write-lock",
  "bd-editor-gate",
  "beads-dir-pin",
  "beads-prime",
  "beads-claim-tracking",
  "beads-stop-nudge",
  "beads-claim-release",
  "bd-lease-heartbeat",
  "beads-session-advisories",
  "beads-skills",
] as const

export type Gate = (typeof GATES)[number]

export type Options = Readonly<Record<string, unknown>>

/** Whether a gate is on. Every gate defaults to on; only an explicit `false` turns one off. */
export function gateEnabled(options: Options | undefined, gate: Gate): boolean {
  const gates = options?.gates
  if (gates === null || typeof gates !== "object") return true
  const value = (gates as Record<string, unknown>)[gate]
  if (value === false) return false
  if (value !== null && typeof value === "object") return (value as Record<string, unknown>).enabled !== false
  return true
}

/** One refusal string: the cause, what to do, and how to switch the gate off. */
export function blockReason(input: { gate: string; cause: string; resolution: string }): string {
  return `${input.cause}; ${input.resolution}. Disable: set the srobroek.beads plugin option gates.${input.gate}.enabled=false`
}

/** A gate refusal. Thrown from `execute.before`, so the model sees it as the tool error. */
export class GateRefusal extends Error {
  readonly gate: string
  constructor(gate: string, cause: string, resolution = "inspect the command and retry") {
    super(blockReason({ gate, cause, resolution }))
    this.name = "GateRefusal"
    this.gate = gate
  }
}

/** Where a session sits in its spawn tree. */
export type SessionChain = { sessionID: string; parentID?: string; rootID: string; agent?: string }

/**
 * The run-scoped actor injected into every `bd` shell call of a session, unless an actor is
 * already set: in `env` (BEADS_ACTOR or BD_ACTOR) or on the command, which the caller checks.
 * A subagent gets `opencode/<rootSessionID>/<agent>/<sessionID>`, a main session
 * `opencode/<agent>/<sessionID>`.
 */
export function agentActor(chain: SessionChain | undefined, env: NodeJS.ProcessEnv = {}): string | undefined {
  if (chain === undefined) return undefined
  if ((env.BEADS_ACTOR ?? "").trim() !== "" || (env.BD_ACTOR ?? "").trim() !== "") return undefined
  const agent = chain.agent !== undefined && chain.agent !== "" ? chain.agent : undefined
  if (chain.parentID === undefined || chain.parentID === "") return `opencode/${agent ?? "main"}/${chain.sessionID}`
  return `opencode/${chain.rootID}/${agent ?? "subagent"}/${chain.sessionID}`
}

type SessionLookup = (sessionID: string) => Promise<{ parentID?: string } | undefined>

/** Walk `parentID` to the root session. A lookup failure stops the walk where it is. */
export async function sessionChain(
  sessionID: string,
  agent: string | undefined,
  lookup: SessionLookup,
  maxDepth = 16,
): Promise<SessionChain> {
  let parentID: string | undefined
  let rootID = sessionID
  let current = sessionID
  for (let depth = 0; depth < maxDepth; depth++) {
    let parent: string | undefined
    try {
      parent = (await lookup(current))?.parentID
    } catch {
      break
    }
    if (parent === undefined || parent === "") break
    if (depth === 0) parentID = parent
    rootID = parent
    current = parent
  }
  return { sessionID, parentID, rootID, agent }
}

/** The `shell` tool's input as the gates read it. */
export type ShellInput = { command: string; cwd: string }

/** Command and resolved working directory of a `shell` call; `workdir` is relative to the location. */
export function shellInput(input: unknown, directory: string): ShellInput | undefined {
  if (input === null || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  if (typeof record.command !== "string") return undefined
  const workdir = typeof record.workdir === "string" && record.workdir !== "" ? record.workdir : undefined
  const cwd = workdir === undefined ? directory : isAbsolute(workdir) ? workdir : resolve(directory, workdir)
  return { command: record.command, cwd }
}
