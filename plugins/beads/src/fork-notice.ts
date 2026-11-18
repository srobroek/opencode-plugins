import type { ClaimState } from "./claims.ts"

const MAX_LISTED = 10

/**
 * The notice a forked session gets about the claims its original holds, or `undefined` when
 * the original holds none. Claims stay with the original; the fork only learns of them.
 */
export function forkNotice(original: string, state: ClaimState): string | undefined {
  const ids = [...new Set(Object.values(state.claims).map((claim) => claim.id))]
  if (ids.length === 0) return undefined
  const listed = ids.slice(0, MAX_LISTED).join(", ")
  const more = ids.length > MAX_LISTED ? ` and ${ids.length - MAX_LISTED} more` : ""
  return `This session is a fork of ${original}. That session holds ${listed}${more}; this one holds no claims. Claim before working on a bead (bd update <id> --claim), or pick other work.`
}
