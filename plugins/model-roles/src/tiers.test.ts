import { describe, expect, test } from "bun:test"
import { buildReferenceIndex, type CatalogModel } from "./catalog.ts"
import reference from "./fixtures/reference.json"
import work from "./fixtures/work-models.json"
import { resolveRole } from "./resolve.ts"
import {
  buildTiers,
  isExpensiveClass,
  parseTierConfig,
  parseTierSettings,
  rankOf,
  resolveTier,
  TIER_PURPOSE,
  tierMeta,
  withEffort,
} from "./tiers.ts"

const refs = buildReferenceIndex(reference as CatalogModel[])
const models = work as CatalogModel[]
const bedrock = (id: string, variant?: string) => `amazon-bedrock/global.${id}${variant ? `#${variant}` : ""}`
const build = (raw: unknown) => buildTiers(parseTierSettings(raw), models, refs)

describe("parseTierSettings", () => {
  test("reads tiers in every shape, the deprecated roles and purposes, and the derivation options", () => {
    const settings = parseTierSettings({
      tiers: {
        cheap: "auto",
        standard: { model: "a/b#high", effort: "medium" },
        strong: ["a/c", 3, " "],
        review2: { purpose: " second look ", distinctVendor: true, effort: "auto" },
        default: { model: "x/y" },
      },
      roles: { smol: "a/d", task: ["a/e"] },
      purposes: { smol: "tiny jobs", bad: 1 },
      prefer: ["openai"],
      avoid: "x/*",
      premium: 6,
    })
    expect(settings.tiers).toEqual({
      cheap: { model: "auto" },
      standard: { model: ["a/b#high"], effort: "medium" },
      strong: { model: ["a/c"] },
      review2: { purpose: "second look", distinctVendor: true, effort: "auto" },
    })
    expect(settings.legacy).toEqual({ smol: ["a/d"], task: ["a/e"] })
    expect(settings.purposes).toEqual({ smol: "tiny jobs" })
    expect(settings.derive).toEqual({ prefer: ["openai"], avoid: ["x/*"], premium: 6 })
    expect(parseTierConfig({ model: [] })).toEqual({ model: "auto" })
    expect(parseTierConfig({})).toEqual({})
  })
})

describe("withEffort", () => {
  test("maps model entries to the nearest variant, keeps links and unknown models", () => {
    const list = [bedrock("anthropic.claude-opus-5-5"), bedrock("openai.gpt-6-luna", "xhigh"), "@other", "nope/x"]
    expect(withEffort(list, "none", models)).toEqual([
      bedrock("anthropic.claude-opus-5-5", "low"),
      bedrock("openai.gpt-6-luna", "none"),
      "@other",
      "nope/x",
    ])
    expect(withEffort(list, "high", models, true)[1]).toBe(bedrock("openai.gpt-6-luna", "xhigh"))
    expect(withEffort(list, "auto", models)[1]).toBe(bedrock("openai.gpt-6-luna"))
    expect(withEffort(list, undefined, models)).toEqual(list)
  })
})

describe("buildTiers", () => {
  test("no options: derived tiers at their default efforts, reviewer from strong, aliases through tiers", () => {
    const set = build({})
    expect(set.roles.cheap).toEqual([bedrock("anthropic.claude-haiku-5-5", "low"), bedrock("openai.gpt-6-luna", "low")])
    expect(set.roles.standard).toEqual([bedrock("openai.gpt-6.1-sol", "medium"), bedrock("anthropic.claude-sonnet-5-5", "medium")])
    expect(set.roles.strong).toEqual([bedrock("anthropic.claude-opus-5-5", "high"), bedrock("openai.gpt-6.1-sol", "high")])
    expect(set.roles.reviewer).toEqual(set.roles.strong)
    expect(set.roles.task).toEqual(["@standard"])
    expect(set.roles.challenger).toEqual(["@reviewer"])
    expect(set.roles.tiny).toEqual([bedrock("anthropic.claude-haiku-5-5", "none"), bedrock("openai.gpt-6-luna", "none")])
    expect(Object.keys(set.tiers)).toEqual(["cheap", "standard", "strong", "reviewer"])
    expect(set.tiers.cheap).toEqual({
      purpose: TIER_PURPOSE.cheap as string,
      distinctVendor: false,
      source: "derived",
      cost: "metered, $0.1/M input tokens",
      effort: "low",
    })
    expect(set.tiers.reviewer?.distinctVendor).toBe(true)
    expect(set.tiers.reviewer?.source).toBe("strong")
  })

  test("a configured list wins, its #effort over the tier effort; a custom tier borrows standard", () => {
    const set = build({
      tiers: {
        strong: { model: [bedrock("openai.gpt-6.1-sol"), bedrock("anthropic.claude-opus-5-5", "max")], effort: "xhigh" },
        docs: { effort: "low" },
        notes: { model: "auto", purpose: "writing release notes" },
      },
    })
    expect(set.roles.strong).toEqual([bedrock("openai.gpt-6.1-sol", "xhigh"), bedrock("anthropic.claude-opus-5-5", "max")])
    expect(set.roles.reviewer).toEqual([bedrock("openai.gpt-6.1-sol", "high"), bedrock("anthropic.claude-opus-5-5", "high")])
    expect(set.roles.docs).toEqual([bedrock("openai.gpt-6.1-sol", "low"), bedrock("anthropic.claude-sonnet-5-5", "low")])
    expect(Object.keys(set.tiers)).toEqual(["cheap", "standard", "strong", "reviewer", "docs", "notes"])
    expect(set.tiers.docs?.purposeMissing).toBe(true)
    expect(set.tiers.notes?.purpose).toBe("writing release notes")
    expect(set.tiers.strong?.source).toBe("config")
  })

  test("effort auto drops the variant", () => {
    const set = build({ tiers: { cheap: { effort: "auto" } } })
    expect(set.roles.cheap).toEqual([bedrock("anthropic.claude-haiku-5-5"), bedrock("openai.gpt-6-luna")])
    expect(set.tiers.cheap?.effort).toBe("auto")
  })

  test("the deprecated roles seed their tiers verbatim and keep their own names", () => {
    const set = build({
      roles: {
        smol: [bedrock("openai.gpt-6-luna")],
        task: [bedrock("openai.gpt-6-luna", "xhigh"), "@smol"],
        challenger: [bedrock("anthropic.claude-opus-5-5")],
        web: [bedrock("anthropic.claude-sonnet-5-5")],
        default: ["x/y"],
      },
      purposes: { smol: "quick things", web: "web lookups" },
      tiers: { standard: { model: "auto" } },
    })
    expect(set.roles.cheap).toEqual([bedrock("openai.gpt-6-luna")])
    expect(set.roles.smol).toEqual([bedrock("openai.gpt-6-luna")])
    expect(set.roles.task).toEqual([bedrock("openai.gpt-6-luna", "xhigh"), "@smol"])
    // An explicit "auto" ignores the legacy seed.
    expect(set.roles.standard?.[0]).toBe(bedrock("openai.gpt-6.1-sol", "medium"))
    expect(set.roles.reviewer).toEqual([bedrock("anthropic.claude-opus-5-5")])
    expect(set.roles.web).toEqual([bedrock("anthropic.claude-sonnet-5-5")])
    expect(set.roles.default).toBeUndefined()
    expect(set.tiers.cheap?.purpose).toBe("quick things")
    expect(set.tiers.cheap?.effort).toBeUndefined()
    expect(set.tiers.web?.purpose).toBe("web lookups")
    expect(Object.keys(set.tiers)).toEqual(["cheap", "standard", "strong", "reviewer", "web"])
  })

  test("classes: only premium models are expensive; ranks follow the lineup", () => {
    const { classes } = build({})
    const at = (id: string) => ({ providerID: "amazon-bedrock", id: `global.${id}` })
    expect(isExpensiveClass(at("anthropic.claude-fable-5-1"), classes)).toBe(true)
    expect(isExpensiveClass(at("openai.gpt-6-astra"), classes)).toBe(true)
    expect(isExpensiveClass(at("anthropic.claude-opus-5-5"), classes)).toBe(false)
    expect(isExpensiveClass(at("openai.gpt-6.1-sol"), classes)).toBe(false)
    expect(rankOf(at("anthropic.claude-opus-5-5"), classes)).toBe(2)
    expect(rankOf(at("anthropic.claude-opus-5"), classes)).toBe(2)
    expect(isExpensiveClass(at("anthropic.claude-fable-5-1"), build({ premium: 20 }).classes)).toBe(false)
    expect(isExpensiveClass(at("anthropic.claude-sonnet-5-5"), classes)).toBe(false)
    expect(isExpensiveClass(at("anthropic.claude-haiku-5-5"), classes)).toBe(false)
    expect(rankOf(at("anthropic.claude-haiku-5-5"), classes)).toBe(0)
    expect(rankOf(at("anthropic.claude-sonnet-5-5"), classes)).toBe(1)
    expect(rankOf({ providerID: "opencode", id: "flint-40b-free" }, classes)).toBeUndefined()
  })
})

describe("resolveTier", () => {
  const set = build({})
  const options = { roles: set.roles, tiers: set.tiers }
  test("reviewer puts another vendor than the caller's first", () => {
    expect(resolveTier(options, models, "reviewer", undefined, "anthropic").model?.id).toBe("global.openai.gpt-6.1-sol")
    expect(resolveTier(options, models, "reviewer", undefined, "openai").model?.id).toBe("global.anthropic.claude-opus-5-5")
    expect(resolveTier(options, models, "challenger", undefined, "anthropic").model?.id).toBe("global.openai.gpt-6.1-sol")
    expect(resolveTier(options, models, "reviewer").model?.id).toBe("global.anthropic.claude-opus-5-5")
    expect(resolveTier(options, models, "strong", undefined, "anthropic").model?.id).toBe("global.anthropic.claude-opus-5-5")
    expect(tierMeta(options, "judge")?.distinctVendor).toBe(true)
  })

  test("a caller vendor with no alternative keeps the order", () => {
    const only = buildTiers(parseTierSettings({ tiers: { reviewer: [bedrock("anthropic.claude-opus-5-5")] } }), models, refs)
    expect(resolveTier({ roles: only.roles, tiers: only.tiers }, models, "reviewer", undefined, "anthropic").model?.id).toBe(
      "global.anthropic.claude-opus-5-5",
    )
    expect(resolveRole(only.roles, models, "smol").model?.id).toBe("global.anthropic.claude-haiku-5-5")
  })
})
