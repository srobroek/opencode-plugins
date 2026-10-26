import { describe, expect, test } from "bun:test"
import { createFakeContext, type FakeContext } from "@srobroek/opencode-lib/testing"
import type { RunResult } from "./git.ts"
import { createPlugin } from "./index.ts"
import { type Lane, laneKey, MERGE_TOOL, SUBAGENT_PREAMBLE } from "./lane.ts"

const BASE = "0123456789abcdef0123456789abcdef01234567"
const PARENT = "ses_parent"
const REPO = "/repo"

type Repo = {
  git: boolean
  branch: Record<string, string | undefined>
  ahead: number
  dirty: boolean
  merge: RunResult
  /** Files the lane changes against its target. */
  laneFiles: string[]
  /** Uncommitted and untracked files in the target checkout, by directory. */
  local: Record<string, { changed: string[]; untracked: string[] }>
}

function fakeRun(repo: Repo, log: string[][]) {
  return async (argv: string[]): Promise<RunResult> => {
    log.push(argv)
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })
    const fail = { code: 1, stdout: "", stderr: "fatal" }
    if (argv[0] === "wt") return repo.merge
    const [, , dir = "", ...args] = argv
    const cmd = args.join(" ")
    if (cmd === "rev-parse --is-inside-work-tree") return repo.git ? ok("true\n") : fail
    if (cmd.startsWith("rev-parse --verify")) return ok(`${BASE}\n`)
    if (cmd === "symbolic-ref --quiet --short HEAD") {
      const branch = repo.branch[dir]
      return branch ? ok(`${branch}\n`) : fail
    }
    if (cmd.startsWith("show-ref")) return fail
    if (cmd.startsWith("switch --quiet -c ")) {
      repo.branch[dir] = args[3]
      return ok()
    }
    if (cmd.startsWith("rev-list --count")) return ok(`${repo.ahead}\n`)
    if (cmd === "status --porcelain") return ok(repo.dirty ? " M a.txt\n" : "")
    if (cmd.startsWith("branch --quiet -d")) return ok()
    if (cmd === "worktree list --porcelain") return ok(`worktree ${REPO}\nHEAD ${BASE}\nbranch refs/heads/main\n`)
    if (cmd === "diff --name-only -z HEAD") return ok(repo.local[dir]?.changed.map((file) => `${file}\0`).join("") ?? "")
    if (cmd === "ls-files --others --exclude-standard --full-name -z") {
      return ok(repo.local[dir]?.untracked.map((file) => `${file}\0`).join("") ?? "")
    }
    if (cmd.startsWith("diff --name-only -z ") && cmd.endsWith("...HEAD")) {
      return ok(repo.laneFiles.map((file) => `${file}\0`).join(""))
    }
    return fail
  }
}

type Setup = {
  fake: FakeContext
  repo: Repo
  log: string[][]
  worktree: { calls: Array<{ method: string; input: Record<string, unknown> }> }
  cleanup: () => Promise<void>
}

async function start(
  options: { opts?: Record<string, unknown>; repo?: Partial<Repo>; assert?: () => void; strategy?: "wt" | "git" } = {},
): Promise<Setup> {
  const fake = createFakeContext({
    directory: REPO,
    options: options.opts ?? {},
    agents: [
      { id: "general", name: "general", mode: "subagent" },
      { id: "explore", name: "explore", mode: "subagent" },
      { id: "build", name: "build", mode: "primary" },
      {
        id: "reviewer",
        name: "reviewer",
        mode: "subagent",
        permissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "deny" },
        ],
      },
    ],
    sessions: [
      { id: PARENT, projectID: "prj", location: { directory: REPO }, model: { id: "m", providerID: "p" } },
      { id: "ses_nested", parentID: PARENT, projectID: "prj", location: { directory: REPO } },
    ],
    ...(options.assert ? { assert: options.assert } : {}),
  })
  const repo: Repo = {
    git: true,
    branch: { [REPO]: "main" },
    ahead: 0,
    dirty: false,
    merge: { code: 0, stdout: "Merged", stderr: "" },
    laneFiles: ["hello.txt"],
    local: {},
    ...options.repo,
  }
  const worktree: Setup["worktree"] = { calls: [] }
  Object.assign(fake.context, {
    worktree: {
      create: async (input: Record<string, unknown>) => {
        worktree.calls.push({ method: "create", input })
        const directory = `/wt/${input.name}`
        if (options.strategy !== "git") repo.branch[directory] = String(input.name)
        return { directory }
      },
      remove: async (input: Record<string, unknown>) => void worktree.calls.push({ method: "remove", input }),
      refresh: async (input: Record<string, unknown>) => void worktree.calls.push({ method: "refresh", input }),
    },
  })
  Object.assign(fake.context.session, {
    remove: async (input: unknown) => void fake.calls.push({ method: "session.remove", input }),
  })
  const log: string[][] = []
  const plugin = createPlugin({ run: fakeRun(repo, log), suffix: () => "abc123", lookupMs: 20 })
  const cleanup = (await plugin.setup(fake.context)) as () => Promise<void>
  return { fake, repo, log, worktree, cleanup }
}

const call = (input: Record<string, unknown>, sessionID = PARENT) => ({
  tool: "subagent",
  sessionID,
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  input: { agent: "general", description: "Write hello", prompt: "Write hello.txt", ...input },
})

const lane = (fake: FakeContext, child = "ses_fake1") => fake.storage.get(laneKey(child)) as Lane | undefined

async function spawn(setup: Setup, input: Record<string, unknown> = {}) {
  return setup.fake.fire.tool("execute.before", call(input))
}

const completed = (child: string, content = "<subagent>done</subagent>") => ({
  tool: "subagent",
  sessionID: PARENT,
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  input: { agent: "general", sessionID: child, prompt: "x" },
  status: "completed" as const,
  result: { content, metadata: { sessionID: child, status: "completed" } } as Record<string, unknown>,
})

describe("setup", () => {
  test("registers the hooks and the merge tool, and cleans up", async () => {
    const { fake, cleanup } = await start()
    expect(fake.hooks("tool")).toEqual(["execute.before", "execute.after"])
    expect([...fake.tools.keys()]).toEqual([MERGE_TOOL])
    await cleanup()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
  })
})

describe("execute.before", () => {
  test("runs an opted-in subagent in a new worktree", async () => {
    const setup = await start()
    const event = await spawn(setup)
    const { fake, worktree } = setup

    expect(fake.asserts).toEqual([
      expect.objectContaining({ action: "subagent", resources: ["general"], sessionID: PARENT }),
    ])
    expect(worktree.calls).toEqual([
      { method: "create", input: { projectID: "prj", name: "subagent-write-hello-abc123", branch: BASE } },
    ])
    const create = fake.calls.find((entry) => entry.method === "session.create")
    expect(create?.input).toEqual({
      parentID: PARENT,
      title: "Write hello",
      agent: "general",
      model: { id: "m", providerID: "p" },
    })
    expect(fake.calls.find((entry) => entry.method === "session.move")?.input).toEqual({
      sessionID: "ses_fake1",
      directory: "/wt/subagent-write-hello-abc123",
    })
    expect(lane(fake)).toEqual({
      child: "ses_fake1",
      parent: PARENT,
      projectID: "prj",
      directory: "/wt/subagent-write-hello-abc123",
      branch: "subagent-write-hello-abc123",
      base: BASE,
      target: "main",
      parentDir: REPO,
      title: "Write hello",
      state: "active",
    })
    const input = event.input as unknown as { sessionID: string; prompt: string }
    expect(input.sessionID).toBe("ses_fake1")
    expect(input.prompt.startsWith(SUBAGENT_PREAMBLE)).toBe(true)
    expect(input.prompt).toContain("/wt/subagent-write-hello-abc123")
    expect(input.prompt.endsWith("Write hello.txt")).toBe(true)
  })

  test("gives a detached worktree (git strategy) a branch", async () => {
    const setup = await start({ strategy: "git" })
    await spawn(setup)
    expect(setup.log).toContainEqual([
      "git",
      "-C",
      "/wt/subagent-write-hello-abc123",
      "switch",
      "--quiet",
      "-c",
      "subagent-write-hello-abc123",
    ])
    expect(lane(setup.fake)?.branch).toBe("subagent-write-hello-abc123")
  })

  test.each([
    ["an agent that is not opted in", { agent: "explore" }, PARENT, {}],
    ["a continuation", { sessionID: "ses_other" }, PARENT, {}],
    ["a child caller", {}, "ses_nested", {}],
    ["a non-git project", {}, PARENT, { git: false }],
    ["a primary agent", { agent: "build" }, PARENT, {}],
    ["a read-only agent", { agent: "reviewer" }, PARENT, {}],
  ] as const)("leaves %s alone", async (_name, input, sessionID, repo) => {
    const setup = await start({ opts: { agents: ["general", "build", "reviewer"] }, repo })
    const original = call(input, sessionID)
    const event = await setup.fake.fire.tool("execute.before", { ...original, input: { ...original.input } })
    expect(event.input).toEqual(original.input)
    expect(setup.worktree.calls).toEqual([])
    expect(setup.fake.asserts).toEqual([])
  })

  test("a denied permission creates nothing", async () => {
    const setup = await start({
      assert: () => {
        throw new Error("denied")
      },
    })
    await expect(spawn(setup)).rejects.toThrow("denied")
    expect(setup.worktree.calls).toEqual([])
    expect(setup.fake.calls.some((entry) => entry.method === "session.create")).toBe(false)
  })

  test("a failure after the worktree exists removes it", async () => {
    const setup = await start()
    Object.assign(setup.fake.context.session, {
      move: async () => {
        throw new Error("move failed")
      },
    })
    await expect(spawn(setup)).rejects.toThrow("subagent-worktree: move failed")
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create", "remove"])
    expect(setup.fake.calls.some((entry) => entry.method === "session.remove")).toBe(true)
    expect(lane(setup.fake)).toBeUndefined()
  })
})

describe("execute.after", () => {
  test("annotates the result and keeps a lane with commits", async () => {
    const setup = await start()
    await spawn(setup)
    setup.repo.ahead = 1
    const event = await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    const result = event.result as { content: string; metadata: Record<string, unknown> }
    expect(result.content).toStartWith("<subagent>done</subagent>\n\n<subagent-worktree")
    expect(result.content).toContain("Commits ahead of base: 1")
    expect(result.content).toContain(`git -C ${REPO} diff ${BASE.slice(0, 12)}...subagent-write-hello-abc123`)
    expect(result.metadata.worktree).toEqual(expect.objectContaining({ branch: "subagent-write-hello-abc123" }))
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create"])
    expect(lane(setup.fake)?.state).toBe("active")
  })

  test("removes an empty, clean lane and moves the child back", async () => {
    const setup = await start()
    await spawn(setup)
    const event = await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    expect((event.result as { content: string }).content).toContain('state="removed"')
    expect(setup.worktree.calls.at(-1)).toEqual({
      method: "remove",
      input: { projectID: "prj", directory: "/wt/subagent-write-hello-abc123", force: false },
    })
    expect(setup.fake.calls.filter((entry) => entry.method === "session.move").at(-1)?.input).toEqual({
      sessionID: "ses_fake1",
      directory: REPO,
    })
    expect(lane(setup.fake)?.state).toBe("removed")
  })

  test("keeps a dirty lane and a background lane", async () => {
    const setup = await start()
    await spawn(setup)
    const running = completed("ses_fake1", "working")
    running.result.metadata = { sessionID: "ses_fake1", status: "running" }
    await setup.fake.fire.tool("execute.after", running)
    setup.repo.dirty = true
    await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create"])
  })

  test("ignores sessions without a lane", async () => {
    const setup = await start()
    const event = await setup.fake.fire.tool("execute.after", completed("ses_none"))
    expect((event.result as { content: string }).content).toBe("<subagent>done</subagent>")
  })

  test("continuing a removed lane gives it a fresh worktree", async () => {
    const setup = await start()
    await spawn(setup)
    await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    const event = await setup.fake.fire.tool("execute.before", call({ sessionID: "ses_fake1", prompt: "again" }))
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create", "remove", "create"])
    expect(lane(setup.fake)?.state).toBe("active")
    const prompt = (event.input as { prompt: string }).prompt
    expect(prompt.startsWith(SUBAGENT_PREAMBLE)).toBe(false)
    expect(prompt).toContain("isolated git worktree")
  })
})

describe(MERGE_TOOL, () => {
  const run = async (setup: Setup, input: Record<string, unknown>, sessionID = PARENT) => {
    const tool = setup.fake.tools.get(MERGE_TOOL) as unknown as {
      execute: (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>
    }
    return tool.execute(input, { sessionID, agent: "build", messageID: "msg_2", id: "call_2" })
  }

  test("merges with wt merge --no-squash --no-ff and retires the lane", async () => {
    const setup = await start()
    await spawn(setup)
    setup.repo.ahead = 2
    const result = await run(setup, { sessionID: "ses_fake1", method: "wt-merge" })
    expect(result.metadata.ok).toBe(true)
    expect(setup.fake.asserts.at(-1)).toEqual(
      expect.objectContaining({ action: MERGE_TOOL, resources: ["subagent-write-hello-abc123"] }),
    )
    expect(setup.log).toContainEqual([
      "wt",
      "-C",
      "/wt/subagent-write-hello-abc123",
      "merge",
      "main",
      "--no-squash",
      "--no-ff",
      "--yes",
    ])
    expect(lane(setup.fake)?.state).toBe("merged")
    expect(setup.worktree.calls.at(-1)?.method).toBe("refresh")
  })

  test("reports a conflict and keeps the worktree", async () => {
    const setup = await start({ repo: { merge: { code: 1, stdout: "", stderr: "CONFLICT (content): a.txt" } } })
    await spawn(setup)
    setup.repo.ahead = 1
    const result = await run(setup, { sessionID: "ses_fake1", method: "wt-merge" })
    expect(result.metadata).toEqual({ ok: false, conflict: true, code: 1 })
    expect(result.content).toContain("merge conflict")
    expect(result.content).toContain("kept at /wt/subagent-write-hello-abc123")
    expect(lane(setup.fake)?.state).toBe("active")
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create"])
  })

  test("refuses when the target checkout has local changes to files the lane changes", async () => {
    const setup = await start({
      repo: { laneFiles: ["a.ts", "hello.txt"], local: { [REPO]: { changed: ["a.ts"], untracked: ["hello.txt", "x"] } } },
    })
    await spawn(setup)
    setup.repo.ahead = 1
    const result = await run(setup, { sessionID: "ses_fake1", method: "wt-merge" })
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("main checkout has uncommitted or untracked changes")
    expect(result.content).toEndWith(": a.ts, hello.txt")
    expect(setup.log.some((argv) => argv[0] === "wt")).toBe(false)
    expect(setup.log).toContainEqual(["git", "-C", REPO, "diff", "--name-only", "-z", "HEAD"])
    expect(lane(setup.fake)?.state).toBe("active")

    setup.repo.local = { [REPO]: { changed: ["other.ts"], untracked: [] } }
    expect((await run(setup, { sessionID: "ses_fake1", method: "wt-merge" })).metadata.ok).toBe(true)
  })

  test("a target that is not checked out anywhere has no local changes", async () => {
    const setup = await start({ repo: { local: { [REPO]: { changed: ["hello.txt"], untracked: [] } } } })
    await spawn(setup)
    setup.repo.ahead = 1
    const result = await run(setup, { sessionID: "ses_fake1", method: "wt-merge", target: "release" })
    expect(result.metadata.ok).toBe(true)
  })

  test("refuses an uncommitted-only lane and says to continue the subagent", async () => {
    const setup = await start()
    await spawn(setup)
    setup.repo.dirty = true
    const result = await run(setup, { sessionID: "ses_fake1", method: "wt-merge" })
    expect(result.content).toContain("exists only as uncommitted changes")
    expect(result.content).toContain("sessionID ses_fake1")
    expect(setup.log.some((argv) => argv[0] === "wt")).toBe(false)
  })

  test("list reports active lanes and flags orphans without removing anything", async () => {
    const orphan: Lane = {
      child: "ses_gone_child",
      parent: "ses_gone_parent",
      projectID: "prj",
      directory: "/wt/orphan",
      branch: "subagent-orphan",
      base: BASE,
      parentDir: REPO,
      state: "active",
    }
    const setup = await start()
    await spawn(setup)
    setup.repo.ahead = 1
    setup.fake.storage.set(laneKey(orphan.child), orphan)
    setup.fake.storage.set(laneKey("ses_other"), { ...orphan, child: "ses_other", projectID: "prj2" })
    setup.fake.storage.set(laneKey("ses_done"), { ...orphan, child: "ses_done", state: "merged" })
    const slow = setup.fake.context.session.get
    Object.assign(setup.fake.context.session, {
      get: (input: { sessionID: string }) =>
        input.sessionID === "ses_fake1" ? new Promise(() => {}) : slow(input as never),
    })
    const result = await run(setup, { method: "list" })
    expect(result.metadata.ok).toBe(true)
    expect(result.content).toContain('count="2"')
    expect(result.content).toContain(
      "- subagent-orphan (sessionID ses_gone_child, parent ses_gone_parent) /wt/orphan ahead=1 dirty=no child=gone parent=gone ORPHAN: child session gone, parent session gone",
    )
    expect(result.content).toContain("subagent-write-hello-abc123 (sessionID ses_fake1, yours)")
    expect(result.content).toContain("child=unknown parent=alive")
    expect(result.content).not.toContain("ses_other")
    expect(result.content).not.toContain("ses_done")
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create"])
    expect(setup.fake.storage.get(laneKey(orphan.child))).toEqual(orphan)
  })

  test("wt-merge and none need a sessionID", async () => {
    const setup = await start()
    expect((await run(setup, { method: "none" })).content).toContain("sessionID is required")
  })

  test("refuses another session and an unknown lane; none only reports", async () => {
    const setup = await start()
    await spawn(setup)
    setup.repo.ahead = 1
    expect((await run(setup, { sessionID: "ses_fake1", method: "wt-merge" }, "ses_x")).content).toContain(
      "only the session",
    )
    expect((await run(setup, { sessionID: "ses_nope", method: "wt-merge" })).content).toContain("no worktree lane")
    const none = await run(setup, { sessionID: "ses_fake1", method: "none" })
    expect(none.content).toContain("Commits ahead of base: 1")
    expect(setup.log.some((argv) => argv[0] === "wt")).toBe(false)
  })
})
