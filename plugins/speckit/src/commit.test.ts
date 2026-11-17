import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  artifactPath,
  blobId,
  executeCommit,
  type GitFactory,
  gitEnvironment,
  gitIn,
  outsideArtifacts,
  readArtifact,
} from "./commit.ts"

describe("readArtifact against a directory swapped for an outbound symlink", () => {
  let root: string
  let workspace: string
  let outside: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "speckit-race-")))
    workspace = join(root, "ws")
    outside = join(root, "outside")
    mkdirSync(join(workspace, "specs", "001-a"), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(workspace, "specs", "001-a", "spec.md"), "mine\n")
    writeFileSync(join(outside, "spec.md"), "secret\n")
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const swap = () => {
    rmSync(join(workspace, "specs", "001-a"), { recursive: true })
    symlinkSync(outside, join(workspace, "specs", "001-a"))
  }

  test("reads the file when nothing moves", () => {
    const snapshot = readArtifact(workspace, "specs/001-a/spec.md")
    expect(snapshot.kind === "blob" && new TextDecoder().decode(snapshot.bytes)).toBe("mine\n")
  })

  test.each(["afterCheck", "afterRead"] as const)("refuses a swap at %s", (moment) => {
    const snapshot = readArtifact(workspace, "specs/001-a/spec.md", { [moment]: swap })
    expect(snapshot.kind).toBe("refuse")
  })
})

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

  test("no configured fsmonitor program runs", async () => {
    const monitor = join(repo, ".git", "test-fsmonitor")
    const marker = join(repo, ".git", "ran-fsmonitor")
    writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
    chmodSync(monitor, 0o755)
    git("config", "core.fsmonitor", monitor)
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

  test("commits in a repository whose directory name ends in a space", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "speckit-commit-space-")))
    const spaced = join(parent, "repo ")
    try {
      cpSync(repo, spaced, { recursive: true })
      mkdirSync(join(spaced, "specs", "001-a"), { recursive: true })
      writeFileSync(join(spaced, "specs", "001-a", "spec.md"), "x\n")
      const result = await executeCommit({ message: "x" }, spaced)
      expect(result.metadata.ok).toBe(true)
      const show = Bun.spawnSync(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: spaced, stdout: "pipe" })
      expect(show.stdout.toString().trim()).toBe("specs/001-a/spec.md")
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  describe("stores the bytes on disk, with no filter or conversion", () => {
    let outside: string
    beforeEach(() => {
      outside = realpathSync(mkdtempSync(join(tmpdir(), "speckit-commit-outside-")))
    })
    afterEach(() => rmSync(outside, { recursive: true, force: true }))
    const blob = (path: string) =>
      Bun.spawnSync(["git", "cat-file", "blob", `HEAD:${path}`], { cwd: repo, stdout: "pipe" }).stdout.toString()
    const mode = (path: string) => git("ls-tree", "HEAD", "--", path).split(" ")[0]

    test("a clean filter selected by .gitattributes never runs", async () => {
      const marker = join(outside, "marker")
      git("config", "filter.evil.clean", `sh -c 'touch "${marker}"; tr a-z A-Z'`)
      write("specs/.gitattributes", "* filter=evil\n")
      write("specs/001-a/spec.md", "raw bytes\n")
      const result = await executeCommit({ message: "x" }, repo)
      expect(result.metadata.ok).toBe(true)
      expect(existsSync(marker)).toBe(false)
      expect(blob("specs/001-a/spec.md")).toBe("raw bytes\n")
    })

    test("core.autocrlf does not convert line endings", async () => {
      git("config", "core.autocrlf", "true")
      write("specs/001-a/spec.md", "a\r\nb\r\n")
      expect((await executeCommit({ message: "x" }, repo)).metadata.ok).toBe(true)
      expect(blob("specs/001-a/spec.md")).toBe("a\r\nb\r\n")
    })

    test("ignored files stay out and the exec bit sets the mode", async () => {
      write(".gitignore", "specs/**/spec-status.md\n")
      git("add", ".gitignore")
      git("commit", "-q", "-m", "ignore")
      write("specs/001-a/spec-status.md")
      write("specs/001-a/run.sh", "#!/bin/sh\n")
      chmodSync(join(repo, "specs/001-a/run.sh"), 0o755)
      write("specs/001-a/spec.md")
      expect((await executeCommit({ message: "x" }, repo)).metadata.ok).toBe(true)
      expect(committedFiles().sort()).toEqual(["specs/001-a/run.sh", "specs/001-a/spec.md"])
      expect(mode("specs/001-a/run.sh")).toBe("100755")
      expect(mode("specs/001-a/spec.md")).toBe("100644")
    })

    test("a symlink inside the boundary is stored as a link to its text", async () => {
      write("specs/001-a/spec.md")
      symlinkSync("spec.md", join(repo, "specs/001-a/current.md"))
      expect((await executeCommit({ message: "x" }, repo)).metadata.ok).toBe(true)
      expect(mode("specs/001-a/current.md")).toBe("120000")
      expect(blob("specs/001-a/current.md")).toBe("spec.md")
    })

    test.each([
      ["a relative path out of the artifact roots", "../../src/b.ts"],
      ["an absolute path", "/etc/hosts"],
    ])("refuses a symlink to %s", async (_, target) => {
      write("specs/001-a/spec.md")
      symlinkSync(target, join(repo, "specs/001-a/link"))
      const result = await executeCommit({ message: "x" }, repo)
      expect(result.metadata.ok).toBe(false)
      expect(result.content).toContain("specs/001-a/link")
      expect(git("log", "--format=%s")).toBe("init")
    })

    test("refuses a nested repository under the paths", async () => {
      write("specs/001-a/spec.md")
      mkdirSync(join(repo, "specs/vendor"))
      Bun.spawnSync(["git", "init", "-q"], { cwd: join(repo, "specs/vendor") })
      writeFileSync(join(repo, "specs/vendor/x"), "x\n")
      const result = await executeCommit({ message: "x" }, repo)
      expect(result.metadata.ok).toBe(false)
      expect(result.content).toContain("specs/vendor")
      expect(git("log", "--format=%s")).toBe("init")
    })

    test("a tracked directory swapped for a symlink out of the boundary cannot leak its target", async () => {
      write("specs/001-a/spec.md", "mine\n")
      expect((await executeCommit({ message: "add" }, repo)).metadata.ok).toBe(true)
      writeFileSync(join(outside, "spec.md"), "secret\n")
      rmSync(join(repo, "specs/001-a"), { recursive: true })
      symlinkSync(outside, join(repo, "specs/001-a"))
      const result = await executeCommit({ message: "swap" }, repo)
      expect(result.metadata.ok).toBe(false)
      expect(git("log", "--format=%s")).toBe("add\ninit")
    })
  })

  test("a tracked artifact whose name holds a tab commits its change and its deletion", async () => {
    const tabbed = "specs/001-a/a\tb.md"
    write(tabbed, "one\n")
    write("specs/001-a/spec.md", "one\n")
    expect((await executeCommit({ message: "add" }, repo)).metadata.ok).toBe(true)
    write(tabbed, "two\n")
    write("specs/001-a/spec.md", "two\n")
    expect((await executeCommit({ message: "modify" }, repo)).metadata.ok).toBe(true)
    expect(git("show", "HEAD:specs/001-a/a\tb.md")).toBe("two")
    expect(git("show", "HEAD:specs/001-a/spec.md")).toBe("two")
    rmSync(join(repo, tabbed))
    write("specs/001-a/spec.md", "three\n")
    expect((await executeCommit({ message: "delete" }, repo)).metadata.ok).toBe(true)
    expect(git("ls-tree", "-r", "-z", "--name-only", "HEAD").split("\0").filter(Boolean)).toEqual([
      "README.md",
      "specs/001-a/spec.md",
    ])
    expect(git("show", "HEAD:specs/001-a/spec.md")).toBe("three")
  })

  test("a SHA-256 repository commits, with the local blob id matching git's", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true })
    git("init", "-q", "--object-format=sha256", "-b", "main")
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.com")
    git("config", "commit.gpgsign", "false")
    write("specs/001-a/spec.md", "sha256\n")
    expect((await executeCommit({ message: "first" }, repo)).metadata.ok).toBe(true)
    const oid = git("rev-parse", "HEAD:specs/001-a/spec.md")
    expect(oid).toHaveLength(64)
    expect(oid).toBe(blobId("sha256", new TextEncoder().encode("sha256\n")))
    write("specs/001-a/spec.md", "changed\n")
    write("specs/001-a/plan.md")
    expect((await executeCommit({ message: "second" }, repo)).metadata.ok).toBe(true)
    expect(git("show", "HEAD:specs/001-a/spec.md")).toBe("changed")
  })

  test("an unchanged tracked artifact writes no new blob while its changed sibling commits", async () => {
    write("specs/001-a/spec.md", "same\n")
    write("specs/001-a/plan.md", "one\n")
    expect((await executeCommit({ message: "add" }, repo)).metadata.ok).toBe(true)
    write("specs/001-a/plan.md", "two\n")
    const hashed: string[] = []
    const spy: GitFactory = (hooks) => {
      const real = gitIn(repo, hooks)
      return (args, options) => {
        if (args[0] === "hash-object" && options?.stdin instanceof Uint8Array)
          hashed.push(new TextDecoder().decode(options.stdin))
        return real(args, options)
      }
    }
    expect((await executeCommit({ message: "plan" }, repo, spy)).metadata.ok).toBe(true)
    expect(hashed).toEqual(["two\n"])
    expect(committedFiles()).toEqual(["specs/001-a/plan.md"])
  })

  test("refuses a tracked submodule under the paths", async () => {
    write("specs/001-a/spec.md")
    git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},specs/vendor`)
    git("commit", "-q", "-m", "submodule")
    const result = await executeCommit({ message: "x" }, repo)
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("specs/vendor is a submodule")
    expect(git("log", "--format=%s")).toBe("submodule\ninit")
  })

  test("reports nothing to commit when the artifacts are unchanged", async () => {
    const result = await executeCommit({ message: "x" }, repo)
    expect(result.metadata.ok).toBe(false)
    expect(git("log", "--format=%s")).toBe("init")
  })
})
