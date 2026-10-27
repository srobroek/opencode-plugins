import { contentPlugin } from "@srobroek/opencode-lib/content-plugin"

/** `adversarial-challenger` is a fallback copy of agent-reviewer's, registered only without it. */
export const FALLBACK_AGENTS = { "adversarial-challenger": "agent-reviewer" } as const

export default contentPlugin("srobroek.quality", import.meta.url, { fallbacks: FALLBACK_AGENTS })
