import { describe, expect, test } from "bun:test"
import {
  agentOptions,
  createDraft,
  dirty,
  INHERIT,
  modelOptions,
  move,
  reset,
  setEffort,
  setPurpose,
  setVariant,
  tierMenuOptions,
  toConfig,
  toggle,
  toPreviewDraft,
  variantOptions,
} from "./tiers-draft.ts"
import type { PickModel, TierRow } from "./tiers-ui.ts"

const row = (over: Partial<TierRow> = {}): TierRow => ({
  name: "strong",
  builtin: true,
  source: "derived",
  purpose: "hard things",
  distinctVendor: false,
  cost: "",
  candidates: ["a/one"],
  ...over,
})

const available: PickModel[] = [
  { ref: "a/one", variants: ["low", "high"] },
  { ref: "b/two", variants: [] },
  { ref: "c/three", variants: ["max"] },
]

describe("draft operations", () => {
  test("toggle appends in selection order and removes, whatever the variant", () => {
    let d = createDraft(row())
    d = toggle(toggle(d, "b/two"), "a/one")
    expect(d.models).toEqual(["b/two", "a/one"])
    d = setVariant(d, "b/two", "high")
    expect(toggle(d, "b/two").models).toEqual(["a/one"])
  })

  test("move swaps with the neighbour and stops at the ends", () => {
    const d = createDraft(row({ configured: { model: ["a/one#high", "b/two", "c/three"] } }))
    expect(move(d, "c/three", "up").models).toEqual(["a/one#high", "c/three", "b/two"])
    expect(move(d, "a/one", "down").models).toEqual(["b/two", "a/one#high", "c/three"])
    expect(move(d, "a/one", "up")).toBe(d)
    expect(move(d, "c/three", "down")).toBe(d)
    expect(move(d, "x/none", "up")).toBe(d)
  })

  test("setVariant pins a variant and undefined inherits", () => {
    const d = createDraft(row({ configured: { model: ["a/one", "b/two"] } }))
    const pinned = setVariant(d, "a/one", "low")
    expect(pinned.models).toEqual(["a/one#low", "b/two"])
    expect(setVariant(pinned, "a/one", undefined).models).toEqual(["a/one", "b/two"])
  })

  test("effort and purpose set and clear", () => {
    const d = setEffort(setPurpose(createDraft(row()), "new"), "high")
    expect(d.purpose).toBe("new")
    expect(d.effort).toBe("high")
    expect(setEffort(d, undefined).effort).toBeUndefined()
  })
})

describe("draft config", () => {
  test("keeps existing #variants when other models change", () => {
    const d = toggle(createDraft(row({ configured: { model: ["a/one#high"] } })), "b/two")
    expect(toConfig(d)).toEqual({ model: ["a/one#high", "b/two"] })
  })

  test("inherit drops the variant", () => {
    const d = setVariant(createDraft(row({ configured: { model: ["a/one#high"] } })), "a/one", undefined)
    expect(toConfig(d)).toEqual({ model: ["a/one"] })
  })

  test("an empty list is auto, and a built-in at plain auto needs no entry", () => {
    const d = toggle(createDraft(row({ configured: { model: ["a/one"] } })), "a/one")
    expect(toConfig(d)).toBeUndefined()
    expect(toConfig(setEffort(d, "low"))).toEqual({ effort: "low" })
  })

  test("a purpose is written only when changed", () => {
    const d = createDraft(row())
    expect(toConfig(toggle(d, "a/one"))).toEqual({ model: ["a/one"] })
    expect(toConfig(setPurpose(toggle(d, "a/one"), " mine "))).toEqual({ model: ["a/one"], purpose: "mine" })
  })

  test("reset drops a built-in's settings and keeps a custom tier's purpose", () => {
    expect(toConfig(reset(createDraft(row({ configured: { model: ["a/one"], effort: "low" } }))))).toBeUndefined()
    const custom = row({ name: "docs", builtin: false, purpose: "docs", configured: { model: ["a/one"], effort: "low", purpose: "docs" } })
    expect(toConfig(reset(createDraft(custom)))).toEqual({ model: "auto", purpose: "docs" })
  })

  test("the preview draft names the tier, null for removal", () => {
    expect(toPreviewDraft(toggle(createDraft(row()), "a/one"))).toEqual({ strong: { model: ["a/one"] } })
    expect(toPreviewDraft(createDraft(row()))).toEqual({ strong: null })
  })
})

describe("dirty", () => {
  test("clean until something differs from the saved tier; undoing is clean again", () => {
    const d = createDraft(row({ configured: { model: ["a/one"] } }))
    expect(dirty(d)).toBe(false)
    expect(dirty(toggle(d, "b/two"))).toBe(true)
    expect(dirty(toggle(toggle(d, "b/two"), "b/two"))).toBe(false)
    expect(dirty(setEffort(d, "low"))).toBe(true)
    expect(dirty(setPurpose(d, "x"))).toBe(true)
    expect(dirty(setVariant(d, "a/one", "low"))).toBe(true)
  })

  test("a new tier is always dirty; reset is dirty only if something was saved", () => {
    expect(dirty(createDraft(row({ configured: { purpose: "p" } }), true))).toBe(true)
    expect(dirty(reset(createDraft(row())))).toBe(false)
    expect(dirty(reset(createDraft(row({ configured: { effort: "low" } }))))).toBe(true)
  })
})

describe("menu options", () => {
  test("tier menu order and the preview line", () => {
    const options = tierMenuOptions(createDraft(row()), "a/one#high")
    expect(options.map((o) => o.value)).toEqual(["models", "effort", "purpose", "preview", "reset", "save", "cancel"])
    expect(options[3]?.title).toBe("Preview: a/one#high")
  })

  test("models: selected first, numbered with variants; the rest unchecked", () => {
    const d = createDraft(row({ configured: { model: ["c/three", "a/one#high"] } }))
    const options = modelOptions(d, available)
    expect(options.map((o) => o.title)).toEqual(["☑ 1. c/three", "☑ 2. a/one#high", "☐ b/two"])
    expect(options.map((o) => o.value)).toEqual(["c/three", "a/one", "b/two"])
    expect(options[1]?.description).toBe("variant high")
    expect(options[0]?.description).toBe("inherits tier effort")
  })

  test("models: health marks and entries the host no longer lists stay visible", () => {
    const d = createDraft(row({ configured: { model: ["gone/x", "a/one"] }, health: [{ entry: "a/one", status: "unhealthy", until: 1, reason: "unknown" }] }))
    const options = modelOptions(d, available)
    expect(options[0]).toMatchObject({ title: "☑ 1. gone/x", footer: "not listed now" })
    expect(options[1]?.description).toBe("inherits tier effort, unhealthy")
  })

  test("variant submenu: inherit first, then the model's variants", () => {
    expect(variantOptions(available[0]).map((o) => o.value)).toEqual([INHERIT, "low", "high"])
    expect(variantOptions(undefined).map((o) => o.value)).toEqual([INHERIT])
  })

  test("agents: tier and resolved model, an own model wins", () => {
    expect(
      agentOptions([
        { id: "build", tier: "strong", resolved: "a/one#high" },
        { id: "own", tier: "cheap", pinned: "b/two" },
        { id: "none", tier: "cheap" },
      ]).map((o) => o.description),
    ).toEqual(["strong → a/one#high", "cheap → b/two (own model)", "cheap → nothing available"])
  })
})
