import { type BdInvocation, invocationActor } from "./bd-actor-gate.ts"
import { claimLookups } from "./claims.ts"
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
 * Who bd would report as the holder of each bead a command claims, worked out the way the shell
 * hands the actor to bd: `--actor`, else the invocation's environment. Stands in for `bd show`.
 */
export function simulatedHolders(
  cwd: string,
  env: NodeJS.ProcessEnv,
  output: string,
  invocations: BdInvocation[],
): Map<string, string> {
  const holders = new Map<string, string>()
  for (const lookup of claimLookups(cwd, env, output, invocations)) {
    const args = lookup.invocation.args
    const flag = args.findIndex((arg) => arg === "--actor" || arg.startsWith("--actor="))
    const named =
      flag < 0 ? undefined : args[flag]?.includes("=") ? args[flag]?.split("=").slice(1).join("=") : args[flag + 1]
    const holder = named ?? invocationActor(lookup.invocation, env)
    if (holder !== null && holder !== undefined) holders.set(lookup.key, holder)
  }
  return holders
}
