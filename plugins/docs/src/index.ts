import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { type McpServers, parseMcpOptions, registerMcp } from "@srobroek/opencode-lib/mcp"

export const CONTEXT7_URL = "https://mcp.context7.com/mcp"
export const OPENAI_DOCS_URL = "https://developers.openai.com/mcp"

/** Off unless the `mcpServers` option turns them on. */
export const OFF_BY_DEFAULT = ["openaiDeveloperDocs"] as const

/** The documentation servers. Context7 sends `CONTEXT7_API_KEY` only when it is set. */
export function docsServers(env: Record<string, string | undefined> = process.env): McpServers {
  return {
    context7: {
      type: "http",
      url: CONTEXT7_URL,
      ...(env.CONTEXT7_API_KEY ? { headers: { CONTEXT7_API_KEY: env.CONTEXT7_API_KEY } } : {}),
    },
    openaiDeveloperDocs: { type: "http", url: OPENAI_DOCS_URL },
  }
}

// Both servers answer without sign-in; OpenCode would otherwise try OAuth on a remote server.
const EXTRA = { context7: { oauth: false }, openaiDeveloperDocs: { oauth: false } }

export async function setupDocs(ctx: Context, env: Record<string, string | undefined> = process.env) {
  const options = parseMcpOptions(ctx.options as Record<string, unknown>)
  const { registration } = await registerMcp(ctx, docsServers(env), options, { off: OFF_BY_DEFAULT, extra: EXTRA, env })
  return () => registration.dispose()
}

export default Plugin.define({
  id: "srobroek.docs",
  setup: (ctx) => setupDocs(ctx),
})
