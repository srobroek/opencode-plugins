/**
 * The feature-flag cleanup bead: after a flagged `feat` PR/MR is proved merged, create
 * one due-dated chore to remove the flag, unless an open one exists.
 *
 * A merge is observed two ways: a completed `delivery_land` whose output reports
 * `ok: true`, and a shell `gh pr merge`/`glab mr merge` that exited 0. Either way the
 * forge is re-read, and only a request it reports as merged counts, so an `--auto`
 * merge that only scheduled the merge creates nothing.
 *
 * The bead is written the way the beads plugin writes an embedded store: `bd` run under
 * its `bd-embedded-write-runner`, which holds the store's single-writer lock for the
 * life of the `bd` process, with an explicit actor, `BEADS_DIR` pinned and
 * `BEADS_DOLT_SHARED_SERVER` cleared. When the runner cannot be found or refuses, the
 * agent gets the exact `bd create` command to run through the shell tool, where the
 * beads plugin's gates apply. Every other failure is silent.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { invocations } from "./shell.ts"

const READ_TIMEOUT_MS = 5_000
const GIT_TIMEOUT_MS = 2_000
const RUNNER_WAIT_MS = 5_000
/** How long the hook waits for the write; the runner is never killed, so it may still land after. */
const WRITE_WAIT_MS = 30_000
const FLAG_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RUNNER_NAME = "bd-embedded-write-runner"
export const DEFAULT_ACTOR = "opencode/trunk-dev"

export type CleanupLinks = { branch?: string; url?: string; bead?: string }
export type CleanupDecision = { args: string[]; command: string; flag: string }

function cleanText(value: unknown): string {
  return typeof value === "string" ? (value.split(/[\r\n\t]/, 1)[0]?.trim() ?? "") : ""
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** The bead the merged work was for: an explicit id, the agent branch convention, or a `Bead:` trailer. */
function beadLink(body: string, links: CleanupLinks): string | undefined {
  const fromBranch = links.branch?.match(/(?:^|\/)(?:omp|opencode)\/agent\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/|$)/)?.[1]
  const fromBody = body.match(/^(?:Bead|Bead-Id|Closes-Bead):\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*$/im)?.[1]
  const candidate = links.bead ?? fromBranch ?? fromBody
  return candidate !== undefined && BEAD_ID.test(candidate) ? candidate : undefined
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * An open cleanup bead for `name`: one this plugin created (`metadata.trunk_dev_flag`),
 * or one created by hand with a title such as `chore: remove <name> feature flag`.
 */
function isCleanupBeadFor(value: unknown, name: string): boolean {
  if (value === null || typeof value !== "object") return false
  const bead = value as { status?: unknown; metadata?: unknown; title?: unknown }
  if (typeof bead.status !== "string" || bead.status.toLowerCase() === "closed") return false
  const metadata = bead.metadata
  if (metadata && typeof metadata === "object" && (metadata as { trunk_dev_flag?: unknown }).trunk_dev_flag === name)
    return true
  if (typeof bead.title !== "string") return false
  const flag = escapeRegExp(name)
  return new RegExp(
    `\\bremove\\b.*(?:\\bflag\\s+${flag}\\b|(?:^|[\\s\`'"])${flag}[\`'"]?\\s+(?:feature\\s+)?flag\\b)`,
    "i",
  ).test(bead.title)
}

/** The `bd create` for a merged flagged `feat`, or `undefined` when none is due. Pure. */
export function decideFlagCleanup(
  title: string,
  body: string,
  existingBeads: unknown,
  links: CleanupLinks,
): CleanupDecision | undefined {
  if (!/^feat(?:\([^\r\n)]+\))?!?:\s+\S/.test(title)) return undefined
  if ([...body.matchAll(/^Flag:/gm)].length !== 1) return undefined
  const matches = [
    ...body.matchAll(/^Flag:\s*(\S+)\s+\(default off; owner [^;\r\n]+; remove by (\d{4}-\d{2}-\d{2})\)\s*$/gm),
  ]
  if (matches.length !== 1) return undefined
  const name = matches[0]?.[1]
  const due = matches[0]?.[2]
  const url = cleanText(links.url)
  if (name === undefined || name.toLowerCase() === "none" || !FLAG_NAME.test(name)) return undefined
  if (due === undefined || !validDate(due) || !isHttpUrl(url)) return undefined
  if (Array.isArray(existingBeads) && existingBeads.some((value) => isCleanupBeadFor(value, name))) return undefined

  // `bd create --deps` fails on an id the ledger does not have, so link only a known bead.
  const candidate = beadLink(body, links)
  const known = Array.isArray(existingBeads) && existingBeads.some((value) => record(value)?.id === candidate)
  const linked = known ? candidate : undefined
  const args = [
    "create",
    `chore: remove feature flag ${name}`,
    "--type",
    "chore",
    "--due",
    due,
    "--metadata",
    JSON.stringify({ trunk_dev_flag: name, pr: url }),
    "--description",
    `Remove the ${name} feature flag after rollout or abandonment. Merged PR/MR: ${url}. Close this chore with the flag-removal PR.`,
    ...(linked === undefined ? [] : ["--deps", `discovered-from:${linked}`]),
    "--silent",
  ]
  return { args, command: ["bd", ...args].map(shellQuote).join(" "), flag: name }
}

export type ForgeKind = "gh" | "glab"
export type ForgeMerge = { title: string; body: string; url: string; branch?: string }

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `gh pr view --json` / `glab mr view --output json`, but only for a completed merge. */
export function mergedForgeData(stdout: string, forge: ForgeKind): ForgeMerge | undefined {
  const value = parseJson(stdout)
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const state = typeof record.state === "string" ? record.state.toLowerCase() : ""
  if (state !== "merged") return undefined
  const title = typeof record.title === "string" ? record.title : undefined
  const body = forge === "gh" ? record.body : (record.description ?? record.body)
  const url = forge === "gh" ? record.url : (record.web_url ?? record.url ?? record.webUrl)
  const branch = forge === "gh" ? record.headRefName : record.source_branch
  if (title === undefined || typeof body !== "string" || typeof url !== "string") return undefined
  return { title, body, url, branch: typeof branch === "string" && branch ? branch : undefined }
}

/** A merge to follow up: which forge, which request, where to run its CLI, and a bead it closed. */
export type MergeRequest = { forge: ForgeKind; number: string; cwd: string; bead?: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The merge a completed `delivery_land` proved, read from its structured output
 * (`{ ok: true, pr, receipt }`). A refusal, an error or any other tool yields nothing.
 */
export function landedMerge(output: unknown, fallbackCwd: string): MergeRequest | undefined {
  const value = record(output)
  if (value?.ok !== true) return undefined
  const pr = value.pr
  const number =
    typeof pr === "number" && Number.isSafeInteger(pr) && pr > 0
      ? String(pr)
      : typeof pr === "string" && /^\d+$/.test(pr)
        ? pr
        : undefined
  if (number === undefined) return undefined
  const receipt = record(value.receipt)
  const repo = record(receipt?.repo)
  const forge = repo?.forge === "gitlab" ? "glab" : repo?.forge === "github" || repo === undefined ? "gh" : undefined
  if (forge === undefined) return undefined
  const worktree = record(receipt?.worktree)?.path
  const root = repo?.canonicalRoot
  const cwd = [worktree, root].find((dir): dir is string => typeof dir === "string" && dir !== "" && isDirectory(dir))
  const ids = record(receipt?.beads)?.ids
  const bead = Array.isArray(ids) && typeof ids[0] === "string" && BEAD_ID.test(ids[0]) ? ids[0] : undefined
  return { forge, number, cwd: cwd ?? fallbackCwd, ...(bead === undefined ? {} : { bead }) }
}

/** Every literal `gh pr merge <n>` / `glab mr merge <n>` in a shell command. */
export function shellMerges(command: string, cwd: string): MergeRequest[] {
  return invocations(command, cwd).flatMap((invocation) => {
    const { argv } = invocation
    const forge: ForgeKind | undefined =
      argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge"
        ? "gh"
        : argv[0] === "glab" && argv[1] === "mr" && argv[2] === "merge"
          ? "glab"
          : undefined
    if (forge === undefined) return []
    const number = argv.slice(3).find((arg, i) => /^\d+$/.test(arg) && !invocation.expands[i + 3])
    return number === undefined ? [] : [{ forge, number, cwd: invocation.cwd }]
  })
}

export type CommandResult = { exitCode: number; stdout: string; timedOut?: true }
export type CommandRunner = (
  cmd: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  killOnTimeout?: boolean,
) => Promise<CommandResult | undefined>
export type Runner = { interpreter: string; script: string }

/** `killOnTimeout: false` leaves a writer running under its lock and reports the wait as timed out. */
export const runCommand: CommandRunner = async (cmd, cwd, env, timeoutMs, killOnTimeout = true) => {
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    child = Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const out = child.stdout
    const stdout = out === null || typeof out === "number" || out === undefined ? Promise.resolve("") : new Response(out).text()
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode, timedOut: false as const })),
      new Promise<{ exitCode: number; timedOut: true }>((done) => {
        timer = setTimeout(() => done({ exitCode: -1, timedOut: true }), timeoutMs)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (result.timedOut) {
      if (killOnTimeout) child.kill()
      void child.exited.catch(() => undefined)
      void stdout.catch(() => undefined)
      return killOnTimeout ? undefined : { exitCode: -1, stdout: "", timedOut: true }
    }
    return { exitCode: result.exitCode, stdout: await stdout }
  } catch {
    try {
      child?.kill()
    } catch {
      // A finished child needs no cleanup.
    }
    return undefined
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The `.beads` the beads plugin pins: `BEADS_DIR`, the primary checkout's, then the checkout's own. */
function selectedStore(cwd: string, root: string, commonDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const pinned = env.BEADS_DIR ? resolve(cwd, env.BEADS_DIR) : undefined
  const candidates = [pinned, join(dirname(resolve(cwd, commonDir)), ".beads"), join(root, ".beads")]
  const found = candidates.find((path): path is string => path !== undefined && isDirectory(path))
  if (found === undefined) return undefined
  try {
    return realpathSync(found)
  } catch {
    return found
  }
}

export async function repository(
  cwd: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
): Promise<{ root: string; store: string } | undefined> {
  const [rootResult, commonResult] = await Promise.all([
    run(["git", "rev-parse", "--show-toplevel"], cwd, env, GIT_TIMEOUT_MS),
    run(["git", "rev-parse", "--git-common-dir"], cwd, env, GIT_TIMEOUT_MS),
  ])
  if (rootResult?.exitCode !== 0 || commonResult?.exitCode !== 0) return undefined
  const root = rootResult.stdout.trim()
  const commonDir = commonResult.stdout.trim()
  if (!root || !commonDir) return undefined
  const store = selectedStore(cwd, root, commonDir, env)
  return store === undefined ? undefined : { root, store }
}

export function bdEnvironment(env: NodeJS.ProcessEnv, store: string): NodeJS.ProcessEnv {
  return {
    ...env,
    BEADS_DOLT_SHARED_SERVER: "",
    BEADS_DIR: store,
    BD_NO_PAGER: "1",
    BD_NON_INTERACTIVE: "1",
    BD_DOLT_AUTO_START: "false",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  }
}

/** The Bun binary, never the compiled `opencode` executable that may be `process.execPath`. */
function bunBinary(env: NodeJS.ProcessEnv): string | undefined {
  const own = basename(process.execPath)
  if (own === "bun" || own === "bun.exe") return process.execPath
  const onPath = Bun.which("bun")
  if (onPath) return onPath
  if (env.BUN_INSTALL) {
    const candidate = join(env.BUN_INSTALL, "bin", "bun")
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** The beads plugin's runner beside this plugin: a sibling checkout, a package install, or the plugin cache. */
export function findRunner(here: string = import.meta.dir, env: NodeJS.ProcessEnv = process.env): Runner | undefined {
  const candidates = [
    join(here, "..", "..", "beads", "dist", `${RUNNER_NAME}.js`),
    join(here, "..", "..", "beads", "src", `${RUNNER_NAME}.ts`),
    join(here, "..", "node_modules", "@srobroek", "opencode-beads", "dist", `${RUNNER_NAME}.js`),
    join(here, "..", "..", "..", "node_modules", "@srobroek", "opencode-beads", "dist", `${RUNNER_NAME}.js`),
  ]
  let script = candidates.find((path) => existsSync(path))
  if (script === undefined) {
    // A plugin cache keeps each installed plugin in its own directory; look at siblings.
    const parent = resolve(here, "..", "..")
    let entries: string[] = []
    try {
      entries = readdirSync(parent)
    } catch {
      entries = []
    }
    for (const entry of entries.filter((name) => /beads/.test(name)).sort()) {
      const found = [
        join(parent, entry, "dist", `${RUNNER_NAME}.js`),
        join(parent, entry, "plugins", "beads", "dist", `${RUNNER_NAME}.js`),
      ].find((path) => existsSync(path))
      if (found !== undefined) {
        script = found
        break
      }
    }
  }
  if (script === undefined) return undefined
  const interpreter = bunBinary(env)
  return interpreter === undefined ? undefined : { interpreter, script: resolve(script) }
}

export type BeadsRuntime = {
  findRunner: () => Runner | undefined
  run: CommandRunner
}

export const productionRuntime: BeadsRuntime = { findRunner: () => findRunner(), run: runCommand }

function actorOf(env: NodeJS.ProcessEnv): string {
  return env.BEADS_ACTOR?.trim() || env.BD_ACTOR?.trim() || DEFAULT_ACTOR
}

function followUp(decision: CleanupDecision, actor: string): string {
  return `trunk-dev: create the feature-flag cleanup chore (required) through the shell tool: BEADS_ACTOR=${shellQuote(actor)} ${decision.command}`
}

function cleanupId(stdout: string): string | undefined {
  const text = stdout.trim()
  if (BEAD_ID.test(text)) return text
  const json = record(parseJson(text))
  if (typeof json?.id === "string" && BEAD_ID.test(json.id)) return json.id
  for (const line of text.split(/\r?\n/)) {
    const id = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*$/.exec(line)?.[1]
    if (id !== undefined) return id
  }
  return undefined
}

/** Write the cleanup bead under the embedded-store lock; the text the agent is told. */
export async function createCleanup(
  decision: CleanupDecision,
  store: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  runtime: BeadsRuntime = productionRuntime,
): Promise<string> {
  const actor = actorOf(env)
  const runner = runtime.findRunner()
  if (runner === undefined) return followUp(decision, actor)
  // The runner waits RUNNER_WAIT_MS for the lock. It is never killed: a killed writer
  // defeats the lock's lifetime guarantee, so a timeout only ends this wait.
  const result = await runtime.run(
    [
      runner.interpreter,
      runner.script,
      "--beads-store",
      store,
      "--beads-wait-ms",
      String(RUNNER_WAIT_MS),
      "--",
      "bd",
      "--json",
      "--actor",
      actor,
      ...decision.args,
    ],
    cwd,
    { ...bdEnvironment(env, store), BEADS_ACTOR: actor },
    WRITE_WAIT_MS,
    false,
  )
  if (result?.timedOut) {
    // The write may still land, so a retry command here could create a duplicate.
    return `trunk-dev: the feature-flag cleanup chore is still being written; before creating it by hand, check \`bd list --metadata-field trunk_dev_flag=${decision.flag} --json\`.`
  }
  if (result === undefined || result.exitCode !== 0) return followUp(decision, actor)
  const id = cleanupId(result.stdout)
  return id === undefined
    ? `trunk-dev: cleanup chore creation completed for flag ${decision.flag}, but bd returned no readable id.`
    : `trunk-dev: created cleanup bead ${id} for flag ${decision.flag}, due on its removal date; close it with the flag-removal PR.`
}

/** Read each merged request back from the forge and create its cleanup bead; the text for the agent, if any. */
export async function flagCleanupFollowUp(
  merges: readonly MergeRequest[],
  env: NodeJS.ProcessEnv,
  runtime: BeadsRuntime = productionRuntime,
): Promise<string | undefined> {
  const notes: string[] = []
  for (const merge of merges) {
    const repo = await repository(merge.cwd, env, runtime.run)
    if (repo === undefined) continue
    const readEnv = bdEnvironment(env, repo.store)
    const forgeArgs =
      merge.forge === "gh"
        ? ["gh", "pr", "view", merge.number, "--json", "title,body,url,state,headRefName"]
        : ["glab", "mr", "view", merge.number, "--output", "json"]
    const [forgeResult, existingResult] = await Promise.all([
      runtime.run(forgeArgs, merge.cwd, readEnv, READ_TIMEOUT_MS),
      runtime.run(["bd", "--readonly", "list", "--all", "--json", "--limit", "0"], repo.root, readEnv, READ_TIMEOUT_MS),
    ])
    if (forgeResult?.exitCode !== 0 || existingResult?.exitCode !== 0) continue
    const forge = mergedForgeData(forgeResult.stdout, merge.forge)
    const existing = parseJson(existingResult.stdout)
    if (forge === undefined || !Array.isArray(existing)) continue
    const decision = decideFlagCleanup(forge.title, forge.body, existing, {
      branch: forge.branch,
      url: forge.url,
      bead: merge.bead,
    })
    if (decision === undefined) continue
    notes.push(await createCleanup(decision, repo.store, merge.cwd, env, runtime))
  }
  return notes.length === 0 ? undefined : notes.join("\n")
}
