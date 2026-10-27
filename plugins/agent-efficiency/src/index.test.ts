import { describe, expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, {
  DEFAULT_LEAN_AGENTS,
  dropInstructions,
  EXPLORE_PROMPT,
  leanSystem,
  parseLeanOptions,
  type Rule,
  routeShellAlias,
  SEGMENTS,
} from "./index.ts"

const none = () => false

describe("routeShellAlias", () => {
  test("routes bash and Bash to shell with shell's input shape", () => {
    expect(routeShellAlias("bash", { command: "echo hi", description: "greet" }, none)).toEqual({
      tool: "shell",
      input: { command: "echo hi" },
    })
    expect(routeShellAlias("Bash", { command: "make", run_in_background: true, timeout: 1000 }, none)).toEqual({
      tool: "shell",
      input: { command: "make", background: true, timeout: 1000 },
    })
  })

  test("leaves other tools and a registered bash tool alone", () => {
    expect(routeShellAlias("shell", { command: "ls" }, none)).toBeUndefined()
    expect(routeShellAlias("read", { path: "a" }, none)).toBeUndefined()
    expect(routeShellAlias("bash", { command: "ls" }, (id) => id === "bash")).toBeUndefined()
  })
})

// The shapes OpenCode 2.1.4 renders: the instructions part from Instructions.combine, the
// identity part from IdentityPlugin and the hint from the opencode tools plugin.
const CATALOG = "# Code Mode\n\nUse the `execute` tool to call the tools listed below."
const SKILLS = "Skills provide specialized instructions.\n<available_skills>\n</available_skills>"
const AGENTS = [
  "Instructions from: /home/u/.config/opencode/AGENTS.md\n## Global\n\n- rule one\n\n- rule two",
  "Instructions from: /repo/AGENTS.md\n# AGENTS.md\n\nInstructions from: inline mention stays part of the file",
].join("\n\n")
const BUILTINS = "Today's date: Tue Oct 27 2026\n\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: /repo\n</env>"
const IDENTITY = "# Your Model\n- Name: Claude Haiku 4.5\n- Provider ID: amazon-bedrock\n- Model ID: haiku"
const WORKTREE =
  "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory."
const text = (value: string) => ({ type: "text" as const, text: value })
const system = () => [
  text("You are a reviewer."),
  text(IDENTITY),
  text([CATALOG, SKILLS, AGENTS, BUILTINS].join("\n\n")),
  text(WORKTREE),
]

describe("dropInstructions", () => {
  test("removes every AGENTS.md file up to the date and keeps what surrounds it", () => {
    expect(dropInstructions([CATALOG, SKILLS, AGENTS, BUILTINS].join("\n\n"))).toBe(
      [CATALOG, SKILLS, BUILTINS].join("\n\n"),
    )
  })

  test("handles the files opening the part", () => {
    expect(dropInstructions(`${AGENTS}\n\n${BUILTINS}`)).toBe(BUILTINS)
  })

  test("leaves a part without both markers unchanged", () => {
    expect(dropInstructions(`${CATALOG}\n\n${BUILTINS}`)).toBe(`${CATALOG}\n\n${BUILTINS}`)
    expect(dropInstructions(`${CATALOG}\n\n${AGENTS}`)).toBe(`${CATALOG}\n\n${AGENTS}`)
    expect(dropInstructions("see Instructions from: x\n\nToday's date: y")).toBe("see Instructions from: x\n\nToday's date: y")
  })
})

describe("leanSystem", () => {
  test("drops instructions, identity and the worktree hint", () => {
    expect(leanSystem(system(), new Set(SEGMENTS))).toEqual([
      text("You are a reviewer."),
      text([CATALOG, SKILLS, BUILTINS].join("\n\n")),
    ])
  })

  test("drops only the chosen segments", () => {
    expect(leanSystem(system(), new Set(["identity"] as const))).toEqual(system().filter((part) => part.text !== IDENTITY))
    expect(leanSystem(system(), new Set())).toEqual(system())
  })

  test("is deterministic so the prompt cache prefix holds", () => {
    expect(leanSystem(system(), new Set(SEGMENTS))).toEqual(leanSystem(system(), new Set(SEGMENTS)))
  })
})

describe("parseLeanOptions", () => {
  test("defaults to the read-only agents and every segment", () => {
    const parsed = parseLeanOptions({})
    expect([...(parsed?.agents ?? [])]).toEqual([...DEFAULT_LEAN_AGENTS])
    expect([...(parsed?.drop ?? [])]).toEqual([...SEGMENTS])
  })

  test("leaves implementers out of the default list", () => {
    for (const id of ["general", "build", "implementer", "implementer-high", "operator", "shepherd", "mechanic", "ui-implementer"])
      expect(DEFAULT_LEAN_AGENTS).not.toContain(id)
  })

  test("takes a list of agents and segments, and false or empty lists turn it off", () => {
    const parsed = parseLeanOptions({ leanSubagents: ["general"], leanDrop: ["identity", "bogus"] })
    expect([...(parsed?.agents ?? [])]).toEqual(["general"])
    expect([...(parsed?.drop ?? [])]).toEqual(["identity"])
    expect(parseLeanOptions({ leanSubagents: false })).toBeUndefined()
    expect(parseLeanOptions({ leanSubagents: [] })).toBeUndefined()
    expect(parseLeanOptions({ leanDrop: [] })).toBeUndefined()
  })
})

describe("plugin", () => {
  const call = (tool: string, input: unknown) => ({
    tool,
    input,
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
  })
  const stockExplore = () => ({
    id: "explore",
    system: "You are a file search specialist.",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    ] as Rule[],
  })
  const evaluate = (rules: Rule[], action: string, resource: string) =>
    rules.findLast(
      (rule) =>
        (rule.action === "*" || rule.action === action) &&
        (rule.resource === "*" || new RegExp(`^${rule.resource.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(resource)),
    )?.effect

  test("renames a bash call to shell before the host looks the tool up", async () => {
    const fake = createFakeContext({ tools: [{ name: "shell" }] })
    const cleanup = await plugin.setup(fake.context)
    const event = await fake.fire.tool("execute.before", call("bash", { command: "echo hi", cwd: "/w" }))
    expect(event.tool).toBe("shell")
    expect(event.input).toEqual({ command: "echo hi", workdir: "/w" })
    const read = await fake.fire.tool("execute.before", call("read", { path: "a" }))
    expect(read).toEqual(call("read", { path: "a" }))
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("defers to a plugin that registered a real bash tool", async () => {
    const fake = createFakeContext({ tools: [{ name: "shell" }, { name: "bash" }] })
    await plugin.setup(fake.context)
    const event = await fake.fire.tool("execute.before", call("bash", { command: "ls" }))
    expect(event.tool).toBe("bash")
  })

  test("bashAlias: false registers no tool hook", async () => {
    const fake = createFakeContext({ options: { bashAlias: false } })
    await plugin.setup(fake.context)
    expect(fake.hooks("tool")).toEqual([])
    const event = await fake.fire.tool("execute.before", call("bash", { command: "ls" }))
    expect(event.tool).toBe("bash")
  })

  test("narrows explore to search and web tools with the scout prompt", async () => {
    const fake = createFakeContext({ agents: [stockExplore()] })
    await plugin.setup(fake.context)
    const explore = fake.agents.get("explore") as ReturnType<typeof stockExplore>
    expect(explore.system).toBe(EXPLORE_PROMPT)
    expect(explore).not.toHaveProperty("request")
    const rules = explore.permissions
    for (const tool of ["read", "grep", "glob", "websearch", "webfetch"]) expect(evaluate(rules, tool, "x")).toBe("allow")
    for (const tool of ["shell", "execute", "skill", "edit", "subagent"]) expect(evaluate(rules, tool, "x")).toBe("deny")
    expect(evaluate(rules, "read", "/repo/.env")).toBe("ask")
    expect(evaluate(rules, "read", "/repo/.env.local")).toBe("ask")
    expect(evaluate(rules, "read", "/repo/.env.example")).toBe("allow")
    expect(evaluate(rules, "external_directory", "/elsewhere/*")).toBe("ask")
  })

  test("explore: false leaves explore alone, and a missing explore is not created", async () => {
    const off = createFakeContext({ agents: [stockExplore()], options: { explore: false } })
    await plugin.setup(off.context)
    expect(off.agents.get("explore")).toEqual(stockExplore())
    const missing = createFakeContext()
    await plugin.setup(missing.context)
    expect(missing.agents.has("explore")).toBe(false)
  })

  const context = (sessionID: string, agent: string) => ({
    sessionID,
    agent,
    model: { providerID: "p", id: "m" },
    system: system(),
    messages: [],
    options: {},
    tools: {},
  })

  test("trims the system prompt of listed agents in child sessions only", async () => {
    const fake = createFakeContext({
      sessions: [
        { id: "ses_child", parentID: "ses_root" },
        { id: "ses_root" },
        { id: "ses_impl", parentID: "ses_root" },
      ],
    })
    const cleanup = await plugin.setup(fake.context)
    const lean = await fake.fire.session("context", context("ses_child", "pr-reviewer"))
    expect(lean.system).toEqual([text("You are a reviewer."), text([CATALOG, SKILLS, BUILTINS].join("\n\n"))])
    const again = await fake.fire.session("context", context("ses_child", "pr-reviewer"))
    expect(again.system).toEqual(lean.system)
    expect(fake.calls.filter((entry) => entry.method === "session.get")).toHaveLength(1)
    expect((await fake.fire.session("context", context("ses_root", "pr-reviewer"))).system).toEqual(system())
    expect((await fake.fire.session("context", context("ses_impl", "implementer"))).system).toEqual(system())
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("leanSubagents: false registers no session hook", async () => {
    const fake = createFakeContext({ options: { leanSubagents: false } })
    await plugin.setup(fake.context)
    expect(fake.hooks("session")).toEqual([])
  })
})
