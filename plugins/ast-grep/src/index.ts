import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { contentPaths } from "@srobroek/opencode-lib/content-plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"

export const SOURCE = "srobroek.ast-grep"

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

let warned = false

/** Test seam; the host never passes it. */
export type Overrides = { env?: Env; available?: () => boolean; warn?: (text: string) => void }

/**
 * Register the skills. The skills drive the `ast-grep` CLI through the shell; there is no MCP
 * server (its cold start was ~10 s and `find_code` returned unbounded output). Without the
 * binary the skills still load and fall back to grep, and one warning says why.
 */
export async function setupAstGrep(ctx: Context, moduleUrl: string, overrides: Overrides = {}) {
  const env = overrides.env ?? process.env
  const { skills } = contentPaths(moduleUrl)
  const registration = skills.length > 0 ? await registerSkills(ctx.skill, skills) : undefined
  const available = overrides.available ?? (() => astGrepAvailable(env))
  if (!warned && !available()) {
    warned = true
    const warn = overrides.warn ?? ((text: string) => console.warn(text))
    warn(`${SOURCE}: ast-grep is not on PATH, so the ast-grep-search skill falls back to grep; install ast-grep and run /reload`)
  }
  return async () => {
    await registration?.dispose()
  }
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
