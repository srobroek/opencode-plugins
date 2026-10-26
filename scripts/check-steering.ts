#!/usr/bin/env bun
/**
 * Fail when shipped markdown still carries Oh My Pi steering: `skill://`, `rule://`,
 * `agent://`, `proc://` and the other omp URI schemes, omp tool names, TTSR wording, or
 * omp CLI and config paths. Shipped markdown is every `*.md` under a plugin's `skills/`
 * or `agents/` directory.
 *
 *   bun scripts/check-steering.ts           check plugins/*
 *   bun scripts/check-steering.ts <files>   check the named files
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export type Finding = { file: string; line: number; match: string; reason: string }

type Check = { pattern: RegExp; reason: (match: string) => string }

const SCHEMES = ["skill", "rule", "agent", "proc", "history", "artifact", "local", "xd", "omp", "memory", "pr"]

/** omp tools with no V2 tool of that name; written as a lone backticked word in prose. */
const BACKTICKED_TOOLS = ["bash", "task", "eval", "lsp", "yield", "find", "todo"]
/** omp tool identifiers that are unambiguous anywhere. */
const IDENTIFIER_TOOLS = ["ast_grep", "ast_edit", "web_search", "todo_write", "inspect_image"]

const CHECKS: Check[] = [
  {
    pattern: new RegExp(`\\b(?:${SCHEMES.join("|")})://`, "g"),
    reason: (match) => `omp URI ${match}: name the skill or use a relative path`,
  },
  {
    pattern: new RegExp(`(?<!\`)\`(?:${BACKTICKED_TOOLS.join("|")})\`(?!\`)`, "g"),
    reason: (match) => `omp tool name ${match}: use the V2 tool (shell, subagent, ...) or plain words`,
  },
  {
    pattern: new RegExp(`\\b(?:${IDENTIFIER_TOOLS.join("|")})\\b`, "g"),
    reason: (match) => `omp tool name ${match}: no V2 tool of that name`,
  },
  { pattern: /\bTTSR\b/g, reason: () => "TTSR is omp-only: describe when to load the skill instead" },
  { pattern: /\bomp (?:plugin|config|agent)\b|~\/\.omp\b|\.omp-plugin\b/g, reason: (match) => `omp CLI or config ${match}` },
]

/** Every steering finding in one markdown text. */
export function checkText(file: string, text: string): Finding[] {
  const findings: Finding[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((content, index) => {
    for (const check of CHECKS) {
      for (const match of content.matchAll(check.pattern))
        findings.push({ file, line: index + 1, match: match[0], reason: check.reason(match[0]) })
    }
  })
  return findings
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith(".md")) out.push(full)
  }
  return out
}

/** The shipped markdown of every plugin under `pluginsDir`. */
export function shippedMarkdown(pluginsDir: string): string[] {
  const files: string[] = []
  for (const plugin of readdirSync(pluginsDir).sort()) {
    for (const sub of ["skills", "agents"]) {
      const dir = path.join(pluginsDir, plugin, sub)
      if (existsSync(dir) && statSync(dir).isDirectory()) files.push(...walk(dir).sort())
    }
  }
  return files
}

function main(argv: string[]): number {
  const root = path.resolve(import.meta.dir, "..")
  const files = argv.length > 0 ? argv : shippedMarkdown(path.join(root, "plugins"))
  const findings = files.flatMap((file) => checkText(path.relative(root, path.resolve(file)), readFileSync(file, "utf8")))
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.reason}`)
  if (findings.length > 0) {
    console.error(`check-steering: ${findings.length} finding(s) in ${new Set(findings.map((f) => f.file)).size} file(s)`)
    return 1
  }
  console.log(`check-steering: ${files.length} file(s) clean`)
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
