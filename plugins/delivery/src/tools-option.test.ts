import { describe, expect, test } from "bun:test"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

const IDS = ["implementer", "implementer-high", "researcher"]

const rulesOf = async (options?: Record<string, unknown>) => {
  const fake = createFakeContext({ options })
  await plugin.setup(fake.context)
  return (id: string) => fake.agents.get(id)?.permissions as AgentPermission[]
}

describe("tools option", () => {
  test.each(IDS)("%s allows context7 and aws-mcp tools by default, after its own rules", async (id) => {
    const rules = (await rulesOf())(id)
    expect(rules.slice(-2)).toEqual([
      { action: "context7_*", resource: "*", effect: "allow" },
      { action: "aws-mcp_*", resource: "*", effect: "allow" },
    ])
    expect(permissionEffect(rules, "context7_query-docs")).toBe("allow")
    expect(permissionEffect(rules, "aws-mcp_search_documentation")).toBe("allow")
    expect(permissionEffect(rules, "other_tool")).toBe("deny")
  })

  test.each(IDS)("%s takes a custom list instead of the defaults", async (id) => {
    const rules = (await rulesOf({ tools: ["demo-server_lookup"] }))(id)
    expect(permissionEffect(rules, "demo-server_lookup")).toBe("allow")
    expect(permissionEffect(rules, "context7_query-docs")).toBe("deny")
  })

  test.each(IDS)("%s gets no MCP rules when tools is false", async (id) => {
    const rules = (await rulesOf({ tools: false }))(id)
    expect(permissionEffect(rules, "context7_query-docs")).toBe("deny")
    expect(permissionEffect(rules, "aws-mcp_x")).toBe("deny")
  })

  test.each(IDS)("%s refuses shell and * and keeps its boundary", async (id) => {
    const before = (await rulesOf({ tools: false }))(id)
    const warn = console.warn
    console.warn = () => {}
    try {
      const rules = (await rulesOf({ tools: ["shell", "*", "edit"] }))(id)
      expect(rules).toEqual(before)
    } finally {
      console.warn = warn
    }
  })

  test("pr-reviewer, operator and shepherd get no MCP rules", async () => {
    const rules = await rulesOf()
    for (const id of ["pr-reviewer", "operator", "shepherd"])
      expect(permissionEffect(rules(id), "context7_query-docs")).toBe("deny")
  })
})
