import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { type AgentDraft, agentPath, parseAgentFile, shapeAgent } from "./agents.ts"

test("agent frontmatter steps reach the registered definition without overriding user settings", () => {
  const file = parseAgentFile("implementer", "---\nsteps: 150\n---\nprompt")
  const created: AgentDraft = {}
  shapeAgent(created, file, undefined, true)
  expect(created.steps).toBe(150)
  const existing: AgentDraft = { steps: 25 }
  shapeAgent(existing, file, undefined, false)
  expect(existing.steps).toBe(25)
})

test("rejects invalid step limits", () => {
  for (const steps of ["0", "-1", "1.5", '"150"', "true"]) {
    expect(() => parseAgentFile("implementer", `---\nsteps: ${steps}\n---\nprompt`)).toThrow(
      "steps must be a positive integer",
    )
  }
})

test.each(["implementer", "implementer-high"])("%s may spawn debug but not coder or a reviewer", (id) => {
  const { permissions } = parseAgentFile(id, readFileSync(agentPath(id), "utf8"))
  expect(permissionEffect(permissions, "subagent", "debug")).toBe("allow")
  expect(permissionEffect(permissions, "subagent", "explore")).toBe("allow")
  for (const other of ["coder", "code-reviewer"]) expect(permissionEffect(permissions, "subagent", other)).toBe("deny")
})
