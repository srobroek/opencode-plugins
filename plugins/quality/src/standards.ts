import type { Context } from "@opencode/plugin/promise/plugin"
import { STANDARDS, TESTING } from "@srobroek/opencode-lib/coding-core"

/**
 * The engineering standards for agents whose prompt does not carry coding-core: research first,
 * compare with the preferred libraries, middleware, Powertools, OpenTelemetry. Static, so the
 * provider's prompt cache holds.
 */
export const STANDARDS_TEXT = `# Engineering standards\n\n${STANDARDS}`

/** The testing standards from the same coding-core, as a second static block. */
export const TESTING_TEXT = `# Testing standards\n\n${TESTING}`

/** The blocks appended to each selected request, in order. */
export const STANDARDS_BLOCKS: ReadonlyArray<string> = [STANDARDS_TEXT, TESTING_TEXT]

/** Code-writing subagents without coding-core in their prompt. coder and the implementers include it. */
export const DEFAULT_STANDARDS_SUBAGENTS: ReadonlyArray<string> = ["general"]

export type StandardsOptions = { subagents: ReadonlySet<string> } | undefined

/** `standards: false` turns the block off; `standardsSubagents` replaces the subagent list. */
export function parseStandardsOptions(options: Readonly<Record<string, unknown>>): StandardsOptions {
  if (options.standards === false) return undefined
  const list = options.standardsSubagents
  const ids = Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : DEFAULT_STANDARDS_SUBAGENTS
  return { subagents: new Set(ids) }
}

/** Every primary session gets the block, and child sessions of the listed subagents. */
export function wantsStandards(primary: boolean, agent: string, subagents: ReadonlySet<string>): boolean {
  return primary || subagents.has(agent)
}

type SystemEvent = { sessionID: string; agent: string; system: Array<{ type: "text"; text: string }> }

async function isPrimary(ctx: Context, sessionID: string): Promise<boolean> {
  try {
    const session = (await ctx.session.get({ sessionID } as never)) as { parentID?: string | null } | undefined
    return session !== undefined && (session.parentID === undefined || session.parentID === null)
  } catch {
    return false
  }
}

/** Append the standards blocks to the system prompt of the sessions `options` selects. */
export async function setupStandards(ctx: Context, options: StandardsOptions): Promise<() => Promise<void>> {
  if (options === undefined) return async () => {}
  const primary = new Map<string, Promise<boolean>>()
  // Also on compaction and generate, so those requests keep the turns' system prompt and prompt cache.
  const add = async (event: SystemEvent) => {
    let known = primary.get(event.sessionID)
    if (known === undefined) {
      known = isPrimary(ctx, event.sessionID)
      primary.set(event.sessionID, known)
    }
    if (wantsStandards(await known, event.agent, options.subagents))
      for (const text of STANDARDS_BLOCKS) event.system.push({ type: "text", text })
  }
  const hooks = [
    await ctx.session.hook("context", add),
    await ctx.session.hook("compaction", add),
    await ctx.session.hook("generate", add),
  ]
  return async () => {
    for (const hook of hooks) await hook.dispose()
    primary.clear()
  }
}
