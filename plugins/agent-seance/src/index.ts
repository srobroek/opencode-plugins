import { Plugin } from "@opencode/plugin"
import { registerAgents } from "@srobroek/opencode-lib/agent-files"
import { contentPaths } from "@srobroek/opencode-lib/content-plugin"
import { neutralize } from "@srobroek/opencode-lib/transcript-text"
import {
  callerChain,
  DESCRIPTION,
  externalResource,
  INPUT_SCHEMA,
  listSessions,
  type ReadInput,
  readSession,
  type SeanceEnv,
  TOOL_NAME,
} from "./read.ts"

export * from "./read.ts"

/** A permission refusal, rethrown as is so the host ends the step. */
class Refused {
  constructor(readonly error: unknown) {}
}

export default Plugin.define({
  id: "srobroek.agent-seance",
  async setup(ctx) {
    const registrations: { dispose: () => Promise<void> }[] = []
    const cleanup = async () => {
      for (const registration of registrations.reverse()) await registration.dispose()
    }
    try {
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: TOOL_NAME,
            description: DESCRIPTION,
            input: INPUT_SCHEMA,
            execute: async (raw, tool) => {
              const input = (raw ?? {}) as ReadInput
              const mode = input.session ? "read" : "list"
              try {
                const { self, chain } = await callerChain(ctx.session, tool.sessionID)
                const env: SeanceEnv = {
                  session: ctx.session,
                  chain,
                  authorize: async (summary) => {
                    const resource = externalResource(summary)
                    try {
                      await ctx.permission.assert({
                        sessionID: tool.sessionID,
                        agent: tool.agent,
                        source: { type: "tool", messageID: tool.messageID, id: tool.id },
                        action: "external_directory",
                        resources: [resource],
                        save: [resource],
                        metadata: { session: summary.id, directory: summary.directory },
                      } as never)
                    } catch (error) {
                      throw new Refused(error)
                    }
                  },
                }
                if (self) env.self = self
                const result = input.session
                  ? await readSession(env, { ...input, session: input.session })
                  : await listSessions(env, input)
                return { content: result.text, metadata: result.metadata }
              } catch (error) {
                if (error instanceof Refused) throw error.error
                const message = error instanceof Error ? error.message : String(error)
                return { content: neutralize(`${TOOL_NAME} error: ${message}`), metadata: { mode, error: message } }
              }
            },
          })
        }),
      )
      registrations.push(await registerAgents(ctx.agent, contentPaths(import.meta.url).agents))
    } catch (error) {
      await cleanup()
      throw error
    }
    return cleanup
  },
})
