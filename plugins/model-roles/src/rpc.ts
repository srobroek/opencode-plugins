import { Rpc } from "@opencode/plugin/rpc"

export const RPC_ID = "model-roles"

/** Shared by the server entry (implements) and the TUI entry (calls). */
export const TiersRpc = Rpc.define({
  id: RPC_ID,
  methods: {
    /** The tier table, the models this location can pick from, and the config file `set` writes. */
    state: {
      input: { type: "object", properties: {} },
      output: { type: "object" },
    },
    /** Set one tier's config (`value`), or remove it (`value` null), in the global config file. */
    set: {
      input: {
        type: "object",
        required: ["tier"],
        properties: { tier: { type: "string" }, value: {} },
      },
      output: { type: "object" },
    },
  },
  events: {},
})
