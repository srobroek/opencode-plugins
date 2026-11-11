import { commandWords } from "@srobroek/opencode-lib/command-words"
import { scanShell } from "@srobroek/opencode-lib/shell-command"
import { shellCall } from "@srobroek/opencode-lib/tool-targets"
import { CONTROL_PREFIXES, commandScripts } from "./shell-scripts.ts"

export const WAIT_REFUSAL = "agent-efficiency wait-guard: foreground `sleep` is refused. Run the wait as a background shell call (`background: true`), for example `gh pr checks 12 --watch`, `gh run watch 123 --exit-status`, or a loop that polls and exits; you are notified when it finishes. To wait for a local server, use `curl --retry 10 --retry-connrefused --retry-delay 1 <url>`."

export function runsSleep(command: string, depth = 0): boolean {
  if (depth > 32) return false
  const scan = scanShell(command, { executableSubstitutionsOnly: true })
  if (scan.substitutions.some((source) => runsSleep(source, depth + 1))) return true
  for (const item of scan.items) {
    if (item.kind !== "command") continue
    const words = [...item.words]
    while (words[0] && !words[0].quoted && CONTROL_PREFIXES.has(words[0].value)) words.shift()
    const { argv } = commandWords(words.map((word) => word.value))
    const executable = words[words.length - argv.length]
    if (!executable || executable.quoted || executable.expands) continue
    const name = argv[0]?.split("/").pop()
    if (name === "sleep") return true
    if (commandScripts(argv, item.hereDocuments).some((source) => runsSleep(source, depth + 1))) return true
  }
  return false
}

export function waitRefusal(tool: string, input: unknown): string | undefined {
  const call = shellCall(tool, input)
  return call && call.background !== true && runsSleep(call.command) ? WAIT_REFUSAL : undefined
}
