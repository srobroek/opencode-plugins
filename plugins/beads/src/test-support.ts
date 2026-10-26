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
