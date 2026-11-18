/**
 * A short-lived on-disk cache of verified gate verdicts, shared between hook processes.
 *
 * A Claude Code hook is a new process per tool call, so the in-memory verdicts of
 * `GateAdmitter` die with it. A verification that outlasts one hook's wait is finished by a
 * detached process that stores the verdict here, and the retry reads it. Only a verified
 * verdict is stored, only for `VERDICT_TTL_MS`, and anything unreadable, expired or from a
 * directory other users can reach counts as no verdict, so the gate still refuses.
 */

import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { GateVerdict } from "./gate-admission.ts"

/** How long a stored verified verdict is trusted. */
export const VERDICT_TTL_MS = 60_000

/** How long one detached verification may hold the claim before another may start. */
export const PENDING_MS = 150_000

/** Where gate verdicts persist between processes. */
export interface VerdictStore {
  read(storeDir: string): GateVerdict | undefined
  write(storeDir: string, verdict: GateVerdict): void
  /** True when the caller may start the one detached verification for this store. */
  claimPending(storeDir: string): boolean
}

export class FileVerdictCache implements VerdictStore {
  readonly #dir: string
  readonly #now: () => number

  constructor(dir = join(tmpdir(), `beads-gate-verdicts-${process.getuid?.() ?? "user"}`), now: () => number = Date.now) {
    this.#dir = dir
    this.#now = now
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

  #file(storeDir: string, kind: "json" | "pending"): string {
    return join(this.#dir, `${createHash("sha256").update(storeDir).digest("hex")}.${kind}`)
  }

  read(storeDir: string): GateVerdict | undefined {
    if (!this.#usable()) return undefined
    try {
      const stored = JSON.parse(readFileSync(this.#file(storeDir, "json"), "utf8")) as {
        at?: unknown
        verdict?: { verified?: unknown; notice?: unknown }
      }
      const { at, verdict } = stored
      if (typeof at !== "number" || at > this.#now() || this.#now() - at >= VERDICT_TTL_MS) return undefined
      if (verdict?.verified !== true) return undefined
      return typeof verdict.notice === "string" ? { verified: true, notice: verdict.notice } : { verified: true }
    } catch {
      return undefined
    }
  }

  write(storeDir: string, verdict: GateVerdict): void {
    if (!verdict.verified || !this.#usable()) return
    const file = this.#file(storeDir, "json")
    const temporary = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ at: this.#now(), verdict }), { mode: 0o600 })
      renameSync(temporary, file)
      rmSync(this.#file(storeDir, "pending"), { force: true })
    } catch {
      rmSync(temporary, { force: true })
    }
  }

  claimPending(storeDir: string): boolean {
    if (!this.#usable()) return false
    const file = this.#file(storeDir, "pending")
    try {
      const at = Number(readFileSync(file, "utf8"))
      if (Number.isFinite(at) && this.#now() - at < PENDING_MS) return false
    } catch {
      // No claim yet.
    }
    try {
      writeFileSync(file, String(this.#now()), { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}
