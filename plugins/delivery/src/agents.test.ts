import { expect, test } from "bun:test"
import { type AgentDraft, parseAgentFile, shapeAgent } from "./agents.ts"

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
