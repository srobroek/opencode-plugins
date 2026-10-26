/**
 * Bounded subprocesses for the permission gates.
 *
 * OpenCode puts no timeout on a hook, so a hung `git` or `gh` would hang the tool call.
 * Every probe one decision starts is bounded twice: by its own timeout, and by what is
 * left of one budget shared across the whole decision. Probes run asynchronously so a
 * slow repository never blocks the server's event loop.
 */

/** Per subprocess. */
export const CALL_TIMEOUT_MS = 10_000
/** For every subprocess one decision starts. */
export const DECISION_BUDGET_MS = 25_000

/** A subprocess outlived its own timeout or the decision's budget; the message names the command. */
export class ProbeTimeout extends Error {}

export type SpawnResult = { exitCode: number; stdout: string }

/** Runs `argv` in `cwd` for at most `timeoutMs`: null when it cannot start, ProbeTimeout when it outlives the bound. */
export type Spawner = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
) => Promise<SpawnResult | null>

function label(argv: string[]): string {
  return argv.slice(0, 3).join(" ")
}

export const spawnWithin: Spawner = async (argv, cwd, timeoutMs, env) => {
  if (timeoutMs <= 0) throw new ProbeTimeout(label(argv))
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>
  try {
    child = Bun.spawn(argv, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
  } catch {
    return null
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, timeoutMs)
  try {
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (timedOut) throw new ProbeTimeout(label(argv))
    return { exitCode, stdout }
  } finally {
    clearTimeout(timer)
  }
}

export type Budget = {
  remainingMs: () => number
  /** `spawn`, capped by what is left of the budget; throws ProbeTimeout once it is spent. */
  run: (argv: string[], cwd: string, env?: Record<string, string>) => Promise<SpawnResult | null>
}

export type Bounds = { timeoutMs?: number; budgetMs?: number; spawn?: Spawner }

export function budget(bounds: Bounds = {}): Budget {
  const timeoutMs = bounds.timeoutMs ?? CALL_TIMEOUT_MS
  const deadline = Date.now() + (bounds.budgetMs ?? DECISION_BUDGET_MS)
  const spawn = bounds.spawn ?? spawnWithin
  const remainingMs = () => deadline - Date.now()
  return {
    remainingMs,
    run: (argv, cwd, env) => spawn(argv, cwd, Math.min(timeoutMs, remainingMs()), env),
  }
}

/** Output of a git call, or null when it fails to start or exits non-zero. */
export async function gitOut(run: Budget["run"], args: string[], cwd: string): Promise<string | null> {
  const result = await run(["git", ...args], cwd)
  return result?.exitCode === 0 ? result.stdout : null
}
