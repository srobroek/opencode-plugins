import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifactPath, executeCommit, type GitFactory, gitEnvironment, gitIn, outsideArtifacts } from "./commit.ts"

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

test.each([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_PARAMETERS",
])("gitEnvironment drops the inherited %s", (key) => {
  expect(gitEnvironment({ [key]: "/elsewhere", PATH: "/bin" })).toEqual({ PATH: "/bin", GIT_TERMINAL_PROMPT: "0" })
})

test("gitEnvironment keeps identity variables and sets only the tool's own index", () => {
  expect(gitEnvironment({ GIT_AUTHOR_NAME: "A", GIT_INDEX_FILE: "/x" }, "/private/index")).toEqual({
    GIT_AUTHOR_NAME: "A",
    GIT_TERMINAL_PROMPT: "0",
    GIT_INDEX_FILE: "/private/index",
  })
})

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
  const late =
    (steps: readonly string[], before: () => void): GitFactory =>
    (hooks) => {
      const real = gitIn(repo, hooks)
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

  test.each(["reference-transaction", "post-index-change"])("no %s hook runs", async (hook) => {
    const hooks = join(repo, ".git", "test-hooks")
    const marker = join(repo, ".git", `ran-${hook}`)
    mkdirSync(hooks)
    writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(join(hooks, hook), 0o755)
    git("config", "core.hooksPath", hooks)
    write("specs/001-a/spec.md")
    const result = await executeCommit({ message: "x" }, repo)
    expect(result.metadata.ok).toBe(true)
    expect(existsSync(marker)).toBe(false)
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

  describe("inherited git selectors", () => {
    /** Run `run` with `vars` in the process environment, as a session's shell could leave them. */
    const withEnv = async <T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> => {
      const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.assign(process.env, vars)
      try {
        return await run()
      } finally {
        for (const [key, value] of Object.entries(saved))
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
      }
    }
    let other: string
    beforeEach(() => {
      other = realpathSync(mkdtempSync(join(tmpdir(), "speckit-commit-other-")))
      cpSync(template, other, { recursive: true })
    })
    afterEach(() => rmSync(other, { recursive: true, force: true }))
    const otherGit = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: other, stdout: "pipe" }).stdout.toString().trim()

    test("GIT_DIR and GIT_WORK_TREE cannot point the commit at another repository", async () => {
      write("specs/001-a/spec.md")
      const result = await withEnv({ GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other }, () =>
        executeCommit({ message: "x" }, repo),
      )
      expect(result.metadata.ok).toBe(true)
      expect(committedFiles()).toEqual(["specs/001-a/spec.md"])
      expect(otherGit("log", "--format=%s")).toBe("init")
      expect(otherGit("status", "--porcelain")).toBe("")
    })

    test("refuses when repository config points the work tree elsewhere", async () => {
      write("specs/001-a/spec.md")
      git("config", "core.worktree", other)
      const result = await executeCommit({ message: "x" }, repo)
      expect(result.metadata.ok).toBe(false)
      git("config", "--unset", "core.worktree")
      expect(git("log", "--format=%s")).toBe("init")
      expect(otherGit("log", "--format=%s")).toBe("init")
    })

    test("GIT_INDEX_FILE cannot swap in another index", async () => {
      write("specs/001-a/spec.md")
      const foreignIndex = join(other, "foreign-index")
      const result = await withEnv({ GIT_INDEX_FILE: foreignIndex }, () => executeCommit({ message: "x" }, repo))
      expect(result.metadata.ok).toBe(true)
      expect(committedFiles()).toEqual(["specs/001-a/spec.md"])
      expect(existsSync(foreignIndex)).toBe(false)
      expect(git("status", "--porcelain")).toBe("")
    })
  })

  test("reports nothing to commit when the artifacts are unchanged", async () => {
    const result = await executeCommit({ message: "x" }, repo)
    expect(result.metadata.ok).toBe(false)
    expect(git("log", "--format=%s")).toBe("init")
  })
})
