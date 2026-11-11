import { commandWords } from "@srobroek/opencode-lib/command-words"
import { scanShell } from "@srobroek/opencode-lib/shell-command"
import { shellCall } from "@srobroek/opencode-lib/tool-targets"

export const WAIT_REFUSAL = "agent-efficiency wait-guard: foreground `sleep` is refused. Run the wait as a background shell call (`background: true`), for example `gh pr checks 12 --watch`, `gh run watch 123 --exit-status`, or a loop that polls and exits; you are notified when it finishes. To wait for a local server, use `curl --retry 10 --retry-connrefused --retry-delay 1 <url>`."

export function runsSleep(command: string, depth = 0): boolean {
  if (depth > 32) return false
  const scan = scanShell(command)
  if (scan.substitutions.some((source) => runsSleep(source, depth + 1))) return true
  for (const item of scan.items) {
    if (item.kind !== "command") continue
    const words = [...item.words]
    while (words[0] && !words[0].quoted && ["if", "then", "elif", "else", "while", "until", "do", "!"].includes(words[0].value)) words.shift()
    const { argv } = commandWords(words.map((word) => word.value))
    const executable = words[words.length - argv.length]
    if (!executable || executable.quoted || executable.expands) continue
    const name = argv[0]?.split("/").pop()
    if (name === "sleep") return true
    if (!["sh", "bash", "zsh", "dash", "ksh"].includes(name ?? "")) continue
    let stdin = true
    let stdinFlag = false
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] as string
      if (/^-[^-]*c/.test(arg)) {
        if (runsSleep(argv[i + 1] ?? "", depth + 1)) return true
        stdin = false
        break
      }
      if (/^-[^-]*[oO]$/.test(arg) || arg === "--rcfile" || arg === "--init-file") { i++; continue }
      if (/^-[^-]*s/.test(arg)) stdinFlag = true
      if (arg === "--") continue
      if (!arg.startsWith("-")) { stdin = stdinFlag; break }
    }
    if (stdin && item.hereDocuments.some((document) => runsSleep(document.body, depth + 1))) return true
  }
  return false
}

export function waitRefusal(tool: string, input: unknown): string | undefined {
  const call = shellCall(tool, input)
  return call && call.background !== true && runsSleep(call.command) ? WAIT_REFUSAL : undefined
}
