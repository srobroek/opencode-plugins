import { describe, expect, test } from "bun:test"
import {
  annotation,
  blockingReservation,
  containingWorktree,
  DEFAULT_AGENTS,
  DIRTY_CHECKOUT_NOTE,
  decideIsolation,
  decideMerge,
  decideWriterGuard,
  diffCommand,
  findWorktree,
  formatLaneList,
  type IsolationFacts,
  isConflict,
  isUnbornHead,
  type Lane,
  type LaneReport,
  liveness,
  mergeArgs,
  orphanReasons,
  overlap,
  parseLane,
  parseWorktrees,
  planStart,
  RESUME_WORKTREE_NOTE,
  readOptions,
  readSubagentInput,
  reservationStatus,
  rewritePrompt,
  rulesAreReadOnly,
  SUBAGENT_PREAMBLE,
  sessionIsReadOnly,
  shouldRemove,
  slug,
  startPrompt,
  tail,
  targetsExternalDirectory,
  WRITER_LIVENESS_NOTE,
  withoutWorktree,
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

test("external working-directory directives are conservative", () => {
  expect(targetsExternalDirectory("Working directory: /other/repo", "/repo")).toBe(true)
  expect(targetsExternalDirectory("Work in ~/.local/share/chezmoi", "/repo")).toBe(true)
  expect(targetsExternalDirectory("Work in ~/repo", "/home/me/repo", "/home/me")).toBe(false)
  expect(targetsExternalDirectory("Read /other/file.txt", "/repo")).toBe(false)
  expect(targetsExternalDirectory("Repository: /repo/subdir", "/repo")).toBe(false)
  expect(targetsExternalDirectory("Repo: /repo-other", "/repo")).toBe(true)
  expect(targetsExternalDirectory("Repo: /other; repo: /repo", "/repo")).toBe(false)
  expect(readSubagentInput({ agent: "general", prompt: "p", worktree: false })?.worktree).toBe(false)
})

describe("readOptions", () => {
  test("defaults", () => {
    expect(DEFAULT_AGENTS).toEqual(["coder", "implementer", "implementer-high", "general"])
    expect(readOptions(undefined)).toMatchObject({ agents: DEFAULT_AGENTS, base: "HEAD" })
  })
  test("defaults for the lifecycle options", () => {
    expect(readOptions(undefined)).toMatchObject({
      gates: true,
      resumeGraceMs: 600_000,
      emptyGraceMs: 1_800_000,
      sweep: "report",
      minAgeHours: 24,
      intervalHours: 6,
      include: [],
    })
    expect(readOptions({ gates: false, sweep: "prune", minAgeHours: 2, include: ["/x", 1] })).toMatchObject({
      gates: false,
      sweep: "prune",
      minAgeHours: 2,
      include: ["/x"],
    })
    expect(readOptions({ sweep: "bogus", minAgeHours: -1 })).toMatchObject({ sweep: "report", minAgeHours: 24 })
  })
  test("reads agents and base, dropping junk", () => {
    expect(readOptions({ agents: ["a", 1, ""], base: " dev " })).toMatchObject({ agents: ["a"], base: "dev" })
    expect(readOptions({ agents: [], base: "" })).toMatchObject({ agents: [], base: "HEAD" })
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
    expect(readSubagentInput({ agent: "a", prompt: "p", worktree: " feat/x " })?.worktree).toBe("feat/x")
    expect(readSubagentInput({ agent: "a", prompt: "p", worktree: " " })?.worktree).toBeUndefined()
  })

  test("withoutWorktree drops only the worktree argument", () => {
    const input = { agent: "a", prompt: "p", worktree: "x" }
    expect(withoutWorktree(input)).toEqual({ agent: "a", prompt: "p" })
    expect(input.worktree).toBe("x")
    const plain = { agent: "a", prompt: "p" }
    expect(withoutWorktree(plain)).toBe(plain)
  })
})

const PORCELAIN = [
  "worktree /repo",
  "HEAD 0123",
  "branch refs/heads/main",
  "",
  "worktree /repo/.worktrees/feat-x",
  "HEAD 4567",
  "branch refs/heads/feat/x",
  "",
  "worktree /wt/detached",
  "HEAD 89ab",
  "detached",
  "",
  "worktree /bare.git",
  "bare",
  "",
].join("\n")

describe("worktree lookup", () => {
  const entries = parseWorktrees(PORCELAIN)

  test("parses git worktree list, skipping bare repositories", () => {
    expect(entries).toEqual([
      { directory: "/repo", branch: "main" },
      { directory: "/repo/.worktrees/feat-x", branch: "feat/x" },
      { directory: "/wt/detached" },
    ])
  })

  test("finds a worktree by branch, path inside it, or unique directory name", () => {
    const found = (...args: Parameters<typeof findWorktree>) => {
      const lookup = findWorktree(...args)
      return lookup.ok ? lookup.worktree.directory : lookup.reason
    }
    expect(found("feat/x", "/cwd/feat/x", entries)).toBe("/repo/.worktrees/feat-x")
    expect(found("refs/heads/feat/x", undefined, entries)).toBe("/repo/.worktrees/feat-x")
    expect(found("/repo/.worktrees/feat-x/src", "/repo/.worktrees/feat-x/src", entries)).toBe("/repo/.worktrees/feat-x")
    expect(found("/repo", "/repo", entries)).toBe("/repo")
    expect(found("detached", "/cwd/detached", entries)).toBe("/wt/detached")
  })

  test("rejects anything outside the project", () => {
    const outside = findWorktree("/elsewhere", "/elsewhere", entries)
    expect(outside.ok).toBe(false)
    expect(!outside.ok && outside.reason).toContain("/repo/.worktrees/feat-x (feat/x)")
    expect(findWorktree("/repository", "/repository", entries).ok).toBe(false)
    expect(findWorktree("x", "/x", undefined)).toEqual({
      ok: false,
      reason: 'cannot use worktree "x": the caller is not in a git checkout',
    })
  })

  test("containingWorktree picks the deepest", () => {
    expect(containingWorktree("/repo/.worktrees/feat-x/a", entries)?.directory).toBe("/repo/.worktrees/feat-x")
    expect(containingWorktree("/repo/src", entries)?.directory).toBe("/repo")
    expect(containingWorktree("/other", entries)).toBeUndefined()
  })
})

describe("planStart", () => {
  const feat = { directory: "/wt/feat", branch: "feat" }
  const isolate = { isolate: true } as const
  const shared = { isolate: false, reason: "read-only agent (edit denied)" } as const
  const base = { parentDir: "/repo", current: "/repo", runnable: true }
  const input = { agent: "explore", description: "d", prompt: "p" }
  const named = { ...input, worktree: "feat" }

  test.each(["feat", false] as const)("ignores worktree %j on resumes", (worktree) => {
    expect(planStart({ ...base, input: { ...input, sessionID: "ses_x", worktree }, isolation: isolate })).toEqual({ kind: "default", note: RESUME_WORKTREE_NOTE })
  })

  test("dirty tracked files skip only automatic writer lanes", () => {
    expect(planStart({ ...base, input, isolation: isolate, trackedDirty: true })).toEqual({ kind: "default", note: DIRTY_CHECKOUT_NOTE })
    expect(planStart({ ...base, input, isolation: shared, trackedDirty: true })).toEqual({ kind: "default" })
    expect(planStart({ ...base, input: named, isolation: isolate, trackedDirty: true, lookup: { ok: true, worktree: feat } })).toEqual({ kind: "isolate", from: "/wt/feat" })
  })

  test("without worktree keeps today's behaviour", () => {
    expect(planStart({ ...base, input, isolation: isolate })).toEqual({ kind: "isolate", from: "/repo" })
    expect(planStart({ ...base, input, isolation: shared })).toEqual({ kind: "default" })
  })

  test("a named worktree: writers branch from it, others run in it", () => {
    const lookup = { ok: true, worktree: feat } as const
    expect(planStart({ ...base, input: named, lookup, isolation: isolate })).toEqual({ kind: "isolate", from: "/wt/feat" })
    expect(planStart({ ...base, input: named, lookup, isolation: shared })).toEqual({ kind: "move", worktree: feat })
    expect(planStart({ ...base, current: "/wt/feat", input: named, lookup, isolation: shared })).toEqual({ kind: "default" })
    expect(planStart({ ...base, runnable: false, input: named, lookup, isolation: shared })).toEqual({ kind: "default" })
  })

  test("refuses a worktree it cannot find", () => {
    const lookup = { ok: false, reason: "nope" } as const
    expect(planStart({ ...base, input: named, lookup, isolation: isolate })).toEqual({ kind: "refuse", reason: "nope" })
  })
})

describe("startPrompt", () => {
  test("replaces the preamble with one that names the worktree", () => {
    const prompt = startPrompt(`${SUBAGENT_PREAMBLE}\nDo it`, { directory: "/wt/feat", branch: "feat" })
    expect(prompt).toBe(
      `${SUBAGENT_PREAMBLE}\nYou work in the git worktree /wt/feat (branch feat). Run every command and read every file there.\n\nDo it`,
    )
    expect(startPrompt("Do it", { directory: "/wt/d" })).toContain("worktree /wt/d. Run")
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
  test("a caller's scoped edit grant makes a denying agent a writer for isolation", () => {
    const agent = { id: "general", permissions: [{ action: "edit", resource: "*", effect: "deny" }] }
    const callerPermissions = [{ action: "edit", resource: "src/*", effect: "allow" }]
    expect(decideIsolation(facts({ agent, callerPermissions }))).toEqual({ isolate: true })
  })
  test("an agent with a scoped edit ask after a blanket deny is still isolated as a writer", () => {
    const permissions = [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "src/*", effect: "ask" },
    ]
    expect(decideIsolation(facts({ agent: { id: "general", permissions } }))).toEqual({ isolate: true })
  })
  test("an agent with a scoped edit grant after a blanket deny is still isolated as a writer", () => {
    const permissions = [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "src/*", effect: "allow" },
    ]
    expect(decideIsolation(facts({ agent: { id: "general", permissions } }))).toEqual({ isolate: true })
  })
})

describe("sessionIsReadOnly", () => {
  const rule = (action: string, resource: string, effect: string) => ({ action, resource, effect })
  const deny = [rule("edit", "*", "deny")]
  const allow = [rule("*", "*", "allow")]

  test("`?` in an action matches exactly one character", () => {
    expect(sessionIsReadOnly([rule("ed?t", "*", "deny")], undefined)).toBe(true)
    expect(sessionIsReadOnly([rule("e?t", "*", "deny")], undefined)).toBe(false)
    expect(sessionIsReadOnly(deny, [rule("ed?t", "src/*", "allow")])).toBe(false)
  })

  test.each([
    ["agent denies, no session rules", deny, undefined, true],
    ["agent allows, session denies edit", allow, deny, true],
    ["agent denies, session allows edit", deny, [rule("edit", "*", "allow")], false],
    ["agent denies, session grants edit on a path", deny, [rule("edit", "src/*", "allow")], false],
    ["agent denies, session grants write on a path", deny, [rule("write", "src/*", "allow")], false],
    ["agent denies, session asks for edit on a path", deny, [rule("edit", "src/*", "ask")], false],
    ["agent denies, later ask for write on a path", deny, [rule("write", "docs/*", "ask")], false],
    ["agent allows, session denies then re-grants a path", allow, [...deny, rule("edit", "docs/*", "allow")], false],
    ["session denies, an earlier scoped grant is overridden", [], [rule("edit", "src/*", "allow"), ...deny], true],
    ["no rules", undefined, undefined, false],
  ])("%s", (_name, agentRules, sessionRules, expected) => {
    expect(sessionIsReadOnly(agentRules, sessionRules)).toBe(expected)
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

describe("isUnbornHead", () => {
  test.each([
    ["a fresh git init", { head: undefined, symbolic: "refs/heads/main", refs: "" }, true],
    ["a resolving HEAD", { head: "abc", symbolic: undefined, refs: undefined }, false],
    ["a repository with other refs", { head: undefined, symbolic: "refs/heads/main", refs: "abc refs/heads/x" }, false],
    ["a detached HEAD that does not resolve", { head: undefined, symbolic: undefined, refs: "" }, false],
    ["a failed refs listing", { head: undefined, symbolic: "refs/heads/main", refs: undefined }, false],
  ])("%s", (_name, facts, expected) => {
    expect(isUnbornHead(facts)).toBe(expected)
  })
})

describe("decideWriterGuard", () => {
  const live = { id: "ses_live", parentID: "ses_parent", busy: 2000 }
  const facts = { writer: true, directory: "/wt/a", caller: "ses_parent" }

  test("refuses when a child session is running", () => {
    const guard = decideWriterGuard({ ...facts, sessions: [live] })
    expect(guard).toEqual({ kind: "refuse", reason: expect.stringContaining("live writer session ses_live") })
  })

  test("refuses a resumed child whose latest run started after its previous one ended", () => {
    const guard = decideWriterGuard({ ...facts, sessions: [{ ...live, idle: 1000 }] })
    expect(guard.kind).toBe("refuse")
  })

  test.each([
    ["a child idle after its last run", [{ ...live, busy: 1000, idle: 2000 }]],
    ["a child that never ran", [{ id: "ses_new", parentID: "ses_parent" }]],
    ["a read-only child", [{ ...live, readOnly: true }]],
    ["a root session", [{ id: "ses_root", busy: 2000 }]],
    ["the caller itself", [{ id: "ses_parent", parentID: "ses_gp", busy: 2000 }]],
    ["no sessions", []],
  ])("allows with %s", (_name, sessions) => {
    expect(decideWriterGuard({ ...facts, sessions })).toEqual({ kind: "allow" })
  })

  test("allows a read-only agent", () => {
    expect(decideWriterGuard({ ...facts, writer: false, sessions: [live] })).toEqual({ kind: "allow" })
  })

  test("allows with a warning when liveness is unknown", () => {
    expect(decideWriterGuard({ ...facts, sessions: undefined })).toEqual({ kind: "allow", warn: WRITER_LIVENESS_NOTE })
  })
})

describe("blockingReservation and holdsReservation", () => {
  const held = { token: "t1", callId: "call_1", child: "ses_a", until: 1000 }
  test("blocks another token before expiry", () => {
    expect(blockingReservation(held, 999, "t2")).toBe(held)
  })
  test.each([
    ["the holder itself", 500, "t1"],
    ["after expiry", 1000, "t2"],
  ])("does not block %s", (_name, now, token) => {
    expect(blockingReservation(held, now, token)).toBeUndefined()
  })
  test("does not block without a reservation", () => {
    expect(blockingReservation(undefined, 0, "t2")).toBeUndefined()
  })
  test.each([
    ["the owner before expiry", held, 999, "t1", "held"],
    ["the owner after expiry", held, 1000, "t1", "free"],
    ["no reservation", undefined, 0, "t1", "free"],
    ["another token that expired", { ...held, token: "t2" }, 1000, "t1", "free"],
    ["another live token", { ...held, token: "t2" }, 500, "t1", "replaced"],
  ] as const)("status: %s", (_name, reservation, now, token, expected) => {
    expect(reservationStatus(reservation, now, token)).toBe(expected)
  })
})
