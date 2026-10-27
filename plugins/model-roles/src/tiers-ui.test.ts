import { describe, expect, test } from "bun:test"
import { applyEdit, compact, readState, remainingModels, type TierRow, tierNameError, tierSummary } from "./tiers-ui.ts"

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
    expect(readState({ tiers: [], models: [] })).toEqual({ tiers: [], models: [] })
    expect(readState({ tiers: 1 })).toBeUndefined()
  })
})
