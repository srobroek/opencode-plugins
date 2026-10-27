import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers every toolchain skill and disposes them", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual([
    "backend-background-jobs",
    "coexistence-worktree",
    "infrastructure-tfstate-guard",
    "ops-no-global-cargo-target",
    "ops-toolchain-cache-policy",
    "shell-language",
    "terraform-language",
    "toolchain-asset-ownership",
    "toolchain-frontend",
    "toolchain-guide",
    "toolchain-infrastructure",
    "toolchain-languages",
    "toolchain-quality-observability",
    "toolchain-stack-defaults",
  ])
  await cleanup?.()
  expect(fake.active()).toBe(0)
})
