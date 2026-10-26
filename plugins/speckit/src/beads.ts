/** Whether a beads workspace is active in a directory, as `bd where` decides. */

export const PROBE_TIMEOUT_MS = 10_000

export type Spawn = (argv: string[], timeoutMs: number) => Promise<number>

const spawnExit: Spawn = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: timeoutMs,
    env: { ...process.env, BD_NON_INTERACTIVE: "1", BD_NO_PAGER: "1", PAGER: "cat" },
  })
  return proc.exited
}

/** `bd -C <directory> where` exits 0. Any failure, including a missing `bd`, reads as inactive. */
export async function beadsActive(directory: string, spawn: Spawn = spawnExit): Promise<boolean> {
  try {
    return (await spawn(["bd", "-C", directory, "where"], PROBE_TIMEOUT_MS)) === 0
  } catch {
    return false
  }
}
