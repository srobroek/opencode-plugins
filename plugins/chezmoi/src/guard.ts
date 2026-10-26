/**
 * Refuses writes to a chezmoi-managed live target: the next `chezmoi apply`
 * overwrites the target from source, so the edit is lost. The refusal names the
 * source path to edit instead. Ported from omp-plugins (`chezmoi/extensions/chezmoi-guard.ts`).
 *
 * Coverage is literal and static, never a shell sandbox. The write targets come from
 * `writtenPaths` in the shared lib: `edit`/`write` paths, `patch` file headers, and
 * the redirects, `tee`, `cp`/`mv`, `sed -i` and `perl -i` targets of a `shell` call.
 */

import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { under } from "@srobroek/opencode-lib/shell-write-targets"
import { supervise } from "@srobroek/opencode-lib/subprocess"
import { shellCall, writtenPaths } from "@srobroek/opencode-lib/tool-targets"

export const SUBPROCESS_TIMEOUT_MS = 2000
/** `chezmoi add`/`forget` from another terminal change the managed set without any call the guard sees. */
export const MANAGED_TTL_MS = 5000

/** `chezmoi` as a command word: its subcommands (`add`, `forget`, …) change the managed set. */
const CHEZMOI_RUN = /(?:^|[\s;&|(/])chezmoi(?:\s|$)/

/** Runs `chezmoi <args>`; resolves to stdout, or `null` when it fails, times out or is missing. */
export type Spawn = (args: string[]) => Promise<string | null>

export const spawnChezmoi: Spawn = async (args) => {
  try {
    const proc = Bun.spawn(["chezmoi", ...args], { stdout: "pipe", stderr: "ignore" })
    const run = await supervise(proc, { timeoutMs: SUBPROCESS_TIMEOUT_MS })
    return run.kind === "exited" && run.exitCode === 0 ? run.stdout : null
  } catch {
    return null
  }
}

function normalized(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export type GuardOptions = {
  spawn?: Spawn
  now?: () => number
  home?: string
  ttlMs?: number
}

export type Guard = {
  /** The refusal for a tool call, or `undefined` when it writes no managed target. */
  decide: (tool: string, input: unknown, cwd: string) => Promise<string | undefined>
  /** Drop the cached managed list. */
  invalidate: () => void
}

export function refusal(target: string, source: string | undefined): string {
  const hint = source ? `'${source}'` : `the path \`chezmoi source-path ${target}\` prints`
  return (
    `'${target}' is a chezmoi-managed target, not the source; the next chezmoi apply overwrites it. ` +
    `Edit the source at ${hint}, then run chezmoi apply. Do not write the live home-directory copy.`
  )
}

export function createGuard(options: GuardOptions = {}): Guard {
  const spawn = options.spawn ?? spawnChezmoi
  const now = options.now ?? Date.now
  const home = options.home ?? homedir()
  const ttl = options.ttlMs ?? MANAGED_TTL_MS
  let managed: Set<string> | null = null
  /** Real path to managed path, built on the first miss after each load. */
  let aliases: Map<string, string> | null = null
  let managedAt = 0
  let sourceDir: string | null | undefined

  const invalidate = () => {
    managed = null
    aliases = null
  }

  const loadSourceDir = async (): Promise<string | null> => {
    if (sourceDir !== undefined) return sourceDir
    const out = await spawn(["source-path"])
    sourceDir = out?.trim() || null
    return sourceDir
  }

  const loadManaged = async (): Promise<Set<string> | null> => {
    if (managed && now() - managedAt < ttl) return managed
    const out = await spawn(["managed", "--path-style=absolute"])
    if (out === null) return null
    managed = new Set(
      out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
    aliases = null
    managedAt = now()
    return managed
  }

  const managedTarget = (set: Set<string>, abs: string): string | undefined => {
    if (set.has(abs)) return abs
    aliases ??= new Map([...set].map((path) => [normalized(path), path]))
    return aliases.get(normalized(abs))
  }

  const considerPath = async (abs: string): Promise<string | undefined> => {
    if (!under(abs, home) && !under(normalized(abs), normalized(home))) return undefined
    const source = await loadSourceDir()
    if (source && (under(abs, source) || under(normalized(abs), normalized(source)))) {
      // A source edit changes what `chezmoi managed` lists after the next apply.
      invalidate()
      return undefined
    }
    const set = await loadManaged()
    if (!set) return undefined
    const target = managedTarget(set, abs)
    if (!target) return undefined
    return refusal(abs, (await spawn(["source-path", target]))?.trim() || undefined)
  }

  return {
    invalidate,
    decide: async (tool, input, cwd) => {
      const shell = shellCall(tool, input)
      if (shell && CHEZMOI_RUN.test(shell.command)) invalidate()
      for (const abs of writtenPaths(tool, input, cwd)) {
        const reason = await considerPath(abs)
        if (reason) return reason
      }
      return undefined
    },
  }
}
