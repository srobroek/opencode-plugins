import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs"
import { devNull, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import pkg from "../package.json" with { type: "json" }
import { parseWorktreeList } from "./cleanup.ts"
import { type CliResult, type CliRunner, runCli, SAFE_GIT_ARGS } from "./forge-adapter.ts"
import {
  beadIdsFromBranch,
  gitVersionFailure,
  inferWorktree,
  type LandDeps,
  type LandParams,
  landPullRequest as landPullRequestUnwrapped,
  resolveLandingTarget,
  selectRemoteForRepo,
} from "./land.ts"
import { type LandingReceipt, RECEIPT_SCHEMA, readReceipt, repoKey, writeReceipt } from "./landing-receipt.ts"
import { writePending } from "./merge-queue.ts"

/** Every raw git argv the tool issued, before the safe-option prefix is stripped for the mocks. */
const rawGitArgv: string[][] = []

/**
 * Put a `git` shim first on PATH that logs, for every start, its physical directory and any
 * repository selector in its environment. Every Git child the tool runs gets the current
 * environment, so each one passes through it, synchronous or not.
 */
function gitSpawnLog(): { log: () => string[]; restore: () => void } {
  const dir = temporaryDirectory("delivery-land-git-shim-")
  const logFile = join(dir, "spawns.log")
  const real = Bun.spawnSync(["which", "git"]).stdout.toString().trim()
  writeExecutable(
    join(dir, "git"),
    `#!/bin/sh\n{ pwd -P; for p in "$GIT_DIR" "$GIT_WORK_TREE" "$GIT_COMMON_DIR"; do [ -n "$p" ] && echo "$p"; done; } >> "${logFile}"\nexec "${real}" "$@"\n`,
  )
  const before = process.env.PATH
  process.env.PATH = `${dir}:${before ?? ""}`
  return {
    log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []),
    restore: () => {
      process.env.PATH = before
    },
  }
}

/** The argv without the safe-option prefix every checkout-bound Git command carries. */
const withoutSafeGit = (argv: readonly string[]): string[] =>
  argv[0] === "git" && SAFE_GIT_ARGS.every((part, index) => argv[index + 1] === part)
    ? ["git", ...argv.slice(1 + SAFE_GIT_ARGS.length)]
    : [...argv]

/** `landPullRequest` whose runner sees Git argv with the safe prefix removed, so mocks match on the verb. */
function landPullRequest(params: LandParams, deps: LandDeps = {}) {
  const inner = deps.run
  if (inner === undefined) return landPullRequestUnwrapped(params, deps)
  const run: CliRunner = (argv, options) => {
    if (argv[0] === "git") rawGitArgv.push([...argv])
    return inner(withoutSafeGit(argv), options)
  }
  return landPullRequestUnwrapped(params, { ...deps, run })
}

type Call = {
  argv: string[]
  cwd: string | undefined
  timeoutMs: number
  env: Readonly<Record<string, string>> | undefined
}

const MERGE_OID = "feedfacecafebabe0123456789abcdef01234567"
const HEAD_OID = "0123456789abcdef0123456789abcdef01234567"
const BASE_OID = "1111111111111111111111111111111111111111"
const TIP_OID = "2222222222222222222222222222222222222222"
const PARENT_TREE = "3333333333333333333333333333333333333333"
const LANDED_TREE = "4444444444444444444444444444444444444444"
const BASE_BRANCH = "omp/integration/omp-plugins-9ej3"
const REMOTE_URL = "https://github.com/srobroek/omp-plugins.git"
const BRANCH = "omp/agent/omp-plugins-9ej3.5"
const NOW = 1_764_000_000_000
const TITLE = "fix(delivery): land the reviewed head"

/** The reviewed head a merging call must name; only an already-MERGED proof may omit it. */
const REVIEWED = { expectHeadSha: HEAD_OID } as const

const completed = (stdout: string, exitCode = 0, stderr = ""): CliResult => ({ ok: true, exitCode, stdout, stderr })

/** A GitHub pull-request payload in `gh pr view --json` spelling. */
const githubPr = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "PR_node_470",
    number: 470,
    url: "https://github.com/srobroek/omp-plugins/pull/470",
    title: TITLE,
    state: "OPEN",
    baseRefName: BASE_BRANCH,
    headRefName: BRANCH,
    headRefOid: HEAD_OID,
    mergeCommit: null,
    mergedAt: null,
    ...overrides,
  })

const mergedGithubPr = (overrides: Record<string, unknown> = {}): string =>
  githubPr({ state: "MERGED", mergeCommit: { oid: MERGE_OID }, mergedAt: "2026-09-21T20:00:00Z", ...overrides })

/** A GitLab merge request in `glab mr view --output json` spelling. */
const gitlabMr = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    iid: 12,
    web_url: "https://gitlab.com/group/project/-/merge_requests/12",
    title: TITLE,
    state: "merged",
    target_branch: "main",
    source_branch: BRANCH,
    sha: HEAD_OID,
    merge_commit_sha: MERGE_OID,
    merged_at: "2026-09-21T20:00:00Z",
    ...overrides,
  })

/** Every fixture directory this file creates, so a test can prove none outlives its test. */
const created: string[] = []
/** The ones the running test created, removed once it ends. */
const pending: string[] = []

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  created.push(path)
  pending.push(path)
  return path
}

/** A linked worktree of `canonical`, as `git worktree add` lays it out: a `.git` file and an admin directory. */
function linkedWorktree(canonical: string, name: string): string {
  const path = join(temporaryDirectory("delivery-land-linked-"), name)
  const admin = join(canonical, ".git", "worktrees", name)
  mkdirSync(path, { recursive: true })
  mkdirSync(admin, { recursive: true })
  writeFileSync(join(path, ".git"), `gitdir: ${admin}\n`)
  writeFileSync(join(admin, "commondir"), "../..\n")
  return path
}


afterEach(() => {
  for (const path of pending.splice(0)) rmSync(path, { recursive: true, force: true })
})

/**
 * A repository whose git reads answer from a real temporary directory.
 *
 * `repoKey` hashes the realpath of the git common directory, so the fixture
 * creates one: the receipt then carries a key that a reader could reproduce, and
 * `canonicalRoot` is the parent this landing was keyed from.
 */
function repository(): { canonical: string; receipts: string } {
  const canonical = temporaryDirectory("delivery-land-repo-")
  mkdirSync(join(canonical, ".git"))
  return { canonical, receipts: temporaryDirectory("delivery-land-receipts-") }
}

type Answers = {
  prView?: CliResult[]
  merge?: CliResult
  autoDelete?: CliResult
  policy?: CliResult
  enable?: CliResult
  lsRemote?: CliResult
  parents?: string
  remoteUrl?: string
  /** What `git rev-parse --verify HEAD^{commit}` answers inside a supplied worktree. */
  worktreeHead?: CliResult
  /** What `git worktree list --porcelain` prints in the repository; empty by default. */
  worktrees?: string
  /** Whether each `git cat-file -e <oid>^{commit}` finds the object, in call order; present once the list is spent. */
  present?: boolean[]
  /** What each `git fetch` answers, in call order; exit 0 once the list is spent. */
  fetch?: CliResult[]
  /** What the approval read (`gh pr view --json author,reviews,comments` or the GitLab approvals API) answers. */
  approval?: CliResult
  /** What the branch rules read (`gh api repos/<o>/<r>/rules/branches/<base>`) answers; no rules by default. */
  rules?: CliResult
  /** What each merge queue state read (`gh api graphql` query) answers, in call order; the last repeats. */
  queueStates?: CliResult[]
  /** Runs while queue state read `index` (0-based) is in flight; the read answers once it settles. */
  duringQueueState?: (index: number) => Promise<void> | undefined
  /** What the `enqueuePullRequest` mutation answers. */
  enqueue?: CliResult
  /** Runs while the `enqueuePullRequest` mutation is in flight, and supplies its answer. */
  duringEnqueue?: () => Promise<CliResult>
  /** What the forge's compare read (`compare/<oid>...<base>`) answers; "ahead" by default. */
  compare?: CliResult
  /** What the `mergeQueue(branch:)` read after a rules 404 answers. */
  mergeQueueProbe?: CliResult
  /** What the rulesets list read after a rules 404 answers. */
  rulesets?: CliResult
  /** What `ls-remote` answers for the base branch; its tip is `TIP_OID` by default. */
  baseTip?: CliResult
  /** What `git rev-parse <landed>^{tree}` answers; the parent's tree is always `PARENT_TREE`. */
  landedTree?: CliResult
  /** What `git merge-tree --write-tree <parent> <head>` answers. */
  mergeTree?: CliResult
  /** What `git merge-base --is-ancestor` answers. */
  ancestor?: CliResult
  /** What `git merge-base --is-ancestor <landed> <base tip>` answers; `ancestor` when unset. */
  onBase?: CliResult
  /** The version `git --version` prints; 2.45.1 when unset. */
  gitVersion?: string
  /** What the checks read (`gh pr checks` or the GitLab merge request API) answers. */
  checks?: CliResult
}

/**
 * One runner for every child process the tool may start, recording each argv.
 *
 * Recording all of them in one place is what makes "no merge argv was issued" and
 * "no bd argv was issued" observations rather than assertions about intent. An
 * unexpected command fails loudly instead of returning a plausible default.
 */
function runner(answers: Answers, canonical: string): { run: CliRunner; calls: Call[] } {
  const views = [...(answers.prView ?? [])]
  const present = [...(answers.present ?? [])]
  const fetches = [...(answers.fetch ?? [])]
  const states = [...(answers.queueStates ?? [])]
  let stateReads = 0
  const calls: Call[] = []
  const run: CliRunner = (argv, options) => {
    calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env })
    const command = argv.join(" ")
    if (argv[0] === "git" && argv.at(-1) === "--version") return completed(`git version ${answers.gitVersion ?? "2.45.1"}\n`)
    if (command.startsWith("git rev-parse --path-format=absolute --git-common-dir --show-toplevel")) {
      return completed(`${join(canonical, ".git")}\n${canonical}\n`)
    }
    if (argv[0] === "git" && argv.includes("show") && argv.includes("-s"))
      return completed(`${answers.parents ?? BASE_OID}\n`)
    const treeOf = argv.find((part) => part.endsWith("^{tree}"))
    if (argv[0] === "git" && argv.includes("rev-parse") && treeOf !== undefined) {
      const parent = (answers.parents ?? BASE_OID).split(" ")[0]
      return treeOf.startsWith(`${parent}^`) ? completed(`${PARENT_TREE}\n`) : (answers.landedTree ?? completed(`${LANDED_TREE}\n`))
    }
    if (argv[0] === "git" && argv.includes("merge-tree")) return answers.mergeTree ?? completed(`${LANDED_TREE}\n`)
    if (argv[0] === "git" && argv.includes("ls-remote") && argv.some((part) => part === `refs/heads/${BASE_BRANCH}` || part === "refs/heads/main"))
      return answers.baseTip ?? completed(`${TIP_OID}\trefs/heads/${argv.find((part) => part.startsWith("refs/heads/"))?.slice(11)}\n`)
    if (argv[0] === "git" && argv[1] === "cat-file" && argv[2] === "-e")
      return (present.shift() ?? true) ? completed("") : completed("", 1, "fatal: not a commit")
    if (argv[0] === "git" && argv.includes("fetch")) return fetches.shift() ?? completed("")
    if (command === "git rev-parse --verify HEAD^{commit}") return answers.worktreeHead ?? completed(`${HEAD_OID}\n`)
    if (command.startsWith("git remote get-url")) return completed(`${answers.remoteUrl ?? REMOTE_URL}\n`)
    if (command === "git remote") return completed("origin\n")
    if (command === "git worktree list --porcelain") return completed(answers.worktrees ?? "")
    if (argv[1] === "pr" && argv[2] === "view" && argv.includes("author,reviews,comments"))
      return answers.approval ?? completed("{}")
    if (argv[1] === "pr" && argv[2] === "checks") return answers.checks ?? completed("[]")
    if (argv[0] === "git" && argv.includes("merge-base") && argv.includes("--is-ancestor"))
      return (argv.at(-1) === TIP_OID ? answers.onBase : undefined) ?? answers.ancestor ?? completed("")
    // No fork point: the rebase proof that reads one is shown against real commits elsewhere.
    if (argv[0] === "git" && argv.includes("merge-base")) return completed("", 1)
    if (argv[1] === "api" && argv.some((part) => part.includes("/compare/")))
      return answers.compare ?? completed("ahead\n")
    if (argv[1] === "api" && argv.some((part) => part.includes("/rulesets")))
      return answers.rulesets ?? completed("[]")
    if (argv[1] === "api" && argv[2] === "graphql" && argv.some((part) => part.includes("mergeQueue(branch")))
      return (
        answers.mergeQueueProbe ??
        completed(JSON.stringify({ data: { repository: { nameWithOwner: "srobroek/omp-plugins", mergeQueue: null } } }))
      )
    if (argv[1] === "api" && argv.some((part) => part.includes("/rules/branches/")))
      return answers.rules ?? completed("[]")
    if (argv[1] === "api" && argv[2] === "graphql") {
      if (argv.some((part) => part.startsWith("query=mutation")))
        return answers.duringEnqueue?.() ?? answers.enqueue ?? completed("{}")
      const state = (states.length > 1 ? states.shift() : states[0]) ?? completed("{}")
      const during = answers.duringQueueState?.(stateReads++)
      return during === undefined ? state : during.then(() => state)
    }
    if (argv[1] === "api" && argv.some((part) => part.endsWith("/approvals")))
      return answers.approval ?? completed("{}")
    if (argv[1] === "api" && argv.some((part) => /\/merge_requests\/\d+$/.test(part)))
      return answers.checks ?? completed("{}")
    if (argv[1] === "pr" && argv[2] === "view") return views.shift() ?? completed(mergedGithubPr())
    if (argv[1] === "mr" && argv[2] === "view") return views.shift() ?? completed(gitlabMr())
    if (argv[1] === "api" && argv.includes(".allow_merge_commit")) return answers.policy ?? completed("true\n")
    if (argv[1] === "api" && argv.includes("-X")) return answers.enable ?? completed("{}\n")
    if (argv[1] === "api") return answers.autoDelete ?? completed("false\n")
    if (argv[1] === "pr" && argv[2] === "merge") return answers.merge ?? completed("")
    if (argv[1] === "mr" && argv[2] === "merge") return answers.merge ?? completed("")
    if (argv.includes("ls-remote")) return answers.lsRemote ?? { ok: true, exitCode: 2, stdout: "", stderr: "" }
    throw new Error(`the tool issued an unexpected command: ${command}`)
  }
  return { run, calls }
}
async function land(
  answers: Answers,
  params: Partial<LandParams> = {},
  env: NodeJS.ProcessEnv = {},
  extra: Partial<LandDeps> = {},
) {
  const { canonical, receipts } = repository()
  mkdirSync(join(canonical, ".beads"))
  const { run, calls } = runner(answers, canonical)
  // A `/tmp/worktrees/<name>` placeholder stands for a real linked worktree of the session
  // repository: an explicit worktree is only read once it is verified to exist and belong there.
  const wanted = params.worktree?.startsWith("/tmp/worktrees/") ? params.worktree : undefined
  const worktreePath = wanted === undefined ? undefined : linkedWorktree(canonical, wanted.split("/").pop() ?? "wt")
  const outcome = await landPullRequest(
    { pr: 470, ...params, ...(worktreePath === undefined ? {} : { worktree: worktreePath }) },
    { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env, ...extra },
  )
  return { outcome, calls, receipts, canonical, worktreePath, files: () => readdirSync(receipts).filter((name) => !name.startsWith("pending-")) }
}
function nativeNext(beadId: string, pr: number, mergeSha: string, receiptPath: string): string[] {
  return [
    `bd update ${beadId} --set-metadata pr=${pr} --set-metadata merge_sha=${mergeSha}`,
    `bd close ${beadId} --reason "PR #${pr} merged as ${mergeSha}; receipt ${receiptPath}"`,
    "delivery_cleanup",
  ]
}

/** Whether a call reads or writes the deletion-on-merge repository setting. */
const settingsCall = (argv: string[]): boolean =>
  argv.some((part) => part.includes("delete_branch_on_merge") || part.includes("remove_source_branch_after_merge"))

/** Run Git in a fixture repository with no user or system configuration and no hooks. */
function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Delivery Test",
      "-c",
      "user.email=delivery@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
    },
  )
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function commitFile(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content)
  git(repo, ["add", file])
  git(repo, ["commit", "-q", "-m", message])
}

/** Resolve once `file` exists, on the directory's change events rather than a polling clock. */
function appeared(file: string, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const settle = (): void => {
    if (!existsSync(file)) return
    watcher.close()
    signal.removeEventListener("abort", cancel)
    resolve()
  }
  const watcher = watch(dirname(file), settle)
  const cancel = (): void => {
    watcher.close()
    resolve()
  }
  signal.addEventListener("abort", cancel, { once: true })
  settle()
  return promise
}

/** Eight numbered lines: room for a base edit near, but not touching, a reviewed hunk. */
const NUMBERED = ["1", "2", "3", "4", "5", "6", "7", "8"]
const numbered = (line: number, text: string): string =>
  `${NUMBERED.map((value, index) => (index === line - 1 ? text : value)).join("\n")}\n`

/**
 * A real repository holding a reviewed two-commit branch and its rebase-and-merge
 * landing. The base moved after review, so the landed commits are rewritten copies
 * with new SHAs and a different committer, as GitHub's rebase-and-merge always makes
 * them. `altered` changes the last landed patch, which no equivalence may accept.
 * `context-moved` has the base edit line 4 of a file whose line 6 the reviewed branch
 * edits: the rebase replays cleanly, but the landed hunk's context lines differ.
 * `transient` has the first reviewed commit add a scratch file and the second remove it,
 * so the last landed commit does not equal the reviewed head merged onto its parent.
 * `whitespace` lands the last line with trailing blanks, which `patch-id` ignores.
 * `same-line` has both reviewed commits edit the one line of `base.txt`, so the second patch
 * only applies on top of the first; `same-line-altered` lands that second edit with other text.
 *
 * The history is written by one `git fast-import`, the landed commits as the trees a
 * replay onto the moved base produces, instead of some fifteen porcelain commands
 * and a real rebase: under heavy load each child process costs a sizeable part of
 * Bun's per-test budget, and the proof reads only commits, trees and diffs.
 */
function rebasedRepository(variant: "clean" | "altered" | "context-moved" | "transient" | "whitespace" | "same-line" | "same-line-altered" = "clean"): {
  canonical: string
  receipts: string
  head: string
  landed: string
  /** The moved base the landing was replayed onto, which does not contain it. */
  main: string
} {
  const moved = variant === "context-moved"
  const transient = variant === "transient"
  const sameLine = variant === "same-line" || variant === "same-line-altered"
  const canonical = realpathSync(temporaryDirectory("delivery-land-rebase-"))
  const base = moved ? numbered(0, "") : "base\n"
  const reviewedTwo = moved ? numbered(6, "6, reviewed") : "base\ntwo\n"
  const movedBase = numbered(4, "4, moved on the base")
  const landedTwo =
    variant === "altered"
      ? "base\ntwo, altered\n"
      : variant === "whitespace"
        ? "base\ntwo \t\n"
      : moved
        ? movedBase.replace("6\n", "6, reviewed\n")
        : "base\ntwo\n"
  let time = 1_700_000_000
  const commit = (
    ref: string,
    mark: number,
    message: string,
    /** A null content deletes the path. */
    files: Record<string, string | null>,
    from?: number,
    committer = "Delivery Test",
  ): string => {
    time += 1
    const author = `Delivery Test <delivery@example.test> ${time} +0000`
    const lines = [
      `commit ${ref}`,
      `mark :${mark}`,
      `author ${author}`,
      `committer ${committer} <delivery@example.test> ${time} +0000`,
      `data ${Buffer.byteLength(message)}`,
      message,
    ]
    if (from !== undefined) lines.push(`from :${from}`)
    for (const [path, content] of Object.entries(files)) {
      if (content === null) lines.push(`D ${path}`)
      else lines.push(`M 100644 inline ${path}`, `data ${Buffer.byteLength(content)}`, content)
    }
    return `${lines.join("\n")}\n`
  }
  const stream = [
    commit("refs/heads/main", 1, "base", { "base.txt": base }),
    commit(
      `refs/heads/${BRANCH}`,
      2,
      "one",
      sameLine ? { "base.txt": "first\n" } : { "one.txt": "one\n", ...(transient ? { "scratch.txt": "scratch\n" } : {}) },
      1,
    ),
    commit(`refs/heads/${BRANCH}`, 3, "two", transient ? { "scratch.txt": null } : { "base.txt": sameLine ? "second\n" : reviewedTwo }, 2),
    moved
      ? commit("refs/heads/main", 4, "base moved", { "base.txt": movedBase }, 1)
      : commit("refs/heads/main", 4, "other", { "other.txt": "other\n" }, 1),
    commit(
      "refs/heads/landed",
      5,
      "one",
      sameLine ? { "base.txt": "first\n" } : { "one.txt": "one\n", ...(transient ? { "scratch.txt": "scratch\n" } : {}) },
      4,
      "Forge Rebase",
    ),
    commit(
      "refs/heads/landed",
      6,
      "two",
      transient
        ? { "scratch.txt": null }
        : { "base.txt": variant === "same-line" ? "second\n" : variant === "same-line-altered" ? "third\n" : landedTwo },
      5,
      "Forge Rebase",
    ),
  ].join("")
  const marks = join(canonical, ".git", "fixture-marks")
  git(canonical, ["init", "-q", "-b", "main"])
  const imported = Bun.spawnSync(["git", "fast-import", "--quiet", `--export-marks=${marks}`], {
    cwd: canonical,
    stdin: Buffer.from(stream),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  })
  if (imported.exitCode !== 0) throw new Error(`git fast-import: ${imported.stderr.toString()}`)
  const oids = new Map(
    readFileSync(marks, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ") as [string, string]),
  )
  const head = oids.get(":3")
  const landed = oids.get(":6")
  const main = oids.get(":4")
  if (head === undefined || landed === undefined || main === undefined) throw new Error("git fast-import exported no marks")
  return { canonical, receipts: temporaryDirectory("delivery-land-receipts-"), head, landed, main }
}

/** A commit's `git patch-id --stable` over Git's default three-line-context diff. */
function contextPatchId(repo: string, commit: string): string {
  const diff = Bun.spawnSync(["git", "diff-tree", "-p", "--no-color", commit], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  })
  const id = Bun.spawnSync(["git", "patch-id", "--stable"], {
    cwd: repo,
    stdin: diff.stdout,
    stdout: "pipe",
    stderr: "pipe",
  })
  return id.stdout.toString().split(" ")[0] ?? ""
}

/**
 * Land a rebase against {@link rebasedRepository}: the forge reads are scripted and
 * every other Git read is answered by the real repository through the real runner —
 * the patch-id proof feeds Git on stdin — so it runs against real rewritten commits.
 */
async function landRebase(
  repo: { canonical: string; receipts: string; head: string; landed: string },
  extra: Partial<Answers> = {},
  params: Partial<LandParams> = { merge_method: "rebase" },
) {
  const fixture = runner(
    {
      prView: [
        completed(githubPr({ headRefOid: repo.head })),
        completed(mergedGithubPr({ headRefOid: repo.head, mergeCommit: { oid: repo.landed } })),
      ],
      // The base branch's tip is the landed commit, which the real repository holds.
      baseTip: completed(`${repo.landed}\trefs/heads/${BASE_BRANCH}\n`),
      ...extra,
    },
    repo.canonical,
  )
  const run: CliRunner = (argv, options) => {
    if (argv[0] !== "git" || argv[1] === "remote" || (argv.includes("ls-remote") && !argv.includes("refs/heads/main"))) return fixture.run(argv, options)
    fixture.calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env })
    return runCli(argv, options)
  }
  const outcome = await landPullRequest(
    { pr: 470, expectHeadSha: repo.head, ...params },
    {
      run,
      cwd: repo.canonical,
      now: () => NOW,
      receiptsDirectory: repo.receipts,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      sleep: async () => {},
    },
  )
  return { outcome, calls: fixture.calls, files: () => readdirSync(repo.receipts) }
}

const merged = (argv: string[]): boolean => argv[2] === "merge"

const reasonOf = (outcome: Awaited<ReturnType<typeof land>>["outcome"]): string => {
  if (outcome.ok) throw new Error("expected a refusal")
  return outcome.reason
}

describe("delivery_land", () => {
  test("a clean land emits one receipt whose fields are the forge reads", async () => {
    const { outcome, receipts, files, calls, worktreePath } = await land(
      {
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        lsRemote: { ok: true, exitCode: 2, stdout: "", stderr: "" },
      },
      { ...REVIEWED, worktree: "/tmp/worktrees/omp-agent-omp-plugins-9ej3.5" },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(files()).toHaveLength(1)
    expect(outcome.receiptPath).toBe(join(receipts, `${NOW}-${MERGE_OID.slice(0, 12)}.json`))

    const receipt = outcome.receipt
    expect(receipt.schema).toBe(RECEIPT_SCHEMA)
    expect(receipt.pr).toEqual({
      number: 470,
      url: "https://github.com/srobroek/omp-plugins/pull/470",
      state: "MERGED",
      baseRefName: "omp/integration/omp-plugins-9ej3",
      headRefName: BRANCH,
      headRefOid: HEAD_OID,
      mergeCommitOid: MERGE_OID,
      mergedAt: "2026-09-21T20:00:00Z",
    })
    expect(receipt.repo.forge).toBe("github")
    expect(receipt.repo.nameWithOwner).toBe("srobroek/omp-plugins")
    expect(receipt.repo.remote).toBe("origin")
    expect(receipt.proof.evidence).toMatchObject({ remote: "origin", remoteUrl: REMOTE_URL })
    expect(receipt.proof.method).toBe("gh pr view")
    expect(receipt.branch).toEqual({
      name: BRANCH,
      deletedRemote: true,
      remoteAbsenceVerifiedAt: new Date(NOW).toISOString(),
      autoDeleteSetting: "off",
    })
    expect(receipt.beads.ids).toEqual(["omp-plugins-9ej3.5"])
    expect(receipt.worktree.path).toBe(worktreePath ?? null)
    // The worktree is recorded only after its own HEAD was read and matched the PR head.
    expect(
      calls.filter((call) => call.argv.join(" ") === "git rev-parse --verify HEAD^{commit}").map((call) => call.cwd),
    ).toEqual([realpathSync(worktreePath ?? "")])
    expect(receipt.proof.evidence).toMatchObject({
      worktree: { path: worktreePath, head: HEAD_OID },
    })
    expect(receipt.outcome).toBe("landed")
    expect(receipt.supersedes).toBeNull()
    expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.5", 470, MERGE_OID, outcome.receiptPath))
    expect(outcome.text).toContain("children before parents")
    expect(
      outcome.text.indexOf(`bd update omp-plugins-9ej3.5 --set-metadata pr=470 --set-metadata merge_sha=${MERGE_OID}`),
    ).toBeLessThan(outcome.text.indexOf("delivery_cleanup"))

    // The file on disk is the object returned, and a reader accepts it.
    const reread = readReceipt(outcome.receiptPath)
    expect(reread.ok).toBe(true)
    if (!reread.ok) throw new Error(reread.reason)
    expect(reread.receipt).toEqual(receipt)
  })
  test("records the default squash method and one-parent proof", async () => {
    const { outcome } = await land({ prView: [completed(mergedGithubPr())] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.proof.evidence).toMatchObject({
      mergeMethod: "squash",
      mergeShape: { parents: [BASE_OID], rebase: null },
    })
  })

  test("maps merge method and proves the reviewed head is the second parent", async () => {
    const { outcome, calls } = await land(
      {
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        parents: `${BASE_OID} ${HEAD_OID}`,
        policy: completed("true\n"),
      },
      { ...REVIEWED, merge_method: "merge" },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    const merge = calls.find((call) => merged(call.argv))?.argv
    expect(merge).toContain("--merge")
    // The PR title is a squash subject only; a merge commit keeps the forge's message.
    expect(merge).not.toContain("--subject")
    expect(outcome.receipt.proof.evidence).toMatchObject({
      mergeMethod: "merge",
      mergePolicy: true,
      mergeShape: { parents: [BASE_OID, HEAD_OID] },
    })
  })

  test("a rebase-and-merge landing with rewritten SHAs is proved by ordered patch-id equivalence", async () => {
    const repo = rebasedRepository()
    // Rewritten SHAs: the reviewed head is not reachable from what landed, which is the
    // precondition the old reviewed-head ancestry proof could never meet.
    expect(repo.landed).not.toBe(repo.head)
    const ancestry = Bun.spawnSync(["git", "merge-base", "--is-ancestor", repo.head, repo.landed], {
      cwd: repo.canonical,
    })
    expect(ancestry.exitCode).toBe(1)

    const { outcome, calls, files } = await landRebase(repo)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(calls.find((call) => merged(call.argv))?.argv).toContain("--rebase")
    expect(calls.filter((call) => call.argv[1] === "patch-id").map((call) => call.argv)).toEqual([
      ["git", "patch-id", "--stable"],
      ["git", "patch-id", "--stable"],
    ])
    const base = git(repo.canonical, ["merge-base", repo.head, repo.landed])
    const landedBase = git(repo.canonical, ["rev-parse", `${repo.landed}~2`])
    expect(outcome.receipt.proof.evidence).toMatchObject({
      mergeMethod: "rebase",
      mergeShape: {
        parents: [git(repo.canonical, ["rev-parse", `${repo.landed}^`])],
        rebase: {
          method: "patch-id",
          commits: 2,
          reviewed: `${base}..${repo.head}`,
          landed: `${landedBase}..${repo.landed}`,
        },
      },
    })
    expect(outcome.receipt.pr.mergeCommitOid).toBe(repo.landed)
    expect(files()).toHaveLength(1)
  }, 60_000)

  test("a clean rebase whose landed hunk's context moved on the base is still proved", async () => {
    const repo = rebasedRepository("context-moved")
    // The base edit sits inside the reviewed hunk's default three context lines, so a
    // context-bearing patch id changes even though the reviewed change replayed as is.
    expect(contextPatchId(repo.canonical, repo.landed)).not.toBe(contextPatchId(repo.canonical, repo.head))
    expect(git(repo.canonical, ["show", `${repo.landed}:base.txt`])).toBe(
      numbered(4, "4, moved on the base").replace("6\n", "6, reviewed\n").trim(),
    )

    const { outcome, files } = await landRebase(repo)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.proof.evidence).toMatchObject({
      mergeMethod: "rebase",
      mergeShape: { rebase: { method: "patch-id", commits: 2 } },
    })
    expect(files()).toHaveLength(1)
  }, 60_000)

  test("a rebase of two commits that edit the same line is proved commit by commit", async () => {
    const repo = rebasedRepository("same-line")
    // The second patch's old side is the first commit's new text, so each commit's patch id
    // is only meaningful when the diffs are read per commit, not against the fork point.
    expect(git(repo.canonical, ["show", `${repo.head}:base.txt`])).toBe("second")
    const { outcome, files } = await landRebase(repo)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.proof.evidence).toMatchObject({
      mergeMethod: "rebase",
      mergeShape: { rebase: { method: "patch-id", commits: 2 } },
    })
    expect(files()).toHaveLength(1)
  }, 60_000)

  test("a rebase of two commits that edit the same line refuses when the landed second edit differs", async () => {
    const repo = rebasedRepository("same-line-altered")
    const { outcome, files } = await landRebase(repo)

    expect(reasonOf(outcome)).toContain("patch-id")
    expect(files()).toHaveLength(0)
  }, 60_000)

  test("a rebase landing whose patches differ from the reviewed commits refuses and writes nothing", async () => {
    const repo = rebasedRepository("altered")
    const { outcome, files } = await landRebase(repo)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("patch-id")
    expect(outcome.reason).toContain(repo.landed)
    expect(outcome.reason).toContain("no receipt was written")
    expect(files()).toHaveLength(0)
  }, 60_000)

  test("a rebase whose patch ids match but whose landed bytes differ refuses on content", async () => {
    const repo = rebasedRepository("whitespace")
    // patch-id ignores whitespace, so the ordered patch ids agree; only the tree tells.
    expect(contextPatchId(repo.canonical, repo.landed)).toBe(contextPatchId(repo.canonical, repo.head))
    const { outcome, files } = await landRebase(repo)

    expect(reasonOf(outcome)).toContain("the landed content is not the reviewed change")
    expect(files()).toHaveLength(0)
  }, 60_000)

  test("a two-parent merge whose tree is not the reviewed head merged onto its first parent refuses", async () => {
    const { outcome, files } = await land(
      {
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        parents: `${BASE_OID} ${HEAD_OID}`,
        mergeTree: completed(`${PARENT_TREE}\n`),
      },
      { ...REVIEWED, merge_method: "merge" },
    )
    expect(reasonOf(outcome)).toContain("the landed content is not the reviewed change")
    expect(outcome.ok === false && outcome.mergeIssued).toBe(true)
    expect(files()).toEqual([])
  })

  test("an already-MERGED rebase whose commits add then remove a file is proved as a rebase chain", async () => {
    const repo = rebasedRepository("transient")
    // The last landed commit is not the reviewed head merged onto its own parent, so a
    // squash-style proof alone would reject this valid rebase.
    expect(git(repo.canonical, ["merge-tree", "--write-tree", `${repo.landed}^`, repo.head])).not.toBe(
      git(repo.canonical, ["rev-parse", `${repo.landed}^{tree}`]),
    )
    const { outcome, calls, files } = await landRebase(
      repo,
      { prView: [completed(mergedGithubPr({ headRefOid: repo.head, mergeCommit: { oid: repo.landed } }))] },
      {},
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(calls.some((call) => merged(call.argv))).toBe(false)
    expect(outcome.receipt.proof.evidence).toMatchObject({
      mergeShape: { rebase: { method: "patch-id", commits: 2 } },
    })
    expect(files()).toHaveLength(1)
  }, 60_000)

  test("refuses merge method when repository policy disallows merge commits", async () => {
    const { outcome, calls, files } = await land(
      { prView: [completed(githubPr())], policy: completed("false\n") },
      { ...REVIEWED, merge_method: "merge" },
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("allow_merge_commit observed false")
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
    expect(files()).toHaveLength(0)
  })

  test.each(["fast-forward", "MERGE", "", null, 1])(
    "strictly refuses invalid merge_method %p",
    async (merge_method) => {
      const { outcome, calls } = await land({}, { merge_method: merge_method as string })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain('expected one of "squash", "merge", "rebase"')
      expect(calls).toHaveLength(0)
    },
  )

  test("a regular-file RETIRED marker makes the landing receipt ledger-inactive", async () => {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    writeFileSync(join(canonical, ".beads", "RETIRED"), "retired\n")
    const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470, worktree: linkedWorktree(canonical, "omp-agent-omp-plugins-9ej3.5") },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.beads).toEqual({ ids: ["omp-plugins-9ej3.5"], ledgerActive: false })
    expect(outcome.next).toEqual(["delivery_cleanup"])
    expect(outcome.text).not.toContain("bd update")
  })

  /**
   * The inverse of what this file used to pin, and the security fix itself: the
   * canonical root's verdict is the repository's verdict. A nested `.beads` under the
   * directory the tool was called in does not get a vote, in either direction.
   */
  test("a nested active ledger does not override a retired canonical root", async () => {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    writeFileSync(join(canonical, ".beads", "RETIRED"), "retired\n")
    const nested = join(canonical, "nested")
    mkdirSync(join(nested, ".beads"), { recursive: true })
    const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: nested, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.beads.ledgerActive).toBe(false)
    expect(outcome.receipt.proof.evidence).toMatchObject({ ledger: { root: realpathSync(canonical), active: false } })
    expect(outcome.next).toEqual(["delivery_cleanup"])
    expect(outcome.text).not.toContain("bd update")
  })

  test("a nested retired ledger does not deactivate an active canonical root", async () => {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    const nested = join(canonical, "nested")
    mkdirSync(join(nested, ".beads"), { recursive: true })
    writeFileSync(join(nested, ".beads", "RETIRED"), "retired\n")
    const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: nested, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.beads.ledgerActive).toBe(true)
    expect(outcome.receipt.proof.evidence).toMatchObject({ ledger: { root: realpathSync(canonical), active: true } })
    expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.5", 470, MERGE_OID, outcome.receiptPath))
    expect(outcome.text).toContain(
      `bd close omp-plugins-9ej3.5 --reason "PR #470 merged as ${MERGE_OID}; receipt ${outcome.receiptPath}"`,
    )
  })

  test("a symlinked RETIRED marker does not deactivate the ledger", async () => {
    const { canonical, receipts } = repository()
    const beads = join(canonical, ".beads")
    mkdirSync(beads)
    const target = join(canonical, "retired-target")
    writeFileSync(target, "retired\n")
    symlinkSync(target, join(beads, "RETIRED"))
    const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.beads.ledgerActive).toBe(true)
    expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.5", 470, MERGE_OID, outcome.receiptPath))
  })

  test("a dangling .beads path keeps the ledger active", async () => {
    const { canonical, receipts } = repository()
    symlinkSync(join(canonical, "missing-beads"), join(canonical, ".beads"))
    const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.beads.ledgerActive).toBe(true)
  })

  test("a non-directory .beads path keeps the ledger active", async () => {
    const { canonical, receipts } = repository()
    writeFileSync(join(canonical, ".beads"), "not a directory\n")
    const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.beads.ledgerActive).toBe(true)
  })

  test("the result text lists native child-before-parent closeout commands before delivery_cleanup", async () => {
    const { outcome } = await land({ prView: [completed(mergedGithubPr())] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    const update = `bd update omp-plugins-9ej3.5 --set-metadata pr=470 --set-metadata merge_sha=${MERGE_OID}`
    const close = `bd close omp-plugins-9ej3.5 --reason "PR #470 merged as ${MERGE_OID}; receipt ${outcome.receiptPath}"`
    expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.5", 470, MERGE_OID, outcome.receiptPath))
    expect(outcome.text).toContain("children before parents")
    expect(outcome.text.indexOf(update)).toBeGreaterThan(-1)
    expect(outcome.text.indexOf(update)).toBeLessThan(outcome.text.indexOf(close))
    expect(outcome.text.indexOf(close)).toBeLessThan(outcome.text.indexOf("delivery_cleanup"))
  })

  test("an already MERGED pull request is proved, not merged again", async () => {
    const { outcome, calls, files } = await land({ prView: [completed(mergedGithubPr())] })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.outcome).toBe("landed")
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
    expect(calls.filter((call) => call.argv[1] === "pr" && call.argv[2] === "view")).toHaveLength(1)
    expect(outcome.receipt.proof.evidence).toMatchObject({ merge: null, reread: null })
    expect(outcome.receipt.notes).toContain("already MERGED")
    expect(files()).toHaveLength(1)
  })

  test("a GitLab merge request is read in its own dialect", async () => {
    const { canonical, receipts } = repository()
    const { run } = runner(
      { remoteUrl: "git@gitlab.com:group/project.git", prView: [completed(gitlabMr())] },
      canonical,
    )
    const outcome = await landPullRequest(
      { pr: "12" },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.repo.forge).toBe("gitlab")
    expect(outcome.receipt.pr.number).toBe(12)
    expect(outcome.receipt.pr.state).toBe("merged")
    expect(outcome.receipt.pr.mergeCommitOid).toBe(MERGE_OID)
  })

  test("an expectHeadSha mismatch refuses, names both shas, and merges nothing", async () => {
    const { outcome, calls, files } = await land(
      { prView: [completed(githubPr())] },
      { expectHeadSha: "ffffffffffffffffffffffffffffffffffffffff" },
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain(HEAD_OID)
    expect(outcome.reason).toContain("ffffffffffffffffffffffffffffffffffffffff")
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
    expect(files()).toHaveLength(0)
  })

  test("a re-read that is not MERGED refuses, names the observed state and oid, and writes nothing", async () => {
    const { outcome, calls, files } = await land(
      {
        prView: [completed(githubPr()), completed(githubPr({ state: "OPEN" }))],
      },
      REVIEWED,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain('pr.state "OPEN"')
    expect(outcome.reason).toContain("pr.mergeCommitOid null")
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(1)
    expect(files()).toHaveLength(0)
  })

  test("a MERGED re-read with no merge commit oid is not proof", async () => {
    const { outcome, files } = await land(
      { prView: [completed(githubPr()), completed(githubPr({ state: "MERGED" }))] },
      REVIEWED,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("pr.mergeCommitOid null")
    expect(files()).toHaveLength(0)
  })

  test("a failed merge refuses with the observed exit status and writes nothing", async () => {
    const { outcome, files } = await land(
      {
        prView: [completed(githubPr())],
        merge: completed("", 1, "Pull request is not mergeable"),
      },
      REVIEWED,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("observed exit 1")
    expect(outcome.reason).toContain("Pull request is not mergeable")
    expect(files()).toHaveLength(0)
  })

  test("a failed pull-request read and a failed merge describe the failure in one spelling", async () => {
    const view = [
      "gh",
      "pr",
      "view",
      "470",
      "--repo",
      "github.com/srobroek/omp-plugins",
      "--json",
      "id,number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,title",
    ].join(" ")
    const merge = `gh pr merge 470 --squash --subject ${TITLE} --delete-branch --repo github.com/srobroek/omp-plugins --match-head-commit ${HEAD_OID}`
    const cases: Array<[Answers, string]> = [
      [
        { prView: [completed("", 4, "  HTTP 401: Bad credentials \n")] },
        `${view}: observed exit 4, expected exit 0; stderr: HTTP 401: Bad credentials`,
      ],
      [
        {
          prView: [
            { ok: false, exitCode: null, stdout: "", stderr: "", error: "gh produced no exit status within 30000ms" },
          ],
        },
        `${view}: observed gh produced no exit status within 30000ms, expected exit 0`,
      ],
      [
        { prView: [completed(githubPr())], merge: completed("", 1, "Pull request is not mergeable") },
        `${merge}: observed exit 1, expected exit 0; stderr: Pull request is not mergeable; no receipt was written`,
      ],
      [
        { prView: [completed(githubPr())], merge: { ok: true, exitCode: null, stdout: "", stderr: "" } },
        `${merge}: observed no exit status, expected exit 0; no receipt was written`,
      ],
    ]
    for (const [answers, reason] of cases) {
      const { outcome } = await land(answers, REVIEWED)
      expect(outcome.ok ? null : outcome.reason).toBe(reason)
    }
  })

  test("an unknown remote-absence verdict leaves deletedRemote false and the timestamp null", async () => {
    const { outcome } = await land({
      prView: [completed(mergedGithubPr())],
      lsRemote: {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "git was terminated by SIGTERM (timeout 10000ms)",
      },
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.branch.deletedRemote).toBe(false)
    expect(outcome.receipt.branch.remoteAbsenceVerifiedAt).toBeNull()
    expect(outcome.receipt.notes).toContain("unknown")
  })

  test("a remote branch still present is not recorded as deleted", async () => {
    const { outcome } = await land({
      prView: [completed(mergedGithubPr())],
      lsRemote: completed(`${HEAD_OID}\trefs/heads/${BRANCH}\n`),
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.branch.deletedRemote).toBe(false)
    expect(outcome.receipt.branch.remoteAbsenceVerifiedAt).toBeNull()
    expect(outcome.receipt.proof.evidence).toMatchObject({ remoteBranch: { verdict: "present" } })
  })

  test("setupAutoDelete absent or false issues no repository-setting write", async () => {
    for (const setupAutoDelete of [undefined, false] as const) {
      const { outcome, calls } = await land({ prView: [completed(mergedGithubPr())] }, { setupAutoDelete })
      expect(outcome.ok).toBe(true)
      expect(
        calls.filter((call) => call.argv.includes("-X") || call.argv.includes("PATCH") || call.argv.includes("PUT")),
      ).toHaveLength(0)
      if (!outcome.ok) throw new Error(outcome.reason)
      expect(outcome.receipt.notes).toContain("no repository setting was written")
    }
  })

  test("setupAutoDelete true writes the setting once and records the outcome in the notes", async () => {
    const { outcome, calls } = await land(
      { prView: [completed(mergedGithubPr())], autoDelete: completed("false\n") },
      { setupAutoDelete: true },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    const writes = calls.filter((call) => call.argv.includes("-X"))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.argv).toEqual([
      "gh",
      "api",
      "-X",
      "PATCH",
      "repos/srobroek/omp-plugins",
      "-F",
      "delete_branch_on_merge=true",
    ])
    expect(outcome.receipt.notes).toContain("the forge accepted")
    // Acceptance is not a re-read, so the recorded setting stays the observed one.
    expect(outcome.receipt.branch.autoDeleteSetting).toBe("off")
  })

  test("a refused setting write is recorded and does not fail the landing", async () => {
    const { outcome } = await land(
      { prView: [completed(mergedGithubPr())], enable: completed("", 1, "HTTP 403") },
      { setupAutoDelete: true },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.notes).toContain("refused")
    expect(outcome.receipt.branch.autoDeleteSetting).toBe("off")
  })

  test("an unreadable auto-delete setting stays unknown", async () => {
    const { outcome } = await land({ prView: [completed(mergedGithubPr())], autoDelete: completed("", 1, "HTTP 404") })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.branch.autoDeleteSetting).toBe("unknown")
  })

  test("a receipt the validator refuses names the validator's field and writes no file", async () => {
    const { outcome, files } = await land({ prView: [completed(mergedGithubPr({ url: "" }))] })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("pr.url")
    expect(outcome.reason).toContain("no file was written")
    expect(files()).toHaveLength(0)
  })

  test("no path issues a bd argv", async () => {
    const cases: Array<[Answers, Partial<LandParams>]> = [
      [{ prView: [completed(githubPr()), completed(mergedGithubPr())] }, REVIEWED],
      [{ prView: [completed(mergedGithubPr())] }, { setupAutoDelete: true }],
      [{ prView: [completed(githubPr())] }, { expectHeadSha: "deadbeef" }],
      [{ prView: [completed(githubPr())] }, {}],
      [{ prView: [completed(githubPr()), completed(githubPr())] }, REVIEWED],
    ]
    for (const [answers, params] of cases) {
      const { calls } = await land(answers, params)
      expect(calls.filter((call) => call.argv[0] === "bd")).toHaveLength(0)
    }
  })

  test("a pull request number that is not a positive integer never reaches a command", async () => {
    for (const pr of ["--repo", "0", "-1", "", "12x"]) {
      const { outcome, calls } = await land({}, { pr })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain("expected a positive integer")
      expect(calls).toHaveLength(0)
    }
  })

  test("a remote whose URL names no adapter refuses without reading the pull request", async () => {
    const { outcome, calls } = await land({
      remoteUrl: "https://bitbucket.org/team/repo.git",
      prView: [completed(mergedGithubPr())],
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain('repo.forge: observed "unknown"')
    expect(calls.filter((call) => call.argv[0] === "gh")).toHaveLength(0)
  })

  test("a pull-request payload missing a required field refuses by field name", async () => {
    const { outcome, files } = await land({ prView: [completed(JSON.stringify({ number: 470, state: "MERGED" }))] })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("pr.url: observed absent")
    expect(files()).toHaveLength(0)
  })

  test("a polluted Object.prototype cannot supply a merge state the forge never sent", async () => {
    // The defect this pins: a plain `payload.state` read consults the prototype
    // chain, so one polluting dependency anywhere in the session would let an open
    // pull request read as MERGED and emit a receipt claiming it landed.
    for (const [key, value] of [
      ["state", "MERGED"],
      ["mergeCommit", { oid: MERGE_OID }],
    ] as const) {
      Object.defineProperty(Object.prototype, key, { value, configurable: true, enumerable: false, writable: true })
    }
    try {
      expect("state" in {}).toBe(true)
      const { outcome, calls, files } = await land({
        prView: [
          completed(
            JSON.stringify({
              number: 470,
              url: "https://x/1",
              baseRefName: "main",
              headRefName: BRANCH,
              headRefOid: HEAD_OID,
            }),
          ),
        ],
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain("pr.state: observed absent")
      expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
      expect(files()).toHaveLength(0)
    } finally {
      Reflect.deleteProperty(Object.prototype, "state")
      Reflect.deleteProperty(Object.prototype, "mergeCommit")
    }
    expect("state" in {}).toBe(false)
  })

  test("the merge argv binds the repository, the first observed head, and the title as squash subject", async () => {
    const { outcome, calls } = await land({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, REVIEWED)

    expect(outcome.ok).toBe(true)
    const merges = calls.filter((call) => merged(call.argv))
    expect(merges).toHaveLength(1)
    expect(merges[0]?.argv).toEqual([
      "gh",
      "pr",
      "merge",
      "470",
      "--squash",
      "--subject",
      TITLE,
      "--delete-branch",
      "--repo",
      "github.com/srobroek/omp-plugins",
      "--match-head-commit",
      HEAD_OID,
    ])
    expect(calls.filter((call) => call.argv[1] === "pr" && call.argv[2] === "view").map((call) => call.argv)).toEqual([
      [
        "gh",
        "pr",
        "view",
        "470",
        "--repo",
        "github.com/srobroek/omp-plugins",
        "--json",
        "id,number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,title",
      ],
      [
        "gh",
        "pr",
        "view",
        "470",
        "--repo",
        "github.com/srobroek/omp-plugins",
        "--json",
        "id,number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,title",
      ],
    ])
    if (!outcome.ok) throw new Error(outcome.reason)
    // The receipt records the unqualified identity: the host belongs to the command
    // that was issued, not to the repository the landing is about.
    expect(outcome.receipt.proof.evidence).toMatchObject({
      boundRepo: "srobroek/omp-plugins",
      merge: { boundHead: HEAD_OID },
    })
  })

  test("a canonical GitHub repo prefix and a pinned GH_HOST defeat a configured host alias", async () => {
    const { outcome, calls } = await land(
      { prView: [completed(githubPr()), completed(mergedGithubPr())] },
      { ...REVIEWED, setupAutoDelete: true },
      { GH_HOST: "evil.example", GH_REPO: "attacker/elsewhere", GH_TOKEN: "keep-gh", PATH: "/usr/bin" },
    )

    expect(outcome.ok).toBe(true)
    const ghCalls = calls.filter((call) => call.argv[0] === "gh")
    expect(ghCalls.length).toBeGreaterThan(3)
    for (const call of ghCalls) {
      // Replaced by the verified host, not merely stripped: an absent GH_HOST still
      // lets `gh` fall back to a host from its own configuration.
      expect(call.env?.GH_HOST).toBe("github.com")
      expect(call.env?.GH_REPO).toBeUndefined()
      expect(call.env?.GH_TOKEN).toBe("keep-gh")
      const repoIndex = call.argv.indexOf("--repo")
      if (repoIndex >= 0) expect(call.argv[repoIndex + 1]).toBe("github.com/srobroek/omp-plugins")
    }
    // The settings reads address the repository in the request path, where the host
    // is the adapter's to add, so they carry the unqualified path.
    for (const call of ghCalls.filter((call) => call.argv[1] === "api")) {
      expect(call.argv.some((part) => part.includes("repos/srobroek/omp-plugins"))).toBe(true)
    }
  })

  test("an alternate SSH transport host still addresses the canonical API host", async () => {
    const { canonical, receipts } = repository()
    const { run, calls } = runner(
      {
        remoteUrl: "ssh://git@ssh.github.com:443/srobroek/omp-plugins.git",
        prView: [completed(githubPr()), completed(mergedGithubPr())],
      },
      canonical,
    )
    const outcome = await landPullRequest(
      { pr: 470, ...REVIEWED },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    for (const call of calls.filter((call) => call.argv[0] === "gh" && call.argv.includes("--repo"))) {
      expect(call.argv[call.argv.indexOf("--repo") + 1]).toBe("github.com/srobroek/omp-plugins")
      expect(call.env?.GH_HOST).toBe("github.com")
    }
  })

  test("a GitLab merge binds the repository and the head in glab's spelling", async () => {
    const { canonical, receipts } = repository()
    const { run, calls } = runner(
      {
        remoteUrl: "ssh://git@altssh.gitlab.com:443/group/sub/project.git",
        prView: [completed(gitlabMr({ state: "opened", merge_commit_sha: null })), completed(gitlabMr())],
      },
      canonical,
    )
    const outcome = await landPullRequest(
      { pr: 12, ...REVIEWED },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    expect(calls.filter((call) => merged(call.argv))[0]?.argv).toEqual([
      "glab",
      "mr",
      "merge",
      "12",
      "--squash",
      "--squash-message",
      TITLE,
      "--remove-source-branch",
      "--repo",
      "gitlab.com/group/sub/project",
      "--sha",
      HEAD_OID,
    ])
    expect(calls.filter((call) => call.argv[1] === "mr" && call.argv[2] === "view").map((call) => call.argv)).toEqual([
      ["glab", "mr", "view", "12", "--repo", "gitlab.com/group/sub/project", "--output", "json"],
      ["glab", "mr", "view", "12", "--repo", "gitlab.com/group/sub/project", "--output", "json"],
    ])
  })

  test("a canonical GitLab repo prefix defeats a configured dotless host alias", async () => {
    const { canonical, receipts } = repository()
    const fixture = runner(
      {
        remoteUrl: "git@gitlab.com:corp/group/project.git",
        prView: [completed(gitlabMr({ state: "opened", merge_commit_sha: null })), completed(gitlabMr())],
      },
      canonical,
    )
    const run: CliRunner = (argv, options) => {
      const repoIndex = argv.indexOf("--repo")
      if (argv[0] === "glab" && repoIndex >= 0 && argv[repoIndex + 1] === "corp/group/project") {
        // Model glab treating the first path segment as a configured host alias.
        fixture.calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env })
        return completed(gitlabMr({ iid: 999 }))
      }
      return fixture.run(argv, options)
    }
    const outcome = await landPullRequest(
      { pr: 12, ...REVIEWED },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.repo.nameWithOwner).toBe("corp/group/project")
    expect(
      fixture.calls
        .filter((call) => call.argv[0] === "glab" && call.argv.includes("--repo"))
        .map((call) => call.argv[call.argv.indexOf("--repo") + 1]),
    ).toEqual(["gitlab.com/corp/group/project", "gitlab.com/corp/group/project", "gitlab.com/corp/group/project"])
  })

  test("a structurally malformed identity refuses before an unreadable remote", async () => {
    for (const repo of ["https://github.com/owner/repo", "owner", "owner//repo", "owner/../repo"]) {
      const { canonical } = repository()
      const calls: Call[] = []
      const run: CliRunner = (argv, options) => {
        calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env })
        return { ok: false, exitCode: null, stdout: "", stderr: "", error: "the remote is unreadable" }
      }
      const outcome = await landPullRequest({ pr: 470, repo }, { run, cwd: canonical, now: () => NOW, env: {} })

      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain("repo: observed")
      expect(calls).toHaveLength(0)
    }
  })

  test("a host-qualified GitHub remote path cannot become --repo when params.repo is absent", async () => {
    const { outcome, calls } = await land({ remoteUrl: "https://github.com/github.com/owner/repo.git" })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("repo: observed")
    expect(calls.filter((call) => call.argv[0] === "gh")).toHaveLength(0)
  })

  /**
   * `URL` deletes embedded tabs and newlines before parsing, so each of these would
   * classify as an ordinary GitHub remote once the output was trimmed — and this
   * identity binds the merge argv, so agreeing with the wrong parser here merges
   * somewhere nobody named. The output is therefore read as exactly one record.
   *
   * The refusal quotes none of it. Output no parser accepted cannot be redacted, since
   * a redactor can only find a secret in a spelling it understands, so the cases with
   * userinfo and a token query must leave neither the token nor its URL in the reason
   * or in any receipt — and there is no receipt, because nothing was written.
   */
  test("git remote get-url output that is not exactly one record merges nothing", async () => {
    for (const remoteUrl of [
      "https://git\thub.com/srobroek/omp-plugins.git",
      "https://github.com/srobroek/omp-plugins.git\n@evil.example/x",
      "https://github.com/srobroek/omp-plugins.git\nhttps://evil.example/o/r.git",
      " https://github.com/srobroek/omp-plugins.git",
      "https://github.com/srobroek/omp-plugins.git ",
      "",
      "https://srobroek:ghp_secrettoken@git\thub.com/srobroek/omp-plugins.git",
      "https://github.com/srobroek/omp-plugins.git?token=ghp_secrettoken\nhttps://evil.example/x",
      " ssh://git:ghp_secrettoken@github.com/srobroek/omp-plugins.git",
    ]) {
      const { outcome, calls, files } = await land({ remoteUrl, prView: [completed(githubPr())] })

      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain("git remote get-url origin: observed malformed Git remote output")
      expect(outcome.reason).toContain("exactly one URL record")
      expect(outcome.reason).not.toContain("ghp_secrettoken")
      expect(outcome.reason).not.toContain("github.com/srobroek")
      expect(outcome.reason).not.toContain("evil.example")
      // Before any forge command, so nothing was read, merged, or written.
      expect(calls.filter((call) => call.argv[0] === "gh")).toHaveLength(0)
      expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
      expect(files()).toHaveLength(0)
    }
  })

  test("ambient Git selectors cannot redirect repository identity or landing proof", async () => {
    const { canonical, receipts } = repository()
    const attacker = repository()
    const ambient = {
      GIT_DIR: join(attacker.canonical, ".git"),
      GIT_WORK_TREE: attacker.canonical,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "remote.origin.url",
      GIT_CONFIG_VALUE_0: "https://github.com/attacker/elsewhere.git",
      PATH: "/usr/bin",
    }
    const fixture = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const run: CliRunner = (argv, options) => {
      const effectiveEnv = options.env ?? ambient
      const redirected =
        argv[0] === "git" &&
        Object.keys(effectiveEnv).some(
          (key) => key === "GIT_DIR" || key === "GIT_WORK_TREE" || key.startsWith("GIT_CONFIG_"),
        )
      if (!redirected) return fixture.run(argv, options)
      fixture.calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env })
      if (argv.includes("--show-toplevel"))
        return completed(`${join(attacker.canonical, ".git")}\n${attacker.canonical}\n`)
      if (argv.includes("get-url")) return completed("https://github.com/attacker/elsewhere.git\n")
      return completed(`${HEAD_OID}\trefs/heads/${BRANCH}\n`)
    }
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: ambient },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.repo.canonicalRoot).toBe(realpathSync(canonical))
    expect(outcome.receipt.repo.nameWithOwner).toBe("srobroek/omp-plugins")
    expect(outcome.receipt.branch.deletedRemote).toBe(true)
  })

  test("a head that moved between the merge and the re-read refuses and writes nothing", async () => {
    const moved = "9999999999999999999999999999999999999999"
    const { outcome, files } = await land(
      {
        prView: [completed(githubPr()), completed(mergedGithubPr({ headRefOid: moved }))],
      },
      REVIEWED,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain(moved)
    expect(outcome.reason).toContain(HEAD_OID)
    expect(outcome.reason).toContain("the head moved")
    expect(files()).toHaveLength(0)
  })

  test("a pull request re-targeted between the reads refuses and writes nothing", async () => {
    const { outcome, files } = await land(
      {
        prView: [completed(githubPr()), completed(mergedGithubPr({ baseRefName: "main" }))],
      },
      REVIEWED,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("re-targeted")
    expect(outcome.reason).toContain("omp/integration/omp-plugins-9ej3")
    expect(files()).toHaveLength(0)
  })

  test("a payload for another pull request refuses before merging", async () => {
    const { outcome, calls, files } = await land({ prView: [completed(githubPr({ number: 999 }))] })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("observed pr.number 999, expected 470")
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
    expect(files()).toHaveLength(0)
  })

  test("a re-read for another pull request refuses and writes nothing", async () => {
    const { outcome, files } = await land(
      { prView: [completed(githubPr()), completed(mergedGithubPr({ number: 999 }))] },
      REVIEWED,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("observed pr.number 999, expected 470")
    expect(files()).toHaveLength(0)
  })

  test("a head that is not a whole object id cannot bind a merge, so none is issued", async () => {
    const { outcome, calls, files } = await land(
      { prView: [completed(githubPr({ headRefOid: "0123456" }))] },
      { expectHeadSha: "0123456" },
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain('pr.headRefOid: observed "0123456"')
    expect(outcome.reason).toContain("no merge was issued")
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
    expect(files()).toHaveLength(0)
  })

  test.each([
    ["git version 2.38.0\n", null],
    ["git version 2.39.5 (Apple Git-154)\n", null],
    ["git version 2.45.0.windows.1\n", null],
    ["git version 3.0.0\n", null],
    ["git version 2.37.9\n", "observed 2.37, expected 2.38 or newer"],
    ["git version 1.99.0\n", "observed 1.99, expected 2.38 or newer"],
    ["", 'expected "git version <major>.<minor>"'],
    [null, 'expected "git version <major>.<minor>"'],
  ])("gitVersionFailure reads %p", (output, failure) => {
    const reason = gitVersionFailure(output)
    if (failure === null) expect(reason).toBeNull()
    else expect(reason).toContain(failure)
  })

  test.each(["2.37.9", "2.30.2", "1.9.5"])("git %s cannot run the content proof, so no merge is issued", async (gitVersion) => {
    const { outcome, calls, files } = await land({ prView: [completed(githubPr())], gitVersion }, REVIEWED)

    const reason = reasonOf(outcome)
    expect(reason).toContain(`observed ${gitVersion.split(".").slice(0, 2).join(".")}, expected 2.38 or newer`)
    expect(reason).toContain("no merge was issued")
    expect(calls.filter((call) => merged(call.argv))).toEqual([])
    expect(calls.filter((call) => call.argv[0] === "gh")).toEqual([])
    expect(files()).toHaveLength(0)
  })

  test.each(["--output=/etc/delivery-poc", "-n1", "--upload-pack=touch /x"])(
    "a merge commit id %p that reads as a git option reaches no git command",
    async (oid) => {
      const { outcome, calls, files } = await land(
        { prView: [completed(mergedGithubPr({ mergeCommit: { oid } }))] },
        REVIEWED,
      )

      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain(oid)
      expect(calls.filter((call) => call.argv[0] === "git" && call.argv.includes(oid))).toEqual([])
      expect(files()).toHaveLength(0)
    },
  )

  test("ambient repository and host variables reach no forge command, on either forge", async () => {
    // Every spelling either CLI reads. `gh`: GH_REPO, GH_HOST. `glab`: GITLAB_HOST,
    // the older GL_HOST, GITLAB_URI, and GITLAB_API_HOST, which redirects API traffic
    // by itself. A GitLab variable is stripped from a GitHub command too: whoever
    // exported it was not necessarily talking about this landing.
    const redirectors = {
      GH_REPO: "attacker/elsewhere",
      GH_HOST: "evil.example",
      GITLAB_HOST: "evil.example",
      GL_HOST: "evil.example",
      GITLAB_URI: "https://evil.example",
      GITLAB_API_HOST: "api.evil.example",
    }
    const ambient = {
      ...redirectors,
      GH_TOKEN: "keep-gh",
      GITLAB_TOKEN: "keep-gitlab",
      GL_TOKEN: "keep-gl",
      PATH: "/usr/bin",
    }

    const github = await land(
      { prView: [completed(githubPr()), completed(mergedGithubPr())] },
      { ...REVIEWED, setupAutoDelete: true },
      ambient,
    )
    expect(github.outcome.ok).toBe(true)

    const { canonical, receipts } = repository()
    const { run, calls: gitlabCalls } = runner(
      {
        remoteUrl: "git@gitlab.com:group/project.git",
        prView: [completed(gitlabMr({ state: "opened", merge_commit_sha: null })), completed(gitlabMr())],
      },
      canonical,
    )
    const gitlab = await landPullRequest(
      { pr: 12, ...REVIEWED, setupAutoDelete: true },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: ambient },
    )
    expect(gitlab.ok).toBe(true)

    for (const [cli, calls] of [
      ["gh", github.calls],
      ["glab", gitlabCalls],
    ] as const) {
      const forgeCalls = calls.filter((call) => call.argv[0] === cli)
      // view, merge, re-read, settings read, settings write.
      expect(forgeCalls.length).toBeGreaterThan(3)
      for (const call of forgeCalls) {
        const glabCall = cli === "glab"
        const pinnedGitLabApi = glabCall && call.argv[1] === "api"
        // Each CLI's own host variable is not stripped but overwritten with the host
        // `forgeTarget` verified: absent, a CLI still reads a default host from its
        // own configuration. Every other redirector, including the other forge's,
        // is gone.
        const pinned = glabCall ? ["GITLAB_HOST", "GITLAB_API_HOST"] : ["GH_HOST"]
        const canonicalHost = glabCall ? "gitlab.com" : "github.com"
        for (const key of Object.keys(redirectors)) {
          if (pinned.includes(key)) {
            expect(call.env?.[key]).toBe(canonicalHost)
          } else {
            expect(call.env?.[key]).toBeUndefined()
          }
        }
        if (pinnedGitLabApi) {
          const hostname = call.argv.indexOf("--hostname")
          expect(hostname).toBeGreaterThan(0)
          expect(call.argv[hostname + 1]).toBe("gitlab.com")
        }
        // Credentials are kept: an unauthenticated command is a different failure.
        expect(call.env?.GH_TOKEN).toBe("keep-gh")
        expect(call.env?.GITLAB_TOKEN).toBe("keep-gitlab")
        expect(call.env?.GL_TOKEN).toBe("keep-gl")
      }
    }

    // The adapter hardens Git's own environment for the absence observation, and that
    // choice is left intact rather than replaced by this tool's.
    const lsRemote = github.calls.find((call) => call.argv.includes("ls-remote"))
    expect(lsRemote?.env?.GIT_ALLOW_PROTOCOL).toBe("file:https:ssh")
    expect(lsRemote?.env?.GIT_TERMINAL_PROMPT).toBe("0")
  })

  test("an unreadable repository refuses before any forge call", async () => {
    const { canonical } = repository()
    const calls: Call[] = []
    const run: CliRunner = (argv, options) => {
      calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env })
      return { ok: false, exitCode: null, stdout: "", stderr: "", error: "spawn git ENOENT" }
    }
    const outcome = await landPullRequest({ pr: 470 }, { run, cwd: canonical, now: () => NOW, env: {} })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("git rev-parse --path-format=absolute --git-common-dir --show-toplevel")
    expect(calls).toHaveLength(1)
  })

  test("the receipt directory follows DELIVERY_RECEIPTS_DIR, never into the checkout", async () => {
    const { canonical } = repository()
    const agentDir = temporaryDirectory("delivery-land-agent-")
    const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: canonical, now: () => NOW, env: { DELIVERY_RECEIPTS_DIR: join(agentDir, "receipts") } },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receiptPath.startsWith(join(agentDir, "receipts", outcome.receipt.repo.key))).toBe(true)
    expect(existsSync(join(canonical, "receipts"))).toBe(false)
    expect(JSON.parse(readFileSync(outcome.receiptPath, "utf8")).receiptId).toBe(outcome.receipt.receiptId)
  })

  test("a repo override that the merge argv could not honour refuses before reading", async () => {
    const { outcome, calls } = await land({ prView: [completed(mergedGithubPr())] }, { repo: "someone-else/fork" })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain('"someone-else/fork"')
    expect(outcome.reason).toContain('"srobroek/omp-plugins"')
    expect(calls.filter((call) => call.argv[0] === "gh")).toHaveLength(0)
  })

  test("a repo override that agrees with the remote is accepted", async () => {
    const { outcome } = await land({ prView: [completed(mergedGithubPr())] }, { repo: "srobroek/omp-plugins" })
    expect(outcome.ok).toBe(true)
  })

  test("a credential in the remote URL is not copied into the receipt", async () => {
    const { outcome } = await land({
      remoteUrl: "https://sjors:ghp_secrettoken@github.com/srobroek/omp-plugins.git",
      prView: [completed(mergedGithubPr())],
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.repo.remote).toBe("origin")
    expect(outcome.receipt.proof.evidence).toMatchObject({ remoteUrl: "https://github.com/srobroek/omp-plugins.git" })
    expect(outcome.receipt.repo.nameWithOwner).toBe("srobroek/omp-plugins")
    expect(JSON.stringify(outcome.receipt)).not.toContain("ghp_secrettoken")
  })

  test("a configured upstream remote name is recorded and reused, never hardcoded to origin", async () => {
    const { outcome, calls } = await land({ prView: [completed(mergedGithubPr())] }, { remote: "upstream" })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.repo.remote).toBe("upstream")
    expect(outcome.receipt.proof.evidence).toMatchObject({ remote: "upstream" })
    expect(calls.find((call) => call.argv[1] === "remote")?.argv).toEqual(["git", "remote", "get-url", "upstream"])
    const absence = calls.find((call) => call.argv.includes("ls-remote"))
    expect(absence?.argv).toContain("upstream")
    expect(absence?.argv).not.toContain("origin")
  })

  /**
   * The exact object a real land emits, key by key against decision omp-plugins-9ej3.1
   * section 2 as amended by omp-plugins-9ej3.45. Two packages read this shape, so the
   * assertion is the whole object and the whole top-level key set: a field added,
   * renamed or dropped here is a contract change and must fail a test, not a consumer.
   */
  test("a real land emits exactly the amended v1 receipt object", async () => {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    const { run } = runner({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, canonical)
    const worktree = linkedWorktree(canonical, "omp-agent-omp-plugins-9ej3.5")
    const outcome = await landPullRequest(
      { pr: 470, ...REVIEWED, worktree },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    const receipt = outcome.receipt
    const key = repoKey(canonical, () => join(canonical, ".git"))
    if (key === null) throw new Error("the fixture repository has no key")

    expect(Object.keys(receipt).sort()).toEqual([
      "beads",
      "branch",
      "emittedAt",
      "emitter",
      "notes",
      "outcome",
      "pr",
      "proof",
      "receiptId",
      "repo",
      "schema",
      "supersedes",
      "version",
      "worktree",
    ])
    expect(receipt.schema).toBe("omp.receipt.landing")
    expect(receipt.version).toBe(1)
    expect(receipt.receiptId).toBe(`${NOW}-${MERGE_OID.slice(0, 12)}`)
    expect(receipt.emittedAt).toBe(new Date(NOW).toISOString())
    expect(receipt.emitter).toEqual({ plugin: pkg.name, version: pkg.version, tool: "delivery_land" })
    expect(receipt.repo).toEqual({
      key,
      canonicalRoot: realpathSync(canonical),
      remote: "origin",
      forge: "github",
      nameWithOwner: "srobroek/omp-plugins",
    })
    expect(receipt.pr).toEqual({
      number: 470,
      url: "https://github.com/srobroek/omp-plugins/pull/470",
      state: "MERGED",
      baseRefName: "omp/integration/omp-plugins-9ej3",
      headRefName: BRANCH,
      headRefOid: HEAD_OID,
      mergeCommitOid: MERGE_OID,
      mergedAt: "2026-09-21T20:00:00Z",
    })
    expect(receipt.branch).toEqual({
      name: BRANCH,
      deletedRemote: true,
      remoteAbsenceVerifiedAt: new Date(NOW).toISOString(),
      autoDeleteSetting: "off",
    })
    expect(receipt.worktree).toEqual({
      path: worktree,
      removed: false,
      localRefDeleted: false,
      absenceVerifiedAt: null,
    })
    expect(receipt.beads).toEqual({ ids: ["omp-plugins-9ej3.5"], ledgerActive: true })
    expect(receipt.proof.method).toBe("gh pr view")
    expect(receipt.proof.observedAt).toBe(new Date(NOW).toISOString())
    expect(receipt.outcome).toBe("landed")
    expect(receipt.supersedes).toBeNull()
    expect(typeof receipt.notes).toBe("string")

    // A forward key a later version added must survive the transport untouched.
    const forward = { ...receipt, mergeQueueEntry: { id: "q-1" } }
    const written = writeReceipt(forward, temporaryDirectory("delivery-land-forward-"))
    expect(readReceipt(written)).toEqual({ ok: true, receipt: forward })
  })

  /**
   * Not a path-shape test: the receipt directory is chosen from the environment, and a
   * whitespace-only DELIVERY_RECEIPTS_DIR is no directory at all. Producer and consumer must
   * trim it identically or they look for receipts in two different trees.
   */
  test("a whitespace-only DELIVERY_RECEIPTS_DIR puts the receipt under $HOME/.omp", async () => {
    const { canonical } = repository()
    const home = temporaryDirectory("delivery-land-home-")
    const { run } = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: canonical, now: () => NOW, env: { DELIVERY_RECEIPTS_DIR: "   ", HOME: home } },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receiptPath).toBe(
      join(home, ".omp", "receipts", outcome.receipt.repo.key, `${outcome.receipt.receiptId}.json`),
    )
  })

  test("the remote-absence probe is asked in the directory this call was made from", async () => {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    const nested = join(canonical, "nested")
    mkdirSync(nested)
    const { run, calls } = runner({ prView: [completed(mergedGithubPr())] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: nested, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    expect(calls.filter((call) => call.argv.includes("ls-remote")).map((call) => call.cwd)).toEqual([nested, nested])
  })

  /**
   * An active ledger and no bead to reconcile is the pair the escalation exploited from
   * the other side: cleanup would ask `bd` about an empty list and pass. A non-agent
   * branch on a repository that tracks its work must name its bead or refuse.
   */
  test("an active ledger with no derivable bead identity refuses before merging and writes nothing", async () => {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    const { run, calls } = runner({ prView: [completed(githubPr({ headRefName: "feature/no-bead" }))] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470, ...REVIEWED },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain('beads.ids: observed no bead identity for branch "feature/no-bead"')
    expect(outcome.reason).toContain("an explicit beadId")
    expect(outcome.reason).toContain(realpathSync(canonical))
    expect(outcome.reason).toContain("no merge was issued and no receipt was written")
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
    expect(readdirSync(receipts)).toEqual([])
  })

  test("beadId names the bead a non-agent branch cannot", async () => {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    const { run } = runner({ prView: [completed(mergedGithubPr({ headRefName: "feature/no-bead" }))] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470, beadId: "omp-plugins-9ej3.38" },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.beads).toEqual({ ids: ["omp-plugins-9ej3.38"], ledgerActive: true })
    expect(outcome.next).toEqual(nativeNext("omp-plugins-9ej3.38", 470, MERGE_OID, outcome.receiptPath))
  })

  test("a ledger-free repository needs no bead identity at all", async () => {
    const { canonical, receipts } = repository()
    const { run } = runner({ prView: [completed(mergedGithubPr({ headRefName: "feature/no-bead" }))] }, canonical)
    const outcome = await landPullRequest(
      { pr: 470 },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.beads).toEqual({ ids: [], ledgerActive: false })
    expect(outcome.next).toEqual(["delivery_cleanup"])
  })

  test("a beadId that is not a bead id, or that contradicts the branch, refuses and merges nothing", async () => {
    for (const beadId of ["-malicious", "bead id", "../escape", "a;b"]) {
      const { outcome, calls, files } = await land({ prView: [completed(githubPr())] }, { ...REVIEWED, beadId })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain("beadId: observed")
      expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
      expect(files()).toHaveLength(0)
    }

    const contradicted = await land({ prView: [completed(githubPr())] }, { ...REVIEWED, beadId: "omp-plugins-9ej3.99" })
    expect(contradicted.outcome.ok).toBe(false)
    if (contradicted.outcome.ok) throw new Error("expected a refusal")
    expect(contradicted.outcome.reason).toContain('expected "omp-plugins-9ej3.5" from branch')
    expect(contradicted.files()).toHaveLength(0)
  })

  /**
   * The per-user store `~/.beads` sits above every repository under $HOME. It is not
   * this repository's ledger, so it must neither mark the landing ledger-backed nor
   * demand a bead for a branch that names none.
   */
  test("a ledger-free repository below an ancestor .beads lands without a beadId", async () => {
    const outer = realpathSync(temporaryDirectory("delivery-land-home-"))
    mkdirSync(join(outer, ".beads"))
    const canonical = join(outer, "repo")
    mkdirSync(join(canonical, ".git"), { recursive: true })
    const receipts = temporaryDirectory("delivery-land-receipts-")
    const { run, calls } = runner(
      {
        prView: [
          completed(githubPr({ headRefName: "feature/no-bead" })),
          completed(mergedGithubPr({ headRefName: "feature/no-bead" })),
        ],
      },
      canonical,
    )
    const outcome = await landPullRequest(
      { pr: 470, ...REVIEWED },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {} },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(1)
    expect(outcome.receipt.beads).toEqual({ ids: [], ledgerActive: false })
    expect(outcome.receipt.proof.evidence).toMatchObject({ ledger: { root: canonical, active: false } })
    expect(outcome.next).toEqual(["delivery_cleanup"])
  })

  /**
   * The recorded worktree is what `delivery_cleanup` later removes, so it must be the
   * checkout holding the landed head. A path at another head — the release-please
   * landing that recorded an unrelated feature worktree — would hand cleanup a target
   * nobody landed. The check also covers an already-MERGED proof, which records the
   * worktree just the same.
   */
  test("a worktree that does not hold the pull request head refuses before any forge mutation", async () => {
    const elsewhere = "9".repeat(40)
    const cases: Array<[string, Answers, Partial<LandParams>]> = [
      ["another head", { prView: [completed(githubPr())], worktreeHead: completed(`${elsewhere}\n`) }, REVIEWED],
      [
        "not a checkout",
        { prView: [completed(githubPr())], worktreeHead: completed("", 128, "fatal: not a git repository") },
        REVIEWED,
      ],
      [
        "already merged, another head",
        { prView: [completed(mergedGithubPr())], worktreeHead: completed(`${elsewhere}\n`) },
        {},
      ],
    ]
    for (const [label, answers, params] of cases) {
      const { outcome, calls, files, worktreePath } = await land(answers, {
        ...params,
        worktree: "/tmp/worktrees/elsewhere",
        setupAutoDelete: true,
      })
      if (outcome.ok) throw new Error(`${label}: expected a refusal`)
      expect(outcome.reason).toContain("worktree")
      expect(outcome.reason).toContain(worktreePath ?? "")
      expect(outcome.reason).toContain(HEAD_OID)
      if (label.includes("another head")) expect(outcome.reason).toContain(elsewhere)
      expect(
        calls.filter((call) => call.argv.join(" ") === "git rev-parse --verify HEAD^{commit}").map((call) => call.cwd),
      ).toEqual([realpathSync(worktreePath ?? "")])
      expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
      expect(calls.filter((call) => settingsCall(call.argv))).toHaveLength(0)
      expect(files()).toHaveLength(0)
    }
  })

  test("a new merge requires expectHeadSha, while an already-MERGED proof does not", async () => {
    for (const expectHeadSha of [undefined, "", "   "]) {
      const { outcome, calls, files } = await land({ prView: [completed(githubPr())] }, { expectHeadSha })
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain("expectHeadSha")
      expect(outcome.reason).toContain(HEAD_OID)
      expect(outcome.reason).toContain("no merge was issued")
      expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
      expect(files()).toHaveLength(0)
    }

    const proved = await land({ prView: [completed(mergedGithubPr())] })
    expect(proved.outcome.ok).toBe(true)
    expect(proved.calls.filter((call) => merged(call.argv))).toHaveLength(0)
    expect(proved.files()).toHaveLength(1)
  })

  /**
   * Every refusal the call can reach, each with `setupAutoDelete: true`. The setting
   * changes every future contributor's merges, so a landing that does not complete
   * must leave it untouched — not merely unwritten, but not even read.
   */
  test("a refused landing reads and writes no deletion-on-merge setting", async () => {
    const cases: Array<[string, Answers, Partial<LandParams>]> = [
      [
        "merge-commit policy",
        { prView: [completed(githubPr())], policy: completed("false\n") },
        { ...REVIEWED, merge_method: "merge" },
      ],
      ["no expectHeadSha", { prView: [completed(githubPr())] }, {}],
      ["expectHeadSha mismatch", { prView: [completed(githubPr())] }, { expectHeadSha: "f".repeat(40) }],
      [
        "worktree at another head",
        { prView: [completed(githubPr())], worktreeHead: completed(`${"9".repeat(40)}\n`) },
        { ...REVIEWED, worktree: "/tmp/worktrees/elsewhere" },
      ],
      ["abbreviated head", { prView: [completed(githubPr({ headRefOid: "0123456" }))] }, { expectHeadSha: "0123456" }],
      ["no title to squash with", { prView: [completed(githubPr({ title: "" }))] }, REVIEWED],
      ["no bead identity", { prView: [completed(githubPr({ headRefName: "feature/no-bead" }))] }, REVIEWED],
      [
        "forge refused the merge",
        { prView: [completed(githubPr())], merge: completed("", 1, "Pull request is not mergeable") },
        REVIEWED,
      ],
      ["re-read not merged", { prView: [completed(githubPr()), completed(githubPr())] }, REVIEWED],
      [
        "landed shape mismatch",
        { prView: [completed(githubPr()), completed(mergedGithubPr())], parents: `${BASE_OID} ${HEAD_OID}` },
        REVIEWED,
      ],
    ]
    for (const [label, answers, params] of cases) {
      const { outcome, calls, files } = await land(answers, { ...params, setupAutoDelete: true })
      if (outcome.ok) throw new Error(`${label}: expected a refusal`)
      expect({ label, settings: calls.filter((call) => settingsCall(call.argv)).map((call) => call.argv) }).toEqual({
        label,
        settings: [],
      })
      expect(files()).toHaveLength(0)
    }
  })

  test("a squash merge with no pull request title refuses before merging", async () => {
    for (const title of ["", "   ", null]) {
      const { outcome, calls, files } = await land({ prView: [completed(githubPr({ title }))] }, REVIEWED)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain("pr.title")
      expect(outcome.reason).toContain("no merge was issued")
      expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
      expect(files()).toHaveLength(0)
    }
  })

  test("a title spelled like an option stays the --subject operand", async () => {
    const { outcome, calls } = await land(
      { prView: [completed(githubPr({ title: "--admin" })), completed(mergedGithubPr())] },
      REVIEWED,
    )

    expect(outcome.ok).toBe(true)
    const merge = calls.find((call) => merged(call.argv))?.argv ?? []
    expect(merge[merge.indexOf("--subject") + 1]).toBe("--admin")
    expect(merge.filter((part) => part === "--admin")).toHaveLength(1)
  })

  /**
   * The hung forge call is a real process that records its pid and waits.
   * The interrupt must kill it and return, instead of holding the session for the
   * forge timeout, and nothing may be merged or written after it.
   */
  test("an interrupt kills a hung forge call and lands nothing", async () => {
    const canonical = realpathSync(temporaryDirectory("delivery-land-abort-"))
    git(canonical, ["init", "-q", "-b", "main"])
    git(canonical, ["remote", "add", "origin", REMOTE_URL])
    const bin = temporaryDirectory("delivery-land-bin-")
    const pidFile = join(bin, "gh.pid")
    // Invoke a script through an existing executable, not a freshly scanned
    // shebang. The marker is published by the process we will actually kill.
    const stub = join(bin, "gh.mjs")
    writeFileSync(
      stub,
      `import { writeFileSync, renameSync } from "node:fs";\nwriteFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));\nrenameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});\nsetInterval(() => {}, 1000);\n`,
    )
    const receipts = temporaryDirectory("delivery-land-receipts-")
    const controller = new AbortController()
    const pending = landPullRequest(
      { pr: 470, ...REVIEWED },
      {
        cwd: canonical,
        now: () => NOW,
        receiptsDirectory: receipts,
        run: (argv, options) => runCli(argv[0] === "gh" ? [process.execPath, stub] : argv, options),
        signal: controller.signal,
      },
    )
    try {
      await Promise.race([appeared(pidFile, controller.signal), pending])
      expect(existsSync(pidFile)).toBe(true)
      const pid = Number(readFileSync(pidFile, "utf8").trim())
      expect(() => process.kill(pid, 0)).not.toThrow()
      controller.abort()
      const outcome = await pending

      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain("gh pr view 470")
      expect(outcome.reason).toContain("abort")
      expect(() => process.kill(pid, 0)).toThrow()
      expect(readdirSync(receipts)).toEqual([])
    } finally {
      controller.abort()
      await pending
    }
  }, 60_000)
})

const porcelain = (...records: Array<{ path: string; head: string; branch?: string; extra?: string }>): string =>
  records
    .map(
      (record) =>
        `worktree ${record.path}\nHEAD ${record.head}\n${record.branch === undefined ? "detached" : `branch refs/heads/${record.branch}`}\n${record.extra ?? ""}`,
    )
    .join("\n")

describe("choosing the remote and worktree of a landing", () => {
  test.each([
    ["origin wins over an earlier match", [{ name: "fork", path: "a/b" }, { name: "origin", path: "a/b" }], "a/b", "origin"],
    ["a non-origin remote is chosen when it alone matches", [{ name: "origin", path: "x/y" }, { name: "upstream", path: "a/b" }], "a/b", "upstream"],
    ["no remote names the repository", [{ name: "origin", path: "x/y" }], "a/b", null],
    ["a remote naming no repository never matches", [{ name: "origin", path: null }], "a/b", null],
  ] as const)("selectRemoteForRepo: %s", (_name, remotes, repo, expected) => {
    expect(selectRemoteForRepo(remotes, repo)).toBe(expected)
  })

  const main = { path: "/r", head: BASE_OID, branch: "main" }
  test.each([
    ["the linked worktree holding the branch at the head", [main, { path: "/r/wt", head: HEAD_OID, branch: BRANCH }], "/r/wt"],
    ["the head compared case-insensitively", [main, { path: "/r/wt", head: HEAD_OID.toUpperCase(), branch: BRANCH }], "/r/wt"],
    ["none when the branch moved past the head", [main, { path: "/r/wt", head: BASE_OID, branch: BRANCH }], null],
    ["none when the branch is only in the main worktree", [{ path: "/r", head: HEAD_OID, branch: BRANCH }], null],
    ["none when the worktree is detached", [main, { path: "/r/wt", head: HEAD_OID }], null],
    ["none when the worktree is prunable", [main, { path: "/r/wt", head: HEAD_OID, branch: BRANCH, extra: "prunable gone" }], null],
    ["none when another branch is checked out", [main, { path: "/r/wt", head: HEAD_OID, branch: "other" }], null],
  ] as const)("inferWorktree: %s", (_name, records, expected) => {
    expect(inferWorktree(parseWorktreeList(porcelain(...records)), BRANCH, HEAD_OID)).toBe(expected)
  })

  test("resolveLandingTarget picks the remote that names an explicit repo", async () => {
    const { canonical } = repository()
    const git = async (argv: readonly string[]): Promise<string | null> => {
      const command = argv.join(" ")
      if (argv[0] === "rev-parse") return `${join(canonical, ".git")}\n${canonical}\n`
      if (command === "remote") return "origin\nupstream\n"
      if (command === "remote get-url origin") return "https://github.com/srobroek/slopvac.git\n"
      if (command === "remote get-url upstream") return `${REMOTE_URL}\n`
      return null
    }
    const resolved = await resolveLandingTarget({ repo: "srobroek/omp-plugins" }, git, canonical, {})
    if ("reason" in resolved) throw new Error(resolved.reason)
    expect(resolved).toMatchObject({ remote: "upstream", nameWithOwner: "srobroek/omp-plugins" })
  })

  test("an explicit remote is never replaced by a matching one", async () => {
    const { canonical } = repository()
    const git = async (argv: readonly string[]): Promise<string | null> => {
      if (argv[0] === "rev-parse") return `${join(canonical, ".git")}\n${canonical}\n`
      if (argv.join(" ") === "remote get-url origin") return "https://github.com/srobroek/slopvac.git\n"
      return null
    }
    const resolved = await resolveLandingTarget({ repo: "srobroek/omp-plugins", remote: "origin" }, git, canonical, {})
    expect("reason" in resolved && resolved.reason).toContain("from remote origin")
  })

  /** One landing in a fresh session repository whose answers may depend on its path. */
  async function landInSession(
    build: (canonical: string) => { answers: Answers; params?: Partial<LandParams>; sleep?: boolean },
  ) {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    const { answers, params, sleep } = build(canonical)
    const { run, calls } = runner(answers, canonical)
    rawGitArgv.length = 0
    const outcome = await landPullRequest(
      { pr: 470, ...params },
      {
        run,
        cwd: canonical,
        now: () => NOW,
        receiptsDirectory: receipts,
        env: {},
        ...(sleep === true ? { sleep: async () => {} } : {}),
      },
    )
    return { outcome, calls, canonical }
  }

  test("delivery_land records the linked worktree that holds the PR branch at its head", async () => {
    let wt = ""
    const { outcome } = await landInSession((canonical) => {
      wt = linkedWorktree(canonical, "wt")
      return {
        answers: {
          prView: [completed(mergedGithubPr())],
          worktrees: porcelain(
            { path: canonical, head: BASE_OID, branch: "main" },
            { path: wt, head: HEAD_OID, branch: BRANCH },
          ),
        },
      }
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.worktree.path).toBe(wt)
  })

  test("delivery_land records no worktree when none holds the head", async () => {
    const { outcome } = await landInSession((canonical) => ({
      answers: {
        prView: [completed(mergedGithubPr())],
        worktrees: porcelain({ path: canonical, head: BASE_OID, branch: "main" }),
      },
    }))
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.worktree.path).toBeNull()
  })

  test("delivery_land records no worktree when the inferred one no longer holds the head", async () => {
    const { outcome } = await landInSession((canonical) => {
      const wt = linkedWorktree(canonical, "wt")
      return {
        answers: {
          prView: [completed(mergedGithubPr())],
          worktreeHead: completed(`${BASE_OID}\n`),
          worktrees: porcelain(
            { path: canonical, head: BASE_OID, branch: "main" },
            { path: wt, head: HEAD_OID, branch: BRANCH },
          ),
        },
      }
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.worktree.path).toBeNull()
  })

  test("delivery_land records no inferred worktree whose .git is a link into another repository", async () => {
    const foreign = repository()
    const { outcome, calls } = await landInSession((canonical) => {
      const wt = linkedWorktree(canonical, "wt")
      rmSync(join(wt, ".git"))
      symlinkSync(join(foreign.canonical, ".git"), join(wt, ".git"))
      return {
        answers: {
          prView: [completed(mergedGithubPr())],
          worktrees: porcelain(
            { path: canonical, head: BASE_OID, branch: "main" },
            { path: wt, head: HEAD_OID, branch: BRANCH },
          ),
        },
      }
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.worktree.path).toBeNull()
    expect(calls.some((call) => call.argv.join(" ") === "git rev-parse --verify HEAD^{commit}")).toBe(false)
  })

  test("an explicit worktree of the session repository is recorded, and Git is pinned to it", async () => {
    let wt = ""
    const { outcome, calls, canonical } = await landInSession((canonical) => {
      wt = linkedWorktree(canonical, "wt")
      return { answers: { prView: [completed(mergedGithubPr())] }, params: { worktree: wt } }
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.worktree.path).toBe(wt)
    const head = calls.find((call) => call.argv.join(" ") === "git rev-parse --verify HEAD^{commit}")
    expect(head?.env?.GIT_DIR).toBe(join(realpathSync(canonical), ".git", "worktrees", "wt"))
    expect(head?.env?.GIT_WORK_TREE).toBe(realpathSync(wt))
    expect(head?.env?.GIT_COMMON_DIR).toBe(join(realpathSync(canonical), ".git"))
  })

  describe("a target outside the session repository is refused before Git runs there", () => {
    /** Each way a `worktree` can fail to belong to the session repository. */
    const foreignTargets: Array<[string, (canonical: string, foreign: { canonical: string }) => string]> = [
      ["a checkout of another repository", (_c, foreign) => foreign.canonical],
      [
        "a .git symlink to another repository",
        (_c, foreign) => {
          const dir = temporaryDirectory("delivery-land-link-")
          symlinkSync(join(foreign.canonical, ".git"), join(dir, ".git"))
          return dir
        },
      ],
      [
        "a .git file naming another repository's worktree admin directory",
        (_c, foreign) => {
          const dir = temporaryDirectory("delivery-land-file-")
          const admin = join(foreign.canonical, ".git", "worktrees", "x")
          mkdirSync(admin, { recursive: true })
          writeFileSync(join(admin, "commondir"), "../..\n")
          writeFileSync(join(dir, ".git"), `gitdir: ${admin}\n`)
          return dir
        },
      ],
      [
        "a .git file whose commondir is a FIFO",
        (canonical) => {
          const dir = linkedWorktree(canonical, "fifo")
          const commondir = join(canonical, ".git", "worktrees", "fifo", "commondir")
          rmSync(commondir)
          Bun.spawnSync(["mkfifo", commondir])
          return dir
        },
      ],
      ["an existing directory that is not a checkout", () => temporaryDirectory("delivery-land-plain-")],
    ]

    test.each(foreignTargets)("%s", async (_name, make) => {
      const foreign = repository()
      const spawns = gitSpawnLog()
      let target = ""
      let outcome: Awaited<ReturnType<typeof landPullRequest>>
      let calls: Call[] = []
      try {
        const landed = await landInSession((canonical) => {
          target = make(canonical, foreign)
          return { answers: { prView: [completed(mergedGithubPr())] }, params: { worktree: target } }
        })
        outcome = landed.outcome
        calls = landed.calls
      } finally {
        spawns.restore()
      }
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.reason).toContain("run delivery_land from a session in the pull request's repository")
      expect(outcome.reason).toContain("no Git ran there")
      expect(calls.filter((call) => call.cwd === target)).toEqual([])
      expect(calls.filter((call) => call.argv.includes("merge"))).toEqual([])
      // The whole log, not only entries found in the target: every Git read here is scripted,
      // so any process that started bypassed the runner.
      expect(spawns.log()).toEqual([])
    }, 20_000)
  })

  test("a worktree that does not exist is refused before any forge read or Git read there", async () => {
    const missing = join(temporaryDirectory("delivery-land-missing-"), "not-yet")
    const spawns = gitSpawnLog()
    let outcome: Awaited<ReturnType<typeof landPullRequest>>
    let calls: Call[] = []
    try {
      const landed = await landInSession(() => ({
        answers: { prView: [completed(mergedGithubPr())] },
        params: { worktree: missing },
      }))
      outcome = landed.outcome
      calls = landed.calls
    } finally {
      spawns.restore()
    }
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("not an existing checkout")
    expect(outcome.reason).toContain("no Git ran there")
    // Nothing was read from the forge either, so a repository created at the path after this
    // point is never entered: there is no later read to enter it.
    expect(calls.filter((call) => call.argv[0] === "gh")).toEqual([])
    expect(calls.filter((call) => call.cwd === missing)).toEqual([])
    // The whole log, not only entries found at the path: every Git read here is scripted.
    expect(spawns.log()).toEqual([])
  })

  test("a repo of another repository is refused with the session-repository instruction", async () => {
    const { outcome, calls } = await landInSession(() => ({
      answers: { prView: [completed(mergedGithubPr())] },
      params: { repo: "someone/else" },
    }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("run delivery_land from a session in that repository")
    expect(calls.filter((call) => call.argv[0] === "gh")).toEqual([])
  })

  test("local Git reads carry the literal options and lazy fetch is off; only the fetch uses the network", async () => {
    const { outcome } = await landInSession(() => ({
      answers: { prView: [completed(mergedGithubPr())], present: [false, true] },
      sleep: true,
    }))
    if (!outcome.ok) throw new Error(outcome.reason)
    const probes = rawGitArgv.filter((argv) => argv.includes("ls-remote"))
    const fetches = rawGitArgv.filter((argv) => argv.includes("fetch"))
    const reads = rawGitArgv.filter((argv) => !probes.includes(argv) && !fetches.includes(argv))
    expect(reads.length).toBeGreaterThan(0)
    const literal = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-optional-locks"]
    for (const argv of reads) expect(argv.slice(0, 1 + literal.length)).toEqual(["git", ...literal])
    expect(fetches).toHaveLength(1)
    expect(fetches[0]).toContain("core.fsmonitor=false")
    expect(fetches[0]).toContain("core.hooksPath=/dev/null")
    const shows = reads.filter((argv) => argv.includes("show"))
    expect(shows.length).toBeGreaterThan(0)
    for (const argv of shows) expect(argv).toContain("log.showSignature=false")
    // No command that could run a clean or smudge filter (status, diff, checkout, add, ...) is issued.
    const allowed = ["rev-parse", "remote", "worktree", "cat-file", "show", "fetch", "rev-list", "merge-base", "diff-tree", "patch-id", "merge-tree", "--version"]
    for (const argv of reads) expect(allowed.some((verb) => argv.includes(verb))).toBe(true)
  })

  test("local Git reads run with lazy fetch disabled", async () => {
    const { calls } = await landInSession(() => ({ answers: { prView: [completed(mergedGithubPr())] } }))
    const reads = calls.filter((call) => call.argv[0] === "git" && !call.argv.includes("ls-remote"))
    expect(reads.length).toBeGreaterThan(0)
    for (const call of reads) expect(call.env?.GIT_NO_LAZY_FETCH).toBe("1")
  })
})

describe("branch reading", () => {
  test("bead ids come from the agent branch convention and nowhere else", () => {
    expect(beadIdsFromBranch("omp/agent/omp-plugins-9ej3.5")).toEqual(["omp-plugins-9ej3.5"])
    expect(beadIdsFromBranch("opencode/agent/opencode-plugins-80h.4")).toEqual(["opencode-plugins-80h.4"])
    for (const branch of ["main", "omp/integration/omp-plugins-9ej3", "omp/agent/", "feature/omp/agent/x"]) {
      expect(beadIdsFromBranch(branch)).toEqual([])
    }
  })
})

describe("landing target resolution", () => {
  /** A Git read answering the repository observation and one remote URL, recording each argv. */
  function gitAnswering(remoteUrl: string): {
    git: (argv: readonly string[]) => Promise<string | null>
    reads: string[][]
    cwd: string
  } {
    const { canonical } = repository()
    const reads: string[][] = []
    const git = async (argv: readonly string[]): Promise<string | null> => {
      reads.push([...argv])
      if (argv[0] === "rev-parse") return `${join(canonical, ".git")}\n${canonical}\n`
      if (argv.join(" ") === "remote get-url origin") return `${remoteUrl}\n`
      return null
    }
    return { git, reads, cwd: canonical }
  }

  test("refuses an explicit identity before reading any repository state", async () => {
    const { git, reads, cwd } = gitAnswering(REMOTE_URL)
    const resolved = await resolveLandingTarget({ repo: "https://github.com/x/y" }, git, cwd, {})
    expect(resolved).toEqual({
      reason:
        'repo: observed "https://github.com/x/y", expected an unqualified "<owner>/<name>" or bounded GitLab "<group>/.../<project>" path',
    })
    expect(reads).toEqual([])
  })

  test("refuses a repo override that disagrees with the remote, naming both", async () => {
    const { git, cwd } = gitAnswering(REMOTE_URL)
    const resolved = await resolveLandingTarget({ repo: "someone/else" }, git, cwd, {})
    expect("reason" in resolved && resolved.reason).toBe(
      'repo: observed "someone/else", expected "srobroek/omp-plugins" from remote origin; the branch absence is verified against origin, so both must name one repository; to land a pull request of another repository, run delivery_land from a session in that repository',
    )
  })

  test("binds every forge command to the canonical host the remote names", async () => {
    const { git, reads, cwd } = gitAnswering("ssh://git@altssh.gitlab.com:443/group/sub/project.git")
    const resolved = await resolveLandingTarget({}, git, cwd, { PATH: "/bin" })
    if ("reason" in resolved) throw new Error(resolved.reason)
    expect(resolved).toMatchObject({
      remote: "origin",
      forge: "gitlab",
      nameWithOwner: "group/sub/project",
      cliRepo: "gitlab.com/group/sub/project",
    })
    expect({ ...resolved.forgeCommandEnv }).toEqual({
      PATH: "/bin",
      GITLAB_HOST: "gitlab.com",
      GITLAB_API_HOST: "gitlab.com",
    })
    expect(resolved.repository.canonicalRoot).toBe(realpathSync(cwd))
    expect(reads.map((argv) => argv[0])).toEqual(["rev-parse", "remote"])
  })
})

/**
 * The forge merges on its side, so the merge commit it names is not in the local
 * object store until something fetches it. Every one of these landings was refused
 * with `git show -s --format=%P <merge>: observed no completed read` before the
 * proof fetched what it reads — 29 times after this tool had just merged the request.
 */
describe("delivery_land brings the landed commits local before proving their shape", () => {
  /** Land with a recorded sleep, so the retry schedule is observed rather than waited out. */
  async function landWithFetch(answers: Answers, params: Partial<LandParams> = REVIEWED) {
    const { canonical, receipts } = repository()
    const { run, calls } = runner(answers, canonical)
    const slept: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms)
    }
    const outcome = await landPullRequest(
      { pr: 470, ...params },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {}, sleep },
    )
    return { outcome, calls, slept, canonical, receipts, run, files: () => readdirSync(receipts).filter((name) => !name.startsWith("pending-")) }
  }
  const fetches = (calls: Call[]): string[][] =>
    calls.filter((call) => call.argv[0] === "git" && call.argv.includes("fetch")).map((call) => call.argv)
  const operands = (argv: string[] | undefined): string[] =>
    argv === undefined ? [] : argv.slice(argv.indexOf("--upload-pack=git-upload-pack") + 1)

  test("a merge commit absent locally is fetched by id from the remote before git show reads it", async () => {
    const { outcome, calls, canonical, files } = await landWithFetch({
      prView: [completed(githubPr()), completed(mergedGithubPr())],
      present: [false, true],
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(fetches(calls).map(operands)).toEqual([["origin", MERGE_OID]])
    const order = calls.map((call) => call.argv.join(" "))
    const merge = order.findIndex((command) => command.startsWith("gh pr merge"))
    const fetch = order.findIndex((command) => command.includes(" fetch "))
    const show = order.findIndex((command) => command.startsWith("git -c log.showSignature=false show -s"))
    expect(merge).toBeGreaterThanOrEqual(0)
    expect(merge).toBeLessThan(fetch)
    expect(fetch).toBeLessThan(show)
    // From the landing's own repository, where the remote name resolves, with Git's
    // inherited controls stripped and prompting off.
    expect(calls[fetch]?.cwd).toBe(canonical)
    expect(calls[fetch]?.env?.GIT_TERMINAL_PROMPT).toBe("0")
    expect(outcome.receipt.proof.evidence).toMatchObject({
      localCommits: { required: [MERGE_OID, HEAD_OID], fetches: [expect.stringContaining(` fetch `)] },
    })
    expect(files()).toHaveLength(1)
  })

  test("a commit already present is not fetched", async () => {
    const { outcome, calls } = await landWithFetch({ prView: [completed(githubPr()), completed(mergedGithubPr())] })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(fetches(calls)).toEqual([])
    expect(outcome.receipt.proof.evidence).toMatchObject({ localCommits: { required: [MERGE_OID, HEAD_OID], fetches: [] } })
  })

  test("replication lag is retried on a bounded schedule, falling back to the base branch", async () => {
    const lagging = {
      ok: true,
      exitCode: 128,
      stdout: "",
      stderr: "fatal: remote error: upload-pack: not our ref",
    } as const
    const { outcome, calls, slept, files } = await landWithFetch({
      prView: [completed(githubPr()), completed(mergedGithubPr())],
      // Before any fetch, after the first id fetch, after the first branch fetch, after the second id fetch.
      present: [false, false, false, false, false, false, true, true],
      fetch: [lagging, completed("")],
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(fetches(calls).map(operands)).toEqual([
      ["origin", MERGE_OID, HEAD_OID],
      ["origin", "refs/heads/omp/integration/omp-plugins-9ej3"],
      ["origin", MERGE_OID, HEAD_OID],
    ])
    expect(slept).toEqual([0, 2_000])
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(1)
    expect(files()).toHaveLength(1)
  })

  test("a merged request whose commit never arrives refuses actionably, and the re-run proves it without merging again", async () => {
    const missing = { ok: true, exitCode: 128, stdout: "", stderr: "fatal: couldn't find remote ref" } as const
    const first = await landWithFetch({
      prView: [completed(githubPr()), completed(mergedGithubPr())],
      present: Array.from({ length: 20 }, () => false),
      fetch: [missing, missing, missing, missing, missing, missing],
    })

    expect(first.outcome.ok).toBe(false)
    if (first.outcome.ok) throw new Error("expected a refusal")
    expect(first.outcome.mergeIssued).toBe(true)
    expect(first.outcome.reason).toContain(`${MERGE_OID}, ${HEAD_OID} absent locally after 6 fetches from origin over 3 attempts`)
    expect(first.outcome.reason).toContain("no receipt was written")
    expect(first.outcome.reason).toContain("so the request is merged and must not be merged again")
    expect(first.outcome.reason).toContain(`re-run delivery_land with the same pr and expectHeadSha ${HEAD_OID}`)
    expect(first.slept).toEqual([0, 2_000, 5_000])
    expect(first.calls.filter((call) => merged(call.argv))).toHaveLength(1)
    expect(first.calls.some((call) => call.argv.includes("show"))).toBe(false)
    expect(first.files()).toHaveLength(0)

    // The re-run the refusal names: the forge now reports MERGED and the commit is local.
    const rerun = await landWithFetch({ prView: [completed(mergedGithubPr())] })
    expect(rerun.outcome.ok).toBe(true)
    if (!rerun.outcome.ok) throw new Error(rerun.outcome.reason)
    expect(rerun.calls.filter((call) => merged(call.argv))).toHaveLength(0)
    expect(rerun.outcome.receipt.pr.mergeCommitOid).toBe(MERGE_OID)
    expect(rerun.files()).toHaveLength(1)
  })

  test("an already MERGED request whose commit is missing names the safe re-run, not a merge", async () => {
    const { outcome, calls } = await landWithFetch({
      prView: [completed(mergedGithubPr())],
      present: Array.from({ length: 20 }, () => false),
      fetch: Array.from({ length: 6 }, () => ({ ok: true, exitCode: 128, stdout: "", stderr: "" })),
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.mergeIssued).toBeUndefined()
    expect(outcome.reason).toContain("already MERGED, so re-running delivery_land issues no merge")
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(0)
  })

  test("a rebase also fetches the reviewed head its patch ids are read from", async () => {
    const { canonical, receipts } = repository()
    const fixture = runner(
      { prView: [completed(githubPr()), completed(mergedGithubPr())], present: [false, false, true, true] },
      canonical,
    )
    // The patch-id comparison itself is proved against real commits above; here the
    // first read past the fetch fails, which is enough to show what was fetched.
    const run: CliRunner = (argv, options) => (argv[1] === "merge-base" ? completed("", 1) : fixture.run(argv, options))
    const outcome = await landPullRequest(
      { pr: 470, ...REVIEWED, merge_method: "rebase" },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {}, sleep: async () => {} },
    )
    expect(outcome.ok).toBe(false)
    expect(fetches(fixture.calls).map(operands)).toEqual([["origin", MERGE_OID, HEAD_OID]])
  })

  test("an abort while waiting to retry stops before the next fetch when no merge was issued here", async () => {
    const { canonical, receipts } = repository()
    const { run, calls } = runner(
      {
        prView: [completed(mergedGithubPr())],
        present: Array.from({ length: 20 }, () => false),
        fetch: [
          { ok: true, exitCode: 128, stdout: "", stderr: "" },
          { ok: true, exitCode: 128, stdout: "", stderr: "" },
        ],
      },
      canonical,
    )
    const controller = new AbortController()
    const sleep = async (ms: number): Promise<void> => {
      if (ms > 0) controller.abort()
    }
    const outcome = await landPullRequest(
      { pr: 470, ...REVIEWED },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {}, sleep, signal: controller.signal },
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected a refusal")
    expect(outcome.reason).toContain("signal: observed an abort while fetching")
    expect(outcome.mergeIssued).toBeUndefined()
    expect(fetches(calls)).toHaveLength(2)
  })

  test.each([false, true])("an abort during the merge still records the receipt and later commands run unsignalled (setupAutoDelete %p)", async (setupAutoDelete) => {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    const { run, calls } = runner({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, canonical)
    const controller = new AbortController()
    let afterMerge = false
    const seen: Array<AbortSignal | undefined> = []
    const aborting: CliRunner = (argv, options) => {
      if (afterMerge) seen.push(options.signal)
      if (merged(argv)) {
        afterMerge = true
        controller.abort()
      }
      return run(argv, options)
    }
    const outcome = await landPullRequest(
      { pr: 470, ...REVIEWED, ...(setupAutoDelete ? { setupAutoDelete } : {}) },
      { run: aborting, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {}, signal: controller.signal },
    )

    if (!outcome.ok) throw new Error(outcome.reason)
    expect(readdirSync(receipts)).toHaveLength(1)
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(1)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((signal) => signal === undefined)).toBe(true)
  })

  test("an abort during the merge does not stop the fetch of a base tip that is missing locally", async () => {
    const { canonical, receipts } = repository()
    const { run, calls } = runner({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, canonical)
    const controller = new AbortController()
    let tipFetched = false
    const aborting: CliRunner = (argv, options) => {
      if (merged(argv)) controller.abort()
      // The base moved on after the merge: its tip is absent until it is fetched by id.
      if (argv.includes("cat-file") && argv.some((part) => part.startsWith(TIP_OID)) && !tipFetched) {
        return completed("", 1, "fatal: not a commit")
      }
      if (argv.includes("fetch") && argv.includes(TIP_OID)) {
        // A fetch that still carries the cancelled signal is what the real runner refuses.
        if (options.signal?.aborted === true) return { ok: false, exitCode: null, stdout: "", stderr: "", error: "aborted" }
        tipFetched = true
      }
      return run(argv, options)
    }
    const outcome = await landPullRequest(
      { pr: 470, ...REVIEWED },
      { run: aborting, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: {}, sleep: async () => {}, signal: controller.signal },
    )

    if (!outcome.ok) throw new Error(outcome.reason)
    expect(tipFetched).toBe(true)
    expect(fetches(calls).map(operands)).toContainEqual(["origin", TIP_OID])
    expect(readdirSync(receipts)).toHaveLength(1)
  })

  test("without a signal a clean land behaves as before", async () => {
    const { outcome } = await land({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, REVIEWED)
    expect(outcome.ok).toBe(true)
  })

  test("against real Git, a squash the forge landed on the remote is fetched and proved", async () => {
    const forge = realpathSync(temporaryDirectory("delivery-land-forge-"))
    const local = realpathSync(temporaryDirectory("delivery-land-local-"))
    const upstream = join(forge, "upstream")
    git(forge, ["init", "-q", "--bare", "-b", "main", "remote.git"])
    git(forge, ["clone", "-q", join(forge, "remote.git"), upstream])
    commitFile(upstream, "base.txt", "base\n", "base")
    git(upstream, ["push", "-q", "origin", "main"])
    git(local, ["clone", "-q", join(forge, "remote.git"), "checkout"])
    const checkout = join(local, "checkout")
    git(checkout, ["checkout", "-q", "-b", BRANCH])
    commitFile(checkout, "feature.txt", "feature\n", "feature")
    const head = git(checkout, ["rev-parse", "HEAD"])
    // The forge squashes the reviewed change onto main; the local clone never fetches it.
    commitFile(upstream, "feature.txt", "feature\n", TITLE)
    git(upstream, ["push", "-q", "origin", "main"])
    const squash = git(upstream, ["rev-parse", "HEAD"])
    expect(Bun.spawnSync(["git", "cat-file", "-e", `${squash}^{commit}`], { cwd: checkout }).exitCode).not.toBe(0)

    const fixture = runner(
      {
        prView: [
          completed(githubPr({ headRefOid: head, baseRefName: "main" })),
          completed(mergedGithubPr({ headRefOid: head, baseRefName: "main", mergeCommit: { oid: squash } })),
        ],
      },
      checkout,
    )
    const run: CliRunner = (argv, options) => {
      if (argv[0] !== "git" || argv[1] === "remote" || (argv.includes("ls-remote") && !argv.includes("refs/heads/main"))) return fixture.run(argv, options)
      fixture.calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env })
      return runCli(argv, options)
    }
    const receipts = temporaryDirectory("delivery-land-receipts-")
    const outcome = await landPullRequest(
      { pr: 470, expectHeadSha: head },
      {
        run,
        cwd: checkout,
        now: () => NOW,
        receiptsDirectory: receipts,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: forge },
        sleep: async () => {},
      },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.pr.mergeCommitOid).toBe(squash)
    expect(outcome.receipt.proof.evidence).toMatchObject({
      mergeShape: { parents: [git(upstream, ["rev-parse", "HEAD^"])] },
    })
    expect(fetches(fixture.calls).map(operands)).toEqual([["origin", squash]])
    // Objects only: no ref and no FETCH_HEAD moved in the checkout.
    expect(git(checkout, ["rev-parse", "origin/main"])).toBe(git(upstream, ["rev-parse", "HEAD^"]))
    expect(existsSync(join(checkout, ".git", "FETCH_HEAD"))).toBe(false)
    expect(readdirSync(receipts)).toHaveLength(1)
  }, 60_000)
})

/** ssh.gitlab.aws.dev is git-over-SSH only; the API and the CLI live at gitlab.aws.dev. */
describe("delivery_land on gitlab.aws.dev", () => {
  test("a remote on ssh.gitlab.aws.dev lands through the gitlab.aws.dev API host", async () => {
    const { canonical, receipts } = repository()
    const { run, calls } = runner(
      {
        remoteUrl: "git@ssh.gitlab.aws.dev:sjors/cde-builderproject.git",
        prView: [
          completed(
            gitlabMr({
              state: "opened",
              merge_commit_sha: null,
              web_url: "https://gitlab.aws.dev/sjors/cde-builderproject/-/merge_requests/12",
            }),
          ),
          completed(gitlabMr({ web_url: "https://gitlab.aws.dev/sjors/cde-builderproject/-/merge_requests/12" })),
        ],
        autoDelete: completed(JSON.stringify({ remove_source_branch_after_merge: true })),
      },
      canonical,
    )
    const outcome = await landPullRequest(
      { pr: 12, ...REVIEWED, setupAutoDelete: true },
      { run, cwd: canonical, now: () => NOW, receiptsDirectory: receipts, env: { GITLAB_HOST: "gitlab.com" } },
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.repo).toMatchObject({ forge: "gitlab", nameWithOwner: "sjors/cde-builderproject" })
    const glab = calls.filter((call) => call.argv[0] === "glab")
    expect(glab.length).toBeGreaterThanOrEqual(5)
    for (const call of glab) {
      if (call.argv.includes("--repo"))
        expect(call.argv[call.argv.indexOf("--repo") + 1]).toBe("gitlab.aws.dev/sjors/cde-builderproject")
      if (call.argv.includes("--hostname"))
        expect(call.argv[call.argv.indexOf("--hostname") + 1]).toBe("gitlab.aws.dev")
      expect(call.argv.join(" ")).not.toContain("ssh.gitlab.aws.dev")
      expect(call.argv.join(" ")).not.toContain("gitlab.com")
      expect(call.env?.GITLAB_HOST).toBe("gitlab.aws.dev")
      expect(call.env?.GITLAB_API_HOST).toBe("gitlab.aws.dev")
    }
    expect(glab.filter((call) => call.argv[1] === "api").map((call) => call.argv.slice(0, 6))).toEqual([
      ["glab", "api", "projects/sjors%2Fcde-builderproject", "--hostname", "gitlab.aws.dev"],
      ["glab", "api", "-X", "PUT", "projects/sjors%2Fcde-builderproject", "--hostname"],
    ])
  })
})

// Last in the file: bun runs a file's tests in order, so every fixture above exists by now.
describe("delivery_land approval and checks preconditions", () => {
  const approvedReview = (oid: string) =>
    completed(
      JSON.stringify({
        author: { login: "author" },
        reviews: [{ state: "APPROVED", author: { login: "reviewer" }, commit: { oid } }],
        comments: [],
      }),
    )
  const greenChecks = completed(JSON.stringify([{ name: "ci", state: "SUCCESS", bucket: "pass" }]))
  const open = { prView: [completed(githubPr()), completed(mergedGithubPr())] }

  test("an approval for the exact head and green checks let the merge through, recorded as evidence", async () => {
    const { outcome, calls } = await land(
      { ...open, approval: approvedReview(HEAD_OID), checks: greenChecks },
      { ...REVIEWED, requireApproval: true, requireGreenChecks: true },
    )
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(calls.filter((call) => merged(call.argv))).toHaveLength(1)
    expect(outcome.receipt.proof.evidence.preconditions).toEqual({
      approval: { kind: "review", reviewer: "reviewer", commit: HEAD_OID },
      checks: { checks: 1 },
    })
    const approvalRead = calls.find((call) => call.argv.includes("author,reviews,comments"))
    expect(approvalRead?.argv).toContain("github.com/srobroek/omp-plugins")
  })

  test("an approval for an older head refuses before the merge", async () => {
    const { outcome, calls, files } = await land(
      { ...open, approval: approvedReview(BASE_OID) },
      { ...REVIEWED, requireApproval: true },
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain(`none for head ${HEAD_OID}`)
    expect(outcome.reason).toContain("no merge was issued")
    expect(calls.some((call) => merged(call.argv))).toBe(false)
    expect(files()).toEqual([])
  })

  test("a failing check refuses before the merge, even though gh exits non-zero", async () => {
    const red = completed(JSON.stringify([{ name: "ci", state: "FAILURE", bucket: "fail" }]), 1)
    const { outcome, calls } = await land({ ...open, checks: red }, { ...REVIEWED, requireGreenChecks: true })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain("ci=fail")
    expect(calls.some((call) => merged(call.argv))).toBe(false)
  })

  test("an already MERGED request is proved without reading approvals or checks", async () => {
    const { outcome, calls } = await land(
      { prView: [completed(mergedGithubPr())] },
      { requireApproval: true, requireGreenChecks: true },
    )
    expect(outcome.ok).toBe(true)
    expect(calls.some((call) => call.argv.includes("author,reviews,comments") || call.argv[2] === "checks")).toBe(false)
  })

  test("authorize sees the resource before any write, and a refusal writes nothing", async () => {
    const { canonical, receipts } = repository()
    mkdirSync(join(canonical, ".beads"))
    const { run, calls } = runner(open, canonical)
    const seen: unknown[] = []
    const denied = landPullRequest(
      { pr: 470, ...REVIEWED },
      {
        run,
        cwd: canonical,
        now: () => NOW,
        receiptsDirectory: receipts,
        env: {},
        authorize: async (request) => {
          seen.push(request)
          throw new Error("rejected")
        },
      },
    )
    await expect(denied).rejects.toThrow("rejected")
    expect(seen).toEqual([
      {
        resource: "srobroek/omp-plugins#470",
        forge: "github",
        head: HEAD_OID,
        merge: "squash",
        setupAutoDelete: false,
      },
    ])
    expect(calls.some((call) => merged(call.argv))).toBe(false)
    expect(readdirSync(receipts)).toEqual([])
  })
})

describe("delivery_land through a GitHub merge queue", () => {
  /** The queue's own commit on its integration branch: never the pull request's head. */
  const INTEGRATION_OID = "9999999999999999999999999999999999999999"
  const queueRules = (method = "SQUASH"): CliResult =>
    completed(
      JSON.stringify([
        { type: "pull_request", parameters: {} },
        { type: "merge_queue", parameters: { merge_method: method } },
      ]),
    )
  const snapshot = (
    state: "OPEN" | "MERGED" | "CLOSED",
    entry: { state: string; position: number } | null,
    overrides: { head?: string; number?: number; repository?: string; base?: string; id?: string } = {},
  ): CliResult =>
    completed(
      JSON.stringify({
        data: {
          repository: {
            nameWithOwner: overrides.repository ?? "srobroek/omp-plugins",
            pullRequest: {
              id: overrides.id ?? "PR_node_470",
              number: overrides.number ?? 470,
              baseRefName: overrides.base ?? "omp/integration/omp-plugins-9ej3",
              state,
              headRefOid: overrides.head ?? HEAD_OID,
              // The queue's integration commit; the tool must never read it as the PR head.
              mergeQueueEntry:
                entry === null ? null : { ...entry, headCommit: { oid: INTEGRATION_OID } },
            },
          },
        },
      }),
    )
  const queued = { state: "QUEUED", position: 1 }
  const enqueued = completed(
    JSON.stringify({
      data: {
        enqueuePullRequest: {
          mergeQueueEntry: { state: "QUEUED", position: 1, headCommit: { oid: INTEGRATION_OID } },
        },
      },
    }),
  )
  const isGraphql = (argv: string[]): boolean => argv[1] === "api" && argv[2] === "graphql"
  const isEnqueue = (argv: string[]): boolean =>
    isGraphql(argv) && argv.some((part) => part.startsWith("query=mutation"))
  const merges = (calls: Call[]): Call[] => calls.filter((call) => call.argv[1] === "pr" && call.argv[2] === "merge")
  const enqueues = (calls: Call[]): Call[] => calls.filter((call) => isEnqueue(call.argv))
  const slept: number[] = []
  const sleep = async (ms: number): Promise<void> => {
    slept.push(ms)
  }
  const inQueue = (answers: Answers, params: Partial<LandParams> = {}, extra: Partial<LandDeps> = {}) => {
    slept.length = 0
    return land(
      { rules: queueRules(), enqueue: enqueued, ...answers },
      { ...REVIEWED, ...params },
      {},
      { sleep, ...extra },
    )
  }

  test("a base branch without a queue rule merges directly and never touches the queue", async () => {
    const { outcome, calls } = await land({ prView: [completed(githubPr()), completed(mergedGithubPr())] }, REVIEWED)
    expect(outcome.ok).toBe(true)
    expect(merges(calls)).toHaveLength(1)
    expect(calls.some((call) => isGraphql(call.argv))).toBe(false)
  })

  test("a 404 from the rules API on a readable repository means no queue, and merges directly", async () => {
    const { outcome, calls } = await land(
      {
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        rules: completed("", 1, "gh: Not Found (HTTP 404)"),
      },
      REVIEWED,
    )
    expect(outcome.ok).toBe(true)
    expect(merges(calls)).toHaveLength(1)
    expect(calls.some((call) => call.argv.some((part) => part.includes("mergeQueue(branch")))).toBe(true)
    expect(calls.some((call) => call.argv.some((part) => part.includes("/rulesets")))).toBe(true)
  })

  test("a 404 whose mergeQueue read finds a queue refuses instead of merging directly", async () => {
    const { outcome, calls } = await land(
      {
        prView: [completed(githubPr())],
        rules: completed("", 1, "gh: Not Found (HTTP 404)"),
        mergeQueueProbe: completed(
          JSON.stringify({ data: { repository: { nameWithOwner: "srobroek/omp-plugins", mergeQueue: { id: "MQ_1" } } } }),
        ),
      },
      REVIEWED,
    )
    expect(reasonOf(outcome)).toContain("expected an explicit null")
    expect(merges(calls)).toEqual([])
  })

  test("a 404 whose mergeQueue read omits the field refuses", async () => {
    const { outcome, calls } = await land(
      {
        prView: [completed(githubPr())],
        rules: completed("", 1, "gh: Not Found (HTTP 404)"),
        mergeQueueProbe: completed(JSON.stringify({ data: { repository: { nameWithOwner: "srobroek/omp-plugins" } } })),
      },
      REVIEWED,
    )
    expect(reasonOf(outcome)).toContain("expected an explicit null")
    expect(merges(calls)).toEqual([])
  })

  test("a 404 whose rulesets list is unreadable refuses even though the repository reads", async () => {
    const { outcome, calls } = await land(
      {
        prView: [completed(githubPr())],
        rules: completed("", 1, "gh: Not Found (HTTP 404)"),
        rulesets: completed("", 1, "HTTP 403"),
      },
      REVIEWED,
    )
    expect(reasonOf(outcome)).toContain("readable rulesets list")
    expect(merges(calls)).toEqual([])
  })

  test("a 404 from the rules API that the rule-specific reads do not explain refuses", async () => {
    const { outcome, calls } = await land(
      {
        prView: [completed(githubPr())],
        rules: completed("", 1, "gh: Not Found (HTTP 404)"),
        rulesets: completed("", 1, "gh: Not Found (HTTP 404)"),
      },
      REVIEWED,
    )
    expect(reasonOf(outcome)).toContain("not taken as \"no merge queue\"")
    expect(merges(calls)).toEqual([])
  })

  const PLAN_GATE = "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)"

  test("a plan-gated rules read means no merge queue is possible, so it merges directly and says why", async () => {
    const { outcome, calls, files } = await land(
      { prView: [completed(githubPr()), completed(mergedGithubPr())], rules: completed("", 1, PLAN_GATE) },
      REVIEWED,
    )

    if (!outcome.ok) throw new Error(outcome.reason)
    expect(merges(calls)).toHaveLength(1)
    expect(enqueues(calls)).toEqual([])
    expect(outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "squash" })
    expect(JSON.stringify(outcome.receipt)).toContain("plan-gated")
    expect(files()).toHaveLength(1)
  })

  test.each([
    ["a 403 with another message", "gh: Resource not accessible by personal access token (HTTP 403)"],
    ["a 403 with no message", "gh: HTTP 403"],
    ["the plan-gate message with a 500 status", "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 500)"],
    ["the plan-gate message and no status", "gh: Upgrade to GitHub Pro or make this repository public to enable this feature."],
    ["a 5xx", "gh: Bad Gateway (HTTP 502)"],
  ])("%s refuses instead of assuming a direct merge", async (_name, stderr) => {
    const { outcome, calls } = await inQueue({ prView: [completed(githubPr())], rules: completed("", 1, stderr) })

    expect(reasonOf(outcome)).toContain("whether the branch requires a merge queue")
    expect(merges(calls)).toEqual([])
    expect(enqueues(calls)).toEqual([])
  })

  test.each([
    ["a non-object element", ["pull_request"]],
    ["an element without a type", [{ parameters: {} }]],
    ["a non-string type", [{ type: 7 }]],
  ])("a rules response with %s refuses and never falls through to a direct merge", async (_name, rules) => {
    const { outcome, calls } = await inQueue({
      prView: [completed(githubPr())],
      rules: completed(JSON.stringify(rules)),
    })
    expect(reasonOf(outcome)).toContain("rules: observed element 0")
    expect(merges(calls)).toEqual([])
    expect(enqueues(calls)).toEqual([])
  })

  test("a squash queue enqueues the reviewed head, waits, proves the commit is on base, and writes the receipt", async () => {
    const { outcome, calls, files } = await inQueue({
      prView: [completed(githubPr()), completed(mergedGithubPr())],
      queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("OPEN", queued), snapshot("MERGED", null)],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(enqueues(calls)).toHaveLength(1)
    expect(enqueues(calls)[0]?.argv).toContain(`head=${HEAD_OID}`)
    expect(enqueues(calls)[0]?.argv).toContain("id=PR_node_470")
    expect(enqueues(calls)[0]?.argv.join(" ")).toContain("expectedHeadOid: $head")
    expect(merges(calls)).toEqual([])
    expect(calls.some((call) => call.argv.includes("--auto"))).toBe(false)
    const compare = calls.find((call) => call.argv.some((part) => part.includes("/compare/")))
    expect(compare?.argv[2]).toBe(
      `repos/srobroek/omp-plugins/compare/${MERGE_OID}...omp/integration/omp-plugins-9ej3?per_page=1`,
    )
    expect(slept).toEqual([5_000])
    expect(files()).toHaveLength(1)
    expect(outcome.receipt.pr.headRefOid).toBe(HEAD_OID)
    expect(outcome.receipt.pr.mergeCommitOid).toBe(MERGE_OID)
    expect(outcome.receipt.proof.evidence).toMatchObject({
      mergeMethod: "squash",
      queue: { rule: "merge_queue", method: "squash" },
    })
  })

  test("a squash queue's commit may have any single parent, as when a grouped entry follows another", async () => {
    const { outcome } = await inQueue({
      prView: [completed(githubPr()), completed(mergedGithubPr())],
      queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
      parents: INTEGRATION_OID,
    })
    expect(outcome.ok).toBe(true)
  })

  test("a squash queue refuses a two-parent commit, and the PR is reported as merged for a retry", async () => {
    const { outcome, files } = await inQueue({
      prView: [completed(githubPr()), completed(mergedGithubPr())],
      queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
      parents: `${BASE_OID} ${HEAD_OID}`,
    })
    expect(reasonOf(outcome)).toContain('merge_method "squash": observed 2 parents')
    expect(outcome.ok === false && outcome.mergeIssued).toBe(true)
    expect(files()).toEqual([])
  })

  test("a merge queue lands a merge commit whose second parent is the queue's, with the reviewed head inside it", async () => {
    const { outcome, calls } = await inQueue({
      rules: queueRules("MERGE"),
      prView: [completed(githubPr()), completed(mergedGithubPr())],
      queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
      parents: `${BASE_OID} ${INTEGRATION_OID}`,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "merge", queue: { method: "merge" } })
    expect(calls.some((call) => call.argv.includes("--is-ancestor") && call.argv.includes(HEAD_OID))).toBe(true)
    expect(merges(calls)).toEqual([])
  })

  test("a merge queue refuses a merge commit that does not contain the reviewed head", async () => {
    const { outcome, files } = await inQueue({
      rules: queueRules("MERGE"),
      prView: [completed(githubPr()), completed(mergedGithubPr())],
      queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
      parents: `${BASE_OID} ${INTEGRATION_OID}`,
      ancestor: completed("", 1),
    })
    expect(reasonOf(outcome)).toContain("not an ancestor of the queue's merge commit")
    expect(files()).toEqual([])
  })

  test("a rebase queue proves the landed commits by patch id and lands without a direct merge", async () => {
    const repo = rebasedRepository("clean")
    const { outcome, calls, files } = await landRebase(repo, {
      rules: queueRules("REBASE"),
      enqueue: enqueued,
      queueStates: [snapshot("OPEN", null, { head: repo.head }), snapshot("OPEN", null, { head: repo.head }), snapshot("MERGED", null, { head: repo.head })],
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "rebase", queue: { method: "rebase" } })
    expect(enqueues(calls)).toHaveLength(1)
    expect(merges(calls)).toEqual([])
    expect(files()).toHaveLength(1)
  }, 60_000)

  test("a merge commit the base branch does not contain is not proof", async () => {
    const { outcome, files } = await inQueue({
      prView: [completed(githubPr()), completed(mergedGithubPr())],
      queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
      compare: completed("diverged\n"),
    })
    expect(reasonOf(outcome)).toContain("is not in the history of")
    expect(outcome.ok === false && outcome.mergeIssued).toBe(true)
    expect(files()).toEqual([])
  })

  test("a merged pull request whose head is not the enqueued head writes no receipt", async () => {
    const { outcome, files } = await inQueue({
      prView: [completed(githubPr()), completed(mergedGithubPr({ headRefOid: BASE_OID }))],
      queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
    })
    expect(reasonOf(outcome)).toContain("the head moved after the merge was bound to it")
    expect(files()).toEqual([])
  })

  test("an entry the queue removed is a refusal, and nothing else merges the pull request", async () => {
    const { outcome, calls, files } = await inQueue({
      prView: [completed(githubPr())],
      queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("OPEN", queued), snapshot("OPEN", null)],
    })
    expect(reasonOf(outcome)).toContain("the merge queue removed it")
    expect(outcome.ok === false && outcome.queued).toBeUndefined()
    expect(merges(calls)).toEqual([])
    expect(files()).toEqual([])
  })

  test("a head that changed while queued is a refusal", async () => {
    const { outcome, files } = await inQueue({
      prView: [completed(githubPr())],
      queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("OPEN", queued), snapshot("OPEN", null, { head: BASE_OID })],
    })
    expect(reasonOf(outcome)).toContain(`observed ${BASE_OID}, expected ${HEAD_OID}`)
    expect(files()).toEqual([])
  })

  test.each([
    ["another pull request number", { number: 471 }, "pull request number 471"],
    ["another repository", { repository: "evil/omp-plugins" }, 'repository "evil/omp-plugins"'],
    ["another base branch", { base: "main" }, 'baseRefName "main"'],
    ["only the node id, with every label correct", {}, 'node id "PR_node_forged"'],
  ])("a snapshot for %s is refused before anything is enqueued", async (_name, forged, expected) => {
    const { outcome, calls, files } = await inQueue({
      prView: [completed(githubPr())],
      queueStates: [snapshot("OPEN", null, { ...forged, id: "PR_node_forged" })],
    })
    expect(reasonOf(outcome)).toContain(expected)
    expect(enqueues(calls)).toEqual([])
    expect(files()).toEqual([])
  })

  describe("single-parent content", () => {
    const queuedSquash = (answers: Answers) =>
      inQueue({
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
        ...answers,
      })

    test("a squash whose tree is not the reviewed head merged onto its parent is refused and reported as merged", async () => {
      const { outcome, files } = await queuedSquash({ mergeTree: completed(`${PARENT_TREE}\n`) })
      expect(reasonOf(outcome)).toContain(`observed tree ${LANDED_TREE}, expected ${PARENT_TREE}`)
      expect(outcome.ok === false && outcome.mergeIssued).toBe(true)
      expect(files()).toEqual([])
    })

    test("a squash with its parent's tree changed nothing and is refused", async () => {
      const { outcome } = await queuedSquash({ landedTree: completed(`${PARENT_TREE}\n`) })
      expect(reasonOf(outcome)).toContain("the same tree as its parent")
    })

    test("a reviewed head that does not merge cleanly onto the parent is refused", async () => {
      const { outcome } = await queuedSquash({ mergeTree: completed("", 1, "CONFLICT") })
      expect(reasonOf(outcome)).toContain("a conflict or no completed read")
    })

    test("a landed commit outside the locally fetched base is refused though the compare API says ahead", async () => {
      const { outcome, calls } = await queuedSquash({ ancestor: completed("", 1) })
      expect(reasonOf(outcome)).toContain("outside the fetched base branch")
      expect(calls.some((call) => call.argv.includes(TIP_OID))).toBe(true)
    })

    test("an unreadable base tip refuses", async () => {
      const { outcome } = await queuedSquash({ baseTip: completed("", 2) })
      expect(reasonOf(outcome)).toContain("ls-remote")
    })

    test("a direct squash is held to the same content proof", async () => {
      const { outcome, files } = await land(
        { prView: [completed(githubPr()), completed(mergedGithubPr())], mergeTree: completed(`${PARENT_TREE}\n`) },
        REVIEWED,
      )
      expect(reasonOf(outcome)).toContain("the landed content is not the reviewed change")
      expect(outcome.ok === false && outcome.mergeIssued).toBe(true)
      expect(files()).toEqual([])
    })

    test("a pre-merged linear request is held to the same content proof", async () => {
      const { outcome } = await land({ prView: [completed(mergedGithubPr())], mergeTree: completed(`${PARENT_TREE}\n`) })
      expect(reasonOf(outcome)).toContain("the landed content is not the reviewed change")
    })
  })

  test("a retry after the queue merged the head reads the record and proves the queue's merge shape", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    await inQueue(
      {
        rules: queueRules("MERGE"),
        prView: [completed(githubPr())],
        queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("OPEN", queued)],
      },
      { queueWaitSeconds: 0 },
      { receiptsDirectory: shared },
    )
    const resumed = await inQueue(
      { prView: [completed(mergedGithubPr())], parents: `${BASE_OID} ${INTEGRATION_OID}` },
      {},
      { receiptsDirectory: shared },
    )
    expect(resumed.outcome.ok).toBe(true)
    if (!resumed.outcome.ok) throw new Error(resumed.outcome.reason)
    expect(resumed.outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "merge", queue: { method: "merge" } })
    expect(enqueues(resumed.calls)).toEqual([])
    expect(readdirSync(shared).filter((name) => name.startsWith("pending-"))).toEqual([])
  })

  test("a proof that fails after the queue merged keeps the record, so the retry still proves the queue shape", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    const failed = await inQueue(
      {
        rules: queueRules("MERGE"),
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
        parents: `${BASE_OID} ${INTEGRATION_OID}`,
        ancestor: completed("", 1),
      },
      {},
      { receiptsDirectory: shared },
    )
    expect(failed.outcome.ok).toBe(false)
    const retried = await inQueue(
      { prView: [completed(mergedGithubPr())], parents: `${BASE_OID} ${INTEGRATION_OID}` },
      {},
      { receiptsDirectory: shared },
    )
    expect(retried.outcome.ok).toBe(true)
  })

  test("a queue that merged the head before the first queue read records it, so a retry after a failed proof proves the queue shape", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    const failed = await inQueue(
      {
        rules: queueRules("MERGE"),
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        // Another actor's entry merged between the pull request read and the queue read.
        queueStates: [snapshot("MERGED", null)],
        parents: `${BASE_OID} ${INTEGRATION_OID}`,
        compare: completed("", 1, "HTTP 502"),
      },
      {},
      { receiptsDirectory: shared },
    )
    expect(reasonOf(failed.outcome)).toContain("HTTP 502")
    expect(enqueues(failed.calls)).toEqual([])
    const retried = await inQueue(
      { prView: [completed(mergedGithubPr())], parents: `${BASE_OID} ${INTEGRATION_OID}` },
      {},
      { receiptsDirectory: shared },
    )
    expect(retried.outcome.ok).toBe(true)
    if (!retried.outcome.ok) throw new Error(retried.outcome.reason)
    expect(retried.outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "merge", queue: { method: "merge" } })
    expect(readdirSync(shared).filter((name) => name.startsWith("pending-"))).toEqual([])
  })

  test("a queue that merged the head before the first queue read records it before re-reading, so a failed re-read still leaves the queue proof", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    const failed = await inQueue(
      {
        rules: queueRules("MERGE"),
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        queueStates: [snapshot("MERGED", null), completed("", 1, "HTTP 502")],
        parents: `${BASE_OID} ${INTEGRATION_OID}`,
      },
      {},
      { receiptsDirectory: shared },
    )
    expect(failed.outcome.ok).toBe(false)
    expect(enqueues(failed.calls)).toEqual([])
    const retried = await inQueue(
      { prView: [completed(mergedGithubPr())], parents: `${BASE_OID} ${INTEGRATION_OID}` },
      {},
      { receiptsDirectory: shared },
    )
    if (!retried.outcome.ok) throw new Error(retried.outcome.reason)
    expect(retried.outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "merge", queue: { method: "merge" } })
    expect(readdirSync(shared).filter((name) => name.startsWith("pending-"))).toEqual([])
  })

  test("a failed queue read keeps the record, so the next call refuses as removed instead of enqueuing again", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    const failed = await inQueue(
      { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), completed("", 1, "HTTP 502")] },
      {},
      { receiptsDirectory: shared },
    )
    expect(reasonOf(failed.outcome)).toContain("HTTP 502")
    expect(enqueues(failed.calls)).toHaveLength(1)
    expect(readdirSync(shared)).toEqual([`pending-queue-470-${HEAD_OID.slice(0, 12)}.json`])

    const next = await inQueue(
      { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
      {},
      { receiptsDirectory: shared },
    )
    expect(reasonOf(next.outcome)).toContain("was removed from the merge queue and was not enqueued again")
    expect(enqueues(next.calls)).toEqual([])
    expect(readdirSync(shared)).toEqual([])
  })

  test("waiting on an entry someone else enqueued writes the record, so its later removal is not re-enqueued", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    const joined = await inQueue(
      { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", queued)] },
      { queueWaitSeconds: 0 },
      { receiptsDirectory: shared },
    )
    expect(joined.outcome.ok === false && joined.outcome.queued).toBe(true)
    expect(enqueues(joined.calls)).toEqual([])
    expect(readdirSync(shared)).toEqual([`pending-queue-470-${HEAD_OID.slice(0, 12)}.json`])

    const removed = await inQueue(
      { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
      {},
      { receiptsDirectory: shared },
    )
    expect(reasonOf(removed.outcome)).toContain("was removed from the merge queue and was not enqueued again")
    expect(enqueues(removed.calls)).toEqual([])
  })

  test("an exhausted budget is pending; the next call waits on the entry without enqueuing again", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    const first = await inQueue(
      { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("OPEN", queued)] },
      { queueWaitSeconds: 0 },
      { receiptsDirectory: shared },
    )
    if (first.outcome.ok) throw new Error("expected a pending result")
    expect(first.outcome.queued).toBe(true)
    expect(first.outcome.mergeIssued).toBeUndefined()
    expect(first.outcome.reason).toContain("Call delivery_land again")
    expect(enqueues(first.calls)).toHaveLength(1)
    expect(readdirSync(shared)).toEqual([`pending-queue-470-${HEAD_OID.slice(0, 12)}.json`])

    const second = await inQueue(
      {
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        queueStates: [snapshot("OPEN", queued), snapshot("MERGED", null)],
      },
      {},
      { receiptsDirectory: shared },
    )
    expect(second.outcome.ok).toBe(true)
    expect(enqueues(second.calls)).toEqual([])
    expect(merges(second.calls)).toEqual([])
    expect(readdirSync(shared).filter((name) => name.startsWith("pending-"))).toEqual([])
  })

  test("a resume whose entry was removed refuses as removed instead of enqueuing again; a later fresh call enqueues", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    await inQueue(
      { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("OPEN", queued)] },
      { queueWaitSeconds: 0 },
      { receiptsDirectory: shared },
    )
    const resumed = await inQueue(
      { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
      {},
      { receiptsDirectory: shared },
    )
    expect(reasonOf(resumed.outcome)).toContain("was removed from the merge queue and was not enqueued again")
    expect(enqueues(resumed.calls)).toEqual([])
    expect(readdirSync(shared)).toEqual([])

    const fresh = await inQueue(
      {
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
      },
      {},
      { receiptsDirectory: shared },
    )
    expect(fresh.outcome.ok).toBe(true)
    expect(enqueues(fresh.calls)).toHaveLength(1)
  })

  test("an already MERGED pull request is proved without reading rules or the queue", async () => {
    const { outcome, calls } = await inQueue({ prView: [completed(mergedGithubPr())] })
    expect(outcome.ok).toBe(true)
    expect(calls.some((call) => isGraphql(call.argv) || call.argv.some((part) => part.includes("/rules/")))).toBe(false)
    expect(merges(calls)).toEqual([])
  })

  test("a merge_method that differs from the queue's refuses before enqueuing", async () => {
    const { outcome, calls } = await inQueue({ prView: [completed(githubPr())] }, { merge_method: "rebase" })
    expect(reasonOf(outcome)).toContain("lands with squash")
    expect(calls.some((call) => isGraphql(call.argv))).toBe(false)
  })

  test("an enqueue GitHub rejects, such as a moved head, refuses and leaves no pending record", async () => {
    const { outcome, receipts } = await inQueue({
      prView: [completed(githubPr())],
      queueStates: [snapshot("OPEN", null)],
      enqueue: completed(JSON.stringify({ errors: [{ message: "Head sha didn't match the expected head" }] })),
    })
    expect(reasonOf(outcome)).toContain("Head sha didn't match")
    expect(readdirSync(receipts)).toEqual([])
  })

  test("an enqueue gh exits non-zero on, with GitHub's errors on stdout, is a rejection and leaves no pending record", async () => {
    const { outcome, receipts } = await inQueue({
      prView: [completed(githubPr())],
      queueStates: [snapshot("OPEN", null)],
      enqueue: completed(JSON.stringify({ errors: [{ message: "Pull request is not mergeable" }] }), 1, "gh: GraphQL error"),
    })
    expect(reasonOf(outcome)).toContain("Pull request is not mergeable")
    expect(readdirSync(receipts)).toEqual([])
  })

  describe("uncertain enqueue history", () => {
    const pendingName = `pending-queue-470-${HEAD_OID.slice(0, 12)}.json`

    test.each([
      ["a timeout", { ok: false, exitCode: null, stdout: "", stderr: "", error: "timed out after 30000 ms" }],
      ["an exit with no readable answer", completed("", 1, "HTTP 502 Bad Gateway")],
      ["an unparseable answer", completed("<html>")],
    ])("an enqueue that ends in %s keeps its record, so a vanished entry refuses as removed", async (_name, lost) => {
      const shared = temporaryDirectory("delivery-land-pending-")
      const first = await inQueue(
        { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)], enqueue: lost as CliResult },
        {},
        { receiptsDirectory: shared },
      )
      expect(reasonOf(first.outcome)).toContain("may have been accepted")
      expect(enqueues(first.calls)).toHaveLength(1)
      expect(readdirSync(shared)).toEqual([pendingName])

      const retry = await inQueue(
        { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
        {},
        { receiptsDirectory: shared },
      )
      expect(reasonOf(retry.outcome)).toContain("was not enqueued again")
      expect(enqueues(retry.calls)).toEqual([])
    })

    test("a record another call writes after this call first looked still stops a second enqueue", async () => {
      const shared = temporaryDirectory("delivery-land-pending-")
      // Another call enqueues this head, and records it, while this call is being authorized;
      // GitHub has since removed that entry.
      const authorize = async (): Promise<void> => {
        writePending(shared, {
          repository: "srobroek/omp-plugins",
          number: 470,
          head: HEAD_OID,
          method: "squash",
          enqueuedAt: "2026-09-21T19:00:00Z",
        })
      }
      const { outcome, calls } = await inQueue(
        { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
        {},
        { receiptsDirectory: shared, authorize },
      )
      expect(reasonOf(outcome)).toContain("was not enqueued again")
      expect(enqueues(calls)).toEqual([])
    })

    test("a call that runs while another call's enqueue is in flight leaves that call's record alone", async () => {
      const shared = temporaryDirectory("delivery-land-pending-")
      let overlapping: Awaited<ReturnType<typeof inQueue>> | null = null
      const first = await inQueue(
        {
          prView: [completed(githubPr())],
          queueStates: [snapshot("OPEN", null)],
          // While the first call waits on GitHub, a second call sees no entry yet.
          duringEnqueue: async () => {
            overlapping = await inQueue(
              { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
              {},
              { receiptsDirectory: shared },
            )
            return { ok: false, exitCode: null, stdout: "", stderr: "", error: "timed out after 30000 ms" }
          },
        },
        {},
        { receiptsDirectory: shared },
      )
      const second = overlapping as Awaited<ReturnType<typeof inQueue>> | null
      if (second === null) throw new Error("the overlapping call did not run")
      expect(reasonOf(second.outcome)).toContain("another call is enqueuing")
      expect(enqueues(second.calls)).toEqual([])
      expect(reasonOf(first.outcome)).toContain("may have been accepted")
      expect(readdirSync(shared)).toEqual([pendingName])

      const retry = await inQueue(
        { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
        {},
        { receiptsDirectory: shared },
      )
      expect(reasonOf(retry.outcome)).toContain("was not enqueued again")
      expect(enqueues(retry.calls)).toEqual([])
    })

    test("a call whose first read missed an entry another call has since made waits on it and keeps that call's record", async () => {
      const shared = temporaryDirectory("delivery-land-pending-")
      let earlier: Awaited<ReturnType<typeof inQueue>> | null = null
      const later = await inQueue(
        {
          prView: [completed(githubPr())],
          // The first read answers no entry; before it returns, another call enqueues and
          // records the head and releases the lock; GitHub then shows the entry.
          queueStates: [snapshot("OPEN", null), snapshot("OPEN", queued)],
          duringQueueState: (index) =>
            index === 0
              ? (async () => {
                  earlier = await inQueue(
                    { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
                    { queueWaitSeconds: 0 },
                    { receiptsDirectory: shared },
                  )
                })()
              : undefined,
        },
        { queueWaitSeconds: 0 },
        { receiptsDirectory: shared },
      )
      const first = earlier as Awaited<ReturnType<typeof inQueue>> | null
      if (first === null) throw new Error("the earlier call did not run")
      expect(enqueues(first.calls)).toHaveLength(1)
      expect(later.outcome.ok === false && later.outcome.queued).toBe(true)
      expect(enqueues(later.calls)).toEqual([])
      expect(readdirSync(shared)).toEqual([pendingName])
    })

    test.each([
      ["while the newer enqueue is in flight", true],
      ["after the newer enqueue answered", false],
    ])("a waiter that sees its entry removed leaves a newer enqueue's record alone %s", async (_name, inFlight) => {
      const shared = temporaryDirectory("delivery-land-pending-")
      const recorded = (): boolean => readdirSync(shared).includes(pendingName)
      // A call that sees the removal and clears the old record, then a fresh call that enqueues.
      const removeThenEnqueue = async (duringEnqueue?: () => Promise<CliResult>) => {
        const removed = await inQueue(
          { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
          {},
          { receiptsDirectory: shared },
        )
        expect(reasonOf(removed.outcome)).toContain("was not enqueued again")
        return inQueue(
          { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)], ...(duringEnqueue ? { duringEnqueue } : {}) },
          { queueWaitSeconds: 0 },
          { receiptsDirectory: shared },
        )
      }
      const reached = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      // The waiter joins an entry, then reads it gone twice; its last read is held at the gate.
      const waiter = inQueue(
        {
          prView: [completed(githubPr())],
          queueStates: [snapshot("OPEN", queued), snapshot("OPEN", null), snapshot("OPEN", null)],
          duringQueueState: (index) => {
            if (index !== 2) return undefined
            reached.resolve()
            return inFlight ? gate.promise : removeThenEnqueue().then(() => undefined)
          },
        },
        {},
        { receiptsDirectory: shared },
      )
      let keptDuringEnqueue: boolean | null = null
      if (inFlight) {
        await reached.promise
        await removeThenEnqueue(async () => {
          gate.resolve()
          await waiter
          keptDuringEnqueue = recorded()
          return enqueued
        })
        expect(keptDuringEnqueue as boolean | null).toBe(true)
      }
      const waited = await waiter
      expect(reasonOf(waited.outcome)).toContain("the merge queue removed it")
      expect(recorded()).toBe(true)

      const retry = await inQueue(
        { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
        {},
        { receiptsDirectory: shared },
      )
      expect(reasonOf(retry.outcome)).toContain("was not enqueued again")
      expect(enqueues(retry.calls)).toEqual([])
    })

    test("an enqueue intent that cannot be persisted sends no enqueue", async () => {
      const shared = temporaryDirectory("delivery-land-pending-")
      chmodSync(shared, 0o500) // check-test-executables: directory permission, not a script
      try {
        const { outcome, calls } = await inQueue(
          { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
          {},
          { receiptsDirectory: shared },
        )
        expect(reasonOf(outcome)).toMatch(/pending-queue (lock|record) could not be written/)
        expect(enqueues(calls)).toEqual([])
      } finally {
        chmodSync(shared, 0o700) // check-test-executables: directory permission, not a script
      }
    })

    test.each([
      ["a truncated record", '{"schema":1,"repository":"srobroek/omp-plugins","num'],
      [
        "a record for another head",
        JSON.stringify({ schema: 1, repository: "srobroek/omp-plugins", number: 470, head: BASE_OID, method: "squash" }),
      ],
    ])("%s refuses instead of reading as never enqueued, and is left in place", async (_name, content) => {
      const shared = temporaryDirectory("delivery-land-pending-")
      writeFileSync(join(shared, pendingName), content)
      const open = await inQueue(
        { prView: [completed(githubPr())], queueStates: [snapshot("OPEN", null)] },
        {},
        { receiptsDirectory: shared },
      )
      expect(reasonOf(open.outcome)).toContain(`the pending-queue record ${join(shared, pendingName)} is unreadable`)
      expect(enqueues(open.calls)).toEqual([])
      expect(merges(open.calls)).toEqual([])
      const merged = await inQueue({ prView: [completed(mergedGithubPr())] }, {}, { receiptsDirectory: shared })
      expect(reasonOf(merged.outcome)).toContain("is unreadable")
      expect(readdirSync(shared)).toEqual([pendingName])
    })
  })

  describe("a resumed queue landing is held to base containment", () => {
    const enqueueThenStop = (shared: string, method: string) =>
      inQueue(
        {
          rules: queueRules(method),
          prView: [completed(githubPr())],
          queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("OPEN", queued)],
        },
        { queueWaitSeconds: 0 },
        { receiptsDirectory: shared },
      )

    test("a merge commit outside the fetched base is refused on resume", async () => {
      const shared = temporaryDirectory("delivery-land-pending-")
      await enqueueThenStop(shared, "MERGE")
      const resumed = await inQueue(
        { prView: [completed(mergedGithubPr())], parents: `${BASE_OID} ${INTEGRATION_OID}`, onBase: completed("", 1) },
        {},
        { receiptsDirectory: shared },
      )
      expect(reasonOf(resumed.outcome)).toContain("outside the fetched base branch")
      expect(readdirSync(shared)).toEqual([`pending-queue-470-${HEAD_OID.slice(0, 12)}.json`])
    })

    test("a merge commit the compare API puts off the base is refused on resume", async () => {
      const shared = temporaryDirectory("delivery-land-pending-")
      await enqueueThenStop(shared, "MERGE")
      const resumed = await inQueue(
        { prView: [completed(mergedGithubPr())], parents: `${BASE_OID} ${INTEGRATION_OID}`, compare: completed("diverged\n") },
        {},
        { receiptsDirectory: shared },
      )
      expect(reasonOf(resumed.outcome)).toContain("is not in the history of")
    })

    test("against real Git, a rebase chain the base branch does not contain is refused on resume", async () => {
      const repo = rebasedRepository("clean")
      const stopped = await landRebase(
        repo,
        {
          rules: queueRules("REBASE"),
          prView: [completed(githubPr({ headRefOid: repo.head }))],
          queueStates: [snapshot("OPEN", null, { head: repo.head }), snapshot("OPEN", null, { head: repo.head }), snapshot("OPEN", queued, { head: repo.head })],
          enqueue: enqueued,
        },
        { queueWaitSeconds: 0 },
      )
      expect(stopped.outcome.ok === false && stopped.outcome.queued).toBe(true)
      const resumed = await landRebase(
        repo,
        {
          prView: [completed(mergedGithubPr({ headRefOid: repo.head, mergeCommit: { oid: repo.landed } }))],
          baseTip: completed(`${repo.main}\trefs/heads/${BASE_BRANCH}\n`),
        },
        {},
      )
      expect(reasonOf(resumed.outcome)).toContain("outside the fetched base branch")
      expect(resumed.files().filter((name) => !name.startsWith("pending-"))).toEqual([])
    }, 60_000)
  })

  test("re-proving a merge-queue landing after its receipt was written keeps the queue's proof", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    const landed = await inQueue(
      {
        rules: queueRules("MERGE"),
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
        parents: `${BASE_OID} ${INTEGRATION_OID}`,
      },
      {},
      { receiptsDirectory: shared },
    )
    expect(landed.outcome.ok).toBe(true)
    expect(readdirSync(shared).filter((name) => name.startsWith("pending-"))).toEqual([])

    const reproved = await inQueue(
      { prView: [completed(mergedGithubPr())], parents: `${BASE_OID} ${INTEGRATION_OID}` },
      { worktree: "/tmp/worktrees/reproved" },
      // A later re-proof: its receipt is a new one, not a rewrite of the first.
      { receiptsDirectory: shared, now: () => NOW + 60_000 },
    )
    expect(reproved.outcome.ok).toBe(true)
    if (!reproved.outcome.ok) throw new Error(reproved.outcome.reason)
    expect(reproved.outcome.receipt.proof.evidence).toMatchObject({ mergeMethod: "merge", queue: { method: "merge" } })
    expect(reproved.outcome.receipt.worktree.path).toBe(reproved.worktreePath ?? "")
  })

  test.each([
    ["another tool's receipt", (r: LandingReceipt): LandingReceipt => ({ ...r, emitter: { ...r.emitter, tool: "delivery_cleanup" } })],
    ["a receipt for another base", (r: LandingReceipt): LandingReceipt => ({ ...r, pr: { ...r.pr, baseRefName: "main" } })],
    [
      "queue evidence that disagrees with the landed method",
      (r: LandingReceipt): LandingReceipt => ({ ...r, proof: { ...r.proof, evidence: { ...r.proof.evidence, mergeMethod: "squash" } } }),
    ],
  ])("%s lends no queue provenance to a re-proof", async (_name, tamper) => {
    const shared = temporaryDirectory("delivery-land-pending-")
    const landed = await inQueue(
      {
        rules: queueRules("MERGE"),
        prView: [completed(githubPr()), completed(mergedGithubPr())],
        queueStates: [snapshot("OPEN", null), snapshot("OPEN", null), snapshot("MERGED", null)],
        parents: `${BASE_OID} ${INTEGRATION_OID}`,
      },
      {},
      { receiptsDirectory: shared },
    )
    if (!landed.outcome.ok) throw new Error(landed.outcome.reason)
    const forged = temporaryDirectory("delivery-land-forged-")
    writeReceipt(tamper(structuredClone(landed.outcome.receipt)), forged)
    const reproved = await inQueue(
      { prView: [completed(mergedGithubPr())], parents: `${BASE_OID} ${INTEGRATION_OID}` },
      {},
      { receiptsDirectory: forged, now: () => NOW + 60_000 },
    )
    expect(reasonOf(reproved.outcome)).toContain(`observed second parent "${INTEGRATION_OID}"`)
  })

  test("a direct landing's receipt lends no queue provenance to a re-proof", async () => {
    const shared = temporaryDirectory("delivery-land-pending-")
    const direct = await land({ prView: [completed(mergedGithubPr())] }, {}, {}, { receiptsDirectory: shared })
    expect(direct.outcome.ok).toBe(true)
    const reproved = await inQueue(
      { prView: [completed(mergedGithubPr())], parents: `${BASE_OID} ${INTEGRATION_OID}` },
      {},
      { receiptsDirectory: shared },
    )
    expect(reasonOf(reproved.outcome)).toContain(`observed second parent "${INTEGRATION_OID}"`)
  })
})

describe("fixture hygiene", () => {
  test("no fixture directory outlives the test that created it", () => {
    expect(created.length).toBeGreaterThan(0)
    expect(created.filter((path) => existsSync(path))).toEqual([])
  })
})
