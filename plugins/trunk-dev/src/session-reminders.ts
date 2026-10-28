import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { supervise } from "@srobroek/opencode-lib/subprocess"
import { bdEnvironment, type CommandRunner, repository } from "./flag-cleanup.ts"
import { isReleaseRepository } from "./release-repo.ts"

export function staleThresholdHours(value: string | undefined): number {
  const hours = value !== undefined && /^\d+$/.test(value) ? Number(value) : 48
  return Number.isSafeInteger(hours) && hours > 0 ? hours : 48
}

/** Only live local branches need action; cap the reminder rather than flooding the result. */
export function decideStaleReminder(beads: unknown, branches: readonly string[], now: number, hours: number): string | undefined {
  if (!Array.isArray(beads)) return undefined
  const live = new Set(branches)
  const rows: string[] = []
  for (const bead of beads) {
    if (bead === null || typeof bead !== "object") continue
    const branch = bead.metadata?.branch
    if (typeof branch !== "string" || !live.has(branch) || typeof bead.id !== "string") continue
    const started = typeof bead.started_at === "string" ? Date.parse(bead.started_at) : NaN
    const old = bead.status === "in_progress" && Number.isFinite(started) && now - started > hours * 3_600_000
    if (!old && bead.status !== "closed" && bead.status !== "merged") continue
    rows.push(`- ${bead.id.replace(/[\r\n`]/g, "")}: ${branch.replace(/[\r\n`]/g, "")} (${old ? `claimed >${hours}h` : bead.status})`)
    if (rows.length === 5) break
  }
  return rows.length ? `trunk-dev: stale bead branches:\n${rows.join("\n")}\nLand or split stale claims; remove landed branches after checking their work.` : undefined
}

export function forgeFromRemote(url: string): "github" | "gitlab" | undefined {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url)?.[1] ?? /^(?:[^@]+@)?([^:/]+):/.exec(url)?.[1]
  if (host && /(^|\.)github\./i.test(host)) return "github"
  if (host && /(^|\.)gitlab\./i.test(host)) return "gitlab"
  return undefined
}

export function decideMissingStaleJob(forge: "github" | "gitlab" | undefined, texts: readonly string[]): string | undefined {
  if (!forge || texts.some((text) => /^\s*stale-bead-branches\s*:/m.test(text))) return undefined
  return "trunk-dev: missing daily stale-bead-branches CI job; run skill trunk-dev-release-setup to add it."
}

function ciTexts(root: string, forge: "github" | "gitlab"): string[] {
  const files: string[] = forge === "gitlab" ? [join(root, ".gitlab-ci.yml")] : []
  const collect = (dir: string, depth: number) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true }).slice(0, 100)) {
        const path = join(dir, entry.name)
        if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(path)
        else if (entry.isDirectory() && depth > 0) collect(path, depth - 1)
      }
    } catch { /* No CI config yet. */ }
  }
  collect(join(root, forge === "github" ? ".github/workflows" : ".gitlab"), forge === "github" ? 0 : 3)
  return files.slice(0, 100).flatMap((file) => {
    try { return [readFileSync(file, "utf8")] } catch { return [] }
  })
}

const read: CommandRunner = async (cmd, cwd, env, timeoutMs) => {
  try {
    const result = await supervise(Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), { timeoutMs })
    return result.kind === "exited" ? { exitCode: result.exitCode, stdout: result.stdout } : undefined
  } catch { return undefined }
}

export async function sessionReminder(cwd: string, env = process.env, run: CommandRunner = read): Promise<string | undefined> {
  const repo = await repository(cwd, env, run)
  if (!repo || !isReleaseRepository(repo.root, { git: () => repo.root })) return undefined
  const [beads, branches, remote] = await Promise.all([
    run(["bd", "--readonly", "list", "--all", "--json", "--limit", "0"], repo.root, bdEnvironment(env, repo.store), 5_000),
    run(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"], repo.root, env, 2_000),
    run(["git", "remote", "get-url", "origin"], repo.root, env, 2_000),
  ])
  const notes: string[] = []
  const forge = remote?.exitCode === 0 ? forgeFromRemote(remote.stdout.trim()) : undefined
  const missing = decideMissingStaleJob(forge, forge ? ciTexts(repo.root, forge) : [])
  if (missing) notes.push(missing)
  if (beads?.exitCode === 0 && branches?.exitCode === 0) {
    try {
      const stale = decideStaleReminder(JSON.parse(beads.stdout), branches.stdout.trim().split("\n"), Date.now(), staleThresholdHours(env.TRUNK_DEV_STALE_HOURS))
      if (stale) notes.push(stale)
    } catch { /* Invalid bd output is advisory-only. */ }
  }
  return notes.length ? notes.join("\n") : undefined
}
