import { readdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { parse, parsedInvocations } from "@srobroek/opencode-lib/shell-command"
import { appendResultText } from "@srobroek/opencode-lib/shell-result"
import { shellWriteTargets } from "@srobroek/opencode-lib/shell-write-targets"
import { shellCall, writeTargets } from "@srobroek/opencode-lib/tool-targets"

export function scratchEntry(target: string, cwd: string, root: string): string | undefined {
  const rel = relative(root, resolve(cwd, target))
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return join(root, rel.split(sep)[0] as string)
}

export function scratchEntries(tool: string, input: unknown, cwd: string, root: string): string[] {
  const call = shellCall(tool, input)
  const dir = call?.workdir ? resolve(cwd, call.workdir) : cwd
  const targets = call ? shellWriteTargets(call.command, dir) : writeTargets(tool, input)
  if (call) {
    const parsed = parse(call.command)
    for (const { args } of parsedInvocations(parsed, "mkdir")) {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-m" || args[i] === "--mode") i++
        else if (!args[i]?.startsWith("-")) targets.push(args[i] as string)
      }
    }
    for (const { args } of parsedInvocations(parsed, "mktemp")) {
      let base = dir
      let template: string | undefined
      let temporaryDirectory = false
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string
        if (arg === "-p" || arg === "--tmpdir") {
          base = resolve(dir, args[++i] ?? "")
          temporaryDirectory = true
        } else if (arg.startsWith("--tmpdir=")) {
          base = resolve(dir, arg.slice(9))
          temporaryDirectory = true
        }
        else if (!arg.startsWith("-")) template = arg
      }
      if (template || temporaryDirectory) targets.push(resolve(base, template ?? "tmp.XXXXXXXXXX"))
    }
  }
  return [...new Set(targets.flatMap((target) => {
    if (/[$`]/.test(target)) return []
    const entry = scratchEntry(target, dir, root)
    return entry ? [entry] : []
  }))]
}

function entries(root: string): string[] {
  try { return readdirSync(root).map((entry) => join(root, entry)) } catch { return [] }
}

export function newScratchEntries(candidates: readonly string[], before: ReadonlySet<string>, after: readonly string[], noted: ReadonlySet<string>): string[] {
  const matches = (candidate: string, entry: string) => {
    if (candidate === entry) return true
    const pattern = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/X{4,}/g, (xs) => `[A-Za-z0-9]{${xs.length}}`)
    return new RegExp(`^${pattern}$`).test(entry)
  }
  return after.filter((entry) => !before.has(entry) && !noted.has(entry) && candidates.some((candidate) => matches(candidate, entry))).slice(0, Math.max(0, 3 - noted.size))
}

export async function setupScratch(ctx: Context): Promise<() => Promise<void>> {
  const root = join(realpathSync(tmpdir()), "opencode")
  const children = new Map<string, Promise<string | undefined>>()
  const pending = new Map<string, { sessionID: string; candidates: string[]; existed: Set<string> }>()
  const noted = new Map<string, Set<string>>()
  const before = await ctx.tool.hook("execute.before", async (event) => {
    let child = children.get(event.sessionID)
    if (!child) {
      child = ctx.session.get({ sessionID: event.sessionID }).then((session) => typeof session.parentID === "string" ? session.location.directory : undefined).catch(() => undefined)
      children.set(event.sessionID, child)
    }
    const cwd = await child
    if (cwd === undefined) return
    const candidates = scratchEntries(event.tool, event.input, cwd, root)
    if (candidates.length) pending.set(event.id, { sessionID: event.sessionID, candidates, existed: new Set(entries(root)) })
  })
  const after = await ctx.tool.hook("execute.after", (event) => {
    const saved = pending.get(event.id)
    pending.delete(event.id)
    if (!saved || event.status !== "completed") return
    const seen = noted.get(saved.sessionID) ?? new Set<string>()
    noted.set(saved.sessionID, seen)
    for (const entry of newScratchEntries(saved.candidates, saved.existed, entries(root), seen)) {
      seen.add(entry)
      event.result = appendResultText(event.result, `Scratch: you created ${entry}. Delete it before your final report unless your brief says to keep it.`)
    }
  })
  return async () => {
    await after.dispose()
    await before.dispose()
    children.clear()
    pending.clear()
    noted.clear()
  }
}
