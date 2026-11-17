import { bdInvocations } from "./bd-actor-gate.ts"
import { type ClaimState, confirmClaims, inspectClaim, recordClaimTransitions } from "./claims.ts"
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

/** What bd 1.3.1 prints for `--json` after a claim succeeds: one issue object per bead, leased to its assignee. */
export function claimJson(held: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(held).map(([id, assignee]) => ({
      id,
      status: "in_progress",
      assignee,
      lease_expires_at: "2026-09-14T12:39:56Z",
      heartbeat_at: "2026-09-14T12:34:56Z",
    })),
  )
}

/** Track a finished command the way `execute.after` does: only a claim bd's own output confirms is recorded. */
export function recordResult(
  state: ClaimState,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  output: string,
  injected?: string,
): void {
  const inspected = inspectClaim(command, cwd, env, { injected, inherited: {} })
  const confirmed = inspected.kind === "claim" ? confirmClaims(inspected.plan, [output]).confirmed : []
  recordClaimTransitions(state, command, cwd, env, bdInvocations(command), confirmed)
}
