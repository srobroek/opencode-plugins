/**
 * Advisories for the start of a session: things nothing in the conversation would
 * otherwise surface. They are computed once per session and frozen into its system text
 * next to `bd prime`, so every request of the session stays byte-identical.
 */

import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { repoIdentity, sessionPinFor } from "./beads-store.ts"
import { binaryHooksRepairAdvisory } from "./binary-hooks.ts"
import { bdStoreDir } from "./gate-admission.ts"

/**
 * What the previous detached push left behind. The writer records `started:` before it
 * detaches and overwrites it with a verdict, so a surviving `started:` means it was cut off.
 */
export function lastPushNotice(contents: string): string | undefined {
  const lines = contents.split("\n").filter((line) => line.trim().length > 0)
  const last = lines[lines.length - 1] ?? ""
  if (last.startsWith("failed:"))
    return `The last session's beads push FAILED -- bead state is committed locally but not published: ${last}. Rerun the push once the cause is fixed.`
  if (last.startsWith("started:"))
    return "The last session's beads push did not finish (no verdict recorded), so it may need rerunning."
  return undefined
}

/** Read the push verdict in `store` and consume it, so it is reported once. */
export function consumeLastPush(store: string): string | undefined {
  const log = join(store, "last-push.log")
  if (!existsSync(log)) return undefined
  let notice: string | undefined
  try {
    notice = lastPushNotice(readFileSync(log, "utf8"))
  } catch {
    notice = undefined
  }
  try {
    rmSync(log, { force: true })
  } catch {
    // A verdict that cannot be consumed is still worth reporting once.
  }
  return notice
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * An inherited `BEADS_DIR` that points at another repository's store. Shell calls
 * honour an explicit `BEADS_DIR`, so `bd` here would read and write that store.
 */
export function storeConflictAdvisory(
  directory: string,
  env: NodeJS.ProcessEnv,
  pinFor: (cwd: string) => string | undefined = sessionPinFor,
  identity: (cwd: string) => string | undefined = repoIdentity,
): string | undefined {
  const pinned = env.BEADS_DIR
  if (pinned === undefined || pinned === "") return undefined
  const own = pinFor(directory)
  if (own === undefined) return undefined
  const foreign = resolve(directory, pinned)
  if (canonical(foreign) === canonical(own)) return undefined
  const theirs = identity(dirname(foreign))
  if (theirs !== undefined && theirs === identity(directory)) return undefined
  return `This OpenCode process has BEADS_DIR=${pinned}, which is another repository's beads store. Shell calls here inherit it, so bd would read and write that store instead of this checkout's ${own}. Prefix each bd call with BEADS_DIR=${own}, or restart OpenCode without BEADS_DIR, before writing.`
}

export type StartDeps = {
  env: NodeJS.ProcessEnv
  binaryHooks: boolean
  pinFor?: (cwd: string) => string | undefined
  identity?: (cwd: string) => string | undefined
  hooksAdvisory?: (cwd: string) => string | undefined
}

/** Every session-start advisory for `directory`, in a stable order. */
export function sessionStartAdvisories(directory: string, deps: StartDeps): string[] {
  const advisories: string[] = []
  if (deps.binaryHooks) {
    const hooks = (deps.hooksAdvisory ?? binaryHooksRepairAdvisory)(directory)
    if (hooks !== undefined) advisories.push(hooks)
  }
  const conflict = storeConflictAdvisory(directory, deps.env, deps.pinFor, deps.identity)
  if (conflict !== undefined) advisories.push(conflict)
  const own = (deps.pinFor ?? sessionPinFor)(directory)
  const store = own ?? bdStoreDir(directory, {})
  if (store !== undefined) {
    const pushed = consumeLastPush(store)
    if (pushed !== undefined) advisories.push(pushed)
  }
  return advisories
}
