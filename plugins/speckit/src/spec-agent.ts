/**
 * When the primary `spec` agent is registered. Each location runs its own plugin instance,
 * so registering it only where SpecKit is in use keeps it out of the agent list (and the
 * primary-agent cycle) in every other project.
 */

import { basename } from "node:path"
import { speckitWorkspace, usesSpeckit } from "./workflow.ts"

export const SPEC_AGENT = "spec"

/** `auto`: only where the location or its project root holds `.specify/`. */
export type SpecAgentSetting = "auto" | boolean

export function specAgentSetting(raw: unknown): SpecAgentSetting {
  return typeof raw === "boolean" ? raw : "auto"
}

/** Whether the agent file at `path` is the `spec` agent. */
export function isSpecAgent(path: string): boolean {
  return basename(path, ".md") === SPEC_AGENT
}

/** Whether a location with these directories (location, then project root) has a SpecKit workspace. */
export function wantsSpecAgent(
  setting: SpecAgentSetting,
  directories: readonly string[],
  detect: (directory: string) => boolean = usesSpeckit,
): boolean {
  if (setting !== "auto") return setting
  const [location, projectRoot] = directories
  return location !== undefined && speckitWorkspace(location, projectRoot, detect) !== undefined
}
