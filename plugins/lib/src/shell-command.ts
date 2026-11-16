import { resolve } from "node:path"
import { shellQuoteBalanced, tokenizeShell } from "./shell-tokenizer.ts"

/*
 * Design scope of this parser, shared by the beads close, update-close, unclaim and actor
 * gates, the embedded-write lock and the agent-efficiency wait guard. It models the shell
 * syntax an agent normally writes: simple commands, pipelines and lists, groups, quoting,
 * command, process and parameter substitutions, here-documents and here-strings, and
 * `bash -c` strings. It does not model shell semantics that need execution (aliases,
 * functions, `eval` of computed text, descriptor tables beyond fd 0), and it does not aim
 * to resist input written to defeat it. Where it cannot read a command it reports the
 * parse as unknown instead of guessing.
 */

/** A token in a command-position argv. Quoted words are data, not executable names. */
export type Token = { value: string; quoted: boolean }

const OPERATORS: Record<string, true> = {
  ";": true,
  "&&": true,
  "||": true,
  "&": true,
  "|": true,
  "\n": true,
  "(": true,
  ")": true,
  "{": true,
  "}": true,
}
const WRAPPERS: Record<string, true> = {
  mise: true,
  env: true,
  command: true,
  exec: true,
  nohup: true,
  nice: true,
  sudo: true,
  xargs: true,
  time: true,
  "!": true,
  if: true,
  elif: true,
  else: true,
  while: true,
  until: true,
  do: true,
}

/** Split shell source at operators outside quoted words. */
export function commandSegments(command: string): string[] {
  const out: string[] = []
  let start = 0
  let quote: "'" | '"' | null = null
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === "\\") escaped = true
      else if (ch === '"') quote = null
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === "&&" || two === "||") {
      out.push(command.slice(start, i), two)
      i++
      start = i + 1
      continue
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      out.push(command.slice(start, i), ch)
      start = i + 1
    }
  }
  out.push(command.slice(start))
  return out
}

/** Preserve the historical token surface used by non-bash lifecycle helpers. */
export function tokenize(segment: string): Token[] {
  return tokenizeShell(segment, { preserveBackslashes: true }).map(({ value, startsQuoted }) => ({
    value,
    quoted: startsQuoted,
  }))
}

/** Return argv beginning at a command name, accepting literal env/wrapper prefixes. */
export function invocation(segment: string, argv: string[]): Token[] | null {
  const tokens = tokenize(segment)
  const head = argv[0]
  if (!head) return null
  let start = 0
  while (start < tokens.length) {
    const token = tokens[start]
    if (!token || token.quoted) return null
    const basename = token.value.split("/").pop() ?? token.value
    if (basename === head) break
    if (basename === "env") {
      start++
      while (start < tokens.length) {
        const option = tokens[start]
        if (!option || option.quoted) return null
        const value = option.value
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
          start++
          continue
        }
        if (value === "--") {
          start++
          break
        }
        if (value === "-i" || value === "--ignore-environment") {
          start++
          continue
        }
        if (value === "-u" || value === "--unset") {
          start++
          if (start >= tokens.length || tokens[start]?.quoted) return null
          start++
          continue
        }
        if (value.startsWith("--unset=") || (value.startsWith("-u") && value.length > 2)) {
          start++
          continue
        }
        if (value.startsWith("-")) {
          start++
          continue
        }
        break
      }
      continue
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value) && !token.value.startsWith("-") && WRAPPERS[basename] !== true)
      return null
    start++
  }
  for (const [offset, word] of argv.entries()) {
    const token = tokens[start + offset]
    if (!token || token.quoted) return null
    const value = offset === 0 ? (token.value.split("/").pop() ?? token.value) : token.value
    if (value !== word) return null
  }
  return tokens.slice(start)
}

export function leadingCdCwd(command: string, cwd: string): string {
  const match = /^\s*cd\s+([^\s;&|]+)\s*&&/.exec(command)
  if (!match) return cwd
  const dir = match[1]
  if (!dir || /^[-~$]/.test(dir) || /[\\`"'*?\x5b\x5d{}]/.test(dir)) return cwd
  return dir.startsWith("/") ? dir : resolve(cwd, dir)
}

/** One shell word and where it sits in the scanned source. */
export type ShellWord = {
  /** Source offsets `[start, end)` of the word, quotes included. */
  start: number
  end: number
  /** The word after quote removal and escape processing; expansions stay verbatim. */
  value: string
  /** Some part of the word was quoted or escaped. */
  quoted: boolean
  /**
   * The shell rewrites the word before running it: a parameter, command, arithmetic
   * or process substitution, a leading tilde, or an unquoted glob or brace pattern.
   */
  expands: boolean
  /** On a redirection word: the operator is `<<<`, so the word is the here-string text. */
  hereString?: true
  /** On a redirection word: the operator, such as `<`, `<<`, `<<<`, `>` or `>&`. */
  operator?: string
  /** On a redirection word: the file descriptor written before the operator, such as `3`. */
  fd?: string
}

export type HereDocument = { body: string; quoted: boolean }

/** A simple command: its argument words, assignments included, and its redirections. */
export type SimpleCommand = {
  kind: "command"
  words: ShellWord[]
  /** Redirection targets, here-string words and here-document delimiters. */
  redirects: ShellWord[]
  hereDocuments: HereDocument[]
}

/** A control operator, or a `{` / `}` group word in command position. */
export type ShellOperator = { kind: "operator"; operator: string }

export type ShellScan = {
  /** Commands and operators in source order. */
  items: (SimpleCommand | ShellOperator)[]
  /**
   * The source of every command, process and parameter substitution, wherever it
   * appears: unquoted, inside double quotes, or in an unquoted here-document body.
   */
  substitutions: string[]
  /** False when a quote, substitution or here-document is left open. */
  complete: boolean
}

type Expansion = {
  end: number
  inner?: string
  expands: boolean
  closed: boolean
  executable?: boolean
  /** Found inside double quotes, so its own body follows double-quote rules whatever encloses it. */
  doubleQuoted?: true
}

/**
 * Split shell source into simple commands with exact word offsets, without evaluating it.
 *
 * A lexer like `tokenizeShell`, but positional: a caller that rewrites one command in
 * place needs to know where each word starts, and needs `2>&1`, `&>` and `>&` read as
 * redirections rather than as background operators. Nothing is expanded or run;
 * every substitution is returned as source for the caller to judge on its own.
 * With `executableSubstitutionsOnly`, only executable substitutions contribute source, including those inside parameter or arithmetic expansions.
 */
export function scanShell(source: string, options: { executableSubstitutionsOnly?: boolean } = {}): ShellScan {
  const items: (SimpleCommand | ShellOperator)[] = []
  const substitutions: string[] = []
  let complete = true
  let command: SimpleCommand = { kind: "command", words: [], redirects: [], hereDocuments: [] }
  let word: { start: number; value: string; quoted: boolean; expands: boolean } | undefined
  let target: "redirect" | "here-document" | "here-document-tabs" | undefined
  let targetHereString = false
  let targetOperator = ""
  let targetFd: string | undefined
  const pending: { delimiter: string; stripTabs: boolean; quoted: boolean; owner: SimpleCommand }[] = []

  const append = (at: number, text: string, quoted = false, expands = false): void => {
    word ??= { start: at, value: "", quoted: false, expands: false }
    word.value += text
    word.quoted ||= quoted
    word.expands ||= expands
  }
  const endCommand = (): void => {
    if (command.words.length > 0 || command.redirects.length > 0) items.push(command)
    command = { kind: "command", words: [], redirects: [], hereDocuments: [] }
  }
  const flush = (end: number): void => {
    if (word === undefined) return
    const done: ShellWord = { start: word.start, end, value: word.value, quoted: word.quoted, expands: word.expands }
    word = undefined
    if (target !== undefined) {
      if (targetHereString) done.hereString = true
      done.operator = targetOperator
      if (targetFd !== undefined) done.fd = targetFd
      command.redirects.push(done)
      if (target !== "redirect")
        pending.push({
          delimiter: done.value,
          stripTabs: target === "here-document-tabs",
          quoted: done.quoted,
          owner: command,
        })
      target = undefined
      return
    }
    // `{` and `}` are reserved only as whole words in command position; `{}` and
    // `a{b,c}` elsewhere are ordinary words.
    if (command.words.length === 0 && !done.quoted && (done.value === "{" || done.value === "}")) {
      endCommand()
      items.push({ kind: "operator", operator: done.value })
      return
    }
    command.words.push(done)
  }
  const operator = (at: number, value: string): void => {
    flush(at)
    target = undefined
    endCommand()
    items.push({ kind: "operator", operator: value })
  }
  const substitution = (expansion: Expansion, unquoted = false): void => {
    if (expansion.inner !== undefined) {
      if (expansion.executable) substitutions.push(expansion.inner)
      else {
        // The raw body is the source by default; callers that want only code skip it.
        if (!options.executableSubstitutionsOnly) substitutions.push(expansion.inner)
        // Unquoted, the body follows expansion rules, not command rules: quotes are honoured
        // and `#` is data, so `${X:-'$(cmd)'}` is a literal while `${X:-$(cmd)}`, `${X:-<(cmd)}`
        // and `${X:- #$(cmd)}` run. Inside double quotes the single quotes are literal, so
        // `"${X:-'$(cmd)'}"` runs `cmd`.
        const own = unquoted && expansion.doubleQuoted !== true
        const nested = own ? parameterBodySubstitutions(expansion.inner) : bodySubstitutions(expansion.inner)
        for (const found of nested) substitution(found, own)
      }
    }
    if (!expansion.closed) complete = false
  }
  /** Read every here-document queued on the line that just ended; returns the next offset. */
  const hereDocuments = (from: number): number => {
    let at = from
    while (pending.length > 0) {
      const document = pending.shift()
      if (document === undefined) break
      const bodyStart = at
      let bodyEnd = -1
      while (at <= source.length) {
        const newline = source.indexOf("\n", at)
        const lineEnd = newline < 0 ? source.length : newline
        const line = source.slice(at, lineEnd)
        if ((document.stripTabs ? line.replace(/^\t+/, "") : line) === document.delimiter) {
          bodyEnd = at
          at = newline < 0 ? source.length : newline + 1
          break
        }
        at = lineEnd + 1
      }
      const body = source.slice(bodyStart, bodyEnd < 0 ? source.length : bodyEnd)
      document.owner.hereDocuments.push({ body, quoted: document.quoted })
      // An unquoted body expands its substitutions in this shell, whatever reads it.
      if (!document.quoted) for (const found of bodySubstitutions(body)) substitution(found)
      if (bodyEnd < 0) {
        complete = false
        return source.length
      }
    }
    return at
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string
    const next = source[i + 1]
    if (ch === "\\") {
      // A backslash-newline is a line continuation and joins the two lines.
      if (next === "\n") i++
      else if (next === undefined) append(i, ch)
      else append(i++, next, true)
      continue
    }
    if (ch === "'") {
      const close = source.indexOf("'", i + 1)
      if (close < 0) complete = false
      append(i, source.slice(i + 1, close < 0 ? source.length : close), true)
      i = close < 0 ? source.length : close
      continue
    }
    if (ch === "$" && next === "'") {
      let j = i + 2
      while (j < source.length && source[j] !== "'") j += source[j] === "\\" ? 2 : 1
      if (j >= source.length) complete = false
      append(i, source.slice(i + 2, Math.min(j, source.length)), true)
      i = j
      continue
    }
    if (ch === '"' || (ch === "$" && next === '"')) {
      const open = ch === '"' ? i : i + 1
      let j = open + 1
      let text = ""
      let expands = false
      while (j < source.length && source[j] !== '"') {
        const c = source[j] as string
        const escaped = source[j + 1]
        if (c === "\\" && escaped !== undefined) {
          if (escaped !== "\n") text += '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`
          j += 2
          continue
        }
        if (c === "$" || c === "`") {
          const expansion = expansionAt(source, j, true)
          substitution(expansion)
          text += source.slice(j, expansion.end)
          expands ||= expansion.expands
          j = expansion.end
          continue
        }
        text += c
        j++
      }
      if (j >= source.length) complete = false
      append(i, text, true, expands)
      i = j
      continue
    }
    if (ch === "$" || ch === "`") {
      const expansion = expansionAt(source, i)
      substitution(expansion, true)
      append(i, source.slice(i, expansion.end), false, expansion.expands)
      i = expansion.end - 1
      continue
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      const close = closingIndex(source, i + 2, "(", ")")
      const end = close < 0 ? source.length : close
      substitutions.push(source.slice(i + 2, end))
      if (close < 0) complete = false
      append(i, source.slice(i, close < 0 ? end : end + 1), false, true)
      i = end
      continue
    }
    if (ch === "#" && word === undefined) {
      const newline = source.indexOf("\n", i)
      i = (newline < 0 ? source.length : newline) - 1
      continue
    }
    if (ch === " " || ch === "\t") {
      flush(i)
      continue
    }
    if (ch === "\n") {
      operator(i, "\n")
      i = hereDocuments(i + 1) - 1
      continue
    }
    if (ch === ";") {
      const length = next === ";" ? (source[i + 2] === "&" ? 3 : 2) : next === "&" ? 2 : 1
      operator(i, length === 1 ? ";" : ";;")
      i += length - 1
      continue
    }
    if (ch === "&" && next === ">") {
      flush(i)
      target = "redirect"
      targetHereString = false
      targetOperator = "&>"
      targetFd = undefined
      i += source[i + 2] === ">" ? 2 : 1
      continue
    }
    if (ch === "&" || ch === "|") {
      const value = next === ch ? `${ch}${ch}` : ch === "|" && next === "&" ? "|&" : ch
      operator(i, value)
      i += value.length - 1
      continue
    }
    if (ch === "(" || ch === ")") {
      operator(i, ch)
      continue
    }
    if (ch === "<" || ch === ">") {
      // A word of digits, or `{name}`, written against the operator is its file descriptor.
      // Flush the previous word first: in `3<<<'x'>out` the here-string belongs to fd 3.
      let fd: string | undefined
      if (word !== undefined && !word.quoted && !word.expands && /^(?:\d+|\{[A-Za-z_]\w*\})$/.test(word.value)) {
        fd = word.value
        word = undefined
      } else flush(i)
      targetFd = fd
      targetHereString = source.startsWith("<<<", i)
      targetOperator = source.startsWith("<<<", i)
        ? "<<<"
        : source.startsWith("<<-", i)
          ? "<<-"
          : source.startsWith("<<", i)
            ? "<<"
            : ch + (next === ">" || next === "&" || next === "|" ? next : "")
      if (source.startsWith("<<<", i)) {
        target = "redirect"
        i += 2
      } else if (source.startsWith("<<-", i)) {
        target = "here-document-tabs"
        i += 2
      } else if (source.startsWith("<<", i)) {
        target = "here-document"
        i += 1
      } else {
        target = "redirect"
        if (next === ">" || next === "&" || next === "|" || (ch === "<" && next === ">")) i += 1
      }
      continue
    }
    append(i, ch, false, "*?[{}".includes(ch) || (ch === "~" && word === undefined))
  }
  flush(source.length)
  endCommand()
  if (pending.length > 0) complete = false
  return { items, substitutions, complete }
}

/** The expansion a `$` or backtick at `at` starts, and where it ends. */
function expansionAt(text: string, at: number, inDouble = false): Expansion {
  if (text[at] === "`") {
    let j = at + 1
    while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1
    const closed = j < text.length
    return {
      end: closed ? j + 1 : text.length,
      inner: text.slice(at + 1, Math.min(j, text.length)),
      executable: true,
      expands: true,
      closed,
    }
  }
  const next = text[at + 1]
  if (next === "(" || next === "{") {
    const close = closingIndex(text, at + 2, next, next === "(" ? ")" : "}", inDouble && next === "{")
    const closed = close >= 0
    return {
      end: closed ? close + 1 : text.length,
      inner: text.slice(at + 2, closed ? close : text.length),
      executable: next === "(" && text[at + 2] !== "(",
      expands: true,
      closed,
    }
  }
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let j = at + 2
    while (j < text.length && /\w/.test(text[j] as string)) j++
    return { end: j, expands: true, closed: true }
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return { end: at + 2, expands: true, closed: true }
  // A `$` that starts nothing is a literal dollar sign.
  return { end: at + 1, expands: false, closed: true }
}

/** Index of the `close` that balances an `open` already consumed before `from`, or -1. */
function closingIndex(text: string, from: number, open: string, close: string, literalSingle = false): number {
  let depth = 1
  for (let j = from; j < text.length; j++) {
    const c = text[j]
    if (c === "\\") {
      j++
      continue
    }
    if (c === "'" && literalSingle) continue
    // A command substitution has its own quote rules, whatever surrounds it.
    if (c === "$" && text[j + 1] === "(") {
      const end = closingIndex(text, j + 2, "(", ")")
      if (end < 0) return -1
      j = end
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      let k = j + 1
      while (k < text.length && text[k] !== c) k += c !== "'" && text[k] === "\\" ? 2 : 1
      if (k >= text.length) return -1
      j = k
      continue
    }
    // Only `${` opens a nested expansion; a bare `{` is a literal brace.
    if (c === open && (open !== "{" || text[j - 1] === "$")) depth++
    else if (c === close && --depth === 0) return j
  }
  return -1
}

/**
 * Substitutions in an unquoted parameter-expansion body such as the default of `${X:-…}`.
 * Quotes are honoured (single quotes hide everything, double quotes still expand `$( )` and
 * backticks), and `$( )`, backticks, `<( )`, `>( )` and nested `${ }` are found. A `#`, a `;`
 * or a newline is plain data here: this is not a command line.
 */
function parameterBodySubstitutions(body: string): Expansion[] {
  const found: Expansion[] = []
  for (let j = 0; j < body.length; j++) {
    const c = body[j] as string
    if (c === "\\") {
      j++
    } else if (c === "'") {
      const end = body.indexOf("'", j + 1)
      j = end < 0 ? body.length : end
    } else if (c === '"') {
      j++
      while (j < body.length && body[j] !== '"') {
        if (body[j] === "\\") j++
        else if (body[j] === "$" || body[j] === "`") {
          const expansion = expansionAt(body, j, true)
          found.push({ ...expansion, doubleQuoted: true })
          j = expansion.end - 1
        }
        j++
      }
    } else if (c === "$" || c === "`") {
      const expansion = expansionAt(body, j)
      found.push(expansion)
      j = expansion.end - 1
    } else if ((c === "<" || c === ">") && body[j + 1] === "(") {
      const close = closingIndex(body, j + 2, "(", ")")
      const closed = close >= 0
      const end = closed ? close + 1 : body.length
      found.push({ end, inner: body.slice(j + 2, closed ? close : body.length), executable: true, expands: true, closed })
      j = end - 1
    }
  }
  return found
}

/** Substitutions an unquoted here-document body expands. */
function bodySubstitutions(body: string): Expansion[] {
  const found: Expansion[] = []
  for (let j = 0; j < body.length; j++) {
    const c = body[j]
    if (c === "\\") {
      j++
      continue
    }
    if (c !== "$" && c !== "`") continue
    const expansion = expansionAt(body, j, true)
    found.push(expansion)
    j = expansion.end - 1
  }
  return found
}

export type CommandPosition = {
  raw: string
  words: Token[]
  argv: string[]
  executable?: string
}

export type ParsedCommand = {
  command: string
  /** String argv segments retained for existing gate helpers. */
  segments: string[][]
  /** Raw command-position segments, preserving quoting for gate decisions. */
  commands: CommandPosition[]
  unknown: boolean
  nested: ParsedCommand[]
}

export type ParseFailure = ParsedCommand & { kind: "parse-failure"; reason: string }

function splitCommands(source: string): CommandPosition[] {
  const positions: CommandPosition[] = []
  let current: Token[] = []
  const flush = (): void => {
    if (current.length === 0) return
    const words = [...current]
    const argv = words.map((word) => word.value)
    let index = 0
    while (
      index < words.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "") || words[index]?.value === "!")
    )
      index++
    while (
      index < words.length &&
      WRAPPERS[words[index]?.value.split("/").pop() ?? words[index]?.value ?? ""] === true
    ) {
      const wrapper = words[index]?.value.split("/").pop() ?? words[index]?.value ?? ""
      index++
      if (wrapper === "env")
        while (
          index < words.length &&
          (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "") || words[index]?.value?.startsWith("-") === true)
        )
          index++
      if (wrapper === "xargs") while (index < words.length && words[index]?.value?.startsWith("-") === true) index++
      if (wrapper === "sudo")
        while (index < words.length && words[index]?.value?.startsWith("-") === true) {
          index++
          if (index < words.length && words[index]?.value?.startsWith("-") === false) index++
        }
    }
    const executable = words[index] && !words[index]?.quoted ? words[index]?.value : undefined
    const raw = words.map((word) => (word.quoted ? `'${word.value.replaceAll("'", "'\\''")}'` : word.value)).join(" ")
    positions.push({ raw, words, argv, executable })
    current = []
  }
  for (const token of tokenize(source)) {
    if (OPERATORS[token.value] === true) {
      flush()
      continue
    }
    current.push(token)
  }
  flush()
  return positions
}

/**
 * The here-document body or here-string text that is the command's standard input, or
 * undefined when stdin is a file, another descriptor's here-document, or nothing. The last
 * redirection of descriptor 0 wins, as in the shell.
 */
export function stdinSource(item: SimpleCommand): string | undefined {
  let heredoc = 0
  let source: string | undefined
  for (const redirect of item.redirects) {
    const operator = redirect.operator ?? ""
    const isHeredoc = operator === "<<" || operator === "<<-"
    const document = isHeredoc ? item.hereDocuments[heredoc++] : undefined
    const fd = redirect.fd ?? (operator.startsWith("<") ? "0" : "1")
    if (fd !== "0") continue
    if (isHeredoc) source = document?.body
    else if (operator === "<<<") source = redirect.value
    else source = undefined
  }
  return source
}

/** Whether a redirection duplicates or closes a descriptor onto standard input (`0<&3`, `<&-`, `0>&3`). */
function duplicatesStdin(item: SimpleCommand): boolean {
  return item.redirects.some((redirect) => {
    const operator = redirect.operator ?? ""
    if (operator !== "<&" && operator !== ">&") return false
    return (redirect.fd ?? (operator === "<&" ? "0" : "1")) === "0"
  })
}

/** Every here-document body and here-string text attached to the command. */
function documentSources(item: SimpleCommand): string[] {
  return [
    ...item.hereDocuments.map((document) => document.body),
    ...item.redirects.filter((redirect) => redirect.hereString === true).map((redirect) => redirect.value),
  ]
}

const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"])

/**
 * Whether a shell interpreter command (`values[0]` is its word) reads its script from stdin,
 * so a here-document or here-string fed to it is shell source. `-c '…'` takes its script from
 * the argument and `script.sh` from a file, so stdin there is data; `-s` forces stdin.
 */
export function readsScriptFromStdin(values: string[]): boolean {
  if (!INTERPRETERS.has(values[0]?.split("/").pop() ?? "")) return false
  let stdin = false
  for (let i = 1; i < values.length; i++) {
    const arg = values[i] as string
    if (arg === "--") return stdin || i + 1 >= values.length
    if (arg.startsWith("--")) {
      if (arg === "--rcfile" || arg === "--init-file") i++
      continue
    }
    if (arg.length > 1 && (arg.startsWith("-") || arg.startsWith("+"))) {
      const letters = arg.slice(1)
      if (arg.startsWith("-") && letters.includes("c")) return false
      if (arg.startsWith("-") && letters.includes("s")) stdin = true
      if (/[oO]$/.test(letters)) i++
      continue
    }
    return stdin
  }
  return true
}

/**
 * The script a shell interpreter runs from `-c 'script'`, or undefined when the command has no
 * literal `-c` argument. Only the plain `bash -c 'script'` and `bash -lc 'script'` spellings.
 */
export function interpreterCommandString(values: string[]): string | undefined {
  if (!INTERPRETERS.has(values[0]?.split("/").pop() ?? "")) return undefined
  for (let i = 1; i < values.length; i++) {
    const arg = values[i] as string
    if (arg === "--" || arg.startsWith("--")) {
      if (arg === "--rcfile" || arg === "--init-file") i++
      if (arg === "--") return undefined
      continue
    }
    if (arg.length > 1 && (arg.startsWith("-") || arg.startsWith("+"))) {
      const letters = arg.slice(1)
      if (arg.startsWith("-") && letters.includes("c")) {
        const script = values[i + 1 + (/[oO]$/.test(letters) ? 1 : 0)]
        return script !== undefined && !script.startsWith("-") ? script : undefined
      }
      if (/[oO]$/.test(letters)) i++
      continue
    }
    return undefined
  }
  return undefined
}

function nestedSources(source: string): { sources: string[]; unknown: boolean } {
  // A balanced, quote-aware scan: `"$(bd create "a (b)")"` is one substitution, which a
  // regex over the quoted body cannot see. Backticks, `<( )` and substitutions nested
  // inside parameter or arithmetic expansions come from the same scan.
  const scan = scanShell(source, { executableSubstitutionsOnly: true })
  const sources: string[] = [...scan.substitutions]
  let unknown = !scan.complete
  // A shell interpreter reading a here-document or here-string runs its body as a script.
  for (const item of scan.items) {
    if (item.kind !== "command") continue
    let first = 0
    while (
      first < item.words.length &&
      /^[A-Za-z_]\w*=/.test(source.slice(item.words[first]?.start, item.words[first]?.end))
    )
      first++
    const values = item.words.slice(first).map((word) => word.value)
    if (!readsScriptFromStdin(values)) continue
    const script = stdinSource(item)
    if (script !== undefined) sources.push(script)
    // `0<&3` or `0<&0` may point stdin at a here-document on another descriptor. Rather than
    // model descriptor tables, read every here-document and here-string on the command as a script.
    else if (duplicatesStdin(item)) sources.push(...documentSources(item))
  }
  for (const match of source.matchAll(/\b(?:bash|sh|zsh|dash|ksh)\s+-c\s+((?:'[^']*')|(?:"[^"]*")|[^\s;&|]+)/g)) {
    const value = match[1]
    if (!value || value.startsWith('"$') || value.startsWith("'$")) unknown = true
    else sources.push(value.replace(/^['"]|['"]$/g, ""))
  }
  for (const match of source.matchAll(/\beval\s+((?:'[^']*')|(?:"[^"]*")|[^\s;&|]+)/g)) {
    const value = match[1]
    if (value?.startsWith("$")) unknown = true
    else if (value) sources.push(value.replace(/^['"]|['"]$/g, ""))
  }
  for (const match of source.matchAll(/\bxargs(?:\s+-[^\s;&|]+)*\s+([^;&|]+?)(?=\s*(?:[;&|]|$))/g)) {
    const value = match[1]?.trim()
    if (value?.startsWith("$")) unknown = true
    else if (value) sources.push(value.replace(/^['"]|['"]$/g, ""))
  }
  return { sources, unknown }
}

function staticParse(command: string): ParsedCommand | ParseFailure {
  if (command.length > 64_000)
    return {
      kind: "parse-failure",
      reason: "input exceeds 64000 characters",
      command,
      segments: [],
      commands: [],
      unknown: true,
      nested: [],
    }
  if (!shellQuoteBalanced(command))
    return {
      kind: "parse-failure",
      reason: "unbalanced shell quote",
      command,
      segments: [],
      commands: [],
      unknown: true,
      nested: [],
    }
  const commands = splitCommands(command)
  const nested = nestedSources(command)
  const children = nested.sources.map(staticParse)
  const unknown = nested.unknown || children.some((child) => child.unknown)
  return {
    command,
    segments: commands.map((position) => position.argv),
    commands,
    unknown,
    nested: children,
  }
}

/** Synchronous structural parse used by tests and callers that already have syntax proof. */
export function parse(command: unknown): ParsedCommand | ParseFailure {
  if (typeof command !== "string") {
    return {
      kind: "parse-failure",
      reason: "command is not a string",
      command: "",
      segments: [],
      commands: [],
      unknown: true,
      nested: [],
    }
  }
  return staticParse(command)
}

export function commandFromInput(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const value = input as Record<string, unknown>
  if (typeof value.command === "string") return value.command
  if (typeof value.cmd === "string") return value.cmd
  return ""
}

export type ParsedInvocation = {
  position: CommandPosition
  command: string
  args: string[]
  verb?: string
  globals: string[]
}

/**
 * Find executable invocations recursively from the shared command-position model.
 * A global flag before the verb takes the next word as its value unless it is listed
 * in `booleanFlags` or written as `--flag=value`.
 */
export function parsedInvocations(
  parsed: ParsedCommand | ParseFailure,
  executable: string,
  booleanFlags: readonly string[] = [],
): ParsedInvocation[] {
  if (parsed.unknown) return []
  const found: ParsedInvocation[] = []
  for (const position of parsed.commands) {
    const executableName = position.executable?.split("/").pop()
    const index =
      executableName === executable
        ? position.argv.findIndex(
            (word, i) => !position.words[i]?.quoted && (word.split("/").pop() ?? word) === executable,
          )
        : -1
    if (index < 0) continue
    const args = position.argv.slice(index + 1)
    const globals: string[] = []
    let verb: string | undefined
    for (let i = 0; i < args.length; i++) {
      const word = args[i]
      if (word === undefined) continue
      if (word.startsWith("-") && verb === undefined) {
        globals.push(word)
        const next = args[i + 1]
        if (!booleanFlags.includes(word) && !word.includes("=") && next !== undefined && !next.startsWith("-")) {
          globals.push(next)
          i++
        }
        continue
      }
      if (verb === undefined && !word.startsWith("\u0000")) verb = word
    }
    found.push({ position, command: position.raw, args, verb, globals })
  }
  for (const child of parsed.nested) found.push(...parsedInvocations(child, executable, booleanFlags))
  return found
}
