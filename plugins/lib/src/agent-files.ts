/**
 * Register agent markdown shipped inside a plugin package through `ctx.agent.transform`.
 *
 * A plugin keeps its agents as `agents/<id>.md` in the V2 markdown shape that
 * `scripts/convert-agent.ts` writes: flat `description`, `mode` and `steps` keys, a
 * `request.headers` map, a `permissions` list of `action`/`resource`/`effect` items, and
 * the prompt as the body. Shipped agents never pin a model: they name a model-roles tier
 * in the `x-opencode-model-role` header, and without that plugin inherit the session model.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"

export type AgentMode = "subagent" | "primary" | "all"
export type AgentPermission = { action: string; resource: string; effect: "allow" | "ask" | "deny" }

export type AgentFile = {
  id: string
  description?: string
  mode: AgentMode
  steps?: number
  request?: { headers: Record<string, string> }
  permissions: AgentPermission[]
  /** The body after the frontmatter, used as the agent's system prompt. */
  system: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const MODES: readonly string[] = ["subagent", "primary", "all"]
const EFFECTS: readonly string[] = ["allow", "ask", "deny"]

function scalar(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"')) return JSON.parse(value) as string
  if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

/** Parse one agent file. Throws on a key or value outside the shape described above. */
export function parseAgentFile(text: string, id: string): AgentFile {
  const source = text.replace(/^\uFEFF/, "")
  const match = FRONTMATTER.exec(source)
  if (!match) throw new Error(`agent ${id}: no frontmatter`)
  const agent: AgentFile = { id, mode: "subagent", permissions: [], system: source.slice(match[0].length).trim() }
  let rule: Partial<AgentPermission> | undefined
  let section: "permissions" | "request" | "headers" | undefined
  const flush = () => {
    if (!rule) return
    const { action, resource, effect } = rule
    if (!action || !resource || !effect || !EFFECTS.includes(effect))
      throw new Error(`agent ${id}: incomplete permission ${JSON.stringify(rule)}`)
    agent.permissions.push({ action, resource, effect })
    rule = undefined
  }
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue
    if (section === "permissions") {
      const item = /^\s+(-\s+)?([a-z]+):\s*(.*)$/.exec(line)
      if (item) {
        if (item[1]) flush()
        rule ??= {}
        const key = item[2] as keyof AgentPermission
        if (key !== "action" && key !== "resource" && key !== "effect")
          throw new Error(`agent ${id}: unknown permission key ${key}`)
        ;(rule as Record<string, string>)[key] = scalar(item[3] ?? "")
        continue
      }
    }
    if (section === "request" || section === "headers") {
      const headers = /^ {2}headers:\s*$/.exec(line)
      if (headers) {
        agent.request = { headers: {} }
        section = "headers"
        continue
      }
      const header = /^ {4}([\w-]+):\s*(.*)$/.exec(line)
      if (section === "headers" && header && agent.request) {
        agent.request.headers[header[1] ?? ""] = scalar(header[2] ?? "")
        continue
      }
      if (/^\s/.test(line)) throw new Error(`agent ${id}: request supports only headers`)
    }
    flush()
    section = undefined
    const field = /^([a-z][\w-]*):\s*(.*)$/.exec(line)
    if (!field) throw new Error(`agent ${id}: unreadable frontmatter line ${JSON.stringify(line)}`)
    const [, key, value = ""] = field
    if (key === "description") agent.description = scalar(value)
    else if (key === "mode") {
      const mode = scalar(value)
      if (!MODES.includes(mode)) throw new Error(`agent ${id}: bad mode ${mode}`)
      agent.mode = mode as AgentMode
    } else if (key === "steps") {
      const steps = Number(scalar(value))
      if (!Number.isInteger(steps) || steps <= 0) throw new Error(`agent ${id}: steps must be a positive integer`)
      agent.steps = steps
    } else if (key === "request") {
      if (value.trim() !== "") throw new Error(`agent ${id}: request must be a map`)
      section = "request"
    } else if (key === "permissions") {
      if (value.trim() === "[]") continue
      if (value.trim() !== "") throw new Error(`agent ${id}: permissions must be a list`)
      section = "permissions"
    } else throw new Error(`agent ${id}: unsupported frontmatter key ${key}`)
  }
  flush()
  return agent
}

/** Read `<path>` and parse it as the agent named by its file name. */
export function readAgentFile(path: string): AgentFile {
  return parseAgentFile(readFileSync(path, "utf8"), basename(path, ".md"))
}

/** The absolute path of every `<directory>/*.md`, sorted. */
export function agentPaths(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(directory, name))
}

type MutableAgent = {
  name?: string
  description?: string
  mode?: string
  system?: string
  steps?: number
  request?: { headers?: Record<string, string> }
  permissions?: AgentPermission[]
}

/**
 * Fill an agent from its file. Fields the agent already has win, including its own request
 * headers; the file's permission rules go after existing ones, so its boundary holds (the
 * last matching rule wins). A `created` agent takes the file's mode, because the host
 * gives a new agent `primary`.
 */
export function shapeAgent(agent: MutableAgent, file: AgentFile, created: boolean): void {
  agent.name ??= file.id
  if (file.description !== undefined) agent.description ??= file.description
  if (created || agent.mode === undefined) agent.mode = file.mode
  agent.system ??= file.system
  if (file.steps !== undefined) agent.steps ??= file.steps
  if (file.request) agent.request = { ...agent.request, headers: { ...file.request.headers, ...agent.request?.headers } }
  agent.permissions = [...(agent.permissions ?? []), ...file.permissions]
}

/** Register every agent file. Files are read once, before the transform registers. */
export async function registerAgents(agent: Context["agent"], paths: readonly string[]) {
  const files = paths.map(readAgentFile)
  return agent.transform((editor) => {
    for (const file of files) {
      const created = editor.get(file.id) === undefined
      editor.update(file.id, (info) => shapeAgent(info as unknown as MutableAgent, file, created))
    }
  })
}
