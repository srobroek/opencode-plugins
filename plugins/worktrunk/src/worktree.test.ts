import { describe, expect, test } from "bun:test"
import {
  branchName,
  createArgs,
  createStrategy,
  failureMessage,
  listArgs,
  parseJsonOutput,
  parseListOutput,
  parseSwitchOutput,
  type RunResult,
  removeArgs,
  removeNeedsForce,
  spawnRunner,
} from "./worktree.ts"

class FakeError extends Error {
  constructor(
    message: string,
    readonly forceRequired?: boolean,
  ) {
    super(message)
  }
}
const error = (message: string, forceRequired?: boolean) => new FakeError(message, forceRequired)
const signal = new AbortController().signal

function fakeRunner(results: Record<string, RunResult>) {
  const calls: string[][] = []
  const run = async (argv: string[]) => {
    calls.push(argv)
    const key = `${argv[0]} ${argv[3]}`
    const result = results[key]
    if (!result) throw new Error(`unexpected ${argv.join(" ")}`)
    return result
  }
  return { calls, run }
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" })

const SWITCH_JSON =
  '{"action":"created","branch":"brave-cabin","path":"/wt/repo/brave-cabin","created_branch":true,"base_branch":"abc123"}'
const LIST_JSON = JSON.stringify({
  schema: 2,
  items: [
    { branch: "main", worktree: { path: "/repo", main: true } },
    { branch: "brave-cabin", worktree: { path: "/wt/repo/brave-cabin", main: false } },
    { branch: "no-worktree" },
  ],
})

describe("argument builders", () => {
  test("create uses the suggested directory's basename as the branch", () => {
    expect(createArgs({ sourceDirectory: "/repo", directory: "/data/worktree/abc/brave-cabin/", base: "abc123" })).toEqual(
      ["-C", "/repo", "switch", "-y", "--create", "--no-cd", "--base", "abc123", "--format", "json", "brave-cabin"],
    )
  })
  test("branchName rejects a directory without a name", () => {
    expect(() => branchName("/")).toThrow()
  })
  test("remove adds --force only when forced and always waits", () => {
    expect(removeArgs({ directory: "/wt/x", force: false })).toEqual(["-C", "/wt/x", "remove", "-y", "--foreground"])
    expect(removeArgs({ directory: "/wt/x", force: true })).toEqual([
      "-C",
      "/wt/x",
      "remove",
      "-y",
      "--force",
      "--foreground",
    ])
  })
  test("list asks for JSON", () => {
    expect(listArgs("/repo")).toEqual(["-C", "/repo", "list", "--format", "json"])
  })
})

describe("output parsers", () => {
  test("switch output gives the created path", () => {
    expect(parseSwitchOutput(SWITCH_JSON)).toEqual({ directory: "/wt/repo/brave-cabin" })
  })
  test("a hook line on stdout does not hide the JSON", () => {
    expect(parseJsonOutput(`hook says hi\n${SWITCH_JSON}\n`)).toMatchObject({ path: "/wt/repo/brave-cabin" })
  })
  test("switch output without a path throws", () => {
    expect(() => parseSwitchOutput('{"action":"created"}')).toThrow("no worktree path")
    expect(() => parseSwitchOutput("not json")).toThrow()
  })
  test("list maps main to root and skips branch-only rows", () => {
    expect(parseListOutput(LIST_JSON)).toEqual([
      { directory: "/repo", type: "root" },
      { directory: "/wt/repo/brave-cabin", type: "worktree" },
    ])
  })
  test("list output without items throws", () => {
    expect(() => parseListOutput("{}")).toThrow()
  })
  test("dirty refusal requires force", () => {
    expect(
      removeNeedsForce(
        "\u001b[31m✗ Cannot remove worktree: probe1 has uncommitted changes\u001b[0m\n↳ Commit or stash changes first, or to lose uncommitted changes, run wt remove --force probe1",
      ),
    ).toBe(true)
    expect(removeNeedsForce("✗ Failed to execute: git rev-parse --git-common-dir")).toBe(false)
  })
  test("failure message names the subcommand and keeps the error lines", () => {
    expect(
      failureMessage(["wt", "-C", "/repo", "switch"], {
        code: 1,
        stdout: "",
        stderr: "◎ Running pre-start\n✗ Branch x already exists\n",
      }),
    ).toBe("wt switch failed (exit 1): ✗ Branch x already exists")
  })
})

describe("strategy", () => {
  test("create bases on HEAD when no branch is given", async () => {
    const fake = fakeRunner({ "git rev-parse": ok("abc123\n"), "wt switch": ok(SWITCH_JSON) })
    const strategy = createStrategy({ run: fake.run, error })
    const result = await strategy.create({ sourceDirectory: "/repo", directory: "/s/brave-cabin" }, { signal })
    expect(result).toEqual({ directory: "/wt/repo/brave-cabin" })
    expect(fake.calls[0]).toEqual(["git", "-C", "/repo", "rev-parse", "--verify", "HEAD"])
    expect(fake.calls[1]).toContain("abc123")
  })
  test("create passes the starting ref as --base", async () => {
    const fake = fakeRunner({ "wt switch": ok(SWITCH_JSON) })
    const strategy = createStrategy({ run: fake.run, error })
    await strategy.create({ sourceDirectory: "/repo", directory: "/s/brave-cabin", branch: "develop" }, { signal })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.slice(7, 9)).toEqual(["--base", "develop"])
  })
  test("a failed create throws without forceRequired", async () => {
    const fake = fakeRunner({ "wt switch": { code: 1, stdout: "", stderr: "✗ Branch brave-cabin already exists" } })
    const strategy = createStrategy({ run: fake.run, error })
    const failure = strategy.create({ sourceDirectory: "/repo", directory: "/s/brave-cabin", branch: "main" }, { signal })
    await expect(failure).rejects.toThrow("already exists")
    await expect(failure).rejects.toMatchObject({ forceRequired: undefined })
  })
  test("a dirty remove asks for force", async () => {
    const fake = fakeRunner({
      "wt remove": { code: 1, stdout: "", stderr: "✗ Cannot remove worktree: x has uncommitted changes" },
    })
    const strategy = createStrategy({ run: fake.run, error, exists: async () => true })
    await expect(strategy.remove({ directory: "/wt/x", force: false }, { signal })).rejects.toMatchObject({
      forceRequired: true,
    })
  })
  test("remove of a missing directory is a no-op", async () => {
    const fake = fakeRunner({})
    const strategy = createStrategy({ run: fake.run, error, exists: async () => false })
    await strategy.remove({ directory: "/gone", force: false }, { signal })
    expect(fake.calls).toHaveLength(0)
  })
  test("list returns parsed entries", async () => {
    const fake = fakeRunner({ "wt list": ok(LIST_JSON) })
    const strategy = createStrategy({ run: fake.run, error })
    expect(await strategy.list("/repo", { signal })).toHaveLength(2)
  })
})

describe("spawnRunner", () => {
  test("captures exit code and both streams", async () => {
    const result = await spawnRunner(["/bin/sh", "-c", "echo out; echo err >&2; exit 3"], signal)
    expect(result).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" })
  }, 60_000)
  test("an aborted signal stops the command and rejects", async () => {
    const controller = new AbortController()
    const pending = spawnRunner(["/bin/sleep", "30"], controller.signal)
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toBeDefined()
  }, 60_000)
})
