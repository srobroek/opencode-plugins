import { isAbsolute, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { appendResultText, isShellTool, leadingCdCwd, shellCall, WRITE_TOOLS } from "@srobroek/opencode-lib"
import { rewriteCloseKeywords } from "./close-keywords.ts"
import { externalDirectories, sessionRoots, shellFlagDirectories } from "./flag-directories.ts"
import { readProviderTypes } from "./fnox-config.ts"
import { GUARD_IDS, type GuardID, type GuardOptions, hardGate } from "./guards.ts"
import { decideToolCall, type MigrationOptions, migrationOverride } from "./migrations.ts"
import { createPackageAdvisor } from "./package-investigate.ts"
import { type Decision, type DecisionID, type ReviewOptions, reviewPermission } from "./permission.ts"
import { createRedactor, type RedactOptions, readRedactOptions } from "./redact.ts"
import { allowScratch, scratchRoots } from "./scratch-dirs.ts"

export { normalize as normalizeCloseKeywords, rewriteCloseKeywords } from "./close-keywords.ts"
export { externalDirectories, flagDirectories, shellFlagDirectories } from "./flag-directories.ts"
export { hardGate, MESSAGES } from "./guards.ts"
export { decidePath as decideMigrationPath, latestMigration, migrationTarget } from "./migrations.ts"
export { INVESTIGATE_NOTICE, packagesToInvestigate } from "./package-investigate.ts"
export { reviewPermission } from "./permission.ts"
export {
  collectSecrets,
  createRedactor,
  looksSecret,
  orderSecrets,
  readRedactOptions,
  redactText,
  redactValue,
} from "./redact.ts"

export type FeatureID =
  | GuardID
  | DecisionID
  | "close-keywords"
  | "package-investigate"
  | "migration-edit"
  | "external-directory"

export const FEATURE_IDS: readonly FeatureID[] = [
  ...GUARD_IDS,
  "force-push",
  "sudo-destructive",
  "worktree-destruction",
  "close-keywords",
  "package-investigate",
  "migration-edit",
  "external-directory",
]

export type SafetyOptions = {
  disabled: ReadonlySet<FeatureID>
  redact: RedactOptions
  opAllow: string[]
  scratchDirs: boolean
}

/**
 * `{ disable: ["git-defender", …] }` turns features off; unknown ids are ignored.
 * `opAllow` lists extra `op` subcommand prefixes the op-guard allows.
 * `scratchDirs: false` stops allowing the OpenCode temp folder and the project's worktree folder.
 * `redactSecrets`, `redactNames` and `redactExclude` configure secret redaction.
 */
export function readOptions(options: Readonly<Record<string, unknown>> | undefined): SafetyOptions {
  const raw = options?.disable
  const list = Array.isArray(raw) ? raw.filter((id): id is FeatureID => FEATURE_IDS.includes(id as FeatureID)) : []
  const allow = options?.opAllow
  const opAllow = Array.isArray(allow) ? allow.filter((entry): entry is string => typeof entry === "string") : []
  return { disabled: new Set(list), redact: readRedactOptions(options), opAllow, scratchDirs: options?.scratchDirs !== false }
}

/** The directory a shell call runs in: its `workdir`, resolved against the session's directory. */
export function shellCwd(workdir: string | undefined, sessionDirectory: string): string {
  if (workdir === undefined) return sessionDirectory
  return isAbsolute(workdir) ? workdir : resolve(sessionDirectory, workdir)
}

/** The evaluation fields the gate reads and writes. */
export type Evaluation = {
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly source?: { readonly type: string; readonly id?: string }
  effect: "allow" | "deny" | "ask"
  message?: string
}

/** Apply a decision to an evaluation without ever loosening it. */
export function applyDecision(evaluation: Evaluation, decision: Decision | undefined): void {
  if (decision === undefined || evaluation.effect === "deny") return
  if (decision.effect === "deny") {
    evaluation.effect = "deny"
    evaluation.message = decision.message
    return
  }
  evaluation.effect = "ask"
  evaluation.message = evaluation.message ? `${evaluation.message}\n\n${decision.message}` : decision.message
}

/** A hard gate that fails internally lets the call through: a parser bug must not take the shell down. */
function safely<T>(run: () => T): T | undefined {
  try {
    return run()
  } catch {
    return undefined
  }
}

/** A permission review that fails internally asks the owner instead of guessing. */
export async function review(command: string, cwd: string, options: ReviewOptions): Promise<Decision | undefined> {
  try {
    return await reviewPermission(command, cwd, options)
  } catch (error) {
    return {
      effect: "ask",
      message: `safety could not check this command (${error instanceof Error ? error.message : String(error)}); confirm it is safe to run.`,
    }
  }
}

/** Tools that open the path they were given themselves, with no shell between the check and the use. */
export const DIRECT_FILE_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write", "patch", "apply_patch", "glob", "grep", "list"])

const PENDING_TTL_MS = 10 * 60_000

type Pending = { sessionID: string; at: number; decision: Decision | undefined }

/** Test seams; the host never passes these. */
export type Overrides = {
  review?: ReviewOptions
  migrations?: MigrationOptions
  env?: NodeJS.ProcessEnv
  guard?: Pick<GuardOptions, "read" | "analyzeOp" | "providerTypes">
  scratch?: { roots?: readonly string[] }
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.safety",
    async setup(ctx) {
      const { disabled, redact, opAllow, scratchDirs } = readOptions(ctx.options)
      const on = (id: FeatureID) => !disabled.has(id)
      const guardOptions = { ...overrides.guard, disabled: disabled as ReadonlySet<GuardID>, opAllow }
      const reviewOptions: ReviewOptions = { ...overrides.review, disabled: disabled as ReadonlySet<DecisionID> }
      const pending = new Map<string, Pending>()
      const advisor = createPackageAdvisor()

      const sessionDirectory = (sessionID: string): Promise<string> =>
        ctx.session
          .get({ sessionID } as never)
          .then((session) => (session as { location: { directory: string } }).location.directory)
          .catch(() => ctx.location.directory as string)

      // The tool behind each running call, so a permission request can be traced to it.
      const running = new Map<string, { tool: string; at: number }>()

      const prune = () => {
        const cutoff = Date.now() - PENDING_TTL_MS
        for (const [id, entry] of pending) if (entry.at < cutoff) pending.delete(id)
        for (const [id, entry] of running) if (entry.at < cutoff) running.delete(id)
      }

      const before = await ctx.tool.hook("execute.before", async (event) => {
        running.set(event.id, { tool: event.tool, at: Date.now() })
        const call = shellCall(event.tool, event.input)
        if (call === undefined || call.command.trim() === "") return
        let command = call.command
        if (on("close-keywords")) {
          const rewritten = rewriteCloseKeywords(command)
          if (rewritten !== undefined) {
            command = rewritten
            event.input = { ...(event.input as object), command }
          }
        }
        const cwd = shellCwd(call.workdir, await sessionDirectory(event.sessionID))
        const gateCwd = leadingCdCwd(command, cwd)
        // The fnox config is read from the call's own directory, and only when the guard asks for a type;
        // the guard ignores it when the command changes directory.
        let types: ReturnType<typeof readProviderTypes> | undefined
        const providerTypes =
          guardOptions.providerTypes ??
          ((name: string) => {
            types ??= readProviderTypes(cwd)
            return types(name)
          })
        const refusal = safely(() => hardGate(command, gateCwd, { ...guardOptions, providerTypes }))
        if (refusal !== undefined) throw new Error(refusal.reason)
        if (on("external-directory")) {
          const sessionDir = await sessionDirectory(event.sessionID)
          const external =
            safely(() =>
              externalDirectories(shellFlagDirectories(command, leadingCdCwd(command, cwd)), sessionRoots(sessionDir)),
            ) ?? []
          if (external.length > 0)
            await ctx.permission.assert({
              sessionID: event.sessionID,
              agent: event.agent,
              source: { type: "tool", messageID: event.messageID, id: event.id },
              action: "external_directory",
              resources: external.map((item) => item.resource),
              save: external.map((item) => item.save),
            } as never)
        }
        prune()
        const decision = await review(command, cwd, reviewOptions)
        pending.set(event.id, { sessionID: event.sessionID, at: Date.now(), decision })
      })

      const migrations = await ctx.tool.hook("execute.before", async (event) => {
        if (!on("migration-edit") || migrationOverride(overrides.env)) return
        if (!WRITE_TOOLS.has(event.tool) && !isShellTool(event.tool)) return
        const call = shellCall(event.tool, event.input)
        const directory = await sessionDirectory(event.sessionID)
        const cwd = call === undefined ? directory : shellCwd(call.workdir, directory)
        const input = call === undefined ? event.input : { command: call.command }
        const reason = await decideToolCall(event.tool, input, cwd, overrides.migrations).catch(() => undefined)
        if (reason) throw new Error(reason)
      })

      const gate = await ctx.permission.hook("evaluate", async (evaluation) => {
        if (evaluation.action !== "shell" || evaluation.effect === "deny") return
        const id = evaluation.source?.type === "tool" ? evaluation.source.id : undefined
        const entry = id === undefined ? undefined : pending.get(id)
        const decision =
          entry !== undefined
            ? entry.decision
            : await review(
                evaluation.resources.join("\n"),
                await sessionDirectory(evaluation.sessionID),
                reviewOptions,
              )
        applyDecision(evaluation as Evaluation, decision)
      })

      const scratch = scratchDirs
        ? await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
            // A shell command can swap a scratch folder for a symlink between this check and its use, so only
            // direct file tools qualify; an unknown source stays an ask.
            const source = evaluation.source
            const tool = source?.type === "tool" ? running.get(source.id)?.tool : undefined
            if (tool === undefined || !DIRECT_FILE_TOOLS.has(tool)) return
            const roots =
              overrides.scratch?.roots ??
              (await ctx.session
                .get({ sessionID: evaluation.sessionID } as never)
                .then((session) => scratchRoots((session as { projectID: string }).projectID))
                .catch(() => []))
            allowScratch(evaluation, roots)
          })
        : undefined

      const after = await ctx.tool.hook("execute.after", (event) => {
        pending.delete(event.id)
        running.delete(event.id)
        if (!on("package-investigate") || event.status !== "completed") return
        const call = shellCall(event.tool, event.input)
        if (call === undefined) return
        const notice = advisor.notice(event.sessionID, call.command)
        if (notice !== undefined) event.result = appendResultText(event.result, notice)
      })

      // Registered last so it also sees the notices the hooks above append.
      const redactor = redact.enabled ? createRedactor(() => overrides.env ?? process.env, redact) : undefined
      const redacting = redactor
        ? [
            await ctx.shell.hook("create.before", (event) => redactor.absorb(event.env)),
            await ctx.tool.hook("execute.after", (event) => {
              redactor.refresh()
              if (redactor.secrets().length === 0) return
              if (event.status === "completed") {
                event.result = redactor.value(event.result)
                return
              }
              const { message, error, metadata } = event.error
              const clean = { message: redactor.text(message), error: redactor.value(error), metadata: redactor.value(metadata) }
              if (clean.message === message && clean.error === error && clean.metadata === metadata) return
              event.error = new ToolError({
                message: clean.message,
                ...(clean.error === undefined ? {} : { error: clean.error }),
                ...(clean.metadata === undefined ? {} : { metadata: clean.metadata }),
              })
            }),
          ]
        : []

      return async () => {
        for (const registration of redacting.reverse()) await registration.dispose()
        await after.dispose()
        await scratch?.dispose()
        await gate.dispose()
        await migrations.dispose()
        await before.dispose()
        pending.clear()
      }
    },
  })
}

export default createPlugin()
