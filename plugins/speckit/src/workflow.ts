/**
 * The SpecKit workflow instructions, added to a session's system prompt once the session's
 * directory holds `.specify/`. The text is read once, and a session that has it keeps it,
 * so the system prompt changes at most once per session and provider prompt caching holds.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

/** Agents with their own SpecKit prompt; the workflow text would only repeat it. */
export const OWN_PROMPT_AGENTS: readonly string[] = ["speckit-sync", "speckit-verify"]

export function usesSpeckit(directory: string): boolean {
  return existsSync(join(directory, ".specify"))
}

/**
 * Per-session latch. `include(sessionID, agent, directory)` says whether this request
 * carries the workflow text: once true for a session, always true for it, so the
 * session's directory is looked up only until then.
 */
export function workflowLatch(detect: (directory: string) => boolean = usesSpeckit) {
  const on = new Set<string>()
  return {
    async include(sessionID: string, agent: string, directory: () => Promise<string>): Promise<boolean> {
      if (OWN_PROMPT_AGENTS.includes(agent)) return false
      if (on.has(sessionID)) return true
      if (!detect(await directory())) return false
      on.add(sessionID)
      return true
    },
    clear: () => on.clear(),
  }
}
