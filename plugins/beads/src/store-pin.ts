/** The store pin a shell child gets: harness-neutral, shared by the OpenCode plugin and the Claude Code hook. */

import { sessionPinFor } from "./beads-store.ts"
import { EMBEDDED_PIN_ENV } from "./gate-admission.ts"

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
