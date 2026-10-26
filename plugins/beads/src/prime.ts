/**
 * `bd prime` as stable system context.
 *
 * The text is read once per location and frozen per session in storage, so every
 * request of a session carries byte-identical system text and provider prompt caches
 * keep hitting. Live state never goes here; it goes in tool results.
 */

import { type BdRun, bdStoreDir, runBdResult } from "./gate-admission.ts"

/** The longest the first request of a session waits for `bd prime`. */
export const PRIME_WAIT_MS = 15_000

const PRIME_CEILING_MS = 60_000

/** `bd prime` output for `cwd`, or `""` when there is no store or the read failed. */
export async function readPrime(cwd: string, env: NodeJS.ProcessEnv, run: BdRun = runBdResult): Promise<string> {
  if (bdStoreDir(cwd, env) === undefined) return ""
  const result = await run(cwd, ["prime"], Date.now() + PRIME_CEILING_MS, env)
  return "output" in result ? result.output.trim() : ""
}

/** The value stored for a session: the frozen text, possibly empty. */
export function storedPrime(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined
  const text = (value as Record<string, unknown>).text
  return typeof text === "string" ? text : undefined
}
