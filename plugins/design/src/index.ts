import { resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { registerAgents } from "@srobroek/opencode-lib/agent-files"
import { contentPaths } from "@srobroek/opencode-lib/content-plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { installFormulas, SETUP_TOOL } from "./formulas.ts"
import {
  confirmScan,
  type Exec,
  readScanParams,
  resolveTargets,
  runScan, SCAN_DESCRIPTION, SCAN_INPUT, SCAN_TOOL } from "./impeccable.ts"

export { FORMULAS, installFormulas, SETUP_TOOL } from "./formulas.ts"
export {
  confirmScan,
  countFindings,
  interpretScan,
  readScanParams,
  resolveTargets,
  runScan,
  SCAN_TOOL,
  scanArgv,
} from "./impeccable.ts"

export const SETUP_DESCRIPTION =
  "Copy the design plugin's beads formulas into a beads workspace's .beads/formulas/.\n" +
  "Covers design-touch, design-surface, design-system and the mol-design-* sub-processes, so bd mol pour and " +
  "bd mol bond find them. Identical " +
  "copies stay; divergent ones are refused unless force=true; symlinked paths are always refused."

const SETUP_INPUT = {
  type: "object",
  properties: {
    workspace: { type: "string", description: "Beads workspace root (contains .beads/); default the session directory" },
    force: { type: "boolean", description: "Overwrite design formulas that differ from the shipped ones" },
  },
  additionalProperties: false,
} as const

export type DesignOptions = { confirmScan: boolean }

export function parseOptions(options: Record<string, unknown> | undefined): DesignOptions {
  return { confirmScan: options?.confirmScan !== false }
}

/** Test seam; the host never passes it. */
export type Overrides = { exec?: Exec }

export async function setupDesign(ctx: Context, moduleUrl: string, overrides: Overrides = {}) {
  const options = parseOptions(ctx.options as Record<string, unknown>)
  const location = ctx.location.directory as string
  const { skills, agents } = contentPaths(moduleUrl)
  const registrations: { dispose: () => Promise<void> }[] = []
  const cleanup = async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
  const directory = (sessionID: string) =>
    ctx.session
      .get({ sessionID })
      .then((session) => (session.location.directory as string) ?? location)
      .catch(() => location)
  const assert = (context: ToolContext, action: string, resources: string[], metadata: Record<string, unknown>) =>
    ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
      action,
      resources,
      save: resources,
      metadata,
    } as never)

  try {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: SETUP_TOOL,
          description: SETUP_DESCRIPTION,
          input: SETUP_INPUT,
          execute: async (input, context) => {
            const { workspace, force } = (input ?? {}) as { workspace?: unknown; force?: unknown }
            if (workspace !== undefined && (typeof workspace !== "string" || workspace === ""))
              return { content: `${SETUP_TOOL}: workspace must be a non-empty string`, metadata: { ok: false } }
            const cwd = await directory(context.sessionID)
            const target = resolve(cwd, typeof workspace === "string" ? workspace : ".")
            await assert(context, SETUP_TOOL, [target], { workspace: target, force: force === true })
            const result = installFormulas(target, cwd, force === true)
            return {
              content: result.ok ? result.text : `${SETUP_TOOL}: ${result.text}`,
              metadata: { ok: result.ok, copied: result.copied, unchanged: result.unchanged },
            }
          },
        })
        editor.add({
          name: SCAN_TOOL,
          description: SCAN_DESCRIPTION,
          input: SCAN_INPUT,
          execute: async (input, context) => {
            const params = readScanParams(input)
            if (typeof params === "string") return { content: `${SCAN_TOOL}: ${params}`, metadata: { ok: false } }
            const cwd = await directory(context.sessionID)
            await assert(context, SCAN_TOOL, resolveTargets(params.targets, cwd), { ...params })
            const result = await runScan(params, cwd, context.signal, overrides.exec)
            return {
              content: result.text,
              metadata: { ok: result.ok, status: result.status, exitCode: result.exitCode, findings: result.findings },
            }
          },
        })
      }),
    )
    if (options.confirmScan) registrations.push(await ctx.permission.hook("evaluate", confirmScan as never))
    if (skills.length > 0) registrations.push(await registerSkills(ctx.skill, skills))
    if (agents.length > 0) registrations.push(await registerAgents(ctx.agent, agents))
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.design",
    setup: (ctx) => setupDesign(ctx, import.meta.url, overrides),
  })
}

export default createPlugin()
