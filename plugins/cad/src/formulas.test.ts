import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { agentPaths, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { skillPaths } from "@srobroek/opencode-lib/skill-files"
import { checkText } from "../../../scripts/check-steering.ts"
import { decideRouting } from "../../beads/src/subagent-routing.ts"
import { FORMULAS, FORMULAS_DIR } from "./formulas.ts"

const root = join(import.meta.dir, "..")
const skillsDir = join(root, "skills")
const agents = agentPaths(join(root, "agents")).map(readAgentFile)
const skills = skillPaths(skillsDir).map((path) => path.split("/").at(-2) as string)

type Step = { id: string; title: string; description?: string; needs?: string[]; metadata?: Record<string, unknown> }
type Formula = { formula: string; vars?: Record<string, { required?: boolean; default?: string }>; steps: Step[] }

const formulas = readdirSync(FORMULAS_DIR)
  .filter((file) => file.endsWith(".formula.toml"))
  .map((file) => {
    const text = readFileSync(join(FORMULAS_DIR, file), "utf8")
    return { file, name: file.replace(/\.formula\.toml$/, ""), text, data: Bun.TOML.parse(text) as Formula }
  })
const routed = formulas.flatMap(({ file, data }) =>
  data.steps
    .filter((step) => typeof step.metadata?.execution_agent_type === "string")
    .map((step) => ({ file, step, type: step.metadata?.execution_agent_type as string })),
)

/** Every Markdown file the model reads: skills, references, agents and the formulas README. */
function prose(): { path: string; text: string }[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".md")) files.push(path)
    }
  }
  walk(skillsDir)
  walk(join(root, "agents"))
  files.push(join(FORMULAS_DIR, "README.md"))
  return [...files, ...formulas.map(({ file }) => join(FORMULAS_DIR, file))].map((path) => ({
    path: relative(root, path),
    text: readFileSync(path, "utf8"),
  }))
}

test("ships exactly the formulas cad_setup installs, each named for its file", () => {
  expect(formulas.map(({ name }) => name).sort()).toEqual([...FORMULAS].sort())
  for (const { name, data } of formulas) expect(data.formula).toBe(name)
})

describe("execution_agent_type routing", () => {
  test("worker steps route to the six cad agents", () => {
    expect(new Set(routed.map(({ type }) => type))).toEqual(new Set(agents.map((agent) => agent.id)))
  })

  for (const { file, step, type } of routed) {
    test(`${file} ${step.id}: ${type} is a shipped subagent the routing gate admits`, () => {
      expect(agents.map((agent) => agent.id)).toContain(type)
      expect(step.metadata?.execution_mode).toBe("subagent")
      const bead = [{ id: "repo-mol-abc", agentType: type }]
      expect(decideRouting(type, bead).kind).toBe("allow")
      expect(decideRouting("general", bead).kind).toBe("block")
    })
  }
})

describe("formula content", () => {
  for (const { file, text, data } of formulas) {
    test(`${file} names only shipped skills and declares every var it uses`, () => {
      for (const match of text.matchAll(/\bthe (cad-[a-z-]+) skill\b/g)) expect(skills).toContain(match[1] as string)
      for (const step of data.steps) {
        const hints = step.metadata?.skill_hints
        if (typeof hints === "string") for (const hint of hints.split(/,\s*/)) expect(skills).toContain(hint)
      }
      const ids = new Set(data.steps.map((step) => step.id))
      for (const step of data.steps) for (const need of step.needs ?? []) expect(ids).toContain(need)
      const declared = new Set(Object.keys(data.vars ?? {}))
      for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) expect(declared).toContain(match[1] as string)
    })
  }
})

describe("OpenCode wording", () => {
  const files = prose()

  test("no file names an OMP launcher, URI or harness", () => {
    for (const { path, text } of files) {
      expect({ path, hits: text.match(/skill:\/\/|uv run --script (?:skill|cad\/skills|\.opencode)|\bOMP\b|PI_SESSION_ID/g) }).toEqual({
        path,
        hits: null,
      })
    }
  })

  test("skills and agents pass the repository steering check", () => {
    for (const { path, text } of files.filter(({ path }) => path.startsWith("skills/") || path.startsWith("agents/")))
      expect({ path, findings: checkText(path, text) }).toEqual({ path, findings: [] })
  })

  test("every cad_run names a script that ships under skills/", () => {
    let count = 0
    for (const { path, text } of files)
      for (const match of text.matchAll(/cad_run ([a-z][\w-]*\/(?:scripts|tests)\/[\w/.-]+\.py)/g)) {
        count++
        expect({ path, script: match[1], exists: existsSync(join(skillsDir, match[1] as string)) }).toEqual({
          path,
          script: match[1],
          exists: true,
        })
      }
    expect(count).toBeGreaterThan(50)
  })
})
