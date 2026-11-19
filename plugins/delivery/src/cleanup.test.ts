import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { outsideLocks } from "@srobroek/opencode-lib/lease-lock"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import {
  claimFile,
  landingFile,
  readLanding,
  removeClaim,
  writeClaim,
  writeLanding,
} from "@srobroek/opencode-lib/worktree-claims"
import { lockedWrite, lockFile, readHolds, setHold, withDiskLock } from "@srobroek/opencode-lib/worktree-locks"
import { authorizeExplicit, createPendingCleanup } from "./pending-cleanup.ts"

// Fixture setup creates several real Git repositories and measured about 20s under full-suite load;
// keep three times that headroom instead of letting Bun's 5s default kill a child process mid-fixture.
setDefaultTimeout(60_000)

import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { devNull, hostname, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import pkg from "../package.json" with { type: "json" }
import {
  branchDeleteArgs,
  CLEANUP_BOUNDS,
  type CleanupBounds,
  type CleanupDeps,
  type CleanupResult,
  cleanupDelivery as cleanupDeliveryUnwrapped,
  type DeliveryCleanupParams,
  removalRoute,
} from "./cleanup.ts"
import { type CliResult, type CliRunner, runCli, SAFE_GIT_ARGS } from "./forge-adapter.ts"
import { type LandDeps, type LandParams, landPullRequest as landPullRequestUnwrapped } from "./land.ts"
import {
  buildReceipt,
  type GitRunner,
  type LandingReceipt,
  listReceipts,
  readReceipt,
  receiptDirectory,
  repoKey,
  repositoryContext,
  validateReceipt,
  writeReceipt,
} from "./landing-receipt.ts"

const ROOTS: string[] = []
// Each test's scratch is removed when it ends. Removing every fixture of the file in one
// afterAll took over a minute where each unlink is endpoint-scanned, past the hook timeout.
afterEach(() => {
  const template = normalTemplateCache?.root
  for (const root of ROOTS.splice(0)) {
    if (root === template) ROOTS.push(root)
    else rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true })
})

const NOW = 1_800_000_000_000

type Fixture = {
  root: string
  main: string
  linked: string
  bare: string
  branch: string
  head: string
  merge: string
  env: NodeJS.ProcessEnv
  receipt: LandingReceipt
  receiptPath: string
}

type FixtureLayout = "normal" | "separate-git-dir" | "separate-dot-git-dir" | "submodule"

/** Every raw git argv a wrapped call issued, with the safe-option prefix still on. */
const rawGitArgv: string[][] = []

/** The argv without the safe-option prefix every checkout-bound Git command carries. */
const withoutSafeGit = (argv: readonly string[]): string[] =>
  argv[0] === "git" && SAFE_GIT_ARGS.every((part, index) => argv[index + 1] === part)
    ? ["git", ...argv.slice(1 + SAFE_GIT_ARGS.length)]
    : [...argv]

/** A runner that sees Git argv without the safe prefix, so scripted runners match on the verb. */
const stripped =
  (inner: CliRunner): CliRunner =>
  (argv, options) => {
    if (argv[0] === "git") rawGitArgv.push([...argv])
    return inner(withoutSafeGit(argv), options)
  }

/** `cleanupDelivery` with a supplied runner seeing the stripped argv; without one it runs real Git, prefix and all. */
function cleanupDelivery(params: DeliveryCleanupParams, cwd: string, deps: CleanupDeps = {}) {
  return cleanupDeliveryUnwrapped(params, cwd, deps.run === undefined ? deps : { ...deps, run: stripped(deps.run) })
}

function landPullRequest(params: LandParams, deps: LandDeps = {}) {
  return landPullRequestUnwrapped(params, deps.run === undefined ? deps : { ...deps, run: stripped(deps.run) })
}

type RecordedCall = {
  argv: string[]
  cwd: string | undefined
  timeoutMs: number
  env: Readonly<Record<string, string>> | undefined
}

type RunnerOptions = {
  pr?: Partial<{
    state: string
    baseRefName: string
    headRefName: string
    headRefOid: string
    mergeCommitOid: string | null
    mergedAt: string | null
    url: string
  }>
  /**
   * What each remote name resolves to, for a checkout whose remotes do not all
   * name the repository the receipt was written for. Absent, every name resolves
   * to the receipt's own repository; present, a name it omits is no remote at all.
   */
  remotes?: Record<string, string>
  /** Let git answer `remote get-url` itself, so a worktree-scoped rewrite is real. */
  realRemoteUrls?: boolean
  /** Verbatim stdout for `remote get-url`, for output that is not one clean record. */
  remoteStdout?: string
  beadStatus?: string
  beadRows?: Record<string, unknown>[]
  beadMergeSha?: string
  remote?: "absent" | "present" | "unknown"
  pathlessAfterRemove?: boolean
  registeredTargetAfterRemove?: boolean
  before?: (argv: string[], calls: string[][]) => void
  after?: (argv: string[], result: CliResult, calls: string[][]) => void
}

function scratch(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `delivery-cleanup-${name}-`)))
  ROOTS.push(root)
  return root
}

type NormalTemplate = { root: string }
let normalTemplateCache: NormalTemplate | undefined

function normalTemplate(): NormalTemplate {
  if (normalTemplateCache !== undefined) return normalTemplateCache
  const root = scratch("template")
  const bare = join(root, "remote.git")
  const main = join(root, "main")
  const linked = join(root, "linked worktree")
  // No template: its sample hooks would be copied into every fixture and never run.
  mkdirSync(bare)
  git(bare, ["init", "--bare", "-q", "--template="])
  mkdirSync(main)
  git(main, ["init", "-q", "-b", "main", "--template="])
  git(main, ["config", "user.email", "delivery@example.test"])
  git(main, ["config", "user.name", "Delivery Test"])
  writeFileSync(join(main, "base.txt"), "base\n")
  git(main, ["add", "base.txt"])
  git(main, ["commit", "-q", "-m", "base"])
  git(main, ["remote", "add", "origin", bare])
  git(main, ["push", "-q", "-u", "origin", "main"])
  mkdirSync(join(main, ".beads"))
  git(main, ["worktree", "add", "-q", "-b", "template", linked])
  writeFileSync(join(linked, "feature.txt"), "feature\n")
  git(linked, ["add", "feature.txt"])
  git(linked, ["commit", "-q", "-m", "feature"])
  git(linked, ["push", "-q", "-u", "origin", "template"])
  git(main, ["merge", "-q", "--no-ff", "template", "-m", "merge feature"])
  git(main, ["push", "-q", "origin", "main"])
  git(bare, ["update-ref", "-d", "refs/heads/template"])
  normalTemplateCache = { root }
  return normalTemplateCache
}

function rewriteCopiedWorktree(templateRoot: string, root: string): void {
  const worktrees = join(root, "main", ".git", "worktrees")
  for (const name of readdirSync(worktrees)) {
    const gitdir = join(worktrees, name, "gitdir")
    if (existsSync(gitdir)) writeFileSync(gitdir, readFileSync(gitdir, "utf8").replaceAll(templateRoot, root))
  }
  const linkedGit = join(root, "linked worktree", ".git")
  writeFileSync(linkedGit, readFileSync(linkedGit, "utf8").replaceAll(templateRoot, root))
  const config = join(root, "main", ".git", "config")
  writeFileSync(config, readFileSync(config, "utf8").replaceAll(templateRoot, root))
}

beforeAll(() => {
  normalTemplate()
})

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim()
}

/**
 * Make a fixture repository hostile: `core.fsmonitor`, a clean filter selected by
 * `info/attributes`, a `filter.<x>.process` driver and `include.path` config each run a
 * script that writes a marker file, and every hook writes one too.
 */
function hostileConfig(f: Fixture): { markers: Record<string, string> } {
  const dir = scratch("hostile")
  const markers: Record<string, string> = {}
  const script = (name: string, body = "cat"): string => {
    const marker = join(dir, `${name}.ran`)
    markers[name] = marker
    const path = join(dir, `${name}.sh`)
    writeExecutable(path, `#!/bin/sh\ntouch "${marker}"\n${body}\n`)
    return path
  }
  git(f.main, ["config", "core.fsmonitor", script("fsmonitor", "printf '\\0'")])
  git(f.main, ["config", "filter.hostile.process", script("process")])
  const included = join(dir, "included.config")
  writeFileSync(included, `[filter "included"]\n\tclean = ${script("included")}\n`)
  git(f.main, ["config", "include.path", included])
  const tracked = git(f.linked, ["ls-files"]).split("\n").filter(Boolean)
  // `included` is a clean driver from `include.path`, `hostile` a long-running process driver.
  mkdirSync(join(f.main, ".git", "info"), { recursive: true })
  writeFileSync(join(f.main, ".git", "info", "attributes"), `* filter=included\n${tracked[0]} filter=hostile\n`)
  const hooks = join(dir, "hooks")
  mkdirSync(hooks)
  for (const hook of ["post-checkout", "reference-transaction", "post-index-change", "pre-auto-gc"]) {
    const marker = join(dir, `hook-${hook}.ran`)
    markers[`hook-${hook}`] = marker
    writeExecutable(join(hooks, hook), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`)
  }
  git(f.main, ["config", "core.hooksPath", hooks])
  // Make a tracked file stat-dirty so a status has to re-hash it through the clean filter.
  for (const file of tracked) writeFileSync(join(f.linked, file), readFileSync(join(f.linked, file)))
  return { markers }
}

const ranMarkers = (markers: Record<string, string>): string[] =>
  Object.entries(markers)
    .filter(([, marker]) => existsSync(marker))
    .map(([name]) => name)
    .sort()

/** One `git` start the PATH shim saw: its physical working directory, the repository selectors in its environment, and its argv. */
type GitSpawn = { cwd: string; gitDir: string; workTree: string; commonDir: string; argv: string[] }

/** `path` with every existing component resolved through symlinks and `..`, as the kernel would. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(canonical(parent), basename(path))
  }
}

/**
 * Every path a start could select a repository through, made canonical: the working
 * directory after each `-C`, `--git-dir` and `--work-tree` (as `=value` or a separate word),
 * and `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR`, relative ones against that directory.
 * Git reads these global options up to the subcommand, so parsing stops there.
 */
function repositorySelectors(spawn: GitSpawn): string[] {
  let cwd = spawn.cwd
  const selected = [cwd]
  const options = spawn.argv
  for (let at = 0; at < options.length; at++) {
    const word = options[at] ?? ""
    const value = (name: string): string | undefined =>
      word === name ? options[++at] : word.startsWith(`${name}=`) ? word.slice(name.length + 1) : undefined
    if (word === "-C") {
      cwd = resolve(cwd, options[++at] ?? "")
      selected.push(cwd)
      continue
    }
    if (word === "-c") {
      at++
      continue
    }
    const path = value("--git-dir") ?? value("--work-tree")
    if (path !== undefined) {
      selected.push(resolve(cwd, path))
      continue
    }
    if (!word.startsWith("-")) break
  }
  for (const path of [spawn.gitDir, spawn.workTree, spawn.commonDir]) if (path !== "") selected.push(resolve(cwd, path))
  return selected.map(canonical)
}

/** The starts that selected a repository path outside `root`, compared canonically. */
const outside = (log: GitSpawn[], root: string): GitSpawn[] => {
  const allowed = canonical(root)
  return log.filter((spawn) =>
    repositorySelectors(spawn).some((path) => path !== allowed && !path.startsWith(`${allowed}/`)),
  )
}

/**
 * Put a `git` shim first on PATH that records every start. Every Git child cleanup runs
 * gets the current environment, so each one passes through it, synchronous or not. Fields
 * are separated by US (0x1f) and records by RS (0x1e), so any argv word survives.
 */
function gitSpawnLog(): { log: () => GitSpawn[]; restore: () => void } {
  const dir = scratch("git-shim")
  const logFile = join(dir, "spawns.log")
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
  writeExecutable(
    join(dir, "git"),
    `#!/bin/sh\n{ printf '%s\\037' "$(pwd -P)" "$GIT_DIR" "$GIT_WORK_TREE" "$GIT_COMMON_DIR" "$@"; printf '\\036'; } >> "${logFile}"\nexec "${real}" "$@"\n`,
  )
  const before = process.env.PATH
  process.env.PATH = `${dir}:${before ?? ""}`
  return {
    log: () =>
      (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\x1e").filter(Boolean) : []).map((record) => {
        const [cwd = "", gitDir = "", workTree = "", commonDir = "", ...argv] = record.split("\x1f")
        return { cwd, gitDir, workTree, commonDir, argv: argv.slice(0, -1) }
      }),
    restore: () => {
      process.env.PATH = before
    },
  }
}

function gitExit(cwd: string, args: string[]): number | null {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  })
  return result.exitCode
}

/**
 * A real repository whose ledger state on disk is the state its receipt claims.
 *
 * Nonstandard layouts plant a retired ledger above an active checkout ledger. That
 * is the live fail-open shape: using the common metadata directory as the checkout
 * root sees the parent verdict, while Git's top level names the active ledger.
 */
function fixture(
  name: string,
  branch = `feat/${name}`,
  ledger: "active" | "retired" = "active",
  layout: FixtureLayout = "normal",
): Fixture {
  const root = scratch(name)
  const bare = join(root, "remote.git")
  let main: string

  if (layout === "normal") {
    cpSync(normalTemplate().root, root, { recursive: true })
    main = join(root, "main")
  } else {
    mkdirSync(bare)
    git(bare, ["init", "--bare", "-q"])
    if (layout === "submodule") {
      const source = join(root, "source")
      const superproject = join(root, "superproject")
      main = join(superproject, "sub")
      mkdirSync(source)
      git(source, ["init", "-q", "-b", "main"])
      git(source, ["config", "user.email", "delivery@example.test"])
      git(source, ["config", "user.name", "Delivery Test"])
      writeFileSync(join(source, "source.txt"), "source\n")
      git(source, ["add", "source.txt"])
      git(source, ["commit", "-q", "-m", "source"])
      mkdirSync(superproject)
      git(superproject, ["init", "-q", "-b", "main"])
      git(superproject, ["config", "user.email", "delivery@example.test"])
      git(superproject, ["config", "user.name", "Delivery Test"])
      writeFileSync(join(superproject, "super.txt"), "super\n")
      git(superproject, ["add", "super.txt"])
      git(superproject, ["commit", "-q", "-m", "super"])
      git(superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub"])
      mkdirSync(join(superproject, ".beads"))
      writeFileSync(join(superproject, ".beads", "RETIRED"), "retired\n")
    } else {
      main = join(root, "main")
      mkdirSync(main)
      const common = layout === "separate-dot-git-dir" ? join(root, "store", ".git") : join(root, "store.git")
      if (layout === "separate-git-dir" || layout === "separate-dot-git-dir") {
        mkdirSync(dirname(common), { recursive: true })
        git(main, ["init", "-q", "-b", "main", `--separate-git-dir=${common}`])
        mkdirSync(join(dirname(common), ".beads"))
        writeFileSync(join(dirname(common), ".beads", "RETIRED"), "retired\n")
      } else {
        git(main, ["init", "-q", "-b", "main"])
      }
    }
    git(main, ["config", "user.email", "delivery@example.test"])
    git(main, ["config", "user.name", "Delivery Test"])
    writeFileSync(join(main, "base.txt"), "base\n")
    git(main, ["add", "base.txt"])
    git(main, ["commit", "-q", "-m", "base"])
    if (layout === "submodule") git(main, ["remote", "set-url", "origin", bare])
    else git(main, ["remote", "add", "origin", bare])
    git(main, ["push", "-q", "-u", "origin", "main"])
    mkdirSync(join(main, ".beads"))
  }
  if (ledger === "retired") writeFileSync(join(main, ".beads", "RETIRED"), "retired\n")

  const linked = join(root, "linked worktree")
  let head: string
  let merge: string
  if (layout === "normal") {
    rewriteCopiedWorktree(normalTemplate().root, root)
    git(linked, ["branch", "-m", branch])
    git(linked, ["config", `branch.${branch}.remote`, "origin"])
    git(linked, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`])
    if (branch !== "template") {
      git(main, ["update-ref", `refs/remotes/origin/${branch}`, "refs/remotes/origin/template"])
      git(main, ["update-ref", "-d", "refs/remotes/origin/template"])
    }
    head = git(linked, ["rev-parse", "HEAD"])
    merge = git(main, ["rev-parse", "HEAD"])
  } else {
    git(main, ["worktree", "add", "-q", "-b", branch, linked])
    writeFileSync(join(linked, "feature.txt"), "feature\n")
    git(linked, ["add", "feature.txt"])
    git(linked, ["commit", "-q", "-m", "feature"])
    git(linked, ["push", "-q", "-u", "origin", branch])
    head = git(linked, ["rev-parse", "HEAD"])
    git(main, ["merge", "-q", "--no-ff", branch, "-m", "merge feature"])
    merge = git(main, ["rev-parse", "HEAD"])
    git(main, ["push", "-q", "origin", "main"])
    git(bare, ["update-ref", "-d", `refs/heads/${branch}`])
  }

  const env = { ...process.env, DELIVERY_RECEIPTS_DIR: join(root, "agent", "receipts") }
  const key = repoKey(main)
  if (key === null) throw new Error("fixture repo has no key")
  const receipt = buildReceipt({
    now: NOW,
    emitter: { plugin: pkg.name, version: pkg.version, tool: "delivery_land" },
    repo: {
      key,
      canonicalRoot: realpathSync(main),
      remote: "origin",
      forge: "github",
      nameWithOwner: "owner/repo",
    },
    pr: {
      number: 17,
      url: "https://github.com/owner/repo/pull/17",
      state: "MERGED",
      baseRefName: "main",
      headRefName: branch,
      headRefOid: head,
      mergeCommitOid: merge,
      mergedAt: "2027-01-15T08:00:00.000Z",
    },
    branch: {
      name: branch,
      deletedRemote: true,
      remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z",
      autoDeleteSetting: "on",
    },
    worktree: { path: linked, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
    beads: { ids: ["delivery-17"], ledgerActive: ledger === "active" },
    proof: {
      method: "gh pr view",
      observedAt: "2027-01-15T08:00:00.000Z",
      evidence: { state: "MERGED" },
    },
    outcome: "landed",
  })
  receipt.forwardProof = { kept: true }
  const receiptPath = writeReceipt(receipt, receiptDirectory(env, key))
  return { root, main, linked, bare, branch, head, merge, env, receipt, receiptPath }
}

function success(stdout = "", exitCode = 0): CliResult {
  return { ok: true, exitCode, stdout, stderr: "" }
}

function githubPayload(f: Fixture, over: RunnerOptions["pr"] = {}): string {
  const state = over.state ?? "MERGED"
  const mergeCommitOid = over.mergeCommitOid === undefined ? f.receipt.pr.mergeCommitOid : over.mergeCommitOid
  return JSON.stringify({
    number: f.receipt.pr.number,
    url: over.url ?? f.receipt.pr.url,
    state,
    baseRefName: over.baseRefName ?? f.receipt.pr.baseRefName,
    headRefName: over.headRefName ?? f.receipt.pr.headRefName,
    headRefOid: over.headRefOid ?? f.receipt.pr.headRefOid,
    mergeCommit: mergeCommitOid === null ? null : { oid: mergeCommitOid },
    mergedAt: over.mergedAt === undefined ? f.receipt.pr.mergedAt : over.mergedAt,
  })
}

function gitlabPayload(f: Fixture, over: RunnerOptions["pr"] = {}): string {
  return JSON.stringify({
    iid: f.receipt.pr.number,
    web_url: over.url ?? f.receipt.pr.url,
    state: over.state ?? f.receipt.pr.state,
    target_branch: over.baseRefName ?? f.receipt.pr.baseRefName,
    source_branch: over.headRefName ?? f.receipt.pr.headRefName,
    sha: over.headRefOid ?? f.receipt.pr.headRefOid,
    merge_commit_sha: over.mergeCommitOid === undefined ? f.receipt.pr.mergeCommitOid : over.mergeCommitOid,
    merged_at: over.mergedAt === undefined ? f.receipt.pr.mergedAt : over.mergedAt,
  })
}

/**
 * The URL a remote name resolves to, which is the one Git read this runner scripts.
 *
 * The fixture's real `origin` is a local bare path, and no forge adapter verifies
 * a path as a host. The remote NAME is what a receipt records; the URL is what
 * classification and every forge query are bound to, so it is scripted here, and
 * `remotes` is how a contributor fork on `origin` is expressed.
 *
 * `realRemoteUrls` hands the read back to git, for the one case whose whole point is
 * that git resolves a URL differently per worktree.
 */
function remoteUrl(f: Fixture, remote: string, options: RunnerOptions): string | null {
  if (options.remotes !== undefined) return options.remotes[remote] ?? null
  const { forge, nameWithOwner } = f.receipt.repo
  const host = forge === "gitlab" ? "gitlab.com" : "github.com"
  return `https://${host}/${nameWithOwner}.git`
}

/**
 * These fixtures run real git, and a loaded machine stalls even a ref read past its
 * production bound; the bounds test below checks the production values.
 */
const HEAVY_FIXTURE_BOUNDS: Partial<CleanupBounds> = { refReadMs: 60_000 }

function runner(
  f: Fixture,
  options: RunnerOptions = {},
): { run: CliRunner; calls: string[][]; details: RecordedCall[] } {
  const calls: string[][] = []
  const details: RecordedCall[] = []
  const run: CliRunner = async (argv, commandOptions) => {
    calls.push([...argv])
    details.push({
      argv: [...argv],
      cwd: commandOptions.cwd,
      timeoutMs: commandOptions.timeoutMs,
      env: commandOptions.env,
    })
    options.before?.(argv, calls)
    let result: CliResult
    if (argv[0] === "gh") {
      result = success(githubPayload(f, options.pr))
    } else if (argv[0] === "glab") {
      result = success(gitlabPayload(f, options.pr))
    } else if (argv[0] === "bd") {
      result = success(
        JSON.stringify({
          schema_version: 1,
          data: options.beadRows ?? [
            {
              id: "delivery-17",
              status: options.beadStatus ?? "closed",
              metadata: { merge_sha: options.beadMergeSha ?? f.merge },
            },
          ],
        }),
      )
    } else if (argv[0] === "git" && argv[1] === "remote" && argv[2] === "get-url" && options.realRemoteUrls !== true) {
      if (options.remoteStdout !== undefined) {
        result = success(options.remoteStdout)
      } else {
        const url = remoteUrl(f, argv[3] ?? "", options)
        result =
          url === null
            ? { ok: true, exitCode: 1, stdout: "", stderr: `error: No such remote '${argv[3]}'\n` }
            : success(`${url}\n`)
      }
    } else if (argv[0] === "git" && argv.includes("ls-remote")) {
      const remote = options.remote ?? "absent"
      if (remote === "absent") result = success("", 2)
      else if (remote === "present") result = success(`${f.head}\trefs/heads/${f.branch}\n`)
      else result = { ok: false, exitCode: null, stdout: "", stderr: "", error: "timeout" }
    } else {
      result = await runCli(argv, commandOptions)
    }
    if (
      options.pathlessAfterRemove &&
      argv[0] === "git" &&
      argv[1] === "worktree" &&
      argv[2] === "list" &&
      calls.some((call) => call[0] === "git" && call[1] === "worktree" && call[2] === "remove")
    ) {
      result = success(`${result.stdout.trimEnd()}\n\nworktree \nHEAD ${f.head}\nbranch refs/heads/${f.branch}\n\n`)
    }
    if (
      options.registeredTargetAfterRemove &&
      argv[0] === "git" &&
      argv[1] === "worktree" &&
      argv[2] === "list" &&
      calls.some((call) => call[0] === "git" && call[1] === "worktree" && call[2] === "remove")
    ) {
      result = success(
        `${result.stdout.trimEnd()}\n\nworktree ${f.linked}\nHEAD ${f.head}\nbranch refs/heads/${f.branch}\n\n`,
      )
    }
    options.after?.(argv, result, calls)
    return result
  }
  return { run, calls, details }
}

async function invoke(
  f: Fixture,
  params: DeliveryCleanupParams = { receipt: f.receiptPath },
  options: RunnerOptions = {},
  extra: Partial<CleanupDeps> = {},
): Promise<{
  result: CleanupResult
  calls: string[][]
  details: RecordedCall[]
}> {
  const scripted = runner(f, options)
  const result = await cleanupDelivery(params, f.main, {
    run: scripted.run,
    now: () => NOW + 10,
    env: f.env,
    bounds: HEAVY_FIXTURE_BOUNDS,
    ...extra,
  })
  return { result, calls: scripted.calls, details: scripted.details }
}

function refusal(result: CleanupResult): string {
  if (result.ok) throw new Error(`expected refusal, got ${result.receipt.receiptId}`)
  return result.reason
}

function commandCalls(calls: string[][], verb: string): string[][] {
  return calls.filter((argv) => argv[0] === verb)
}

function mutationCalls(calls: string[][]): string[][] {
  return calls.filter(
    (argv) =>
      (argv[0] === "git" &&
        ((argv[1] === "worktree" && argv[2] === "remove") || (argv[1] === "branch" && argv[2] === "-d"))) ||
      (argv[0] === "bd" && !["show", "list"].includes(argv[1] ?? "")),
  )
}

describe("delivery_cleanup irreversible boundary", () => {
  test("removes one listed worktree then its local branch and records four independent absence verdicts", async () => {
    const f = fixture("happy")
    const listedPath = realpathSync(f.linked)
    const { result, calls } = await invoke(f, {
      receipt: f.receiptPath,
      pr: 17,
      branch: f.branch,
      worktree: f.linked,
      remote: "origin",
    })
    expect(calls.slice(0, 3)).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "remote", "get-url", "origin"],
      [
        "gh",
        "pr",
        "view",
        "17",
        "--repo",
        "github.com/owner/repo",
        "--json",
        "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
      ],
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(existsSync(f.linked)).toBe(false)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(1)
    const destructive = mutationCalls(calls)
    expect(destructive).toEqual([
      ["git", "worktree", "remove", listedPath],
      ["git", "branch", "-d", "--", f.branch],
    ])
    expect(calls.flat()).not.toContain("--force")
    expect(calls.flat()).not.toContain("-D")
    expect(commandCalls(calls, "bd").every((argv) => argv[1] === "show")).toBe(true)

    const validation = validateReceipt(result.receipt)
    expect(validation.ok).toBe(true)
    expect(result.receipt.outcome).toBe("cleaned")
    expect(result.receipt.supersedes).toBe(f.receipt.receiptId)
    expect(result.receipt.forwardProof).toEqual({ kept: true })
    expect(result.receipt.worktree).toEqual({
      path: f.linked,
      removed: true,
      localRefDeleted: true,
      absenceVerifiedAt: new Date(NOW + 10).toISOString(),
    })
    expect(result.receipt.branch.deletedRemote).toBe(true)
    expect(result.receipt.proof.evidence).toEqual({
      worktreeRegistration: "absent",
      worktreePath: "absent",
      localRef: "absent",
      remoteBranch: "absent",
      pushed: "upstream",
    })
    expect(readReceipt(result.path)).toEqual({ ok: true, receipt: result.receipt })
    expect(listReceipts(receiptDirectory(f.env, f.receipt.repo.key))).toHaveLength(2)
  }, 60_000)

  test("from another repository, a pr without a worktree or receipt still finds no receipt", async () => {
    const f = fixture("cross-bare-pr")
    const session = fixture("cross-bare-pr-session")
    const scripted = runner(f, {})
    const result = await cleanupDelivery({ pr: 17 }, session.main, {
      run: scripted.run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain("receipt")
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("a retired ledger, agreed by the receipt and the canonical root, cleans up with no bd command", async () => {
    const f = fixture("inactive-ledger", "feat/inactive-ledger", "retired")

    const { result, calls } = await invoke(f)

    expect(result.ok).toBe(true)
    expect(commandCalls(calls, "bd")).toEqual([])
    if (!result.ok) return
    expect(result.receipt.beads.ledgerActive).toBe(false)
    expect(existsSync(f.linked)).toBe(false)
  })

  test("a ledger-free receipt for another repository is denied before local mutation", async () => {
    const f = fixture("cross-repo-receipt", "feat/cross-repo-receipt", "retired")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      continues: f.receipt,
      repo: { ...f.receipt.repo, nameWithOwner: "attacker/elsewhere" },
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))

    const { result, calls } = await invoke(f, { receipt: path })

    expect(refusal(result)).toContain(
      'repo.nameWithOwner: observed "owner/repo", expected receipt value "attacker/elsewhere"',
    )
    expect(calls).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "remote", "get-url", "origin"],
    ])
    expect(commandCalls(calls, "bd")).toEqual([])
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("a receipt remote that cannot name one verified repository fails closed", async () => {
    const f = fixture("remote-identity", "feat/remote-identity", "retired")
    // A leading dash is an option to `git remote get-url`; whitespace padding is a
    // receipt that does not say which remote. Neither is trimmed into something
    // usable, and neither reaches a command that names a remote: the one call made
    // first is the target-identity listing the observation is resolved inside.
    //
    // The four line terminators are here because a receipt is a file: a generator
    // that wrote `origin\n` produced a value that must refuse, and U+2028/U+2029 are
    // line terminators to a JavaScript regex while surviving a JSON round trip
    // untouched.
    for (const remote of [
      "--upload-pack=touch",
      " origin",
      "origin\n",
      "origin\r",
      "origin\r\n",
      "origin\u2028",
      "origin\u2029",
      "or igin",
    ]) {
      const receipt = buildReceipt({
        ...f.receipt,
        now: NOW + 1,
        continues: f.receipt,
        repo: { ...f.receipt.repo, remote },
      })
      const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
      const { result, calls } = await invoke(f, { receipt: path })
      expect(refusal(result)).toContain(`repo.remote: observed ${JSON.stringify(remote)}, expected a git remote name`)
      expect(calls).toEqual([["git", "worktree", "list", "--porcelain"]])
      rmSync(path)
    }

    for (const [field, remotes] of [
      ["repo.remote", {}],
      ["repo.forge", { origin: "https://evil.example/owner/repo.git" }],
      ["repo.forge", { origin: "https://gitlab.com/owner/repo.git" }],
      ["repo.nameWithOwner", { origin: "https://github.com/" }],
      ["repo.nameWithOwner", { origin: "https://github.com/attacker/elsewhere.git" }],
    ] as const) {
      const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { remotes })
      expect(refusal(result)).toContain(field)
      expect(calls).toEqual([
        ["git", "worktree", "list", "--porcelain"],
        ["git", "remote", "get-url", "origin"],
      ])
    }
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  /**
   * `URL` deletes embedded tabs and newlines before parsing, so each of these reads as
   * an ordinary GitHub remote once the output is trimmed. Trimming would let the
   * identity comparison pass and authorise a removal whose absence probe could then
   * only ever answer "unknown" — a worktree deleted on an observation of nothing. The
   * output is read as exactly one record instead, and refusal precedes the forge read.
   *
   * The refusal also says nothing about the bytes. Output no parser accepted cannot be
   * redacted — a redactor can only find a secret in a spelling it understands — so the
   * cases below carry userinfo and a token query, and the refusal text must hold
   * neither those tokens nor the URL that framed them.
   */
  test("git remote get-url output that is not exactly one record refuses before the forge read", async () => {
    const f = fixture("remote-record", "feat/remote-record", "retired")
    for (const remoteStdout of [
      "https://git\thub.com/owner/repo.git\n",
      "https://github.com/owner/repo.git\n@evil.example/x\n",
      "https://github.com/owner/repo.git\nhttps://evil.example/owner/repo.git\n",
      "https://github.com/owner/repo.git\r\n\r\n",
      " https://github.com/owner/repo.git\n",
      "https://github.com/owner/repo.git \n",
      "\n",
      "",
      "https://srobroek:ghp_secrettoken@git\thub.com/owner/repo.git\n",
      "https://github.com/owner/repo.git?token=ghp_secrettoken\nhttps://evil.example/x\n",
      " ssh://git:ghp_secrettoken@github.com/owner/repo.git\n",
    ]) {
      const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { remoteStdout })
      const reason = refusal(result)
      expect(reason).toContain('repo.remote: observed "malformed Git remote output"')
      expect(reason).toContain("exactly one URL record")
      // Neither the secret nor the spelling that carried it.
      expect(reason).not.toContain("ghp_secrettoken")
      expect(reason).not.toContain("github.com/owner/repo")
      expect(reason).not.toContain("evil.example")
      expect(calls).toEqual([
        ["git", "worktree", "list", "--porcelain"],
        ["git", "remote", "get-url", "origin"],
      ])
      expect(mutationCalls(calls)).toEqual([])
    }
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("GitLab queries the receipt's project on the canonical host", async () => {
    const f = fixture("gitlab-local-repo", "feat/gitlab-local-repo", "retired")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      continues: f.receipt,
      repo: { ...f.receipt.repo, forge: "gitlab", nameWithOwner: "group/project" },
      pr: {
        ...f.receipt.pr,
        url: "https://gitlab.com/group/project/-/merge_requests/17",
        state: "merged",
      },
      proof: { ...f.receipt.proof, method: "glab mr view" },
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
    f.receipt = receipt
    f.receiptPath = path

    const { result, calls, details } = await invoke(f)

    expect(result.ok).toBe(true)
    expect(calls.slice(0, 3)).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "remote", "get-url", "origin"],
      ["glab", "mr", "view", "17", "--repo", "gitlab.com/group/project", "--output", "json"],
    ])
    const mr = details.find((call) => call.argv[0] === "glab")
    expect(mr?.env?.GITLAB_HOST).toBe("gitlab.com")
    expect(mr?.env?.GITLAB_API_HOST).toBe("gitlab.com")
    expect(mr?.cwd).toBeUndefined()
  }, 60_000)

  /**
   * The finding this pins: a checkout whose `origin` is a contributor fork and
   * whose `upstream` is the remote the landing was run with. `gh repo view` and
   * `glab repo view` answer for `origin`, so the observation came out of the fork
   * and a valid upstream receipt was refused, blocking cleanup after a landing
   * that had already succeeded — while the receipt named the right remote all
   * along.
   */
  for (const forge of ["github", "gitlab"] as const) {
    test(`${forge}: the observation follows the receipt's remote while origin is a fork`, async () => {
      const f = fixture(`fork-origin-${forge}`, `feat/fork-origin-${forge}`, "retired")
      git(f.main, ["remote", "add", "upstream", f.bare])
      const nameWithOwner = forge === "github" ? "owner/repo" : "group/project"
      const host = forge === "github" ? "github.com" : "gitlab.com"
      const receipt = buildReceipt({
        ...f.receipt,
        now: NOW + 1,
        continues: f.receipt,
        repo: { ...f.receipt.repo, remote: "upstream", forge, nameWithOwner },
        pr:
          forge === "github"
            ? f.receipt.pr
            : {
                ...f.receipt.pr,
                url: `https://gitlab.com/${nameWithOwner}/-/merge_requests/17`,
                state: "merged",
              },
        proof: { ...f.receipt.proof, method: forge === "github" ? "gh pr view" : "glab mr view" },
      })
      f.receiptPath = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
      f.receipt = receipt

      const { result, calls, details } = await invoke(
        f,
        { receipt: f.receiptPath },
        {
          remotes: {
            origin: `https://${host}/contributor/fork.git`,
            upstream: `https://${host}/${nameWithOwner}.git`,
          },
        },
      )

      expect(result.ok).toBe(true)
      expect(calls.slice(0, 3)).toEqual([
        ["git", "worktree", "list", "--porcelain"],
        ["git", "remote", "get-url", "upstream"],
        forge === "github"
          ? [
              "gh",
              "pr",
              "view",
              "17",
              "--repo",
              "github.com/owner/repo",
              "--json",
              "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
            ]
          : ["glab", "mr", "view", "17", "--repo", "gitlab.com/group/project", "--output", "json"],
      ])
      expect(calls.filter((argv) => argv[1] === "remote" && argv[2] === "get-url")).toEqual([
        ["git", "remote", "get-url", "upstream"],
      ])
      expect(calls.flat().join(" ")).not.toContain("contributor/fork")
      expect(calls.flat()).not.toContain("origin")
      // The absence probe is bound to the resolved URL, not the remote name: after
      // removal a name would be re-resolved by a surviving worktree's configuration.
      // The URL travels in the child's environment, so argv names only the alias.
      const absence = details.find((call) => call.argv.includes("ls-remote"))
      expect(absence?.argv.at(-2)).toBe("delivery-absence-probe")
      expect(absence?.argv).not.toContain("upstream")
      expect(absence?.env?.GIT_CONFIG_VALUE_0).toBe(`https://${host}/${nameWithOwner}.git`)
      expect(existsSync(f.linked)).toBe(false)
      if (!result.ok) return
      expect(result.receipt.repo.remote).toBe("upstream")
      expect(result.receipt.proof.method).toBe(forge === "github" ? "gh pr view" : "glab mr view")
    }, 60_000)
  }

  /**
   * A remote NAME resolves per repository; a remote URL resolves per worktree.
   *
   * `extensions.worktreeConfig` scopes `url.<other>.insteadOf` to a single worktree,
   * and `git remote get-url` expands those rewrites, so the landed worktree and the
   * directory cleanup must run from print different URLs for the same name. Nothing
   * here is scripted: git configures the rewrite and git answers both reads, and the
   * two `expect`s before the call record the premise as an observation rather than an
   * assumption. Resolved from the invocation worktree this receipt is unusable —
   * `origin` is the fork there — and the landed worktree it names becomes impossible
   * to clean.
   */
  test("the remote URL is resolved in the landed worktree, where a worktree-scoped rewrite applies", async () => {
    const f = fixture("worktree-config", "feat/worktree-config", "retired")
    const fork = "https://github.com/contributor/fork.git"
    const upstream = "https://github.com/owner/repo.git"
    git(f.main, ["config", "extensions.worktreeConfig", "true"])
    git(f.main, ["remote", "set-url", "origin", fork])
    git(f.linked, ["config", "--worktree", `url.${upstream}.insteadOf`, fork])
    // The surviving worktree rewrites the other way: any probe that loaded this
    // repository's configuration would be sent from upstream to the fork. It is the
    // worktree cleanup runs from, and the only one left once the target is removed.
    git(f.main, ["config", "--worktree", `url.${fork}.insteadOf`, upstream])
    expect(git(f.linked, ["remote", "get-url", "origin"])).toBe(upstream)
    expect(git(f.main, ["remote", "get-url", "origin"])).toBe(fork)
    // Captured before the call, because a successful cleanup removes this directory
    // and `realpathSync` then throws on a path that no longer exists.
    const landedPath = realpathSync(f.linked)

    const { result, calls, details } = await invoke(f, { receipt: f.receiptPath }, { realRemoteUrls: true })

    expect(result.ok).toBe(true)
    const identityRead = details.find((call) => call.argv[1] === "remote" && call.argv[2] === "get-url")
    expect(identityRead?.argv).toEqual(["git", "remote", "get-url", "origin"])
    // The directory is what makes the answer upstream's rather than the fork's.
    expect(identityRead?.cwd).toBe(landedPath)
    expect(calls.slice(0, 3)).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "remote", "get-url", "origin"],
      [
        "gh",
        "pr",
        "view",
        "17",
        "--repo",
        "github.com/owner/repo",
        "--json",
        "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
      ],
    ])
    expect(calls.flat().join(" ")).not.toContain("contributor/fork")
    // The post-removal absence probe is the second place a remote name would be
    // re-resolved, and by then the worktree that rewrites it is gone. It is bound to
    // the URL the target resolved — but through Git's environment config, because
    // `ps` shows argv to every user on the host and a remote URL may carry a token.
    // The command line therefore names an opaque alias and nothing else.
    const probe = details.find((call) => call.argv.includes("ls-remote"))
    expect(probe?.argv.at(-2)).toBe("delivery-absence-probe")
    expect(probe?.argv.join(" ")).not.toContain(upstream)
    expect(probe?.argv).not.toContain("origin")
    expect(probe?.env?.GIT_CONFIG_COUNT).toBe("1")
    expect(probe?.env?.GIT_CONFIG_KEY_0).toBe("remote.delivery-absence-probe.url")
    expect(probe?.env?.GIT_CONFIG_VALUE_0).toBe(upstream)
    // Config cannot reach that probe: no global file, no system file, and — because a
    // ceiling around the probe directory was measured not to stop a parent checkout's
    // rewrite — a repository of this module's own making, so there is no discovery to
    // redirect. The directory is gone once the call returns.
    expect(probe?.env?.GIT_CONFIG_GLOBAL).toBe(devNull)
    expect(probe?.env?.GIT_CONFIG_NOSYSTEM).toBe("1")
    expect(probe?.env?.GIT_DIR).toBe(join(probe?.cwd ?? "", "probe.git"))
    expect(probe?.env?.GIT_CEILING_DIRECTORIES).toBe(probe?.cwd)
    expect(probe?.cwd).not.toBe(f.main)
    expect(probe?.cwd).not.toBe(landedPath)
    expect(existsSync(probe?.cwd ?? "")).toBe(false)
    expect(existsSync(f.linked)).toBe(false)
  }, 60_000)

  test("cleanup strips every ambient forge and Git selector from the identity and pull-request reads", async () => {
    const f = fixture("ambient-redirectors", "feat/ambient-redirectors", "retired")
    Object.assign(f.env, {
      GH_REPO: "attacker/elsewhere",
      GH_HOST: "evil.example",
      GITLAB_HOST: "evil.example",
      GL_HOST: "evil.example",
      GITLAB_URI: "https://evil.example",
      GITLAB_API_HOST: "api.evil.example",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_CONFIG_GLOBAL: "/elsewhere/config",
      GH_TOKEN: "keep-gh",
      GITLAB_TOKEN: "keep-gitlab",
      GL_TOKEN: "keep-gl",
    })

    const { result, details } = await invoke(f)

    expect(result.ok).toBe(true)
    const forgeCalls = details.filter((call) => call.argv[0] === "gh")
    expect(forgeCalls).toHaveLength(1)
    for (const call of forgeCalls) {
      for (const key of ["GH_REPO", "GITLAB_HOST", "GL_HOST", "GITLAB_URI", "GITLAB_API_HOST"]) {
        expect(call.env?.[key]).toBeUndefined()
      }
      // Not merely stripped: replaced by the host `forgeTarget` verified, so the
      // CLI cannot fall back to a configured default host either.
      expect(call.env?.GH_HOST).toBe("github.com")
      expect(call.env?.GH_TOKEN).toBe("keep-gh")
      expect(call.env?.GITLAB_TOKEN).toBe("keep-gitlab")
      expect(call.env?.GL_TOKEN).toBe("keep-gl")
    }
    const identityRead = details.find((call) => call.argv[1] === "remote" && call.argv[2] === "get-url")
    expect(identityRead?.argv).toEqual(["git", "remote", "get-url", "origin"])
    // The ambient selectors are gone; the only GIT_DIR / GIT_WORK_TREE are the ones the
    // call pinned from the verified checkout, never the inherited "/elsewhere" values.
    expect(identityRead?.env?.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(identityRead?.env?.GIT_WORK_TREE).toBe(f.linked)
    expect(identityRead?.env?.GIT_DIR?.startsWith(join(f.main, ".git", "worktrees"))).toBe(true)
    expect(identityRead?.env?.GIT_COMMON_DIR).toBe(join(f.main, ".git"))
  }, 60_000)

  test("a valid receipt extension named ok cannot collide with cleanup's private resolution tag", async () => {
    const f = fixture("receipt-ok-extension")
    rmSync(f.receiptPath)
    f.receipt.ok = false
    const path = writeReceipt(f.receipt, receiptDirectory(f.env, f.receipt.repo.key))

    const { result } = await invoke(f, { receipt: path })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipt.ok).toBe(false)
    expect(result.receipt.outcome).toBe("cleaned")
    expect(existsSync(f.linked)).toBe(false)
  })

  test("a second call selects the cleaned continuation, refuses the absent worktree, and mutates nothing", async () => {
    const f = fixture("second")
    const first = await invoke(f)
    expect(first.result.ok).toBe(true)
    const second = await invoke(f, {})
    expect(refusal(second.result)).toContain("worktree.path: observed")
    expect(refusal(second.result)).toContain("absent after prior cleanup")
    expect(mutationCalls(second.calls)).toEqual([])
  })

  test("an unknown remote observation never becomes verified absence, while local cleanup stays truthful", async () => {
    const f = fixture("remote-unknown")
    const { result } = await invoke(f, { receipt: f.receiptPath }, { remote: "unknown" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.remoteBranchAbsence).toBe("unknown")
    expect(result.receipt.branch.deletedRemote).toBe(false)
    expect(result.receipt.branch.remoteAbsenceVerifiedAt).toBeNull()
    expect(result.receipt.worktree.removed).toBe(true)
    expect(result.receipt.worktree.localRefDeleted).toBe(true)
  })

  test("an explicit receipt outside the canonical repository receipt directory is refused before observation", async () => {
    const f = fixture("outside-receipt")
    const outside = join(scratch("explicit-tmp"), basename(f.receiptPath))
    copyFileSync(f.receiptPath, outside)
    const { result, calls } = await invoke(f, { receipt: outside })
    expect(refusal(result)).toContain(`receipt.path: observed "${outside}", expected a direct entry under`)
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("explicit and implicit receipt selection refuse a symlinked receipt parent", async () => {
    const f = fixture("receipt-parent-symlink")
    const directory = receiptDirectory(f.env, f.receipt.repo.key)
    const realDirectory = `${directory}-real`
    renameSync(directory, realDirectory)
    symlinkSync(realDirectory, directory, "dir")

    const explicit = await invoke(f, { receipt: f.receiptPath })
    expect(refusal(explicit.result)).toContain(`receipt.directory: observed "${directory} (unsafe)"`)
    expect(explicit.calls).toEqual([])
    const implicit = await invoke(f, { pr: f.receipt.pr.number })
    expect(refusal(implicit.result)).toContain(`receipt.directory: observed "${directory} (unsafe)"`)
    expect(implicit.calls).toEqual([])
  })

  test("receipt, argument, and each merged-PR mismatch precede every local-state observation", async () => {
    const f = fixture("proof-order")
    const missing = await invoke(f, { pr: 999 })
    expect(refusal(missing.result)).toContain(
      "receipt: observed null, expected the newest validated receipt for pr 999",
    )
    expect(missing.calls).toEqual([])

    appendFileSync(join(f.linked, "feature.txt"), "dirty\n")
    const argument = await invoke(f, { receipt: f.receiptPath, branch: "wrong" })
    expect(refusal(argument.result)).toContain(`branch: observed "wrong", expected receipt value "${f.branch}"`)
    expect(argument.calls).toEqual([])

    const mismatches: Array<{ pr: NonNullable<RunnerOptions["pr"]>; field: string }> = [
      { pr: { state: "OPEN" }, field: "pr.state" },
      { pr: { url: "https://github.com/owner/repo/pull/99" }, field: "pr.url" },
      { pr: { baseRefName: "other-base" }, field: "pr.baseRefName" },
      { pr: { headRefName: "other-head" }, field: "pr.headRefName" },
      { pr: { headRefOid: "a".repeat(40) }, field: "pr.headRefOid" },
      { pr: { mergeCommitOid: "b".repeat(40) }, field: "pr.mergeCommitOid" },
      { pr: { mergedAt: "2027-01-15T08:00:01.000Z" }, field: "pr.mergedAt" },
    ]
    for (const mismatch of mismatches) {
      const observed = await invoke(f, { receipt: f.receiptPath }, { pr: mismatch.pr })
      expect(refusal(observed.result)).toContain(`${mismatch.field}: observed`)
      // The pull-request read is now preceded by the target's identity, because the
      // remote is resolved inside the target. That is the only thing allowed to
      // precede it, and it is a listing: no dirty check, no unpushed check, no
      // ledger read, and nothing that mutates.
      expect(observed.calls.map((argv) => argv.slice(0, 3))).toEqual([
        ["git", "worktree", "list"],
        ["git", "remote", "get-url"],
        ["gh", "pr", "view"],
      ])
      expect(observed.calls.some((argv) => argv[0] === "git" && argv[1] === "status")).toBe(false)
      expect(observed.calls.some((argv) => argv[0] === "bd")).toBe(false)
      expect(mutationCalls(observed.calls)).toEqual([])
    }
  })

  test("a schema-valid receipt without a merge commit refuses before any observation or mutation", async () => {
    const f = fixture("missing-merge-authorization", "feat/missing-merge-authorization", "retired")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      pr: { ...f.receipt.pr, mergeCommitOid: null },
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))

    const { result, calls } = await invoke(f, { receipt: path }, { pr: { mergeCommitOid: null } })

    expect(refusal(result)).toContain("pr.mergeCommitOid")
    expect(refusal(result)).toContain("a non-empty merge commit oid before cleanup")
    expect(calls).toEqual([])
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
    rmSync(f.root, { recursive: true, force: true })
  })

  test("commits after the PR head refuse before anything is removed", async () => {
    const f = fixture("moved-on")
    writeFileSync(join(f.linked, "followup.txt"), "more work\n")
    git(f.linked, ["add", "followup.txt"])
    git(f.linked, ["commit", "-q", "-m", "follow-up work"])
    const { result, calls } = await invoke(f)
    expect(refusal(result)).toContain("worktree.HEAD: observed")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    rmSync(f.root, { recursive: true, force: true })
  })

  describe.each([
    ["a tracked change", "worktree.status", (f: Fixture) => writeFileSync(join(f.linked, git(f.linked, ["ls-files"]).split("\n")[0] ?? ""), "changed\n")],
    ["an untracked file", "worktree.status", (f: Fixture) => writeFileSync(join(f.linked, "untracked.txt"), "x\n")],
    ["a merge in progress", "worktree.operation", (f: Fixture) => writeFileSync(join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "MERGE_HEAD"), `${f.head}\n`)],
    ["a cherry-pick in progress", "worktree.operation", (f: Fixture) => writeFileSync(join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "CHERRY_PICK_HEAD"), `${f.head}\n`)],
    ["a rebase in progress", "worktree.operation", (f: Fixture) => mkdirSync(join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "rebase-merge"))],
    ["a bisect in progress", "worktree.operation", (f: Fixture) => writeFileSync(join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "BISECT_LOG"), "git bisect start\n")],
    ["a stash on the branch", "worktree.stash", (f: Fixture) => {
      writeFileSync(join(f.linked, "stashed.txt"), "x\n")
      git(f.linked, ["stash", "push", "-u", "-q", "-m", "keep me"])
    }],
  ])("the clean check refuses %s", (_name, gate, dirty) => {
    test("and removes nothing", async () => {
      const f = fixture("dirty-kind")
      dirty(f)
      const { result, calls } = await invoke(f)
      expect(refusal(result)).toContain(`${gate}: observed`)
      expect(mutationCalls(calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
      rmSync(f.root, { recursive: true, force: true })
    })
  })

  test("an ignored file does not make the worktree dirty", async () => {
    const f = fixture("ignored-ok")
    const commonExclude = join(resolve(f.linked, git(f.linked, ["rev-parse", "--git-common-dir"])), "info", "exclude")
    mkdirSync(dirname(commonExclude), { recursive: true })
    writeFileSync(commonExclude, "ignored.log\n")
    writeFileSync(join(f.linked, "ignored.log"), "noise\n")
    const { result } = await invoke(f)
    expect(result.ok).toBe(true)
    rmSync(f.root, { recursive: true, force: true })
  })

  test("a moved head, a dirty tree, an unpushed commit, and an open bead each refuse at their own gate", async () => {
    const f = fixture("refusal-order")
    writeFileSync(join(f.linked, "dirty.txt"), "dirty\n")
    const dirty = await invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" })
    expect(refusal(dirty.result)).toContain("worktree.status")
    expect(refusal(dirty.result)).toContain("dirty.txt")
    expect(commandCalls(dirty.calls, "bd")).toEqual([])

    // A commit moves the worktree off the head the receipt names, and the target's
    // identity is now proved before the pull request is read — because the remote is
    // resolved inside the target — so this refuses at `worktree.HEAD` rather than
    // reaching the unpushed count. The earlier gate is the point: the receipt no
    // longer describes this worktree at all.
    rmSync(join(f.linked, "dirty.txt"))
    writeFileSync(join(f.linked, "ahead.txt"), "ahead\n")
    git(f.linked, ["add", "ahead.txt"])
    git(f.linked, ["commit", "-q", "-m", "ahead"])
    const moved = await invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" })
    expect(refusal(moved.result)).toContain("worktree.HEAD: observed")
    expect(refusal(moved.result)).toContain(f.head)
    expect(moved.calls.map((argv) => argv.slice(0, 3))).toEqual([["git", "worktree", "list"]])

    // Unpushed with the head the receipt does name: the commit is dropped and the
    // tracking ref is rewound instead, which is what `@{upstream}..HEAD` counts.
    git(f.linked, ["reset", "-q", "--hard", f.head])
    git(f.linked, ["update-ref", `refs/remotes/origin/${f.branch}`, `${f.head}^`])
    const unpushed = await invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" })
    expect(refusal(unpushed.result)).toContain("branch.unpushed: observed 1, expected 0 commits")
    expect(commandCalls(unpushed.calls, "bd")).toEqual([])

    git(f.linked, ["update-ref", `refs/remotes/origin/${f.branch}`, f.head])
    const ledger = await invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" })
    expect(refusal(ledger.result)).toContain(
      `bd update delivery-17 --set-metadata pr=${f.receipt.pr.number} --set-metadata merge_sha=${f.receipt.pr.mergeCommitOid}`,
    )
    expect(mutationCalls(ledger.calls)).toEqual([])
  }, 60_000)

  test("a branch with no upstream is proved pushed by the merged pull request head", async () => {
    const f = fixture("no-upstream")
    git(f.linked, ["config", "--unset", `branch.${f.branch}.remote`])
    git(f.linked, ["config", "--unset", `branch.${f.branch}.merge`])
    const { result } = await invoke(f)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipt.proof.evidence.pushed).toBe("pr-head")
  }, 60_000)

  test("an upstream read that does not complete still refuses before the ledger read", async () => {
    const f = fixture("upstream-hung")
    const scripted = runner(f)
    const run: CliRunner = (argv, options) =>
      argv.includes("@{upstream}") && argv[1] === "rev-parse"
        ? { ok: false, exitCode: null, stdout: "", stderr: "", error: "git was killed by the 5000ms timeout" }
        : scripted.run(argv, options)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain("branch.upstream: observed")
    expect(commandCalls(scripted.calls, "bd")).toEqual([])
    expect(mutationCalls(scripted.calls)).toEqual([])
  }, 60_000)

  test("reconciliation requires every bead merge_sha to equal the receipt exactly", async () => {
    const f = fixture("ledger-sha")
    const observed = "b".repeat(40)
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { beadMergeSha: observed })
    const reason = refusal(result)
    expect(reason).toContain("beads.delivery-17.metadata.merge_sha")
    expect(reason).toContain(observed)
    expect(reason).toContain(f.merge)
    expect(reason).toContain(
      `bd update delivery-17 --set-metadata pr=${f.receipt.pr.number} --set-metadata merge_sha=${f.merge}`,
    )
    expect(commandCalls(calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]])
    expect(mutationCalls(calls)).toEqual([])
  })

  test("reconciliation refuses a closed bead without merge_sha and names native update", async () => {
    const f = fixture("ledger-missing-merge-sha")
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        beadRows: [{ id: "delivery-17", status: "closed", metadata: {} }],
      },
    )
    const reason = refusal(result)
    expect(reason).toContain("beads.delivery-17.metadata.merge_sha")
    expect(reason).toContain(
      `bd update delivery-17 --set-metadata pr=${f.receipt.pr.number} --set-metadata merge_sha=${f.merge}`,
    )
    expect(reason).toContain(
      `bd close delivery-17 --reason "PR #${f.receipt.pr.number} merged as ${f.merge}; receipt ${f.receiptPath}"`,
    )
    expect(commandCalls(calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]])
    expect(mutationCalls(calls)).toEqual([])
  })
  for (const [order, statuses] of [
    ["open then closed", ["open", "closed"]],
    ["closed then open", ["closed", "open"]],
  ] as const) {
    test(`conflicting duplicate bead statuses refuse in ${order} order without mutation`, async () => {
      const f = fixture(`duplicate-status-${statuses.join("-")}`)
      const beadRows = statuses.map((status) => ({
        id: "delivery-17",
        status,
        metadata: { merge_sha: f.merge },
      }))

      const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { beadRows })

      const reason = refusal(result)
      expect(reason).toContain("beads.delivery-17")
      expect(reason).toContain("duplicate bd show rows for one bead id to be identical")
      expect(reason).toContain(JSON.stringify(beadRows))
      expect(mutationCalls(calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
      expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
      rmSync(f.root, { recursive: true, force: true })
    })
  }

  for (const [order, identities] of [
    ["first then second", ["issue-one", "issue-two"]],
    ["second then first", ["issue-two", "issue-one"]],
  ] as const) {
    test(`conflicting duplicate bead identities refuse in ${order} order without mutation`, async () => {
      const f = fixture(`duplicate-identity-${identities.join("-")}`)
      const beadRows = identities.map((identity) => ({
        id: "delivery-17",
        identity,
        status: "closed",
        metadata: { merge_sha: f.merge },
      }))

      const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { beadRows })

      const reason = refusal(result)
      expect(reason).toContain("beads.delivery-17")
      expect(reason).toContain("duplicate bd show rows for one bead id to be identical")
      expect(reason).toContain(JSON.stringify(beadRows))
      expect(mutationCalls(calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
      expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
      rmSync(f.root, { recursive: true, force: true })
    })
  }

  test("identical duplicate bead rows coalesce without weakening cleanup authorization", async () => {
    const f = fixture("duplicate-identical")
    const issue = { id: "delivery-17", status: "closed", metadata: { merge_sha: f.merge } }
    const linked = realpathSync(f.linked)

    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { beadRows: [issue, structuredClone(issue)] })

    expect(result.ok).toBe(true)
    expect(mutationCalls(calls)).toEqual([
      ["git", "worktree", "remove", linked],
      ["git", "branch", "-d", "--", f.branch],
    ])
    rmSync(f.root, { recursive: true, force: true })
  })

  test("refuses the repository's main worktree", async () => {
    const mainTarget = fixture("main-target")
    const mainReceipt = buildReceipt({
      ...mainTarget.receipt,
      now: NOW + 1,
      pr: { ...mainTarget.receipt.pr, headRefName: "main", headRefOid: mainTarget.merge },
      branch: { ...mainTarget.receipt.branch, name: "main" },
      worktree: { path: mainTarget.main, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: mainTarget.receipt,
    })
    const mainPath = writeReceipt(mainReceipt, receiptDirectory(mainTarget.env, mainReceipt.repo.key))
    const mainRun = runner(mainTarget, { pr: { headRefName: "main", headRefOid: mainTarget.merge } })
    // Asked from the linked worktree: a call standing in its own target is refused
    // earlier, by the invocation check, and would not reach the main-worktree rule.
    const mainResult = await cleanupDelivery({ receipt: mainPath }, mainTarget.linked, {
      run: mainRun.run,
      now: () => NOW + 20,
      env: mainTarget.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(mainResult)).toContain("a linked worktree other than main")
    expect(mutationCalls(mainRun.calls)).toEqual([])
  })

  test("refuses a worktree from a foreign repository", async () => {
    const current = fixture("current-repo")
    const foreign = fixture("foreign-repo")
    const foreignReceipt = buildReceipt({
      ...current.receipt,
      now: NOW + 2,
      worktree: { path: foreign.linked, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: current.receipt,
    })
    const foreignPath = writeReceipt(foreignReceipt, receiptDirectory(current.env, foreignReceipt.repo.key))
    const foreignRun = runner(current)
    const foreignResult = await cleanupDelivery({ receipt: foreignPath }, current.main, {
      run: foreignRun.run,
      now: () => NOW + 20,
      env: current.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(foreignResult)).toContain("a worktree in the current repository")
    expect(mutationCalls(foreignRun.calls)).toEqual([])
  })

  test("refuses an unlisted path inside the same linked worktree", async () => {
    const unlisted = fixture("unlisted")
    const nested = join(unlisted.linked, "nested")
    mkdirSync(nested)
    const unlistedReceipt = buildReceipt({
      ...unlisted.receipt,
      now: NOW + 3,
      worktree: { path: nested, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: unlisted.receipt,
    })
    const unlistedPath = writeReceipt(unlistedReceipt, receiptDirectory(unlisted.env, unlistedReceipt.repo.key))
    const unlistedRun = runner(unlisted)
    const unlistedResult = await cleanupDelivery({ receipt: unlistedPath }, unlisted.main, {
      run: unlistedRun.run,
      now: () => NOW + 20,
      env: unlisted.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(unlistedResult)).toContain("an exact live record in git worktree list --porcelain")
    expect(mutationCalls(unlistedRun.calls)).toEqual([])
  })

  test("a symlink alias cannot turn an untrusted receipt path into a listed target", async () => {
    const f = fixture("symlink")
    const alias = join(f.root, "linked-alias")
    symlinkSync(f.linked, alias, "dir")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      worktree: { path: alias, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: f.receipt,
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: path }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain(`${alias} (unsafe)`)
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a dirtying race at the irreversible boundary is observed before removal", async () => {
    const f = fixture("dirty-race")
    let statuses = 0
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        before: (argv) => {
          if (argv[0] === "git" && argv[1] === "status") {
            statuses += 1
            if (statuses === 2) writeFileSync(join(f.linked, "raced.txt"), "raced\n")
          }
        },
      },
    )
    expect(refusal(result)).toContain("raced.txt")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a ref that moves after worktree removal is not force-deleted and emits no receipt", async () => {
    const f = fixture("ref-race")
    const beforeReceipts = readFileSync(f.receiptPath, "utf8")
    const raced = git(f.main, ["commit-tree", `${f.merge}^{tree}`, "-p", f.merge, "-m", "raced ref"])
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        after: (argv, commandResult) => {
          if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
            git(f.main, ["update-ref", `refs/heads/${f.branch}`, raced])
          }
        },
      },
    )
    expect(refusal(result)).toContain("branch.localRef: observed")
    expect(git(f.main, ["rev-parse", `refs/heads/${f.branch}`])).toBe(raced)
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
    expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipts)
  })

  test("re-registration after removal is detected independently and stops branch deletion", async () => {
    const f = fixture("registration-race")
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        after: (argv, commandResult) => {
          if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
            git(f.main, ["worktree", "add", "-q", f.linked, f.branch])
          }
        },
      },
    )
    expect(refusal(result)).toContain('worktree.registrationAbsence: observed "present", expected "absent"')
    expect(existsSync(f.linked)).toBe(true)
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
  })

  test("a stored registration path remains present proof after its filesystem target vanishes", async () => {
    const f = fixture("stored-registration")
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { registeredTargetAfterRemove: true })
    expect(refusal(result)).toContain('worktree.registrationAbsence: observed "present", expected "absent"')
    expect(existsSync(f.linked)).toBe(false)
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
  })

  test("a pathless porcelain record makes post-remove registration proof unknown", async () => {
    const f = fixture("pathless-record")
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { pathlessAfterRemove: true })
    expect(refusal(result)).toContain('worktree.registrationAbsence: observed "unknown", expected "absent"')
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
  })

  test("filesystem-path recreation after removal is independent of registration absence", async () => {
    const f = fixture("path-race")
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        after: (argv, commandResult) => {
          if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
            mkdirSync(f.linked)
          }
        },
      },
    )
    expect(refusal(result)).toContain('worktree.pathAbsence: observed "present", expected "absent"')
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
  })

  test("local-ref recreation after branch -d is independently reported and emits no receipt", async () => {
    const f = fixture("local-ref-race")
    const { result } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        after: (argv, commandResult) => {
          if (argv[0] === "git" && argv[1] === "branch" && argv[2] === "-d" && commandResult.exitCode === 0) {
            git(f.main, ["update-ref", `refs/heads/${f.branch}`, f.head])
          }
        },
      },
    )
    expect(refusal(result)).toContain('worktree.localRefAbsence: observed "present", expected "absent"')
    expect(git(f.main, ["rev-parse", `refs/heads/${f.branch}`])).toBe(f.head)
  })

  test("hostile shell punctuation remains one argv element and cannot create a side effect", async () => {
    const marker = join(tmpdir(), "delivery-cleanup-must-not-exist")
    rmSync(marker, { force: true })
    const branch = `feat/cleanup;touch-${marker.replaceAll("/", "-")}`
    const f = fixture("argv", branch)
    const { result, calls } = await invoke(f)
    expect(result.ok).toBe(true)
    expect(calls).toContainEqual(["git", "branch", "-d", "--", branch])
    expect(existsSync(marker)).toBe(false)
  })

  test("a leading-dash branch remains an operand after the branch-delete option terminator", () => {
    expect(branchDeleteArgs("-malicious-option")).toEqual(["branch", "-d", "--", "-malicious-option"])
  })
})

/**
 * One runner for a real `delivery_land` call against a fixture repository: the forge
 * reads are scripted, every Git read is answered by the fixture's own repository.
 *
 * Scripted `git remote get-url` is the one exception. The fixture's `origin` is a
 * local bare path, which `detectForge` correctly refuses as no forge; the URL is what
 * the landing classifies, and the remote NAME is what the receipt records. The
 * `ls-remote` reads are scripted too: the base branch's tip is the fixture's merge
 * commit, and the head branch is unknown.
 */
function landRunner(f: Fixture): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: CliRunner = (argv, options) => {
    calls.push([...argv])
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return success(githubPayload(f))
    if (argv[0] === "gh" && argv[1] === "api") return success("false\n")
    if (argv[0] === "git" && argv[1] === "remote" && argv[2] === "get-url")
      return success("https://github.com/owner/repo.git\n")
    if (argv[0] === "git" && argv.includes("ls-remote") && argv.includes(`refs/heads/${f.receipt.pr.baseRefName}`))
      return success(`${f.receipt.pr.mergeCommitOid}\trefs/heads/${f.receipt.pr.baseRefName}\n`)
    if (argv[0] === "git" && argv.includes("ls-remote")) return success("", 2)
    return runCli(argv, options)
  }
  return { run, calls }
}

/**
 * The classification seam is the security boundary this whole tool stands on, so it
 * is exercised against real repositories: a real `.beads` at a real canonical root, a
 * real nested retired marker, and a real linked worktree that really disappears or
 * really survives.
 */
describe("the ledger is classified at the canonical root, never at a caller's directory", () => {
  /**
   * The escalation the final integration review proved, end to end and now closed:
   * land from a directory shadowed by a nested retired `.beads`, then clean from the
   * repository whose canonical ledger is active. Before the fix the receipt recorded
   * `ledgerActive: false` from the shadowed directory and cleanup returned success
   * from the ledger gate without issuing a single `bd` call, deleting the worktree and
   * the branch while the bead stayed open.
   */
  test("a landing from a shadowed directory records the canonical verdict, and cleanup then requires reconciliation", async () => {
    const f = fixture("bypass", "omp/agent/delivery-17")
    const shadowed = join(f.main, "nested")
    mkdirSync(join(shadowed, ".beads"), { recursive: true })
    writeFileSync(join(shadowed, ".beads", "RETIRED"), "retired\n")

    const landing = landRunner(f)
    const landed = await landPullRequest(
      { pr: f.receipt.pr.number, worktree: f.linked },
      { run: landing.run, cwd: shadowed, now: () => NOW + 5, env: f.env },
    )
    expect(landed.ok).toBe(true)
    if (!landed.ok) throw new Error(landed.reason)
    expect(landed.receipt.beads).toEqual({ ids: ["delivery-17"], ledgerActive: true })
    expect(landed.receipt.proof.evidence).toMatchObject({ ledger: { root: realpathSync(f.main), active: true } })
    expect(landed.receipt.repo.remote).toBe("origin")
    expect(landed.next).toEqual([
      `bd update delivery-17 --set-metadata pr=${landed.receipt.pr.number} --set-metadata merge_sha=${landed.receipt.pr.mergeCommitOid}`,
      `bd close delivery-17 --reason "PR #${landed.receipt.pr.number} merged as ${landed.receipt.pr.mergeCommitOid}; receipt ${landed.receiptPath}"`,
      "delivery_cleanup",
    ])

    const cleaning = runner(f)
    const cleaned = await cleanupDelivery({ receipt: landed.receiptPath }, f.main, {
      run: cleaning.run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(cleaned.ok).toBe(true)
    // The gate ran: the bypass was a cleanup that reached success with no bd call.
    expect(commandCalls(cleaning.calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]])
    expect(existsSync(f.linked)).toBe(false)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(1)
  })

  test("an unreconciled bead still refuses that same landing, so the gate is the ledger's and not the receipt's", async () => {
    const f = fixture("bypass-open-bead", "omp/agent/delivery-17")
    const shadowed = join(f.main, "nested")
    mkdirSync(join(shadowed, ".beads"), { recursive: true })
    writeFileSync(join(shadowed, ".beads", "RETIRED"), "retired\n")

    const landed = await landPullRequest(
      { pr: f.receipt.pr.number, worktree: f.linked },
      { run: landRunner(f).run, cwd: shadowed, now: () => NOW + 5, env: f.env },
    )
    expect(landed.ok).toBe(true)
    if (!landed.ok) throw new Error(landed.reason)

    const cleaning = runner(f, { beadStatus: "open" })
    const refused = await cleanupDelivery({ receipt: landed.receiptPath }, f.main, {
      run: cleaning.run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(refused)).toContain(
      `bd update delivery-17 --set-metadata pr=${landed.receipt.pr.number} --set-metadata merge_sha=${landed.receipt.pr.mergeCommitOid}`,
    )
    expect(mutationCalls(cleaning.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
  })

  for (const layout of ["separate-git-dir", "separate-dot-git-dir", "submodule"] as const) {
    test(`${layout}: an active checkout ledger requires reconciliation and preserves an open bead's worktree and branch`, async () => {
      const f = fixture(`live-${layout}`, "omp/agent/delivery-17", "active", layout)
      const landed = await landPullRequest(
        { pr: f.receipt.pr.number, worktree: f.linked },
        { run: landRunner(f).run, cwd: f.main, now: () => NOW + 5, env: f.env },
      )

      expect(landed.ok).toBe(true)
      if (!landed.ok) throw new Error(landed.reason)
      expect(landed.receipt.repo.canonicalRoot).toBe(realpathSync(f.main))
      expect(landed.receipt.beads).toEqual({ ids: ["delivery-17"], ledgerActive: true })
      expect(landed.next).toEqual([
        `bd update delivery-17 --set-metadata pr=${landed.receipt.pr.number} --set-metadata merge_sha=${landed.receipt.pr.mergeCommitOid}`,
        `bd close delivery-17 --reason "PR #${landed.receipt.pr.number} merged as ${landed.receipt.pr.mergeCommitOid}; receipt ${landed.receiptPath}"`,
        "delivery_cleanup",
      ])

      const cleaning = runner(f, { beadStatus: "open" })
      const refused = await cleanupDelivery({ receipt: landed.receiptPath }, f.main, {
        run: cleaning.run,
        now: () => NOW + 10,
        env: f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
      })
      expect(refusal(refused)).toContain(
        `bd update delivery-17 --set-metadata pr=${landed.receipt.pr.number} --set-metadata merge_sha=${landed.receipt.pr.mergeCommitOid}`,
      )
      expect(commandCalls(cleaning.calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]])
      expect(mutationCalls(cleaning.calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
      expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
    })
  }

  /**
   * The same receipt an unfixed producer would have written, and the same receipt an
   * attacker would forge: `ledgerActive: false` over a repository whose canonical
   * ledger is active. The stored boolean alone never opens the success path.
   */
  test("a stale or tampered false claim is refused against the recomputed verdict, and nothing is removed", async () => {
    const f = fixture("stale-false-claim")
    const stale = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      beads: { ids: f.receipt.beads.ids, ledgerActive: false },
    })
    const stalePath = writeReceipt(stale, receiptDirectory(f.env, stale.repo.key))

    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: stalePath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    const reason = refusal(result)
    expect(reason).toContain("beads.ledgerActive: observed false stored in the receipt, expected true")
    expect(reason).toContain(`recomputed at canonical root "${realpathSync(f.main)}"`)
    expect(reason).toContain(
      `bd update delivery-17 --set-metadata pr=${f.receipt.pr.number} --set-metadata merge_sha=${f.receipt.pr.mergeCommitOid}`,
    )
    expect(mutationCalls(calls)).toEqual([])
    expect(commandCalls(calls, "bd")).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
  })

  test("a true claim over a retired canonical root is refused just as loudly", async () => {
    const f = fixture("stale-true-claim", "feat/stale-true-claim", "retired")
    const claimed = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      beads: { ids: f.receipt.beads.ids, ledgerActive: true },
    })
    const claimedPath = writeReceipt(claimed, receiptDirectory(f.env, claimed.repo.key))

    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: claimedPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    const reason = refusal(result)
    expect(reason).toContain("beads.ledgerActive: observed true stored in the receipt, expected false")
    expect(reason).toContain(`recomputed at canonical root "${realpathSync(f.main)}"`)
    // Receipts minted before the canonical-root fix carry this claim; the refusal names the way out.
    expect(reason).toContain(
      `run delivery_land for PR #${claimed.pr.number} again with worktree "${claimed.worktree.path}"`,
    )
    expect(reason).toContain("then run delivery_cleanup with that new receipt")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  /**
   * An active ledger with nothing to reconcile is refused by the receipt's own
   * validator, so a tampered file carrying that pair never reaches the ledger gate.
   */
  test("a tampered receipt claiming an active ledger with no bead ids is refused when it is read", async () => {
    const f = fixture("tampered-empty-ids")
    const directory = receiptDirectory(f.env, f.receipt.repo.key)
    const tampered = { ...f.receipt, beads: { ids: [], ledgerActive: true } }
    rmSync(f.receiptPath)
    writeFileSync(join(directory, `${f.receipt.receiptId}.json`), JSON.stringify(tampered))

    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    expect(refusal(result)).toContain(
      "beads.ids: observed array of 0, expected at least one bead id when beads.ledgerActive is true",
    )
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })
})

describe("delivery_cleanup never removes the worktree it was called from", () => {
  test("a call from inside its own target refuses, naming the invocation and the resolved target", async () => {
    const f = fixture("invocation-target")
    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.linked, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    const reason = refusal(result)
    expect(reason).toContain(`worktree.invocationCwd: observed "${f.linked}"`)
    expect(reason).toContain(realpathSync(f.linked))
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
  })

  test("a subdirectory of the target is inside the target", async () => {
    const f = fixture("invocation-nested")
    const nested = join(f.linked, "deep", "deeper")
    mkdirSync(nested, { recursive: true })
    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, nested, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    expect(refusal(result)).toContain("expected a directory outside the worktree this call would remove")
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a symlinked alias of the target is still the target", async () => {
    const f = fixture("invocation-alias")
    const alias = join(f.root, "alias")
    symlinkSync(f.linked, alias, "dir")
    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, alias, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    expect(refusal(result)).toContain("worktree.invocationCwd")
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  /**
   * The probe used to be asked from a surviving worktree, because a remote NAME only
   * resolves inside the repository that configures it. It is now given the URL the
   * landed worktree resolved, so it is asked from nowhere in particular on purpose:
   * any checkout it ran in could rewrite that URL through `url.<base>.insteadOf` and
   * send the question to another repository, whose answer would become a false
   * absence here.
   */
  test("the remote-absence probe is asked outside every checkout, and its directory does not survive", async () => {
    const f = fixture("probe-cwd")
    const scripted = runner(f)
    // Classified inside the hook, while the directory still exists: afterwards it is
    // gone, and "no repository" would be true of any deleted path.
    const probes: { cwd: string | undefined; key: string | null }[] = []
    const run: CliRunner = (argv, options) => {
      if (argv.includes("ls-remote")) {
        probes.push({ cwd: options.cwd, key: options.cwd === undefined ? null : repoKey(options.cwd) })
      }
      return scripted.run(argv, options)
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    expect(result.ok).toBe(true)
    expect(probes).toHaveLength(1)
    const asked = probes[0]?.cwd
    if (asked === undefined) throw new Error("the probe was issued with no working directory")
    expect(asked).not.toBe(f.main)
    expect(asked.startsWith(f.root)).toBe(false)
    expect(probes[0]?.key).toBeNull()
    expect(existsSync(asked)).toBe(false)
  })
})

/**
 * The tool is registered, so no harness deadline applies: each bound is sized by the
 * work its command does. Cheap ref reads keep 5 s; a cold embedded store needs far
 * longer than that to answer `bd show`, and a removal stopped mid-way leaves a
 * half-deleted worktree.
 */
describe("delivery_cleanup command bounds and interrupts", () => {
  /** A command that never answers on its own: only its bound or an interrupt ends it. */
  const hang = (options: Parameters<CliRunner>[1]) => runCli(["sleep", "30"], options)

  test("each command is bounded by its work, and no mutation or bd read runs under the 5 s ref-read bound", async () => {
    const f = fixture("bounds")
    // The bound each command was given is recorded; it then runs under a generous one,
    // so a loaded machine cannot trip the production bound this test reads back.
    const scripted = runner(f)
    const details: { argv: string[]; timeoutMs: number }[] = []
    const run: CliRunner = (argv, options) => {
      details.push({ argv: [...argv], timeoutMs: options.timeoutMs })
      return scripted.run(argv, { ...options, timeoutMs: Math.max(options.timeoutMs, 60_000) })
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, { run, now: () => NOW + 10, env: f.env })
    expect(result.ok).toBe(true)
    const bounds = (match: (argv: string[]) => boolean) =>
      details.filter((call) => match(call.argv)).map((call) => call.timeoutMs)
    expect(bounds((argv) => argv[0] === "bd")).toEqual([120_000])
    expect(bounds((argv) => argv[1] === "worktree" && argv[2] === "remove")).toEqual([600_000])
    expect(bounds((argv) => argv[1] === "branch" && argv[2] === "-d")).toEqual([600_000])
    expect(bounds((argv) => argv[1] === "status")).toEqual([60_000, 60_000])
    const refReads = bounds(
      (argv) =>
        argv[0] === "git" &&
        (["rev-parse", "rev-list", "show-ref", "remote"].includes(argv[1] ?? "") ||
          (argv[1] === "worktree" && argv[2] === "list")),
    )
    expect(refReads.length).toBeGreaterThan(0)
    expect(refReads.every((bound) => bound === CLEANUP_BOUNDS.refReadMs)).toBe(true)
    expect(CLEANUP_BOUNDS.refReadMs).toBe(5_000)
  })

  test("bounds.refReadMs replaces the ref-read bound on every ref read", async () => {
    const f = fixture("configured-ref-read")
    const scripted = runner(f)
    const refReads: number[] = []
    const run: CliRunner = (argv, options) => {
      if (argv[0] === "git" && ["rev-parse", "rev-list", "show-ref", "remote"].includes(argv[1] ?? ""))
        refReads.push(options.timeoutMs)
      return scripted.run(argv, options)
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: { refReadMs: 61_000 },
    })
    expect(result.ok).toBe(true)
    expect(refReads.length).toBeGreaterThan(0)
    expect(refReads.every((bound) => bound === 61_000)).toBe(true)
  })

  test("bounds.refReadMs also bounds the repository identity reads", async () => {
    const f = fixture("configured-repository-read")
    const reads: { argv: readonly string[]; timeoutMs: number }[] = []
    const git: GitRunner = (argv, cwd, timeoutMs) => {
      reads.push({ argv, timeoutMs })
      const proc = Bun.spawnSync(["git", ...SAFE_GIT_ARGS, ...argv], { cwd, env: process.env, stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
      return proc.exitCode === 0 ? proc.stdout.toString() : null
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run: runner(f).run,
      now: () => NOW + 10,
      env: f.env,
      bounds: { refReadMs: 61_000 },
      git,
    })
    expect(result.ok).toBe(true)
    // The repository key, the target's common directory (twice: before the reads and at
    // the boundary) and the canonical ledger root.
    expect(reads.map((read) => read.argv[0] === "rev-parse" && read.argv.at(-1))).toEqual([
      "--git-common-dir",
      "--show-toplevel",
      "--show-toplevel",
      "--show-toplevel",
    ])
    expect(reads.every((read) => read.timeoutMs === 61_000)).toBe(true)
  })

  test("a bd show that hangs past its bound reports the ledger step not done, and nothing is removed", async () => {
    const f = fixture("hung-bd")
    const scripted = runner(f)
    const run: CliRunner = (argv, options) => (argv[0] === "bd" ? hang(options) : scripted.run(argv, options))
    const started = Date.now()
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: { ...HEAVY_FIXTURE_BOUNDS, bdShowMs: 300 },
    })
    expect(Date.now() - started).toBeLessThan(10_000)
    const reason = refusal(result)
    expect(reason.startsWith("beads: observed")).toBe(true)
    expect(reason).toContain("no exit status")
    expect(reason).toContain("killed by the 300ms timeout")
    expect(mutationCalls(scripted.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("an interrupt ends a hung read at once, long before its bound, and nothing is removed", async () => {
    const f = fixture("interrupted-read")
    const scripted = runner(f)
    const controller = new AbortController()
    const run: CliRunner = (argv, options) => {
      if (argv[0] !== "bd") return scripted.run(argv, options)
      setTimeout(() => controller.abort(), 200)
      return hang(options)
    }
    const started = Date.now()
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      signal: controller.signal,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(refusal(result)).toContain("killed by an abort")
    expect(mutationCalls(scripted.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("an interrupt observed after the last read refuses before the removal starts", async () => {
    const f = fixture("interrupted-boundary")
    const scripted = runner(f)
    const controller = new AbortController()
    // The second `rev-list --count` is the last read before the removal, so the
    // abort lands where only the pre-removal check can observe it.
    let counts = 0
    const run: CliRunner = async (argv, options) => {
      const result = await scripted.run(argv, options)
      if (argv[1] === "rev-list" && ++counts === 2) controller.abort()
      return result
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      signal: controller.signal,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain("nothing was removed")
    expect(mutationCalls(scripted.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("an interrupt that arrives once the removal has started neither reaches it nor stops the steps after it", async () => {
    const f = fixture("interrupted-removal")
    const scripted = runner(f)
    const controller = new AbortController()
    const signalled: { argv: string[]; signal: boolean }[] = []
    const run: CliRunner = (argv, options) => {
      signalled.push({ argv: [...argv], signal: options.signal !== undefined })
      if (argv[1] === "worktree" && argv[2] === "remove") controller.abort()
      return scripted.run(argv, options)
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      signal: controller.signal,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(result.ok).toBe(true)
    expect(existsSync(f.linked)).toBe(false)
    const removal = signalled.findIndex((call) => call.argv[1] === "worktree" && call.argv[2] === "remove")
    expect(removal).toBeGreaterThan(0)
    expect(signalled.slice(0, removal).every((call) => call.signal)).toBe(true)
    expect(signalled.slice(removal).some((call) => call.signal)).toBe(false)
  })
})

describe("removalRoute", () => {
  const identity = (path: string) => path
  test.each([
    { name: "a listed directory goes to the host", listed: ["/r", "/w/a"], target: "/w/a", route: "host" },
    { name: "an unlisted directory goes to git", listed: ["/r", "/w/b"], target: "/w/a", route: "git" },
    { name: "an empty registry goes to git", listed: [] as string[], target: "/w/a", route: "git" },
  ])("$name", ({ listed, target, route }) => {
    expect(
      removalRoute(
        listed.map((directory) => ({ directory })),
        target,
        identity,
      ),
    ).toBe(route)
  })

  test("paths are compared after canonicalisation, so an alias still matches", () => {
    const canonical = (path: string) => path.replace("/alias", "/real")
    expect(removalRoute([{ directory: "/real/w" }], "/alias/w", canonical)).toBe("host")
  })
})

describe("delivery_cleanup host worktree registry", () => {
  /** A fake host registry that removes through git like the host's git strategy; it refuses on request. */
  function fakeHost(f: Fixture, registered: string[], refuse?: string) {
    const entries = new Set(registered)
    const removes: Array<{ directory: string }> = []
    return {
      removes,
      host: {
        list: async () => [...entries].map((directory) => ({ directory })),
        remove: async (directory: string) => {
          removes.push({ directory })
          if (refuse !== undefined) throw new Error(refuse)
          execFileSync("git", ["worktree", "remove", directory], { cwd: f.main })
          entries.delete(directory)
        },
      },
    }
  }

  test("a host-registered worktree is removed through the host, never by git, and leaves the registry", async () => {
    const f = fixture("host-registered")
    const listedPath = realpathSync(f.linked)
    const fake = fakeHost(f, [listedPath])
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host: fake.host })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(fake.removes).toEqual([{ directory: listedPath }])
    expect(await fake.host.list()).toEqual([])
    expect(calls.filter((argv) => argv[1] === "worktree" && argv[2] === "remove")).toEqual([])
    expect(mutationCalls(calls)).toEqual([["git", "branch", "-d", "--", f.branch]])
    expect(existsSync(f.linked)).toBe(false)
    expect(result.receipt.worktree.removed).toBe(true)
    expect(result.receipt.proof.evidence).toMatchObject({ worktreeRegistration: "absent", worktreePath: "absent" })
  }, 60_000)

  test("a host whose listing fails leaves ownership unknown: refuse, remove nothing, no git fallback", async () => {
    const f = fixture("host-list-fails")
    const host = {
      list: async () => {
        throw new Error("registry offline")
      },
      remove: async () => {
        throw new Error("must not be called")
      },
    }
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host })
    const reason = refusal(result)
    expect(reason).toContain("worktree.owner")
    expect(reason).toContain("registry offline")
    expect(reason).toContain("retry delivery_cleanup")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("an abort during the host listing stops the call before any removal", async () => {
    const f = fixture("host-list-abort")
    const controller = new AbortController()
    const removes: string[] = []
    const host = {
      list: async () => {
        controller.abort()
        return [{ directory: realpathSync(f.linked) }]
      },
      remove: async (directory: string) => {
        removes.push(directory)
      },
    }
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host, signal: controller.signal })
    expect(refusal(result)).toContain("signal")
    expect(removes).toEqual([])
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("a worktree the host does not list is removed by git as before", async () => {
    const f = fixture("host-unlisted")
    const listedPath = realpathSync(f.linked)
    const fake = fakeHost(f, [f.main])
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host: fake.host })
    expect(result.ok).toBe(true)
    expect(fake.removes).toEqual([])
    expect(mutationCalls(calls)[0]).toEqual(["git", "worktree", "remove", listedPath])
  }, 60_000)

  test("a host refusal is reported and neither forced nor retried with git", async () => {
    const f = fixture("host-refuses")
    const fake = fakeHost(f, [realpathSync(f.linked)], "worktree contains modified files")
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host: fake.host })
    const reason = refusal(result)
    expect(reason).toContain("worktree.removed")
    expect(reason).toContain("worktree contains modified files")
    expect(mutationCalls(calls)).toEqual([])
    expect(calls.flat()).not.toContain("--force")
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)
})

/** The options every checkout-bound Git command must carry, spelled out and independent of the source constant. */
const EXPECTED_SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-optional-locks"]

describe("the Git start check", () => {
  // The containment the two "no Git ran in the target" checks below rely on.
  const session = () => fixture("selector-session")
  const start = (cwd: string, argv: string[], env: Partial<Pick<GitSpawn, "gitDir" | "workTree" | "commonDir">> = {}): GitSpawn => ({
    cwd,
    gitDir: env.gitDir ?? "",
    workTree: env.workTree ?? "",
    commonDir: env.commonDir ?? "",
    argv,
  })

  test("a start that selects only the allowed checkout is inside it", () => {
    const { main } = session()
    const pinned = start(main, [...SAFE_GIT_ARGS, "-C", ".", "--git-dir=.git", "status"], { gitDir: ".git", workTree: main })
    expect(outside([pinned], main)).toEqual([])
  })

  test.each([
    ["-C", (target: string) => ["-C", target, "rev-parse", "--git-dir"], {}],
    ["--git-dir as a separate word", (target: string) => ["--git-dir", join(target, ".git"), "rev-parse"], {}],
    ["--git-dir=", (target: string) => [`--git-dir=${join(target, ".git")}`, "rev-parse"], {}],
    ["--work-tree=", (target: string) => [`--work-tree=${target}`, "status"], {}],
    ["-C after -c", (target: string) => [...SAFE_GIT_ARGS, "-C", target, "status"], {}],
  ] as const)("a start from the allowed directory that selects the target through %s is outside", (_name, argv) => {
    const { main, linked } = session()
    expect(outside([start(main, argv(linked))], main)).toHaveLength(1)
  })

  test("an environment path that only spells the allowed root before a .. is outside", () => {
    const { main, linked } = session()
    const lexical = `${main}/../${basename(linked)}`
    expect(lexical.startsWith(`${main}/`)).toBe(true)
    for (const env of [{ gitDir: `${lexical}/.git` }, { workTree: lexical }, { commonDir: `${main}/../${basename(main)}x` }])
      expect(outside([start(main, ["status"], env)], main)).toHaveLength(1)
  })

  test("argv after the subcommand is not a repository selector", () => {
    const { main, linked } = session()
    expect(outside([start(main, ["log", "-C", linked])], main)).toEqual([])
  })
})

describe("delivery_cleanup fails closed on another repository", () => {
  const selectors = [
    ["the receipt path", (f: Fixture): DeliveryCleanupParams => ({ receipt: f.receiptPath })],
    ["the worktree", (f: Fixture): DeliveryCleanupParams => ({ pr: 17, worktree: f.linked })],
  ] as const
  const hosts = [
    ["without a host registry", undefined],
    [
      "with a host registry",
      {
        list: async () => [],
        remove: async () => {
          throw new Error("the host remover must not be called")
        },
      },
    ],
  ] as const

  describe.each(selectors)("selected by %s", (_selector, params) => {
    test.each(hosts)("%s: refused before any Git process runs in the target", async (_name, host) => {
      const f = fixture("foreign-target")
      const session = fixture("foreign-session")
      const { markers } = hostileConfig(f)
      // Sanity: the same hostile checkout does run its programs under plain Git.
      execFileSync("git", ["status", "--porcelain"], {
        cwd: f.linked,
        env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
      })
      expect(ranMarkers(markers)).toEqual(expect.arrayContaining(["fsmonitor", "included", "process"]))
      for (const marker of Object.values(markers)) rmSync(marker, { force: true })

      const spawns = gitSpawnLog()
      const scripted = runner(f, {})
      try {
        const result = await cleanupDelivery(params(f), session.main, {
          run: scripted.run,
          now: () => NOW + 10,
          env: f.env,
          bounds: HEAVY_FIXTURE_BOUNDS,
          ...(host === undefined ? {} : { host }),
        })
        const reason = refusal(result)
        expect(reason).toContain("worktree.owner")
        expect(reason).toContain("from a session in that repository")
        // Every Git start, not only those found in the target: each ran in the session's repository.
        const log = spawns.log()
        expect(log.length).toBeGreaterThan(0)
        expect(outside(log, session.main)).toEqual([])
      } finally {
        spawns.restore()
      }
      expect(ranMarkers(markers)).toEqual([])
      expect(scripted.details.filter((call) => call.cwd !== undefined && call.cwd !== session.main)).toEqual([])
      expect(mutationCalls(scripted.calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
    }, 60_000)
  })
})

describe("delivery_cleanup Git options in its own repository", () => {
  /** Cleanup with the real Git behind the runner, raw argv included, so overrides actually take effect. */
  function realGitRunner(f: Fixture): { run: CliRunner; raw: string[][] } {
    const scripted = runner(f, {})
    const raw: string[][] = []
    const run: CliRunner = (argv, options) => {
      if (argv[0] === "git") raw.push([...argv])
      const verb = withoutSafeGit(argv)
      if (verb[0] !== "git" || verb[1] === "remote" || verb.includes("ls-remote")) return scripted.run(verb, options)
      return runCli(argv, options)
    }
    return { run, raw }
  }

  test("every checkout-bound Git command carries the literal safe options", async () => {
    const f = fixture("safe-literal")
    const { run, raw } = realGitRunner(f)
    const result = await cleanupDeliveryUnwrapped({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(result.ok).toBe(true)
    const bound = raw.filter((argv) => !argv.includes("ls-remote"))
    expect(bound.some((argv) => argv.includes("status"))).toBe(true)
    for (const argv of bound) expect(argv.slice(0, 1 + EXPECTED_SAFE_GIT.length)).toEqual(["git", ...EXPECTED_SAFE_GIT])
  }, 60_000)

  test("hooks and filter drivers of the checkout do not run during a full cleanup", async () => {
    const f = fixture("safe-hooks")
    const { markers } = hostileConfig(f)
    for (const marker of Object.values(markers)) rmSync(marker, { force: true }) // setup reads may have fired some
    const { run } = realGitRunner(f)
    const result = await cleanupDeliveryUnwrapped({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    // The attribute-selected filter driver is not covered by the options; the hooks and
    // the fsmonitor are. This is the session's own repository, which it already trusts.
    expect(result.ok).toBe(true)
    for (const name of ["fsmonitor", "hook-post-checkout", "hook-reference-transaction", "hook-post-index-change"]) {
      expect(existsSync(markers[name] ?? "")).toBe(false)
    }
    // Sanity: plain Git does fire the reference-transaction hook for the same kind of write.
    git(f.main, ["update-ref", "refs/heads/zz-sanity", "HEAD"])
    expect(existsSync(markers["hook-reference-transaction"] ?? "")).toBe(true)
  }, 60_000)

  test("a refused cleanup leaves the index byte-identical", async () => {
    const f = fixture("safe-index")
    const indexPath = join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "index")
    const tracked = git(f.linked, ["ls-files"]).split("\n")[0] ?? ""
    writeFileSync(join(f.linked, tracked), readFileSync(join(f.linked, tracked)))
    writeFileSync(join(f.linked, "untracked.txt"), "dirty\n")
    const before = readFileSync(indexPath)
    const { run } = realGitRunner(f)
    const result = await cleanupDeliveryUnwrapped({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain("worktree.status")
    expect(readFileSync(indexPath).equals(before)).toBe(true)
    // Sanity: plain `git status` refreshes the stat-dirty entry, so the check above can fail.
    git(f.linked, ["status", "--porcelain"])
    expect(readFileSync(indexPath).equals(before)).toBe(false)
  }, 60_000)
})

describe("delivery_cleanup pins Git to the verified worktree", () => {
  test("a marker swapped after verification does not redirect Git", async () => {
    const f = fixture("pinned-swap")
    const foreign = fixture("pinned-swap-foreign")
    const { markers } = hostileConfig(foreign)
    for (const marker of Object.values(markers)) rmSync(marker, { force: true })
    let swapped = false
    const { result, details } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        before: (argv) => {
          if (swapped || argv[1] !== "status") return
          swapped = true
          writeFileSync(join(f.linked, ".git"), readFileSync(join(foreign.linked, ".git")))
        },
      },
    )
    expect(swapped).toBe(true)
    // The first status ran after the swap, yet against the verified repository: its env pins
    // the session's admin directory and the worktree, so the changed marker was never consulted.
    const status = details.find((call) => call.argv.includes("status"))
    expect(status?.env?.GIT_DIR?.startsWith(join(f.main, ".git", "worktrees"))).toBe(true)
    expect(status?.env?.GIT_WORK_TREE).toBe(f.linked)
    expect(status?.env?.GIT_COMMON_DIR).toBe(join(f.main, ".git"))
    // The next verification reads the swapped marker and refuses before the removal.
    expect(refusal(result)).toContain("worktree.marker")
    expect(ranMarkers(markers)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("the removal and branch deletion run pinned to a verified main worktree", async () => {
    const f = fixture("pinned-exec")
    const { result, details } = await invoke(f)
    expect(result.ok).toBe(true)
    for (const verb of [["worktree", "remove"], ["branch", "-d"]]) {
      const call = details.find((entry) => entry.argv.includes(verb[0] as string) && entry.argv.includes(verb[1] as string))
      expect(call?.env?.GIT_DIR).toBe(join(f.main, ".git"))
      expect(call?.env?.GIT_WORK_TREE).toBe(f.main)
    }
  }, 60_000)
})

describe("delivery_cleanup resolves the target path once", () => {
  test("a symlinked parent switched between steps cannot move any step to another tree", async () => {
    const f = fixture("resolve-once")
    const foreign = fixture("resolve-once-foreign")
    const alias = join(scratch("alias"), "parent")
    symlinkSync(f.root, alias, "dir")
    const viaAlias = join(alias, basename(f.linked))
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      worktree: { path: viaAlias, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: f.receipt,
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
    let switched = false
    const { result, details } = await invoke(
      f,
      { receipt: path },
      {
        before: (argv) => {
          if (switched || argv[1] !== "status") return
          switched = true
          rmSync(alias)
          symlinkSync(foreign.root, alias, "dir")
        },
      },
    )
    expect(switched).toBe(true)
    // Every command run in the target used the one physical path, never the alias.
    const inTarget = details.filter((call) => call.cwd !== undefined && call.cwd !== f.main && call.argv[0] === "git")
    expect(inTarget.length).toBeGreaterThan(0)
    for (const call of inTarget) {
      expect(call.cwd).toBe(f.linked)
      expect(call.env?.GIT_WORK_TREE).toBe(f.linked)
    }
    expect(details.some((call) => call.cwd?.includes(alias) === true)).toBe(false)
    // The next verification resolves the receipt path afresh and no longer finds a registered worktree.
    expect(refusal(result)).toContain("worktree.")
    expect(mutationCalls(details.map((call) => call.argv))).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("a receipt path that does not resolve is refused before any Git runs in it", async () => {
    const f = fixture("resolve-missing")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      worktree: { path: join(f.root, "missing"), removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: f.receipt,
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
    const { result, details } = await invoke(f, { receipt: path })
    expect(refusal(result)).toContain("worktree.path")
    expect(details.filter((call) => call.cwd === join(f.root, "missing"))).toEqual([])
  }, 60_000)
})

describe("delivery_cleanup refuses a registered worktree whose directory is not this repository's", () => {
  /** Each way the directory behind an intact registration can stop belonging to the session repository. */
  const replacements: Array<[string, (f: Fixture, foreign: Fixture) => void]> = [
    [
      ".git replaced by a symlink to another repository",
      (f, foreign) => {
        rmSync(join(f.linked, ".git"))
        symlinkSync(join(foreign.main, ".git"), join(f.linked, ".git"))
      },
    ],
    [
      ".git file naming another repository's worktree admin directory",
      (f, foreign) => {
        writeFileSync(join(f.linked, ".git"), readFileSync(join(foreign.linked, ".git")))
      },
    ],
    [
      "directory replaced by another repository's checkout",
      (f, foreign) => {
        rmSync(f.linked, { recursive: true, force: true })
        cpSync(foreign.main, f.linked, { recursive: true })
      },
    ],
    [
      ".git whose gitdir has a leading blank, so Git reads it as a relative name inside the target",
      (f, foreign) => {
        const admin = /^gitdir: (.+)$/m.exec(readFileSync(join(foreign.linked, ".git"), "utf8"))?.[1] ?? ""
        mkdirSync(join(f.linked, ` ${admin}`), { recursive: true })
        writeFileSync(join(f.linked, ` ${admin}`, "commondir"), `${join(f.main, ".git")}\n`)
        writeFileSync(join(f.linked, ".git"), `gitdir:  ${admin}\n`)
      },
    ],
    [
      ".git replaced by a FIFO",
      (f) => {
        rmSync(join(f.linked, ".git"))
        Bun.spawnSync(["mkfifo", join(f.linked, ".git")])
      },
    ],
    [
      "gitdir whose commondir is a FIFO",
      (f) => {
        const evil = scratch("evil-gitdir")
        Bun.spawnSync(["mkfifo", join(evil, "commondir")])
        writeFileSync(join(f.linked, ".git"), `gitdir: ${evil}\n`)
      },
    ],
    [
      "gitdir whose commondir is a symlink to a FIFO",
      (f) => {
        const evil = scratch("evil-gitdir")
        const fifo = join(scratch("fifo"), "pipe")
        Bun.spawnSync(["mkfifo", fifo])
        symlinkSync(fifo, join(evil, "commondir"))
        writeFileSync(join(f.linked, ".git"), `gitdir: ${evil}\n`)
      },
    ],
  ]

  test.each(replacements)("%s", async (_name, replace) => {
    const f = fixture("marker-target")
    const foreign = fixture("marker-foreign")
    const { markers } = hostileConfig(foreign)
    for (const marker of Object.values(markers)) rmSync(marker, { force: true })
    replace(f, foreign)

    const spawns = gitSpawnLog()
    const scripted = runner(f, {})
    try {
      const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
        run: scripted.run,
        now: () => NOW + 10,
        env: f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
      })
      expect(refusal(result)).toContain("worktree.marker")
      // Every Git start, not only those found in the target: each ran in the session's own checkout.
      const log = spawns.log()
      expect(log.length).toBeGreaterThan(0)
      expect(outside(log, f.main)).toEqual([])
    } finally {
      spawns.restore()
    }
    expect(ranMarkers(markers)).toEqual([])
    expect(scripted.details.filter((call) => call.cwd === f.linked)).toEqual([])
    expect(mutationCalls(scripted.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 30_000)
})

describe("pending cleanup: one remover per worktree", () => {
  type Harness = Awaited<ReturnType<typeof harness>>
  async function harness(
    name: string,
    over: {
      beadStatus?: string
      maxPerPass?: number
      list?: (query: Record<string, unknown>) => Promise<unknown>
      before?: RunnerOptions["before"]
      hook?: boolean
      bounds?: Partial<CleanupBounds>
      observe?: GitRunner
      lock?: Record<string, unknown>
    } = {},
  ) {
    const f = fixture(name)
    const options: RunnerOptions = { beadStatus: over.beadStatus ?? "closed", ...(over.before ? { before: over.before } : {}) }
    const scripted = runner(f, options)
    const fake = createFakeContext({ directory: f.main })
    if (over.list) (fake.context.session as unknown as { list: unknown }).list = over.list
    if (over.hook === false) {
      const session = fake.context.session as unknown as { hook: (name: string, callback: unknown) => Promise<unknown> }
      const original = session.hook.bind(session)
      session.hook = (hookName, callback) =>
        hookName === "experimental.idle" ? Promise.reject(new Error("unknown hook")) : original(hookName, callback)
    }
    let clock = NOW + 10
    const pending = createPendingCleanup({
      ctx: fake.context,
      cwd: f.main,
      env: f.env,
      host: () => undefined,
      debounceMs: 1,
      ...(over.maxPerPass === undefined ? {} : { maxPerPass: over.maxPerPass }),
      cleanup: { run: stripped(scripted.run), now: () => NOW + 10, bounds: over.bounds ?? HEAVY_FIXTURE_BOUNDS },
      now: () => clock,
      ...(over.observe === undefined ? {} : { observe: over.observe }),
      ...(over.lock === undefined ? {} : { lock: over.lock }),
    })
    const common = repositoryContext(f.main)?.commonDir as string
    const advance = (ms: number) => {
      clock += ms
    }
    const idle = async (sessionID = "ses_lead") => {
      fake.emit({ type: "session.idle", data: { sessionID } })
      await pending.settle()
    }
    const claim = () =>
      writeClaim(common, { directory: f.linked, branch: f.branch, sessionID: "ses_child", parentID: "ses_lead", createdAt: 1 })
    const finish = async () => {
      await pending.dispose()
      rmSync(f.root, { recursive: true, force: true })
    }
    return { f, options, scripted, fake, pending, common, advance, idle, claim, finish }
  }
  const removed = (h: Harness) => !existsSync(h.f.linked)
  const synthetic = (h: Harness) => h.fake.calls.filter((entry) => entry.method === "session.synthetic")

  test("a receipt landed with beads open is nudged once; after the beads close, the next idle removes the worktree", async () => {
    const h = await harness("pending-retry", { beadStatus: "open" })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(synthetic(h)).toHaveLength(1)
    expect(JSON.stringify(synthetic(h)[0]?.input)).toContain("Landed PR #17: close beads delivery-17")
    await h.idle()
    expect(synthetic(h)).toHaveLength(1)
    expect(removed(h)).toBe(false)
    h.options.beadStatus = "closed"
    h.advance(60_000)
    await h.idle()
    expect(removed(h)).toBe(true)
    expect(readLanding(h.common, h.f.receipt.receiptId)).toEqual({ kind: "missing" })
    await h.finish()
  })

  test("a lane's claim keeps delivery from removing the worktree, however many turns end", async () => {
    const h = await harness("pending-claimed")
    await h.pending.record(h.f.receipt, "ses_lead")
    h.claim()
    await h.pending.start()
    await h.idle()
    h.advance(60_000)
    await h.idle()
    expect(removed(h)).toBe(false)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    expect(readLanding(h.common, h.f.receipt.receiptId).kind).toBe("present")
    await h.finish()
  })

  test("an unreadable claim is not 'no claim': delivery keeps the worktree", async () => {
    const h = await harness("pending-claim-corrupt")
    await h.pending.record(h.f.receipt, "ses_lead")
    mkdirSync(dirname(claimFile(h.common, h.f.linked)), { recursive: true })
    writeFileSync(claimFile(h.common, h.f.linked), "{not json")
    await h.pending.start()
    await h.idle()
    expect(removed(h)).toBe(false)
    await h.finish()
  })

  test("a lane claimed after delivery's snapshot is not removed: ownership is checked again before the removal", async () => {
    let claimed = false
    let h: Harness | undefined
    h = await harness("pending-claimed-late", {
      before: (argv) => {
        if (argv.includes("status") && !claimed) {
          claimed = true
          h?.claim()
        }
      },
    })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(claimed).toBe(true)
    expect(removed(h)).toBe(false)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    await h.finish()
  })

  test("a denial written after the snapshot blocks the removal at the last check", async () => {
    let written = false
    let h: Harness | undefined
    h = await harness("pending-denied-late", {
      before: (argv) => {
        if (argv.includes("status") && !written && h) {
          written = true
          writeLanding(h.common, {
            receiptId: h.f.receipt.receiptId,
            worktree: h.f.linked,
            headRefOid: h.f.head,
            sessionID: "ses_lead",
            landedAt: 1,
            denied: { at: 2, sessionID: "ses_lead" },
          })
        }
      },
    })
    await h.pending.start()
    await h.idle()
    expect(written).toBe(true)
    expect(removed(h)).toBe(false)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    await h.finish()
  })

  test("a landing record that cannot be read blocks the removal at the last check", async () => {
    let written = false
    let h: Harness | undefined
    h = await harness("pending-record-corrupt-late", {
      before: (argv) => {
        if (argv.includes("status") && !written && h) {
          written = true
          mkdirSync(dirname(landingFile(h.common, "9-bad")), { recursive: true })
          writeFileSync(landingFile(h.common, "9-bad"), "garbage")
        }
      },
    })
    await h.pending.start()
    await h.idle()
    expect(written).toBe(true)
    expect(removed(h)).toBe(false)
    await h.finish()
  })

  test("once the claim is gone the same receipt is removed", async () => {
    const h = await harness("pending-claim-released")
    await h.pending.record(h.f.receipt, "ses_lead")
    h.claim()
    await h.pending.start()
    await h.idle()
    expect(removed(h)).toBe(false)
    removeClaim(h.common, h.f.linked)
    h.advance(60_000)
    await h.idle()
    expect(removed(h)).toBe(true)
    await h.finish()
  })

  describe("denials", () => {
    test("a denied cleanup is not retried in the background", async () => {
      const h = await harness("pending-denied")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("a refused explicit call keeps (and renews) the denial; idle still removes nothing", async () => {
      const h = await harness("pending-denied-again")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      const first = readLanding(h.common, h.f.receipt.receiptId)
      h.advance(60_000)
      await expect(
        authorizeExplicit(h.pending, async () => {
          throw new Error("denied by the user")
        }, "ses_lead", { worktree: h.f.linked }),
      ).rejects.toThrow("denied by the user")
      const second = readLanding(h.common, h.f.receipt.receiptId)
      expect(second.kind === "present" && second.value.denied !== undefined).toBe(true)
      expect(second.kind === "present" && first.kind === "present" && (second.value.denied?.at ?? 0) > (first.value.denied?.at ?? 0)).toBe(true)
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("a refused explicit call on a receipt with no record yet creates the denial", async () => {
      const h = await harness("pending-denied-fresh")
      await expect(
        authorizeExplicit(h.pending, async () => {
          throw new Error("no")
        }, "ses_lead", { worktree: h.f.linked }),
      ).rejects.toThrow("no")
      expect(readLanding(h.common, h.f.receipt.receiptId)).toMatchObject({ kind: "present", value: { denied: { sessionID: "ses_lead" } } })
      await h.finish()
    })

    test("an authorized explicit call re-arms it, and the next idle removes the worktree", async () => {
      const h = await harness("pending-rearmed")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await authorizeExplicit(h.pending, async () => {}, "ses_lead", { worktree: h.f.linked })
      expect(readLanding(h.common, h.f.receipt.receiptId)).toMatchObject({ kind: "present" })
      const record = readLanding(h.common, h.f.receipt.receiptId)
      expect(record.kind === "present" && record.value.denied).toBeFalsy()
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })
  })

  describe("it fails closed on who is in the worktree", () => {
    const clear = (query: Record<string, unknown>) =>
      Promise.resolve(
        query.cursor === undefined
          ? { data: [{ id: "old", time: { busy: 1, idle: 2 } }], cursor: { next: "p2" } }
          : { data: [{ id: "older", time: { busy: 1, idle: 2 } }] },
      )

    test("a lookup error holds the worktree", async () => {
      const h = await harness("pending-list-error", {
        list: async () => {
          throw new Error("boom")
        },
      })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("an owner on the second page holds the worktree", async () => {
      const h = await harness("pending-page-two", {
        list: async (query) =>
          query.cursor === undefined
            ? { data: [{ id: "old", time: { busy: 1, idle: 2 } }], cursor: { next: "p2" } }
            : { data: [{ id: "live", time: { busy: 9, idle: 2 } }] },
      })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("with every page read and no owner the worktree is removed", async () => {
      const h = await harness("pending-page-clear", { list: clear })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })
  })

  test("without the experimental.idle hook the events still retry", async () => {
    const h = await harness("pending-no-hook", { hook: false })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    expect(h.fake.hooks("session")).not.toContain("experimental.idle")
    h.fake.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_lead" } })
    await h.pending.settle()
    expect(removed(h)).toBe(true)
    await h.finish()
  })

  test("receipts that need no attempt do not starve one that does", async () => {
    const h = await harness("pending-window", { maxPerPass: 1 })
    const key = repoKey(h.f.main) as string
    const parked = join(h.f.root, "parked worktree")
    mkdirSync(parked)
    const newer = buildReceipt({
      now: NOW + 5000,
      emitter: h.f.receipt.emitter,
      repo: h.f.receipt.repo,
      pr: { ...h.f.receipt.pr, number: 18 },
      branch: { ...h.f.receipt.branch, name: "feat/parked" },
      worktree: { ...h.f.receipt.worktree, path: parked },
      beads: h.f.receipt.beads,
      proof: h.f.receipt.proof,
      outcome: "landed",
    })
    writeReceipt(newer, receiptDirectory(h.f.env, key))
    await h.pending.record(newer, "ses_lead", { denied: true })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(removed(h)).toBe(true)
    expect(existsSync(parked)).toBe(true)
    await h.finish()
  })

  describe("one removal boundary for every delivery remover", () => {
    const explicitCleanup = (h: Harness) =>
      cleanupDelivery({ receipt: h.f.receiptPath }, h.f.main, {
        run: h.scripted.run,
        now: () => NOW + 10,
        env: h.f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
        ...h.pending.explicit(async () => {}, "ses_lead"),
      })

    test("an authorized explicit cleanup of an unclaimed worktree with a live hold removes nothing", async () => {
      const h = await harness("explicit-hold")
      setHold(h.common, h.f.linked, "ses_x", [{ kind: "shell", id: "x" }], NOW + 10)
      const result = await explicitCleanup(h)
      expect(result.ok).toBe(false)
      expect(refusal(result)).toContain("worktree.held")
      expect(refusal(result)).toContain("background job")
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("the same explicit cleanup removes the worktree once nothing holds it", async () => {
      const h = await harness("explicit-clear")
      const result = await explicitCleanup(h)
      expect(result.ok).toBe(true)
      expect(removed(h)).toBe(true)
      await h.finish()
    })

    test("a lock another remover holds keeps delivery's removal from running", async () => {
      const h = await harness("explicit-locked", { lock: { waitMs: 60 } })
      await h.pending.record(h.f.receipt, "ses_lead")
      mkdirSync(join(h.common, "opencode", "locks"), { recursive: true })
      writeFileSync(
        lockFile(h.common, h.f.linked),
        JSON.stringify({ pid: process.pid, host: hostname().split(".")[0], owner: "subagent-worktree", token: "theirs", taken: NOW + 10, expires: NOW + 10 + 60_000 }),
      )
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      expect(JSON.parse(readFileSync(lockFile(h.common, h.f.linked), "utf8")).token).toBe("theirs")
      await h.finish()
    })

    // Reads happen between the section's first look and the removal call: the tree is scanned a second
    // time (revalidateBoundary). Whatever appears during that scan must still stop the removal.
    const onSecondStatus = (act: () => void): RunnerOptions["before"] => {
      let scans = 0
      return (argv) => {
        if (argv.includes("status") && argv.includes("--porcelain") && ++scans === 2) act()
      }
    }

    test("a denial that appears during the second tree scan stops the removal", async () => {
      let h: Harness | undefined
      h = await harness("final-denial", {
        before: onSecondStatus(() =>
          writeLanding(h!.common, {
            receiptId: h!.f.receipt.receiptId,
            worktree: h!.f.linked,
            headRefOid: h!.f.head,
            sessionID: "ses_lead",
            landedAt: 1,
            denied: { at: 2, sessionID: "ses_lead" },
          }),
        ),
      })
      const result = await explicitCleanup(h)
      expect(refusal(result)).toContain("worktree.held")
      expect(refusal(result)).toContain("denied")
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("a hold that appears during the second tree scan stops the removal", async () => {
      let h: Harness | undefined
      h = await harness("final-hold", {
        before: onSecondStatus(() => setHold(h!.common, h!.f.linked, "ses_x", [{ kind: "shell", id: "x" }], NOW + 10)),
      })
      const result = await explicitCleanup(h)
      expect(refusal(result)).toContain("worktree.held")
      expect(refusal(result)).toContain("background job")
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("a claim that appears during the second tree scan stops the removal too", async () => {
      let h: Harness | undefined
      h = await harness("final-claim", { before: onSecondStatus(() => h!.claim()) })
      const result = await explicitCleanup(h)
      expect(refusal(result)).toContain("worktree.held")
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("writers wait for a removal in flight: a hold written from outside lands after it, not inside it", async () => {
      let h: Harness | undefined
      let writer: Promise<void> | undefined
      h = await harness("writers-serialised", {
        before: (argv) => {
          if (argv.includes("remove") && h && writer === undefined) {
            // A competing writer starts while the removal holds the lock.
            writer = lockedWrite(h.common, h.f.linked, { sessionID: "writer", waitMs: 5000 }, () =>
              setHold(h!.common, h!.f.linked, "ses_late", [{ kind: "shell", id: "late" }], NOW + 10),
            )
          }
        },
      })
      const result = await explicitCleanup(h)
      expect(result.ok).toBe(true)
      // The write had to wait for the lock, so it happened after the removal, never in between.
      await writer
      expect(readHolds(h.common, h.f.linked).holds.map((hold) => hold.sessionID)).toEqual(["ses_late"])
      await h.finish()
    })

    test("a denial that could not be written to disk (lock busy) is still remembered, and the retry never removes it", async () => {
      const h = await harness("denied-unwritten", { lock: { waitMs: 40 } })
      mkdirSync(join(h.common, "opencode", "locks"), { recursive: true })
      writeFileSync(
        lockFile(h.common, h.f.linked),
        JSON.stringify({ pid: process.pid, host: hostname().split(".")[0], owner: "other", token: "theirs", taken: NOW + 10, expires: NOW + 10 + 60_000 }),
      )
      await expect(h.pending.record(h.f.receipt, "ses_lead", { denied: true })).rejects.toThrow()
      rmSync(lockFile(h.common, h.f.linked))
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("an abort during the final lookup that then returns clear still stops the removal", async () => {
      const h = await harness("final-abort")
      const controller = new AbortController()
      const result = await cleanupDelivery({ receipt: h.f.receiptPath }, h.f.main, {
        run: h.scripted.run,
        now: () => NOW + 10,
        env: h.f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
        signal: controller.signal,
        finalCheck: async () => {
          controller.abort()
          return undefined
        },
      })
      expect(refusal(result)).toContain("signal")
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    describe("sessions inside the worktree are moved out before it goes", () => {
      const moves = (h: Harness) =>
        h.fake.calls.filter((entry) => entry.method === "session.move").map((entry) => entry.input as { sessionID: string; directory: string })

      test("an idle session inside is moved to the main checkout first, then the worktree is removed", async () => {
        let movedBeforeRemoval: number | undefined
        let h: Harness | undefined
        h = await harness("evict-idle", {
          before: (argv) => {
            if (argv.includes("remove") && h) movedBeforeRemoval = moves(h).length
          },
        })
        h.fake.sessions.set("ses_idle", { id: "ses_idle", location: { directory: h.f.linked }, time: { busy: 1, idle: 2 } })
        h.fake.sessions.set("ses_elsewhere", { id: "ses_elsewhere", location: { directory: h.f.main }, time: { busy: 1, idle: 2 } })
        const result = await explicitCleanup(h)
        expect(result.ok).toBe(true)
        expect(moves(h)).toEqual([{ sessionID: "ses_idle", directory: realpathSync(h.f.main) }])
        expect(movedBeforeRemoval).toBe(1)
        expect(removed(h)).toBe(true)
        await h.finish()
      })

      test("a running session inside blocks the removal, and nothing is moved", async () => {
        const h = await harness("evict-running")
        h.fake.sessions.set("ses_busy", { id: "ses_busy", location: { directory: h.f.linked }, time: { busy: 9, idle: 2 } })
        h.fake.sessions.set("ses_idle", { id: "ses_idle", location: { directory: h.f.linked }, time: { busy: 1, idle: 2 } })
        const result = await explicitCleanup(h)
        expect(result.ok).toBe(false)
        expect(removed(h)).toBe(false)
        expect(moves(h)).toEqual([])
        await h.finish()
      })

      test("a failed move blocks the removal and is reported", async () => {
        const h = await harness("evict-move-fails")
        h.fake.sessions.set("ses_idle", { id: "ses_idle", location: { directory: h.f.linked }, time: { busy: 1, idle: 2 } })
        ;(h.fake.context.session as unknown as { move: unknown }).move = async () => {
          throw new Error("host refused")
        }
        const result = await explicitCleanup(h)
        expect(refusal(result)).toContain("ses_idle could not be moved")
        expect(refusal(result)).toContain("host refused")
        expect(removed(h)).toBe(false)
        expect(mutationCalls(h.scripted.calls)).toEqual([])
        await h.finish()
      })

      test("the background retry moves an idle session out too", async () => {
        const h = await harness("evict-retry")
        h.fake.sessions.set("ses_idle", { id: "ses_idle", location: { directory: h.f.linked }, time: { busy: 1, idle: 2 } })
        await h.pending.record(h.f.receipt, "ses_lead")
        await h.pending.start()
        await h.idle()
        expect(moves(h).map((move) => move.sessionID)).toEqual(["ses_idle"])
        expect(removed(h)).toBe(true)
        await h.finish()
      })
    })

    test("the removal runs while the shared disk lock is held", async () => {
      let heldDuring = false
      let h: Harness | undefined
      h = await harness("explicit-lock-held", {
        before: (argv) => {
          if (argv.includes("remove") && h) {
            heldDuring = readdirSync(join(h.common, "opencode", "locks")).some((name) => name.endsWith(".lock"))
          }
        },
      })
      const result = await explicitCleanup(h)
      expect(result.ok).toBe(true)
      expect(heldDuring).toBe(true)
      await h.finish()
    })
  })

  describe("a coordination store that cannot be written is unsafe, not empty", () => {
    const needsPermissions = process.getuid?.() === 0 ? test.skip : test
    const lock = (h: Harness) => chmodSync(join(h.common, "opencode"), 0o555)
    const unlock = (h: Harness) => chmodSync(join(h.common, "opencode"), 0o755)

    needsPermissions("an unwritable store and a running shell: the idle hook resolves and nothing is removed", async () => {
      const h = await harness("unwritable-shell")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      lock(h)
      try {
        await h.fake.fire.session("experimental.idle", {
          sessionID: "ses_lead",
          background: [{ kind: "shell", sessionID: "ses_x", shellID: "sh1", command: `cd ${h.f.linked} && make` }],
        } as never)
        await h.pending.settle()
        expect(removed(h)).toBe(false)
        expect(mutationCalls(h.scripted.calls)).toEqual([])
      } finally {
        unlock(h)
      }
      await h.finish()
    })

    needsPermissions("with no holds directory and an unwritable store, a plain turn end removes nothing either", async () => {
      const h = await harness("unwritable-missing")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      lock(h)
      try {
        await h.idle()
        expect(removed(h)).toBe(false)
      } finally {
        unlock(h)
      }
      await h.finish()
    })

    needsPermissions("a failed hold write blocks removal even though the holds directory exists and reads as empty", async () => {
      const h = await harness("unwritable-holds-dir")
      await h.pending.record(h.f.receipt, "ses_lead")
      // An older entry makes the holds directory exist; it is then made read-only.
      setHold(h.common, h.f.linked, "ses_old", [{ kind: "shell", id: "old" }], NOW - 25 * 3_600_000)
      const holdsRoot = join(h.common, "opencode", "holds")
      const holdsDir = join(holdsRoot, readdirSync(holdsRoot)[0] as string)
      await h.pending.start()
      chmodSync(holdsDir, 0o555)
      try {
        await h.fake.fire.session("experimental.idle", {
          sessionID: "ses_lead",
          background: [{ kind: "shell", sessionID: "ses_x", shellID: "sh1", command: `cd ${h.f.linked} && make` }],
        } as never)
        await h.pending.settle()
        expect(removed(h)).toBe(false)
        expect(mutationCalls(h.scripted.calls)).toEqual([])
      } finally {
        chmodSync(holdsDir, 0o755)
      }
      await h.finish()
    })

    needsPermissions("a later hold write that succeeds clears the unsafe state", async () => {
      const h = await harness("unwritable-recovers")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      lock(h)
      await h.fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [{ kind: "shell", sessionID: "x", command: h.f.linked }] } as never)
      await h.pending.settle()
      expect(removed(h)).toBe(false)
      unlock(h)
      h.advance(60_000)
      await h.fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [] } as never)
      await h.pending.settle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })
  })

  describe("the repository observations follow the cleanup bound", () => {
    // A git that needs about 6 s: it answers only when allowed at least that long.
    const slowGit: GitRunner = (argv, cwd, timeoutMs) => {
      if (timeoutMs < 6000) return null
      const proc = Bun.spawnSync(["git", ...argv], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
      return proc.exitCode === 0 ? proc.stdout.toString() : null
    }

    test("with the cleanup bound injected (61 s) a 6 s observation succeeds and the worktree is removed", async () => {
      const h = await harness("bound-injected", { bounds: { refReadMs: 61_000 }, observe: slowGit })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })

    test("with a 5 s bound the same observation times out and nothing is removed", async () => {
      const h = await harness("bound-5s", { bounds: { refReadMs: 5_000 }, observe: slowGit })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("the ledger check of an open bead uses the configured observer and bound, so the nudge is sent", async () => {
      // Only the configured observer can classify the ledger: the git on PATH refuses the
      // canonical-root read, and the observer answers only within the 61 s bound.
      const real = Bun.which("git") ?? "git"
      const observer: GitRunner = (argv, cwd, timeoutMs) => {
        if (timeoutMs < 6000) return null
        const proc = Bun.spawnSync([real, ...argv], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
        return proc.exitCode === 0 ? proc.stdout.toString() : null
      }
      const h = await harness("ledger-observer", { beadStatus: "open", bounds: { refReadMs: 61_000 }, observe: observer })
      const bin = scratch("ledger-observer-bin")
      writeExecutable(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --git-common-dir --show-toplevel "*) exit 1;; esac\nexec "${real}" "$@"\n`)
      const before = process.env.PATH
      process.env.PATH = `${bin}:${before ?? ""}`
      try {
        await h.pending.record(h.f.receipt, "ses_lead")
        await h.pending.start()
        await h.idle()
      } finally {
        process.env.PATH = before
      }
      expect(synthetic(h)).toHaveLength(1)
      expect(JSON.stringify(synthetic(h)[0]?.input)).toContain("Landed PR #17: close beads delivery-17")
      expect(removed(h)).toBe(false)
      await h.finish()
    })
  })

  describe("background work", () => {
    const idleHook = (h: Harness, background: unknown[]) =>
      h.fake.fire.session("experimental.idle", { sessionID: "ses_lead", background } as never)

    test("a running shell named by the idle session's background list keeps an unclaimed landed worktree", async () => {
      const h = await harness("pending-bg-shell")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await idleHook(h, [{ kind: "shell", sessionID: "ses_x", shellID: "sh1", command: `cd ${h.f.linked} && make test` }])
      await h.pending.settle()
      expect(removed(h)).toBe(false)
      expect(readHolds(h.common, h.f.linked).holds.map((hold) => hold.sessionID)).toEqual(["ses_lead"])
      await h.finish()
    })

    test("a job of a session that works in the worktree keeps it too", async () => {
      const h = await harness("pending-bg-session")
      h.fake.sessions.set("ses_in", { id: "ses_in", location: { directory: h.f.linked } })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await idleHook(h, [{ kind: "shell", sessionID: "ses_in", shellID: "sh2", command: "sleep 30" }])
      await h.pending.settle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("a hold another instance wrote blocks the final check", async () => {
      const h = await harness("pending-bg-foreign")
      await h.pending.record(h.f.receipt, "ses_lead")
      setHold(h.common, h.f.linked, "ses_child", [{ kind: "shell", id: "x" }], NOW)
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("when the next idle lists nothing the hold clears and the worktree is removed", async () => {
      const h = await harness("pending-bg-clears")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await idleHook(h, [{ kind: "shell", sessionID: "ses_x", shellID: "sh1", command: `cd ${h.f.linked}` }])
      await h.pending.settle()
      expect(removed(h)).toBe(false)
      h.advance(60_000)
      await idleHook(h, [])
      await h.pending.settle()
      expect(readHolds(h.common, h.f.linked).holds).toEqual([])
      expect(removed(h)).toBe(true)
      await h.finish()
    })
  })

  describe("writes and cleanup of records decide under the lock", () => {
    const denialOf = (h: Harness) => {
      const record = readLanding(h.common, h.f.receipt.receiptId)
      return record.kind === "present" ? record.value.denied : undefined
    }

    /** Start the writers while another process holds the lock, so both are queued before either has written. */
    const queuedBehindALock = async (h: Harness, start: () => Promise<unknown>[]) => {
      let writers: Promise<unknown>[] = []
      await withDiskLock(h.common, h.f.linked, { sessionID: "other process", now: () => NOW + 10 }, async () => {
        writers = outsideLocks(start)
        await new Promise((done) => setTimeout(done, 60))
      })
      await Promise.all(writers)
    }

    test("two queued writers, the first a denial and the second a plain record: the denial survives", async () => {
      const h = await harness("writes-denial-first")
      await queuedBehindALock(h, () => [
        h.pending.record(h.f.receipt, "ses_lead", { denied: true }),
        h.pending.record(h.f.receipt, "ses_lead"),
      ])
      expect(denialOf(h)).toMatchObject({ sessionID: "ses_lead" })
      await h.finish()
    })

    test("an update never overwrites an unreadable landing record", async () => {
      const h = await harness("writes-unreadable")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      const file = landingFile(h.common, h.f.receipt.receiptId)
      writeFileSync(file, "{ this record is damaged")
      const before = readFileSync(file)
      // A plain update would otherwise replace the damaged record (and the denial it may hold) with a clean one.
      await expect(h.pending.record(h.f.receipt, "ses_lead")).rejects.toThrow("cannot be read")
      expect(readFileSync(file).equals(before)).toBe(true)
      // And the retry keeps its hands off the worktree.
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      expect(readFileSync(file).equals(before)).toBe(true)
      await h.finish()
    })

    test("only an authorized re-arm clears a denial", async () => {
      const h = await harness("writes-rearm")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await h.pending.record(h.f.receipt, "ses_lead")
      expect(denialOf(h)).toBeDefined()
      await h.pending.arm(h.f.linked)
      expect(denialOf(h)).toBeUndefined()
      await h.finish()
    })

    test("cleanup that checked before a denial was written, then waited on the lock, does not delete the record", async () => {
      const h = await harness("gc-waits-for-lock")
      const key = repoKey(h.f.main) as string
      writeReceipt(
        buildReceipt({
          now: NOW + 5000,
          emitter: h.f.receipt.emitter,
          repo: h.f.receipt.repo,
          pr: h.f.receipt.pr,
          branch: h.f.receipt.branch,
          worktree: { ...h.f.receipt.worktree, removed: true },
          beads: h.f.receipt.beads,
          proof: h.f.receipt.proof,
          outcome: "cleaned",
          supersedes: h.f.receipt.receiptId,
        }),
        receiptDirectory(h.f.env, key),
      )
      await h.pending.record(h.f.receipt, "ses_lead") // plain, and its receipt is superseded: deletable evidence
      let collecting: Promise<void> | undefined
      // Same clock as delivery's, so the lease it takes is not already expired in its eyes.
      await withDiskLock(h.common, h.f.linked, { sessionID: "other writer", now: () => NOW + 10 }, async () => {
        // The cleanup starts and queues for the lock (it is another process, so it does not share this chain) ...
        collecting = outsideLocks(() => h.pending.gc())
        await new Promise((done) => setTimeout(done, 80))
        // ... and a denial lands while it waits.
        writeLanding(h.common, {
          receiptId: h.f.receipt.receiptId,
          worktree: h.f.linked,
          headRefOid: h.f.head,
          sessionID: "ses_lead",
          landedAt: 1,
          denied: { at: 2, sessionID: "ses_lead" },
        })
      })
      await collecting
      expect(denialOf(h)).toMatchObject({ sessionID: "ses_lead" })
      await h.finish()
    })

    test("cleanup still drops a plain record whose evidence holds", async () => {
      const h = await harness("gc-still-drops")
      const key = repoKey(h.f.main) as string
      writeReceipt(
        buildReceipt({
          now: NOW + 5000,
          emitter: h.f.receipt.emitter,
          repo: h.f.receipt.repo,
          pr: h.f.receipt.pr,
          branch: h.f.receipt.branch,
          worktree: { ...h.f.receipt.worktree, removed: true },
          beads: h.f.receipt.beads,
          proof: h.f.receipt.proof,
          outcome: "cleaned",
          supersedes: h.f.receipt.receiptId,
        }),
        receiptDirectory(h.f.env, key),
      )
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId)).toEqual({ kind: "missing" })
      await h.finish()
    })
  })

  describe("a landing record is dropped only on positive evidence", () => {
    const receiptsDir = (h: Harness) => receiptDirectory(h.f.env, repoKey(h.f.main) as string)

    test("a missing receipt directory deletes nothing, denial or not", async () => {
      const h = await harness("gc-no-dir")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      rmSync(receiptsDir(h), { recursive: true, force: true })
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId)).toMatchObject({ kind: "present", value: { denied: { sessionID: "ses_lead" } } })
      await h.finish()
    })

    test("a receipt that cannot be parsed deletes nothing", async () => {
      const h = await harness("gc-corrupt")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await h.pending.record({ ...h.f.receipt, receiptId: "9-other" } as never, "ses_lead")
      writeFileSync(join(receiptsDir(h), `${h.f.receipt.receiptId}.json`), "{not json")
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId).kind).toBe("present")
      expect(readLanding(h.common, "9-other").kind).toBe("present")
      await h.finish()
    })

    test("a superseded receipt's record is dropped, but a denial never is", async () => {
      const h = await harness("gc-superseded")
      const key = repoKey(h.f.main) as string
      const later = buildReceipt({
        now: NOW + 5000,
        emitter: h.f.receipt.emitter,
        repo: h.f.receipt.repo,
        pr: h.f.receipt.pr,
        branch: h.f.receipt.branch,
        worktree: { ...h.f.receipt.worktree, removed: true },
        beads: h.f.receipt.beads,
        proof: h.f.receipt.proof,
        outcome: "cleaned",
        supersedes: h.f.receipt.receiptId,
      })
      writeReceipt(later, receiptDirectory(h.f.env, key))
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId)).toEqual({ kind: "missing" })
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId).kind).toBe("present")
      await h.finish()
    })

    test("a pass over a worktree that is gone keeps a denial", async () => {
      const h = await harness("gc-gone-denied")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      rmSync(h.f.linked, { recursive: true, force: true })
      await h.pending.start()
      await h.idle()
      expect(readLanding(h.common, h.f.receipt.receiptId).kind).toBe("present")
      await h.finish()
    })
  })

  test("a worktree that is already gone is done and takes no slot", async () => {
    const h = await harness("pending-gone", { maxPerPass: 1 })
    const key = repoKey(h.f.main) as string
    const gone = buildReceipt({
      now: NOW + 5000,
      emitter: h.f.receipt.emitter,
      repo: h.f.receipt.repo,
      pr: { ...h.f.receipt.pr, number: 19 },
      branch: { ...h.f.receipt.branch, name: "feat/gone" },
      worktree: { ...h.f.receipt.worktree, path: join(h.f.root, "no such worktree") },
      beads: h.f.receipt.beads,
      proof: h.f.receipt.proof,
      outcome: "landed",
    })
    writeReceipt(gone, receiptDirectory(h.f.env, key))
    await h.pending.record(gone, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(removed(h)).toBe(true)
    expect(readLanding(h.common, gone.receiptId)).toEqual({ kind: "missing" })
    expect(existsSync(landingFile(h.common, gone.receiptId))).toBe(false)
    await h.finish()
  })
})
