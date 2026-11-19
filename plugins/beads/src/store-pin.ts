/** The store pin a shell child gets: harness-neutral, shared by the OpenCode plugin and the Claude Code hook. */

import { sessionPinFor } from "./beads-store.ts"
import { EMBEDDED_PIN_ENV } from "./gate-admission.ts"

/**
 * Names the `BEADS_DIR` this plugin pinned. A process started from a pinned shell, such
 * as an OpenCode server an agent restarted, inherits the pin; the marker tells it apart
 * from a `BEADS_DIR` the user set, so the inheritor resolves its own store per directory
 * instead of following the repository that shell ran in.
 */
export const PIN_MARKER_ENV = "SROBROEK_BEADS_PIN"

/** The variables that pin a child to `store`. */
export function pinVariables(store: string): Record<string, string> {
  return { ...EMBEDDED_PIN_ENV, BEADS_DIR: store, [PIN_MARKER_ENV]: store }
}

/** Whether `env` carries a pin this plugin set, rather than a `BEADS_DIR` someone chose. */
function inheritsPin(env: Record<string, string | undefined>): boolean {
  const marker = env[PIN_MARKER_ENV]
  return marker !== undefined && marker !== "" && env.BEADS_DIR === marker
}

/**
 * `env` without a pin this plugin set: what a process that inherited one should start from.
 * A `BEADS_DIR` the user set, even over a pinned shell, stays.
 */
export function withoutInheritedPin<T extends Record<string, string | undefined>>(env: T): T {
  if (env[PIN_MARKER_ENV] === undefined) return env
  const { [PIN_MARKER_ENV]: _marker, ...rest } = env
  if (inheritsPin(env)) delete rest.BEADS_DIR
  return rest as T
}

/**
 * The store a shell child in `cwd` should open: the checkout's own `.beads`, or the
 * primary checkout's from a linked worktree. `undefined` when `env` already chooses one
 * or there is none.
 */
export function shellPin(cwd: string, env: Record<string, string | undefined>, pinFor = sessionPinFor): string | undefined {
  const explicit = withoutInheritedPin(env).BEADS_DIR
  if (explicit !== undefined && explicit !== "") return undefined
  return pinFor(cwd)
}

/**
 * Pin a child environment the host hands to `create.before`: drop a pin it inherited and
 * set the store for `cwd`, unless the user chose one.
 */
export function pinShell(
  cwd: string,
  env: Record<string, string | undefined>,
  pinFor: (cwd: string) => string | undefined = sessionPinFor,
): void {
  const own = withoutInheritedPin(env)
  if (own.BEADS_DIR === undefined) delete env.BEADS_DIR
  delete env[PIN_MARKER_ENV]
  const pin = shellPin(cwd, own, pinFor)
  if (pin !== undefined) Object.assign(env, pinVariables(pin))
}

/** The environment a gate should assume the child shell gets: `base` plus the pin. */
export function pinnedEnvironment(cwd: string, base: NodeJS.ProcessEnv, pinFor = sessionPinFor): NodeJS.ProcessEnv {
  const env = { ...base }
  pinShell(cwd, env, pinFor)
  return env
}
