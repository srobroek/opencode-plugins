import { describe, expect, test } from "bun:test"
import {
  annotation,
  DEFAULT_AGENTS,
  decideIsolation,
  decideMerge,
  diffCommand,
  type IsolationFacts,
  isConflict,
  type Lane,
  mergeArgs,
  parseLane,
  readOptions,
  readSubagentInput,
  rewritePrompt,
  SUBAGENT_PREAMBLE,
  shouldRemove,
  slug,
  tail,
  worktreeName,
} from "./lane.ts"

const lane: Lane = {
  child: "ses_child",
  parent: "ses_parent",
  projectID: "prj",
  directory: "/wt/subagent-x",
  branch: "subagent-x",
  base: "0123456789abcdef0123",
  target: "main",
  parentDir: "/repo",
  state: "active",
}

describe("readOptions", () => {
  test("defaults", () => {
    expect(readOptions(undefined)).toEqual({ agents: DEFAULT_AGENTS, base: "HEAD" })
  })
  test("reads agents and base, dropping junk", () => {
    expect(readOptions({ agents: ["a", 1, ""], base: " dev " })).toEqual({ agents: ["a"], base: "dev" })
    expect(readOptions({ agents: [], base: "" })).toEqual({ agents: [], base: "HEAD" })
  })
})

describe("readSubagentInput", () => {
  test("reads the fields the plugin uses", () => {
    expect(readSubagentInput({ agent: "general", description: "d", prompt: "p", sessionID: "", background: true })).toEqual(
      { agent: "general", description: "d", prompt: "p", background: true },
    )
    expect(readSubagentInput({ agent: "general", prompt: "p", sessionID: "ses_1" })?.sessionID).toBe("ses_1")
    expect(readSubagentInput({ prompt: "p" })).toBeUndefined()
    expect(readSubagentInput("x")).toBeUndefined()
  })
})

describe("decideIsolation", () => {
  const facts = (over: Partial<IsolationFacts> = {}): IsolationFacts => ({
    tool: "subagent",
    input: { agent: "general", description: "fix it", prompt: "do" },
    options: readOptions(undefined),
    agent: { id: "general", mode: "subagent" },
    callerIsChild: false,
    isGit: true,
    ...over,
  })
  test("isolates an opted-in subagent from a top-level git session", () => {
    expect(decideIsolation(facts())).toEqual({ isolate: true })
  })
  test.each([
    ["other tool", { tool: "shell" }, "not the subagent tool"],
    ["no input", { input: undefined }, "unreadable input"],
    ["continuation", { input: { agent: "general", description: "", prompt: "p", sessionID: "ses_1" } }, "continues"],
    ["opt-out", { input: { agent: "explore", description: "", prompt: "p" }, agent: { id: "explore" } }, "not opted in"],
    ["unknown agent", { agent: undefined }, "unknown agent"],
    ["primary", { agent: { id: "general", mode: "primary" } }, "primary"],
    ["child caller", { callerIsChild: true }, "child"],
    ["no git", { isGit: false }, "not a git"],
  ] as const)("skips: %s", (_name, over, reason) => {
    const decision = decideIsolation(facts(over as Partial<IsolationFacts>))
    expect(decision.isolate).toBe(false)
    if (!decision.isolate) expect(decision.reason).toContain(reason)
  })
  test("matches the resolved agent name too", () => {
    const decision = decideIsolation(
      facts({ input: { agent: "Implementer", description: "", prompt: "p" }, agent: { id: "implementer" } }),
    )
    expect(decision).toEqual({ isolate: true })
  })
})

describe("names", () => {
  test("slug", () => {
    expect(slug("Fix the README's typo!")).toBe("fix-the-readme-s-typo")
    expect(slug("***")).toBe("task")
    expect(slug("a".repeat(50)).length).toBe(32)
  })
  test("worktreeName", () => {
    expect(worktreeName("Write hello", "ab12cd")).toBe("subagent-write-hello-ab12cd")
  })
})

describe("rewritePrompt", () => {
  test("a fresh child gets the preamble once, then the notice, then the task", () => {
    const text = rewritePrompt("Write a file", lane, true)
    expect(text.startsWith(SUBAGENT_PREAMBLE)).toBe(true)
    expect(text).toContain("/wt/subagent-x")
    expect(text).toContain("branch subagent-x")
    expect(text.endsWith("Write a file")).toBe(true)
    expect(rewritePrompt(`${SUBAGENT_PREAMBLE}\nWrite a file`, lane, true).split(SUBAGENT_PREAMBLE).length).toBe(2)
  })
  test("a continued child has no preamble", () => {
    expect(rewritePrompt("more", lane, false).startsWith(SUBAGENT_PREAMBLE)).toBe(false)
  })
})

describe("shouldRemove", () => {
  test("only an empty, clean, finished lane", () => {
    expect(shouldRemove({ ahead: 0, dirty: false }, "completed")).toBe(true)
    expect(shouldRemove({ ahead: 0, dirty: false }, "error")).toBe(true)
    expect(shouldRemove({ ahead: 0, dirty: false }, "running")).toBe(false)
    expect(shouldRemove({ ahead: 1, dirty: false }, "completed")).toBe(false)
    expect(shouldRemove({ ahead: 0, dirty: true }, "completed")).toBe(false)
    expect(shouldRemove(undefined, "completed")).toBe(false)
  })
})

describe("annotation", () => {
  test("active lane names branch, base, diff and merge", () => {
    const note = annotation(lane, { ahead: 2, dirty: false }, false)
    expect(note).toContain('branch="subagent-x"')
    expect(note).toContain('base="0123456789ab"')
    expect(note).toContain("Commits ahead of base: 2")
    expect(note).toContain(diffCommand(lane))
    expect(note).toContain("subagent_worktree_merge")
    expect(diffCommand(lane)).toBe("git -C /repo diff 0123456789ab...subagent-x")
  })
  test("quotes odd paths and points at status when dirty", () => {
    const note = annotation({ ...lane, parentDir: "/my repo" }, { ahead: 0, dirty: true }, false)
    expect(note).toContain("git -C '/my repo' diff")
    expect(note).toContain("status")
  })
  test("removed lane", () => {
    expect(annotation(lane, { ahead: 0, dirty: false }, true)).toContain('state="removed"')
  })
})

describe("merge", () => {
  test("mergeArgs keeps history", () => {
    expect(mergeArgs("/wt/x", "main")).toEqual(["wt", "-C", "/wt/x", "merge", "main", "--no-squash", "--no-ff", "--yes"])
  })
  test("isConflict", () => {
    expect(isConflict("CONFLICT (content): Merge conflict in a.txt")).toBe(true)
    expect(isConflict("error: could not apply 1234")).toBe(true)
    expect(isConflict("Merged 2 commits")).toBe(false)
  })
  const clean = { ahead: 1, dirty: false }
  test("decideMerge", () => {
    expect(decideMerge({ lane, caller: "ses_parent", status: clean })).toEqual({ refuse: false, target: "main" })
    expect(decideMerge({ lane, caller: "ses_parent", status: clean, target: "dev" })).toEqual({
      refuse: false,
      target: "dev",
    })
    const reason = (input: Parameters<typeof decideMerge>[0]) => {
      const decision = decideMerge(input)
      return decision.refuse ? decision.reason : ""
    }
    expect(reason({ lane: undefined, caller: "ses_parent", status: clean })).toContain("no worktree lane")
    expect(reason({ lane: { ...lane, state: "merged" }, caller: "ses_parent", status: clean })).toContain("merged")
    expect(reason({ lane, caller: "ses_other", status: clean })).toContain("only the session")
    const { target: _target, ...detached } = lane
    expect(reason({ lane: detached, caller: "ses_parent", status: clean })).toContain("pass target")
    expect(reason({ lane, caller: "ses_parent", status: undefined })).toContain("cannot read")
    expect(reason({ lane, caller: "ses_parent", status: { ahead: 1, dirty: true } })).toContain("uncommitted")
    expect(reason({ lane, caller: "ses_parent", status: { ahead: 0, dirty: false } })).toContain("no commits")
  })
})

describe("parseLane", () => {
  test("round-trips and rejects junk", () => {
    expect(parseLane(JSON.parse(JSON.stringify(lane)))).toEqual(lane)
    expect(parseLane({ ...lane, state: "x" })).toBeUndefined()
    expect(parseLane({ ...lane, branch: "" })).toBeUndefined()
    expect(parseLane(null)).toBeUndefined()
  })
})

test("tail strips ANSI and keeps the last lines", () => {
  expect(tail("\x1b[31ma\x1b[0m\nb\nc", 2)).toBe("b\nc")
})
