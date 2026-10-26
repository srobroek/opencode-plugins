import { Plugin } from "@opencode/plugin"

import { controllerOptions, GoalController } from "./controller.ts"

export {
  activeContinuation,
  CONTINUATION_REGISTRY,
  type ContinuationKind,
  GOAL_SOURCE,
  isGoalSourced,
} from "./continuation.ts"

const GOAL_GET_DESCRIPTION =
  "Read this session's goal: objective, status and budget use. Use it when a goal is active and you need its exact state."

const GOAL_COMPLETE_DESCRIPTION =
  "Mark this session's goal complete. Call it only when every deliverable is verified against the current state (files read, commands and tests run), never because the budget is low or the turn is ending. Pass the evidence. Ends automatic goal continuation."

export default Plugin.define({
  id: "srobroek.goal",
  async setup(ctx) {
    const controller = new GoalController(ctx, controllerOptions(ctx.options))
    await controller.load()

    const commands = await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "goal mode: [objective|show|pause|resume|drop|budget <N|$|off>]",
        execute: (input) => controller.goalCommand(input),
      })
      editor.add({
        name: "loop",
        description: "repeat a prompt after each turn: [N|duration] [--while|--until '<cmd>'] [prompt]",
        execute: (input) => controller.loopCommand(input),
      })
    })

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "goal_get",
        description: GOAL_GET_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => ({ content: await controller.goalGet(context.sessionID) }),
      })
      editor.add({
        name: "goal_complete",
        description: GOAL_COMPLETE_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            evidence: {
              type: "string",
              minLength: 1,
              description: "What proves each deliverable: files, command output, test results.",
            },
          },
          required: ["evidence"],
          additionalProperties: false,
        },
        execute: async (input, context) => ({
          content: await controller.goalComplete(context.sessionID, String((input as { evidence?: unknown }).evidence ?? "")),
        }),
      })
    })

    const compaction = await ctx.session.hook("compaction", (event) => {
      controller.compaction(event as never)
    })

    const abort = new AbortController()
    const iterator = ctx.event.subscribe({ signal: abort.signal })[Symbol.asyncIterator]()
    void (async () => {
      for (;;) {
        const next = await iterator.next().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        try {
          await controller.handleEvent(next.value)
        } catch (error) {
          console.error("srobroek.goal: event handling failed", error)
        }
      }
    })()

    return async () => {
      controller.dispose()
      abort.abort()
      await iterator.return?.()
      await compaction.dispose()
      await tools.dispose()
      await commands.dispose()
    }
  },
})
