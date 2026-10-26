/**
 * A bounded subprocess for read-only discovery commands (`gh api`). Ported from
 * omp-plugins (`find-tools/extensions/find-tools-scan-tool.ts`).
 */

import { spawn } from "node:child_process"

import { EXIT_GRACE_MS, EXIT_POLL_MS, processAlive } from "@srobroek/opencode-lib/subprocess"

export type RunResult = { ok: boolean; stdout: string; stderr: string }
export type Run = (argv: string[], timeoutMs: number, signal?: AbortSignal) => Promise<RunResult>

const DEFAULT_MS = 10_000
const OUTPUT_LIMIT = 1_048_576

/**
 * Run `argv` without a shell. The process group is killed at the deadline, on
 * cancellation or when stdout and stderr together pass the output limit; a detached
 * descendant holding the pipes cannot keep the call open past a one-second grace.
 * A child that is gone without its exit reported (oven-sh/bun#41024) is stopped the
 * same way, so the call never waits on that event alone.
 */
export function defaultRun(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, stdout: "", stderr: "Cancelled before spawn" })
  const command = argv[0]
  if (!command) return Promise.resolve({ ok: false, stdout: "", stderr: "No command provided" })
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      let stopped = ""
      let settled = false
      let cleanup: ReturnType<typeof setTimeout> | undefined
      const finish = (code: number) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        clearInterval(poll)
        if (cleanup) clearTimeout(cleanup)
        signal?.removeEventListener("abort", abort)
        proc.stdout?.destroy()
        proc.stderr?.destroy()
        resolve({
          ok: !stopped && code === 0,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: [Buffer.concat(stderr).toString("utf8"), stopped].filter(Boolean).join("\n"),
        })
      }
      const stop = (reason: string) => {
        if (stopped || settled) return
        stopped = reason
        try {
          if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL")
          else proc.kill("SIGKILL")
        } catch {
          // Already exited.
        }
        cleanup = setTimeout(() => finish(1), 1_000)
      }
      const abort = () => stop("Cancelled")
      const ms = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, DEFAULT_MS)) : DEFAULT_MS
      const deadline = setTimeout(() => stop("Discovery command deadline exceeded"), ms)
      let goneSince: number | undefined
      let exitSeen = false
      const poll = setInterval(() => {
        if (exitSeen || !proc.pid || processAlive(proc.pid)) {
          goneSince = undefined
          return
        }
        goneSince ??= Date.now()
        if (Date.now() - goneSince >= EXIT_GRACE_MS) stop("Discovery command ended without reporting an exit status")
      }, EXIT_POLL_MS)
      poll.unref?.()
      const collect = (target: Buffer[], chunk: Buffer) => {
        if (stopped || settled) return
        const remaining = OUTPUT_LIMIT - bytes
        if (remaining > 0) {
          const kept = chunk.subarray(0, remaining)
          target.push(Buffer.from(kept))
          bytes += kept.length
        }
        if (chunk.length > remaining) stop("Discovery command output limit exceeded")
      }
      proc.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk))
      proc.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk))
      proc.on("error", (error) => {
        stopped = `Discovery command failed to start: ${error.message}`
        finish(1)
      })
      proc.on("exit", () => {
        exitSeen = true
      })
      proc.on("close", (code) => finish(code ?? 1))
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) })
    }
  })
}

export const OUTPUT_LIMIT_BYTES = OUTPUT_LIMIT
