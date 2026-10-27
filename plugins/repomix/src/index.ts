import { statSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { contentPaths } from "@srobroek/opencode-lib/content-plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import {
  chooseRunner,
  confirmPack,
  PACK_DESCRIPTION,
  PACK_INPUT,
  PACK_TOOL,
  type PackDeps,
  readPackParams,
  resolveTarget,
  runPack,
  targetResource,
} from "./pack.ts"

export {
  chooseRunner,
  confirmPack,
  interpretPack,
  PACK_TOOL,
  packArgv,
  packLabel,
  parseSummary,
  prunePacks,
  REPOMIX_VERSION,
  readPackParams,
  resolveTarget,
  targetResource,
} from "./pack.ts"

export type RepomixOptions = { confirmPack: boolean }

export function parseOptions(options: Record<string, unknown> | undefined): RepomixOptions {
  return { confirmPack: options?.confirmPack !== false }
}

/** Test seam; the host never passes it. */
export type Overrides = PackDeps & { which?: (bin: string) => string | null; isDirectory?: (path: string) => boolean }

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export async function setupRepomix(ctx: Context, moduleUrl: string, overrides: Overrides = {}) {
  const options = parseOptions(ctx.options as Record<string, unknown>)
  const location = ctx.location.directory as string
  const { skills } = contentPaths(moduleUrl)
  const registrations: { dispose: () => Promise<void> }[] = []
  const cleanup = async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
  const directory = (sessionID: string) =>
    ctx.session
      .get({ sessionID })
      .then((session) => (session.location.directory as string) ?? location)
      .catch(() => location)
  const which = overrides.which ?? ((bin: string) => Bun.which(bin))

  try {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: PACK_TOOL,
          description: PACK_DESCRIPTION,
          input: PACK_INPUT,
          execute: async (input, context) => {
            const params = readPackParams(input)
            if (typeof params === "string") return { content: `${PACK_TOOL}: ${params}`, metadata: { ok: false } }
            const target = resolveTarget(params, await directory(context.sessionID))
            if (target.kind === "local" && !(overrides.isDirectory ?? isDirectory)(target.directory))
              return { content: `${PACK_TOOL}: ${target.directory} is not a directory`, metadata: { ok: false } }
            const runner = chooseRunner(which)
            const resource = targetResource(target)
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
              action: PACK_TOOL,
              resources: [resource],
              save: [resource],
              metadata: { runner: runner.kind, target: resource, compress: params.compress, include: params.include },
            } as never)
            const result = await runPack(params, target, runner, context.signal, overrides)
            return {
              content: result.ok ? result.text : `${PACK_TOOL}: ${result.text}`,
              metadata: {
                ok: result.ok,
                status: result.status,
                runner: runner.kind,
                path: result.path,
                files: result.summary?.files,
                tokens: result.summary?.tokens,
                topFiles: result.summary?.topFiles,
                suspiciousExcluded: result.summary?.suspiciousExcluded,
              },
            }
          },
        })
      }),
    )
    if (options.confirmPack) registrations.push(await ctx.permission.hook("evaluate", confirmPack as never))
    if (skills.length > 0) registrations.push(await registerSkills(ctx.skill, skills))
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.repomix",
    setup: (ctx) => setupRepomix(ctx, import.meta.url, overrides),
  })
}

export default createPlugin()
