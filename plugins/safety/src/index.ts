import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { Tool } from "@opencode/plugin/effect"
import { appendResultText, isShellTool, leadingCdCwd, shellCall, WRITE_TOOLS } from "@srobroek/opencode-lib"
import { hostWarn, type Warn } from "@srobroek/opencode-lib/host-log"
import { rewriteCloseKeywords } from "./close-keywords.ts"
import { externalDirectories, sessionRoots, shellFlagDirectories } from "./flag-directories.ts"
import { readConfigSnapshot, readProviderTypes } from "./fnox-config.ts"
import { GUARD_IDS, type GuardID, type GuardOptions, hardGate } from "./guards.ts"
import { decideToolCall, type MigrationOptions, migrationOverride } from "./migrations.ts"
import { createPackageAdvisor } from "./package-investigate.ts"
import { type Decision, type DecisionID, type ReviewOptions, reviewPermission } from "./permission.ts"
import { createRedactor, type RedactOptions, readRedactOptions } from "./redact.ts"
import { allowScratch, scratchRoots } from "./scratch-dirs.ts"
import {
  COMMAND_ACTION,
  type Destination,
  runChild,
  STORE_ACTION,
  type StoreDeps,
  type StoreRequest,
  storeSecret,
} from "./secret-store.ts"
import { allowSkillReads, listedSkills, READ_ONLY_TOOLS, skillDirectories } from "./skill-references.ts"
import { denyUnanswerable, type SessionInfo, unanswerableDenial } from "./subagent-prompts.ts"

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
export { allowSkillReads, skillDirectories } from "./skill-references.ts"
export { denyUnanswerable, unanswerableMessage } from "./subagent-prompts.ts"

export type FeatureID =
  | GuardID
  | DecisionID
  | "close-keywords"
  | "package-investigate"
  | "migration-edit"
  | "external-directory"
  | "skill-references"
  | "subagent-prompts"

export const FEATURE_IDS: readonly FeatureID[] = [
  ...GUARD_IDS,
  "force-push",
  "sudo-destructive",
  "worktree-destruction",
  "close-keywords",
  "package-investigate",
  "migration-edit",
  "external-directory",
  "skill-references",
  "subagent-prompts",
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
 * `disable: ["skill-references"]` stops allowing reads in installed skills' directories, and
 * `disable: ["subagent-prompts"]` lets a subagent session's asks prompt instead of failing at once.
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

/** The `permission.asked` payload fields the backstop reads. */
type AskedRequest = {
  readonly id?: string
  readonly sessionID?: string
  readonly action?: string
  readonly resources?: ReadonlyArray<string>
  readonly message?: string
}

/** Test seams; the host never passes these. */
export type Overrides = {
  review?: ReviewOptions
  migrations?: MigrationOptions
  env?: NodeJS.ProcessEnv
  guard?: Pick<GuardOptions, "read" | "analyzeOp" | "providerTypes">
  scratch?: { roots?: readonly string[] }
  secretStore?: Partial<Pick<StoreDeps, "run" | "which" | "env" | "home">>
  warn?: Warn
}

/** The model-facing schema of `safety_secret_store`; `parseRequest` checks every field again. */
export const SECRET_STORE_INPUT = {
  type: "object",
  properties: {
    name: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$", description: "fnox secret name" },
    target: {
      type: "object",
      description:
        '{kind:"1password", vault, item, field?="credential", tags?, provider?} or {kind:"fnox-store", provider} (a value-store provider such as host)',
      properties: {
        kind: { type: "string", enum: ["1password", "fnox-store"] },
        vault: { type: "string" },
        item: { type: "string", description: "1Password item title; no '/'" },
        field: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        provider: { type: "string", description: "fnox provider; for 1password, default the only 1Password provider" },
      },
      required: ["kind"],
    },
    generate: {
      type: "object",
      description: "A CSPRNG value of at least 128 bits: one of bytes (entropy) or length (characters)",
      properties: {
        charset: { type: "string", enum: ["hex", "base64url", "alnum", "ascii-printable"] },
        bytes: { type: "integer" },
        length: { type: "integer" },
      },
      required: ["charset"],
    },
    command: {
      type: "object",
      description: "Run argv with no shell after asking the user; runs with your permission; approve only commands you trust. Its stdout is the value",
      properties: { argv: { type: "array", items: { type: "string" }, minItems: 1 }, cwd: { type: "string" } },
      required: ["argv"],
    },
    config: { type: "string", description: "Existing fnox config file fnox gets as --config (default fnox.toml); outside the project asks first" },
    description: { type: "string", description: "fnox secret description" },
  },
  required: ["name", "target"],
  additionalProperties: false,
} as const

/** Turn an allowed secret command run into a prompt, so every run asks; a configured deny stays a deny. */
export function confirmSecretCommand(evaluation: Evaluation): void {
  if (evaluation.action !== COMMAND_ACTION || evaluation.effect !== "allow") return
  evaluation.effect = "ask"
  evaluation.message = `Run this command for ${STORE_ACTION}? Its stdout becomes the secret and is never shown.`
}

/** The canonical path of an existing file or directory, symlinks resolved; `undefined` when missing. */
function canonical(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** The store permission's resource: the secret name, where its value goes and the config fnox writes. */
export function storeResource(request: StoreRequest, destination: Destination): string {
  const target = request.target
  const where =
    target.kind === "1password"
      ? `1password ${target.vault}/${target.item}/${target.field} (fnox provider ${destination.provider})`
      : `fnox provider ${destination.provider}`
  return `${request.name} -> ${where} in ${destination.file}`
}

/** argv as one shell-quoted line, for the permission prompt. */
export function displayArgv(argv: readonly string[]): string {
  return argv.map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(" ")
}

/** The process environment with unset entries dropped, as a child's environment. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.safety",
    async setup(ctx) {
      // Bound before the first await, while the fiber still carries the host's logger.
      const warn = overrides.warn ?? hostWarn("srobroek.safety")
      const { disabled, redact, opAllow, scratchDirs } = readOptions(ctx.options)
      const on = (id: FeatureID) => !disabled.has(id)
      const guardOptions = {
        env: overrides.env ?? process.env,
        ...overrides.guard,
        disabled: disabled as ReadonlySet<GuardID>,
        opAllow,
      }
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
          ((name: string, config?: string) => {
            types ??= readProviderTypes(cwd)
            return types(name, config)
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

      const skillReads = on("skill-references")
        ? await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
            const source = evaluation.source
            const tool = source?.type === "tool" ? running.get(source.id)?.tool : undefined
            if (tool === undefined || !READ_ONLY_TOOLS.has(tool)) return
            const directory = await sessionDirectory(evaluation.sessionID)
            const listed = await ctx.skill.list({ location: { directory } } as never).catch(() => undefined)
            allowSkillReads(evaluation, skillDirectories(listedSkills(listed)))
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

      const secretTool = await ctx.tool.transform((editor) => {
        editor.add({
          name: STORE_ACTION,
          description:
            "Store a new secret in 1Password or a fnox store without a shell: generated, or the stdout of a command you name.\n" +
            "The value never reaches a command line, an environment, a log, an error or this result. `generate` draws from a " +
            "CSPRNG. `command` runs argv with no shell after the user allows that run; its stdout, one trailing newline trimmed " +
            "and at most 64 KiB, is the value. Target `1password` pipes the item JSON to `op item create --vault <vault> -`, then " +
            "records `fnox set NAME '<item>/<field>'` with the config's 1Password provider. Target `fnox-store` pipes the value " +
            "to `fnox set NAME --provider <p>` for a value-store provider and replaces an existing value. A failure gives the " +
            "stage and exit code only and is not retried.",
          input: SECRET_STORE_INPUT,
          execute: async (input, context) => {
            // `signal` is undefined on hosts older than OpenCode 2.3.
            if (context.signal?.aborted === true) return { content: "safety_secret_store stopped before it started; nothing was stored." }
            const directory = await sessionDirectory(context.sessionID)
            const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
            const env = overrides.secretStore?.env ?? stringEnv(process.env)
            const home = overrides.secretStore?.home ?? homedir()
            const deps: StoreDeps = {
              directory,
              roots: sessionRoots(directory).map((root) => canonical(root) ?? root),
              env,
              home,
              which: (bin, cwd) => Bun.which(bin, { PATH: env.PATH ?? "", cwd }),
              realpath: canonical,
              // A fresh read every time: the tool compares the config before and after the value is obtained.
              snapshot: (path) => readConfigSnapshot(directory, path, home),
              run: runChild,
              ...overrides.secretStore,
              ...(context.signal ? { signal: context.signal } : {}),
              askExternal: (external) =>
                ctx.permission.assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                  action: "external_directory",
                  resources: external.map((item) => item.resource),
                  save: external.map((item) => item.save),
                } as never),
              askStore: (request, destination) => {
                const resource = storeResource(request, destination)
                return ctx.permission.assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                  action: STORE_ACTION,
                  resources: [resource],
                  save: [resource],
                  metadata: {
                    name: request.name,
                    target: request.target,
                    provider: destination.provider,
                    config: destination.file,
                    source: request.source.kind,
                  },
                } as never)
              },
              askCommand: (argv, cwd) =>
                ctx.permission.assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                  action: COMMAND_ACTION,
                  resources: [`${displayArgv(argv)}  (in ${cwd})`],
                  metadata: { argv, cwd },
                } as never),
            }
            const result = await storeSecret(input, deps)
            const where = "reference" in result ? `reference ${result.reference}` : `provider ${result.provider}`
            return { content: `Stored ${result.name} (${where}).`, metadata: result }
          },
        })
      })
      const confirmCommand = await ctx.permission.hook("evaluate", (evaluation) => confirmSecretCommand(evaluation as Evaluation))

      // Registered after this plugin's other evaluate hooks, so it sees the asks they leave or add.
      const sessionInfo = (sessionID: string): Promise<SessionInfo | undefined> =>
        ctx.session
          .get({ sessionID } as never)
          .then((info) => info as SessionInfo)
          .catch((error: unknown) => {
            // The error's name only: a host message could carry a path.
            warn("session lookup failed; the permission prompt stays", {
              sessionID,
              error: error instanceof Error ? error.name : typeof error,
            })
            return undefined
          })
      const unanswerable = on("subagent-prompts")
        ? await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.effect !== "ask") return
            denyUnanswerable(evaluation, await sessionInfo(evaluation.sessionID))
          })
        : undefined

      // A plugin whose evaluate hook runs after this one can still raise a prompt in a subagent session,
      // so every prompt the host raises in this location is checked again and rejected through the reply API.
      const watching = new AbortController()
      const asked = on("subagent-prompts")
        ? ctx.event.subscribe({ types: ["permission.asked"], signal: watching.signal } as never)[Symbol.asyncIterator]()
        : undefined
      if (asked)
        void (async () => {
            for (;;) {
              const next = await asked.next().catch(() => ({ done: true as const, value: undefined }))
              if (next.done || watching.signal.aborted) return
              const event = next.value as { type?: string; data?: AskedRequest }
              if (event.type !== "permission.asked" || event.data === undefined) continue
              await rejectUnanswerable(event.data).catch((error: unknown) =>
                warn("could not reject a subagent's permission prompt", {
                  sessionID: event.data?.sessionID,
                  error: error instanceof Error ? error.name : typeof error,
                }),
              )
            }
          })()
      async function rejectUnanswerable(request: AskedRequest): Promise<void> {
        if (typeof request.sessionID !== "string" || typeof request.id !== "string") return
        const message = unanswerableDenial(
          { action: request.action ?? "permission", resources: request.resources ?? [], message: request.message },
          await sessionInfo(request.sessionID),
        )
        if (message === undefined) return
        await ctx.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: "reject", message } as never)
      }

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
              event.error = new Tool.Error({
                message: clean.message,
                ...(clean.error === undefined ? {} : { error: clean.error }),
                ...(clean.metadata === undefined ? {} : { metadata: clean.metadata }),
              })
            }),
          ]
        : []

      return async () => {
        for (const registration of redacting.reverse()) await registration.dispose()
        await unanswerable?.dispose()
        watching.abort()
        // Ending the iterator ends the loop above; it is not awaited, since a pending read may never settle.
        void asked?.return?.()
        await confirmCommand.dispose()
        await secretTool.dispose()
        await after.dispose()
        await skillReads?.dispose()
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
