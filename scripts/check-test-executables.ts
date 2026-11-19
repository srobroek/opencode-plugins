#!/usr/bin/env bun
/**
 * Fail when a test writes an executable directly instead of through `writeExecutable`
 * (`@srobroek/opencode-lib/executable-fixture`). Endpoint security agents check every newly
 * written file the first time it runs, which under load stalls that run for up to tens of
 * seconds and times tests out; a symlink to the committed trampoline starts at once.
 *
 * - `writeFileSync(..., { mode: <executable> })` in a `*.test.ts` file is always a finding.
 * - `chmodSync(..., <executable>)` is a finding too. Mark a chmod that is not a script (a
 *   directory permission, a mode under test) with `// check-test-executables: <reason>` on
 *   the same line.
 *
 *   bun scripts/check-test-executables.ts   check plugins/ and scripts/
 */

import { readFileSync } from "node:fs"
import path from "node:path"

export type Site = { line: number; kind: "write" | "chmod" }
export type Finding = { file: string; line: number; reason: string }

const EXEMPT = /\/\/\s*check-test-executables:\s*\S/
/** An octal literal whose owner digit has the execute bit. */
const EXECUTABLE_MODE = "0o[1357][0-7]{2}"
const WRITE = new RegExp(`writeFileSync\\((?:(?!writeFileSync\\()[\\s\\S]){0,400}?\\bmode:\\s*${EXECUTABLE_MODE}\\b`, "g")
const CHMOD = new RegExp(`chmodSync\\([^\\n]*?,\\s*${EXECUTABLE_MODE}\\s*\\)`, "g")

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length

/** Direct executable writes and executable chmods in one file, by the line each call starts on. */
export function directExecutables(text: string): Site[] {
  const lines = text.split("\n")
  const sites: Site[] = []
  for (const [pattern, kind] of [
    [WRITE, "write"],
    [CHMOD, "chmod"],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      const line = lineAt(text, match.index ?? 0)
      const last = lineAt(text, (match.index ?? 0) + match[0].length)
      if (lines.slice(line - 1, last).some((l) => EXEMPT.test(l))) continue
      sites.push({ line, kind })
    }
  }
  return sites.sort((a, b) => a.line - b.line)
}

/** Findings for test files (repo-relative path to text). */
export function checkTree(files: Map<string, string>): Finding[] {
  const findings: Finding[] = []
  for (const [file, text] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    for (const site of directExecutables(text))
      findings.push({
        file,
        line: site.line,
        reason:
          site.kind === "write"
            ? "writes an executable directly; use writeExecutable from @srobroek/opencode-lib/executable-fixture"
            : "chmodSync to an executable mode; use writeExecutable for a script, or mark a non-script with `// check-test-executables: <reason>`",
      })
  return findings
}

function main(): number {
  const root = path.resolve(import.meta.dir, "..")
  const files = new Map<string, string>()
  for (const pattern of ["plugins/*/src/**/*.test.ts", "scripts/**/*.test.ts"])
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root }))
      if (!file.includes("node_modules") && file !== "scripts/check-test-executables.test.ts")
        files.set(file, readFileSync(path.join(root, file), "utf8"))
  const findings = checkTree(files)
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.reason}`)
  if (findings.length > 0) {
    console.error(`check-test-executables: ${findings.length} finding(s)`)
    return 1
  }
  console.log(`check-test-executables: ${files.size} test file(s) clean`)
  return 0
}

if (import.meta.main) process.exit(main())
