import { describe, expect, test } from "bun:test"
import {
  applyDraft,
  applyEdit,
  compact,
  readDraft,
  readState,
  remainingModels,
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
  test("remaining models skip the picked ones, variants or not", () => {
    const models = [{ ref: "a/b", variants: [] }, { ref: "c/d", variants: ["high"] }]
    expect(remainingModels(models, ["c/d#high"]).map((m) => m.ref)).toEqual(["a/b"])
  })

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
  test("lists each tiered agent with its source and resolution, and each candidate's status", () => {
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
        { id: "plain" },
      ],
      status: () => ({ status: "available" }),
    })
    expect(state.agents).toEqual([
      { id: "critic", tier: "cheap", source: "header", resolved: "a/b#high", pinned: "c/d" },
      { id: "explore", tier: "cheap", source: "implicit", resolved: "a/b#high" },
      { id: "worker", tier: "cheap", source: "options", resolved: "a/b#high" },
    ])
    expect(state.tiers[0]?.health).toEqual([{ entry: "a/b#high", status: "available" }])
  })
})
