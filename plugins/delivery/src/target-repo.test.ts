import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cloneInput, type GitReadAt, remotePaths, retargetRepository } from "./target-repo.ts"

const made: string[] = []
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true })
})

/** A checkout laid out as Git does: a `.git` directory under a real root. */
function checkout(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-target-")))
  made.push(root)
  mkdirSync(join(root, ".git"))
  return root
}

/** A reader answering per directory: its remotes by name, and rev-parse paths when it is a checkout. */
function reader(dirs: Record<string, Record<string, string>>): { read: GitReadAt; reads: string[] } {
  const reads: string[] = []
  const read: GitReadAt = async (cwd, argv) => {
    reads.push(`${cwd} ${argv.join(" ")}`)
    const remotes = dirs[cwd]
    if (remotes === undefined) return null
    if (argv[0] === "rev-parse") return `${join(cwd, ".git")}\n${cwd}\n`
    if (argv.join(" ") === "remote") return `${Object.keys(remotes).join("\n")}\n`
    if (argv[0] === "remote" && argv[1] === "get-url") return remotes[argv[2] ?? ""] === undefined ? null : `${remotes[argv[2] ?? ""]}\n`
    return null
  }
  return { read, reads }
}

describe("cloneInput", () => {
  test.each([
    ["repoPath wins over worktree", { repoPath: "/a", worktree: "/b" }, { field: "repoPath", value: "/a" }],
    ["worktree alone", { worktree: " /b " }, { field: "worktree", value: "/b" }],
    ["blank values name nothing", { repoPath: " ", worktree: "" }, null],
    ["no values name nothing", {}, null],
  ] as const)("%s", (_name, input, expected) => {
    expect(cloneInput(input)).toEqual(expected)
  })
})

describe("remotePaths", () => {
  test("names each remote's normalized repository path and null for one that names none", async () => {
    const dir = checkout()
    const { read } = reader({
      [dir]: { origin: "https://github.com/acme/widgets.git", odd: "/some/local/path" },
    })
    expect(await remotePaths(read, dir)).toEqual([
      { name: "origin", path: "acme/widgets" },
      { name: "odd", path: null },
    ])
  })
})

describe("retargetRepository", () => {
  const SESSION = { origin: "https://github.com/srobroek/slopvac.git" }

  test.each([
    ["no repo", {}],
    ["a repo the session already is", { repo: "srobroek/slopvac", repoPath: "/ignored" }],
    ["an invalid repo, left for the caller's own validation", { repo: "https://x/y" }],
  ] as const)("keeps the session directory for %s", async (_name, input) => {
    const session = checkout()
    const { read } = reader({ [session]: SESSION })
    expect(await retargetRepository(input, session, read)).toEqual({ cwd: session, retargeted: false })
  })

  test("runs in the canonical root of the clone whose remote names repo", async () => {
    const session = checkout()
    const target = checkout()
    const { read } = reader({ [session]: SESSION, [target]: { upstream: "git@github.com:acme/widgets.git" } })
    expect(await retargetRepository({ repo: "acme/widgets", repoPath: target }, session, read)).toEqual({
      cwd: target,
      retargeted: true,
    })
  })

  test("resolves a relative clone path against the session directory", async () => {
    const session = checkout()
    const target = join(session, "nested")
    mkdirSync(join(target, ".git"), { recursive: true })
    const { read } = reader({ [session]: SESSION, [target]: { origin: "https://github.com/acme/widgets.git" } })
    expect(await retargetRepository({ repo: "acme/widgets", worktree: "nested" }, session, read)).toEqual({
      cwd: target,
      retargeted: true,
    })
  })

  test.each([
    ["no clone", {}, ["`worktree`", "`repoPath`", '"srobroek/slopvac"']],
    ["a path that is not a checkout", { repoPath: "/not/a/checkout" }, ['repoPath: observed "/not/a/checkout"']],
    ["a repoPath without repo", { repoPath: "/x", repo: undefined }, ["without repo"]],
  ] as const)("refuses %s", async (_name, extra, fragments) => {
    const session = checkout()
    const { read } = reader({ [session]: SESSION })
    const input = "repo" in extra ? extra : { repo: "acme/widgets", ...extra }
    const outcome = await retargetRepository(input, session, read)
    if (!("reason" in outcome)) throw new Error("expected a refusal")
    for (const fragment of fragments) expect(outcome.reason).toContain(fragment)
  })

  test("refuses a clone whose remotes name other repositories, listing them", async () => {
    const session = checkout()
    const target = checkout()
    const { read } = reader({ [session]: SESSION, [target]: { origin: "https://github.com/acme/other.git" } })
    const outcome = await retargetRepository({ repo: "acme/widgets", repoPath: target }, session, read)
    if (!("reason" in outcome)) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("origin=acme/other")
    expect(outcome.reason).toContain('expected one naming "acme/widgets"')
  })
})
