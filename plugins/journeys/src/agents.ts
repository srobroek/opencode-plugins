import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const AGENT_IDS = ["journey-scribe", "journey-validator"] as const

export const AGENT_PATHS = AGENT_IDS.map((id) => fileURLToPath(new URL(`../agents/${id}.md`, import.meta.url)))

export type Permission = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

/** The fields of an agent markdown file this plugin applies. */
export type AgentFile = {
  id: string
  description?: string
  mode: "subagent" | "primary" | "all"
  steps?: number
  request?: { headers?: Record<string, string> }
  permissions: Permission[]
  system: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Parse an agent markdown file written by `scripts/convert-agent.ts`. */
export function parseAgentFile(id: string, text: string): AgentFile {
  const match = FRONTMATTER.exec(text)
  if (!match) throw new Error(`${id}: agent file has no frontmatter`)
  const data = (Bun.YAML.parse(match[1] ?? "") ?? {}) as Record<string, unknown>
  const mode = data.mode === "primary" || data.mode === "all" ? data.mode : "subagent"
  const agent: AgentFile = {
    id,
    mode,
    permissions: Array.isArray(data.permissions) ? (data.permissions as Permission[]) : [],
    system: text.slice(match[0].length).trim(),
  }
  if (typeof data.description === "string") agent.description = data.description
  if (typeof data.steps === "number") agent.steps = data.steps
  if (data.request && typeof data.request === "object") agent.request = data.request as AgentFile["request"]
  return agent
}

export function loadAgents(paths: readonly string[] = AGENT_PATHS): AgentFile[] {
  return paths.map((path, at) => parseAgentFile(AGENT_IDS[at] ?? path, readFileSync(path, "utf8")))
}

export type AgentFields = {
  name?: string
  description?: string
  mode?: string
  system?: string
  steps?: number
  request?: { headers?: Record<string, string> }
  permissions?: unknown[]
}

/**
 * Apply a shipped agent. Fields the user configured for the same id win, and so do
 * configured permissions: they go after the shipped ones, and the last matching rule wins. A `created` agent gets the shipped mode,
 * because the host fills a new agent's mode with `primary` before the callback runs.
 */
export function shapeAgent(agent: AgentFields, file: AgentFile, created: boolean): void {
  agent.name ??= file.id
  if (file.description !== undefined) agent.description ??= file.description
  if (created || agent.mode === undefined) agent.mode = file.mode
  agent.system ??= file.system
  if (file.steps !== undefined) agent.steps ??= file.steps
  if (file.request?.headers) agent.request = { ...agent.request, headers: { ...file.request.headers, ...agent.request?.headers } }
  agent.permissions = [...file.permissions, ...(agent.permissions ?? [])]
}
