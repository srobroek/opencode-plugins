/**
 * MCP servers a plugin adds through `ctx.mcp.transform`.
 *
 * Servers are written in the Claude Code `.mcp.json` format, so the same file ships to
 * Claude Code and Codex through the marketplace export and to OpenCode through
 * `registerMcp`. The OpenCode side differs from a config entry in four ways:
 *
 * - `${VAR}` and `${VAR:-default}` are expanded here from `process.env`, because OpenCode
 *   does not expand `{env:VAR}` in configs a plugin sets. A server that names an unset
 *   variable without a default is skipped.
 * - A server already in the editor (the user's config) is left alone, so config wins.
 * - Code Mode is set explicitly on every server.
 * - The `mcp` option picks `auto` (only where the plugin's relevance check passes),
 *   `always` or `off`, and `mcpServers` turns single servers on or off by name.
 */

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { Context } from "@opencode/plugin/promise/plugin"

/** One server in Claude Code `.mcp.json` format. */
export type ClaudeMcpServer = {
  type?: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export type McpServers = Record<string, ClaudeMcpServer>

/** The OpenCode V2 server config `editor.set` takes. */
export type McpConfig = Parameters<MCPEditor["set"]>[1]

export type McpMode = "auto" | "always" | "off"

export const MCP_MODES: readonly McpMode[] = ["auto", "always", "off"]

export type McpOptions = {
  mode: McpMode
  /** Per-server switches from the `mcpServers` option; a name not listed uses the plugin default. */
  servers: Record<string, boolean>
}

type Env = Record<string, string | undefined>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")

/** Parse a `.mcp.json` document (`{ "mcpServers": { ... } }`). Throws on a malformed server. */
export function parseMcpJson(text: string, where = ".mcp.json"): McpServers {
  const document = JSON.parse(text) as unknown
  if (!isRecord(document)) throw new Error(`${where}: expected an object`)
  const servers = document.mcpServers ?? {}
  if (!isRecord(servers)) throw new Error(`${where}: mcpServers must be an object`)
  const result: McpServers = {}
  for (const [name, server] of Object.entries(servers)) {
    const at = `${where}: ${name}`
    if (!isRecord(server)) throw new Error(`${at}: expected an object`)
    const type = server.type ?? (server.url === undefined ? "stdio" : "http")
    if (type !== "stdio" && type !== "http" && type !== "sse") throw new Error(`${at}: unknown type ${String(type)}`)
    if (type === "stdio") {
      if (typeof server.command !== "string" || server.command === "") throw new Error(`${at}: command is required`)
      if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every((a) => typeof a === "string")))
        throw new Error(`${at}: args must be strings`)
      if (server.env !== undefined && !isStringRecord(server.env)) throw new Error(`${at}: env must map to strings`)
      if (server.cwd !== undefined && typeof server.cwd !== "string") throw new Error(`${at}: cwd must be a string`)
    } else {
      if (typeof server.url !== "string" || server.url === "") throw new Error(`${at}: url is required`)
      if (server.headers !== undefined && !isStringRecord(server.headers))
        throw new Error(`${at}: headers must map to strings`)
    }
    result[name] = { ...(server as ClaudeMcpServer), type }
  }
  return result
}

/** Read and parse `path`; a missing file has no servers. */
export function loadMcpJson(path: string): McpServers {
  if (!existsSync(path)) return {}
  return parseMcpJson(readFileSync(path, "utf8"), path)
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** Expand `${VAR}` and `${VAR:-default}`; collects the names of unset variables without a default. */
export function expandVars(value: string, env: Env, missing: Set<string>): string {
  return value.replace(VARIABLE, (_, name: string, fallback: string | undefined) => {
    const found = env[name]
    if (found !== undefined && found !== "") return found
    if (fallback !== undefined) return fallback
    if (found === undefined) missing.add(name)
    return ""
  })
}

const expandRecord = (record: Record<string, string> | undefined, env: Env, missing: Set<string>) =>
  record === undefined
    ? undefined
    : Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandVars(value, env, missing)]))

/** Convert one Claude-format server to an OpenCode config, or list the unset variables it needs. */
export function toOpenCode(server: ClaudeMcpServer, env: Env): { config: McpConfig } | { missing: string[] } {
  const missing = new Set<string>()
  let config: Record<string, unknown>
  if (server.type === "http" || server.type === "sse" || (server.type === undefined && server.url !== undefined)) {
    const headers = expandRecord(server.headers, env, missing)
    config = {
      type: "remote",
      url: expandVars(server.url ?? "", env, missing),
      ...(headers === undefined ? {} : { headers }),
      codemode: true,
    }
  } else {
    const environment = expandRecord(server.env, env, missing)
    config = {
      type: "local",
      command: [server.command ?? "", ...(server.args ?? [])].map((part) => expandVars(part, env, missing)),
      ...(server.cwd === undefined ? {} : { cwd: expandVars(server.cwd, env, missing) }),
      ...(environment === undefined ? {} : { environment }),
      codemode: true,
    }
  }
  if (missing.size > 0) return { missing: [...missing].sort() }
  return { config: config as McpConfig }
}

/** Read the `mcp` and `mcpServers` plugin options. Unknown values fall back to `auto` and are ignored. */
export function parseMcpOptions(options: Record<string, unknown> | undefined): McpOptions {
  const mode = MCP_MODES.includes(options?.mcp as McpMode) ? (options?.mcp as McpMode) : "auto"
  const servers: Record<string, boolean> = {}
  if (isRecord(options?.mcpServers)) {
    for (const [name, value] of Object.entries(options.mcpServers)) if (typeof value === "boolean") servers[name] = value
  }
  return { mode, servers }
}

export type McpSettings = {
  /** Whether the location is a project the servers help with; consulted only in `auto` mode. */
  relevant?: () => boolean
  /** Servers off unless `mcpServers` turns them on, by name. */
  off?: readonly string[]
  /** OpenCode-only fields merged over a converted server (timeouts, `oauth: false`), by name. */
  extra?: Record<string, Record<string, unknown>>
  env?: Env
}

export type McpPlan = {
  add: [string, McpConfig][]
  skipped: { name: string; reason: string }[]
}

/** Decide which servers to add. Pure apart from calling `settings.relevant`. */
export function planMcp(servers: McpServers, options: McpOptions, settings: McpSettings = {}): McpPlan {
  const plan: McpPlan = { add: [], skipped: [] }
  const names = Object.keys(servers)
  const skipAll = (reason: string) => ({ add: [], skipped: names.map((name) => ({ name, reason })) })
  if (options.mode === "off") return skipAll("mcp is off")
  if (options.mode === "auto" && settings.relevant !== undefined && !settings.relevant())
    return skipAll("not relevant here")
  const off = new Set(settings.off ?? [])
  for (const name of names) {
    const server = servers[name] as ClaudeMcpServer
    if (!(options.servers[name] ?? !off.has(name))) {
      plan.skipped.push({ name, reason: "turned off" })
      continue
    }
    const converted = toOpenCode(server, settings.env ?? process.env)
    if ("missing" in converted) {
      plan.skipped.push({ name, reason: `unset ${converted.missing.join(", ")}` })
      continue
    }
    plan.add.push([name, { ...converted.config, ...settings.extra?.[name] } as McpConfig])
  }
  return plan
}

/** Apply a plan to an editor, leaving every server already configured under that name alone. */
export function applyMcp(editor: Pick<MCPEditor, "get" | "set">, add: McpPlan["add"]): void {
  for (const [name, config] of add) {
    if (editor.get(name) !== undefined) continue
    editor.set(name, structuredClone(config))
  }
}

/** The directories a relevance check should look in: the location and its project root. */
export function locationDirectories(ctx: Pick<Context, "location">): string[] {
  const location = ctx.location as { directory: string; project?: { directory?: string } }
  const directories = [location.directory]
  const root = location.project?.directory
  if (typeof root === "string" && root !== location.directory) directories.push(root)
  return directories
}

/**
 * Add `servers` through `ctx.mcp.transform` as `options` and `settings` allow. Returns the
 * registration (a no-op when nothing is added) and the plan, so a caller can report skips.
 */
export async function registerMcp(
  ctx: Pick<Context, "mcp">,
  servers: McpServers,
  options: McpOptions,
  settings: McpSettings = {},
): Promise<{ registration: { dispose: () => Promise<void> }; plan: McpPlan }> {
  const plan = planMcp(servers, options, settings)
  if (plan.add.length === 0) return { registration: { dispose: async () => {} }, plan }
  const registration = await ctx.mcp.transform((editor) => applyMcp(editor, plan.add))
  return { registration, plan }
}

export type PluginMcpSettings = Omit<McpSettings, "relevant"> & {
  /** Whether a directory (the location, then its project root) is one the servers help with. */
  relevant?: (directory: string) => boolean
  /** OpenCode-only servers added after the `.mcp.json` ones, kept out of the Claude Code and Codex export. */
  servers?: McpServers
}

/**
 * Add the servers of the `.mcp.json` at the root of the package whose module URL is
 * `moduleUrl` (one level above `src/` and the bundled `dist/`), reading the plugin's
 * `mcp` and `mcpServers` options.
 */
export async function registerPluginMcp(
  ctx: Pick<Context, "mcp" | "location" | "options">,
  moduleUrl: string,
  settings: PluginMcpSettings = {},
) {
  const { relevant, servers: more, ...rest } = settings
  const servers = { ...loadMcpJson(fileURLToPath(new URL("../.mcp.json", moduleUrl))), ...more }
  const options = parseMcpOptions(ctx.options as Record<string, unknown>)
  const check = relevant === undefined ? undefined : () => locationDirectories(ctx).some(relevant)
  return registerMcp(ctx, servers, options, { ...rest, relevant: check })
}
