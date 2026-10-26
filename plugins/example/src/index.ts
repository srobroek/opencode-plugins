import { Plugin } from "@opencode/plugin"

export const BLOCKED_COMMAND = /\bgit\s+push\b.*\s--force(?!-with-lease)\b/

export function blockReason(tool: string, input: unknown): string | undefined {
  if (tool !== "shell") return undefined
  const command = (input as { command?: unknown } | null)?.command
  if (typeof command !== "string") return undefined
  return BLOCKED_COMMAND.test(command) ? "Use git push --force-with-lease instead of --force." : undefined
}

export default Plugin.define({
  id: "srobroek.example",
  async setup(ctx) {
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "example_echo",
        description: "Echo the given text back. Reference tool for this repository.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        execute: async (input) => ({ content: String((input as { text: string }).text) }),
      })
    })
    const guard = await ctx.tool.hook("execute.before", (event) => {
      const reason = blockReason(event.tool, event.input)
      if (reason) throw new Error(reason)
    })
    return async () => {
      await guard.dispose()
      await tools.dispose()
    }
  },
})
