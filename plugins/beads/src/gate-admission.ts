/**
 * Automatic gates are verified before work is picked.
 *
 * A mutating `bd` command, and a subagent dispatch, waits for the target store's gate
 * verdict: `bd gate list`, and `bd gate check` when an automatic gate could resolve.
 * The verdict is derived from bd and cached per store in this plugin instance; an
 * instance that never saw it just reads it again.
 */

import { existsSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { type BdInvocation, bdInvocations, flagEnabled, globalValue, invocationFromArgv } from "./bd-actor-gate.ts"
import { embeddedWriteTargets, withEmbeddedWriteLock, writesStore } from "./bd-embedded-write-lock.ts"
import { sessionPinFor } from "./beads-store.ts"
import { leadingCdCwd } from "./shell.ts"

/** The longest a mutating command waits for its store's gate verification. */
export const GATE_ADMISSION_MS = 20_000

/** The fixed ceiling on one internal `bd` command. Cold embedded reads run 30-50 seconds. */
const BD_COMMAND_CEILING_MS = 120_000

/** Longest advisory list before it stops being read. */
const MAX_LISTED = 8

/** Gate types bd resolves on its own; a human gate never resolves from a check. */
export const AUTO_GATE_TYPES: Record<string, true> = { timer: true, "gh:run": true, "gh:pr": true, bead: true }

/** Variables the plugin wins on whenever it shapes an environment for bd. */
export const EMBEDDED_PIN_ENV: Readonly<Record<string, string>> = { BEADS_DOLT_SHARED_SERVER: "" }

/** The environment for a plugin-internal `bd` read from `cwd`. */
export function lifecycleBdEnvironment(cwd: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  if (env.BEADS_DIR === undefined || env.BEADS_DIR === "") {
    delete env.BEADS_DIR
    const resolved = sessionPinFor(cwd)
    if (resolved !== undefined) env.BEADS_DIR = resolved
  }
  return boundedBdEnvironment(env)
}

function boundedBdEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    ...EMBEDDED_PIN_ENV,
    BD_NO_PAGER: "1",
    BD_NON_INTERACTIVE: "1",
    BD_DOLT_AUTO_START: "false",
    NO_COLOR: "1",
  }
}

/** The store directory bd would open from `cwd` under `env`. */
export function bdStoreDir(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const selected = env.BEADS_DIR
  const dir = selected ? (isAbsolute(selected) ? selected : resolve(cwd, selected)) : join(cwd, ".beads")
  try {
    return statSync(dir).isDirectory() ? resolve(dir) : undefined
  } catch {
    return undefined
  }
}

export function boundedFailure(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim()
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine
}

function readFailure(reason: string): string {
  return `Beads gates could not be verified: ${boundedFailure(reason)}.`
}

/**
 * The JSON bd printed, ignoring the human summary it prints first.
 *
 * `bd gate check --json` writes its progress lines and then the envelope, so the
 * payload is the last block that parses to the end of the output.
 */
export function parseTrailingJson(stdout: string): unknown {
  const text = stdout.trim()
  if (!text) return undefined
  if (text === "null") return null
  const starts: number[] = []
  if (text[0] === "{" || text[0] === "[") starts.push(0)
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "\n" && (text[i + 1] === "{" || text[i + 1] === "[")) starts.push(i + 1)
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(text.slice(starts[i]))
    } catch {
      // An earlier candidate may still parse: bd's own summary can contain braces.
    }
  }
  return undefined
}

/** Unwrap `BD_JSON_ENVELOPE=1` output; bare `--json` passes through. */
export function envelopeData(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if ("schema_version" in record && "data" in record) return record.data
  return value
}

export interface Gate {
  id: string
  awaitType: string
  blocks?: string
  reason?: string
}

export function readGates(stdout: string): Gate[] {
  const data = envelopeData(parseTrailingJson(stdout))
  if (!Array.isArray(data)) return []
  const gates: Gate[] = []
  for (const row of data) {
    if (row === null || typeof row !== "object") continue
    const record = row as Record<string, unknown>
    if (typeof record.id !== "string") continue
    if (typeof record.status === "string" && record.status !== "open") continue
    const description = typeof record.description === "string" ? record.description : ""
    gates.push({
      id: record.id,
      awaitType: typeof record.await_type === "string" ? record.await_type : "unknown",
      blocks: description.match(/blocking\s+(\S+)/)?.[1],
      reason: description.match(/^Reason:\s*(.+)$/m)?.[1],
    })
  }
  return gates
}

/** Parse a gate list while distinguishing bd's valid empty `null` from bad output. */
export function readGateList(stdout: string): Gate[] | undefined {
  const parsed = parseTrailingJson(stdout)
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const error = (parsed as Record<string, unknown>).error
    if (error !== undefined && error !== null && error !== "") return undefined
  }
  const data = envelopeData(parsed)
  if (data === null) return []
  if (
    !Array.isArray(data) ||
    data.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        typeof (row as Record<string, unknown>).id !== "string" ||
        typeof (row as Record<string, unknown>).await_type !== "string",
    )
  )
    return undefined
  return readGates(stdout)
}

/** Whether spending a `bd gate check` can change anything. */
export function gatesCanResolve(gates: Gate[]): boolean {
  return gates.some((gate) => AUTO_GATE_TYPES[gate.awaitType] === true)
}

export interface CheckOutcome {
  resolved: number
  escalated: number
  errors: number
}

export function readCheckOutcome(stdout: string): CheckOutcome | undefined {
  const data = envelopeData(parseTrailingJson(stdout))
  if (data === null || typeof data !== "object") return undefined
  const record = data as Record<string, unknown>
  if (typeof record.resolved !== "number" || typeof record.escalated !== "number" || typeof record.errors !== "number")
    return undefined
  return { resolved: record.resolved, escalated: record.escalated, errors: record.errors }
}

export function formatGateAdvisory(gates: Gate[], outcome: CheckOutcome | undefined): string | undefined {
  if (gates.length === 0) return undefined
  const lines = [`${gates.length} open beads gate(s); only their actual dependency consumers must wait:`]
  for (const gate of gates.slice(0, MAX_LISTED)) {
    const blocks = gate.blocks ? ` blocks ${gate.blocks}` : ""
    const reason = gate.reason ? ` -- ${gate.reason}` : ""
    lines.push(`- ${gate.id} (${gate.awaitType})${blocks}${reason}`)
  }
  if (gates.length > MAX_LISTED) lines.push(`- ...and ${gates.length - MAX_LISTED} more`)
  if (outcome) {
    lines.push(
      `\`bd gate check\` ran: ${outcome.resolved} resolved, ${outcome.escalated} escalated, ${outcome.errors} errors.`,
    )
  }
  lines.push(
    "A human gate resolves only through a recorded human decision (`bd gate resolve <id>`); never force-close a gated issue around one.",
  )
  lines.push(
    "Future-stage or unrelated gates do not block independent work, pre-spec work, or governance work. Check the selected work's dependency edges before waiting; retain all required safety/provider confirmations.",
  )
  return lines.join("\n")
}

/**
 * The stale-skip warning, from either shape bd reports it in. Only a real import
 * produces it: `--dry-run` reports every row as `created` and never compares.
 */
export function staleSkipNotice(output: string): string | undefined {
  let stale: string | undefined
  const data = envelopeData(parseTrailingJson(output))
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const ids = (data as Record<string, unknown>).stale_skipped_ids
    if (Array.isArray(ids) && ids.length > 0) stale = ids.map(String).join(", ")
  }
  if (stale === undefined) {
    const plain = output.match(/\((\d+) stale skipped/)
    if (plain && Number(plain[1]) > 0) stale = `${plain[1]} row(s)`
  }
  if (stale === undefined) return undefined
  return [
    `\`bd import\` skipped stale rows (${stale}): the JSONL export is BEHIND this database and local state was kept.`,
    "Commit a fresh export (`bd export -o .beads/issues.jsonl`, then stage it) BEFORE pulling peer changes -- otherwise the next export overwrites what a peer committed.",
  ].join(" ")
}

export type BdRunResult = { output: string } | { failure: string }

/** How the plugin runs `bd` itself. Replaceable in tests. */
export type BdRun = (cwd: string, args: string[], deadline: number, env: NodeJS.ProcessEnv) => Promise<BdRunResult>

let internalRuns = 0

/** Run bd, under the embedded write lock when the verb writes. */
export const runBdResult: BdRun = async (cwd, args, deadline, env) => {
  const execute = (): Promise<BdRunResult> => spawnBd(cwd, args, deadline, env)
  let result: BdRunResult
  if (writesStore(invocationFromArgv(args))) {
    const locked = await withEmbeddedWriteLock(
      cwd,
      `beads-plugin-run-${process.pid}-${internalRuns++}`,
      execute,
      env,
      deadline,
    )
    result = locked.kind === "failed" ? { failure: boundedFailure(locked.reason) } : locked.value
  } else {
    result = await execute()
  }
  return Date.now() >= deadline ? { failure: "bd command timed out" } : result
}

async function spawnBd(cwd: string, args: string[], deadline: number, env: NodeJS.ProcessEnv): Promise<BdRunResult> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { failure: "bd command timed out" }
  const started = Date.now()
  try {
    const proc = Bun.spawn(["bd", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1", BD_JSON_ENVELOPE: "1" },
      timeout: Math.min(BD_COMMAND_CEILING_MS, remaining),
      killSignal: "SIGKILL",
    })
    // A read is unreferenced so a slow one cannot hold the host open. A write runs inside
    // the embedded write lock this process holds and must not be cut off mid-journal.
    if (!writesStore(invocationFromArgv(args))) proc.unref()
    const [out, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    if (code === 0) return { output: out }
    if (Date.now() >= deadline || Date.now() - started >= remaining) return { failure: "bd command timed out" }
    const detail = stderr.replace(/\s+/g, " ").trim()
    return { failure: boundedFailure(`bd exited with code ${code}${detail ? `: ${detail}` : ""}`) }
  } catch (error) {
    if (Date.now() >= deadline || Date.now() - started >= remaining) return { failure: "bd command timed out" }
    return { failure: boundedFailure(`bd could not run: ${error instanceof Error ? error.message : String(error)}`) }
  }
}

export interface GateVerdict {
  notice?: string
  verified: boolean
}

/** Read the store's gates and, when an automatic one could resolve, check them. */
export async function verifyGates(cwd: string, env: NodeJS.ProcessEnv, run: BdRun = runBdResult): Promise<GateVerdict> {
  const runGate = (args: string[]): Promise<BdRunResult> => run(cwd, args, Date.now() + BD_COMMAND_CEILING_MS, env)
  const listed = await runGate(["gate", "list", "--json"])
  if (!("output" in listed)) return { notice: readFailure(listed.failure), verified: false }
  let gates = readGateList(listed.output)
  if (gates === undefined)
    return { notice: "Beads gate list returned malformed data; unresolved gates remain unverified.", verified: false }
  if (gates.length === 0) return { verified: true }
  let outcome: CheckOutcome | undefined
  if (gatesCanResolve(gates)) {
    const checked = await runGate(["gate", "check", "--json"])
    if (!("output" in checked)) return { notice: readFailure(checked.failure), verified: false }
    outcome = readCheckOutcome(checked.output)
    if (outcome === undefined)
      return { notice: "Beads gate check returned malformed data; unresolved gates remain unverified.", verified: false }
    if (outcome.errors > 0)
      return {
        notice: `Beads gate check reported ${outcome.errors} error(s); unresolved gates remain unverified.`,
        verified: false,
      }
    if (outcome.resolved > 0) {
      const relisted = await runGate(["gate", "list", "--json"])
      if (!("output" in relisted)) return { notice: readFailure(relisted.failure), verified: false }
      const relistedGates = readGateList(relisted.output)
      if (relistedGates === undefined)
        return { notice: "Beads gate list returned malformed data; unresolved gates remain unverified.", verified: false }
      gates = relistedGates
    }
  }
  return { notice: formatGateAdvisory(gates, outcome), verified: true }
}

interface Verification {
  pending: Promise<GateVerdict>
  verdict?: GateVerdict
  /** True after an operation was admitted using this completed verdict. */
  admitted?: boolean
  /** True once the verdict's notice was handed to a caller. */
  advised?: boolean
}

export type Admission = { block: true; reason: string } | { block: false; notice?: string } | undefined

async function settleWithin<T>(pending: Promise<T>, budgetMs: number): Promise<T | undefined> {
  if (budgetMs <= 0) return undefined
  const { promise, resolve } = Promise.withResolvers<undefined>()
  const timer = setTimeout(resolve, budgetMs)
  timer.unref?.()
  try {
    return await Promise.race([pending, promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Gate verdicts by resolved store directory. One instance per plugin instance. */
export class GateAdmitter {
  readonly #verifications = new Map<string, Verification>()
  readonly #run: BdRun

  constructor(run: BdRun = runBdResult) {
    this.#run = run
  }

  /** Start (or reuse) verification for the store `cwd` and `env` select. */
  verify(cwd: string, env: NodeJS.ProcessEnv, refresh = false): Verification | undefined {
    const dir = bdStoreDir(cwd, env)
    if (dir === undefined) return undefined
    const existing = this.#verifications.get(dir)
    if (
      existing !== undefined &&
      (existing.verdict === undefined ||
        (!refresh && existing.verdict.verified) ||
        (existing.verdict.verified && existing.admitted !== true))
    )
      return existing
    const pending = verifyGates(cwd, env, this.#run).catch(
      (error: unknown): GateVerdict => ({
        notice: readFailure(error instanceof Error ? error.message : String(error)),
        verified: false,
      }),
    )
    const verification: Verification = { pending }
    void pending.then((verdict) => {
      verification.verdict = verdict
    })
    this.#verifications.set(dir, verification)
    return verification
  }

  /**
   * Wait for the store's verdict within `deadline`. A verified store admits, once with
   * its gate list as a notice; an unverified or still-pending one refuses.
   */
  async admit(cwd: string, env: NodeJS.ProcessEnv, refresh: boolean, deadline: number): Promise<Admission> {
    const bounded = boundedBdEnvironment(env)
    const gate = this.verify(resolve(cwd), bounded, refresh)
    if (gate === undefined) return undefined
    const waitStarted = Date.now()
    if (gate.verdict === undefined) {
      const verdict = await settleWithin(gate.pending, Math.min(GATE_ADMISSION_MS, deadline - waitStarted))
      if (verdict !== undefined) gate.verdict = verdict
    }
    if (gate.verdict?.verified === true) {
      gate.admitted = true
      const notice = gate.advised === true ? undefined : gate.verdict.notice
      gate.advised = true
      return { block: false, notice }
    }
    const reason =
      gate.verdict?.notice === undefined
        ? `automatic beads gates are still being verified for ${cwd} after ${Date.now() - waitStarted} ms, so an automatic gate may still be unresolved and this operation would pick or change work ahead of it. The read is slow, not failed`
        : `automatic beads gates could not be verified for ${cwd}, so this operation could pick or change work while a gate remains unresolved. ${gate.verdict.notice}`
    return { block: true, reason }
  }
}

function canonicalStore(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The store one `bd` invocation opens, when it is a local one. */
export function bdStoreForInvocation(
  invocation: BdInvocation,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (flagEnabled(invocation.globals, ["--global", "--database"])) return undefined
  const directory = globalValue(invocation.globals, ["-C", "--directory"])
  const db = globalValue(invocation.globals, ["--db"])
  const base = directory === undefined ? cwd : resolve(cwd, directory)
  if (db !== undefined) {
    const target = resolve(base, db)
    if (!existsSync(target)) return undefined
    return canonicalStore(statSync(target).isDirectory() ? target : dirname(target))
  }
  if (directory !== undefined) return canonicalStore(sessionPinFor(base) ?? join(base, ".beads"))
  const local = invocation.prefix.findLast((token) => token.startsWith("BEADS_DIR="))?.slice("BEADS_DIR=".length)
  const pinned = local ?? env.BEADS_DIR
  return canonicalStore(
    pinned === undefined || pinned === ""
      ? (sessionPinFor(cwd) ?? join(cwd, ".beads"))
      : isAbsolute(pinned)
        ? pinned
        : resolve(cwd, pinned),
  )
}

/** Command-local `BEADS_DIR=` assignments on bd invocations override the ambient one. */
export function environmentForCommand(command: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const invocation of bdInvocations(command)) {
    const assignment = invocation.prefix.findLast((token) => token.startsWith("BEADS_DIR="))
    if (assignment !== undefined) env.BEADS_DIR = assignment.slice("BEADS_DIR=".length)
  }
  return env
}

/**
 * Whether a mutating bd command may run yet: its target store's automatic gates must be
 * verified first. Commands that write nothing, or write an external store, pass.
 */
export async function admitBdMutation(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  admitter: GateAdmitter,
  deadline: number,
  targetEnabled?: (cwd: string) => boolean,
): Promise<Admission> {
  if (!command) return undefined
  if (/\bcd\s+(?:"[^"]*\$[^"]*"|'[^']*\$[^']*'|\$[A-Za-z_])/u.test(command)) {
    return { block: true, reason: "cannot resolve the dynamic working directory before this mutation" }
  }
  const writes = bdInvocations(command).filter((invocation) => writesStore(invocation))
  if (
    writes.some((invocation) =>
      invocation.prefix.some((token) => token.startsWith("BEADS_DIR=") && /[$`]/u.test(token)),
    )
  ) {
    return {
      block: true,
      reason: "Beads directory is selected dynamically and cannot be verified before this mutation",
    }
  }
  if (writes.length === 0) return undefined
  const literalCd = /^\s*cd\s+([^\s;&|]+)\s*&&\s*([\s\S]+?)\s*$/.exec(command)
  const targetCommand = literalCd === null ? command : (literalCd[2] ?? "")
  const targetCwd = literalCd === null ? cwd : leadingCdCwd(command, cwd)
  const commandEnv = environmentForCommand(command, env)
  const writeTargets = embeddedWriteTargets(targetCommand, targetCwd, commandEnv)
  if (writeTargets.kind === "refused") return { block: true, reason: writeTargets.reason }
  const direct = writes.length === 1 ? writes[0] : undefined
  if (direct !== undefined && flagEnabled(direct.globals, ["--global", "--database"])) return undefined
  const store = direct === undefined ? undefined : bdStoreForInvocation(direct, targetCwd, commandEnv)
  if (targetEnabled?.(store === undefined ? targetCwd : dirname(store)) === false) return undefined
  return await admitter.admit(
    targetCwd,
    store === undefined ? commandEnv : { ...commandEnv, BEADS_DIR: store },
    false,
    deadline,
  )
}
