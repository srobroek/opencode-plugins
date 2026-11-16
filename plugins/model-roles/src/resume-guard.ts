/**
 * Pure guard decision for a resumed subagent. The host keeps a resumed child on the model
 * it already runs, so a model the guard has refused since the child spawned must be
 * switched away from, not just left out of the resume.
 */

import { type ModelRef, modelText, type Options, parseCandidate } from "./resolve.ts"

export type ResumeFacts = {
  /** The model the child runs on now; `undefined` when nothing says. */
  current: ModelRef | undefined
  /** The guard's reason for refusing `current`; `undefined` when it accepts it. */
  refused: string | undefined
  /** The child's tier (snapshot tier, else its spawn-role tier). */
  tier: string | undefined
  /** The tier's usable candidates in order, each with the guard's verdict. */
  candidates: ReadonlyArray<{ model: ModelRef; allowed: boolean }>
  /** Allowed candidates left out because the child's prompt already overflowed them, with their context window. */
  overflowed?: ReadonlyArray<{ model: ModelRef; limit?: number }>
}

export type ResumeDecision = { action: "keep" } | { action: "switch"; model: ModelRef } | { action: "refuse"; reason: string }

/** Keep an accepted model; otherwise switch to the tier's first accepted candidate, else refuse. */
export function resumeGuard(facts: ResumeFacts): ResumeDecision {
  if (facts.current === undefined || facts.refused === undefined) return { action: "keep" }
  const allowed = facts.candidates.find((c) => c.allowed)
  if (allowed !== undefined) return { action: "switch", model: allowed.model }
  const spent = facts.overflowed ?? []
  if (spent.length > 0) {
    const list = spent.map((c) => `${modelText(c.model)} (${c.limit === undefined ? "unknown limit" : `${c.limit} tokens`})`).join(", ")
    const which = spent.length === 1 ? `The only allowed candidate, ${list}, already` : `The allowed candidates, ${list}, already`
    return {
      action: "refuse",
      reason: `This resume would run on ${modelText(facts.current)}, which the guard refuses. ${which} overflowed its context; compact the session or start a new one.\n${facts.refused}`,
    }
  }
  const where = facts.tier === undefined ? "the child has no tier to switch within" : `no candidate of tier '${facts.tier}' passes the guard`
  return { action: "refuse", reason: `This resume would run on ${modelText(facts.current)}, which the guard refuses, and ${where}.\n${facts.refused}` }
}

/** Every model a tier lists, following `@tier` links depth-first; a link back into the chain is skipped. */
export function tierModels(roles: Options["roles"], tier: string | undefined): ModelRef[] {
  const found: ModelRef[] = []
  const walk = (role: string, chain: string[]) => {
    for (const entry of roles[role] ?? []) {
      const candidate = parseCandidate(entry)
      if (candidate === undefined) continue
      if (candidate.kind === "model") found.push(candidate.ref)
      else if (!chain.includes(candidate.role) && Object.hasOwn(roles, candidate.role)) walk(candidate.role, [...chain, candidate.role])
    }
  }
  if (tier !== undefined && Object.hasOwn(roles, tier)) walk(tier, [tier])
  return found
}
