import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { agentPaths, permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { MODEL_TIERS } from "@srobroek/opencode-lib/model-roles"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { AGENTS_DIR, enabledModes, parseOptions, selectAgents, setupModes } from "./index.ts"

const agent = (id: string) => readAgentFile(`${AGENTS_DIR}/${id}.md`)
const effect = (id: string, action: string, resource = "*") => permissionEffect(agent(id).permissions, action, resource)
const WORKTREE = "~/.local/share/opencode/worktree/abc123/debug-1"
const WORKTREE_ROOT = "~/.local/share/opencode/worktree/41bad1"

describe("options", () => {
  test("every agent and reminders default to on", () => {
    expect(parseOptions(undefined)).toEqual({ agents: { debug: true, refactor: true, concept: true }, reminders: true })
  })
  test("an agent set to false is left out of the registered files and modes", () => {
    const options = parseOptions({ agents: { refactor: false } })
    const files = selectAgents(agentPaths(AGENTS_DIR), options).map((path) => path.split("/").pop())
    expect(files).toEqual(["concept.md", "debug.md"])
    expect(enabledModes(options).map((mode) => mode.id)).toEqual(["debug", "concept"])
  })
})

describe("shipped agents", () => {
  const expected = { debug: ["all", "strong", 150], refactor: ["primary", "standard", 200], concept: ["primary", "strong", 120] } as const
  test.each(Object.entries(expected))("%s has its mode, tier, steps, colour and a short description", (id, [mode, tier, steps]) => {
    const file = agent(id)
    expect(file.mode).toBe(mode)
    expect(file.hidden).toBe(false)
    expect(MODEL_TIERS).toContain(file.request?.headers["x-opencode-model-role"] as never)
    expect(file.request?.headers["x-opencode-model-role"]).toBe(tier)
    expect(file.steps).toBe(steps)
    expect(file.color).toBeTruthy()
    expect((file.description ?? "").length).toBeLessThanOrEqual(150)
  })

  test("colours are distinct", () => {
    expect(new Set(Object.keys(expected).map((id) => agent(id).color)).size).toBe(3)
  })

  test("debug denies edits in the checkout and allows the scratch worktree and ledger", () => {
    expect(effect("debug", "edit", "src/foo.ts")).toBe("deny")
    expect(effect("debug", "edit", `${WORKTREE}/src/foo.ts`)).toBe("allow")
    expect(effect("debug", "edit", "~/.opencode/debug/x.md")).toBe("allow")
    expect(effect("debug", "edit", `${WORKTREE_ROOT}/debug-foo/src/a.ts`)).toBe("allow")
    expect(effect("debug", "edit", `${WORKTREE_ROOT}/subagent-x/src/a.ts`)).toBe("deny")
    expect(effect("debug", "external_directory", `${WORKTREE_ROOT}/subagent-x/src/a.ts`)).toBe("ask")
    expect(effect("debug", "external_directory", `${WORKTREE}/src/foo.ts`)).toBe("allow")
  })
  test("debug shell is open but refuses push, clean and rm -rf", () => {
    expect(effect("debug", "shell", "git -C wt commit -m x")).toBe("allow")
    for (const command of ["git push origin main", "git clean -fd", "rm -rf build", "git -C wt push", "git -c a=b clean -fdx"]) expect(effect("debug", "shell", command)).toBe("deny")
  })
  test("debug spawns only its listed helpers", () => {
    expect(effect("debug", "subagent", "adversarial-challenger")).toBe("allow")
    expect(effect("debug", "subagent", "coder")).toBe("deny")
  })

  test("refactor denies tests and fixtures but allows source", () => {
    expect(effect("refactor", "edit", "src/foo.ts")).toBe("allow")
    for (const path of ["src/foo.test.ts", "tests/a.ts", "pkg/__snapshots__/a.snap", "src/fixtures/x.json", "test_a.py"])
      expect(effect("refactor", "edit", path)).toBe("deny")
  })
  test("refactor may spawn debug but not coder", () => {
    expect(effect("refactor", "subagent", "debug")).toBe("allow")
    expect(effect("refactor", "subagent", "coder")).toBe("deny")
  })

  test("concept edits only design docs and scratch", () => {
    expect(effect("concept", "edit", "src/foo.ts")).toBe("deny")
    expect(effect("concept", "edit", "docs/adr/0001-x.md")).toBe("allow")
    expect(effect("concept", "edit", "~/.opencode/concept/s/brief.md")).toBe("allow")
  })
  test("concept shell asks except for read-only git and the prototype server", () => {
    expect(effect("concept", "shell", "rm a")).toBe("ask")
    expect(effect("concept", "shell", "git status --short")).toBe("allow")
    expect(effect("concept", "shell", "python3 -m http.server 8000")).toBe("allow")
  })
  test.each([
    "design-guide",
    "design-prototype",
    "design-upstream-preflight",
    "ui-review",
    "wireloom",
    "html-wireframe",
    "html-prototype",
    "prototype-logic",
    "grilling",
    "debate",
  ])("concept may load the %s skill, and not an unrelated one", (skill) => {
    expect(effect("concept", "skill", skill)).toBe("allow")
    expect(effect("concept", "skill", "dep-update")).toBe("deny")
  })
  test.each(["frontend-slides", "web-asset-generator", "design-evidence", "accessibility-audit", "accessibility"])(
    "concept may load the %s skill",
    (skill) => expect(effect("concept", "skill", skill)).toBe("allow"),
  )
  test("concept may load every skill that design-guide routes to", () => {
    const guide = readFileSync(join(import.meta.dir, "../../design/skills/design-guide/SKILL.md"), "utf8")
    const routed = [...guide.matchAll(/\|[^|]*\|\s*`([\w-]+)`\s*\|/g)].map((match) => match[1] as string)
    expect(routed.length).toBeGreaterThan(10)
    for (const skill of routed) expect({ skill, effect: effect("concept", "skill", skill) }).toEqual({ skill, effect: "allow" })
  })
  test("concept may drive a browser, and every curl asks", () => {
    expect(effect("concept", "browser")).toBe("allow")
    for (const url of ["http://127.0.0.1:8123/a.html", "http://127.0.0.1:8123@evil.com", "https://example.com"])
      expect(effect("concept", "shell", `curl -sS -o /dev/null -w '%{http_code}' ${url}`)).toBe("ask")
  })
  test("concept spawns design helpers but not coder", () => {
    expect(effect("concept", "subagent", "ui-ux-specialist")).toBe("allow")
    expect(effect("concept", "subagent", "design-critic")).toBe("allow")
    expect(effect("concept", "subagent", "coder")).toBe("deny")
    expect(effect("concept", "wire-dsl_render")).toBe("allow")
  })
})

describe("setup", () => {
  test("registers the agents and reminders, and the cleanup disposes everything", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    expect([...fake.agents.keys()].sort()).toEqual(["concept", "debug", "refactor"])
    expect(fake.hooks("session")).toEqual(["context"])
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.hooks("session")).toEqual([])
  })
  test("the shell guard refuses git -C push for debug, allows it for build, and is disposed", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    const run = (agent: string, command: string) => fake.fire.tool("execute.before", { tool: "shell", agent, input: { command } })
    await expect(run("debug", "git -C /wt push")).rejects.toThrow("git push")
    await expect(run("build", "git -C /wt push")).resolves.toBeDefined()
    await expect(run("debug", "git -C /wt status")).resolves.toBeDefined()
    await expect(
      fake.fire.tool("execute.before", { tool: "bash", agent: "debug", input: { command: ["git", "push"] } }),
    ).rejects.toThrow()
    await cleanup?.()
    expect(fake.hooks("tool")).toEqual([])
  })
  test("the write guard refuses a debug edit in the starting directory and allows a debug-* worktree", async () => {
    const fake = createFakeContext({ sessions: [{ id: "ses_1", location: { directory: "/repo" } }] })
    const cleanup = await plugin.setup(fake.context)
    const edit = (agent: string, path: string) =>
      fake.fire.tool("execute.before", { tool: "edit", agent, sessionID: "ses_1", input: { path } })
    const scratch = `${homedir()}/.local/share/opencode/worktree/h1/debug-foo/src/a.ts`
    await expect(edit("debug", "/repo/src/a.ts")).rejects.toThrow("started in")
    await expect(edit("debug", scratch)).resolves.toBeDefined()
    await expect(edit("build", "/repo/src/a.ts")).resolves.toBeDefined()
    await cleanup?.()
    expect(fake.hooks("tool")).toEqual([])
  })
  test("the shell guard keeps debug's mutating git out of the session's starting checkout", async () => {
    const fake = createFakeContext({ sessions: [{ id: "ses_1", location: { directory: "/repo" } }] })
    await setupModes(fake.context, { headCheck: async () => undefined })
    const run = (agent: string, command: string, workdir?: string) =>
      fake.fire.tool("execute.before", { tool: "shell", agent, sessionID: "ses_1", input: { command, workdir } })
    const scratch = `${homedir()}/.local/share/opencode/worktree/h1/debug-foo`
    await expect(run("debug", "git commit -m x")).rejects.toThrow("scratch worktree")
    await expect(run("debug", `git -C ${scratch} commit -m x`)).rejects.toThrow("workdir")
    await expect(run("debug", "git commit -m x", scratch)).resolves.toBeDefined()
    await expect(run("refactor", "git commit -m x")).resolves.toBeDefined()
  })
  test("a mutating git command also needs HEAD to be detached or on a debug branch, read before it runs", async () => {
    const fake = createFakeContext({ sessions: [{ id: "ses_1", location: { directory: "/repo" } }] })
    const asked: Array<string | undefined> = []
    let verdict: string | undefined
    await setupModes(fake.context, {
      headCheck: async (workdir) => {
        asked.push(workdir)
        return verdict
      },
    })
    const run = (agent: string, command: string, workdir?: string) =>
      fake.fire.tool("execute.before", { tool: "shell", agent, sessionID: "ses_1", input: { command, workdir } })
    const scratch = `${homedir()}/.local/share/opencode/worktree/h1/debug-foo`
    await expect(run("debug", "git commit -m x", scratch)).resolves.toBeDefined()
    expect(asked).toEqual([scratch])
    verdict = "the worktree is on refs/heads/main"
    await expect(run("debug", "git commit -m x", scratch)).rejects.toThrow("refs/heads/main")
    await run("debug", "git log -p", scratch)
    await run("debug", "git status", "/repo")
    await run("refactor", "git commit -m x")
    expect(asked).toEqual([scratch, scratch])
  })
  test("a lone branch change skips the HEAD check, which any other mutating call still needs", async () => {
    const fake = createFakeContext({ sessions: [{ id: "ses_1", location: { directory: "/repo" } }] })
    const asked: Array<string | undefined> = []
    await setupModes(fake.context, {
      headCheck: async (workdir) => {
        asked.push(workdir)
        return "the worktree is on refs/heads/main"
      },
    })
    const run = (command: string, workdir: string) =>
      fake.fire.tool("execute.before", { tool: "shell", agent: "debug", sessionID: "ses_1", input: { command, workdir } })
    const scratch = `${homedir()}/.local/share/opencode/worktree/h1/debug-foo`
    await expect(run("git switch -c debug/x", scratch)).resolves.toBeDefined()
    await expect(run("git switch --detach", scratch)).resolves.toBeDefined()
    expect(asked).toEqual([])
    await expect(run("git commit -am x", scratch)).rejects.toThrow("refs/heads/main")
    await expect(run("git switch -c debug/x && git commit -am x", scratch)).rejects.toThrow("its own call")
    expect(asked).toEqual([scratch])
  })
  test("a refused command never reads HEAD, and the real check refuses a workdir that is not a repository", async () => {
    const fake = createFakeContext({ sessions: [{ id: "ses_1", location: { directory: "/repo" } }] })
    await setupModes(fake.context)
    const scratch = `${homedir()}/.local/share/opencode/worktree/h1/debug-missing`
    await expect(
      fake.fire.tool("execute.before", { tool: "shell", agent: "debug", sessionID: "ses_1", input: { command: "git commit -m x", workdir: scratch } }),
    ).rejects.toThrow("could not be read")
  })
  test("the shell guard is not registered when debug and refactor are off", async () => {
    const fake = createFakeContext({ options: { agents: { debug: false, refactor: false } } })
    await plugin.setup(fake.context)
    expect(fake.hooks("tool")).toEqual([])
  })
  test("reminders: false registers no hook", async () => {
    const fake = createFakeContext({ options: { reminders: false } })
    await plugin.setup(fake.context)
    expect(fake.hooks("session")).toEqual([])
  })
})
