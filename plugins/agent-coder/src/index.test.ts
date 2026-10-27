import { expect, test } from "bun:test"
import { join } from "node:path"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

const PLUGINS = join(import.meta.dir, "../..")

const setup = async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  const agent = fake.agents.get("coder")
  return { fake, cleanup, agent, rules: agent?.permissions as AgentPermission[] }
}

const allowedSkills = (rules: AgentPermission[]) =>
  rules.filter((rule) => rule.action === "skill" && rule.effect === "allow").map((rule) => rule.resource)

test("registers the standard-tier coder subagent and disposes it", async () => {
  const { fake, cleanup, agent } = await setup()
  expect(fake.skills.size).toBe(0)
  expect(agent).toMatchObject({ mode: "subagent", request: { headers: { "x-opencode-model-role": "standard" } } })
  expect(agent?.model).toBeUndefined()
  expect(agent?.description).toContain("general only for non-code work")
  expect(agent?.system).toContain("VERDICT: DONE|PARTIAL|BLOCKED")
  await cleanup?.()
  expect(fake.active()).toBe(0)
})

test("allows only coding tools", async () => {
  const { rules } = await setup()
  const tools = ["read", "grep", "glob", "edit", "shell", "webfetch", "websearch", "execute", "lsp_diagnostics"]
  for (const action of [...tools, "dep_scan", "dep_apply", "version_gap_scan"]) expect(permissionEffect(rules, action)).toBe("allow")
  for (const action of ["question", "some_plugin_tool", "find_tools_scan", "goal_complete", "parley_ask", "journeys_index"])
    expect(permissionEffect(rules, action)).toBe("deny")
  expect(permissionEffect(rules, "read", "src/.env")).toBe("ask")
  expect(permissionEffect(rules, "read", "src/.env.example")).toBe("allow")
  expect(permissionEffect(rules, "external_directory", "/tmp/x/*")).toBe("ask")
})

test("spawns only explore and mechanic", async () => {
  const { rules } = await setup()
  for (const child of ["explore", "mechanic"]) expect(permissionEffect(rules, "subagent", child)).toBe("allow")
  for (const child of ["general", "coder", "implementer", "researcher"])
    expect(permissionEffect(rules, "subagent", child)).toBe("deny")
})

test("allowlists coding skills by id or family prefix and denies the rest", async () => {
  const { rules } = await setup()
  const skills = allowedSkills(rules)
  expect(skills).not.toContain("*")
  const ids = ["quality-code-policy", "lang-typescript-quality", "lang-rust-quality", "lang-go", "shell-language", "dep-update", "ast-grep-search"]
  for (const id of [...ids, "whats-new"]) expect(permissionEffect(rules, "skill", id)).toBe("allow")
  const excluded = ["design-md", "journey-write", "speckit-bugfix", "delivery-fan-out", "delivery-git-workflow", "debate"]
  for (const id of [...excluded, "license-picker", "beads-ledger", "find-tools", "prototype-logic"])
    expect(permissionEffect(rules, "skill", id)).toBe("deny")
})

test("every allowlisted skill ships in this repository", async () => {
  const { rules } = await setup()
  const ids = new Set(
    [...new Bun.Glob("*/skills/**/SKILL.md").scanSync(PLUGINS)].map((path) => path.split("/").at(-2)),
  )
  for (const id of allowedSkills(rules)) {
    const shipped = id.endsWith("*") ? [...ids].some((name) => name?.startsWith(id.slice(0, -1))) : ids.has(id)
    expect({ id, shipped }).toEqual({ id, shipped: true })
  }
})

test("every allowlisted router member's router is allowlisted too", async () => {
  const { rules } = await setup()
  const allowed = { has: (id: string) => permissionEffect(rules, "skill", id) === "allow" }
  const row = /^\|.*\|\s*`([\w-]+)`\s*\|\s*$/
  const routerOf = new Map<string, string>()
  for (const path of new Bun.Glob("*/skills/*/SKILL.md").scanSync(PLUGINS)) {
    const text = await Bun.file(join(PLUGINS, path)).text()
    if (!text.includes("| Load skill |")) continue
    const router = path.split("/").at(-2) as string
    for (const line of text.split("\n")) {
      const member = row.exec(line)?.[1]
      if (member !== undefined) routerOf.set(member, router)
    }
  }
  const routed = [...routerOf.keys()].filter((id) => allowed.has(id))
  expect(routed.length).toBeGreaterThan(0)
  for (const id of routed) {
    const router = routerOf.get(id)
    expect({ id, router, allowed: allowed.has(router as string) }).toEqual({ id, router, allowed: true })
  }
  for (const router of ["lang-go", "lang-python", "lang-typescript", "lang-rust", "toolchain-guide", "architecture-guide", "trunk-dev-guide"])
    expect(permissionEffect(rules, "skill", router)).toBe("allow")
})
