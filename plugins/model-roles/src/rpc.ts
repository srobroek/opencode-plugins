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
    /** The outcome ledger's usage report per tier and agent over the last `days` (default: the ledger's retention). */
    usage: {
      input: { type: "object", properties: { days: { type: "number" } } },
      output: { type: "object" },
    },
    /** The findings (new recommendations and rollbacks) the user has not seen yet; none while exploration is off. */
    findings: {
      input: { type: "object" },
      output: { type: "object" },
    },
    /** Mark the finding of one `tier` and `agent` seen, or dismissed. */
    seen: {
      input: { type: "object", required: ["tier", "agent"], properties: { tier: { type: "string" }, agent: { type: "string" } } },
      output: { type: "object" },
    },
    /** Set one tier's config (`value`), or remove it (`value` null), in the global config file; the running instance applies it. `adopt` records an adopted assessment (`from` and `to` arm labels). */
    set: {
      input: {
        type: "object",
        required: ["tier"],
        properties: { tier: { type: "string" }, value: {}, adopt: { type: "object" } },
      },
      output: { type: "object" },
    },
    /** Set one agent's tier (`tier`), or remove the override (`tier` null), in the global config file; the running instance applies it. */
    setAgent: {
      input: {
        type: "object",
        required: ["agent"],
        properties: { agent: { type: "string" }, tier: {} },
      },
      output: { type: "object" },
    },
  },
  events: {},
})
