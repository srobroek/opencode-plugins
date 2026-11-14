import { describe, expect, test } from "bun:test"
import {
  agentTierError,
  applyDraft,
  applyEdit,
  compact,
  mergeAgents,
  readDraft,
  readState,
  type TierRow,
  tierNameError,
  tierState,
  tierSummary,
  validateTierConfig,
} from "./tiers-ui.ts"

const row = (over: Partial<TierRow> = {}): TierRow => ({
  name: "cheap",
  builtin: true,
  source: "derived",
  purpose: "cheap things",
  distinctVendor: false,
  cost: "",
  candidates: [],
  ...over,
})

describe("tier edits", () => {
  test("models: an ordered list, or auto; a built-in back at plain auto needs no entry", () => {
    expect(applyEdit(row(), { kind: "models", models: ["a/b#high", "c/d"] })).toEqual({ model: ["a/b#high", "c/d"] })
    expect(applyEdit(row({ configured: { model: ["a/b"] } }), { kind: "models", models: "auto" })).toBeUndefined()
    expect(applyEdit(row({ configured: { model: ["a/b"], effort: "low" } }), { kind: "models", models: [] })).toEqual({ model: "auto", effort: "low" })
  })

  test("effort, including auto and back to the tier default", () => {
    expect(applyEdit(row(), { kind: "effort", effort: "auto" })).toEqual({ effort: "auto" })
    expect(applyEdit(row({ configured: { model: ["a/b"], effort: "low" } }), { kind: "effort", effort: undefined })).toEqual({ model: ["a/b"] })
  })

  test("purpose and reset; reset keeps a custom tier's purpose", () => {
    const custom = row({ name: "docs", builtin: false, purpose: "docs", configured: { model: ["a/b"], effort: "low", purpose: "docs" } })
    expect(applyEdit(custom, { kind: "purpose", purpose: " writing " })).toEqual({ model: ["a/b"], effort: "low", purpose: "writing" })
    expect(applyEdit(custom, { kind: "reset" })).toEqual({ model: "auto", purpose: "docs" })
    expect(applyEdit(row({ configured: { model: ["a/b"] } }), { kind: "reset" })).toBeUndefined()
    expect(compact({ purpose: " " })).toBeUndefined()
  })
})

describe("pickers", () => {
  test("tier names", () => {
    expect(tierNameError("docs", ["cheap"])).toBeUndefined()
    expect(tierNameError("cheap", ["cheap"])).toContain("already exists")
    expect(tierNameError("smol", [])).toContain("old role name")
    expect(tierNameError("Docs!", [])).toContain("lowercase")
  })

  test("summaries and state replies", () => {
    expect(tierSummary(row({ effort: "low", resolved: "a/b#low" }))).toBe("auto, effort low → a/b#low")
    expect(tierSummary(row({ configured: { model: ["a/b", "c/d"] } }))).toBe("2 models → nothing available")
    expect(readState({ tiers: [], models: [] })).toEqual({ tiers: [], models: [], agents: [] })
    expect(readState({ tiers: 1 })).toBeUndefined()
  })
})

describe("validation", () => {
  const listed = [
    { providerID: "a", id: "b", variants: [{ id: "high" }] },
    { providerID: "a", id: "off", variants: [{ id: "low" }], enabled: false },
  ]
  const catalog = [{ providerID: "z", id: "known", variants: [{ id: "max" }] }]

  test.each([
    { name: "an unknown model", model: ["a/nope"], error: "Unknown model a/nope: no provider lists it." },
    { name: "a variant the model lacks", model: ["a/b#max"], error: "a/b has no variant max (it has: high)." },
    { name: "a variant a catalog model lacks", model: ["z/known#low"], error: "z/known has no variant low (it has: max)." },
    { name: "a malformed entry", model: ["nope"], error: '"nope" is not provider/model, provider/model#variant or @tier.' },
  ])("rejects $name", ({ model, error }) => {
    expect(validateTierConfig({ model: [...model] }, listed, catalog).errors).toEqual([error])
  })

  test("accepts known models and warns about ones that are not available now", () => {
    expect(validateTierConfig({ model: ["a/b#high", "@cheap", "a/off#low", "z/known"] }, listed, catalog)).toEqual({
      errors: [],
      warnings: [
        "a/off is not available now (provider not connected, or disabled); the tier skips it until it is.",
        "z/known is not available now (provider not connected, or disabled); the tier skips it until it is.",
      ],
    })
    expect(validateTierConfig(undefined, listed, catalog)).toEqual({ errors: [], warnings: [] })
  })
})

describe("drafts", () => {
  test("a draft replaces or removes tiers over the configured ones", () => {
    expect(applyDraft({ cheap: { effort: "low" }, docs: { model: "auto" } }, { cheap: { model: ["a/b"] }, docs: null, new: { effort: "high" } })).toEqual({
      cheap: { model: ["a/b"] },
      new: { effort: "high" },
    })
  })

  test("a draft is read from the state input", () => {
    expect(readDraft({ draft: { cheap: { model: "a/b", junk: 1 }, docs: null, "Bad Name": {} } })).toEqual({ cheap: { model: ["a/b"] }, docs: null })
    expect(readDraft({})).toEqual({})
  })
})

describe("tierState", () => {
  test("lists every agent with its source and resolution (none for an untiered one), and each candidate's status", () => {
    const options = {
      roles: { cheap: ["a/b#high"] },
      agents: { worker: "cheap" },
      implicit: { explore: "cheap" },
      fallback: "keep" as const,
      tiers: { cheap: { purpose: "p", distinctVendor: false, source: "config" as const, cost: "" } },
    }
    const state = tierState({
      options,
      available: [{ providerID: "a", id: "b", variants: [{ id: "high" }] }],
      configured: {},
      agents: [
        { id: "worker" },
        { id: "explore" },
        { id: "critic", request: { headers: { "x-opencode-model-role": "cheap" } }, model: { providerID: "c", id: "d" } },
        { id: "plain", description: "  Does plain things.  " },
      ],
      status: () => ({ status: "available" }),
    })
    expect(state.agents).toEqual([
      { id: "critic", tier: "cheap", source: "header", resolved: "a/b#high", pinned: "c/d" },
      { id: "explore", tier: "cheap", source: "implicit", resolved: "a/b#high" },
      { id: "plain", description: "Does plain things." },
      { id: "worker", tier: "cheap", source: "options", resolved: "a/b#high" },
    ])
    expect(state.agents.map((a) => a.id)).toEqual(["critic", "explore", "plain", "worker"])
    expect(state.tiers[0]?.health).toEqual([{ entry: "a/b#high", status: "available" }])
  })
})

describe("agentTierError", () => {
  test("accepts a known tier; refuses an unknown or non-string one", () => {
    const tiers = { cheap: {}, docs: {} }
    expect(agentTierError("docs", tiers)).toBeUndefined()
    expect(agentTierError("nope", tiers)).toBe('Unknown tier "nope".')
    expect(agentTierError(3, tiers)).toBe("Unknown tier 3.")
    expect(agentTierError("toString", tiers)).toBe('Unknown tier "toString".')
  })
})

describe("mergeAgents", () => {
  const startup = { a: "cheap", b: "strong" } // the global file at startup
  test("a project assignment the global file never had is kept; global edits apply around it", () => {
    const given = { a: "cheap", b: "strong", p: "reviewer" } // ctx.options at startup: global plus a project's p
    expect(mergeAgents(given, startup, { a: "cheap", b: "strong" })).toEqual({ a: "cheap", b: "strong", p: "reviewer" })
    expect(mergeAgents(given, startup, { a: "standard", c: "cheap" })).toEqual({ a: "standard", c: "cheap", p: "reviewer" })
  })

  test("a global assignment removed from the file is dropped; a project value that differs from it wins", () => {
    expect(mergeAgents({ a: "cheap", b: "strong" }, startup, { a: "cheap" })).toEqual({ a: "cheap" })
    expect(mergeAgents({ a: "reviewer", b: "strong" }, startup, { a: "standard", b: "strong" })).toEqual({ a: "reviewer", b: "strong" })
  })
})
