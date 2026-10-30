// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures exercise literal Claude placeholders.
// Regressions for the review findings: S1 (project-file trust, hook env), S2 (agent id
// collisions), S4 (symlink containment), P1b (moved sessions), P2a (dispose during a hook)
// and P2b (unsupported SessionStart matchers).
import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { CHECK_TOOL, setupClaudeCompat, TRUST_COMMAND } from "./index.ts"
import { gitCachePath, PROJECT_FILE } from "./source.ts"
import { TRUST_ACTION } from "./trust.ts"

const MARKETPLACE = realpathSync(join(import.meta.dir, "..", "fixtures", "marketplace"))
const scratch: string[] = []
const warnings: string[] = []
const deps = { warn: (line: string) => void warnings.push(line), env: { PATH: process.env.PATH } }

function directory(): string {
  const base = join(tmpdir(), "opencode")
  mkdirSync(base, { recursive: true })
  const dir = realpathSync(mkdtempSync(join(base, "claude-compat-sec-")))
  scratch.push(dir)
  return dir
}

function put(root: string, path: string, content: string) {
  mkdirSync(join(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** A single Claude plugin at `root` with a SessionStart hook running `command`. */
function plugin(root: string, command: string, extra: Record<string, unknown> = {}) {
  put(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "bundled" }))
  put(root, "skills/bundled-skill/SKILL.md", "---\nname: bundled-skill\ndescription: Bundled.\n---\nBody")
  put(root, "agents/helper.md", "---\ndescription: Bundled agent.\ntools: Bash\n---\nRun things.")
  put(root, ".mcp.json", JSON.stringify({ mcpServers: { bundled: { command: "node", args: ["x.js"] } } }))
  put(root, "hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command }] }], ...extra } }))
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  warnings.length = 0
})

async function report(fake: ReturnType<typeof createFakeContext>) {
  const tool = fake.tools.get(CHECK_TOOL) as unknown as { execute: (input: unknown) => Promise<{ content: string }> }
  return JSON.parse((await tool.execute({})).content) as { plugins: string[]; loaded: Record<string, string[]>; diagnostics: { where: string; message: string }[] }
}

const registered = (fake: ReturnType<typeof createFakeContext>) =>
  fake.skills.size + fake.agents.size + fake.mcp.size + fake.hooks("tool").length + fake.hooks("session").length

test("S1: a project file is ignored by default, even when it names a plugin inside the repo", async () => {
  const repo = directory()
  plugin(join(repo, "bundled"), "touch ran")
  put(repo, PROJECT_FILE, JSON.stringify({ sources: [{ path: "./bundled" }] }))
  const fake = createFakeContext({ directory: repo })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  expect(registered(fake)).toBe(0)
  expect(fake.commands.has(TRUST_COMMAND)).toBe(false)
  await cleanup()
})

test("S1: with projectFile, nothing loads before approval; approval is remembered per digest and a change asks again", async () => {
  const repo = directory()
  plugin(join(repo, "bundled"), "echo started")
  put(repo, "bundled/.mcp.json", JSON.stringify({ mcpServers: { bundled: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "${SECRET_TOKEN}" } } } }))
  put(repo, PROJECT_FILE, JSON.stringify({ sources: [{ path: "./bundled" }] }))
  const options = { projectFile: true, mcp: "always" }
  const sessions = [{ id: "ses_a", location: { directory: repo } }]

  // Refused approval: still nothing from the file.
  const refused = createFakeContext({ directory: repo, options, sessions, assert: () => Promise.reject(new Error("rejected")) })
  const cleanupRefused = await setupClaudeCompat(refused.context, deps)
  const evaluation = await refused.fire.permission("evaluate", { action: TRUST_ACTION, effect: "allow" })
  expect(evaluation.effect).toBe("ask")
  expect((await refused.fire.permission("evaluate", { action: TRUST_ACTION, effect: "deny" })).effect).toBe("deny")
  expect(registered(refused)).toBe(0)
  expect((await report(refused)).diagnostics.some((issue) => issue.message.includes("Project file not approved"))).toBe(true)
  expect(warnings.some((line) => line.includes("not approved"))).toBe(true)
  await expect(refused.commands.get(TRUST_COMMAND)?.execute({ sessionID: "ses_a", prompt: { text: "" }, delivery: "queue" } as never)).rejects.toThrow("rejected")
  expect(registered(refused)).toBe(0)
  await cleanupRefused()

  // Approved: the assert names the canonical file and its digest, and the plugin loads.
  const fake = createFakeContext({ directory: repo, options, sessions })
  const cleanup = await setupClaudeCompat(fake.context, { ...deps, env: { ...deps.env, SECRET_TOKEN: "approved-secret" } })
  expect(registered(fake)).toBe(0)
  await fake.commands.get(TRUST_COMMAND)?.execute({ sessionID: "ses_a", prompt: { text: "" }, delivery: "queue" } as never)
  expect(fake.asserts).toHaveLength(1)
  expect(fake.asserts[0]?.action).toBe(TRUST_ACTION)
  expect(fake.asserts[0]?.resources[0]).toMatch(new RegExp(`^${join(repo, PROJECT_FILE)}#sha256:[0-9a-f]{64}$`))
  expect(fake.skills.has("bundled-skill")).toBe(true)
  expect(fake.agents.has("bundled:helper")).toBe(true)
  expect(fake.mcp.has("bundled")).toBe(true)
  expect(fake.mcp.get("bundled")?.headers).toEqual({ Authorization: "approved-secret" })
  await cleanup()
  expect(fake.active()).toBe(0)

  // The same digest loads without asking, from the remembered approval.
  const again = createFakeContext({ directory: repo, options, sessions, storage: Object.fromEntries(fake.storage) })
  const cleanupAgain = await setupClaudeCompat(again.context, deps)
  expect(again.skills.has("bundled-skill")).toBe(true)
  expect(again.commands.has(TRUST_COMMAND)).toBe(false)
  await cleanupAgain()

  // Changing any file of a named source changes the digest: nothing loads until approved again.
  put(repo, "bundled/hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo changed" }] }] } }))
  const changed = createFakeContext({ directory: repo, options, sessions, storage: Object.fromEntries(fake.storage) })
  const cleanupChanged = await setupClaudeCompat(changed.context, deps)
  expect(registered(changed)).toBe(0)
  expect(changed.commands.has(TRUST_COMMAND)).toBe(true)
  await cleanupChanged()

  // The project file's own contents are part of the hash too.
  put(repo, PROJECT_FILE, JSON.stringify({ sources: [{ path: "./bundled" }], plugins: [] }))
  const fileChanged = createFakeContext({ directory: repo, options, sessions, storage: Object.fromEntries(fake.storage) })
  const cleanupFile = await setupClaudeCompat(fileChanged.context, deps)
  expect(fileChanged.commands.has(TRUST_COMMAND)).toBe(true)
  await cleanupFile()
})

test("S1: source changes during the permission prompt invalidate approval", async () => {
  const repo = directory()
  plugin(join(repo, "bundled"), "echo x")
  put(repo, PROJECT_FILE, JSON.stringify({ sources: [{ path: "./bundled" }] }))
  const fake = createFakeContext({ directory: repo, options: { projectFile: true }, assert: () => put(repo, "bundled/new.txt", "changed") })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  await expect(fake.commands.get(TRUST_COMMAND)?.execute({ sessionID: "ses_a" } as never)).rejects.toThrow("changed during approval")
  expect(registered(fake)).toBe(0)
  expect(fake.storage.size).toBe(0)
  await cleanup()
})

test("S1: approving an uncached Git source only downloads it; its contents need approval before activation", async () => {
  const root = directory()
  plugin(root, "echo git-started")
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim()
  git("init", "--quiet")
  git("add", ".")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture")
  const source = { git: root, ref: git("rev-parse", "HEAD") }
  const cacheBefore = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = directory()
  const cache = gitCachePath(source)
  scratch.push(cache)
  const repo = directory()
  put(repo, PROJECT_FILE, JSON.stringify({ sources: [source] }))
  const fake = createFakeContext({
    directory: repo,
    options: { projectFile: true, mcp: "always" },
    sessions: [{ id: "ses_a", location: { directory: repo } }],
  })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  try {
    const approve = () => fake.commands.get(TRUST_COMMAND)?.execute({ sessionID: "ses_a", prompt: { text: "" }, delivery: "queue" } as never)
    await approve()
    expect(registered(fake)).toBe(0)
    expect((await report(fake)).diagnostics.some((issue) => issue.message.includes("not approved"))).toBe(true)
    expect(fake.asserts).toHaveLength(1)
    await approve()
    expect(fake.asserts).toHaveLength(2)
    expect(fake.asserts[1]?.resources).not.toEqual(fake.asserts[0]?.resources)
    expect(fake.skills.has("bundled-skill")).toBe(true)
    expect(fake.agents.has("bundled:helper")).toBe(true)
    expect(fake.mcp.has("bundled")).toBe(true)
  } finally {
    await cleanup()
    if (cacheBefore === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = cacheBefore
  }
})

test("S1: hooks get only the allowlisted environment plus the env option's names", async () => {
  const root = directory()
  plugin(root, 'echo "secret=${SECRET_TOKEN:-none} extra=${EXTRA_OK:-none} root=$CLAUDE_PLUGIN_ROOT project=$CLAUDE_PROJECT_DIR"')
  const project = directory()
  const fake = createFakeContext({
    directory: project,
    options: { sources: [{ path: root }], env: ["EXTRA_OK"], mcp: "off" },
    sessions: [{ id: "ses_new", location: { directory: project } }],
  })
  const env = { PATH: process.env.PATH, SECRET_TOKEN: "s3cr3t", EXTRA_OK: "yes" }
  const cleanup = await setupClaudeCompat(fake.context, { ...deps, env })
  await fake.fire.session("prompt", { sessionID: "ses_new" })
  const synthetic = fake.calls.find((call) => call.method === "session.synthetic")
  if (!synthetic) throw new Error("SessionStart context missing")
  const text = (synthetic.input as { text: string }).text
  expect(text).toEndWith(`secret=none extra=yes root=${root} project=${project}`)
  await cleanup()
})

test("S2: an imported agent whose id already exists is refused and reported, not merged", async () => {
  const project = directory()
  const fake = createFakeContext({
    directory: project,
    options: { sources: [{ path: MARKETPLACE }], plugins: ["demo"], mcp: "off", hooks: false },
    agents: [{ id: "demo:reader", system: "Mine", permissions: [{ action: "*", resource: "*", effect: "ask" }] }],
  })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  expect(fake.agents.get("demo:reader")).toEqual({ id: "demo:reader", system: "Mine", permissions: [{ action: "*", resource: "*", effect: "ask" }] })
  const result = await report(fake)
  expect(result.loaded.agents).toEqual(["demo:open", "demo:pinned"])
  expect(result.diagnostics).toContainEqual({ where: "demo:reader", message: "An agent with this id already exists; the imported agent is not registered" })
  await cleanup()
})

test("S2: newly registered agents inherit the native build agent's configured user/global policy", async () => {
  const project = directory()
  const fake = createFakeContext({
    directory: project,
    options: { sources: [{ path: MARKETPLACE }], plugins: ["demo"], mcp: "off", hooks: false },
    agents: [{ id: "build", permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "read", resource: "*notes.txt", effect: "deny" },
      { action: "grep", resource: "*", effect: "ask" },
    ] }],
  })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  expect((await fake.fire.permission("evaluate", { agent: "demo:reader", action: "read", resources: ["/p/notes.txt"], effect: "allow" })).effect).toBe("deny")
  expect((await fake.fire.permission("evaluate", { agent: "demo:reader", action: "grep", resources: ["x"], effect: "allow" })).effect).toBe("ask")
  expect((await fake.fire.permission("evaluate", { agent: "demo:reader", action: "shell", resources: ["ls"], effect: "allow" })).effect).toBe("deny")
  await cleanup()
})

test("S4: default component directories, skill leaves, agent files and CLAUDE.md may not link outside the plugin", async () => {
  const outside = directory()
  put(outside, "stolen/SKILL.md", "---\nname: stolen\ndescription: Outside.\n---\nOutside")
  put(outside, "agents/evil.md", "---\ndescription: Outside.\n---\nOutside")
  put(outside, "CLAUDE.md", "Outside instructions")
  put(outside, ".mcp.json", '{"mcpServers":{"evil":{"command":"evil"}}}')
  put(outside, "hooks.json", '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"evil"}]}]}}')
  const root = directory()
  put(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "linky" }))
  mkdirSync(join(root, "skills"))
  symlinkSync(join(outside, "stolen"), join(root, "skills", "stolen"))
  mkdirSync(join(root, "skills", "leaf"))
  symlinkSync(join(outside, "stolen", "SKILL.md"), join(root, "skills", "leaf", "SKILL.md"))
  symlinkSync(join(outside, "agents"), join(root, "agents"))
  put(root, "commands/ok.md", "---\ndescription: Inside.\n---\nInside")
  symlinkSync(join(outside, "agents", "evil.md"), join(root, "commands", "evil.md"))
  symlinkSync(join(outside, "CLAUDE.md"), join(root, "CLAUDE.md"))
  symlinkSync(join(outside, ".mcp.json"), join(root, ".mcp.json"))
  mkdirSync(join(root, "hooks"))
  symlinkSync(join(outside, "hooks.json"), join(root, "hooks", "hooks.json"))
  const project = directory()
  const fake = createFakeContext({ directory: project, options: { sources: [{ path: root }], instructions: true } })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  expect(fake.skills.size).toBe(0)
  expect(fake.agents.size).toBe(0)
  expect([...fake.commands.keys()]).toEqual(["linky:ok"])
  expect(fake.hooks("session")).toEqual([])
  const escapes = (await report(fake)).diagnostics.filter((issue) => issue.message.includes("path escapes source"))
  expect(escapes.map((issue) => issue.where).sort()).toEqual(["linky: CLAUDE.md", "linky: agents", "linky: mcp", "linky: hooks", join(root, "commands", "evil.md"), join(root, "skills", "stolen"), join(root, "skills", "leaf", "SKILL.md")].sort())
  await cleanup()
})

test("P1b: the session directory is looked up per call, so a session moved out of the project is left alone", async () => {
  const project = directory()
  const fake = createFakeContext({
    directory: project,
    options: { sources: [{ path: MARKETPLACE }], plugins: ["demo"], mcp: "off", instructions: true },
    sessions: [{ id: "ses_a", location: { directory: project } }],
  })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  const call = { tool: "shell", sessionID: "ses_a", agent: "build", messageID: "m", id: "c", input: { command: "echo forbidden-fixture-word" } }
  await expect(fake.fire.tool("execute.before", call)).rejects.toThrow("Blocked by the demo PreToolUse hook")
  expect((await fake.fire.session("context", { sessionID: "ses_a", system: [] as unknown[] })).system).toHaveLength(1)
  ;(fake.sessions.get("ses_a") as unknown as { location: unknown }).location = { directory: "/elsewhere" }
  await expect(fake.fire.tool("execute.before", call)).resolves.toBeDefined()
  expect((await fake.fire.session("context", { sessionID: "ses_a", system: [] as unknown[] })).system).toHaveLength(0)
  mkdirSync(join(project, "sub"))
  ;(fake.sessions.get("ses_a") as unknown as { location: unknown }).location = { directory: join(project, "sub") }
  await expect(fake.fire.tool("execute.before", call)).rejects.toThrow("Blocked")
  await cleanup()
})

test("P2a/P2b: cleanup kills a running SessionStart hook and drops its late result; other SessionStart matchers are reported", async () => {
  const root = directory()
  plugin(root, "sleep 20; echo late")
  put(
    root,
    "hooks/hooks.json",
    JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "sleep 20; echo late" }] },
          { matcher: "resume|compact", hooks: [{ type: "command", command: "echo resumed" }] },
        ],
      },
    }),
  )
  const project = directory()
  const fake = createFakeContext({ directory: project, options: { sources: [{ path: root }], mcp: "off" } })
  const cleanup = await setupClaudeCompat(fake.context, deps)
  const result = await report(fake)
  expect(result.loaded.hooks).toEqual(["bundled:SessionStart(startup)"])
  expect(result.diagnostics.map((issue) => issue.message)).toContain("SessionStart hook for resume|compact; only startup is supported; not run")
  expect(warnings.some((line) => line.includes("resume|compact"))).toBe(true)
  fake.emit({ type: "session.created", data: { sessionID: "ses_new", location: { directory: project } } })
  await Bun.sleep(200)
  const started = Date.now()
  await cleanup()
  expect(Date.now() - started).toBeLessThan(5_000)
  await Bun.sleep(300)
  expect(fake.calls.some((call) => call.method === "session.synthetic")).toBe(false)
  expect(fake.active()).toBe(0)
})
