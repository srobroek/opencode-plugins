import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultProbe,
  type GitProbe,
  parseWorktreeList,
  type Removal,
  removals,
  reviewRemovals,
  type WorktreeRecord,
} from "./worktree-detached.ts"

// Every decision spawns real git processes; a loaded machine can take seconds.
setDefaultTimeout(60_000)

const SLOW = { timeoutMs: 30_000, budgetMs: 120_000 }

const ATTACHED: WorktreeRecord = { path: "/repo/feature", head: "a".repeat(40), detached: false, branch: "feature" }
const DETACHED: WorktreeRecord = { path: "/repo/loose", head: "b".repeat(40), detached: true, branch: "" }

function probe(worktrees: WorktreeRecord[] | null, refs: string[] | null, status: string[] | null = []): GitProbe {
  return {
    list: async () => worktrees,
    containingRefs: async () => refs,
    status: async () => status,
    resolve: (cwd, target) => (target.startsWith("/") ? target : join(cwd, target)).replace(/\/+$/, ""),
  }
}

const literal = (targets: string[], extra: Partial<Removal> = {}): Removal => ({
  tool: "wt",
  chdir: null,
  targets,
  force: false,
  literal: true,
  ...extra,
})

async function refusal(command: string, cwd: string, gitProbe: GitProbe): Promise<string | undefined> {
  return (await reviewRemovals(command, cwd, gitProbe)).refuse
}

describe("removal recognition", () => {
  test("names the target of each removal spelling", () => {
    expect(removals("git worktree remove ../loose")).toEqual([literal(["../loose"], { tool: "git" })])
    expect(removals("wt remove loose")).toEqual([literal(["loose"])])
    expect(removals("git -C /repo worktree remove --force ../loose")).toEqual([
      literal(["../loose"], { tool: "git", chdir: "/repo", force: true }),
    ])
    expect(removals("cd /repo && wt remove loose")).toEqual([literal(["loose"])])
    expect(removals("wt -y -C /repo remove --force --no-delete-branch --foreground x")).toEqual([
      literal(["x"], { chdir: "/repo", force: true }),
    ])
  })

  test("ignores commands that remove nothing", () => {
    expect(removals("git worktree list --porcelain")).toEqual([])
    expect(removals("wt switch feature")).toEqual([])
    expect(removals("rm -rf build")).toEqual([])
    expect(removals("echo 'wt remove loose'")).toEqual([])
  })

  test("marks wrapper-built and expanded removals as untrusted", () => {
    expect(removals("git worktree list --porcelain | xargs wt remove")[0]?.literal).toBe(false)
    expect(removals('wt remove "$STALE"')[0]?.literal).toBe(false)
    expect(removals("wt remove $(cat list)")[0]?.literal).toBe(false)
    expect(removals("bash -c 'wt remove loose'")[0]?.literal).toBe(false)
    expect(removals("ssh host 'wt remove loose'")[0]?.literal).toBe(false)
  })

  test("quoted words stay one target", () => {
    expect(removals("wt remove 'my worktree'")).toEqual([literal(["my worktree"])])
  })
})

describe("refusals", () => {
  test("refuses a detached checkout no ref reaches", async () => {
    const reason = await refusal("wt remove ./loose", "/repo", probe([ATTACHED, DETACHED], []))
    expect(reason).toContain("detached")
    expect(reason).toContain("git branch recovered/loose bbbbbbb")
  })

  test("allows a detached checkout another ref reaches", async () => {
    expect(await refusal("wt remove ./loose", "/repo", probe([ATTACHED, DETACHED], ["refs/heads/other"]))).toBeUndefined()
  })

  test("allows removing a checkout that is on a branch", async () => {
    expect(await reviewRemovals("wt remove ./feature", "/repo", probe([ATTACHED, DETACHED], []))).toEqual({ ask: [] })
  })

  test("refuses a multi-target sweep before probing git", async () => {
    let listed = 0
    const counting: GitProbe = {
      ...probe([ATTACHED], ["refs/heads/other"]),
      list: async () => {
        listed++
        return [ATTACHED]
      },
    }
    expect(await refusal("wt remove ./feature ./other", "/repo", counting)).toContain("2 targets in one call")
    expect(listed).toBe(0)
  })

  test("refuses when the worktree inventory cannot be read", async () => {
    expect(await refusal("wt remove ./loose", "/repo", probe(null, []))).toContain("did not answer")
  })

  test("refuses when containment cannot be determined", async () => {
    expect(await refusal("wt remove ./loose", "/repo", probe([DETACHED], null))).toContain(
      "containment could not be determined",
    )
  })

  test("blocks an oversized command that contains a removal", async () => {
    expect(await refusal(`${"x".repeat(64_001)}; wt remove ./loose`, "/repo", probe([DETACHED], []))).toContain(
      "oversize",
    )
  })

  test("allows an oversized command with no removal", async () => {
    expect(await refusal(`echo ${"x".repeat(64_001)}`, "/repo", probe([DETACHED], []))).toBeUndefined()
  })

  test("blocks when parsing a detected removal throws", async () => {
    const parse = () => {
      throw new Error("injected parser failure")
    }
    expect((await reviewRemovals("wt remove ./loose", "/repo", probe([DETACHED], []), parse)).refuse).toContain(
      "parse failure",
    )
  })

  test("blocks when a removal probe throws", async () => {
    const throwing: GitProbe = {
      ...probe([DETACHED], []),
      list: async () => {
        throw new Error("injected probe failure")
      },
    }
    expect(await refusal("wt remove ./loose", "/repo", throwing)).toContain("parse failure")
  })

  test("resolves the target relative to a -C directory", async () => {
    const seen: string[] = []
    const tracking: GitProbe = {
      ...probe([DETACHED], []),
      list: async (cwd) => {
        seen.push(cwd)
        return [DETACHED]
      },
    }
    expect(await refusal("git -C /repo worktree remove loose", "/elsewhere", tracking)).toContain("detached")
    expect(seen).toEqual(["/repo"])
  })
})

describe("forced removals", () => {
  test("a forced removal of a dirty checkout asks, naming what it discards", async () => {
    const verdict = await reviewRemovals("wt remove --force feature", "/repo", probe([ATTACHED], [], ["?? notes.md"]))
    expect(verdict.refuse).toBeUndefined()
    expect(verdict.ask[0]).toContain("/repo/feature (feature)")
    expect(verdict.ask[0]).toContain("?? notes.md")
  })

  test("a forced removal of a clean checkout needs no question", async () => {
    expect(await reviewRemovals("git worktree remove -f /repo/feature", "/repo", probe([ATTACHED], [], []))).toEqual({
      ask: [],
    })
  })

  test("an unreadable status asks", async () => {
    const verdict = await reviewRemovals("wt remove --force feature", "/repo", probe([ATTACHED], [], null))
    expect(verdict.ask[0]).toContain("status could not be read")
  })

  test("wt remove without a target means the current worktree", async () => {
    const verdict = await reviewRemovals("wt remove --force", "/repo/feature", probe([ATTACHED], [], ["M a.ts"]))
    expect(verdict.ask).toHaveLength(1)
  })
})

// The bug is a git behaviour, so the probes are proved against a real repository. Nothing is removed.
describe("live git evidence", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-detached-")))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const repo = join(root, "repo")
  const loose = join(root, "loose")
  const contained = join(root, "contained")
  const dirty = join(root, "dirty")
  const git = (cwd: string, ...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    })
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
    return proc.stdout.toString().trim()
  }

  Bun.spawnSync(["mkdir", "-p", repo])
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "config", "user.email", "t@example.com")
  git(repo, "config", "user.name", "t")
  git(repo, "commit", "-q", "--allow-empty", "-m", "base")
  git(repo, "worktree", "add", "-q", "--detach", loose)
  git(loose, "commit", "-q", "--allow-empty", "-m", "loose tip")
  git(repo, "worktree", "add", "-q", "--detach", contained)
  git(contained, "commit", "-q", "--allow-empty", "-m", "contained tip")
  git(repo, "branch", "keep", git(contained, "rev-parse", "HEAD"))
  git(repo, "worktree", "add", "-q", "-b", "dirty", dirty)
  writeFileSync(join(dirty, "scratch.txt"), "work\n")

  test("reads a real worktree inventory and real containment", async () => {
    const live = defaultProbe(SLOW)
    const worktrees = await live.list(repo)
    const looseRecord = worktrees?.find((w) => live.resolve(repo, w.path) === live.resolve(repo, loose))
    expect(looseRecord?.detached).toBe(true)
    expect(await live.containingRefs(repo, looseRecord?.head ?? "")).toEqual([])
    const containedRecord = worktrees?.find((w) => live.resolve(repo, w.path) === live.resolve(repo, contained))
    expect(await live.containingRefs(repo, containedRecord?.head ?? "")).toEqual(["refs/heads/keep"])
  })

  test("refuses the orphaning removal, allows the contained one, asks for the dirty forced one", async () => {
    expect(await refusal(`wt remove ${loose}`, repo, defaultProbe(SLOW))).toContain("no ref reaches that commit")
    expect(await reviewRemovals(`git worktree remove ${contained}`, repo, defaultProbe(SLOW))).toEqual({ ask: [] })
    const forced = await reviewRemovals(`git worktree remove --force ${dirty}`, repo, defaultProbe(SLOW))
    expect(forced.ask[0]).toContain("?? scratch.txt")
    expect((await defaultProbe(SLOW).list(repo))?.length).toBe(4)
  })
})

describe("porcelain parsing", () => {
  test("separates detached checkouts from branch checkouts", () => {
    expect(
      parseWorktreeList(
        "worktree /repo\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree /repo/loose\nHEAD 2222222222222222222222222222222222222222\ndetached\n",
      ),
    ).toEqual([
      { path: "/repo", head: "1".repeat(40), detached: false, branch: "main" },
      { path: "/repo/loose", head: "2".repeat(40), detached: true, branch: "" },
    ])
  })
})
