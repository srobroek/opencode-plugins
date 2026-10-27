import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { contentPaths } from "@srobroek/opencode-lib/content-plugin"
import { registerPluginMcp } from "@srobroek/opencode-lib/mcp"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { isAwsProject } from "./detect.ts"

export { AWS_MARKERS, IAC_DIRECTORIES, isAwsProject } from "./detect.ts"

export async function setupAws(ctx: Context, moduleUrl: string) {
  const { skills } = contentPaths(moduleUrl)
  const registrations: { dispose: () => Promise<void> }[] = []
  const cleanup = async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
  try {
    if (skills.length > 0) registrations.push(await registerSkills(ctx.skill, skills))
    const mcp = await registerPluginMcp(ctx, moduleUrl, {
      relevant: isAwsProject,
      // The first start downloads the uvx environment, which outlasts the default startup timeout.
      extra: {
        "aws-mcp": { timeout: { startup: 120000, execution: 100000 } },
        "aws-pricing": { timeout: { startup: 120000 } },
      },
    })
    registrations.push(mcp.registration)
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}

export default Plugin.define({
  id: "srobroek.aws",
  setup: (ctx) => setupAws(ctx, import.meta.url),
})
