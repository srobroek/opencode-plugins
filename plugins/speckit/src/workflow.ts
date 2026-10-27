/**
 * The SpecKit workflow instructions, added to a session's system prompt when the session's
 * directory holds `.specify/` at its first request. The text is read once, and the decision
 * is kept for the session either way, so the system prompt never changes mid-session and
 * provider prompt caching holds. A session that sets SpecKit up later gets the text in the
 * `speckit_setup` result instead.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

/** Agents with their own SpecKit prompt; the workflow text would only repeat it. */
export const OWN_PROMPT_AGENTS: readonly string[] = ["speckit-sync", "speckit-verify"]

export function usesSpeckit(directory: string): boolean {
  return existsSync(join(directory, ".specify"))
}

/** Where the per-session decisions persist, so a restarted server keeps them. */
export type LatchStore = {
  get: (sessionID: string) => Promise<boolean | undefined>
  set: (sessionID: string, value: boolean) => Promise<void>
}

/**
 * Per-session latch. `include(sessionID, agent, directory)` says whether this request
 * carries the workflow text. The first request of a session decides, and later requests
 * repeat that answer without looking at the directory again. `lacks(sessionID)` is true
 * for a session that decided without the text.
 */
export function workflowLatch(detect: (directory: string) => boolean = usesSpeckit, store?: LatchStore) {
  const decided = new Map<string, Promise<boolean>>()
  const decide = async (sessionID: string, directory: () => Promise<string>): Promise<boolean> => {
    const stored = await store?.get(sessionID).catch(() => undefined)
    if (stored !== undefined) return stored
    const value = await directory().then(detect, () => false)
    await store?.set(sessionID, value).catch(() => {})
    return value
  }
  return {
    include(sessionID: string, agent: string, directory: () => Promise<string>): Promise<boolean> {
      if (OWN_PROMPT_AGENTS.includes(agent)) return Promise.resolve(false)
      let known = decided.get(sessionID)
      if (known === undefined) {
        known = decide(sessionID, directory)
        decided.set(sessionID, known)
      }
      return known
    },
    async lacks(sessionID: string): Promise<boolean> {
      const known = decided.get(sessionID)
      if (known !== undefined) return !(await known)
      return (await store?.get(sessionID).catch(() => undefined)) === false
    },
    clear: () => decided.clear(),
  }
}
