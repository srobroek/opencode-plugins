import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { AGENT_IDS, type AgentFile, loadAgents, parseAgentFile, shapeAgent } from "./agents.ts"
import { createPlugin, indexResource, readIndexParams, SKILL_NAMES } from "./index.ts"
import { type Exec, installFormulas, JOURNEYS_SCRIPT, journeysWrites, runJourneys } from "./journeys-tool.ts"

const execFileAsync = promisify(execFile)

const tempRoot = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

function seedJourney(root: string, name = "J1-login"): string {
  const journey = join(root, name)
  mkdirSync(join(journey, "runs"), { recursive: true })
  writeFileSync(
    join(journey, "journey.md"),
    "---\nid: J1\ntitle: Login\nversion: 1\nstatus: draft\nlast_reviewed: 2026-01-01\nsurfaces: [web]\ninterfaces: [browser]\n---\n\n### S1 — Open app {#S1}\n",
  )
  return journey
}

function formulaSource(): string {
  const source = tempRoot("journeys-formulas-source-")
  for (const name of ["journey-step-agentic-verification", "journey-step-human-verification"])
    writeFileSync(join(source, `${name}.formula.toml`), `formula = '${name}'\n`)
  return source
}

describe("runJourneys", () => {
  test("maps each command and the prune flags to the Python CLI and passes cwd", async () => {
    const seen: { file: string; args: string[]; options: Record<string, unknown> }[] = []
    const runner: Exec = async (file, args, options) => {
      seen.push({ file, args, options })
      return { stdout: "ok", stderr: "" }
    }
    await runJourneys("/cwd", { command: "index", journeysDir: "/j" }, undefined, runner)
    await runJourneys("/cwd", { command: "lint", journeysDir: "/j" }, undefined, runner)
    await runJourneys("/cwd", { command: "prune", journeysDir: "/j", keep: 3, journey: "J1-login", yes: true }, undefined, runner)
    expect(seen.map(({ file }) => file)).toEqual(["python3", "python3", "python3"])
    expect(seen[0]?.args).toEqual([JOURNEYS_SCRIPT, "index", "/j"])
    expect(seen[1]?.args).toEqual([JOURNEYS_SCRIPT, "lint", "/j"])
    expect(seen[2]?.args).toEqual([JOURNEYS_SCRIPT, "prune", "/j", "--keep", "3", "--journey", "J1-login", "--yes"])
    expect(seen.every(({ options }) => options.cwd === "/cwd" && options.shell === false)).toBe(true)
  })

  test("returns stdout, stderr and a non-zero exit code", async () => {
    const result = await runJourneys("/cwd", { command: "lint", journeysDir: "/j" }, undefined, async () => {
      throw { code: 7, stdout: "partial output", stderr: "lint failed" }
    })
    expect(result).toEqual({ stdout: "partial output", stderr: "lint failed", exitCode: 7 })
  })

  test("runs the bundled Python helper end to end", async () => {
    const root = tempRoot("journeys-e2e-")
    try {
      seedJourney(root)
      const result = await runJourneys(root, { command: "index", journeysDir: root })
      expect(result).toMatchObject({ exitCode: 0 })
      expect(result.stdout).toContain("INDEX.md: 1 journeys")
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toContain("[J1](J1-login/journey.md)")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a run that outlasts its bound is unrun, not a failed exit", async () => {
    const dir = tempRoot("journeys-timeout-")
    const python = join(dir, "python3")
    writeFileSync(python, "#!/bin/sh\nexec /bin/sleep 30\n")
    chmodSync(python, 0o755)
    try {
      const result = await runJourneys(
        dir,
        { command: "lint", journeysDir: dir },
        undefined,
        (_file, args, options) => execFileAsync(python, args, options),
        3_000,
      )
      expect(result).toEqual({ stdout: "", stderr: "", unrun: "timed out after 3 s" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  test("an aborted run is cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runJourneys("/cwd", { command: "lint", journeysDir: "/j" }, controller.signal, async () => {
      throw { code: "ABORT_ERR", message: "aborted" }
    })
    expect(result).toMatchObject({ unrun: "cancelled" })
  })

  test("only index and prune --yes write", () => {
    expect(journeysWrites({ command: "index" })).toBe(true)
    expect(journeysWrites({ command: "lint" })).toBe(false)
    expect(journeysWrites({ command: "prune" })).toBe(false)
    expect(journeysWrites({ command: "prune", yes: true })).toBe(true)
  })
})

describe("installFormulas", () => {
  test("refuses a repository without Beads", () => {
    const root = tempRoot("journeys-no-beads-")
    try {
      expect(installFormulas(root, false, root).ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("copies the formulas, keeps identical copies and refuses divergent ones unless forced", () => {
    const source = formulaSource()
    const repo = tempRoot("journeys-formulas-repo-")
    try {
      mkdirSync(join(repo, ".beads"))
      expect(installFormulas(repo, false, "/", source)).toMatchObject({ ok: true, copied: 2, unchanged: 0 })
      expect(installFormulas(repo, false, "/", source)).toMatchObject({ ok: true, copied: 0, unchanged: 2 })
      const target = join(repo, ".beads", "formulas", "journey-step-human-verification.formula.toml")
      writeFileSync(target, "edited\n")
      expect(installFormulas(repo, false, "/", source).text).toContain("refusing to overwrite divergent")
      expect(installFormulas(repo, true, "/", source)).toMatchObject({ ok: true, copied: 1, unchanged: 1 })
      expect(readFileSync(target, "utf8")).toBe("formula = 'journey-step-human-verification'\n")
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("resolves file URLs and relative roots against the base", () => {
    const source = formulaSource()
    const repo = tempRoot("journeys-formulas-url-")
    try {
      mkdirSync(join(repo, ".beads"))
      const result = installFormulas(pathToFileURL(repo).href, false, "/", pathToFileURL(source).href)
      expect(result).toMatchObject({ ok: true, copied: 2 })
      expect(installFormulas(".", false, repo, source)).toMatchObject({ ok: true, unchanged: 2 })
      expect(installFormulas("../x", false, repo, source).ok).toBe(false)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("ships both required formulas", () => {
    const repo = tempRoot("journeys-formulas-shipped-")
    try {
      mkdirSync(join(repo, ".beads"))
      expect(installFormulas(repo, false, "/")).toMatchObject({ ok: true, copied: 2 })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe("input", () => {
  test("validates journeys_index parameters", () => {
    expect(readIndexParams({ command: "lint", journeysDir: "j" })).toEqual({ command: "lint", journeysDir: "j" })
    expect(readIndexParams({ command: "drop", journeysDir: "j" })).toContain("command")
    expect(readIndexParams({ command: "prune", journeysDir: "j", keep: -1 })).toContain("keep")
    expect(readIndexParams({ command: "prune", journeysDir: "j", keep: 1.5 })).toContain("keep")
    expect(readIndexParams({ command: "prune", journeysDir: "" })).toContain("journeysDir")
  })

  test("names a prune's journey, or all of them, in the permission resource", () => {
    expect(indexResource({ command: "index", journeysDir: "/j" })).toBe("index /j")
    expect(indexResource({ command: "prune", journeysDir: "/j", journey: "J1-a", yes: true })).toBe("prune /j J1-a")
    expect(indexResource({ command: "prune", journeysDir: "/j", yes: true })).toBe("prune /j *all*")
  })
})

describe("agents", () => {
  test("the shipped agents parse as subagents with a model role and the converted permissions", () => {
    const agents = loadAgents()
    expect(agents.map((agent) => agent.id)).toEqual([...AGENT_IDS])
    for (const agent of agents) {
      expect(agent.mode).toBe("subagent")
      expect(agent.description).toBeTruthy()
      expect(agent.request?.headers).toEqual({ "x-opencode-model-role": "task" })
      expect(agent.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
      expect(agent.system).not.toMatch(/skill:\/\/|CAP: none|\bbash\b|\beval\b|result channel/)
    }
    expect(agents.find((agent) => agent.id === "journey-validator")?.steps).toBe(400)
    const shaped: Record<string, unknown> = {}
    shapeAgent(shaped, agents.find((agent) => agent.id === "journey-validator") as AgentFile, true)
    expect(shaped.steps).toBe(400)
  })

  test("a configured agent keeps its fields, and its permissions come after the shipped ones", () => {
    const file = parseAgentFile("x", "---\ndescription: shipped\nmode: subagent\npermissions:\n  - action: edit\n    resource: \"*\"\n    effect: deny\n---\nbody\n")
    const own = { action: "edit", resource: "*", effect: "allow" }
    const agent = { description: "mine", mode: "all", permissions: [own] }
    shapeAgent(agent, file, false)
    expect(agent).toMatchObject({ name: "x", description: "mine", mode: "all", system: "body" })
    expect(agent.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }, own])
  })
})

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>

describe("plugin", () => {
  const context = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }

  test("registers the tools, agents and skills, and disposes them all", async () => {
    const fake = createFakeContext()
    const cleanup = await createPlugin().setup(fake.context)
    expect([...fake.tools.keys()]).toEqual(["journeys_index", "journey_install_formulas"])
    expect([...fake.agents.keys()]).toEqual([...AGENT_IDS])
    expect(fake.agents.get("journey-validator")).toMatchObject({ name: "journey-validator", mode: "subagent" })
    expect([...fake.skills.keys()]).toEqual([...SKILL_NAMES])
    for (const skill of fake.skills.values())
      expect(String(skill.content)).not.toMatch(/skill:\/\/|rule:\/\/|AskUserQuestion|\.claude\/agents/)
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
    expect(fake.skills.size).toBe(0)
  })

  test("journeys_index asks permission before writing, not for lint or a dry-run prune", async () => {
    const seen: string[][] = []
    const exec: Exec = async (_file, args) => {
      seen.push(args)
      return { stdout: "done", stderr: "" }
    }
    const fake = createFakeContext({ directory: "/project" })
    await createPlugin({ exec }).setup(fake.context)
    const run = fake.tools.get("journeys_index")?.execute as Execute
    expect((await run({ command: "lint", journeysDir: "docs/journeys" }, context)).content).toBe("done")
    await run({ command: "prune", journeysDir: "docs/journeys", journey: "J1-a" }, context)
    expect(fake.asserts).toEqual([])
    await run({ command: "index", journeysDir: "docs/journeys" }, context)
    expect(fake.asserts).toHaveLength(1)
    expect(fake.asserts[0]).toMatchObject({ action: "journeys_index", resources: ["index /project/docs/journeys"] })
    expect(seen[2]?.slice(1)).toEqual(["index", "/project/docs/journeys"])
  })

  test("a rejected permission stops journeys_index before the helper runs", async () => {
    let ran = false
    const fake = createFakeContext({
      assert: () => {
        throw new Error("rejected")
      },
    })
    await createPlugin({
      exec: async () => {
        ran = true
        return { stdout: "", stderr: "" }
      },
    }).setup(fake.context)
    const run = fake.tools.get("journeys_index")?.execute as Execute
    await expect(run({ command: "prune", journeysDir: "/j", yes: true }, context)).rejects.toThrow("rejected")
    expect(fake.asserts[0]?.resources).toEqual(["prune /j *all*"])
    expect(ran).toBe(false)
  })

  test("journey_install_formulas asks permission for the resolved repository root", async () => {
    const repo = tempRoot("journeys-plugin-formulas-")
    try {
      mkdirSync(join(repo, ".beads"))
      const fake = createFakeContext({ directory: repo })
      await createPlugin().setup(fake.context)
      const install = fake.tools.get("journey_install_formulas")?.execute as Execute
      const result = await install({ repoRoot: "." }, context)
      expect(result.metadata).toMatchObject({ ok: true, copied: 2 })
      expect(fake.asserts[0]).toMatchObject({ action: "journey_install_formulas", resources: [repo] })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("the built entry resolves the shipped files from the package root", async () => {
    const built = (await import(join(import.meta.dir, "..", "index.js"))) as { JOURNEYS_SCRIPT: string }
    expect(built.JOURNEYS_SCRIPT).toBe(join(import.meta.dir, "..", "skills", "journey-init", "scripts", "journeys.py"))
    expect(existsSync(built.JOURNEYS_SCRIPT)).toBe(true)
  })
})
