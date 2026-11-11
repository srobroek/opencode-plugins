import { describe, expect, test } from "bun:test"
import path from "node:path"
import { checkAgent, checkFiles, checkFragment, shippedAgents } from "./check-agent-roles.ts"

const agent = (frontmatter: string, steps = "steps: 80\n") => `---\ndescription: x\nmode: subagent\n${steps}${frontmatter}---\nbody\n`
const role = (name: string) => `request:\n  headers:\n    x-opencode-model-role: ${name}\n`

describe("checkAgent", () => {
  test("requires positive integer steps", () => {
    for (const steps of ["", "steps: 0\n", "steps: -1\n", "steps: 1.5\n", 'steps: "80"\n', "steps: true\n"]) {
      expect(checkAgent("a.md", agent(role("standard"), steps), false).findings).toEqual([
        { file: "a.md", reason: "steps must be a positive integer" },
      ])
    }
    expect(checkAgent("a.md", agent(role("standard"), "steps: 1\n"), false).findings).toEqual([])
  })
  test("accepts a tier and an old role name", () => {
    expect(checkAgent("a.md", agent(role("standard")), false)).toEqual({ role: "standard", findings: [] })
    expect(checkAgent("a.md", agent(role("task")), false)).toEqual({ role: "task", findings: [] })
  })

  test("flags a missing header, an unknown role and an unexpected model", () => {
    expect(checkAgent("a.md", agent(""), false).findings[0]?.reason).toContain("no request.headers.x-opencode-model-role")
    expect(checkAgent("a.md", agent(role("worker")), false).findings[0]?.reason).toContain('unknown model tier "worker"')
    expect(checkAgent("a.md", agent(`model: a/b\n${role("task")}`), false).findings[0]?.reason).toContain("pins a model")
    expect(checkAgent("a.md", agent(`model: a/b\n${role("task")}`), true).findings).toEqual([])
    expect(checkAgent("a.md", "no frontmatter", false).findings[0]?.reason).toBe("no frontmatter")
  })
})

describe("checkFragment", () => {
  test("reports ids whose fragment role differs from the header", () => {
    const text = JSON.stringify({ agents: { a: "task", b: "tiny" } })
    expect(checkFragment("roles.json", text, { a: "task", b: "smol", c: "slow" }).map((f) => f.reason)).toEqual([
      "b: fragment says tiny, agent header says smol",
      "c: fragment says nothing, agent header says slow",
    ])
  })
})

test("every shipped agent declares a known model tier and positive integer steps", () => {
  const root = path.resolve(import.meta.dir, "..")
  const files = shippedAgents(path.join(root, "plugins"))
  expect(files.length).toBeGreaterThan(0)
  expect(checkFiles(root, files)).toEqual([])
})
