import { Rpc } from "@opencode/plugin/rpc"

export const RPC_ID = "model-roles"

/** Shared by the server entry (implements) and the TUI entry (calls). */
export const TiersRpc = Rpc.define({
  id: RPC_ID,
  methods: {
    /** The current tier table, or a draft of it previewed: tier configs to try, `null` for a tier removed. */
    state: {
      input: { type: "object", properties: { draft: { type: "object" } } },
      output: { type: "object" },
    },
    /** Set one tier's config (`value`), or remove it (`value` null), in the global config file; the running instance applies it. */
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
