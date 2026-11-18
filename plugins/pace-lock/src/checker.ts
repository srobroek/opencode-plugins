import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export const CHECK_TIMEOUT_MS = 5000

export type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean; failed: boolean }

/** `$PACE_LOCK_BIN`, else `~/.local/bin/pace-lock`. */
export function checkerBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.PACE_LOCK_BIN || join(homedir(), ".local", "bin", "pace-lock")
}

/** Run the checker with no shell. A missing binary, a spawn error or a timeout sets `failed` or `timedOut`. */
export function runChecker(bin: string, args: string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    const done = (run: Omit<Run, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...run, stdout, stderr, timedOut })
    }
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
      done({ code: null, failed: true })
    }, options.timeoutMs ?? CHECK_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk
    })
    child.on("error", () => done({ code: null, failed: true }))
    child.on("close", (code) => done({ code, failed: code === null }))
    child.stdin.on("error", () => {})
    child.stdin.end(options.stdin ?? "")
  })
}

export type Verdict = { allow: true } | { allow: false; reason: string }

/** Exit 0 allows, exit 2 blocks with the checker's reason, and every other result blocks. */
export function verdict(run: Run): Verdict {
  if (!run.failed && run.code === 0) return { allow: true }
  if (run.code === 2) return { allow: false, reason: run.stdout.trim() || "PACE lock: the checker blocked this call." }
  const why = run.timedOut ? "the checker timed out" : run.code === null ? "the checker could not run" : `the checker exited ${run.code}`
  return { allow: false, reason: `PACE lock: ${why}, so the call is blocked.` }
}
