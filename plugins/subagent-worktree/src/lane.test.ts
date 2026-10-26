import { describe, expect, test } from "bun:test"
import {
  annotation,
  DEFAULT_AGENTS,
  decideIsolation,
  decideMerge,
  diffCommand,
  formatLaneList,
  type IsolationFacts,
  isConflict,
  type Lane,
  type LaneReport,
  liveness,
  mergeArgs,
  orphanReasons,
  overlap,
  parseLane,
  readOptions,
  readSubagentInput,
  rewritePrompt,
  rulesAreReadOnly,
  SUBAGENT_PREAMBLE,
  shouldRemove,
  slug,
  tail,
  worktreeForBranch,
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
    [
      "read-only agent",
      { agent: { id: "general", permissions: [{ action: "edit", resource: "*", effect: "deny" }] } },
      "read-only",
    ],
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

describe("rulesAreReadOnly", () => {
  const rule = (action: string, resource: string, effect: string) => ({ action, resource, effect })
  test("the last rule matching edit on * decides", () => {
    expect(rulesAreReadOnly([rule("edit", "*", "deny")])).toBe(true)
    expect(rulesAreReadOnly([rule("*", "**", "deny")])).toBe(true)
    expect(rulesAreReadOnly([rule("edit", "*", "deny"), rule("edit", "*", "allow")])).toBe(false)
    expect(rulesAreReadOnly([rule("edit", "*", "allow"), rule("ed*", "*", "deny")])).toBe(true)
  })
  test("path-scoped denies, other actions and junk are not read-only", () => {
    expect(rulesAreReadOnly([rule("edit", "*.env", "deny")])).toBe(false)
    expect(rulesAreReadOnly([rule("shell", "*", "deny")])).toBe(false)
    expect(rulesAreReadOnly([rule("edit", "*", "ask")])).toBe(false)
    expect(rulesAreReadOnly([null, { action: 1 }])).toBe(false)
    expect(rulesAreReadOnly(undefined)).toBe(false)
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
  test("warns when the work exists only as uncommitted changes", () => {
    const note = annotation(lane, { ahead: 0, dirty: true }, false)
    expect(note).toContain("exists only as uncommitted changes")
    expect(note).toContain("sessionID ses_child")
    expect(annotation(lane, { ahead: 1, dirty: true }, false)).not.toContain("exists only as uncommitted")
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
  const none = { laneFiles: [], localFiles: [] }
  test("decideMerge", () => {
    expect(decideMerge({ lane, caller: "ses_parent", status: clean, ...none })).toEqual({ refuse: false, target: "main" })
    expect(decideMerge({ lane, caller: "ses_parent", status: clean, target: "dev", ...none })).toEqual({
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
    const only = reason({ lane, caller: "ses_parent", status: { ahead: 0, dirty: true } })
    expect(only).toContain("0 commits")
    expect(only).toContain("exists only as uncommitted changes")
    expect(only).toContain("sessionID ses_child")
  })
  test("decideMerge refuses overlapping local changes in the target checkout", () => {
    const decide = (laneFiles: string[] | undefined, localFiles: string[] | undefined) =>
      decideMerge({ lane, caller: "ses_parent", status: clean, laneFiles, localFiles })
    expect(decide(["a.ts", "b.ts"], ["c.ts"])).toEqual({ refuse: false, target: "main" })
    const refused = decide(["b.ts", "a.ts", "c.ts"], ["c.ts", "a.ts"])
    expect(refused.refuse).toBe(true)
    if (refused.refuse) expect(refused.reason).toEndWith(": a.ts, c.ts")
    expect(decide(undefined, [])).toEqual({ refuse: true, reason: expect.stringContaining("cannot list the files") })
    expect(decide([], undefined)).toEqual({ refuse: true, reason: expect.stringContaining("cannot read the local") })
  })
  test("overlap", () => {
    expect(overlap(["b", "a", "a"], ["a", "b", "x"])).toEqual(["a", "b"])
    expect(overlap([], ["a"])).toEqual([])
  })
  test("worktreeForBranch", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD 1111",
      "branch refs/heads/main",
      "",
      "worktree /wt/x",
      "HEAD 2222",
      "branch refs/heads/subagent-x",
      "",
      "worktree /wt/detached",
      "HEAD 3333",
      "detached",
    ].join("\n")
    expect(worktreeForBranch(porcelain, "main")).toBe("/repo")
    expect(worktreeForBranch(porcelain, "subagent-x")).toBe("/wt/x")
    expect(worktreeForBranch(porcelain, "dev")).toBeUndefined()
  })
})

describe("lane inventory", () => {
  test("liveness: resolved is alive, rejected is gone, slow is unknown", async () => {
    expect(await liveness(Promise.resolve({}), 50)).toBe("alive")
    expect(await liveness(Promise.reject(new Error("no session")), 50)).toBe("gone")
    expect(await liveness(new Promise(() => {}), 5)).toBe("unknown")
  })
  test("orphanReasons", () => {
    const status = { ahead: 1, dirty: false }
    expect(orphanReasons({ status, child: "alive", parent: "alive" })).toEqual([])
    expect(orphanReasons({ status, child: "unknown", parent: "unknown" })).toEqual([])
    expect(orphanReasons({ status: undefined, child: "gone", parent: "gone" })).toEqual([
      "child session gone",
      "parent session gone",
      "worktree unreadable",
    ])
  })
  test("formatLaneList", () => {
    expect(formatLaneList([], "ses_parent")).toContain("No active lanes")
    const reports: LaneReport[] = [
      { lane, status: { ahead: 2, dirty: false }, child: "alive", parent: "alive" },
      {
        lane: { ...lane, child: "ses_old", parent: "ses_gone", branch: "subagent-y", directory: "/wt/y" },
        status: { ahead: 0, dirty: true },
        child: "gone",
        parent: "gone",
      },
    ]
    const text = formatLaneList(reports, "ses_parent")
    expect(text).toContain('count="2"')
    expect(text).toContain("- subagent-x (sessionID ses_child, yours) /wt/subagent-x ahead=2 dirty=no child=alive parent=alive\n")
    expect(text).toContain("parent ses_gone")
    expect(text).toContain("ORPHAN: child session gone, parent session gone")
    expect(text).toContain("exists only as uncommitted changes")
    expect(text).toContain("nothing was removed")
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
