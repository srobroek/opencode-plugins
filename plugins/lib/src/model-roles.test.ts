import { expect, test } from "bun:test"
import { isModelRole, isModelTier, MODEL_ROLES, MODEL_TIER_ALIASES, MODEL_TIERS, tierFor } from "./model-roles.ts"

test("MODEL_ROLES lists the tiers, then every alias", () => {
  expect(MODEL_ROLES).toEqual([...MODEL_TIERS, ...Object.keys(MODEL_TIER_ALIASES)])
})

test("tiers and aliases", () => {
  expect(isModelTier("strong")).toBe(true)
  expect(isModelTier("slow")).toBe(false)
  expect(isModelRole("slow")).toBe(true)
  expect(isModelRole("worker")).toBe(false)
  expect(tierFor("challenger")).toBe("reviewer")
  expect(tierFor("cheap")).toBe("cheap")
  expect(tierFor("default")).toBe("inherit")
  expect(tierFor("worker")).toBeUndefined()
})
