import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { agentPaths, permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
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
        expect(["tasks", "requirements", "review"]).toContain(metadata.execution_agent_mode as string)
      if (metadata.execution_agent_type === "speckit-sync")
        expect(["drift", "conflicts", "both"]).toContain(metadata.execution_agent_scope as string)
    }
  })
})

test("shipped agents carry a model-roles role header and no model", () => {
  expect(agents.map((agent) => agent.id)).toEqual(["spec", "speckit-sync", "speckit-verify"])
  for (const agent of agents.filter((agent) => agent.id !== "spec")) {
    expect(agentRole(agent.request)).toBe("reviewer")
    expect(permissionEffect(agent.permissions, "edit")).toBe("deny")
    expect(permissionEffect(agent.permissions, "shell")).toBe("allow")
    expect(agent.mode).toBe("subagent")
  }
})

test("the spec agent edits only specs/ and .specify/ and runs only the SpecKit commands", () => {
  const spec = agents.find((agent) => agent.id === "spec")
  if (spec === undefined) throw new Error("no spec agent")
  const rules = spec.permissions
  expect(agentRole(spec.request)).toBe("strong")
  expect(spec.mode).toBe("primary")
  expect(spec.hidden).toBe(false)
  for (const path of ["specs/001-a/spec.md", "specs/001-a/contracts/api.md", ".specify/memory/constitution.md"])
    expect({ path, effect: permissionEffect(rules, "edit", path) }).toEqual({ path, effect: "allow" })
  for (const path of ["src/index.ts", "README.md", "AGENTS.md", ".beads/config.yaml"])
    expect({ path, effect: permissionEffect(rules, "edit", path) }).toEqual({ path, effect: "deny" })
  for (const command of [
    "bd mol current bd-1",
    "BEADS_DOLT_SHARED_SERVER= BEADS_DIR=/r/.beads '/bin/bun' '/p/dist/bd-embedded-write-runner.js' --beads-store /r/.beads --beads-wait-ms 5000 -- bd create x",
    "specify extension list",
    ".specify/scripts/bash/setup-plan.sh --json",
    "bash .specify/extensions/git/scripts/bash/create-new-feature.sh --json x",
    "git status --short",
    "git add specs/001-a",
    'git commit -m "docs: spec"',
  ])
    expect({ command, effect: permissionEffect(rules, "shell", command) }).toEqual({ command, effect: "allow" })
  for (const command of ["git push", "git reset --hard", "git add src", "rm -rf specs", "bun test", "npm install"])
    expect({ command, effect: permissionEffect(rules, "shell", command) }).toEqual({ command, effect: "deny" })
  for (const action of ["speckit_setup", "speckit_start", "parley", "question", "execute"])
    expect({ action, effect: permissionEffect(rules, action) }).toEqual({ action, effect: "allow" })
  for (const skill of ["speckit-specify", "speckit-critique-run", "quality-code-design"])
    expect({ skill, effect: permissionEffect(rules, "skill", skill) }).toEqual({ skill, effect: "allow" })
  expect(permissionEffect(rules, "skill", "delivery-git-workflow")).toBe("deny")
  for (const agent of ["explore", "researcher", "architect", "speckit-verify", "speckit-sync"])
    expect({ agent, effect: permissionEffect(rules, "subagent", agent) }).toEqual({ agent, effect: "allow" })
  for (const agent of ["implementer", "general", "build"])
    expect({ agent, effect: permissionEffect(rules, "subagent", agent) }).toEqual({ agent, effect: "deny" })
  expect(permissionEffect(rules, "webfetch")).toBe("deny")
})
