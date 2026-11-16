import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import {
  ANALYZE_REDIRECT,
  createPlugin,
  DENY_REASON,
  IMPLEMENT_REDIRECT,
  parseOptions,
  TASKSTOISSUES_REFUSAL,
  wantsSpecAgent,
} from "./index.ts"

type Fake = ReturnType<typeof createFakeContext>

async function start(
  options: {
    beads?: boolean
    directory?: string
    project?: string
    plugin?: Record<string, unknown>
    skills?: { id: string; content: string }[]
  } = {},
) {
  const directory = options.directory ?? "/repo"
  const probes: string[] = []
  const fake = createFakeContext({
    directory,
    options: options.plugin ?? {},
    sessions: [{ id: "ses_main", location: { directory } }],
    skills: options.skills ?? [],
  })
  if (options.project !== undefined)
    (fake.context.location as { project?: { directory: string } }).project = { directory: options.project }
  const plugin = createPlugin({
    probe: async (dir) => {
      probes.push(dir)
      return options.beads ?? true
    },
  })
  const cleanup = await plugin.setup(fake.context as never)
  return { fake, cleanup: cleanup as () => Promise<void>, probes }
}

const before = (fake: Fake, tool: string, input: unknown) =>
  fake.fire.tool("execute.before", {
    tool,
    sessionID: "ses_main",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input,
  })

describe("setup", () => {
  test("registers the tools, hooks, skills and agents, and disposes all of them", async () => {
    const { fake, cleanup } = await start()
    expect([...fake.tools.keys()].sort()).toEqual(["speckit_commit", "speckit_setup", "speckit_start"])
    expect(fake.hooks("tool")).toEqual(["execute.before"])
    expect(fake.hooks("session")).toEqual(["context", "compaction", "generate"])
    expect([...fake.skills.keys()].sort()).toEqual(["speckit-bugfix", "speckit-setup"])
    expect(fake.agents.get("speckit-verify")).toMatchObject({
      mode: "subagent",
      request: { headers: { "x-opencode-model-role": "reviewer" } },
    })
    expect(fake.agents.get("speckit-verify")?.model).toBeUndefined()
    await cleanup()
    expect(fake.hooks("tool")).toEqual([])
    expect(fake.hooks("session")).toEqual([])
    expect(fake.active()).toBe(0)
  })

  test("options switch each part off", async () => {
    const { fake, cleanup } = await start({
      plugin: {
        tasksGuard: false,
        blockTasksToIssues: false,
        implementRedirect: false,
        workflow: false,
        agents: false,
      },
    })
    expect(fake.hooks("tool")).toEqual([])
    expect(fake.hooks("session")).toEqual([])
    expect(fake.agents.has("speckit-sync")).toBe(false)
    await cleanup()
  })

  test("parseOptions defaults the integration to codex and keeps a configured one", () => {
    expect(parseOptions(undefined).integration).toBe("codex")
    expect(parseOptions({ integration: "claude" }).integration).toBe("claude")
  })

  test("the setup tool advertises the configured integration", async () => {
    const { fake, cleanup } = await start({ plugin: { integration: "claude" } })
    const input = fake.tools.get("speckit_setup")?.input as { properties: { integration: { description: string } } }
    expect(input.properties.integration.description).toContain("default claude")
    await cleanup()
  })
})

describe("tasks.md guard", () => {
  test("refuses write, edit, patch and shell writes in the session's directory", async () => {
    const { fake, cleanup, probes } = await start()
    await expect(before(fake, "write", { path: "specs/001-a/tasks.md", content: "" })).rejects.toThrow(DENY_REASON)
    await expect(
      before(fake, "edit", { path: "/repo/specs/001-a/tasks.md", oldString: "a", newString: "b" }),
    ).rejects.toThrow(DENY_REASON)
    await expect(
      before(fake, "patch", { patchText: "*** Begin Patch\n*** Add File: specs/001-a/tasks.md\n+x\n*** End Patch" }),
    ).rejects.toThrow(DENY_REASON)
    await expect(before(fake, "shell", { command: "echo x >> specs/001-a/tasks.md", workdir: "/wt" })).rejects.toThrow(
      DENY_REASON,
    )
    expect(probes.slice(1)).toEqual(["/repo", "/repo", "/repo", "/wt"])
    await before(fake, "shell", { command: "cat specs/001-a/tasks.md" })
    await before(fake, "write", { path: "specs/001-a/spec.md", content: "" })
    await cleanup()
  })

  test("allows tasks.md where no beads workspace is active", async () => {
    const { fake, cleanup } = await start({ beads: false })
    await before(fake, "write", { path: "specs/001-a/tasks.md", content: "" })
    await cleanup()
  })
})

describe("skill routing", () => {
  const upstream = [
    { id: "speckit-implement", content: "Execute tasks.md" },
    { id: "speckit-taskstoissues", content: "Create GitHub issues" },
    { id: "speckit-plan", content: "Plan" },
    { id: "speckit-analyze", content: "Analyze" },
  ]

  test("redirects implement and refuses taskstoissues where beads is active", async () => {
    const { fake, cleanup } = await start({ skills: upstream })
    expect(fake.skills.get("speckit-implement")?.content).toBe(IMPLEMENT_REDIRECT)
    expect(fake.skills.get("speckit-taskstoissues")?.content).toContain(TASKSTOISSUES_REFUSAL)
    expect(fake.skills.get("speckit-plan")?.content).toBe("Plan")
    expect(fake.skills.get("speckit-analyze")?.content).toBe(`${ANALYZE_REDIRECT}\nAnalyze`)
    await expect(before(fake, "skill", { id: "speckit-taskstoissues" })).rejects.toThrow(TASKSTOISSUES_REFUSAL)
    await before(fake, "skill", { id: "speckit-plan" })
    await cleanup()
  })

  test("re-registers when a project skill loads after the plugin", async () => {
    const { fake, cleanup } = await start()
    fake.skills.set("speckit-implement", { id: "speckit-implement", content: "Execute tasks.md" })
    fake.emit({ type: "skill.updated", data: {} })
    for (let i = 0; i < 20 && fake.skills.get("speckit-implement")?.content !== IMPLEMENT_REDIRECT; i++)
      await Bun.sleep(5)
    expect(fake.skills.get("speckit-implement")?.content).toBe(IMPLEMENT_REDIRECT)
    await cleanup()
  })

  test("leaves the upstream skills alone without beads", async () => {
    const { fake, cleanup } = await start({ beads: false, skills: upstream })
    expect(fake.skills.get("speckit-implement")?.content).toBe("Execute tasks.md")
    await before(fake, "skill", { id: "speckit-taskstoissues" })
    await cleanup()
  })
})

describe("workflow context", () => {
  test("a session's first request decides the workflow text, for every request of the session", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "speckit-ctx-")))
    try {
      const { fake, cleanup } = await start({ directory: dir })
      const request = (sessionID: string) => ({ sessionID, agent: "build", system: [] as { text: string }[] })
      expect((await fake.fire.session("context", request("ses_plain"))).system).toEqual([])
      mkdirSync(join(dir, ".specify"))
      // A session that started without SpecKit keeps its system prompt.
      expect((await fake.fire.session("context", request("ses_plain"))).system).toEqual([])
      const first = await fake.fire.session("context", request("ses_main"))
      expect(first.system).toHaveLength(1)
      expect(first.system[0]?.text).toContain("SpecKit workflow")
      rmSync(join(dir, ".specify"), { recursive: true })
      expect((await fake.fire.session("context", request("ses_main"))).system).toEqual(first.system)
      await cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("spec agent registration", () => {
  const withDir = async (run: (dir: string) => Promise<void>) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "speckit-agent-")))
    try {
      await run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("registers the primary spec agent where the location holds .specify/", () =>
    withDir(async (dir) => {
      mkdirSync(join(dir, ".specify"))
      const { fake, cleanup } = await start({ directory: dir })
      expect(fake.agents.get("spec")).toMatchObject({
        mode: "primary",
        hidden: false,
        request: { headers: { "x-opencode-model-role": "strong" } },
      })
      expect(fake.agents.get("spec")?.model).toBeUndefined()
      expect(fake.agents.has("speckit-verify")).toBe(true)
      await cleanup()
      expect(fake.active()).toBe(0)
    }))

  test("skips the spec agent in a plain repository but keeps the subagents", () =>
    withDir(async (dir) => {
      const { fake, cleanup } = await start({ directory: dir })
      expect(fake.agents.has("spec")).toBe(false)
      expect(fake.agents.has("speckit-verify")).toBe(true)
      await cleanup()
    }))

  test("specAgent true registers it anywhere and false never; agents false keeps it", async () => {
    const always = await start({ plugin: { specAgent: true, agents: false } })
    expect(always.fake.agents.has("spec")).toBe(true)
    expect(always.fake.agents.has("speckit-verify")).toBe(false)
    await always.cleanup()
    await withDir(async (dir) => {
      mkdirSync(join(dir, ".specify"))
      const never = await start({ directory: dir, plugin: { specAgent: false } })
      expect(never.fake.agents.has("spec")).toBe(false)
      await never.cleanup()
    })
  })

  test("speckit_setup at the location registers it once .specify/ exists", () =>
    withDir(async (dir) => {
      const { fake, cleanup } = await start({ directory: dir })
      expect(fake.agents.has("spec")).toBe(false)
      mkdirSync(join(dir, ".specify"))
      const execute = fake.tools.get("speckit_setup")?.execute as (input: unknown, ctx: unknown) => Promise<unknown>
      const context = { sessionID: "ses_main", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }
      await execute({ skipSpecify: true, skipBeads: true }, context)
      expect(fake.agents.get("spec")).toMatchObject({ mode: "primary" })
      await execute({ skipSpecify: true, skipBeads: true }, context)
      await cleanup()
      expect(fake.active()).toBe(0)
    }))
})

describe("nested location inside a SpecKit project root", () => {
  const git = (cwd: string, ...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
    return proc.stdout.toString().trim()
  }
  const nested = async (run: (root: string, sub: string) => Promise<void>) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "speckit-nested-")))
    const sub = join(root, "packages", "app")
    try {
      for (const path of [sub, join(root, ".specify"), join(root, ".beads"), join(root, "specs", "001-a")])
        mkdirSync(path, { recursive: true })
      await run(root, sub)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const context = { sessionID: "ses_main", agent: "spec", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }

  test("registers the spec agent and gives the session the workflow text", () =>
    nested(async (root, sub) => {
      const { fake, cleanup } = await start({ directory: sub, project: root })
      expect(fake.agents.has("spec")).toBe(true)
      const request = { sessionID: "ses_main", agent: "build", system: [] as { text: string }[] }
      expect((await fake.fire.session("context", request)).system[0]?.text).toContain("SpecKit workflow")
      await cleanup()
    }))

  test("tools default to the project root's SpecKit workspace", () =>
    nested(async (root, sub) => {
      git(root, "init", "-q", "-b", "main")
      git(root, "config", "user.name", "Test")
      git(root, "config", "user.email", "test@example.com")
      git(root, "config", "commit.gpgsign", "false")
      git(root, "config", "core.hooksPath", "/dev/null")
      writeFileSync(join(root, "specs", "001-a", "spec.md"), "x\n")
      const { fake, cleanup } = await start({ directory: sub, project: root })
      const execute = fake.tools.get("speckit_commit")?.execute as (input: unknown, ctx: unknown) => Promise<{ metadata: { ok: boolean } }>
      const result = await execute({ message: "docs(spec): 001-a", paths: ["specs/001-a"] }, context)
      expect(result.metadata.ok).toBe(true)
      expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe("specs/001-a/spec.md")
      await cleanup()
    }), 30_000) // several real git processes, slow on a loaded machine
})

describe("an explicit workspace input resolves against the session directory", () => {
  // outer/repo holds SpecKit; the session runs in outer/repo/pkg and names ".." (outer/repo).
  const layout = async (run: (outer: string, repo: string, pkg: string) => Promise<void>) => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "speckit-explicit-")))
    const repo = join(outer, "repo")
    const pkg = join(repo, "pkg")
    try {
      for (const path of [pkg, join(repo, ".specify"), join(repo, ".beads")]) mkdirSync(path, { recursive: true })
      await run(outer, repo, pkg)
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  }
  const context = { sessionID: "ses_main", agent: "spec", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }
  type Execute = (input: unknown, ctx: unknown) => Promise<{ content: string }>

  test("speckit_setup", () =>
    layout(async (outer, repo, pkg) => {
      const { fake, cleanup } = await start({ directory: pkg, project: repo })
      const execute = fake.tools.get("speckit_setup")?.execute as Execute
      await execute({ workspace: "..", skipSpecify: true, skipBeads: true }, context)
      expect(existsSync(join(repo, ".gitignore"))).toBe(true)
      expect(existsSync(join(outer, ".gitignore"))).toBe(false)
      await cleanup()
    }))

  test("speckit_start", () =>
    layout(async (_outer, repo, pkg) => {
      const { fake, cleanup } = await start({ directory: pkg, project: repo })
      const execute = fake.tools.get("speckit_start")?.execute as Execute
      // outer/repo/.beads exists, so the start gets past the lookup that outer/.beads would fail.
      const result = await execute({ spec: "001-a", workspace: ".." }, context)
      expect(result.content).toContain("Canonical embedded store unavailable")
      await cleanup()
    }))
})

describe("wantsSpecAgent", () => {
  test("auto checks the location, then the project root", () => {
    const has = (dir: string) => dir === "/root"
    expect(wantsSpecAgent("auto", ["/root/sub", "/root"], has)).toBe(true)
    expect(wantsSpecAgent("auto", ["/elsewhere"], has)).toBe(false)
    // A location outside its project root (a separate worktree) does not borrow the root's workspace.
    expect(wantsSpecAgent("auto", ["/elsewhere", "/root"], has)).toBe(false)
    // A child whose name starts with ".." is inside the root, not a traversal out of it.
    expect(wantsSpecAgent("auto", ["/root/..cache", "/root"], has)).toBe(true)
    expect(wantsSpecAgent("auto", ["/root/../other", "/root"], has)).toBe(false)
    expect(wantsSpecAgent(true, ["/elsewhere"], has)).toBe(true)
    expect(wantsSpecAgent(false, ["/root"], has)).toBe(false)
  })
})

describe("a stop through the tool call's signal", () => {
  /** A `specify` that records its pid and then waits; only a kill ends it. */
  const blockingSpecify = async (run: (dir: string, pidFile: string) => Promise<void>) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "speckit-stop-")))
    const bin = join(dir, "bin")
    mkdirSync(bin)
    const pidFile = join(dir, "specify.pid")
    writeFileSync(join(bin, "specify"), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`)
    chmodSync(join(bin, "specify"), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      await run(dir, pidFile)
    } finally {
      process.env.PATH = path
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("aborting speckit_setup kills the command it started and reports it stopped", () =>
    blockingSpecify(async (dir, pidFile) => {
      const { fake, cleanup } = await start({ directory: dir })
      const execute = fake.tools.get("speckit_setup")?.execute as (
        input: unknown,
        ctx: unknown,
      ) => Promise<{ content: string }>
      const controller = new AbortController()
      const context = { sessionID: "ses_main", agent: "build", messageID: "msg_1", id: "call_1", signal: controller.signal }
      const running = execute({ skipBeads: true }, context)
      while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") await Bun.sleep(10)
      const pid = Number(readFileSync(pidFile, "utf8").trim())
      controller.abort()
      const result = await running
      expect(result.content).toContain("stopped by the tool call")
      for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(20)
      expect(alive(pid)).toBe(false)
      await cleanup()
    }), 15_000)
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
