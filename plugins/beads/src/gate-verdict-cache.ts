/**
 * Gate verification for a host that runs one short process per tool call (Claude Code hooks).
 *
 * `bd gate check` writes the embedded store under its write lock, and that lock belongs to
 * the process that spawned it. A hook process is cut off by its budget, so it never runs the
 * verification itself: it hands the store to one detached worker and waits for the worker's
 * verdict in a short-lived on-disk cache. The worker owns the lock and every bd child for the
 * whole verification and exits only after they have exited.
 *
 * A verified verdict is trusted for `VERDICT_TTL_MS`. Anything unreadable, expired, or in a
 * directory other users can reach counts as no verdict, so the gate still refuses.
 */

import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processAlive } from "@srobroek/opencode-lib/subprocess"

import type { GateVerdict, GateVerifier } from "./gate-admission.ts"

/** How long a stored verified verdict is trusted. */
export const VERDICT_TTL_MS = 60_000

/** How often a waiting hook looks for the worker's verdict. */
export const POLL_MS = 200

export type Claim = "claimed" | "busy" | "unavailable"

export class FileVerdictCache {
  readonly #dir: string
  readonly #now: () => number
  readonly #alive: (pid: number) => boolean

  constructor(
    dir = join(tmpdir(), `beads-gate-verdicts-${process.getuid?.() ?? "user"}`),
    now: () => number = Date.now,
    alive: (pid: number) => boolean = processAlive,
  ) {
    this.#dir = dir
    this.#now = now
    this.#alive = alive
  }

  /** The cache's clock, which stamps every verdict. */
  now(): number {
    return this.#now()
  }

  /** The cache directory when it is ours and closed to other users; created on demand. */
  #usable(): boolean {
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
      const stat = lstatSync(this.#dir)
      const owner = process.getuid?.()
      return stat.isDirectory() && (owner === undefined || stat.uid === owner) && (stat.mode & 0o077) === 0
    } catch {
      return false
    }
  }

  #file(storeDir: string, kind: "json" | "worker"): string {
    return join(this.#dir, `${createHash("sha256").update(storeDir).digest("hex")}.${kind}`)
  }

  #stored(storeDir: string): { at: number; verdict: GateVerdict } | undefined {
    if (!this.#usable()) return undefined
    try {
      const { at, verdict } = JSON.parse(readFileSync(this.#file(storeDir, "json"), "utf8")) as {
        at?: unknown
        verdict?: { verified?: unknown; notice?: unknown }
      }
      if (typeof at !== "number" || at > this.#now() || this.#now() - at >= VERDICT_TTL_MS) return undefined
      if (typeof verdict?.verified !== "boolean") return undefined
      const notice = typeof verdict.notice === "string" ? { notice: verdict.notice } : {}
      return { at, verdict: { verified: verdict.verified, ...notice } }
    } catch {
      return undefined
    }
  }

  /** The store's verified verdict, while it is fresh. */
  read(storeDir: string): GateVerdict | undefined {
    const stored = this.#stored(storeDir)
    return stored?.verdict.verified === true ? stored.verdict : undefined
  }

  /** The store's failed verdict when it was written at or after `since`. */
  failureSince(storeDir: string, since: number): GateVerdict | undefined {
    const stored = this.#stored(storeDir)
    return stored !== undefined && !stored.verdict.verified && stored.at >= since ? stored.verdict : undefined
  }

  /** Store the newest verdict, verified or not; a failure replaces an older verified verdict. */
  write(storeDir: string, verdict: GateVerdict): void {
    if (!this.#usable()) return
    const file = this.#file(storeDir, "json")
    const temporary = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ at: this.#now(), verdict }), { mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      rmSync(temporary, { force: true })
    }
  }

  #holder(storeDir: string): number | undefined {
    try {
      const pid = Number(readFileSync(this.#file(storeDir, "worker"), "utf8"))
      return Number.isInteger(pid) && pid > 0 ? pid : undefined
    } catch {
      return undefined
    }
  }

  /** Whether a live process holds the store's verification. */
  workerAlive(storeDir: string): boolean {
    if (!this.#usable()) return false
    const pid = this.#holder(storeDir)
    return pid !== undefined && this.#alive(pid)
  }

  /** Take the store's verification for `pid`, unless a live process already holds it. */
  claim(storeDir: string, pid: number): Claim {
    if (!this.#usable()) return "unavailable"
    const file = this.#file(storeDir, "worker")
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, String(pid), { flag: "wx", mode: 0o600 })
        return "claimed"
      } catch {
        // Held: keep a live holder, clear a dead one and try once more.
        if (this.workerAlive(storeDir)) return "busy"
        rmSync(file, { force: true })
      }
    }
    return "busy"
  }

  /** Pass a claim from `from` to `to`, the worker that does the verification. */
  handOver(storeDir: string, from: number, to: number): void {
    if (this.#holder(storeDir) !== from) return
    const file = this.#file(storeDir, "worker")
    const temporary = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, String(to), { mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      rmSync(temporary, { force: true })
    }
  }

  /** Give up `pid`'s claim; another holder's claim is left alone. */
  release(storeDir: string, pid: number): void {
    if (this.#holder(storeDir) !== pid) return
    try {
      unlinkSync(this.#file(storeDir, "worker"))
    } catch {
      // Already gone.
    }
  }
}

const ENDED = "the gate verification process ended without a verdict"

/**
 * A verifier that never runs bd in this process: it returns a fresh cached verdict, or makes
 * sure one worker is verifying the store (`spawnWorker` starts it and returns its pid) and
 * waits for that worker's verdict. The wait ends when the worker is gone.
 */
export function delegatedVerifier(
  cache: FileVerdictCache,
  spawnWorker: (cwd: string, env: NodeJS.ProcessEnv, storeDir: string) => number | undefined,
  pollMs = POLL_MS,
): GateVerifier {
  return async (cwd, env, storeDir) => {
    const cached = cache.read(storeDir)
    if (cached !== undefined) return cached
    const since = cache.now()
    const claim = cache.claim(storeDir, process.pid)
    if (claim === "unavailable")
      return { verified: false, notice: "Beads gates could not be verified: the gate verdict cache directory is not usable." }
    if (claim === "claimed") {
      let pid: number | undefined
      try {
        pid = spawnWorker(cwd, env, storeDir)
      } catch {
        pid = undefined
      }
      if (pid === undefined) {
        cache.release(storeDir, process.pid)
        return { verified: false, notice: "Beads gates could not be verified: the gate verification process did not start." }
      }
      cache.handOver(storeDir, process.pid, pid)
    }
    while (true) {
      await Bun.sleep(pollMs)
      const verdict = cache.read(storeDir)
      if (verdict !== undefined) return verdict
      if (!cache.workerAlive(storeDir))
        return cache.read(storeDir) ?? cache.failureSince(storeDir, since) ?? { verified: false, notice: `Beads gates could not be verified: ${ENDED}.` }
    }
  }
}
