import { describe, expect, test } from "bun:test"
import { explainSpawn, formatReceipts, pushReceipt, type Receipt, readReceipts } from "./receipt.ts"
import type { TierMeta } from "./tiers.ts"

const models = [
  { providerID: "a", id: "big", variants: [{ id: "low" }, { id: "high" }, { id: "max" }] },
  { providerID: "a", id: "plain", variants: [] },
  { providerID: "b", id: "gone", variants: [], enabled: false },
]
const meta = (over: Partial<TierMeta> = {}): TierMeta => ({ purpose: "p", distinctVendor: false, source: "config", cost: "", ...over })

describe("explainSpawn", () => {
  test.each([
    {
      name: "a candidate's own variant",
      model: { providerID: "a", id: "big", variant: "max" },
      meta: meta({ effort: "high", effortFrom: "tier" }),
      explicit: ["a/big#max"],
      rule: "candidate-variant",
      warnings: ["a/big#max sets its own variant, which wins over the tier effort high"],
    },
    { name: "the tier effort", model: { providerID: "a", id: "big", variant: "high" }, meta: meta({ effort: "high", effortFrom: "tier" }), explicit: ["a/big"], rule: "tier-effort", warnings: [] },
    { name: "the base tier effort", model: { providerID: "a", id: "big", variant: "high" }, meta: meta({ effort: "high", effortFrom: "base" }), explicit: [], rule: "base-tier-effort", warnings: [] },
    { name: "the built-in effort", model: { providerID: "a", id: "big", variant: "low" }, meta: meta({ effort: "low", effortFrom: "builtin" }), explicit: [], rule: "builtin-effort", warnings: [] },
    {
      name: "the model default, for a model without variants",
      model: { providerID: "a", id: "plain" },
      meta: meta({ effort: "low", effortFrom: "builtin" }),
      explicit: [],
      rule: "model-default",
      warnings: ["a/plain has no variants; it runs at the model default, not effort low"],
    },
  ])("names $name as the winning rule", ({ model, meta, explicit, rule, warnings }) => {
    const receipt = explainSpawn({ tier: "t", model, meta, explicit, order: [], models, roles: {}, health: {}, now: 0 })
    expect(receipt.rule).toBe(rule)
    expect(receipt.warnings).toEqual([...warnings])
  })

  test("lists the candidates it fell back past, with the reason", () => {
    const receipt = explainSpawn({
      tier: "t",
      model: { providerID: "a", id: "big", variant: "high" },
      meta: meta({ effort: "high", effortFrom: "tier" }),
      explicit: [],
      order: ["x/none", "b/gone", "a/big#bogus", "a/big#high", "a/plain"],
      models,
      roles: {},
      health: {},
      now: 0,
    })
    expect(receipt.fallbacks).toEqual([
      "x/none: provider unavailable (not connected, no credentials, or denied by policy)",
      "b/gone: provider unavailable (not connected, no credentials, or denied by policy)",
      "a/big#bogus: unknown variant (has: low, high, max)",
    ])
  })
})

describe("receipts", () => {
  const receipt = (at: number): Receipt => ({ at, agent: "plain", source: "tier-param", tier: "cheap", model: "a/big#low", rule: "builtin-effort", fallbacks: [], warnings: [] })

  test("the newest comes first and only the last ones are kept", () => {
    let list: Receipt[] = []
    for (let at = 1; at <= 4; at++) list = pushReceipt(list, receipt(at), 3)
    expect(list.map((r) => r.at)).toEqual([4, 3, 2])
  })

  test("stored receipts are read defensively", () => {
    expect(readReceipts([receipt(1), { at: "x" }, 3])).toEqual([receipt(1)])
    expect(readReceipts(undefined)).toEqual([])
  })

  test("one compact line per spawn, with the source, alias, rule, fallbacks and warnings", () => {
    const lines = formatReceipts([
      { ...receipt(Date.UTC(2026, 10, 13, 9, 30)), alias: "smol", fallbacks: ["x/y: unknown id"], warnings: ["w"] },
      { at: Date.UTC(2026, 10, 13, 9, 29), agent: "critic", source: "agent", rule: "explicit-model", model: "a/plain", fallbacks: [], warnings: [] },
    ])
    expect(lines).toEqual([
      "",
      "Recent spawns (newest first):",
      "  - 09:30:00 plain: tier cheap (smol, tier param) → a/big#low by built-in effort; fell back past x/y: unknown id; warning: w",
      "  - 09:29:00 critic: agent tier → a/plain by explicit model",
    ])
    expect(formatReceipts([])).toEqual([])
  })
})
