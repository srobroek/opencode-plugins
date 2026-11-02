import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentPaths, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { skillPaths } from "@srobroek/opencode-lib/skill-files"
import { checkText } from "../../../scripts/check-steering.ts"
import { decideRouting } from "../../beads/src/subagent-routing.ts"
import { FORMULAS, FORMULAS_DIR, installFormulas } from "./formulas.ts"

const root = join(import.meta.dir, "..")
const agents = agentPaths(join(root, "agents")).map(readAgentFile)
const skills = skillPaths(join(root, "skills")).map((path) => path.split("/").at(-2) as string)

type Step = {
  id: string
  title: string
  description?: string
  needs?: string[]
  metadata?: Record<string, unknown>
}
type Formula = { formula: string; vars?: Record<string, { required?: boolean; default?: string }>; steps: Step[] }

const files = readdirSync(FORMULAS_DIR).filter((file) => file.endsWith(".formula.toml"))
const formulas = files.map((file) => {
  const text = readFileSync(join(FORMULAS_DIR, file), "utf8")
  return { file, name: file.replace(/\.formula\.toml$/, ""), text, data: Bun.TOML.parse(text) as Formula }
})
const routed = formulas.flatMap(({ file, data }) =>
  data.steps
    .filter((step) => typeof step.metadata?.execution_agent_type === "string")
    .map((step) => ({ file, step, type: step.metadata?.execution_agent_type as string })),
)

test("ships exactly the formulas design_setup installs, each named for its file", () => {
  expect(formulas.map(({ name }) => name).sort()).toEqual([...FORMULAS].sort())
  for (const { name, data } of formulas) expect(data.formula).toBe(name)
})

describe("execution_agent_type routing (beads FO-5)", () => {
  test("the critique and audit steps route to a design agent", () => {
    expect(new Set(routed.map(({ type }) => type))).toEqual(new Set(["design-critic", "a11y-auditor"]))
  })

  for (const { file, step, type } of routed) {
    test(`${file} ${step.id}: ${type} is a shipped agent the routing gate admits`, () => {
      expect(agents.map((agent) => agent.id)).toContain(type)
      expect(step.metadata?.execution_mode).toBe("subagent")
      const bead = [{ id: "repo-mol-abc", agentType: type }]
      expect(decideRouting(type, bead).kind).toBe("allow")
      expect(decideRouting(`design:${type}`, bead).kind).toBe("allow")
      expect(decideRouting("general", bead).kind).toBe("block")
    })
  }

  test("every subagent-mode step names its agent", () => {
    for (const { data } of formulas)
      for (const step of data.steps)
        if (step.metadata?.execution_mode === "subagent") expect(step.metadata.execution_agent_type).toBeString()
  })
})

describe("formula content", () => {
  for (const { file, text, data } of formulas) {
    test(`${file} carries no omp steering`, () => {
      expect(checkText(file, text)).toEqual([])
      expect(text).not.toMatch(/@srobroek\/design\b|\bcomputer\b|\blsp\b|tab\.emulate|\bTern\b/)
    })

    test(`${file} names only shipped skills`, () => {
      for (const match of text.matchAll(/\bthe ([a-z][a-z-]+) skill\b/g)) expect(skills).toContain(match[1] as string)
      for (const step of data.steps) {
        const hints = step.metadata?.skill_hints
        if (typeof hints === "string") for (const hint of hints.split(/,\s*/)) expect(skills).toContain(hint)
      }
    })

    test(`${file} needs only its own steps and declares every var it uses`, () => {
      const ids = new Set(data.steps.map((step) => step.id))
      for (const step of data.steps) for (const need of step.needs ?? []) expect(ids).toContain(need)
      const declared = new Set(Object.keys(data.vars ?? {}))
      for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) expect(declared).toContain(match[1] as string)
    })
  }

  test("bonded formulas declare no var defaults, because bd mol bond does not apply them", () => {
    for (const { name, data } of formulas.filter(({ name }) => name.startsWith("mol-")))
      for (const [key, spec] of Object.entries(data.vars ?? {})) {
        expect({ name, key, default: spec.default }).toEqual({ name, key, default: undefined })
        expect(spec.required).toBe(true)
      }
  })

  test("the critique steps run the scan tool, not npx impeccable themselves", () => {
    for (const { text } of formulas) expect(text).not.toMatch(/npx --yes impeccable detect "/)
    const scans = formulas.filter(({ text }) => text.includes("design_impeccable_scan")).map(({ name }) => name)
    expect(scans.sort()).toEqual(["design-surface", "design-system", "mol-design-iterate"])
  })
})

describe("installFormulas", () => {
  test("copies every design formula once, then reports them unchanged, with the pour usage", () => {
    const repo = mkdtempSync(join(tmpdir(), "design-formulas-"))
    try {
      mkdirSync(join(repo, ".beads"))
      const first = installFormulas(".", repo)
      expect(first).toMatchObject({ ok: true, copied: [...FORMULAS], unchanged: [] })
      expect(first.text).toContain("bd mol pour design-touch")
      expect(readdirSync(join(repo, ".beads", "formulas")).length).toBe(FORMULAS.length)
      const second = installFormulas(repo, "/elsewhere")
      expect(second).toMatchObject({ ok: true, copied: [], unchanged: [...FORMULAS] })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
