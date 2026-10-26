/**
 * The AI-assistant attribution matcher, shared by the shell `attribution` gate and the
 * `commit-msg` hook. Kept free of other imports so the hook bundle stays small.
 */

const ATTRIBUTION =
  /co-authored-by:[^\n]{0,120}(?:claude|codex|gpt|copilot|cursor|devin|anthropic|openai|gemini)|generated (?:with|by) [[(]?(?:claude|codex|copilot|opencode|gemini)|noreply@(?:anthropic|openai)\.com/i

export function hasAttribution(text: string): boolean {
  return ATTRIBUTION.test(text)
}
