import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { createPlugin, DENY_REASON, IMPLEMENT_REDIRECT, parseOptions, TASKSTOISSUES_REFUSAL } from "./index.ts"

type Fake = ReturnType<typeof createFakeContext>

async function start(
  options: {
    beads?: boolean
    directory?: string
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
    expect([...fake.tools.keys()].sort()).toEqual(["speckit_setup", "speckit_start"])
    expect(fake.hooks("tool")).toEqual(["execute.before"])
    expect(fake.hooks("session")).toEqual(["context"])
    expect([...fake.skills.keys()].sort()).toEqual(["speckit-bugfix", "speckit-setup"])
    expect(fake.agents.get("speckit-verify")).toMatchObject({
      mode: "subagent",
      request: { headers: { "x-opencode-model-role": "challenger" } },
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
  ]

  test("redirects implement and refuses taskstoissues where beads is active", async () => {
    const { fake, cleanup } = await start({ skills: upstream })
    expect(fake.skills.get("speckit-implement")?.content).toBe(IMPLEMENT_REDIRECT)
    expect(fake.skills.get("speckit-taskstoissues")?.content).toContain(TASKSTOISSUES_REFUSAL)
    expect(fake.skills.get("speckit-plan")?.content).toBe("Plan")
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
  test("adds the workflow text in a SpecKit repository, for every request of the session", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "speckit-ctx-")))
    try {
      const { fake, cleanup } = await start({ directory: dir })
      const request = () => ({ sessionID: "ses_main", agent: "build", system: [] as { text: string }[] })
      expect((await fake.fire.session("context", request())).system).toEqual([])
      mkdirSync(join(dir, ".specify"))
      const first = await fake.fire.session("context", request())
      expect(first.system).toHaveLength(1)
      expect(first.system[0]?.text).toContain("SpecKit workflow")
      rmSync(join(dir, ".specify"), { recursive: true })
      expect((await fake.fire.session("context", request())).system).toEqual(first.system)
      await cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
