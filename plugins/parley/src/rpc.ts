import { Rpc } from "@opencode/plugin/rpc"

export const RPC_ID = "parley"

/** Shared by the server entry (implements) and the TUI entry (calls). */
export const ParleyRpc = Rpc.define({
  id: RPC_ID,
  methods: {
    attach: {
      input: {
        type: "object",
        required: ["clientID"],
        properties: {
          clientID: { type: "string" },
          sessionIDs: { type: "array", items: { type: "string" } },
          detach: { type: "boolean" },
        },
      },
      output: { type: "object" },
    },
    pending: {
      input: { type: "object", properties: { sessionID: { type: "string" } } },
      output: { type: "object" },
    },
    submit: {
      input: {
        type: "object",
        required: ["roundID", "answers"],
        properties: {
          roundID: { type: "string" },
          answers: { type: "array", items: { type: "object" } },
          final: { type: "boolean" },
        },
      },
      output: { type: "object" },
    },
    cancel: {
      input: {
        type: "object",
        required: ["roundID"],
        properties: { roundID: { type: "string" }, reason: { type: "string" } },
      },
      output: { type: "object" },
    },
  },
  events: {
    round: {
      schema: {
        type: "object",
        required: ["sessionID", "roundID", "action"],
        properties: {
          sessionID: { type: "string" },
          roundID: { type: "string" },
          action: { type: "string", enum: ["opened", "updated", "closed", "ended", "native"] },
          status: { type: "string" },
          reason: { type: "string" },
          message: { type: "string" },
          callID: { type: "string" },
        },
      },
    },
  },
})

export interface RoundEvent {
  readonly sessionID: string
  readonly roundID: string
  /** `native`: a `question` call (`callID`) went to the built-in tool, whose form the TUI must fetch. */
  readonly action: "opened" | "updated" | "closed" | "ended" | "native"
  readonly status?: string
  readonly reason?: string
  readonly message?: string
  readonly callID?: string
}
