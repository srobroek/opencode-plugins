import { parse, parsedInvocations } from "@srobroek/opencode-lib/shell-command"
import { shellCall } from "@srobroek/opencode-lib/tool-targets"

export const WAIT_REFUSAL = "agent-efficiency wait-guard: foreground `sleep` is refused. Run the wait as a background shell call (`background: true`), for example `gh pr checks 12 --watch`, `gh run watch 123 --exit-status`, or a loop that polls and exits; you are notified when it finishes. To wait for a local server, use `curl --retry 10 --retry-connrefused --retry-delay 1 <url>`."

export function runsSleep(command: string): boolean {
  const parsed = parse(command)
  if (parsedInvocations(parsed, "sleep").length > 0) return true
  if (parsed.commands.some((position) => position.executable === "then" && runsSleep(position.raw.slice(4)))) return true
  return parsedInvocations(parsed, "timeout", ["--foreground", "--preserve-status"]).some(({ position, args }) => {
    let at = 0
    while (args[at]?.startsWith("-")) {
      const flag = args[at++]
      if (flag === "--") break
      if (["-s", "--signal", "-k", "--kill-after"].includes(flag ?? "")) at++
    }
    at++ // duration
    const word = args[at]
    const offset = position.argv.length - args.length + at
    return word?.split("/").pop() === "sleep" && !position.words[offset]?.quoted
  })
}

export function waitRefusal(tool: string, input: unknown): string | undefined {
  const call = shellCall(tool, input)
  return call && call.background !== true && runsSleep(call.command) ? WAIT_REFUSAL : undefined
}
