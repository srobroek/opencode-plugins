/**
 * Waiting on a child process without trusting its exit event.
 *
 * Bun on macOS can lose a child's exit notification (oven-sh/bun#39709, #41024): the
 * child is gone and its pipes are closed, but `exited` never settles, and neither does
 * anything awaiting it. {@link supervise} never depends on that event alone. A deadline
 * kills the child (or its whole process group) and resolves after a grace period
 * whether or not the exit arrives, and a poll of `kill(pid, 0)` notices a child that
 * disappeared without its exit being reported.
 */

export type SupervisedChild = {
  readonly pid: number
  readonly exited: Promise<number>
  readonly signalCode?: string | null
  readonly stdout?: unknown
  readonly stderr?: unknown
  kill(signal?: number | NodeJS.Signals): void
}

/**
 * `exited`: the exit event arrived and the pipes drained. `timeout` and `aborted`: the
 * child was killed. `lost`: the child disappeared and no exit status was reported, so
 * the run is not an observation of anything.
 */
export type SupervisedRun =
  | { kind: "exited"; exitCode: number; signalCode: string | null; stdout: string; stderr: string }
  | { kind: "timeout"; stdout: string; stderr: string }
  | { kind: "aborted"; stdout: string; stderr: string }
  | { kind: "lost"; stdout: string; stderr: string }

export type SuperviseOptions = {
  /** Kill the child and stop waiting after this long; omit, 0 or Infinity for no deadline. */
  timeoutMs?: number
  signal?: AbortSignal
  /** The child leads its own process group (spawned `detached`): end the whole group. */
  group?: boolean
  /** How long to wait for the exit and the pipes once the child is killed or found gone. */
  graceMs?: number
  /** How often to check that the child still exists. */
  pollMs?: number
  /** Let the process exit while this child is still being waited on (its timers are unreferenced). */
  unref?: boolean
  /** Whether `pid` still exists; replaceable in tests. */
  alive?: (pid: number) => boolean
}

export const EXIT_GRACE_MS = 2_000
export const EXIT_POLL_MS = 100

/** Whether a process with this pid exists (a zombie still does). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** SIGKILL the child's process group when it leads one, else the child. Never throws. */
export function killChild(child: Pick<SupervisedChild, "pid" | "kill">, group: boolean): void {
  if (group) {
    try {
      process.kill(-child.pid, "SIGKILL")
      return
    } catch {
      // No group left to signal; the direct child is the last thing to stop.
    }
  }
  try {
    child.kill("SIGKILL")
  } catch {
    // Already reaped.
  }
}

function unref(timer: unknown): void {
  ;(timer as { unref?: () => void }).unref?.()
}

type Capture = { text: Promise<string>; snapshot: () => string; cancel: () => void }

function capture(stream: unknown): Capture {
  if (!(stream instanceof ReadableStream)) return { text: Promise.resolve(""), snapshot: () => "", cancel: () => {} }
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let collected = ""
  const text = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        collected += decoder.decode(chunk.value, { stream: true })
      }
    } catch {
      // A cancelled or failed read ends the capture; the bytes already read stay.
    }
    collected += decoder.decode()
    return collected
  })()
  const cancel = (): void => {
    try {
      void reader.cancel().catch(() => undefined)
    } catch {
      // Already released or closed.
    }
  }
  return { text, snapshot: () => collected, cancel }
}

/**
 * Collect a spawned child's piped stdout and stderr and its exit status. Never throws
 * and always settles: at the latest `graceMs` after the deadline or abort, or after the
 * child is found gone with no exit reported. Ending the run cancels the pipe readers, so
 * a descendant that inherited them cannot hold the call open either.
 *
 * Timers start synchronously, so a caller may write the child's stdin after calling this.
 */
export function supervise(child: SupervisedChild, options: SuperviseOptions = {}): Promise<SupervisedRun> {
  const grace = Math.max(0, options.graceMs ?? EXIT_GRACE_MS)
  const pollMs = Math.max(1, options.pollMs ?? EXIT_POLL_MS)
  const alive = options.alive ?? processAlive
  const group = options.group ?? false
  const { signal, timeoutMs } = options
  const out = capture(child.stdout)
  const err = capture(child.stderr)
  return new Promise((resolve) => {
    let ended: "timeout" | "aborted" | "lost" | null = null
    let exitSeen = false
    let settled = false
    let goneSince: number | null = null
    let deadline: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (run: SupervisedRun): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(graceTimer)
      clearInterval(poller)
      signal?.removeEventListener("abort", onAbort)
      resolve(run)
    }
    // `end` runs from raw timers and an abort listener, so every step is contained.
    const end = (cause: "timeout" | "aborted" | "lost"): void => {
      if (ended !== null || settled) return
      ended = cause
      // A child found gone may have had its pid reused; only its group is still worth ending.
      if (cause !== "lost" || group) killChild(child, group)
      out.cancel()
      err.cancel()
      graceTimer = setTimeout(() => settle({ kind: cause, stdout: out.snapshot(), stderr: err.snapshot() }), grace)
      if (options.unref) unref(graceTimer)
    }
    const onAbort = (): void => end("aborted")
    const poller = setInterval(() => {
      if (exitSeen || ended !== null || settled) return
      if (alive(child.pid)) {
        goneSince = null
        return
      }
      goneSince ??= Date.now()
      if (Date.now() - goneSince >= grace) end("lost")
    }, pollMs)
    unref(poller)
    if (timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      deadline = setTimeout(() => end("timeout"), timeoutMs)
      if (options.unref) unref(deadline)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.exited.then(
      () => {
        exitSeen = true
      },
      () => undefined,
    )
    Promise.all([child.exited, out.text, err.text]).then(
      ([exitCode, stdout, stderr]) => {
        if (ended !== null) settle({ kind: ended, stdout, stderr })
        else settle({ kind: "exited", exitCode, signalCode: child.signalCode ?? null, stdout, stderr })
      },
      () => end("lost"),
    )
  })
}
