import { Rpc } from "@opencode/plugin/rpc"

/** `metadata.source` on the continuation messages OpenCode's built-in goal sends. */
export const GOAL_SOURCE = "goal"

/** The built-in goal's RPC, declared here because OpenCode does not export its definition. */
export const GoalRpc = Rpc.define({
  id: "opencode.goal",
  methods: {
    /** The session's goal state, or null without a goal. */
    get: {
      input: { type: "object", required: ["sessionID"], properties: { sessionID: { type: "string" } } },
      output: {},
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        required: ["sessionID"],
        properties: { sessionID: { type: "string" }, goal: {} },
      },
    },
  },
})

/** Whether a goal state (`null` for none) is still driving the session. */
export function isGoalActive(state: unknown): boolean {
  return (state as { status?: unknown } | null | undefined)?.status === "active"
}
