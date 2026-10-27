import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  AGENT_DESCRIPTION,
  CONTEXT_BLOCK,
  checkAgent,
  checkBlock,
  checkPlugins,
  checkSkill,
  checkTool,
  SKILL_DESCRIPTION,
  TOOL_FIRST_LINE,
  unexempted,
} from "./check-descriptions.ts"

const long = (n: number) => "x".repeat(n)

describe("checkTool", () => {
  test("accepts a short first line with detail on later lines", () => {
    expect(checkTool("p", { name: "p_do", description: `Do it.\n${long(500)}`, input: {} }, false)).toEqual([])
  })

  test("flags a long first line, an oversized schema and an unjustified direct tool", () => {
    const reasons = (tool: Parameters<typeof checkTool>[1], direct = false) =>
      checkTool("p", tool, direct).map((finding) => finding.reason)
    expect(reasons({ name: "a", description: long(TOOL_FIRST_LINE + 1) })[0]).toContain("first description line")
    expect(reasons({ name: "a", description: "x", input: { d: long(3000) } })[0]).toContain("input schema")
    expect(reasons({ name: "a", description: "x", input: { d: long(2000) }, options: { codemode: false } })).toHaveLength(2)
    expect(reasons({ name: "a", description: "x", input: { d: long(2000) } })).toEqual([])
    expect(reasons({ name: "a", description: "x", options: { codemode: false } })[0]).toContain("check-descriptions: direct")
    expect(reasons({ name: "a", description: "x", options: { codemode: false } }, true)).toEqual([])
  })
})

describe("files", () => {
  test("skill, agent and block limits", () => {
    const skill = (description: string) => `---\nname: s\ndescription: ${description}\n---\nbody`
    expect(checkSkill("s.md", skill(long(SKILL_DESCRIPTION)))).toEqual([])
    expect(checkSkill("s.md", skill(long(SKILL_DESCRIPTION + 1)))[0]?.key).toBe("skill:s")
    const agent = (description: string) => `---\ndescription: "${description}"\nmode: subagent\n---\nbody`
    expect(checkAgent("a/agents/x.md", agent(long(AGENT_DESCRIPTION)))).toEqual([])
    expect(checkAgent("a/agents/x.md", agent(long(AGENT_DESCRIPTION + 1)))[0]?.key).toBe("agent:x")
    expect(checkBlock("p", "b.md", long(CONTEXT_BLOCK))).toEqual([])
    expect(checkBlock("p", "b.md", long(CONTEXT_BLOCK + 1))[0]?.key).toBe("block:p/b.md")
  })
})

describe("unexempted", () => {
  test("drops exempt findings and reports stale exemptions", () => {
    const findings = [
      { key: "tool:a", where: "w", reason: "r" },
      { key: "tool:b", where: "w", reason: "r" },
    ]
    expect(unexempted(findings, { "tool:a": "why", "tool:gone": "why" }).map((finding) => finding.key)).toEqual([
      "tool:b",
      "tool:gone",
    ])
  })
})

test("the shipped plugins pass", async () => {
  expect(unexempted(await checkPlugins(path.join(import.meta.dir, "..", "plugins")))).toEqual([])
})
