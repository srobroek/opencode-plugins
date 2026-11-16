import { GateAdmitter } from "./gate-admission.ts"
import type { ShellGateDeps } from "./shell-gates.ts"

/** Shell-gate dependencies that never reach `bd`, `gh` or a real runner unless a test asks. */
export function gateDeps(overrides: Partial<ShellGateDeps> = {}): ShellGateDeps {
  return {
    options: {},
    actor: undefined,
    env: { ...process.env, BEADS_DIR: "", BEADS_ACTOR: undefined, BD_ACTOR: undefined },
    admitter: new GateAdmitter(async () => ({ output: "null" })),
    callID: "call_test",
    deadline: Date.now() + 5_000,
    runnerLookup: () => ({ interpreter: "/opt/bun", script: "/opt/beads/src/bd-embedded-write-runner.ts" }),
    repositoryControl: () => false,
    ...overrides,
  }
}

/**
 * A stand-in for what `bd show` reports as each bead's holder, specified by the test rather than
 * derived from the command: `table` maps bead ids to holders, `fallback` holds every other bead.
 */
export function fixtureHolders(table: Record<string, string> = {}, fallback?: string): Map<string, string> {
  return new (class extends Map<string, string> {
    override get(key: string): string | undefined {
      return table[key.slice(key.lastIndexOf("\0") + 1)] ?? fallback
    }
  })()
}
