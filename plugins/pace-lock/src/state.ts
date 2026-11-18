import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** The binding the checker writes to `opencode-<root>.json`. Only a `bound` state locks a session. */
export type LockState = { state: string; customer?: string; account?: string; region?: string; expires_at?: string }

/** Directory of the checker's state files; `PACE_LOCK_STATE_DIR` overrides it for tests. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PACE_LOCK_STATE_DIR || join(homedir(), ".local", "state", "pace-lock")
}

export function stateFile(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), `opencode-${root}.json`)
}

/** Parse the checker's JSON; anything that is not a state object reads as unbound. */
export function parseState(text: string): LockState {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === "object" && value !== null && typeof (value as LockState).state === "string") return value as LockState
  } catch {}
  return { state: "unbound" }
}

export function readState(root: string, env: NodeJS.ProcessEnv = process.env): LockState {
  try {
    return parseState(readFileSync(stateFile(root, env), "utf8"))
  } catch {
    return { state: "unbound" }
  }
}

/** The banner row for a state, or undefined when the session is not bound. */
export function bannerText(state: LockState): string | undefined {
  if (state.state !== "bound" || !state.customer) return undefined
  const account = state.account ? ` (${state.account})` : ""
  return `⚠ PACE: ${state.customer}${account} ⚠`
}
