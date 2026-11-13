import { describe, expect, test } from "bun:test"
import { type AgentPermission, permissionEffect } from "./agent-files.ts"
import { DEFAULT_MCP_TOOLS, grantTools, parseToolsOption, refusedTool, toolRules } from "./agent-tools.ts"

const quiet = () => {}

describe("parseToolsOption", () => {
  test("absent means the public read-only defaults", () => {
    expect(parseToolsOption(undefined)).toEqual(["context7_*", "aws-mcp_*"])
    expect(DEFAULT_MCP_TOOLS).toEqual(["context7_*", "aws-mcp_*"])
  })

  test("a list replaces the defaults and drops duplicates", () => {
    expect(parseToolsOption(["demo_search", " demo_search ", "docs-*"], quiet)).toEqual(["demo_search", "docs-*"])
  })

  test.each([[false], [[]]])("%p disables the defaults", (value) => {
    expect(parseToolsOption(value)).toEqual([])
  })

  test.each([
    ["shell", "built-in"],
    ["*", "built-in"],
    ["s*", "built-in"],
    ["*_*", "built-in"],
    ["external_directory", "built-in"],
    ["subagent", "built-in"],
    ["edit", "built-in"],
    ["", "non-empty"],
    ["a b", "letters"],
  ])("refuses %p and warns", (pattern, reason) => {
    const warnings: string[] = []
    expect(parseToolsOption([pattern, "demo_*"], (message) => warnings.push(message))).toEqual(["demo_*"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(reason)
  })

  test.each([
    ["dep_*", "plugin"],
    ["dep_apply", "plugin"],
    ["delivery_*", "plugin"],
    ["de*", "plugin"],
    ["dep*", "plugin"],
    ["*_apply", "server"],
    ["*", "built-in"],
  ])("refuses the plugin tool pattern %p", (pattern, reason) => {
    expect(refusedTool(pattern)).toContain(reason)
  })

  test.each(["context7_*", "aws-mcp_*", "context7_query-docs", "deploy_*", "depot_*", "demo-server_lookup"])(
    "accepts the MCP pattern %p",
    (pattern) => {
      expect(refusedTool(pattern)).toBeUndefined()
    },
  )

  test("refuses a non-string entry and a non-array option", () => {
    const warnings: string[] = []
    expect(parseToolsOption([42, null], (message) => warnings.push(message))).toEqual([])
    expect(parseToolsOption("context7_*", (message) => warnings.push(message))).toEqual([...DEFAULT_MCP_TOOLS])
    expect(warnings).toHaveLength(3)
  })

  test("accepts server_tool names with dashes", () => {
    expect(refusedTool("context7_query-docs")).toBeUndefined()
    expect(refusedTool("aws-mcp_*")).toBeUndefined()
  })
})

describe("tool rules", () => {
  const own: AgentPermission[] = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
  ]

  test("allow rules go after the agent's own, so they win over the leading deny", () => {
    const file = grantTools({ id: "a", permissions: own }, { agents: ["a"], rules: toolRules(["demo_*"]) })
    expect(file.permissions.slice(0, 2)).toEqual(own)
    expect(file.permissions[2]).toEqual({ action: "demo_*", resource: "*", effect: "allow" })
    expect(permissionEffect(file.permissions, "demo_search")).toBe("allow")
    expect(permissionEffect(file.permissions, "other_search")).toBe("deny")
    expect(permissionEffect(file.permissions, "shell")).toBe("deny")
  })

  test("an agent the grant does not name is untouched", () => {
    const file = { id: "b", permissions: own }
    expect(grantTools(file, { agents: ["a"], rules: toolRules(["demo_*"]) })).toBe(file)
  })
})
