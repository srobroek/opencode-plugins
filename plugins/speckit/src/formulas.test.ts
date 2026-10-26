import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { agentPaths, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { agentRole } from "@srobroek/opencode-lib/model-roles"
import { decideRouting } from "../../beads/src/subagent-routing.ts"
import { FORMULAS } from "./setup.ts"

const root = join(import.meta.dir, "..")
const formulas = join(root, "formulas")
const agents = agentPaths(join(root, "agents")).map(readAgentFile)

type Step = { id: string; metadata?: Record<string, unknown> }

function steps(file: string): Step[] {
  const data = Bun.TOML.parse(readFileSync(join(formulas, file), "utf8")) as { steps?: Step[] }
  return data.steps ?? []
}

const routed = readdirSync(formulas)
  .filter((file) => file.endsWith(".formula.toml"))
  .flatMap((file) => steps(file).map((step) => ({ file, step })))
  .filter(({ step }) => typeof step.metadata?.execution_agent_type === "string")

test("ships exactly the formulas setup installs", () => {
  const shipped = readdirSync(formulas).map((file) => file.replace(/\.formula\.toml$/, ""))
  expect(shipped.sort()).toEqual([...FORMULAS].sort())
})

describe("execution_agent_type routing (beads FO-5)", () => {
  test("some steps route to a speckit agent", () => {
    expect(routed.length).toBeGreaterThan(0)
  })

  for (const { file, step } of routed) {
    const type = step.metadata?.execution_agent_type as string
    test(`${file} ${step.id}: ${type} is a shipped agent the routing gate admits`, () => {
      expect(agents.map((agent) => agent.id)).toContain(type)
      const bead = [{ id: "sk-abc1.4", agentType: type }]
      expect(decideRouting(type, bead).kind).toBe("allow")
      expect(decideRouting(`speckit:${type}`, bead).kind).toBe("allow")
      expect(decideRouting("general", bead).kind).toBe("block")
    })
  }

  test("mode and scope selectors sit next to the agent type", () => {
    for (const { step } of routed) {
      const metadata = step.metadata ?? {}
      if (metadata.execution_agent_type === "speckit-verify")
        expect(["tasks", "requirements"]).toContain(metadata.execution_agent_mode as string)
      if (metadata.execution_agent_type === "speckit-sync")
        expect(["drift", "conflicts", "both"]).toContain(metadata.execution_agent_scope as string)
    }
  })
})

test("shipped agents carry a model-roles role header and no model", () => {
  expect(agents.map((agent) => agent.id)).toEqual(["speckit-sync", "speckit-verify"])
  for (const agent of agents) {
    expect(agentRole(agent.request)).toBe("challenger")
    expect(agent.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
    expect(agent.mode).toBe("subagent")
  }
})
