import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { landingFile, readLanding, removeClaim, writeClaim } from "@srobroek/opencode-lib/worktree-claims"
import type { CleanupDeps, CleanupResult } from "./cleanup.ts"
import * as realCleanup from "./cleanup.ts"
import { cloneRegistryFile } from "./clone-registry.ts"
import { type CliRunner, runCli } from "./forge-adapter.ts"
import * as realLand from "./land.ts"
import { buildReceipt, type GitRunner, type LandingReceipt, receiptDirectory, repositoryContext, writeReceipt } from "./landing-receipt.ts"

// Landing needs a forge and cleanup needs a real remote; both are replaced so the test sees only how
// the registered tools and the turn-end retry chain them across two real repositories: the session's
// (A) and the one a landing targets (B).
const originalCleanup = { ...realCleanup }
// These tests run real git (two `git init` repositories and observed git calls). The 14 tests of this file
// and clone-registry.test.ts took 15 s together alone (about 1 s each); under full-suite load fixtures took
// 20 s or more. 60 s keeps three times that headroom; Bun's 5 s default fails when machines are busy.
setDefaultTimeout(60_000)
const originalLand = { ...realLand }

let repoA = ""
let repoB = ""
let commonA = ""
let commonB = ""
let receiptsRoot = ""
let worktree = ""
let sequence = 0
/** Bead ids the mocked landing records; non-empty makes the target's ledger active. */
let beadIds: string[] = []
let cleanupResult: CleanupResult
let cleanupCalls: Array<{ params: Record<string, unknown>; deps: CleanupDeps }> = []
const env = (): NodeJS.ProcessEnv => ({ HOME: process.env.HOME ?? "", DELIVERY_RECEIPTS_DIR: receiptsRoot })
const disposers: Array<() => Promise<void>> = []

const FAILED: CleanupResult = { ok: false, reason: "worktree.status: dirty" }
const REMOVED = { ok: true, path: "/r", receipt: { branch: { name: "feat" }, worktree: { path: "/w" } }, remoteBranchAbsence: "absent", alreadyCleaned: false, localRefDeleted: true, report: { removed: ["worktree"], skipped: [] } } as never

function receiptIn(repoRoot: string, now: number, over: Partial<Parameters<typeof buildReceipt>[0]> = {}): LandingReceipt {
  const context = repositoryContext(repoRoot)
  if (context === null) throw new Error("fixture repository has no context")
  return buildReceipt({
    now,
    emitter: { plugin: "test", version: "0", tool: "delivery_land" },
    repo: { key: context.key, canonicalRoot: context.ledger.root, remote: "origin", forge: "github", nameWithOwner: "o/b" },
    pr: {
      number: 7,
      url: "https://github.com/o/b/pull/7",
      state: "MERGED",
      baseRefName: "main",
      headRefName: "feat",
      headRefOid: "a".repeat(40),
      mergeCommitOid: "b".repeat(40),
      mergedAt: "2027-01-15T08:00:00.000Z",
    },
    branch: { name: "feat", deletedRemote: true, remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z", autoDeleteSetting: "on" },
    worktree: { path: worktree, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
    beads: { ids: [], ledgerActive: false },
    proof: { method: "gh pr view", observedAt: "2027-01-15T08:00:00.000Z", evidence: { state: "MERGED" } },
    outcome: "landed",
    ...over,
  })
}

beforeAll(() => {
  const init = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "clones-repo-"))
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
    return dir
  }
  repoA = init()
  repoB = init()
  commonA = repositoryContext(repoA)?.commonDir as string
  commonB = repositoryContext(repoB)?.commonDir as string
  mock.module("./cleanup.ts", () => ({
    ...originalCleanup,
    cleanupDelivery: async (params: Record<string, unknown>, _cwd: string, deps: CleanupDeps) => {
      cleanupCalls.push({ params, deps })
      return cleanupResult
    },
  }))
  mock.module("./land.ts", () => ({
    ...originalLand,
    landPullRequest: async () => {
      const receipt = receiptIn(repoB, Date.now() + ++sequence, beadIds.length === 0 ? {} : { beads: { ids: beadIds, ledgerActive: true } })
      const receiptPath = writeReceipt(receipt, receiptDirectory(env(), receipt.repo.key))
      return { ok: true, receipt, receiptPath, text: "landed", next: [] }
    },
  }))
})
afterAll(() => {
  rmSync(repoA, { recursive: true, force: true })
  rmSync(repoB, { recursive: true, force: true })
  mock.module("./cleanup.ts", () => originalCleanup)
  mock.module("./land.ts", () => originalLand)
})
beforeEach(() => {
  receiptsRoot = mkdtempSync(join(tmpdir(), "clones-receipts-"))
  worktree = mkdtempSync(join(tmpdir(), "clones-worktree-"))
  cleanupCalls = []
  cleanupResult = FAILED
  beadIds = []
})
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  removeClaim(commonB, worktree)
  rmSync(receiptsRoot, { recursive: true, force: true })
  rmSync(worktree, { recursive: true, force: true })
})

type Result = { output: Record<string, unknown>; content: string }
type Session = {
  fake: ReturnType<typeof createFakeContext>
  land: () => Promise<Result>
  cleanup: (input: Record<string, unknown>) => Promise<Result>
  /** What the host does at a turn end for the session. */
  idle: (background?: unknown[]) => Promise<void>
  dispose: () => Promise<void>
}

/** A fresh `setupDelivery`: a new process, as after a server restart. */
async function session(
  sessionID = "s",
  cleanup?: NonNullable<Parameters<typeof import("./index.ts").setupDelivery>[1]>["cleanup"],
  observe?: GitRunner,
): Promise<Session> {
  const fake = createFakeContext({ directory: repoA })
  const context = fake.context as unknown as { location: unknown; worktree: unknown; options: unknown }
  context.location = { ...(context.location as object), project: { id: "prj" } }
  context.options = { receiptsDirectory: receiptsRoot }
  context.worktree = { list: async () => [], remove: async () => {} }
  const { setupDelivery, LAND_ACTION, CLEANUP_ACTION } = await import("./index.ts")
  const dispose = await setupDelivery(fake.context, {
    debounceMs: 0,
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(observe === undefined ? {} : { observe }),
  })
  disposers.push(dispose)
  const call = { sessionID, agent: "a", messageID: "m", id: "c", signal: new AbortController().signal }
  const run = (name: string, input: unknown): Promise<Result> => {
    const execute = fake.tools.get(name)?.execute as ((i: unknown, c: unknown) => Promise<Result>) | undefined
    if (!execute) throw new Error(`${name} is not registered`)
    return execute(input, call)
  }
  return {
    fake,
    land: () => run(LAND_ACTION, { pr: 7, repo: "o/b", repoPath: repoB }),
    cleanup: (input) => run(CLEANUP_ACTION, input),
    idle: async (background = []) => {
      await fake.fire.session("experimental.idle", { sessionID, background })
    },
    dispose,
  }
}

const registryOf = (sessionID = "s") => {
  const file = cloneRegistryFile(env(), sessionID)
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { version: number; clones: Array<Record<string, unknown>> }) : undefined
}

test("a landing whose cleanup did not finish is registered under .clones and retried at the turn end", async () => {
  const s = await session()
  const landed = await s.land()
  expect(landed.output.cleanup).toMatchObject({ ok: false })
  expect(cloneRegistryFile(env(), "s").startsWith(join(receiptsRoot, ".clones"))).toBe(true)
  const registry = registryOf()
  expect(registry).toMatchObject({ version: 1, clones: [{ commonDir: commonB, root: repositoryContext(repoB)?.ledger.root, repo: "o/b" }] })
  expect(registry?.clones[0]?.receiptIds).toHaveLength(1)
  const [receiptId] = (registry?.clones[0]?.receiptIds as string[] | undefined) ?? []
  expect(readLanding(commonB, receiptId as string).kind).toBe("present")
  expect(readLanding(commonA, receiptId as string).kind).toBe("missing")

  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle()
  const params = cleanupCalls.map((c) => c.params)
  expect(params).toEqual([
    { receipt: join(receiptDirectory(env(), registry?.clones[0]?.key as string), `${receiptId}.json`), repo: "o/b", repoPath: repositoryContext(repoB)?.ledger.root },
  ])
  expect(registryOf()).toBeUndefined()
})

test("a fresh setupDelivery after a restart still finds the registered receipts", async () => {
  const first = await session()
  await first.land()
  await first.dispose()
  cleanupCalls = []
  cleanupResult = REMOVED
  const restarted = await session()
  await restarted.idle()
  expect(cleanupCalls).toHaveLength(1)
  expect(cleanupCalls[0]?.params).toMatchObject({ repo: "o/b" })
})

test("receipts in the target that another session landed are ignored", async () => {
  const mine = await session("s")
  await mine.land()
  const other = receiptIn(repoB, Date.now() + 1000)
  writeReceipt(other, receiptDirectory(env(), other.repo.key))
  cleanupCalls = []
  cleanupResult = REMOVED
  await mine.idle()
  expect(cleanupCalls).toHaveLength(1)
  expect(String(cleanupCalls[0]?.params.receipt)).not.toContain(other.receiptId)
})

test("a lane claim in the target keeps the retry from cleaning, and the registration stays", async () => {
  const s = await session()
  await s.land()
  writeClaim(commonB, { directory: worktree, branch: "lane-a", sessionID: "c", parentID: "p", createdAt: 1 })
  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle()
  expect(cleanupCalls).toEqual([])
  expect(registryOf()?.clones).toHaveLength(1)
})

/** Land in B, then write the cleaned receipt that settles it; returns what the tests need to clean it up. */
async function landAndSettle(s: Session) {
  await s.land()
  const registry = registryOf()
  const [receiptId] = (registry?.clones[0]?.receiptIds as string[] | undefined) ?? []
  const directory = receiptDirectory(env(), registry?.clones[0]?.key as string)
  const landed = JSON.parse(readFileSync(join(directory, `${receiptId}.json`), "utf8")) as LandingReceipt
  writeReceipt(
    receiptIn(repoB, Date.now() + 5000, {
      continues: landed,
      outcome: "cleaned",
      worktree: { path: worktree, removed: true, localRefDeleted: true, absenceVerifiedAt: "2027-01-15T08:00:02.000Z" },
    }),
    directory,
  )
  return { receiptId: receiptId as string, directory, receiptPath: join(directory, `${receiptId}.json`) }
}

test("an explicit cleanup that settles the receipt also collects the target's landing record before unregistering", async () => {
  const s = await session()
  const { receiptId, receiptPath } = await landAndSettle(s)
  expect(readLanding(commonB, receiptId).kind).toBe("present")
  cleanupResult = REMOVED
  await s.cleanup({ receipt: receiptPath, repo: "o/b", repoPath: repoB })
  expect(registryOf()).toBeUndefined()
  expect(readLanding(commonB, receiptId).kind).toBe("missing")
})

test("a landing record the target cannot read keeps the registration: collection is incomplete", async () => {
  const s = await session()
  const { receiptId, receiptPath } = await landAndSettle(s)
  writeFileSync(landingFile(commonB, `${receiptId}-broken`), "{not json")
  cleanupResult = REMOVED
  await s.cleanup({ receipt: receiptPath, repo: "o/b", repoPath: repoB })
  expect(registryOf()?.clones).toHaveLength(1)
  expect(readLanding(commonB, receiptId).kind).toBe("present")
  rmSync(landingFile(commonB, `${receiptId}-broken`), { force: true })
  await s.cleanup({ receipt: receiptPath, repo: "o/b", repoPath: repoB })
  expect(registryOf()).toBeUndefined()
})

test("the end-of-turn pass keeps a superseded receipt registered while the target has an unreadable landing record", async () => {
  const s = await session()
  const { receiptId } = await landAndSettle(s)
  writeFileSync(landingFile(commonB, `${receiptId}-broken`), "{not json")
  await s.idle()
  expect(registryOf()?.clones).toHaveLength(1)
  expect(readLanding(commonB, receiptId).kind).toBe("present")
  rmSync(landingFile(commonB, `${receiptId}-broken`), { force: true })
  await s.idle()
  expect(registryOf()).toBeUndefined()
  expect(readLanding(commonB, receiptId).kind).toBe("missing")
})

test("a registry that cannot be written is reported, not hidden: at landing and when collecting", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    // At landing: `.clones` is a file, so the registration cannot be written.
    writeFileSync(join(receiptsRoot, ".clones"), "not a directory")
    const s = await session()
    await s.land()
    expect(errors.mock.calls.map((call) => String(call[0]) + String(call[1])).join("\n")).toContain("clone registry")
    const recorded = errors.mock.calls.find((call) => String(call[0]).includes("could not record the landing"))?.[1] as Error | undefined
    expect(recorded?.cause).toBeInstanceOf(Error)
    rmSync(join(receiptsRoot, ".clones"), { force: true })

    // When collecting: the entry is settled but the registry directory refuses the change.
    errors.mockClear()
    await s.land()
    const registry = registryOf()
    const [receiptId] = (registry?.clones[0]?.receiptIds as string[] | undefined) ?? []
    const directory = receiptDirectory(env(), registry?.clones[0]?.key as string)
    const landed = JSON.parse(readFileSync(join(directory, `${receiptId}.json`), "utf8")) as LandingReceipt
    writeReceipt(
      receiptIn(repoB, Date.now() + 5000, {
        continues: landed,
        outcome: "cleaned",
        worktree: { path: worktree, removed: true, localRefDeleted: true, absenceVerifiedAt: "2027-01-15T08:00:02.000Z" },
      }),
      directory,
    )
    const registryDirectory = join(receiptsRoot, ".clones")
    chmodSync(registryDirectory, 0o500) // check-test-executables: directory permission, not a script
    try {
      cleanupResult = REMOVED
      await s.cleanup({ receipt: join(directory, `${receiptId}.json`), repo: "o/b", repoPath: repoB })
    } finally {
      chmodSync(registryDirectory, 0o700) // check-test-executables: directory permission, not a script
    }
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toContain("clone registry")
  } finally {
    errors.mockRestore()
  }
})

test("a source repository that cannot be observed does not hide a background shell in the target worktree: nothing is removed", async () => {
  const real = (argv: readonly string[], cwd: string, timeoutMs: number): string | null => {
    try {
      return execFileSync("git", [...argv], { cwd, timeout: timeoutMs, encoding: "utf8" })
    } catch {
      return null
    }
  }
  // Observing the session's own repository fails; the target's works.
  const observe: GitRunner = (argv, cwd, timeoutMs) => (cwd === repoA ? null : real(argv, cwd, timeoutMs))
  const s = await session("s", undefined, observe)
  await s.land()
  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle([{ kind: "shell", shellID: "sh1", command: `tail -f ${worktree}/log` }])
  expect(cleanupCalls).toEqual([])
  expect(registryOf()?.clones).toHaveLength(1)
})

test("control: with the same unobservable source and no background shell the retry does clean the target", async () => {
  const observe: GitRunner = (argv, cwd, timeoutMs) => {
    if (cwd === repoA) return null
    try {
      return execFileSync("git", [...argv], { cwd, timeout: timeoutMs, encoding: "utf8" })
    } catch {
      return null
    }
  }
  const s = await session("s", undefined, observe)
  await s.land()
  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle([])
  expect(cleanupCalls).toHaveLength(1)
})

test("the reminder for a registered landing in another repository runs its close-out in that clone, without the session's bead pin", async () => {
  mkdirSync(join(repoB, ".beads"))
  try {
    beadIds = ["omp-1"]
    const open: CliRunner = async (argv, options) =>
      argv[0] === "bd"
        ? { ok: true, exitCode: 0, stdout: JSON.stringify({ schema_version: 1, data: [{ id: "omp-1", status: "open", metadata: {} }] }), stderr: "" }
        : runCli(argv, options)
    const s = await session("s", { run: open })
    await s.land()
    await s.idle()
    const reminders = s.fake.calls.filter((call) => call.method === "session.synthetic").map((call) => JSON.stringify(call.input))
    expect(reminders).toHaveLength(1)
    const root = repositoryContext(repoB)?.ledger.root as string
    const text = String((JSON.parse(reminders[0] as string) as { text: string }).text)
    expect(text).toContain(`cd '${root}' && env -u BEADS_DIR bd update omp-1`)
    expect(text).toContain(`cd '${root}' && env -u BEADS_DIR bd close omp-1`)
    expect(text).not.toMatch(/(^|; |\()bd (update|close)/)
  } finally {
    rmSync(join(repoB, ".beads"), { recursive: true, force: true })
  }
})
