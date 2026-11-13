import { Plugin } from "@opencode/plugin"
import { contentPlugin } from "@srobroek/opencode-lib/content-plugin"
import { parseStandardsOptions, setupStandards } from "./standards.ts"
import { parseTestAuditOptions, setupTestAudit } from "./test-audit.ts"

export * from "./standards.ts"
export * from "./test-audit.ts"

/** `adversarial-challenger` is a fallback copy of agent-reviewer's, registered only without it. */
export const FALLBACK_AGENTS = { "adversarial-challenger": "agent-reviewer" } as const

const content = contentPlugin("srobroek.quality", import.meta.url, { fallbacks: FALLBACK_AGENTS, toolAgents: ["adversarial-challenger"] })

export default Plugin.define({
  id: "srobroek.quality",
  async setup(ctx) {
    const disposeContent = await content.setup(ctx)
    let disposeStandards: () => Promise<void>
    try {
      disposeStandards = await setupStandards(ctx, parseStandardsOptions(ctx.options as Record<string, unknown>))
    } catch (error) {
      await disposeContent?.()
      throw error
    }
    let disposeAudit: () => Promise<void>
    try {
      disposeAudit = await setupTestAudit(ctx, parseTestAuditOptions(ctx.options as Record<string, unknown>))
    } catch (error) {
      await disposeStandards()
      await disposeContent?.()
      throw error
    }
    return async () => {
      await disposeAudit()
      await disposeStandards()
      await disposeContent?.()
    }
  },
})
