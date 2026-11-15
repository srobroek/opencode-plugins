#!/usr/bin/env bun
/**
 * Check every skill's `references/pitfalls.md`: SKILL.md links it, and each `## ` entry
 * carries `**Symptom:**`, `**Cause:**` and `**Fix:**` lines in that order, with the
 * Symptom holding the exact, greppable text in a code span. See "Skill pitfalls" in AGENTS.md.
 *
 *   bun scripts/check-pitfalls.ts   check plugins/*
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

export type Finding = { file: string; line: number; reason: string }

const FIELDS = ["Symptom", "Cause", "Fix"] as const
export const POINTER = "references/pitfalls.md"

/** Findings for one pitfalls file. */
export function checkPitfalls(file: string, text: string): Finding[] {
  const findings: Finding[] = []
  const lines = text.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => (/^## \S/.test(line) ? [index] : []))
  if (starts.length === 0) return [{ file, line: 1, reason: "no `## <title>` entry" }]
  starts.forEach((start, n) => {
    const body = lines.slice(start + 1, starts[n + 1] ?? lines.length)
    let from = 0
    for (const field of FIELDS) {
      const pattern = new RegExp(`^(?:[-*] )?\\*\\*${field}:\\*\\* \\S`)
      const at = body.findIndex((line, index) => index >= from && pattern.test(line))
      if (at < 0) {
        findings.push({ file, line: start + 1, reason: `entry lacks "**${field}:**" (after the previous field)` })
        return
      }
      if (field === "Symptom" && !/`[^`]+`/.test(body[at] ?? ""))
        findings.push({ file, line: start + 2 + at, reason: "Symptom quotes no exact text in a code span" })
      from = at + 1
    }
  })
  return findings
}

/** Findings for a skill directory: a pitfalls file must be linked from SKILL.md and well formed. */
export function checkSkillDir(dir: string): Finding[] {
  const pitfalls = path.join(dir, POINTER)
  if (!existsSync(pitfalls)) return []
  const skill = path.join(dir, "SKILL.md")
  const findings = checkPitfalls(pitfalls, readFileSync(pitfalls, "utf8"))
  if (!existsSync(skill) || !readFileSync(skill, "utf8").includes(POINTER))
    findings.push({ file: skill, line: 1, reason: `SKILL.md does not point to ${POINTER}` })
  return findings
}

function main(): number {
  const root = path.resolve(import.meta.dir, "..")
  const plugins = path.join(root, "plugins")
  const findings: Finding[] = []
  let count = 0
  for (const plugin of readdirSync(plugins).sort()) {
    const skills = path.join(plugins, plugin, "skills")
    if (!existsSync(skills)) continue
    for (const skill of readdirSync(skills).sort()) {
      const dir = path.join(skills, skill)
      if (existsSync(path.join(dir, POINTER))) count++
      findings.push(...checkSkillDir(dir))
    }
  }
  for (const f of findings) console.error(`${path.relative(root, f.file)}:${f.line}: ${f.reason}`)
  if (findings.length > 0) {
    console.error(`check-pitfalls: ${findings.length} finding(s)`)
    return 1
  }
  console.log(`check-pitfalls: ${count} pitfalls file(s) clean`)
  return 0
}

if (import.meta.main) process.exit(main())
