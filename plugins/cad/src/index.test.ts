import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { permissionEffect } from "@srobroek/opencode-lib/agent-files"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { createPlugin, FORMULAS, PLUGIN_ID, RUN_TOOL, SETUP_TOOL, STOP_TOOL } from "./index.ts"

const SKILLS_DIR = join(import.meta.dir, "..", "skills")
const SKILLS = [
  "cad-analysis",
  "cad-bom",
  "cad-concept",
  "cad-design",
  "cad-drawings",
  "cad-fits",
  "cad-flow",
  "cad-model",
  "cad-motion",
  "cad-recheck",
  "cad-record",
  "cad-render",
  "cad-review-dfm",
  "cad-review-mech",
  "cad-viewer",
]
const WRITERS = ["cad-analyst", "cad-concept-designer", "cad-part-designer"]
const READERS = ["cad-dfm-reviewer", "cad-mech-reviewer", "cad-sourcing-researcher"]

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>
type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }

const scratch: string[] = []
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

const call = (sessionID: string) => ({
  sessionID,
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  signal: new AbortController().signal,
})
const exited = (stdout = "", exitCode = 0): SupervisedRun => ({ kind: "exited", exitCode, signalCode: null, stdout, stderr: "" })

function harness(overrides: Parameters<typeof createPlugin>[0] = {}, directory = temp("cad-project-")) {
  const fake = createFakeContext({
    directory,
    sessions: [
      { id: "ses_root", location: { directory } },
      { id: "ses_child", parentID: "ses_root", location: { directory } },
    ],
  })
  const runs: { argv: string[]; cwd: string; env: Record<string, string> }[] = []
  let handled = 0
  const instance = createPlugin({
    exec: async (argv, options) => {
      runs.push({ argv, cwd: options.cwd, env: options.env })
      return exited(`{"ok": true}\n`)
    },
    eventHandled: () => {
      handled++
    },
    ...overrides,
  })
  const tool = (name: string) => fake.tools.get(name)?.execute as Execute
  const settle = async (count: number) => {
    for (let wait = 0; handled < count && wait < 200; wait++) await Bun.sleep(5)
  }
  return { fake, instance, runs, tool, directory, settle }
}

test("registers the CAD skills, the six subagents and three tools, and disposes them all", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(SKILLS)
  expect([...fake.agents.keys()].sort()).toEqual([...READERS, ...WRITERS].sort())
  for (const agent of fake.agents.values()) expect(agent.mode).toBe("subagent")
  expect([...fake.tools.keys()]).toEqual([SETUP_TOOL, RUN_TOOL, STOP_TOOL])
  await cleanup?.()
  expect(fake.active()).toBe(0)
  expect(fake.tools.size).toBe(0)
})

describe("agent boundaries", () => {
  const fake = createFakeContext()
  beforeAll(async () => {
    await plugin.setup(fake.context)
  })
  const rules = (id: string) => fake.agents.get(id)?.permissions as Rule[]

  test("writers edit only .cad-work and run scripts through cad_run, with no shell", () => {
    for (const id of WRITERS) {
      expect(permissionEffect(rules(id), "edit", ".cad-work/part-arm/hw/parts/LMP-0001/model.py")).toBe("allow")
      expect(permissionEffect(rules(id), "edit", "hw/parts/LMP-0001/model.py")).toBe("deny")
      expect(permissionEffect(rules(id), RUN_TOOL, "cad-flow/scripts/scratch.py")).toBe("allow")
      expect(permissionEffect(rules(id), "shell", "uv run --script x.py")).toBe("deny")
      expect(permissionEffect(rules(id), STOP_TOOL)).toBe("deny")
      expect(permissionEffect(rules(id), "subagent")).toBe("deny")
    }
  })

  test("reviewers and the researcher edit and run nothing; only the researcher reaches the web", () => {
    for (const id of READERS) {
      expect(permissionEffect(rules(id), "edit", ".cad-work/x")).toBe("deny")
      expect(permissionEffect(rules(id), RUN_TOOL)).toBe("deny")
      expect(permissionEffect(rules(id), "shell")).toBe("deny")
      expect(permissionEffect(rules(id), "read", "hw/parts/LMP-0001/part.yaml")).toBe("allow")
      expect(permissionEffect(rules(id), "webfetch")).toBe(id === "cad-sourcing-researcher" ? "allow" : "deny")
    }
  })

  test("every agent loads cad skills and reads the installed skills without a prompt, other paths ask", () => {
    for (const id of [...READERS, ...WRITERS]) {
      expect(permissionEffect(rules(id), "skill", "cad-record")).toBe("allow")
      expect(permissionEffect(rules(id), "skill", "design-guide")).toBe("deny")
      expect(permissionEffect(rules(id), "external_directory", join(SKILLS_DIR, "cad-record", "references", "*"))).toBe("allow")
      expect(permissionEffect(rules(id), "external_directory", "/etc/*")).toBe("ask")
    }
  })
})

describe(SETUP_TOOL, () => {
  test("asks for the session directory and copies the formulas there", async () => {
    const { fake, instance, tool, directory } = harness()
    mkdirSync(join(directory, ".beads"))
    const cleanup = await instance.setup(fake.context)
    const result = await tool(SETUP_TOOL)({}, call("ses_root"))
    expect(result.metadata).toMatchObject({ ok: true, copied: [...FORMULAS] })
    expect(fake.asserts.map(({ action, resources }) => ({ action, resources }))).toEqual([
      { action: SETUP_TOOL, resources: [directory] },
    ])
    expect(readdirSync(join(directory, ".beads", "formulas")).length).toBe(FORMULAS.length)
    expect(result.content).toContain("bd mol pour cad-part")
    await cleanup?.()
  })
})

describe(RUN_TOOL, () => {
  test("runs the script through run.py from the session directory, keyed to the root session", async () => {
    const { fake, instance, runs, tool, directory } = harness()
    const cleanup = await instance.setup(fake.context)
    const result = await tool(RUN_TOOL)(
      { script: "cad-flow/scripts/preflight.py", args: ["--json"] },
      call("ses_child"),
    )
    expect(result.metadata).toMatchObject({ ok: true, exitCode: 0, script: "cad-flow/scripts/preflight.py" })
    expect(result.content).toContain('{"ok": true}')
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run?.argv).toEqual([
      "uv",
      "run",
      "--script",
      join(SKILLS_DIR, "cad-flow", "scripts", "run.py"),
      "cad-flow/scripts/preflight.py",
      "--json",
    ])
    expect(run?.cwd).toBe(directory)
    expect(run?.env.CAD_SESSION_ID).toBe("ses_root")
    expect(run?.env.CAD_OPENCODE_PLUGIN).toStartWith(`${PLUGIN_ID} `)
    expect(fake.asserts.map(({ action, resources }) => ({ action, resources }))).toEqual([
      { action: RUN_TOOL, resources: ["cad-flow/scripts/preflight.py"] },
    ])
    await cleanup?.()
  })

  test("refuses a script outside the skills before asking or spawning", async () => {
    const { fake, instance, runs, tool } = harness()
    const cleanup = await instance.setup(fake.context)
    for (const script of ["../package.json", "/etc/passwd", "cad-flow/SKILL.md", "cad-flow/scripts/missing.py"]) {
      const result = await tool(RUN_TOOL)({ script }, call("ses_root"))
      expect(result.metadata.ok).toBe(false)
    }
    expect((await tool(RUN_TOOL)({ script: "cad-flow/scripts/run.py", args: [1] }, call("ses_root"))).content).toContain(
      "args must be an array of strings",
    )
    expect(runs).toEqual([])
    expect(fake.asserts).toEqual([])
    await cleanup?.()
  })

  test("a rejected permission stops the run", async () => {
    const directory = temp("cad-project-")
    const fake = createFakeContext({
      directory,
      sessions: [{ id: "ses_root", location: { directory } }],
      assert: () => {
        throw new Error("rejected")
      },
    })
    const runs: string[][] = []
    const cleanup = await createPlugin({
      exec: async (argv) => {
        runs.push(argv)
        return exited()
      },
    }).setup(fake.context)
    const execute = fake.tools.get(RUN_TOOL)?.execute as Execute
    await expect(execute({ script: "cad-flow/scripts/preflight.py" }, call("ses_root"))).rejects.toThrow("rejected")
    expect(runs).toEqual([])
    await cleanup?.()
  })
})

describe("session cleanup", () => {
  test("deleting the root session stops its viewer hosts with their --session, and only those", async () => {
    const { fake, instance, runs, tool, directory, settle } = harness()
    const cleanup = await instance.setup(fake.context)
    const viewer = "cad-viewer/scripts/viewer.py"
    await tool(RUN_TOOL)({ script: viewer, args: ["serve"] }, call("ses_root"))
    await tool(RUN_TOOL)({ script: viewer, args: ["serve", "--session", "review"] }, call("ses_child"))
    await tool(RUN_TOOL)({ script: viewer, args: ["serve", "--session", "gone"] }, call("ses_root"))
    await tool(RUN_TOOL)({ script: viewer, args: ["stop", "--session", "gone"] }, call("ses_root"))
    runs.length = 0
    fake.emit({ type: "session.deleted", data: { sessionID: "ses_child" } })
    await settle(1)
    expect(runs).toEqual([])
    fake.emit({ type: "session.deleted", data: { sessionID: "ses_root" } })
    await settle(2)
    expect(runs.map(({ argv }) => argv.slice(4)).sort()).toEqual([
      [viewer, "stop"],
      [viewer, "stop", "--session", "review"],
    ])
    for (const run of runs) {
      expect(run.cwd).toBe(directory)
      expect(run.env.CAD_SESSION_ID).toBe("ses_root")
    }
    await cleanup?.()
    expect(runs).toHaveLength(2)
  })

  /** Background starts that print a URL, signals sent through process.kill, and each child's exit. */
  function backgroundHarness() {
    const live = new Set<number>()
    const exits = new Map<number, () => void>()
    const killed: number[] = []
    let nextPid = 900_000
    const setup = harness({
      start: (_argv, { stdout }) => {
        writeFileSync(stdout, '{"url": "http://127.0.0.1:5173/"}\n')
        const pid = nextPid++
        live.add(pid)
        let exit = () => {}
        const exited = new Promise<void>((resolve) => {
          exit = resolve
        })
        exits.set(pid, exit)
        return { pid, exited, kill: () => killed.push(-1) }
      },
      alive: (pid) => live.has(pid),
      stopGraceMs: 0,
    })
    const realKill = process.kill
    process.kill = ((pid: number, signal?: string | number) => {
      const target = Math.abs(pid)
      if (signal === 0) return live.has(target)
      if (!live.has(target)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
      killed.push(pid)
      live.delete(target)
      return true
    }) as typeof process.kill
    return { ...setup, live, exits, killed, restore: () => (process.kill = realKill) }
  }
  const serve = { script: "cad-concept/scripts/serve.py", args: ["--scene-dir", "hw/concept"], background: true }

  test("a background script reports its first line, stops by pid, and is stopped on dispose", async () => {
    const { fake, instance, tool, killed, restore } = backgroundHarness()
    try {
      const cleanup = await instance.setup(fake.context)
      const first = await tool(RUN_TOOL)(serve, call("ses_root"))
      expect(first.metadata).toMatchObject({ ok: true, pid: 900_000 })
      expect(first.content).toContain('{"url": "http://127.0.0.1:5173/"}')
      expect(existsSync(first.metadata.stdout as string)).toBe(true)
      expect((await tool(STOP_TOOL)({ pid: 900_000 }, call("ses_child"))).metadata).toMatchObject({ ok: true, state: "stopped" })
      expect((await tool(STOP_TOOL)({ pid: 900_000 }, call("ses_root"))).metadata.ok).toBe(false)
      await tool(RUN_TOOL)(serve, call("ses_root"))
      await cleanup?.()
      // Each job's process group gets one SIGTERM, which ends it.
      expect(killed).toEqual([-900_000, -900_001])
    } finally {
      restore()
    }
  })

  test("a background script that exits on its own is forgotten, so its reused pid is never signalled", async () => {
    const { fake, instance, tool, exits, killed, settle, restore } = backgroundHarness()
    try {
      const cleanup = await instance.setup(fake.context)
      await tool(RUN_TOOL)(serve, call("ses_root"))
      // serve.py's idle timeout ends it; its pid now belongs to an unrelated process.
      exits.get(900_000)?.()
      await Bun.sleep(0)
      expect((await tool(STOP_TOOL)({ pid: 900_000 }, call("ses_root"))).metadata.ok).toBe(false)
      fake.emit({ type: "session.deleted", data: { sessionID: "ses_root" } })
      await settle(1)
      await cleanup?.()
      expect(killed).toEqual([])
    } finally {
      restore()
    }
  })
})
