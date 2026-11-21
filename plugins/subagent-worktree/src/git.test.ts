import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { hardenedGitEnv } from "@srobroek/opencode-lib/safe-git"
import { collectDriverKeys, createGit, type RunResult, spawnRunner } from "./git.ts"

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

describe("children of wt and gh against a hostile repository (round 2)", () => {
  let root: string
  const raw = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "ignore", stderr: "ignore" })
    expect(await child.exited).toBe(0)
  }
  const marker = (name: string) => join(root, name)
  const fired = (name: string) => Bun.file(marker(name)).exists()
  // Run a stub `wt` (a /bin/sh script) in `cwd` through the plugin's runner.
  const runWt = async (script: string, cwd: string) => {
    const bin = await mkdtemp(join(root, "bin-"))
    writeExecutable(join(bin, "wt"), `#!/bin/sh\n${script}\n`)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      return await spawnRunner(["wt"], { cwd })
    } finally {
      process.env.PATH = path
    }
  }
  const repoWith = async (name: string) => {
    const repo = join(root, name)
    await raw(root, "init", "--quiet", repo)
    await writeFile(join(repo, "a.txt"), "one")
    await raw(repo, "add", "-A")
    await raw(repo, "commit", "--quiet", "-m", "init")
    return repo
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-round2-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test("a commit signs nothing and runs no gpg.ssh.defaultKeyCommand", async () => {
    const repo = await repoWith("sign")
    writeExecutable(join(root, "key-command"), `#!/bin/sh\ntouch ${marker("key-command-ran")}\nexit 1\n`)
    await raw(repo, "config", "commit.gpgSign", "true")
    await raw(repo, "config", "tag.gpgSign", "true")
    await raw(repo, "config", "gpg.format", "ssh")
    await raw(repo, "config", "gpg.ssh.defaultKeyCommand", join(root, "key-command"))
    const result = await runWt("git -c user.name=t -c user.email=t@example.com commit --quiet --allow-empty -m x", repo)
    expect({ code: result.code, fired: await fired("key-command-ran") }).toEqual({ code: 0, fired: false })
  })

  test("a patch diff runs neither diff.external nor a diff driver's command", async () => {
    const repo = await repoWith("diff")
    await writeFile(join(repo, ".git", "info", "attributes"), "a.txt diff=evil\n")
    await raw(repo, "config", "diff.external", `touch ${marker("external")}; true`)
    await raw(repo, "config", "diff.evil.command", `touch ${marker("command")}; true`)
    await writeFile(join(repo, "a.txt"), "two")
    // The diff itself fails closed (an empty command cannot run); what matters is that no command ran.
    await runWt("git diff HEAD", repo)
    expect({ external: await fired("external"), command: await fired("command") }).toEqual({ external: false, command: false })
  })

  test("a driver defined only in another worktree's config cannot run when a child works there", async () => {
    const repo = await repoWith("multi")
    const other = join(root, "multi-other")
    await raw(repo, "config", "extensions.worktreeConfig", "true")
    await raw(repo, "worktree", "add", "--quiet", "-b", "other", other)
    await raw(other, "config", "--worktree", "filter.evil.clean", `touch ${marker("other-filter")}; cat`)
    await writeFile(join(repo, ".git", "info", "attributes"), "a.txt filter=evil\n")
    await writeFile(join(other, "a.txt"), "two")
    await utimes(join(other, "a.txt"), 946_684_800, 946_684_800)
    const result = await runWt(`git -C ${other} status --porcelain`, repo)
    expect({ code: result.code, out: result.stdout.trim(), fired: await fired("other-filter") }).toEqual({ code: 0, out: "M a.txt", fired: false })
  })

  test("a worktree whose path holds a newline still has its own drivers blanked", async () => {
    const repo = await repoWith("newline")
    const other = join(root, "newline\nother")
    await raw(repo, "config", "extensions.worktreeConfig", "true")
    await raw(repo, "worktree", "add", "--quiet", "-b", "other", other)
    await raw(other, "config", "--worktree", "filter.evil.clean", `touch ${marker("newline-filter")}; cat`)
    await writeFile(join(repo, ".git", "info", "attributes"), "a.txt filter=evil\n")
    await writeFile(join(other, "a.txt"), "two")
    await utimes(join(other, "a.txt"), 946_684_800, 946_684_800)
    const result = await runWt(`git -C '${other}' status --porcelain`, repo)
    expect({ code: result.code, out: result.stdout.trim(), fired: await fired("newline-filter") }).toEqual({ code: 0, out: "M a.txt", fired: false })
  })

  // A partial clone whose origin is then pointed at `url`; returns the clone and a blob it lacks.
  const lazyClone = async (name: string, url: string, config: [string, string][]) => {
    const source = await repoWith(`${name}-source`)
    await raw(source, "config", "uploadpack.allowFilter", "true")
    await raw(source, "config", "uploadpack.allowAnySHA1InWant", "true")
    const clone = join(root, `${name}-clone`)
    await raw(root, "clone", "--quiet", "--no-checkout", "--no-local", "--filter=blob:none", `file://${source}`, clone)
    for (const [key, value] of config) await raw(clone, "config", key, value)
    await raw(clone, "remote", "set-url", "origin", url)
    const blob = (await new Response(Bun.spawn(["git", "-C", source, "rev-parse", "HEAD:a.txt"], { stdout: "pipe" }).stdout).text()).trim()
    // The partial clone really lacks the blob, so reading it needs a lazy fetch.
    const missing = Bun.spawn(["git", "-C", clone, "rev-list", "--objects", "--missing=print", "HEAD"], { stdout: "pipe" })
    expect((await new Response(missing.stdout).text()).split("\n")).toContain(`?${blob}`)
    return { clone, blob }
  }
  // The hardened environment minus GIT_NO_LAZY_FETCH (git 2.45+ honours it), so the lazy fetch really
  // starts and only the core.sshCommand / credential.helper overrides stand between it and the command.
  // `hardened: false` is the control: the same read with no hardening at all.
  const catBlob = async (clone: string, blob: string, hardened = true) => {
    const env = hardened ? hardenedGitEnv(Bun.env) : { ...Bun.env }
    delete env.GIT_NO_LAZY_FETCH
    const child = Bun.spawn(["git", "-C", clone, "cat-file", "-p", blob], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    await child.exited
  }

  test("a lazy fetch for a missing object runs no ssh command", async () => {
    writeExecutable(join(root, "ssh-command"), `#!/bin/sh\ntouch ${marker("ssh-command-ran")}\nexit 1\n`)
    const { clone, blob } = await lazyClone("lazy-ssh", "ssh://example.invalid/repo", [["core.sshCommand", join(root, "ssh-command")]])
    await catBlob(clone, blob)
    const hardened = await fired("ssh-command-ran")
    await catBlob(clone, blob, false)
    expect({ hardened, unhardened: await fired("ssh-command-ran") }).toEqual({ hardened: false, unhardened: true })
  })

  test("a lazy fetch that meets an authentication challenge runs no credential helper", async () => {
    writeExecutable(join(root, "credential-helper"), `#!/bin/sh\ntouch ${marker("credential-helper-ran")}\nexit 1\n`)
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }) })
    try {
      const { clone, blob } = await lazyClone("lazy-cred", `http://127.0.0.1:${server.port}/repo.git`, [["credential.helper", join(root, "credential-helper")]])
      await catBlob(clone, blob)
      const hardened = await fired("credential-helper-ran")
      await catBlob(clone, blob, false)
      expect({ hardened, unhardened: await fired("credential-helper-ran") }).toEqual({ hardened: false, unhardened: true })
    } finally {
      await server.stop(true)
    }
  })

  test("changedFiles refuses a target that git would read as an option, and writes no file", async () => {
    const repo = await repoWith("output")
    const target = `--output=${marker("diff-output")}`
    expect(await createGit(spawnRunner).changedFiles(repo, target)).toBeUndefined()
    expect(await fired("diff-output")).toBe(false)
  })
})

describe("collectDriverKeys", () => {
  const exec = (answers: Record<string, RunResult>) => async (argv: string[], cwd: string) =>
    answers[`${argv.slice(1, 3).join(" ")}@${cwd}`] ?? { code: 99, stdout: "", stderr: "unexpected" }
  const list = (code: number, stdout = "", stderr = ""): RunResult => ({ code, stdout, stderr })

  test("unions the keys of every worktree", async () => {
    const keys = await collectDriverKeys(
      "/main",
      exec({
        "worktree list@/main": list(0, "worktree /main\0HEAD abc\0\0worktree /lane\0HEAD def\0"),
        "config --name-only@/main": list(0, "filter.a.clean\ndiff.x.command\n"),
        "config --name-only@/lane": list(0, "filter.b.clean\nfilter.a.clean\n"),
      }),
    )
    expect([...keys].sort()).toEqual(["diff.x.command", "filter.a.clean", "filter.b.clean"])
  })

  test("a worktree with no matching keys (exit 1) adds none", async () => {
    const keys = await collectDriverKeys("/main", exec({ "worktree list@/main": list(0, "worktree /main\0"), "config --name-only@/main": list(1) }))
    expect(keys).toEqual([])
  })

  test("a prunable worktree is not read", async () => {
    const keys = await collectDriverKeys(
      "/main",
      exec({
        "worktree list@/main": list(0, "worktree /main\0HEAD abc\0\0worktree /gone\0HEAD def\0prunable gitdir file points to non-existent location\0"),
        "config --name-only@/main": list(0, "filter.a.clean\n"),
      }),
    )
    expect(keys).toEqual(["filter.a.clean"])
  })

  test("a worktree whose directory no longer exists is not read", async () => {
    const keys = await collectDriverKeys(
      "/main",
      exec({
        "worktree list@/main": list(0, "worktree /main\0\0worktree /gone\0locked\0"),
        "config --name-only@/main": list(0, "filter.a.clean\n"),
      }),
      (dir) => dir !== "/gone",
    )
    expect(keys).toEqual(["filter.a.clean"])
  })

  test("outside a repository only the directory itself is read", async () => {
    const keys = await collectDriverKeys(
      "/plain",
      exec({
        "worktree list@/plain": list(128, "", "fatal: not a git repository (or any of the parent directories): .git"),
        "config --name-only@/plain": list(0, "filter.g.clean\n"),
      }),
    )
    expect(keys).toEqual(["filter.g.clean"])
  })

  test.each([
    ["the worktree list fails", { "worktree list@/main": list(128, "", "fatal: bad object") }],
    ["the worktree list times out", { "worktree list@/main": list(124, "", "git timed out") }],
    [
      "a worktree's config read fails",
      { "worktree list@/main": list(0, "worktree /main\0\0worktree /lane\0"), "config --name-only@/main": list(0), "config --name-only@/lane": list(124, "", "timed out") },
    ],
  ])("refuses when %s", async (_name, answers) => {
    await expect(collectDriverKeys("/main", exec(answers))).rejects.toThrow()
  })
})

describe("spawnRunner with registered worktrees whose state is broken", () => {
  let root: string
  const raw = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "ignore", stderr: "ignore" })
    expect(await child.exited).toBe(0)
  }
  const repoWithWorktree = async (name: string) => {
    const repo = join(root, name)
    const lane = join(root, `${name}-lane`)
    await raw(root, "init", "--quiet", repo)
    await raw(repo, "commit", "--quiet", "--allow-empty", "-m", "init")
    await raw(repo, "config", "extensions.worktreeConfig", "true")
    await raw(repo, "worktree", "add", "--quiet", "-b", "lane", lane)
    return { repo, lane }
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-broken-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test("a deleted registered worktree blocks neither commands nor pruning", async () => {
    const { repo, lane } = await repoWithWorktree("deleted")
    await rm(lane, { recursive: true, force: true })
    const status = await spawnRunner(["git", "-C", repo, "status", "--porcelain"])
    const pruned = await createGit(spawnRunner).pruneWorktrees(repo)
    const listed = await spawnRunner(["git", "-C", repo, "worktree", "list", "--porcelain"])
    expect({ code: status.code, pruned, lane: listed.stdout.includes("deleted-lane") }).toEqual({ code: 0, pruned: true, lane: false })
  })

  test("a live worktree whose config cannot be read still refuses the command", async () => {
    const { repo, lane } = await repoWithWorktree("live")
    // Its per-worktree config exists but is unreadable, so reading it fails with a real error.
    const gitDir = (await new Response(Bun.spawn(["git", "-C", lane, "rev-parse", "--absolute-git-dir"], { stdout: "pipe" }).stdout).text()).trim()
    await writeFile(join(gitDir, "config.worktree"), "")
    await chmod(join(gitDir, "config.worktree"), 0o000)
    const status = await spawnRunner(["git", "-C", repo, "status", "--porcelain"])
    expect(status.code).toBe(127)
    expect(status.stderr).toContain("cannot read the git config")
  })
})
