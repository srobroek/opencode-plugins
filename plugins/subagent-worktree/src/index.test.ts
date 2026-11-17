import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { outsideLocks } from "@srobroek/opencode-lib/lease-lock"
import { createFakeContext, type FakeContext } from "@srobroek/opencode-lib/testing"
import { readClaim, writeLanding } from "@srobroek/opencode-lib/worktree-claims"
import type { RunResult } from "./git.ts"
import { createPlugin, SWEEP_TOOL } from "./index.ts"
import { type Lane, laneKey, MERGE_TOOL, SUBAGENT_PREAMBLE, UNBORN_NOTE } from "./lane.ts"

const BASE = "0123456789abcdef0123456789abcdef01234567"
const PARENT = "ses_parent"
const REPO = "/repo"
const OTHER = "/wt/other"
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98"

type Repo = {
  git: boolean
  /** A repository without a commit: HEAD does not resolve. */
  unborn?: boolean
  branch: Record<string, string | undefined>
  ahead: number
  dirty: boolean
  merge: RunResult
  /** Files the lane changes against its target. */
  laneFiles: string[]
  /** Uncommitted and untracked files in the target checkout, by directory. */
  local: Record<string, { changed: string[]; untracked: string[] }>
  /** HEAD commit by directory; BASE elsewhere. */
  heads: Record<string, string>
  porcelain: string
  /** Called with every git command before it is answered. */
  onCommand?: (cmd: string) => Promise<void> | void
}

function fakeRun(repo: Repo, log: string[][]) {
  return async (argv: string[]): Promise<RunResult> => {
    log.push(argv)
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })
    const fail = { code: 1, stdout: "", stderr: "fatal" }
    if (argv[0] === "wt") return repo.merge
    const [, , dir = "", ...args] = argv
    const cmd = args.join(" ")
    await repo.onCommand?.(cmd)
    if (cmd === "rev-parse --is-inside-work-tree") return repo.git ? ok("true\n") : fail
    if (repo.unborn && cmd.startsWith("rev-parse --verify")) return fail
    if (repo.unborn && cmd === "symbolic-ref --quiet HEAD") return ok("refs/heads/main\n")
    if (repo.unborn && cmd === "for-each-ref --count=1") return ok()
    // A lane branch points where its worktree is: the ref follows the worktree's HEAD.
    const ref = /^rev-parse --verify --quiet refs\/heads\/(.+)\^\{commit\}$/.exec(cmd)
    if (ref) return ok(`${repo.heads[`/wt/${ref[1]}`] ?? BASE}\n`)
    if (cmd.startsWith("rev-parse --verify")) return ok(`${repo.heads[dir] ?? BASE}\n`)
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
    if (cmd === "status --porcelain --untracked-files=no -- :(top) :(top,exclude).beads") return ok(repo.local[dir]?.changed.length ? " M a.txt\n" : "")
    if (cmd.startsWith("branch --quiet -d")) return ok()
    if (cmd.startsWith("stash list")) return ok()
    if (cmd.startsWith("update-ref -d")) return ok()
    if (cmd === "worktree list --porcelain") return repo.git ? ok(repo.porcelain) : fail
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

const COMMONS: string[] = []
afterAll(() => {
  for (const root of COMMONS) rmSync(root, { recursive: true, force: true })
})

type Setup = {
  common: string
  fake: FakeContext
  repo: Repo
  log: string[][]
  worktree: { calls: Array<{ method: string; input: Record<string, unknown> }> }
  cleanup: () => Promise<void>
}

async function start(
  options: {
    opts?: Record<string, unknown>
    repo?: Partial<Repo>
    assert?: () => void
    strategy?: "wt" | "git"
    tools?: Array<Record<string, unknown> & { name: string }>
    exists?: (path: string) => Promise<boolean>
    now?: () => number
    commonDir?: (directory: string) => Promise<string | undefined>
    /** Called inside the host removal, i.e. while the removal holds the directory lock. */
    onRemove?: () => void
  } = {},
): Promise<Setup> {
  const fake = createFakeContext({
    directory: REPO,
    options: options.opts ?? {},
    agents: [
      { id: "coder", name: "coder", mode: "subagent" },
      { id: "general", name: "general", mode: "subagent" },
      { id: "explore", name: "explore", mode: "subagent" },
      { id: "pinned", name: "pinned", mode: "subagent", model: { id: "y", providerID: "prov" } },
      { id: "build", name: "build", mode: "primary" },
      {
        id: "asking",
        name: "asking",
        mode: "subagent",
        permissions: [
          { action: "edit", resource: "*", effect: "deny" },
          { action: "edit", resource: "src/*", effect: "ask" },
        ],
      },
      {
        id: "scoped",
        name: "scoped",
        mode: "subagent",
        permissions: [
          { action: "edit", resource: "*", effect: "deny" },
          { action: "edit", resource: "src/*", effect: "allow" },
        ],
      },
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
      { id: "ses_in_other", projectID: "prj", location: { directory: OTHER } },
    ],
    ...(options.assert ? { assert: options.assert } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
  })
  const repo: Repo = {
    git: true,
    branch: { [REPO]: "main", [OTHER]: "feat" },
    ahead: 0,
    dirty: false,
    merge: { code: 0, stdout: "Merged", stderr: "" },
    laneFiles: ["hello.txt"],
    local: {},
    heads: { [OTHER]: OTHER_HEAD },
    porcelain: `worktree ${REPO}\nHEAD ${BASE}\nbranch refs/heads/main\n\nworktree ${OTHER}\nHEAD ${OTHER_HEAD}\nbranch refs/heads/feat\n`,
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
      remove: async (input: Record<string, unknown>) => {
        expect(fake.sessions.get("ses_fake1")?.location).toEqual({ directory: REPO })
        worktree.calls.push({ method: "remove", input })
        options.onRemove?.()
      },
      refresh: async (input: Record<string, unknown>) => void worktree.calls.push({ method: "refresh", input }),
    },
  })
  Object.assign(fake.context.session, {
    remove: async (input: unknown) => void fake.calls.push({ method: "session.remove", input }),
  })
  const common = mkdtempSync(join(tmpdir(), "common-"))
  COMMONS.push(common)
  const log: string[][] = []
  const plugin = createPlugin({ commonDir: options.commonDir ?? (async () => common), run: async (argv) => {
    if (argv[0] === "wt") expect(fake.sessions.get("ses_fake1")?.location).toEqual({ directory: REPO })
    return fakeRun(repo, log)(argv)
  }, suffix: () => "abc123", lookupMs: 20, directoryExists: options.exists ?? (async () => true), ...(options.now ? { now: options.now } : {}), reserveMs: 60_000 })
  const cleanup = (await plugin.setup(fake.context)) as () => Promise<void>
  return { common, fake, repo, log, worktree, cleanup }
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

async function spawn(setup: Setup, input: Record<string, unknown> = {}, sessionID = PARENT) {
  return setup.fake.fire.tool("execute.before", call(input, sessionID))
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
    expect(fake.hooks("tool")).toEqual(["execute.before", "execute.after", "execute.after"])
    expect([...fake.tools.keys()]).toEqual([MERGE_TOOL, SWEEP_TOOL])
    await cleanup()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
  })
})

describe("execute.before", () => {
  test("coder gets an automatic lane by default", async () => {
    const setup = await start()
    await spawn(setup, { agent: "coder" })
    expect(setup.worktree.calls[0]?.method).toBe("create")
  })

  test.each([OTHER, false] as const)("resuming with worktree %j keeps the session in place and notes it once", async (worktree) => {
    const setup = await start()
    const event = await spawn(setup, { sessionID: "ses_in_other", worktree })
    expect(event.input).toEqual(call({ sessionID: "ses_in_other" }).input)
    expect(setup.worktree.calls).toEqual([])
    expect(setup.fake.calls.some((entry) => entry.method === "session.move")).toBe(false)
    const result = await setup.fake.fire.tool("execute.after", completed("ses_in_other"))
    expect((result.result as { content: string }).content).toContain("subagent-worktree: ignored `worktree` on a resumed session; it keeps its directory.")
    const again = await setup.fake.fire.tool("execute.after", completed("ses_in_other"))
    expect((again.result as { content: string }).content).toBe("<subagent>done</subagent>")
  })

  test("dirty caller tracked files keep an automatic coder in place with an explanation", async () => {
    const setup = await start({ repo: { local: { [OTHER]: { changed: ["a.ts"], untracked: [] } } } })
    const event = await spawn(setup, { agent: "coder" }, "ses_in_other")
    expect((event.input as { sessionID?: string }).sessionID).toBeUndefined()
    expect(setup.worktree.calls).toEqual([])
    const result = await setup.fake.fire.tool("execute.after", completed("ses_x"))
    expect((result.result as { content: string }).content).toContain("uncommitted changes to tracked files")
    expect((result.result as { content: string }).content).toContain("Passing `worktree` forces a lane.")
    await spawn(setup, { agent: "coder", worktree: "feat" }, "ses_in_other")
    expect(setup.worktree.calls[0]?.method).toBe("create")
  })

  test("untracked caller files alone do not skip isolation", async () => {
    const setup = await start({ repo: { local: { [REPO]: { changed: [], untracked: ["new.ts"] } } } })
    await spawn(setup, { agent: "coder" })
    expect(setup.worktree.calls[0]?.method).toBe("create")
  })
  test.each([{ worktree: false }, { prompt: "Working directory: /elsewhere/repo" }])("skips unneeded lanes: %j", async (input) => {
    const setup = await start()
    const event = await spawn(setup, input)
    expect(setup.worktree.calls).toEqual([])
    expect(setup.fake.calls.some((call) => call.method === "session.create")).toBe(false)
    expect((event.input as Record<string, unknown>).worktree).toBeUndefined()
  })
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

  test.each([
    ["the spawn's model and variant", "pinned", { model: "prov/x#high" }, { providerID: "prov", id: "x", variant: "high" }],
    ["the spawn's model without a variant", "pinned", { model: "prov/x" }, { providerID: "prov", id: "x" }],
    ["the agent's model when the spawn names none", "pinned", {}, { id: "y", providerID: "prov" }],
    ["the parent's model when neither names one", "general", {}, { id: "m", providerID: "p" }],
  ])("starts the child on %s", async (_name, agent, extra, expected) => {
    const setup = await start({ opts: { agents: ["pinned", "general"] } })
    await spawn(setup, { agent, description: "Write hello", prompt: "Write hello.txt", ...extra })
    const create = setup.fake.calls.find((entry) => entry.method === "session.create")
    expect((create?.input as { model?: unknown } | undefined)?.model).toEqual(expected)
  })

  test("runs in place and notes it when the repository has no commit yet", async () => {
    const setup = await start({ repo: { unborn: true } })
    const event = await spawn(setup)
    expect(setup.worktree.calls).toEqual([])
    expect(setup.fake.calls.some((call) => call.method === "session.create")).toBe(false)
    expect((event.input as { sessionID?: string }).sessionID).toBeUndefined()
    const result = await setup.fake.fire.tool("execute.after", {
      ...completed("ses_x"),
      input: { agent: "general", prompt: "x" },
      result: { content: "<subagent>done</subagent>", metadata: {} },
    })
    expect((result as { result: { content: string } }).result.content).toContain(UNBORN_NOTE)
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

describe("worktree argument", () => {
  const subagentTool = {
    name: "subagent",
    description: "Spawns an agent",
    input: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"], additionalProperties: false },
  }
  const moves = (fake: FakeContext) => fake.calls.filter((entry) => entry.method === "session.move").map((entry) => entry.input)

  test("offers worktree on the subagent tool", async () => {
    const { fake, cleanup } = await start({ tools: [subagentTool] })
    const input = fake.tools.get("subagent")?.input as { properties: Record<string, { description: string }>; required: string[] }
    expect(Object.keys(input.properties)).toEqual(["agent", "worktree"])
    expect(input.properties.worktree?.description).toStartWith("New spawns only. Omit for defaults:")
    expect(input.required).toEqual(["agent"])
    expect(fake.tools.get("subagent")?.description).toBe("Spawns an agent")
    await cleanup()
  })

  test("a read-only agent runs in the named worktree", async () => {
    const setup = await start()
    const event = await spawn(setup, { agent: "explore", worktree: OTHER, prompt: `${SUBAGENT_PREAMBLE}\nLook` })
    expect(setup.worktree.calls).toEqual([])
    expect(setup.fake.asserts).toEqual([expect.objectContaining({ action: "subagent", resources: ["explore"] })])
    expect(setup.fake.calls.find((entry) => entry.method === "session.create")?.input).toEqual(
      expect.objectContaining({ parentID: PARENT, agent: "explore" }),
    )
    expect(moves(setup.fake)).toEqual([{ sessionID: "ses_fake1", directory: OTHER }])
    const input = event.input as Record<string, string>
    expect(input.worktree).toBeUndefined()
    expect(input.sessionID).toBe("ses_fake1")
    expect(input.prompt).toBe(
      `${SUBAGENT_PREAMBLE}\nYou work in the git worktree ${OTHER} (branch feat). Run every command and read every file there.\n\nLook`,
    )
    expect(lane(setup.fake)).toBeUndefined()
  })

  test("a writer gets a fresh worktree branched from the named worktree's HEAD", async () => {
    const setup = await start({ opts: { base: "main" } })
    await spawn(setup, { worktree: "feat" })
    expect(setup.worktree.calls).toEqual([
      { method: "create", input: { projectID: "prj", name: "subagent-write-hello-abc123", branch: OTHER_HEAD } },
    ])
    expect(lane(setup.fake)).toEqual(
      expect.objectContaining({ base: OTHER_HEAD, target: "feat", parentDir: OTHER, directory: "/wt/subagent-write-hello-abc123" }),
    )
    setup.repo.ahead = 1
    const tool = setup.fake.tools.get(MERGE_TOOL) as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> }
    await tool.execute({ sessionID: "ses_fake1", method: "wt-merge" }, { sessionID: PARENT, agent: "build", messageID: "m", id: "c" })
    expect(setup.log).toContainEqual(["wt", "-C", "/wt/subagent-write-hello-abc123", "merge", "feat", "--no-squash", "--no-ff", "--yes"])
  })

  describe("single writer per worktree", () => {
    const running = { busy: 2000 }
    const writerIn = (setup: Setup, id: string, time: Record<string, number>, extra: Record<string, unknown> = {}, directory = OTHER) =>
      setup.fake.sessions.set(id, { id, parentID: PARENT, projectID: "prj", location: { directory }, time, ...extra })
    const sessionID = (event: { input: unknown }) => (event.input as { sessionID?: string }).sessionID

    test("refuses a second writer and names the live session", async () => {
      const setup = await start()
      writerIn(setup, "ses_live", running)
      await expect(spawn(setup, { agent: "pinned", worktree: "feat" })).rejects.toThrow(
        /ses_live.*Send that session a follow-up \(pass sessionID: "ses_live"\).*or stop it first/s,
      )
      expect(setup.fake.calls.some((entry) => entry.method === "session.create")).toBe(false)
    })

    test("refuses a resumed writer that still shows its earlier outcome", async () => {
      const setup = await start()
      writerIn(setup, "ses_resumed", { idle: 1000, busy: 2000 }, { outcome: "interrupted" })
      await expect(spawn(setup, { agent: "pinned", worktree: "feat" })).rejects.toThrow(/live writer session ses_resumed/)
    })

    test("allows a writer when the earlier one is idle after its last run", async () => {
      const setup = await start()
      writerIn(setup, "ses_done", { busy: 1000, idle: 2000 }, { outcome: "succeeded" })
      expect(sessionID(await spawn(setup, { agent: "pinned", worktree: "feat" }))).toBe("ses_fake1")
    })

    test("checks the caller's own worktree when it is named", async () => {
      const setup = await start()
      writerIn(setup, "ses_live", running, {}, REPO)
      await expect(spawn(setup, { agent: "pinned", worktree: "main" })).rejects.toThrow(/live writer session ses_live/)
    })

    test("does not check for an agent that gets a fresh lane", async () => {
      const setup = await start()
      writerIn(setup, "ses_live", running)
      await spawn(setup, { agent: "general", worktree: "feat" })
      expect(setup.worktree.calls[0]?.method).toBe("create")
      expect(setup.fake.calls.some((entry) => entry.method === "session.list")).toBe(false)
    })

    test("a read-only agent is unaffected by a live writer", async () => {
      const setup = await start()
      writerIn(setup, "ses_live", running)
      expect(sessionID(await spawn(setup, { agent: "reviewer", worktree: "feat" }))).toBe("ses_fake1")
    })

    test("a live reviewer whose session rules grant edit still blocks a writer", async () => {
      const setup = await start()
      writerIn(setup, "ses_review", running, { agent: "reviewer", permissions: [{ action: "edit", resource: "*", effect: "allow" }] })
      await expect(spawn(setup, { agent: "pinned", worktree: "feat" })).rejects.toThrow(/live writer session ses_review/)
    })

    test("a live writer agent whose session rules deny edit does not block a writer", async () => {
      const setup = await start()
      writerIn(setup, "ses_limited", running, { agent: "pinned", permissions: [{ action: "edit", resource: "*", effect: "deny" }] })
      expect(sessionID(await spawn(setup, { agent: "pinned", worktree: "feat" }))).toBe("ses_fake1")
    })

    test("a read-only agent whose parent session grants scoped edit is guarded as a writer", async () => {
      const setup = await start()
      Object.assign(setup.fake.sessions.get(PARENT) ?? {}, { permissions: [{ action: "edit", resource: "src/*", effect: "allow" }] })
      writerIn(setup, "ses_live", running)
      await expect(spawn(setup, { agent: "reviewer", worktree: "feat" })).rejects.toThrow(/live writer session ses_live/)
    })

    test("a spawning agent with a scoped edit ask is guarded as a writer", async () => {
      const setup = await start()
      writerIn(setup, "ses_live", running)
      await expect(spawn(setup, { agent: "asking", worktree: "feat" })).rejects.toThrow(/live writer session ses_live/)
    })

    test("a live agent with a scoped edit ask counts as a writer", async () => {
      const setup = await start()
      writerIn(setup, "ses_asking", running, { agent: "asking" })
      await expect(spawn(setup, { agent: "pinned", worktree: "feat" })).rejects.toThrow(/live writer session ses_asking/)
    })

    test("a live reviewer whose session rules ask for scoped edit counts as a writer", async () => {
      const setup = await start()
      writerIn(setup, "ses_review", running, { agent: "reviewer", permissions: [{ action: "edit", resource: "src/*", effect: "ask" }] })
      await expect(spawn(setup, { agent: "pinned", worktree: "feat" })).rejects.toThrow(/live writer session ses_review/)
    })

    test("a spawning agent with a scoped edit grant is guarded as a writer", async () => {
      const setup = await start()
      writerIn(setup, "ses_live", running)
      await expect(spawn(setup, { agent: "scoped", worktree: "feat" })).rejects.toThrow(/live writer session ses_live/)
    })

    test("a live reviewer is not a writer", async () => {
      const setup = await start()
      writerIn(setup, "ses_review", running, { agent: "reviewer" })
      expect(sessionID(await spawn(setup, { agent: "pinned", worktree: "feat" }))).toBe("ses_fake1")
    })

    test("resuming the live session itself still works", async () => {
      const setup = await start()
      writerIn(setup, "ses_live", running)
      expect(sessionID(await spawn(setup, { agent: "pinned", sessionID: "ses_live", worktree: "feat" }))).toBe("ses_live")
    })

    test("finds a live writer on a later page", async () => {
      const setup = await start()
      for (let n = 0; n < 101; n++) writerIn(setup, `ses_old${n}`, { busy: 1000, idle: 2000, updated: 5000 })
      writerIn(setup, "ses_late", { ...running, updated: 1 })
      await expect(spawn(setup, { agent: "pinned", worktree: "feat" })).rejects.toThrow(/live writer session ses_late/)
    })

    test("allows the spawn and warns when the host cannot list sessions", async () => {
      const setup = await start()
      Object.assign(setup.fake.context.session, {
        list: async () => {
          throw new Error("unavailable")
        },
      })
      await spawn(setup, { agent: "pinned", worktree: "feat" })
      const result = await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
      expect((result.result as { content: string }).content).toContain("could not check whether the worktree already has a live writer")
    })

    test("allows the spawn within the deadline and warns when the list never settles", async () => {
      const setup = await start()
      Object.assign(setup.fake.context.session, { list: () => new Promise(() => {}) })
      const started = Date.now()
      const event = await spawn(setup, { agent: "pinned", worktree: "feat" })
      expect(Date.now() - started).toBeLessThan(1000)
      expect(sessionID(event)).toBe("ses_fake1")
      const result = await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
      expect((result.result as { content: string }).content).toContain("could not check whether the worktree already has a live writer")
    })
  })

  describe("reservation of a worktree by an in-flight writer spawn", () => {
    const sessionID = (event: { input: unknown }) => (event.input as { sessionID?: string }).sessionID
    const second = (setup: Setup) => setup.fake.fire.tool("execute.before", { ...call({ agent: "pinned", worktree: "feat" }), id: "call_2" })
    const first = (setup: Setup) => spawn(setup, { agent: "pinned", worktree: "feat" })
    const failCreateOnce = (setup: Setup) => {
      const original = setup.fake.context.session.create.bind(setup.fake.context.session)
      let failed = false
      Object.assign(setup.fake.context.session, {
        create: async (input: never) => {
          if (!failed) {
            failed = true
            throw new Error("create failed")
          }
          return original(input)
        },
      })
    }

    test("two concurrent spawns: the second is refused", async () => {
      const setup = await start()
      const results = await Promise.allSettled([first(setup), second(setup)])
      const outcomes = results.map((result) => result.status).sort()
      expect(outcomes).toEqual(["fulfilled", "rejected"])
      const refused = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
      expect(String(refused?.reason)).toMatch(/already has a (live writer session|writer spawn in progress)/)
    })

    test("a later spawn is refused and names the reserving session", async () => {
      const setup = await start()
      await first(setup)
      await expect(second(setup)).rejects.toThrow(/live writer session ses_fake1/)
    })

    test("a spawn that finished releases the worktree", async () => {
      const setup = await start()
      await first(setup)
      await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
      expect(sessionID(await second(setup))).toBe("ses_fake2")
    })

    test("a failed spawn releases the worktree", async () => {
      const setup = await start()
      failCreateOnce(setup)
      await expect(first(setup)).rejects.toThrow(/create failed/)
      expect(sessionID(await second(setup))).toBeDefined()
    })

    test("the reservation expires", async () => {
      let clock = 1_000_000
      const setup = await start({ now: () => clock })
      await first(setup)
      clock += 59_000
      await expect(second(setup)).rejects.toThrow(/writer/)
      clock += 2_000
      expect(sessionID(await second(setup))).toBeDefined()
    })

    const backgroundDone = () => ({
      ...completed("ses_fake1"),
      result: { content: "started", metadata: { sessionID: "ses_fake1", status: "running" } } as Record<string, unknown>,
    })

    test("reserves before the liveness lookup, so a concurrent spawn is refused while it is pending", async () => {
      const setup = await start()
      let open: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        open = resolve
      })
      const list = setup.fake.context.session.list.bind(setup.fake.context.session)
      let listing: () => void = () => {}
      const listed = new Promise<void>((resolve) => {
        listing = resolve
      })
      Object.assign(setup.fake.context.session, {
        list: async (input: never) => {
          listing()
          await gate
          return list(input)
        },
      })
      const a = first(setup)
      await listed
      await expect(second(setup)).rejects.toThrow(/writer spawn in progress/)
      open()
      expect(sessionID(await a)).toBe("ses_fake1")
    })

    test("a background child keeps the worktree reserved until it is observed busy", async () => {
      const setup = await start()
      await first(setup)
      await setup.fake.fire.tool("execute.after", backgroundDone())
      await expect(second(setup)).rejects.toThrow(/live writer session ses_fake1/)
    })

    test("a background child that has started is caught by the live lookup, not the reservation", async () => {
      const setup = await start()
      await first(setup)
      await setup.fake.fire.tool("execute.after", backgroundDone())
      Object.assign(setup.fake.sessions.get("ses_fake1") ?? {}, { projectID: "prj", time: { busy: 2000 } })
      await expect(second(setup)).rejects.toThrow(/live writer session ses_fake1/)
      Object.assign(setup.fake.sessions.get("ses_fake1") ?? {}, { time: { busy: 2000, idle: 3000 } })
      expect(sessionID(await second(setup))).toBeDefined()
    })

    test("a background child that never starts frees the worktree when the hold expires", async () => {
      let clock = 1_000_000
      const setup = await start({ now: () => clock })
      await first(setup)
      await setup.fake.fire.tool("execute.after", backgroundDone())
      clock += 59_000
      await expect(second(setup)).rejects.toThrow(/live writer session ses_fake1/)
      clock += 2_000
      expect(sessionID(await second(setup))).toBeDefined()
    })

    /** A first spawn stuck on its permission prompt; `open` lets it continue. */
    const stuckSpawn = async (setup: Setup) => {
      let open: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        open = resolve
      })
      let reached: () => void = () => {}
      const waiting = new Promise<void>((resolve) => {
        reached = resolve
      })
      const assertPermission = setup.fake.context.permission.assert.bind(setup.fake.context.permission)
      let waits = 0
      Object.assign(setup.fake.context.permission, {
        assert: async (input: never) => {
          if (waits++ === 0) {
            reached()
            await gate
          }
          return assertPermission(input)
        },
      })
      const outcome = first(setup).then(
        (event) => sessionID(event),
        (error: Error) => error.message,
      )
      await waiting
      return { open, outcome }
    }
    const creates = (setup: Setup) => setup.fake.calls.filter((entry) => entry.method === "session.create")

    test("a spawn whose reservation was replaced while it waited is fenced out and creates no child", async () => {
      let clock = 1_000_000
      const setup = await start({ now: () => clock })
      const stuck = await stuckSpawn(setup)
      clock += 61_000
      expect(sessionID(await second(setup))).toBe("ses_fake1")
      stuck.open()
      expect(await stuck.outcome).toMatch(/took over this worktree/)
      expect(creates(setup)).toHaveLength(1)
    })

    test("a spawn whose reservation merely expired while it waited re-takes it and continues", async () => {
      let clock = 1_000_000
      const setup = await start({ now: () => clock })
      const stuck = await stuckSpawn(setup)
      clock += 61_000
      stuck.open()
      expect(await stuck.outcome).toBe("ses_fake1")
      await expect(second(setup)).rejects.toThrow(/live writer session ses_fake1/)
    })

    test("a spawn whose reservation expired is refused when a live writer appeared meanwhile", async () => {
      let clock = 1_000_000
      const setup = await start({ now: () => clock })
      const stuck = await stuckSpawn(setup)
      clock += 61_000
      setup.fake.sessions.set("ses_late", { id: "ses_late", parentID: PARENT, projectID: "prj", location: { directory: OTHER }, time: { busy: 2000 } })
      stuck.open()
      expect(await stuck.outcome).toMatch(/live writer session ses_late/)
      expect(creates(setup)).toHaveLength(0)
    })

    test("a tool error on the first spawn releases the worktree for the next writer", async () => {
      const setup = await start()
      await first(setup)
      await setup.fake.fire.tool("execute.after", {
        ...completed("ses_fake1"),
        status: "error" as const,
        error: new ToolError({ message: "boom" }),
      } as never)
      expect(sessionID(await second(setup))).toBe("ses_fake2")
    })

    test("a background spawn into the caller's own worktree ties its child to the reservation", async () => {
      const setup = await start()
      const own = (id: string) => setup.fake.fire.tool("execute.before", { ...call({ agent: "pinned", worktree: "main" }), id })
      await own("call_1")
      setup.fake.sessions.set("ses_bg", { id: "ses_bg", parentID: PARENT, projectID: "prj", location: { directory: REPO }, time: { busy: 1000, idle: 2000 } })
      await setup.fake.fire.tool("execute.after", {
        ...completed("ses_bg"),
        input: { agent: "pinned", prompt: "x" },
        result: { content: "started", metadata: { sessionID: "ses_bg", status: "running" } },
      })
      // The child has finished: only the reservation could still block, and it follows the child.
      await expect(own("call_2")).resolves.toBeDefined()
    })

    test("a child lookup that never settles keeps the reservation without hanging the next spawn", async () => {
      const setup = await start()
      await first(setup)
      await setup.fake.fire.tool("execute.after", backgroundDone())
      const get = setup.fake.context.session.get.bind(setup.fake.context.session)
      Object.assign(setup.fake.context.session, {
        get: (input: { sessionID: string }) => (input.sessionID === "ses_fake1" ? new Promise(() => {}) : get(input)),
      })
      const started = Date.now()
      await expect(second(setup)).rejects.toThrow(/live writer session ses_fake1/)
      expect(Date.now() - started).toBeLessThan(1000)
    })

    test("a re-taken reservation keeps the warning when the fresh liveness lookup fails", async () => {
      let clock = 1_000_000
      const setup = await start({ now: () => clock })
      const stuck = await stuckSpawn(setup)
      clock += 61_000
      Object.assign(setup.fake.context.session, {
        list: async () => {
          throw new Error("unavailable")
        },
      })
      stuck.open()
      expect(await stuck.outcome).toBe("ses_fake1")
      const result = await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
      expect((result.result as { content: string }).content).toContain("could not check whether the worktree already has a live writer")
    })

    test("a read-only agent neither reserves nor is blocked", async () => {
      const setup = await start()
      await spawn(setup, { agent: "reviewer", worktree: "feat" })
      expect(sessionID(await second(setup))).toBeDefined()
    })
  })

  test("a parent already in a worktree: children start there and writers branch from it", async () => {
    const setup = await start()
    const original = call({ agent: "explore" }, "ses_in_other")
    const event = await setup.fake.fire.tool("execute.before", { ...original, input: { ...original.input } })
    expect(event.input).toEqual(original.input)
    await spawn(setup, {}, "ses_in_other")
    expect(setup.worktree.calls[0]?.input).toEqual(expect.objectContaining({ branch: OTHER_HEAD }))
    expect(lane(setup.fake)).toEqual(expect.objectContaining({ parentDir: OTHER, target: "feat" }))
  })

  test("naming the caller's own worktree only drops the argument", async () => {
    const setup = await start()
    const event = await spawn(setup, { agent: "explore", worktree: "main" })
    expect(event.input).toEqual(call({ agent: "explore" }).input)
    expect(setup.fake.calls.some((entry) => entry.method === "session.create")).toBe(false)
  })

  test.each([
    ["a path outside the project", { worktree: "/elsewhere" }, {}, "is not a worktree of this project"],
    ["a non-git caller", { agent: "explore", worktree: OTHER }, { git: false }, "not in a git checkout"],
  ] as const)("refuses %s", async (_name, input, repo, message) => {
    const setup = await start({ repo })
    await expect(spawn(setup, input)).rejects.toThrow(message)
    expect(setup.worktree.calls).toEqual([])
    expect(setup.fake.calls.some((entry) => entry.method === "session.create")).toBe(false)
  })

  test("a failed move removes the child session", async () => {
    const setup = await start()
    Object.assign(setup.fake.context.session, {
      move: async () => {
        throw new Error("move failed")
      },
    })
    await expect(spawn(setup, { agent: "explore", worktree: OTHER })).rejects.toThrow("subagent-worktree: move failed")
    expect(setup.fake.calls.some((entry) => entry.method === "session.remove")).toBe(true)
  })
})

describe("execute.after", () => {
  test("a failed move prevents removal", async () => {
    const setup = await start()
    await spawn(setup)
    Object.assign(setup.fake.context.session, { move: async () => { throw new Error("move failed") } })
    await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    expect(setup.worktree.calls.map((call) => call.method)).toEqual(["create"])
    expect(lane(setup.fake)?.state).toBe("active")
  })
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
    expect(setup.worktree.calls.slice(-2)).toEqual([
      { method: "remove", input: { projectID: "prj", directory: "/wt/subagent-write-hello-abc123", force: false } },
      { method: "refresh", input: { projectID: "prj" } },
    ])
    expect(setup.fake.calls.filter((entry) => entry.method === "session.move").at(-1)?.input).toEqual({
      sessionID: "ses_fake1",
      directory: REPO,
    })
    expect(lane(setup.fake)?.state).toBe("removed")
  })

  test("a new lane is claimed on disk for every other remover to read", async () => {
    const setup = await start()
    await spawn(setup)
    const created = lane(setup.fake)
    expect(created?.state).toBe("active")
    expect(readClaim(setup.common, created?.directory ?? "")).toEqual({
      kind: "present",
      value: expect.objectContaining({
        directory: created?.directory,
        branch: created?.branch,
        sessionID: "ses_fake1",
        parentID: PARENT,
      }),
    })
  })

  test("the claim is deleted when the lane is retired", async () => {
    const setup = await start()
    await spawn(setup)
    const directory = lane(setup.fake)?.directory ?? ""
    await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    expect(lane(setup.fake)?.state).toBe("removed")
    expect(readClaim(setup.common, directory)).toEqual({ kind: "missing" })
  })

  test("a lane whose claim cannot be placed is not created", async () => {
    const setup = await start({ commonDir: async () => undefined })
    await expect(spawn(setup)).rejects.toThrow("cannot find the git common directory")
    expect(lane(setup.fake)).toBeUndefined()
  })

  test("a resume that races the removal of an empty foreground lane leaves it in place", async () => {
    const setup = await start()
    await spawn(setup)
    let resumed = false
    setup.repo.onCommand = async (cmd) => {
      if (cmd === "status --porcelain" && !resumed) {
        resumed = true
        await setup.fake.fire.tool("execute.before", call({ sessionID: "ses_fake1", prompt: "one more thing" }))
      }
    }
    const event = await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    expect(resumed).toBe(true)
    expect((event.result as { content: string }).content).not.toContain('state="removed"')
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create"])
    expect(lane(setup.fake)?.state).toBe("active")
  })

  test("a commit that lands between the empty check and the HEAD read keeps the lane and its branch", async () => {
    const setup = await start()
    await spawn(setup)
    const directory = lane(setup.fake)?.directory ?? ""
    let landed = false
    setup.repo.onCommand = (cmd) => {
      if (cmd === "status --porcelain" && !landed) {
        landed = true
        setup.repo.heads[directory] = "9".repeat(40)
      }
    }
    const event = await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    expect(landed).toBe(true)
    expect((event.result as { content: string }).content).not.toContain('state="removed"')
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create"])
    expect(setup.log.some((argv) => argv.includes("update-ref"))).toBe(false)
    expect(lane(setup.fake)?.state).toBe("active")
  })

  test("a resume waiting on the lock revives the lane, and the revived lane and its claim survive the retirement", async () => {
    let resumed: Promise<unknown> | undefined
    let setup: Setup | undefined
    setup = await start({
      onRemove: () => {
        // The removal holds the directory lock; the resume has to queue behind it.
        resumed = setup?.fake.fire.tool("execute.before", call({ sessionID: "ses_fake1", prompt: "again" }))
      },
    })
    // Storage takes a moment to write a retirement, as a real one does.
    const storage = setup.fake.context.storage as unknown as { set: (key: string, value: unknown) => Promise<void> }
    const write = storage.set.bind(storage)
    storage.set = async (key, value) => {
      if ((value as { state?: string })?.state !== undefined && (value as { state: string }).state !== "active") {
        await new Promise((done) => setTimeout(done, 15))
      }
      return write(key, value)
    }
    await spawn(setup)
    await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    await resumed
    const revived = lane(setup.fake)
    expect(setup.worktree.calls.map((entry) => entry.method).filter((method) => method === "create")).toHaveLength(2)
    expect(revived?.state).toBe("active")
    expect(readClaim(setup.common, revived?.directory ?? "").kind).toBe("present")
  })

  test("a resume in another plugin instance that arrives mid-removal waits on the disk lock, then revives the lane", async () => {
    let resumed: Promise<unknown> | undefined
    let b: Setup | undefined
    const a = await start({
      onRemove: () => {
        // Instance A holds the directory's disk lock here; instance B's resume has to queue behind it.
        resumed = outsideLocks(() => b?.fake.fire.tool("execute.before", call({ sessionID: "ses_fake1", prompt: "again" })))
      },
    })
    b = await start({ commonDir: async () => a.common })
    // One lane store behind both instances, as the host has.
    Object.assign(b.fake.context.storage, a.fake.context.storage)
    await spawn(a)
    const session = a.fake.sessions.get("ses_fake1")
    if (session) b.fake.sessions.set("ses_fake1", session)
    await a.fake.fire.tool("execute.after", completed("ses_fake1"))
    await resumed
    expect(a.worktree.calls.map((entry) => entry.method)).toContain("remove")
    expect(b.worktree.calls.map((entry) => entry.method)).toContain("create")
    const revived = lane(a.fake)
    expect(revived?.state).toBe("active")
    expect(readClaim(a.common, revived?.directory ?? "").kind).toBe("present")
    await a.cleanup()
    await b.cleanup()
  })

  test("without that resume the same foreground lane is removed", async () => {
    const setup = await start()
    await spawn(setup)
    const event = await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    expect((event.result as { content: string }).content).toContain('state="removed"')
  })

  test("a denial delivery recorded for the lane keeps even an empty foreground lane", async () => {
    const setup = await start()
    await spawn(setup)
    const directory = lane(setup.fake)?.directory ?? ""
    writeLanding(setup.common, {
      receiptId: "r1",
      worktree: directory,
      headRefOid: BASE,
      sessionID: PARENT,
      landedAt: 1,
      denied: { at: 2, sessionID: PARENT },
    })
    await setup.fake.fire.tool("execute.after", completed("ses_fake1"))
    expect(lane(setup.fake)?.state).toBe("active")
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create"])
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
    expect(setup.worktree.calls.map((entry) => entry.method)).toEqual(["create", "remove", "refresh", "create"])
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

  test("list repairs externally deleted lanes and reports the moved session", async () => {
    let present = true
    const setup = await start({ exists: async () => present })
    await spawn(setup)
    present = false
    const result = await run(setup, { method: "list" })
    expect(result.content).toContain("moved child sessions back")
    expect(result.metadata.repaired).toEqual(["ses_fake1"])
    expect(setup.fake.sessions.get("ses_fake1")?.location).toEqual({ directory: REPO })
    expect(lane(setup.fake)?.state).toBe("removed")
    expect(setup.worktree.calls.map((call) => call.method)).toEqual(["create"])
  })

  test("an aborted signal stops before the merge and leaves the lane active", async () => {
    const setup = await start()
    await spawn(setup)
    setup.repo.ahead = 2
    const controller = new AbortController()
    controller.abort()
    const tool = setup.fake.tools.get(MERGE_TOOL) as unknown as {
      execute: (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>
    }
    const result = await tool.execute(
      { sessionID: "ses_fake1", method: "wt-merge" },
      { sessionID: PARENT, agent: "build", messageID: "msg_2", id: "call_2", signal: controller.signal },
    )
    expect(result.metadata).toMatchObject({ ok: false, stopped: true })
    expect(result.content).toContain("stopped")
    expect(setup.log.some((argv) => argv[0] === "wt")).toBe(false)
    expect(lane(setup.fake)?.state).toBe("active")
  })

  test("a failed move prevents wt merge", async () => {
    const setup = await start()
    await spawn(setup)
    setup.repo.ahead = 1
    Object.assign(setup.fake.context.session, { move: async () => { throw new Error("move failed") } })
    await expect(run(setup, { sessionID: "ses_fake1", method: "wt-merge" })).rejects.toThrow("move failed")
    expect(setup.log.some((argv) => argv[0] === "wt")).toBe(false)
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
    await spawn(setup, { worktree: "main" })
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
    await spawn(setup, { worktree: "main" })
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

  test("list denial prevents lane and session reads", async () => {
    const setup = await start({
      assert: () => {
        throw new Error("list denied")
      },
    })
    Object.assign(setup.fake.context.storage, {
      scan: async () => {
        throw new Error("unexpected lane read")
      },
    })
    Object.assign(setup.fake.context.session, {
      get: async () => {
        throw new Error("unexpected session read")
      },
    })
    await expect(run(setup, { method: "list" })).rejects.toThrow("list denied")
    expect(setup.log).toEqual([])
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
    expect(setup.fake.asserts.at(-1)).toEqual({
      sessionID: PARENT,
      agent: "build",
      action: MERGE_TOOL,
      resources: ["list"],
      source: { type: "tool", messageID: "msg_2", id: "call_2" },
    })
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
