/**
 * Advisory after a shell call that installs a CVE scanner persistently during a
 * dependency audit. Ported from the omp-plugins `dep-update-no-scanner-install` rule,
 * whose condition was a regex over streamed tool arguments; this reads the command
 * with the shared static lexer instead. It never stops the command: it runs on
 * `execute.after`, when the install has already happened.
 */

import { commandWords } from "@srobroek/opencode-lib/command-words"
import { tokenizeShell } from "@srobroek/opencode-lib/shell-tokenizer"

export const SCANNERS: ReadonlySet<string> = new Set(["pip-audit", "osv-scanner", "cargo-audit", "govulncheck"])

export const SCANNER_ADVISORY =
  "dep-update: this command installed a CVE scanner persistently. A dependency audit is read-only; " +
  "say in the report that the toolchain changed. Prefer an ephemeral runner (`uvx pip-audit`, " +
  "`go run golang.org/x/vuln/cmd/govulncheck@latest`, " +
  "`go run github.com/google/osv-scanner/v2/cmd/osv-scanner@latest`, or the package manager's own " +
  "`npm audit`/`pnpm audit`/`yarn npm audit`). `cargo-audit` has no ephemeral runner: use it only when " +
  "`command -v cargo-audit` finds it. A missing scanner is a reported coverage gap " +
  "(`scanner not available: <name>`), not a task; an unrun scanner never reads as clean."

const SEPARATORS: ReadonlySet<string> = new Set([";", "&", "|", "\n", "(", ")", "$("])
/** Reserved words that may open a simple command (`if x; then pip install y; fi`). */
const KEYWORDS: ReadonlySet<string> = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"])
const MAX_DEPTH = 8

/** The words of every simple command at command position, wrappers dropped. */
function simpleCommands(command: string, depth = 0): string[][] {
  if (depth > MAX_DEPTH) return []
  const out: string[][] = []
  let words: string[] = []
  const flush = () => {
    let at = 0
    while (at < words.length && KEYWORDS.has(words[at] as string)) at++
    const argv = commandWords(words.slice(at)).argv
    if (argv.length > 0) out.push(argv)
    words = []
  }
  for (const token of tokenizeShell(command, { hereDocumentSubstitutionsOnly: true })) {
    if (token.sawQuote || !SEPARATORS.has(token.value)) words.push(token.value)
    else flush()
  }
  flush()
  for (const match of command.matchAll(/`([^`]*)`|\$\(([^()]*)\)/g)) {
    out.push(...simpleCommands(match[1] ?? match[2] ?? "", depth + 1))
  }
  return out
}

/** The package an install operand names: `pip-audit==2.7.0` and `golang.org/x/vuln/cmd/govulncheck@v1` alike. */
function packageName(operand: string): string {
  const bare = operand.split(/[=<>~!@[;]/, 1)[0] ?? ""
  return bare.slice(bare.lastIndexOf("/") + 1)
}

function base(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1)
}

/** The operands after the install verb when `argv` is a persistent install, else undefined. */
function installOperands(argv: readonly string[]): readonly string[] | undefined {
  const [first, ...rest] = argv
  if (first === undefined) return undefined
  const name = base(first)
  const verb = rest.findIndex((word) => !word.startsWith("-"))
  const sub = rest[verb]
  const after = rest.slice(verb + 1)
  if (/^python[\d.]*$/.test(name)) {
    const module = rest.indexOf("-m")
    if (module === -1 || rest[module + 1] !== "pip") return undefined
    return installOperands(["pip", ...rest.slice(module + 2)])
  }
  if (/^pip[\d.]*$/.test(name) || name === "pipx" || name === "brew") return sub === "install" ? after : undefined
  if (name === "uv") return sub === "tool" && after[0] === "install" ? after.slice(1) : undefined
  if (name === "cargo") return sub === "install" || sub === "binstall" ? after : undefined
  if (name === "go") return sub === "install" ? after : undefined
  if (name === "yarn") return sub === "global" && after[0] === "add" ? after.slice(1) : undefined
  if (name === "npm" || name === "pnpm" || name === "bun") {
    const global = rest.some((word) => word === "-g" || word === "--global")
    return global && (sub === "i" || sub === "install" || sub === "add") ? after : undefined
  }
  return undefined
}

/** The scanner a shell command installs persistently, or undefined when it installs none. */
export function persistentScannerInstall(command: string): string | undefined {
  for (const argv of simpleCommands(command)) {
    const operands = installOperands(argv)
    if (operands === undefined) continue
    for (const operand of operands) {
      if (operand.startsWith("-")) continue
      const name = packageName(operand)
      if (SCANNERS.has(name)) return name
    }
  }
  return undefined
}
