// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures exercise literal Claude placeholders.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { CHECK_TOOL, setupClaudeCompat } from "./index.ts"
import { cachedProjects } from "./load.ts"

const MARKETPLACE = realpathSync(join(import.meta.dir, "..", "fixtures", "marketplace"))
const DEMO = join(MARKETPLACE, "plugins", "demo")
const scratch: string[] = []
const warnings: string[] = []
const deps = { warn: (line: string) => void warnings.push(line), env: { PATH: process.env.PATH } }

function project(config?: unknown): string {
  const base = join(tmpdir(), "opencode")
  mkdirSync(base, { recursive: true })
  const dir = realpathSync(mkdtempSync(join(base, "claude-compat-test-")))
  scratch.push(dir)
  if (config !== undefined) {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "claude-compat.json"), JSON.stringify(config))
  }
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  warnings.length = 0
})

const fakeFor = (directory: string, options: Record<string, unknown>, extra: Parameters<typeof createFakeContext>[0] = {}) =>
  createFakeContext({ directory, options: { enabled: true, ...options }, sessions: [{ id: "ses_a", location: { directory } }], ...extra })

async function check(fake: ReturnType<typeof createFakeContext>) {
  const tool = fake.tools.get(CHECK_TOOL) as unknown as { execute: (input: unknown) => Promise<{ content: string }> }
  return JSON.parse((await tool.execute({})).content) as { plugins: string[]; loaded: Record<string, string[]>; diagnostics: { where: string; message: string }[] }
}

test("loads a marketplace from plugin options: skills, new agents, commands, MCP and hooks; cleanup disposes all", async () => {
  const dir = project()
  const fake = fakeFor(dir, { sources: [{ path: MARKETPLACE }] })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  expect([...fake.skills.keys()].sort()).toEqual(["demo-helper", "other-skill"])
  expect(fake.skills.get("demo-helper")?.path).toBe(join(DEMO, "skills/demo-helper/SKILL.md"))
  expect(fake.skills.get("demo-helper")?.content).toContain(`${DEMO}/mcp/echo.mjs`)

  expect([...fake.agents.keys()].sort()).toEqual(["demo:open", "demo:pinned", "demo:reader"])
  const reader = fake.agents.get("demo:reader") as unknown as { mode: string; permissions: never[]; request: unknown; system: string }
  expect(reader.mode).toBe("subagent")
  expect(reader.request).toEqual({ headers: { "x-opencode-model-role": "cheap" } })
  expect(permissionEffect(reader.permissions, "read")).toBe("allow")
  expect(permissionEffect(reader.permissions, "shell")).toBe("deny")
  expect(reader.system).toContain("Bash→shell")
  expect((fake.agents.get("demo:open") as unknown as { permissions: unknown[] }).permissions).toEqual([])

  expect([...fake.commands.keys()].sort()).toEqual(["demo:greet", "demo:sub:deep"])
  await fake.commands.get("demo:greet")?.execute({ sessionID: "ses_a", prompt: { text: "Ada Lovelace" }, delivery: "queue" } as never)
  expect(fake.calls.at(-1)).toEqual({
    method: "session.prompt",
    input: { sessionID: "ses_a", text: `Greet Ada warmly. All arguments: Ada Lovelace. Plugin root: ${DEMO}\n`, delivery: "queue" },
  })

  expect(fake.mcp.get("echo")).toEqual({ type: "local", command: ["node", `${DEMO}/mcp/echo.mjs`], codemode: true })
  expect(fake.mcp.get("docs")).toEqual({ type: "remote", url: "https://example.invalid/mcp", codemode: true })
  expect(fake.hooks("tool")).toEqual(["execute.before", "execute.after"])

  const report = await check(fake)
  expect(report.plugins).toEqual(["demo", "other"])
  expect(report.loaded.hooks).toEqual(["demo:PreToolUse(Bash)", "demo:PostToolUse(Read)", "demo:SessionStart(startup)"])
  const messages = report.diagnostics.map((issue) => issue.message)
  expect(messages).toContain("Unsupported hook event UserPromptSubmit; not run")
  expect(messages).toContain("Unknown Claude tool: TodoWrite; dropped")
  expect(messages).toContain("Plugin CLAUDE.md not included (instructions: false)")
  expect(messages.some((message) => message.includes("only named local marketplace sources"))).toBe(true)
  expect(warnings).toEqual([`srobroek.claude-compat: demo: PreToolUse: unsupported hook type agent; not run; Unsupported hook event UserPromptSubmit; not run`])

  await cleanup()
  expect(fake.active()).toBe(0)
  expect(fake.skills.size + fake.commands.size + fake.mcp.size + fake.tools.size).toBe(0)
  expect(cachedProjects()).not.toContain(dir)
})

test("a PreToolUse hook blocks a matching shell call with exit 2 and lets others through", async () => {
  const dir = project()
  const fake = fakeFor(dir, { sources: [{ path: MARKETPLACE }], plugins: ["demo"], mcp: "off" })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  const call = (command: string) => ({ tool: "shell", sessionID: "ses_a", agent: "build", messageID: "msg_1", id: "call_1", input: { command } })
  await expect(fake.fire.tool("execute.before", call("echo forbidden-fixture-word"))).rejects.toThrow(
    "Blocked by the demo PreToolUse hook: fixture guard: forbidden-fixture-word is not allowed",
  )
  await expect(fake.fire.tool("execute.before", call("echo fine"))).resolves.toBeDefined()
  // Edit|Write only has an unsupported agent hook; nothing runs for it.
  await expect(fake.fire.tool("execute.before", { ...call(""), tool: "write", input: { path: "/x" } })).resolves.toBeDefined()
  await cleanup()
})

test("a PostToolUse hook appends its additionalContext to the tool result", async () => {
  const dir = project()
  const fake = fakeFor(dir, { sources: [{ path: MARKETPLACE }], plugins: ["demo"], mcp: "off" })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  const event = { tool: "read", sessionID: "ses_a", agent: "build", messageID: "m", id: "c", input: { path: "/etc/hosts" }, status: "completed", result: { content: "hosts" } }
  const after = await fake.fire.tool("execute.after", event)
  expect(after.result.content).toBe("hosts\n[demo PostToolUse hook] fixture after-read saw /etc/hosts")
  await cleanup()
})

test("a SessionStart hook adds a synthetic message to a new top-level session of this project only", async () => {
  const dir = project()
  const fake = fakeFor(dir, { sources: [{ path: MARKETPLACE }], plugins: ["demo"], mcp: "off" })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  fake.emit({ type: "session.created", data: { sessionID: "ses_child", parentID: "ses_a", location: { directory: dir } } })
  fake.emit({ type: "session.created", data: { sessionID: "ses_other", location: { directory: "/elsewhere" } } })
  fake.emit({ type: "session.created", data: { sessionID: "ses_a", location: { directory: dir } } })
  for (let i = 0; i < 100 && !fake.calls.some((c) => c.method === "session.synthetic"); i++) await Bun.sleep(20)
  const synthetic = fake.calls.filter((c) => c.method === "session.synthetic")
  expect(synthetic).toHaveLength(1)
  expect(synthetic[0]?.input).toMatchObject({ sessionID: "ses_a", text: `Session context from the Claude plugin demo (SessionStart hook):\nFixture session context from ${dir}`, delivery: "steer", resume: false })
  await cleanup()
  expect(fake.active()).toBe(0)
})

test("the first prompt of a new session waits for SessionStart; old sessions and later prompts do not run it", async () => {
  const dir = project()
  const now = Date.now()
  const fake = createFakeContext({
    directory: dir,
    options: { enabled: true, sources: [{ path: MARKETPLACE }], plugins: ["demo"], mcp: "off" },
    sessions: [
      { id: "ses_new", location: { directory: dir }, time: { created: now + 60_000 } },
      { id: "ses_old", location: { directory: dir }, time: { created: now - 60_000 } },
    ],
  })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  await fake.fire.session("prompt", { sessionID: "ses_new" })
  const synthetic = () => fake.calls.filter((c) => c.method === "session.synthetic")
  expect(synthetic().map((c) => (c.input as { sessionID: string }).sessionID)).toEqual(["ses_new"])
  await fake.fire.session("prompt", { sessionID: "ses_new" })
  await fake.fire.session("prompt", { sessionID: "ses_old" })
  expect(synthetic()).toHaveLength(1)
  await cleanup()
})

test("two projects are isolated: project A's plugins never appear in project B", async () => {
  const a = project()
  const b = project()
  // One shared (global) options object for both, as a global config entry would give.
  const options = { enabled: true, mcp: "always", projects: { [a]: { sources: [{ path: MARKETPLACE }] } } }
  const fakeA = fakeFor(a, options)
  const fakeB = createFakeContext({ directory: b, options, sessions: [{ id: "ses_b", location: { directory: b } }, { id: "ses_a", location: { directory: a } }] })
  const [cleanupA, cleanupB] = await Promise.all([setupClaudeCompat(fakeA.context, deps), setupClaudeCompat(fakeB.context, deps)])
  expect([...fakeA.skills.keys()].sort()).toEqual(["demo-helper", "other-skill"])
  expect(fakeA.agents.has("demo:reader")).toBe(true)
  expect(fakeA.mcp.has("echo")).toBe(true)
  expect(fakeB.skills.size + fakeB.agents.size + fakeB.commands.size + fakeB.mcp.size).toBe(0)
  expect(fakeB.hooks("tool")).toEqual([])
  expect((await check(fakeB)).plugins).toEqual([])
  expect(cachedProjects()).toContain(a)
  // Even if the host delivered B's tool calls to A's hooks, A only acts for its own sessions.
  const fakeAWithB = fakeFor(a, options, { sessions: [{ id: "ses_b", location: { directory: b } }] })
  const cleanupShared = await setupClaudeCompat(fakeAWithB.context, deps)
  const call = { tool: "shell", sessionID: "ses_b", agent: "build", messageID: "m", id: "c", input: { command: "echo forbidden-fixture-word" } }
  await expect(fakeAWithB.fire.tool("execute.before", call)).resolves.toBeDefined()
  await Promise.all([cleanupA(), cleanupB(), cleanupShared()])
  expect(cachedProjects()).not.toContain(a)
})

test("relative paths resolve against the project root; locations of one project share a bundle until released", async () => {
  const root = project()
  const options = { enabled: true, projects: { [root]: { sources: [{ path: "./vendor/marketplace" }], plugins: ["other"] } } }
  mkdirSync(join(root, "vendor"), { recursive: true })
  const { symlinkSync } = await import("node:fs")
  symlinkSync(MARKETPLACE, join(root, "vendor", "marketplace"))
  const sub = join(root, "packages", "app")
  mkdirSync(sub, { recursive: true })
  const first = createFakeContext({ directory: sub, options })
  ;(first.context.location as unknown as { project: { directory: string } }).project = { directory: root }
  const second = createFakeContext({ directory: root, options })
  const cleanupFirst = await setupClaudeCompat(first.context, deps)
  const cleanupSecond = await setupClaudeCompat(second.context, deps)
  expect(first.skills.has("other-skill")).toBe(true)
  expect(second.skills.has("other-skill")).toBe(true)
  expect(cachedProjects().filter((dir) => dir === root)).toHaveLength(1)
  await cleanupFirst()
  expect(cachedProjects()).toContain(root)
  await cleanupSecond()
  expect(cachedProjects()).not.toContain(root)
})

test("options: instructions add plugin CLAUDE.md; hooks off registers no hooks; untypedAgents deny", async () => {
  const dir = project()
  const fake = fakeFor(dir, { sources: [{ path: MARKETPLACE }], plugins: ["demo"], instructions: true, hooks: false, untypedAgents: "deny", mcp: "off" })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  expect(fake.hooks("tool")).toEqual([])
  expect(fake.hooks("session")).toEqual(["context", "compaction", "generate"])
  const context = await fake.fire.session("context", { sessionID: "ses_a", system: [] as { type: string; text: string }[] })
  expect(context.system[0]?.text).toBe(`Instructions from Claude plugin demo (CLAUDE.md):\nFixture plugin instructions: the demo plugin root is ${DEMO}.`)
  expect(permissionEffect((fake.agents.get("demo:open") as unknown as { permissions: never[] }).permissions, "read")).toBe("deny")
  const messages = (await check(fake)).diagnostics.map((issue) => issue.message)
  expect(messages).toContain("3 hook(s) not run: hooks is off")
  expect(messages).toContain("mcp is off")
  await cleanup()
})

test("user definitions win over plugin ones", async () => {
  const dir = project()
  const fake = fakeFor(dir, { sources: [{ path: MARKETPLACE }], plugins: ["demo"] }, {
    skills: [{ id: "demo-helper", name: "demo-helper", content: "User skill" }],
    agents: [{ id: "demo:reader", system: "User agent", description: "Mine" }],
    mcp: { echo: { type: "local", command: ["user-echo"] } },
    sessions: [{ id: "ses_a", location: { directory: dir } }],
  })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  expect(fake.skills.get("demo-helper")?.content).toBe("User skill")
  expect(fake.agents.get("demo:reader")).toMatchObject({ system: "User agent", description: "Mine" })
  expect(fake.mcp.get("echo")?.command).toEqual(["user-echo"])
  await cleanup()
})

test("the enabled rollout flag defaults off and disabling it loads no capabilities", async () => {
  for (const enabled of [undefined, false]) {
    const fake = createFakeContext({ directory: project(), options: { enabled, sources: [{ path: MARKETPLACE }], projectFile: true } })
    const cleanup = await setupClaudeCompat(fake.context, deps)
    expect(fake.active()).toBe(0)
    expect(fake.skills.size + fake.agents.size + fake.commands.size + fake.tools.size + fake.mcp.size).toBe(0)
    await cleanup()
  }
})

test("malformed options are rejected before anything registers; no sources registers only the check tool", async () => {
  const bad = createFakeContext({ options: { untypedAgents: "all" } })
  await expect(setupClaudeCompat(bad.context, deps)).rejects.toThrow("untypedAgents must be inherit or deny")
  expect(bad.active()).toBe(0)
  const empty = createFakeContext({ directory: project(), options: { enabled: true } })
  const cleanup = await setupClaudeCompat(empty.context, deps)
  expect([...empty.tools.keys()]).toEqual([CHECK_TOOL])
  await cleanup()
  expect(empty.active()).toBe(0)
})
