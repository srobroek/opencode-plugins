import { describe, expect, test } from "bun:test"
import {
  billingOf,
  buildReferenceIndex,
  type CatalogModel,
  canonical,
  type Derived,
  deriveTiers,
  lineupRank,
  nearestVariant,
} from "./catalog.ts"
import reference from "./fixtures/reference.json"
import work from "./fixtures/work-models.json"

const refs = buildReferenceIndex(reference as CatalogModel[])
const firstParty = (provider: string, id: string): CatalogModel => {
  const found = (reference as CatalogModel[]).find((m) => m.providerID === provider && m.id === id)
  if (found === undefined) throw new Error(`no ${provider}/${id} in the fixture`)
  return found
}

/** The ChatGPT sign-in list (OpenCode 2.1.4 `chatgpt.ts` fallbackModels), priced `cost: []`. */
const chatgpt: CatalogModel[] = [
  "gpt-5.5",
  "gpt-5.5-fast",
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
  "gpt-6-astra",
  "gpt-6-astra-fast",
  "gpt-6-luna",
  "gpt-6-luna-fast",
  "gpt-6-sol",
  "gpt-6-sol-fast",
  "gpt-6.1-sol",
  "gpt-6.1-sol-fast",
].map((id) => ({ ...firstParty("openai", id), cost: [], enabled: true }))

/** opencode-claude 1.6.0: no family, no release date, `cost: []`. */
const claudeCode: CatalogModel[] = ["claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1[1m]"].map((id) => ({
  providerID: "claude-code",
  id,
  status: "active",
  enabled: true,
  capabilities: { tools: true, output: ["text"] },
  variants: ["low", "medium", "high", "xhigh", "max"].map((v) => ({ id: v })),
  time: { released: 0 },
  cost: [],
}))

const ids = (derived: Derived, tier: keyof Derived["tiers"]) => derived.tiers[tier].map((r) => `${r.model.providerID}/${r.model.id}`)

describe("canonical", () => {
  test("strips Bedrock regions, vendor prefixes, versions, dates and [1m]", () => {
    expect(canonical("global.anthropic.claude-opus-5-5")).toEqual({ key: "claude-opus-5-5", vendor: "anthropic", speed: false })
    expect(canonical("us.anthropic.claude-haiku-4-5-20251001-v1:0").key).toBe("claude-haiku-4-5")
    expect(canonical("openai.gpt-oss-120b-1:0").key).toBe("gpt-oss-120b")
    expect(canonical("claude-opus-5-5[1m]")).toEqual({ key: "claude-opus-5-5", vendor: "anthropic", speed: false })
    expect(canonical("gpt-6.1-sol-ultrafast")).toEqual({ key: "gpt-6.1-sol-ultrafast", vendor: "openai", speed: true })
    expect(canonical("gemini-3.8-flash").vendor).toBe("google")
    expect(canonical("o3").vendor).toBe("openai")
    expect(canonical("flint-40b-free").vendor).toBeUndefined()
  })
})

describe("billingOf", () => {
  test("no cost is a plan, all zero is free, anything else is metered", () => {
    expect(billingOf({ cost: [] })).toBe("subscription")
    expect(billingOf({})).toBe("subscription")
    expect(billingOf({ cost: [{ input: 0, output: 0 }] })).toBe("free")
    expect(billingOf({ cost: [{ input: 0.1, output: 0.5 }] })).toBe("metered")
  })
})

describe("nearestVariant", () => {
  const all = ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id }))
  test("exact, else the nearest on the effort scale with ties going lower", () => {
    expect(nearestVariant(all, "high")).toBe("high")
    expect(nearestVariant(all, "none")).toBe("low")
    expect(nearestVariant([{ id: "none" }, { id: "high" }, { id: "max" }], "medium")).toBe("high")
    expect(nearestVariant([{ id: "low" }, { id: "high" }], "medium")).toBe("low")
    expect(nearestVariant([], "high")).toBeUndefined()
    expect(nearestVariant(undefined, "high")).toBeUndefined()
    expect(nearestVariant(all, "thinking")).toBeUndefined()
  })
})

describe("deriveTiers", () => {
  test("work: Bedrock only, the free opencode models dropped", () => {
    const derived = deriveTiers(work as CatalogModel[], refs)
    expect(ids(derived, "cheap")).toEqual(["amazon-bedrock/global.anthropic.claude-haiku-5-5", "amazon-bedrock/global.openai.gpt-6-luna"])
    expect(ids(derived, "standard")).toEqual([
      "amazon-bedrock/global.openai.gpt-6.1-sol",
      "amazon-bedrock/global.anthropic.claude-sonnet-5-5",
    ])
    expect(ids(derived, "strong")).toEqual(["amazon-bedrock/global.anthropic.claude-opus-5-5", "amazon-bedrock/global.openai.gpt-6.1-sol"])
    const reasons = new Map(derived.dropped.map((d) => [d.ref, d.reason]))
    expect(reasons.get("opencode/flint-40b-free")).toBe("free")
    expect(reasons.get("amazon-bedrock/global.anthropic.claude-fable-5-1")).toBe("premium")
    expect(reasons.get("amazon-bedrock/global.openai.gpt-6-astra")).toBe("premium")
    expect(reasons.get("amazon-bedrock/global.openai.gpt-6.1-sol-ultrafast")).toBe("speed")
    expect(reasons.get("amazon-bedrock/global.openai.gpt-5.6-terra")).toBe("dominated")
    expect(reasons.get("amazon-bedrock/openai.gpt-5.5")).toBe("stale")
    expect(reasons.get("amazon-bedrock/openai.gpt-oss-120b")).toBe("special-purpose")
    expect(reasons.get("amazon-bedrock/global.anthropic.claude-opus-5")).toBe("superseded")
    expect(reasons.get("amazon-bedrock/us.anthropic.claude-opus-5-5")).toBe("duplicate-region")
  })

  test("personal: ChatGPT and claude-code are subscriptions ranked by reference price", () => {
    const derived = deriveTiers([...chatgpt, ...claudeCode], refs)
    expect(ids(derived, "cheap")).toEqual(["claude-code/claude-haiku-5-5", "openai/gpt-6-luna"])
    expect(ids(derived, "standard")).toEqual(["openai/gpt-6.1-sol", "claude-code/claude-sonnet-5-5"])
    expect(ids(derived, "strong")).toEqual(["claude-code/claude-opus-5-5[1m]", "openai/gpt-6.1-sol"])
    expect(derived.tiers.strong.every((r) => r.billing === "subscription")).toBe(true)
    const reasons = new Map(derived.dropped.map((d) => [d.ref, d.reason]))
    expect(reasons.get("openai/gpt-6-astra")).toBe("premium")
    expect(reasons.get("claude-code/claude-fable-5-1[1m]")).toBe("premium")
    expect(reasons.get("openai/gpt-6-luna-fast")).toBe("speed")
  })

  test("prefer reorders within billing kind, avoid drops", () => {
    const derived = deriveTiers([...chatgpt, ...claudeCode], refs, { prefer: ["openai"], avoid: ["claude-code/*sonnet*"] })
    expect(ids(derived, "cheap")).toEqual(["openai/gpt-6-luna", "claude-code/claude-haiku-5-5"])
    expect(ids(derived, "strong")).toEqual(["openai/gpt-6.1-sol", "claude-code/claude-opus-5-5[1m]"])
    expect(ids(derived, "standard")).toEqual(["openai/gpt-6.1-sol", "claude-code/claude-opus-5-5[1m]"])
  })

  test("subscriptions come before metered models on a mixed device", () => {
    const derived = deriveTiers([...(work as CatalogModel[]), ...claudeCode], refs)
    expect(ids(derived, "cheap")[0]).toBe("claude-code/claude-haiku-5-5")
    expect(ids(derived, "strong").slice(0, 2)).toEqual(["claude-code/claude-opus-5-5[1m]", "amazon-bedrock/global.anthropic.claude-opus-5-5"])
  })

  test("metered API keys: three vendors, special-purpose ids excluded", () => {
    const derived = deriveTiers(reference as CatalogModel[], refs)
    expect(ids(derived, "cheap")).toEqual(["anthropic/claude-haiku-5-5", "openai/gpt-6-luna", "google/gemini-3.5-flash-lite"])
    expect(ids(derived, "standard")).toEqual(["google/gemini-3.8-flash", "openai/gpt-6.1-terra", "anthropic/claude-sonnet-5-5"])
    expect(ids(derived, "strong")).toEqual(["anthropic/claude-opus-5-5", "google/gemini-4-argon", "openai/gpt-6.1-sol"])
    const all = Object.values(derived.tiers).flat().map((r) => r.model.id)
    expect(all.some((id) => /realtime|preview|latest|embed/.test(id))).toBe(false)
  })

  test("unpriced models are unranked, and a lineup of one fills every tier", () => {
    const derived = deriveTiers(
      [
        { ...claudeCode[0], id: "claude-sonata-1" } as CatalogModel,
        { providerID: "x", id: "claude-only-1", cost: [{ input: 1 }], status: "active" },
      ],
      refs,
    )
    expect(derived.dropped).toContainEqual({ ref: "claude-code/claude-sonata-1", reason: "unranked" })
    expect(ids(derived, "cheap")).toEqual(["x/claude-only-1"])
    expect(ids(derived, "standard")).toEqual(["x/claude-only-1"])
    expect(ids(derived, "strong")).toEqual(["x/claude-only-1"])
    expect(lineupRank({ providerID: "x", id: "claude-only-1" }, derived)).toBe(1)
  })

  test("every tier is non-empty whenever a lineup is", () => {
    for (const models of [work as CatalogModel[], chatgpt, claudeCode, reference as CatalogModel[]]) {
      const derived = deriveTiers(models, refs)
      if (derived.lineups.length === 0) continue
      for (const tier of ["cheap", "standard", "strong"] as const) expect(derived.tiers[tier].length).toBeGreaterThan(0)
    }
  })
})
