import { Plugin } from "@opencode/plugin"
import { contentPlugin } from "@srobroek/opencode-lib/content-plugin"

export const ID = "srobroek.project"
export const COMMAND = "new-project"
export const SKILL = "project-scaffold"

const content = contentPlugin(ID, import.meta.url)

/** The prompt `/new-project` submits: load the scaffold skill and pass the user's words on. */
export function scaffoldPrompt(args: string): string {
  const request = args.trim()
  return [
    `Load the \`${SKILL}\` skill with the skill tool and follow it to scaffold a new project in the current directory.`,
    request
      ? `The user's request: ${request}`
      : "The user gave no details: start with the skill's interview and ask what they are building.",
  ].join("\n\n")
}

export default Plugin.define({
  id: ID,
  async setup(ctx) {
    const cleanupContent = await content.setup(ctx)
    try {
      const command = await ctx.command.transform((editor) =>
        editor.add({
          name: COMMAND,
          description: "scaffold a standard project: [language or project name]",
          execute: async (input) => {
            await ctx.session.prompt({
              sessionID: input.sessionID,
              ...input.prompt,
              text: scaffoldPrompt(input.prompt.text ?? ""),
              delivery: input.delivery,
            } as never)
          },
        }),
      )
      return async () => {
        await command.dispose()
        await cleanupContent?.()
      }
    } catch (error) {
      await cleanupContent?.()
      throw error
    }
  },
})
