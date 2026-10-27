import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { contentPaths } from "@srobroek/opencode-lib/content-plugin"
import { loadMcpJson, parseMcpOptions, registerMcp } from "@srobroek/opencode-lib/mcp"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"

export const SOURCE = "srobroek.ast-grep"
export const SERVER = "ast-grep"

type Env = Record<string, string | undefined>

const isExecutable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Find `name` on `PATH` (with `PATHEXT` on Windows). */
export function onPath(name: string, env: Env = process.env, executable = isExecutable, platform = process.platform) {
  const extensions = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""]
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue
    for (const extension of extensions) if (executable(join(directory, name + extension))) return true
  }
  return false
}

/**
 * Whether the server can run: it shells out to `ast-grep`, or to `AST_GREP_PATH` when set.
 * `sg` alone does not count, since the server never calls it (and on Linux `sg` is often
 * shadow-utils' group command).
 */
export function astGrepAvailable(env: Env = process.env, executable = isExecutable, platform = process.platform) {
  if ((env.AST_GREP_PATH ?? "").trim() !== "") return true
  return onPath("ast-grep", env, executable, platform)
}

// The first start builds the uvx environment from git (about 18 s cold), past the 30 s default on slow links.
export const EXTRA = { [SERVER]: { timeout: { startup: 120000 } } }

let warned = false

/** Test seam; the host never passes it. */
export type Overrides = { env?: Env; available?: () => boolean; warn?: (text: string) => void }

export async function setupAstGrep(ctx: Context, moduleUrl: string, overrides: Overrides = {}) {
  const env = overrides.env ?? process.env
  const { skills } = contentPaths(moduleUrl)
  const registrations: { dispose: () => Promise<void> }[] = []
  const cleanup = async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
  try {
    if (skills.length > 0) registrations.push(await registerSkills(ctx.skill, skills))
    const servers = loadMcpJson(fileURLToPath(new URL("../.mcp.json", moduleUrl)))
    const options = parseMcpOptions(ctx.options as Record<string, unknown>)
    const available = overrides.available ?? (() => astGrepAvailable(env))
    const mcp = await registerMcp(ctx, servers, options, { relevant: available, extra: EXTRA, env })
    registrations.push(mcp.registration)
    if (!warned && mcp.plan.skipped.some((skip) => skip.reason === "not relevant here")) {
      warned = true
      const warn = overrides.warn ?? ((text: string) => console.warn(text))
      warn(`${SOURCE}: ast-grep is not on PATH, so the ${SERVER} MCP server is not added; install ast-grep and run /reload`)
    }
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}

/** Test seam: let the one-time warning fire again. */
export function resetWarning() {
  warned = false
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: SOURCE,
    setup: (ctx) => setupAstGrep(ctx, import.meta.url, overrides),
  })
}

export default createPlugin()
