import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { createGit, spawnRunner } from "./git.ts"

// Real git repositories: 1.6 s at load average 49; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000)

describe("createGit().isUnborn on real repositories", () => {
  let root: string
  const git = createGit(spawnRunner)
  const sh = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await child.exited).toBe(0)
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-unborn-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test("is true after git init and false after the first commit", async () => {
    const repo = join(root, "repo")
    await sh(root, "init", "--quiet", repo)
    expect(await git.isUnborn(repo)).toBe(true)
    expect(await git.commit(repo, "HEAD")).toBeUndefined()
    await sh(repo, "commit", "--quiet", "--allow-empty", "-m", "init")
    expect(await git.isUnborn(repo)).toBe(false)
    expect(await git.commit(repo, "HEAD")).toBeTruthy()
  })

  test("is false outside a repository", async () => {
    const plain = await mkdtemp(join(root, "plain-"))
    expect(await git.isUnborn(plain)).toBe(false)
  })

  test("trackedDirty includes staged and unstaged changes but excludes untracked files", async () => {
    const repo = await mkdtemp(join(root, "dirty-"))
    await sh(repo, "init", "--quiet")
    await writeFile(join(repo, "tracked.txt"), "first")
    await sh(repo, "add", "tracked.txt")
    await sh(repo, "commit", "--quiet", "-m", "init")
    expect(await git.trackedDirty(repo)).toBe(false)
    await writeFile(join(repo, "untracked.txt"), "new")
    expect(await git.trackedDirty(repo)).toBe(false)
    await writeFile(join(repo, "tracked.txt"), "second")
    expect(await git.trackedDirty(repo)).toBe(true)
    await sh(repo, "add", "tracked.txt")
    expect(await git.trackedDirty(repo)).toBe(true)
    await sh(repo, "commit", "--quiet", "-m", "update")
    expect(await git.trackedDirty(repo)).toBe(false)
  })

  test("trackedDirty ignores the tracked Beads export, from any subdirectory", async () => {
    const repo = await mkdtemp(join(root, "beads-"))
    await sh(repo, "init", "--quiet")
    await mkdir(join(repo, ".beads"))
    await mkdir(join(repo, "sub"))
    await writeFile(join(repo, ".beads", "issues.jsonl"), "{}\n")
    await writeFile(join(repo, "sub", "tracked.txt"), "first")
    await writeFile(join(repo, "top.txt"), "first")
    await sh(repo, "add", ".")
    await sh(repo, "commit", "--quiet", "-m", "init")
    await writeFile(join(repo, ".beads", "issues.jsonl"), "{}\n{}\n")
    expect(await git.trackedDirty(repo)).toBe(false)
    expect(await git.trackedDirty(join(repo, "sub"))).toBe(false)
    await writeFile(join(repo, "top.txt"), "second")
    expect(await git.trackedDirty(join(repo, "sub"))).toBe(true)
  })
})

describe("spawnRunner against a hostile repository (CWE-78)", () => {
  let root: string
  let repo: string
  const git = createGit(spawnRunner)
  const raw = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await child.exited).toBe(0)
  }
  const marker = (name: string) => join(root, name)
  const fired = async (name: string) => Bun.file(marker(name)).exists()

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-hostile-"))
    repo = join(root, "repo")
    await raw(root, "init", "--quiet", repo)
    await writeFile(join(repo, ".gitattributes"), "* filter=evil diff=evil\n")
    await writeFile(join(repo, "tracked.txt"), "first")
    await raw(repo, "add", "-A")
    await raw(repo, "commit", "--quiet", "-m", "init")
    await raw(repo, "config", "filter.evil.clean", `touch ${marker("filter")}; cat`)
    await raw(repo, "config", "diff.evil.textconv", `touch ${marker("textconv")}; cat`)
    await writeFile(join(repo, ".git", "info", "attributes"), "tracked.txt filter=viainfo\n")
    await raw(repo, "config", "filter.viainfo.clean", `touch ${marker("info-attributes")}; cat`)
    await raw(repo, "config", "core.fsmonitor", `touch ${marker("fsmonitor")}; echo`)
    await mkdir(join(repo, ".githooks"))
    await writeFile(join(repo, ".githooks", "post-checkout"), `#!/bin/sh\ntouch ${marker("hook")}\n`, { mode: 0o755 }) // check-test-executables: hook fixture under test
    await raw(repo, "config", "core.hooksPath", join(repo, ".githooks"))
    // A same-size rewrite with an old mtime forces git to re-hash the file, which runs the clean filter.
    await writeFile(join(repo, "tracked.txt"), "secnd")
    await utimes(join(repo, "tracked.txt"), 946_684_800, 946_684_800)
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test("status, diff and branch reads still report the changes", async () => {
    expect(await git.trackedDirty(repo)).toBe(true)
    expect(await git.porcelain(repo)).toContain("tracked.txt")
    expect(await git.localFiles(repo)).toContain("tracked.txt")
  })

  test("reads and ref updates run no filter, textconv, fsmonitor or hook command", async () => {
    await git.trackedDirty(repo)
    await git.porcelain(repo)
    await git.status(repo, "HEAD")
    await git.localFiles(repo)
    await git.changedFiles(repo, "HEAD")
    expect(await git.createBranch(repo, "lane")).toBe(true)
    expect({
      filter: await fired("filter"),
      textconv: await fired("textconv"),
      fsmonitor: await fired("fsmonitor"),
      hook: await fired("hook"),
      infoAttributes: await fired("info-attributes"),
    }).toEqual({ filter: false, textconv: false, fsmonitor: false, hook: false, infoAttributes: false })
  })
})

describe("hardening beyond status", () => {
  let root: string
  const git = createGit(spawnRunner)
  const raw = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "ignore", stderr: "ignore" })
    expect(await child.exited).toBe(0)
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-gaps-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test("stash list runs no signature-verification program", async () => {
    const repo = join(root, "sig")
    const marker = join(root, "gpg")
    await raw(root, "init", "--quiet", repo)
    await writeFile(join(repo, "a.txt"), "one")
    await raw(repo, "add", "-A")
    await raw(repo, "commit", "--quiet", "-m", "init")
    await writeFile(join(repo, "a.txt"), "two")
    await raw(repo, "stash", "push", "--quiet")
    // Git only verifies a commit that carries a signature header, so forge one on the stash commit.
    const stash = await Bun.spawn(["git", "-C", repo, "cat-file", "commit", "refs/stash"], { stdout: "pipe" }).stdout.text()
    const forged = stash.replace("\n\n", "\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n xx\n -----END PGP SIGNATURE-----\n\n")
    const file = join(root, "forged-commit")
    await writeFile(file, forged)
    const hashed = Bun.spawn(["git", "-C", repo, "hash-object", "-t", "commit", "-w", file], { stdout: "pipe" })
    const oid = (await new Response(hashed.stdout).text()).trim()
    await raw(repo, "update-ref", "-m", "On main: WIP", "refs/stash", oid)
    const program = join(root, "fake-gpg")
    writeExecutable(program, `#!/bin/sh\ntouch ${marker}\nexit 1\n`)
    await raw(repo, "config", "log.showSignature", "true")
    await raw(repo, "config", "gpg.program", program)
    await raw(repo, "config", "gpg.ssh.program", program)
    await raw(repo, "config", "gpg.x509.program", program)
    expect(await git.stashSubjects(repo)).toContain("WIP")
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test("wt and gh children get the same hardening through their environment", async () => {
    const repo = join(root, "child")
    const marker = join(root, "child-filter")
    await raw(root, "init", "--quiet", repo)
    await writeFile(join(repo, ".git", "info", "attributes"), "a.txt filter=evil\n")
    await writeFile(join(repo, "a.txt"), "one")
    await raw(repo, "add", "-A")
    await raw(repo, "commit", "--quiet", "-m", "init")
    await raw(repo, "config", "filter.evil.clean", `touch ${marker}; cat`)
    await writeFile(join(repo, "a.txt"), "two")
    await utimes(join(repo, "a.txt"), 946_684_800, 946_684_800)
    const bin = join(root, "bin")
    await mkdir(bin)
    for (const name of ["wt", "gh"]) writeExecutable(join(bin, name), "#!/bin/sh\ngit status --porcelain\ntest \"$GIT_NO_LAZY_FETCH\" = 1\n")
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      for (const name of ["wt", "gh"]) {
        const result = await spawnRunner([name], { cwd: repo })
        expect({ name, code: result.code, out: result.stdout.trim() }).toEqual({ name, code: 0, out: "M a.txt" })
      }
    } finally {
      process.env.PATH = path
    }
    expect(await Bun.file(marker).exists()).toBe(false)
  })
})

describe("git version gate", () => {
  const fake = (version: string) => async (argv: string[]) => ({
    code: 0,
    stdout: argv.includes("--version") ? version : "",
    stderr: "",
  })
  test.each([
    ["git version 2.40.1", true],
    ["git version 2.41.0", false],
    ["git version 2.56.1 (Apple Git-150)", false],
    ["git version 1.9.0", true],
    ["unexpected output", true],
  ])("%s -> unsupported reason: %p", async (text, unsupported) => {
    const reason = await createGit(fake(text)).unsupported()
    expect(reason !== undefined).toBe(unsupported)
    if (unsupported) expect(reason).toContain("2.41")
  })
})
