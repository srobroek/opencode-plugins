import { describe, expect, test } from "bun:test"
import {
  AGENT_DEFAULT,
  agentDetailOptions,
  agentOptions,
  agentTierCurrent,
  agentTierOptions,
  BACK,
  CHANGE_TIER,
  createDraft,
  dirty,
  INHERIT,
  modelOptions,
  move,
  reset,
  setEffort,
  setPurpose,
  setVariant,
  sourceText,
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
    expect(toggle(d, "b/two#high").models).toEqual(["a/one"])
  })

  test("entries of the same model with different variants are separate rows", () => {
    const d = createDraft(row({ configured: { model: ["a/one#low", "b/two", "a/one#high"] } }))
    expect(setVariant(d, "a/one#high", undefined).models).toEqual(["a/one#low", "b/two", "a/one"])
    expect(setVariant(d, "a/one#low", "high").models).toEqual(["a/one#high", "b/two", "a/one#high"])
    expect(toggle(d, "a/one#high").models).toEqual(["a/one#low", "b/two"])
    expect(move(d, "a/one#high", "up").models).toEqual(["a/one#low", "a/one#high", "b/two"])
    expect(move(d, "a/one#low", "down").models).toEqual(["b/two", "a/one#low", "a/one#high"])
  })

  test("move swaps with the neighbour and stops at the ends", () => {
    const d = createDraft(row({ configured: { model: ["a/one#high", "b/two", "c/three"] } }))
    expect(move(d, "c/three", "up").models).toEqual(["a/one#high", "c/three", "b/two"])
    expect(move(d, "a/one#high", "down").models).toEqual(["b/two", "a/one#high", "c/three"])
    expect(move(d, "a/one#high", "up")).toBe(d)
    expect(move(d, "c/three", "down")).toBe(d)
    expect(move(d, "x/none", "up")).toBe(d)
  })

  test("setVariant pins a variant and undefined inherits", () => {
    const d = createDraft(row({ configured: { model: ["a/one", "b/two"] } }))
    const pinned = setVariant(d, "a/one", "low")
    expect(pinned.models).toEqual(["a/one#low", "b/two"])
    expect(setVariant(pinned, "a/one#low", undefined).models).toEqual(["a/one", "b/two"])
  })

  test("effort and purpose set and clear", () => {
    const d = setEffort(setPurpose(createDraft(row()), "new"), "high")
    expect(d.purpose).toBe("new")
    expect(d.effort).toBe("high")
    expect(setEffort(d, undefined).effort).toBeUndefined()
  })
})

describe("draft config", () => {
  test("untouched models stay as saved: a legacy roles-backed tier keeps its absent model", () => {
    const legacy = row({ name: "task", builtin: false, source: "roles", candidates: ["x/legacy#high"], purpose: "p" })
    expect(toConfig(setPurpose(createDraft({ ...legacy, configured: { purpose: "p" } }), "q"))).toEqual({ purpose: "q" })
    expect(toConfig(setEffort(createDraft(legacy), "low"))).toEqual({ effort: "low" })
    // Touching the models, or Reset, does write the model setting.
    expect(toConfig(toggle(createDraft({ ...legacy, configured: { purpose: "p" } }), "a/one"))).toEqual({ model: ["a/one"], purpose: "p" })
    expect(toConfig(reset(createDraft({ ...legacy, configured: { purpose: "p" } })))).toEqual({ model: "auto", purpose: "p" })
  })

  test("keeps existing #variants when other models change", () => {
    const d = toggle(createDraft(row({ configured: { model: ["a/one#high"] } })), "b/two")
    expect(toConfig(d)).toEqual({ model: ["a/one#high", "b/two"] })
  })

  test("inherit drops the variant", () => {
    const d = setVariant(createDraft(row({ configured: { model: ["a/one#high"] } })), "a/one#high", undefined)
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

  test("edits after Reset still count: dirty compares the resulting config with the saved one", () => {
    const fresh = reset(createDraft(row()))
    expect(dirty(toggle(fresh, "b/two"))).toBe(true)
    expect(dirty(setEffort(fresh, "low"))).toBe(true)
    expect(dirty(setPurpose(fresh, "other"))).toBe(true)
    expect(dirty(toggle(toggle(fresh, "b/two"), "b/two"))).toBe(false)
  })

  test("a new tier is always dirty; reset is dirty only if something was saved", () => {
    expect(dirty(createDraft(row({ configured: { purpose: "p" } }), true))).toBe(true)
    expect(dirty(reset(createDraft(row())))).toBe(false)
    expect(dirty(reset(createDraft(row({ configured: { effort: "low" } }))))).toBe(true)
  })
})

describe("menu options", () => {
  test("an unset effort says Tier default, with the effective effort when the state knows it", () => {
    const text = (d: ReturnType<typeof createDraft>) => tierMenuOptions(d, undefined)[1]?.description
    expect(text(createDraft(row()))).toBe("Tier default")
    expect(text(createDraft(row({ effort: "high" })))).toBe("Tier default (high)")
    expect(text(createDraft(row({ effort: "low", configured: { effort: "low" } })))).toBe("low")
    expect(text(setEffort(createDraft(row({ effort: "low", configured: { effort: "low" } })), undefined))).toBe("Tier default")
  })

  test("tier menu order and the preview line", () => {
    const options = tierMenuOptions(createDraft(row()), "a/one#high")
    expect(options.map((o) => o.value)).toEqual(["models", "effort", "purpose", "preview", "reset", "save", "cancel"])
    expect(options[3]?.title).toBe("Preview: a/one#high")
  })

  test("models: selected first, numbered with variants; the rest unchecked", () => {
    const d = createDraft(row({ configured: { model: ["c/three", "a/one#high"] } }))
    const options = modelOptions(d, available)
    expect(options.map((o) => o.title)).toEqual(["☑ 1. c/three", "☑ 2. a/one#high", "☐ b/two"])
    expect(options.map((o) => o.value)).toEqual(["c/three", "a/one#high", "b/two"])
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

  test("agent rows are short: id, tier or no tier, a marker for an own model", () => {
    expect(
      agentOptions([
        { id: "build", tier: "strong", source: "options", resolved: "a/one#high" },
        { id: "own", tier: "cheap", source: "header", pinned: "b/two" },
        { id: "none" },
      ]).map((o) => [o.title, o.description]),
    ).toEqual([
      ["build", "strong"],
      ["own", "cheap · own model"],
      ["none", "no tier"],
    ])
  })

  test("agent details: one disabled row per fact, long text wrapped, then the actions", () => {
    const rows = agentDetailOptions({ id: "own", tier: "cheap", source: "header", resolved: "a/one#low", pinned: "b/two", description: "word ".repeat(30).trim() })
    const facts = rows.filter((r) => r.disabled)
    expect(facts.slice(0, 4).map((r) => r.title)).toEqual(["Tier: cheap", "From: agent default", "Resolves to: a/one#low", "Own model: b/two (wins over the tier)"])
    expect(facts.length).toBeGreaterThan(5)
    expect(facts.every((r) => r.title.length <= 54)).toBe(true)
    expect(rows.slice(-2).map((r) => r.value)).toEqual([CHANGE_TIER, BACK])
  })

  test("agent details without a tier, pin or description", () => {
    expect(agentDetailOptions({ id: "x" }).map((r) => r.title)).toEqual([
      "Tier: no tier (session model)",
      "From: none",
      "Resolves to: the session model",
      "Change tier…",
      "Back",
    ])
  })

  test("agent details name a project config: set by it for its own assignments, else that it holds the entry", () => {
    const project = { origin: "project", path: "/p/opencode.json" }
    const titles = (rows: ReturnType<typeof agentDetailOptions>) => rows.filter((r) => r.disabled).map((r) => r.title)
    expect(titles(agentDetailOptions({ id: "a", tier: "cheap", source: "options", resolved: "x" }, project))).toContain("Set by project config (/p/opencode.json)")
    expect(titles(agentDetailOptions({ id: "a", tier: "cheap", source: "header" }, project)).join(" ")).toContain("Project config (/p/opencode.json) holds the")
    expect(titles(agentDetailOptions({ id: "a" }, { origin: "global", path: "/g" })).join(" ")).not.toContain("project")
  })

  test("source words", () => {
    expect([sourceText("options"), sourceText("header"), sourceText("implicit"), sourceText(undefined)]).toEqual([
      "your setting",
      "agent default",
      "auto-classified",
      "none",
    ])
  })

  test("tier picker: agent default first, every tier with its summary; the current mark follows the setting", () => {
    const options = agentTierOptions([{ name: "cheap", builtin: true, source: "derived", purpose: "p", distinctVendor: false, cost: "", candidates: [], resolved: "a/b" }])
    expect(options.map((o) => [o.title, o.value])).toEqual([
      ["Agent default", AGENT_DEFAULT],
      ["cheap", "cheap"],
    ])
    expect(options[1]?.description).toBe("auto → a/b")
    expect(agentTierCurrent({ id: "a", tier: "cheap", source: "options" })).toBe("cheap")
    expect(agentTierCurrent({ id: "a", tier: "cheap", source: "header" })).toBe(AGENT_DEFAULT)
    expect(agentTierCurrent({ id: "a" })).toBe(AGENT_DEFAULT)
  })
})
