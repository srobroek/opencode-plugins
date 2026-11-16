import type { Result } from "@opencode/plugin/promise/tool"
import { resultText, shellOutput } from "@srobroek/opencode-lib/shell-result"

/**
 * Text a shell result carries: the rendered content and the raw shell output,
 * which can differ when the rendered content was truncated.
 */
export function claimResultOutput(result: Result | undefined): string {
  const content = resultText(result)
  const output = shellOutput(result) ?? ""
  return content === output ? content : [content, output].filter(Boolean).join("\n")
}

/** The same text as separate readings, raw shell output first, so JSON can be read from one without the other's noise. */
export function claimResultTexts(result: Result | undefined): string[] {
  const output = shellOutput(result)
  const content = resultText(result)
  return [output, content].filter((text): text is string => text !== undefined && text !== "")
}
