import { isAbsolute, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { appendResultText, leadingCdCwd, shellCall } from "@srobroek/opencode-lib"
import { rewriteCloseKeywords } from "./close-keywords.ts"
import { GUARD_IDS, type GuardID, hardGate } from "./guards.ts"
import { createPackageAdvisor } from "./package-investigate.ts"
import { type Decision, type DecisionID, type ReviewOptions, reviewPermission } from "./permission.ts"

export { normalize as normalizeCloseKeywords, rewriteCloseKeywords } from "./close-keywords.ts"
export { hardGate, MESSAGES } from "./guards.ts"
export { INVESTIGATE_NOTICE, packagesToInvestigate } from "./package-investigate.ts"
export { reviewPermission } from "./permission.ts"

export type FeatureID = GuardID | DecisionID | "close-keywords" | "package-investigate"

export const FEATURE_IDS: readonly FeatureID[] = [
  ...GUARD_IDS,
  "force-push",
  "sudo-destructive",
  "worktree-destruction",
  "close-keywords",
  "package-investigate",
]

export type SafetyOptions = { disabled: ReadonlySet<FeatureID> }

/** `{ disable: ["git-defender", …] }` turns features off; unknown ids are ignored. */
export function readOptions(options: Readonly<Record<string, unknown>> | undefined): SafetyOptions {
  const raw = options?.disable
  const list = Array.isArray(raw) ? raw.filter((id): id is FeatureID => FEATURE_IDS.includes(id as FeatureID)) : []
  return { disabled: new Set(list) }
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

const PENDING_TTL_MS = 10 * 60_000

type Pending = { sessionID: string; at: number; decision: Decision | undefined }

/** Test seams; the host never passes these. */
export type Overrides = { review?: ReviewOptions }

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.safety",
    async setup(ctx) {
      const { disabled } = readOptions(ctx.options)
      const on = (id: FeatureID) => !disabled.has(id)
      const guardOptions = { disabled: disabled as ReadonlySet<GuardID> }
      const reviewOptions: ReviewOptions = { ...overrides.review, disabled: disabled as ReadonlySet<DecisionID> }
      const pending = new Map<string, Pending>()
      const advisor = createPackageAdvisor()

      const sessionDirectory = (sessionID: string): Promise<string> =>
        ctx.session
          .get({ sessionID } as never)
          .then((session) => (session as { location: { directory: string } }).location.directory)
          .catch(() => ctx.location.directory as string)

      const prune = () => {
        const cutoff = Date.now() - PENDING_TTL_MS
        for (const [id, entry] of pending) if (entry.at < cutoff) pending.delete(id)
      }

      const before = await ctx.tool.hook("execute.before", async (event) => {
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
        const refusal = safely(() => hardGate(command, leadingCdCwd(command, cwd), guardOptions))
        if (refusal !== undefined) throw new Error(refusal.reason)
        prune()
        const decision = await review(command, cwd, reviewOptions)
        pending.set(event.id, { sessionID: event.sessionID, at: Date.now(), decision })
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

      const after = await ctx.tool.hook("execute.after", (event) => {
        pending.delete(event.id)
        if (!on("package-investigate") || event.status !== "completed") return
        const call = shellCall(event.tool, event.input)
        if (call === undefined) return
        const notice = advisor.notice(event.sessionID, call.command)
        if (notice !== undefined) event.result = appendResultText(event.result, notice)
      })

      return async () => {
        await after.dispose()
        await gate.dispose()
        await before.dispose()
        pending.clear()
      }
    },
  })
}

export default createPlugin()
