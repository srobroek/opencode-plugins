import type { Result } from "@opencode/plugin/promise/tool"
import { resultText, shellOutput } from "@srobroek/opencode-lib/shell-result"

/**
 * Parse claim output from `bd`. Lease ownership and renewal are handled by
 * native Beads leases; this module does not write lease anchors.
 */
const BD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/

/**
 * Bead ids that a completed claim reports as claimed by this actor. Read from
 * `bd`'s own output rather than from the command text, so quoting, wrappers and
 * heredocs are irrelevant.
 */
export function claimedIds(output: string): string[] {
  const ids = new Set<string>()
  for (const match of output.matchAll(/"id"\s*:\s*"([^"]+)"/g)) {
    const id = match[1]
    if (id && BD_ID.test(id)) ids.add(id)
  }
  for (const id of claimedTextIds(output)) ids.add(id)
  return [...ids]
}

/** Bead ids carried by explicit `Claimed` result lines, excluding unrelated JSON objects. */
export function claimedTextIds(output: string): string[] {
  const ids = new Set<string>()
  for (const match of output.matchAll(/\bclaimed(?:\s+issue:)?\s+([A-Za-z][A-Za-z0-9-]+(?:\.\d+)*)\b/gi)) {
    const id = match[1]
    if (id && BD_ID.test(id)) ids.add(id)
  }
  return [...ids]
}

/**
 * Text a claim's shell result carries: the rendered content and the raw shell output,
 * which can differ when the rendered content was truncated.
 */
export function claimResultOutput(result: Result | undefined): string {
  const content = resultText(result)
  const output = shellOutput(result) ?? ""
  return content === output ? content : [content, output].filter(Boolean).join("\n")
}
