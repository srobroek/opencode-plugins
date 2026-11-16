import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifactPath, executeCommit, outsideArtifacts } from "./commit.ts"

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

  test("reports nothing to commit when the artifacts are unchanged", async () => {
    const result = await executeCommit({ message: "x" }, repo)
    expect(result.metadata.ok).toBe(false)
    expect(git("log", "--format=%s")).toBe("init")
  })
})
