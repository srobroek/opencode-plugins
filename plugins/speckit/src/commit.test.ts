import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifactPath, executeCommit, type Git, gitIn, outsideArtifacts } from "./commit.ts"

describe("artifactPath", () => {
  test.each([
    ["specs", "specs"],
    ["specs/001-a/spec.md", "specs/001-a/spec.md"],
    ["./specs/001-a/", "specs/001-a"],
    [".specify/memory/constitution.md", ".specify/memory/constitution.md"],
  ])("keeps %s as %s", (path, expected) => {
    expect(artifactPath(path)).toBe(expected)
  })

  test.each(["src/b.ts", "specs/../src/b.ts", "../specs/a", "/repo/specs/a", "specsx/a", ".specify-other", "", "."])(
    "refuses %s",
    (path) => {
      expect(artifactPath(path)).toBeUndefined()
    },
  )
})

test("outsideArtifacts lists staged repository paths outside the workspace's specs/ and .specify/", () => {
  expect(outsideArtifacts(["sub/specs/a.md", "sub/.specify/b", "sub/src/c.ts", "specs/d.md"], "sub/")).toEqual([
    "sub/src/c.ts",
    "specs/d.md",
  ])
  expect(outsideArtifacts(["specs/a.md"], "")).toEqual([])
  expect(outsideArtifacts(["specs/a/x.md", "specs/b/y.md", ".specify/z"], "", ["specs/a"])).toEqual([
    "specs/b/y.md",
    ".specify/z",
  ])
})

// Each case below runs several real git processes, which a loaded machine slows past the 5 s default.
setDefaultTimeout(30_000)

describe("executeCommit", () => {
  let template: string
  let repo: string
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
    return proc.stdout.toString().trim()
  }
  const write = (path: string, text = "x\n") => {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    writeFileSync(join(repo, path), text)
  }

  beforeAll(() => {
    template = realpathSync(mkdtempSync(join(tmpdir(), "speckit-commit-base-")))
    repo = template
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.com")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    write("README.md")
    git("add", "README.md")
    git("commit", "-q", "-m", "init")
  })
  afterAll(() => rmSync(template, { recursive: true, force: true }))
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "speckit-commit-")))
    cpSync(template, repo, { recursive: true })
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test("commits only the artifacts, leaving other edits unstaged", async () => {
    write("specs/001-a/spec.md")
    write("src/b.ts")
    const result = await executeCommit({ message: "docs(spec): 001-a" }, repo)
    expect(result.metadata.ok).toBe(true)
    expect(git("show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual(["docs(spec): 001-a", "", "specs/001-a/spec.md"])
    expect(git("status", "--porcelain")).toBe("?? src/")
  })

  test("refuses when a path outside specs/ and .specify/ is already staged, and commits nothing", async () => {
    write("specs/001-a/spec.md")
    write("src/b.ts")
    git("add", "src/b.ts")
    const result = await executeCommit({ message: "docs(spec): 001-a" }, repo)
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("src/b.ts")
    expect(git("log", "--format=%s")).toBe("init")
  })

  test("refuses a requested path outside specs/ and .specify/ before staging anything", async () => {
    write("specs/001-a/spec.md")
    write("src/b.ts")
    const result = await executeCommit({ message: "x", paths: ["specs/001-a", "src/b.ts"] }, repo)
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("src/b.ts")
    expect(git("diff", "--cached", "--name-only")).toBe("")
  })

  test("a commit message cannot smuggle in options such as --amend", async () => {
    write("specs/001-a/spec.md")
    const result = await executeCommit({ message: "--amend" }, repo)
    expect(result.metadata.ok).toBe(true)
    expect(git("log", "--format=%s")).toBe("--amend\ninit")
  })

  /** The real runner, with `before` run ahead of the git step that writes the commit or moves HEAD. */
  const late = (steps: readonly string[], before: () => void): Git => {
    const real = gitIn(repo)
    return (args, options) => {
      if (steps.includes(args[0] ?? "")) before()
      return real(args, options)
    }
  }
  const committedFiles = () => git("show", "--name-only", "--format=", "HEAD").split("\n")

  test("commits the working-tree snapshot of a partially staged artifact and syncs its index entry", async () => {
    write("specs/001-a/spec.md", "staged\n")
    git("add", "specs/001-a/spec.md")
    write("specs/001-a/spec.md", "worktree\n")
    const result = await executeCommit({ message: "x" }, repo)
    expect(result.metadata.ok).toBe(true)
    expect(git("show", "HEAD:specs/001-a/spec.md")).toBe("worktree")
    expect(git("status", "--porcelain", "--", "specs")).toBe("")
  })

  test("an edit or a foreign stage after validation does not reach the commit", async () => {
    write("specs/001-a/spec.md", "checked\n")
    const seam = late(["commit", "commit-tree"], () => {
      write("specs/001-a/spec.md", "late\n")
      write("src/b.ts")
      git("add", "src/b.ts")
    })
    const result = await executeCommit({ message: "x" }, repo, seam)
    expect(result.metadata.ok).toBe(true)
    expect(git("show", "HEAD:specs/001-a/spec.md")).toBe("checked")
    expect(committedFiles()).toEqual(["specs/001-a/spec.md"])
    expect(result.content).not.toContain("not synced")
    expect(git("diff", "--cached", "--name-only")).toBe("src/b.ts")
  })

  test("a pre-commit hook that stages a foreign file cannot add it to the commit", async () => {
    const hooks = join(repo, ".git", "test-hooks")
    mkdirSync(hooks)
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho x > src.ts && git add src.ts\n")
    chmodSync(join(hooks, "pre-commit"), 0o755)
    git("config", "core.hooksPath", hooks)
    write("specs/001-a/spec.md")
    const result = await executeCommit({ message: "x" }, repo)
    expect(result.metadata.ok).toBe(true)
    expect(committedFiles()).toEqual(["specs/001-a/spec.md"])
  })

  test("refuses when HEAD moves during the commit, keeping the other commit", async () => {
    write("specs/001-a/spec.md")
    // Plumbing moves HEAD without touching the index, as another writer's commit would.
    const seam = late(["commit", "update-ref"], () => {
      git("update-ref", "HEAD", git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "concurrent"))
    })
    const result = await executeCommit({ message: "x" }, repo, seam)
    expect(result.metadata.ok).toBe(false)
    expect(git("log", "--format=%s")).toBe("concurrent\ninit")
  })

  test("makes the first commit of a repository without commits", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true })
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.com")
    git("config", "commit.gpgsign", "false")
    write("specs/001-a/spec.md")
    const result = await executeCommit({ message: "first" }, repo)
    expect(result.metadata.ok).toBe(true)
    expect(git("log", "--format=%s")).toBe("first")
    expect(committedFiles()).toEqual(["specs/001-a/spec.md"])
  })

  test("commits the deletion of a tracked root that is gone from the working tree", async () => {
    write("specs/001-a/spec.md")
    expect((await executeCommit({ message: "add" }, repo)).metadata.ok).toBe(true)
    rmSync(join(repo, "specs"), { recursive: true })
    const result = await executeCommit({ message: "drop" }, repo)
    expect(result.metadata.ok).toBe(true)
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("README.md")
  })

  describe("with diff.relative=true in a nested workspace", () => {
    const nested = () => {
      git("config", "diff.relative", "true")
      write("pkg/specs/001-a/spec.md")
      return join(repo, "pkg")
    }

    test("a staged artifact still counts as the workspace's own", async () => {
      const workspace = nested()
      git("add", "pkg/specs/001-a/spec.md")
      const result = await executeCommit({ message: "x" }, workspace)
      expect(result.metadata.ok).toBe(true)
      expect(committedFiles()).toEqual(["pkg/specs/001-a/spec.md"])
    })

    test("a foreign file staged outside the workspace is still refused", async () => {
      const workspace = nested()
      write("src/b.ts")
      git("add", "src/b.ts")
      const result = await executeCommit({ message: "x" }, workspace)
      expect(result.metadata.ok).toBe(false)
      expect(result.content).toContain("src/b.ts")
    })
  })

  test("reports nothing to commit when the artifacts are unchanged", async () => {
    const result = await executeCommit({ message: "x" }, repo)
    expect(result.metadata.ok).toBe(false)
    expect(git("log", "--format=%s")).toBe("init")
  })
})
