import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import path from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import fixture from "./fixtures/system-2.1.4.json"
import plugin, {
  DEFAULT_DROP,
  DEFAULT_LEAN_AGENTS,
  dropInstructions,
  EXPLORE_PROMPT,
  globalConfigDirs,
  isUnder,
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
const GLOBAL_DIR = path.join(homedir(), ".config", "opencode")
const CATALOG = "# Code Mode\n\nUse the `execute` tool to call the tools listed below."
const SKILLS = "Skills provide specialized instructions.\n<available_skills>\n</available_skills>"
const GLOBAL = `Instructions from: ${GLOBAL_DIR}/AGENTS.md\n## Global\n\n- rule one\n\n- rule two\n`
const PROJECT = "Instructions from: /repo/AGENTS.md\n# AGENTS.md\n\nInstructions from: inline mention stays part of the file\n"
const AGENTS = [GLOBAL, PROJECT].join("\n\n")
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
const isGlobal = (file: string) => isUnder(file, [GLOBAL_DIR])

describe("dropInstructions", () => {
  test("removes every AGENTS.md file up to the date and keeps what surrounds it", () => {
    expect(dropInstructions([CATALOG, SKILLS, AGENTS, BUILTINS].join("\n\n"))).toBe(
      [CATALOG, SKILLS, BUILTINS].join("\n\n"),
    )
  })

  test("handles the files opening the part", () => {
    expect(dropInstructions(`${AGENTS}\n\n${BUILTINS}`)).toBe(BUILTINS)
    expect(dropInstructions(`${AGENTS}\n\n${BUILTINS}`, isGlobal)).toBe(`${PROJECT}\n\n${BUILTINS}`)
  })

  test("drops one file by its path and keeps the other with its inline mention", () => {
    const part = [CATALOG, SKILLS, AGENTS, BUILTINS].join("\n\n")
    expect(dropInstructions(part, isGlobal)).toBe([CATALOG, SKILLS, PROJECT, BUILTINS].join("\n\n"))
    expect(dropInstructions(part, (file) => !isGlobal(file))).toBe([CATALOG, SKILLS, GLOBAL, BUILTINS].join("\n\n"))
    expect(dropInstructions(part, () => false)).toBe(part)
  })

  test("leaves a part without both markers unchanged", () => {
    expect(dropInstructions(`${CATALOG}\n\n${BUILTINS}`)).toBe(`${CATALOG}\n\n${BUILTINS}`)
    expect(dropInstructions(`${CATALOG}\n\n${AGENTS}`)).toBe(`${CATALOG}\n\n${AGENTS}`)
    expect(dropInstructions("see Instructions from: x\n\nToday's date: y")).toBe("see Instructions from: x\n\nToday's date: y")
    expect(dropInstructions("a\n\nInstructions from: inline\n\nToday's date: y")).toBe("a\n\nInstructions from: inline\n\nToday's date: y")
  })
})

describe("globalConfigDirs", () => {
  test("lists OPENCODE_CONFIG_DIR, the XDG config dir and ~/.config/opencode", () => {
    expect(globalConfigDirs({}, "/Users/u")).toEqual(["/Users/u/.config/opencode"])
    expect(globalConfigDirs({ OPENCODE_CONFIG_DIR: "/cfg", XDG_CONFIG_HOME: "/xdg" }, "/Users/u")).toEqual([
      "/cfg",
      "/xdg/opencode",
      "/Users/u/.config/opencode",
    ])
    expect(globalConfigDirs({ XDG_CONFIG_HOME: "/Users/u/.config" }, "/Users/u")).toEqual(["/Users/u/.config/opencode"])
  })

  test("matches files inside a directory only", () => {
    expect(isUnder("/Users/u/.config/opencode/AGENTS.md", ["/Users/u/.config/opencode/"])).toBe(true)
    expect(isUnder("/Users/u/.config/opencode-old/AGENTS.md", ["/Users/u/.config/opencode"])).toBe(false)
    expect(isUnder("/repo/AGENTS.md", [])).toBe(false)
  })
})

// Recorded from OpenCode 2.1.4 with Claude Haiku 4.5, one global and one project AGENTS.md;
// home and repository paths are renamed.
describe("leanSystem on a recorded 2.1.4 prompt", () => {
  const dirs = ["/Users/u/.config/opencode"]
  const instructions = (parts: ReadonlyArray<{ type: string; text: string }>) =>
    parts.filter((part) => part.text.includes("Today's date: "))
  for (const agent of ["explore", "adversarial-challenger"] as const) {
    const recorded = fixture[agent] as Array<{ type: "text"; text: string }>
    const prompt = recorded[0]?.text ?? ""
    const part = instructions(recorded)[0]?.text ?? ""

    test(`${agent}: the default drops identity and the hint, and keeps both AGENTS.md files`, () => {
      const lean = leanSystem(recorded, new Set(DEFAULT_DROP), dirs)
      expect(lean).toEqual(recorded.filter((_, index) => index === 0 || index === 2))
      expect(lean[1]?.text).toContain("Instructions from: /Users/u/.config/opencode/AGENTS.md")
      expect(lean[1]?.text).toContain("Instructions from: /Users/u/dev/repo/AGENTS.md")
    })

    test(`${agent}: global-instructions drops the global file and keeps the project file`, () => {
      const lean = leanSystem(recorded, new Set(["global-instructions", ...DEFAULT_DROP] as const), dirs)
      expect(lean).toHaveLength(2)
      expect(lean[0]?.text).toBe(prompt)
      const kept = lean[1]?.text ?? ""
      expect(kept).not.toContain("Instructions from: /Users/u/.config/opencode/AGENTS.md")
      expect(kept).not.toContain("## GitHub transport")
      expect(kept).toContain("Instructions from: /Users/u/dev/repo/AGENTS.md\n# AGENTS.md")
      expect(kept).toContain("## Issue tracking")
      expect(kept.length).toBe(part.length - (part.indexOf("Instructions from: /Users/u/dev/repo") - part.indexOf("Instructions from: /Users/u/.config")))
      expect(kept.endsWith(part.slice(part.indexOf("\n\nToday's date: ")))).toBe(true)
    })

    test(`${agent}: project-instructions drops the project file only`, () => {
      const [, kept] = leanSystem([recorded[0], recorded[2]] as typeof recorded, new Set(["project-instructions"] as const), dirs)
      expect(kept?.text).toContain("## GitHub transport\n")
      expect(kept?.text).not.toContain("Instructions from: /Users/u/dev/repo/AGENTS.md")
      expect(kept?.text).toContain("rm -rf`.\n\n\nToday's date: ")
    })

    test(`${agent}: both instruction segments drop the whole block`, () => {
      const [, , kept] = leanSystem(recorded, new Set(["global-instructions", "project-instructions"] as const), dirs)
      expect(kept?.text).not.toContain("Instructions from: ")
      expect(kept?.text).toBe(part.replace(/(?:^|\n\n)Instructions from: [\s\S]*(?=Today's date: )/, (match) => (match.startsWith("\n") ? "\n\n" : "")))
      expect(leanSystem(recorded, new Set(), dirs)).toEqual(recorded)
    })
  }
})

describe("leanSystem", () => {
  test("drops instructions, identity and the worktree hint", () => {
    expect(leanSystem(system(), new Set(SEGMENTS), [GLOBAL_DIR])).toEqual([
      text("You are a reviewer."),
      text([CATALOG, SKILLS, BUILTINS].join("\n\n")),
    ])
  })

  test("drops only the chosen segments", () => {
    expect(leanSystem(system(), new Set(["identity"] as const))).toEqual(system().filter((part) => part.text !== IDENTITY))
    expect(leanSystem(system(), new Set())).toEqual(system())
  })

  test("without global dirs every file counts as the project's", () => {
    const [, , part] = leanSystem(system(), new Set(["global-instructions"] as const))
    expect(part?.text).toBe([CATALOG, SKILLS, AGENTS, BUILTINS].join("\n\n"))
  })

  test("is deterministic so the prompt cache prefix holds", () => {
    expect(leanSystem(system(), new Set(DEFAULT_DROP), [GLOBAL_DIR])).toEqual(
      leanSystem(system(), new Set(DEFAULT_DROP), [GLOBAL_DIR]),
    )
  })
})

describe("parseLeanOptions", () => {
  test("defaults to the read-only agents, dropping identity and the hint", () => {
    const parsed = parseLeanOptions({})
    expect([...(parsed?.agents ?? [])]).toEqual([...DEFAULT_LEAN_AGENTS])
    expect([...(parsed?.drop ?? [])]).toEqual(["identity", "worktree"])
  })

  test("leaves implementers out of the default list", () => {
    for (const id of ["general", "build", "implementer", "implementer-high", "operator", "shepherd", "mechanic", "ui-implementer"])
      expect(DEFAULT_LEAN_AGENTS).not.toContain(id)
  })

  test("takes a list of agents and segments, and false or empty lists turn it off", () => {
    const parsed = parseLeanOptions({ leanSubagents: ["general"], leanDrop: ["identity", "bogus", 3] })
    expect([...(parsed?.agents ?? [])]).toEqual(["general"])
    expect([...(parsed?.drop ?? [])]).toEqual(["identity"])
    expect(parseLeanOptions({ leanSubagents: false })).toBeUndefined()
    expect(parseLeanOptions({ leanSubagents: [] })).toBeUndefined()
    expect(parseLeanOptions({ leanDrop: [] })).toBeUndefined()
  })

  test("instructions stands for both AGENTS.md segments", () => {
    expect([...(parseLeanOptions({ leanDrop: ["instructions", "worktree"] })?.drop ?? [])]).toEqual([
      "global-instructions",
      "project-instructions",
      "worktree",
    ])
    expect([...(parseLeanOptions({ leanDrop: ["project-instructions"] })?.drop ?? [])]).toEqual(["project-instructions"])
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
    expect(lean.system).toEqual([text("You are a reviewer."), text([CATALOG, SKILLS, AGENTS, BUILTINS].join("\n\n"))])
    const again = await fake.fire.session("context", context("ses_child", "pr-reviewer"))
    expect(again.system).toEqual(lean.system)
    expect(fake.calls.filter((entry) => entry.method === "session.get")).toHaveLength(1)
    expect((await fake.fire.session("context", context("ses_root", "pr-reviewer"))).system).toEqual(system())
    expect((await fake.fire.session("context", context("ses_impl", "implementer"))).system).toEqual(system())
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("leanDrop global-instructions also drops the global AGENTS.md", async () => {
    const fake = createFakeContext({
      options: { leanDrop: ["global-instructions", "identity", "worktree"] },
      sessions: [{ id: "ses_child", parentID: "ses_root" }, { id: "ses_root" }],
    })
    await plugin.setup(fake.context)
    const lean = await fake.fire.session("context", context("ses_child", "pr-reviewer"))
    expect(lean.system).toEqual([text("You are a reviewer."), text([CATALOG, SKILLS, PROJECT, BUILTINS].join("\n\n"))])
  })

  test("compaction and generate requests get the same trimmed system prompt", async () => {
    const fake = createFakeContext({ sessions: [{ id: "ses_child", parentID: "ses_root" }, { id: "ses_root" }] })
    const cleanup = await plugin.setup(fake.context)
    expect(fake.hooks("session")).toEqual(["context", "compaction", "generate"])
    const turn = (await fake.fire.session("context", context("ses_child", "pr-reviewer"))).system
    expect(turn).not.toEqual(system())
    for (const hook of ["compaction", "generate"] as const)
      expect({ hook, system: (await fake.fire.session(hook, context("ses_child", "pr-reviewer"))).system }).toEqual({ hook, system: turn })
    expect((await fake.fire.session("compaction", context("ses_root", "pr-reviewer"))).system).toEqual(system())
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("leanSubagents: false registers no session hook", async () => {
    const fake = createFakeContext({ options: { leanSubagents: false } })
    await plugin.setup(fake.context)
    expect(fake.hooks("session")).toEqual([])
  })
})
