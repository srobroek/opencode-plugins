/**
 * Pattern gates for `permission.hook("evaluate")`.
 *
 * Patterns use OpenCode's permission wildcard syntax: `*` matches any run of
 * characters, `?` matches one, and a trailing ` *` also matches the bare command,
 * so `git push *` matches both `git push` and `git push origin main`.
 */

export type PermissionEffect = "allow" | "deny" | "ask"

export type PatternRule = {
  pattern: string
  effect: PermissionEffect
  message?: string
  /** Limit the rule to one permission action (wildcards allowed); any action when omitted. */
  action?: string
}

export type PatternDecision = {
  effect: PermissionEffect
  message?: string
  /** The rule pattern that matched. */
  pattern: string
  /** The evaluation resource it matched. */
  resource: string
}

/** The evaluation fields a gate reads and writes. */
export type Evaluation = {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  effect: PermissionEffect
  message?: string
}

const compiled = new Map<string, RegExp>()

function compile(pattern: string): RegExp {
  let regex = compiled.get(pattern)
  if (regex === undefined) {
    let source = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`
    regex = new RegExp(`^${source}$`, "s")
    compiled.set(pattern, regex)
  }
  return regex
}

/** Whether `value` matches the wildcard `pattern`. */
export function wildcardMatch(value: string, pattern: string): boolean {
  return compile(pattern).test(value)
}

/**
 * The decision of the first rule, in order, whose pattern matches any of the
 * resources, or `undefined` when none does.
 */
export function matchPatterns(
  resources: ReadonlyArray<string>,
  rules: ReadonlyArray<PatternRule>,
  action?: string,
): PatternDecision | undefined {
  for (const rule of rules) {
    if (rule.action !== undefined && (action === undefined || !wildcardMatch(action, rule.action))) continue
    const resource = resources.find((candidate) => wildcardMatch(candidate, rule.pattern))
    if (resource === undefined) continue
    const decision: PatternDecision = { effect: rule.effect, pattern: rule.pattern, resource }
    if (rule.message !== undefined) decision.message = rule.message
    return decision
  }
  return undefined
}

/** Apply the first matching rule to an evaluation in place; returns the decision. */
export function applyPatterns(evaluation: Evaluation, rules: ReadonlyArray<PatternRule>): PatternDecision | undefined {
  const decision = matchPatterns(evaluation.resources, rules, evaluation.action)
  if (decision === undefined) return undefined
  evaluation.effect = decision.effect
  if (decision.message !== undefined) evaluation.message = decision.message
  return decision
}
