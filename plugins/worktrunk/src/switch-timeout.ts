import { commandWords, scanShell, shellCall } from "@srobroek/opencode-lib"

/**
 * `wt switch` runs the post-create and pre-start hooks in the foreground. A shell tool
 * timeout (default 120000 ms) kills the hook with SIGTERM and leaves a half-provisioned
 * worktree, so a `wt switch` call gets at least this long.
 */
export const SWITCH_TIMEOUT_MS = 600_000

const GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "--config", "--config-set"])

/** Whether a `wt [globals] switch ...` argv. */
function isSwitch(argv: readonly string[]): boolean {
  if (argv[0]?.split("/").pop() !== "wt") return false
  let index = 1
  while (argv[index]?.startsWith("-")) index += GLOBAL_VALUE_OPTIONS.has(argv[index] ?? "") ? 2 : 1
  return argv[index] === "switch" && !argv.includes("--help") && !argv.includes("-h")
}

/** Whether a command source runs `wt switch` as a simple command. */
export function namesSwitchCommand(source: string): boolean {
  if (!/\bswitch\b/.test(source)) return false
  return scanShell(source).items.some(
    (item) => item.kind === "command" && isSwitch(commandWords(item.words.map((word) => word.value)).argv),
  )
}

/**
 * The input with `timeout` raised to `SWITCH_TIMEOUT_MS` when a foreground shell call runs
 * `wt switch` with no timeout or a shorter one; `undefined` when it needs no change.
 * A background call has no timeout by default and is left alone.
 */
export function withSwitchTimeout(tool: string, input: unknown): Record<string, unknown> | undefined {
  const call = shellCall(tool, input)
  if (!call || call.background === true || !namesSwitchCommand(call.command)) return undefined
  if (call.timeout !== undefined && (call.timeout === 0 || call.timeout >= SWITCH_TIMEOUT_MS)) return undefined
  // Only an object input has a timeout field to raise; a raw-string alias input stays as is.
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return { ...(input as Record<string, unknown>), timeout: SWITCH_TIMEOUT_MS }
}
