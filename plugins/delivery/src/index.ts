import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { keepFallback, ownedElsewhere } from "@srobroek/opencode-lib/agent-fallback"
import { grantTools, mcpGrant } from "@srobroek/opencode-lib/agent-tools"
import { appendResultText, shellOutput } from "@srobroek/opencode-lib/shell-result"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import {
  AGENT_IDS,
  type Available,
  FALLBACK_AGENTS,
  fallbackModel,
  hasModelRoles,
  loadAgents,
  shapeAgent,
} from "./agents.ts"
import {
  type CleanupReport,
  inlineCleanupDecision,
  nextAfterCleanup,
  runInlineCleanup,
  textAfterCleanup,
} from "./auto-cleanup.ts"
import { type CleanupResult, cleanupDelivery, type DeliveryCleanupParams, type HostWorktrees } from "./cleanup.ts"
import { MERGE_METHODS } from "./forge-adapter.ts"
import { type LandOutcome, type LandParams, landPullRequest } from "./land.ts"
import { CleanupDeferred, createPendingCleanup, type PendingDeps } from "./pending-cleanup.ts"
import { malformedNote, parseVerdict } from "./verdict.ts"

export {
  AGENT_IDS,
  availableModel,
  FALLBACK_AGENTS,
  fallbackModel,
  hasModelRoles,
  parseAgentFile,
  parseModel,
  shapeAgent,
} from "./agents.ts"
export { cleanupDelivery } from "./cleanup.ts"
export { landPullRequest } from "./land.ts"
export { AGENT_VERDICTS, parseVerdict } from "./verdict.ts"

export const LAND_ACTION = "delivery_land"
export const CLEANUP_ACTION = "delivery_cleanup"
export const SKILL_PATH = fileURLToPath(new URL("../skills/delivery-git-workflow/SKILL.md", import.meta.url))
export const FAN_OUT_SKILL_PATH = fileURLToPath(new URL("../skills/delivery-fan-out/SKILL.md", import.meta.url))
export const FAN_OUT_PATH = fileURLToPath(new URL("../instructions/delivery-fan-out.md", import.meta.url))

export type DeliveryOptions = {
  /** Ask before every land and cleanup even when the permission policy allows them. Default true. */
  confirm: boolean
  /** Receipts root; default `$DELIVERY_RECEIPTS_DIR`, then `~/.omp/receipts`. */
  receiptsDirectory?: string
  /** Register the delivery agents. Default true. */
  agents: boolean
  /**
   * Per-agent model override (`provider/model#variant`), or false for no model. Without
   * an override, an agent's file model applies only when the model-roles plugin is absent.
   */
  models: Record<string, string | false>
  /** Add the short fan-out instructions to primary sessions that can call `subagent`. Default true. */
  fanOut: boolean
  /** Parse delivery-agent verdicts into subagent result metadata. Default true. */
  verdicts: boolean
  /** Run the cleanup in-process after a successful land. Default true. */
  autoCleanup: boolean
}

/** `plugin.list` during setup must not hold up startup; a slow answer counts as "not installed". */
const PLUGIN_LIST_TIMEOUT_MS = 2000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export function parseOptions(raw: Record<string, unknown> | undefined): DeliveryOptions {
  const options = raw ?? {}
  const models: Record<string, string | false> = {}
  if (typeof options.models === "object" && options.models !== null) {
    for (const [id, value] of Object.entries(options.models as Record<string, unknown>)) {
      if (typeof value === "string" || value === false) models[id] = value
    }
  }
  return {
    confirm: options.confirm !== false,
    receiptsDirectory: typeof options.receiptsDirectory === "string" ? options.receiptsDirectory : undefined,
    agents: options.agents !== false,
    models,
    fanOut: options.fanOut !== false,
    verdicts: options.verdicts !== false,
    autoCleanup: options.autoCleanup !== false,
  }
}

type Evaluation = {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  effect: string
  message?: string
}

/** Turn an allowed land or cleanup into a prompt; a configured deny never reaches the hook. */
export function confirmDelivery(evaluation: Evaluation): void {
  if (evaluation.effect !== "allow") return
  if (evaluation.action === LAND_ACTION) {
    evaluation.effect = "ask"
    evaluation.message = `Land ${evaluation.resources.join(", ")}? delivery_land merges at most once and writes a landing receipt.`
  } else if (evaluation.action === CLEANUP_ACTION) {
    evaluation.effect = "ask"
    evaluation.message = `Remove worktree ${evaluation.resources.join(", ")} and delete its local branch?`
  }
}

const LAND_INPUT = {
  type: "object",
  properties: {
    pr: { type: ["integer", "string"], description: "PR or MR number" },
    merge_method: { type: "string", enum: [...MERGE_METHODS], description: "default squash" },
    repo: { type: "string", description: '"<owner>/<name>"; defaults to the remote URL path' },
    remote: { type: "string", description: 'Forge remote; default "origin"' },
    expectHeadSha: {
      type: "string",
      description: "The reviewed head; required to merge, optional when proving an already MERGED PR",
    },
    requireApproval: {
      type: "boolean",
      description: "Require an APPROVED review or a 'VERDICT: APPROVE' author comment for the exact head",
    },
    requireGreenChecks: { type: "boolean", description: "Require every check on the head to pass" },
    queueWaitSeconds: { type: "integer", description: "Merge queue: seconds to wait for the merge, 0-3600; default 600" },
    setupAutoDelete: { type: "boolean", description: "Enable deletion-on-merge after the landing is proved" },
    worktree: { type: "string", description: "Landed worktree for cleanup (HEAD = PR head); inferred if omitted" },
    beadId: {
      type: "string",
      description: "Bead this closes when the branch is not <omp|opencode>/agent/<bead-id>; required then on a ledger",
    },
  },
  required: ["pr"],
  additionalProperties: false,
} as const

const LAND_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    receiptPath: { type: "string" },
    mergeSha: { type: "string" },
    pr: { type: "integer" },
    repo: { type: "string" },
    next: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    mergeIssued: { type: "boolean" },
    queued: { type: "boolean" },
    receipt: { type: "object" },
    cleanup: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        reason: { type: "string" },
        removed: { type: "string" },
        localRefDeleted: { type: "boolean" },
        skipped: { type: "boolean" },
        deferred: { type: "string" },
        denied: { type: "boolean" },
      },
      required: ["ok"],
    },
  },
  required: ["ok"],
} as const

const CLEANUP_INPUT = {
  type: "object",
  properties: {
    receipt: {
      type: "string",
      minLength: 1,
      description: "Path to a canonical landing receipt; omit to select the newest for this repository",
    },
    pr: { type: "integer", minimum: 1, description: "PR number, which must equal the selected receipt" },
    branch: { type: "string", minLength: 1, description: "Branch, which must equal the selected receipt" },
    worktree: { type: "string", minLength: 1, description: "Worktree path, which must equal the selected receipt" },
    remote: { type: "string", minLength: 1, description: "Remote name, which must equal the selected receipt" },
  },
  additionalProperties: false,
} as const

const CLEANUP_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    receiptPath: { type: "string" },
    branch: { type: "string" },
    worktree: { type: "string" },
    remoteBranchAbsence: { type: "string", enum: ["absent", "present", "unknown"] },
    reason: { type: "string" },
    deferred: { type: "string" },
    receipt: { type: "object" },
  },
  required: ["ok"],
} as const

/** What `delivery_cleanup` returns when the worktree belongs to a lane: nothing removed, the owner does it. */
function deferredOutput(deferred: string) {
  return { ok: true as const, deferred }
}

const LAND_DESCRIPTION =
  "Merge a reviewed pull request at most once, prove it landed, and write one landing receipt.\n" +
  "Refuses unless expectHeadSha names the PR head (required whenever the call would merge) " +
  "and, when worktree is given, it is a worktree of the session repository (never another repository's) whose HEAD is that head. With requireApproval/requireGreenChecks it also requires an approval artifact on the PR for that exact head " +
  "and green checks before merging. Merges at most once (an already MERGED request is proved, not re-merged) with merge_method (squash by default, PR title as subject), " +
  "binds the merge to the head, re-reads it, fetches the landed commits and checks the method's commit shape, observes the remote branch, then writes the receipt. " +
  "Writes no Beads ledger: when beads.ledgerActive, run the returned next steps child-before-parent, then delivery_cleanup. " +
  "A base branch with a GitHub merge queue is landed by enqueuing the head (never --auto): queued true means still queued, call again. " +
  "A refusal with mergeIssued true means the PR is merged: re-run with the same pr and expectHeadSha to write the receipt."

const CLEANUP_DESCRIPTION =
  "Remove a landed PR's worktree and local branch after proving the landing receipt, and write a continuation receipt.\n" +
  "Recomputes the ledger classification at the canonical root, proves the PR merged at the recorded head from the receipt's own remote, " +
  "checks every receipt bead is closed with metadata.merge_sha equal to the merge (read-only bd show), refuses to remove the worktree it runs from, a dirty tree or unpushed commits, a receipt or worktree of another repository, " +
  "then removes the worktree (no force; through OpenCode when it tracks it, else git worktree remove) and runs git branch -d and verifies four absences."

export function landOutput(outcome: LandOutcome, cleanup?: CleanupReport) {
  if (!outcome.ok) {
    return {
      ok: false as const,
      reason: outcome.reason,
      ...(outcome.mergeIssued === true ? { mergeIssued: true } : {}),
      ...(outcome.queued === true ? { queued: true } : {}),
    }
  }
  return {
    ok: true as const,
    receiptPath: outcome.receiptPath,
    mergeSha: outcome.receipt.pr.mergeCommitOid ?? "",
    pr: outcome.receipt.pr.number,
    repo: outcome.receipt.repo.nameWithOwner,
    next: nextAfterCleanup(outcome.next, cleanup),
    ...(cleanup === undefined ? {} : { cleanup }),
    receipt: outcome.receipt as Record<string, unknown>,
  }
}

function cleanupOutput(result: CleanupResult) {
  if (!result.ok) return { ok: false as const, reason: result.reason }
  return {
    ok: true as const,
    receiptPath: result.path,
    branch: result.receipt.branch.name,
    worktree: result.receipt.worktree.path ?? "",
    remoteBranchAbsence: result.remoteBranchAbsence,
    receipt: result.receipt as Record<string, unknown>,
  }
}

/** The persisted metadata: the output without the full receipt, which lives on disk. */
function metadataOf(output: Record<string, unknown>): Record<string, unknown> {
  const { receipt: _receipt, ...rest } = output
  return rest
}

/**
 * OpenCode's worktree registry for this project. Undefined when the host reports no
 * project or an older host has no `worktree` list/remove, so cleanup keeps the git path.
 */
export function hostWorktrees(ctx: Context): HostWorktrees | undefined {
  const projectID = ctx.location.project?.id
  const worktree = (ctx as { worktree?: Partial<Context["worktree"]> }).worktree
  if (projectID === undefined) return undefined
  if (typeof worktree?.list !== "function" || typeof worktree.remove !== "function") return undefined
  const { list, remove } = worktree
  return {
    list: () => list.call(worktree, { projectID }),
    remove: (directory) => remove.call(worktree, { projectID, directory, force: false }),
  }
}

function environment(options: DeliveryOptions): NodeJS.ProcessEnv {
  return options.receiptsDirectory === undefined
    ? process.env
    : { ...process.env, DELIVERY_RECEIPTS_DIR: options.receiptsDirectory }
}

function asserter(ctx: Context, context: ToolContext, action: string) {
  return async (resource: string, metadata: Record<string, unknown>) => {
    await ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
      action,
      resources: [resource],
      save: [resource],
      metadata,
    } as never)
  }
}

async function isPrimary(ctx: Context, sessionID: string): Promise<boolean> {
  try {
    const session = (await ctx.session.get({ sessionID } as never)) as { parentID?: string } | undefined
    return session?.parentID === undefined || session.parentID === null
  } catch {
    return false
  }
}

export async function setupDelivery(
  ctx: Context,
  overrides: Pick<PendingDeps, "debounceMs" | "now" | "cleanup"> = {},
): Promise<() => Promise<void>> {
  const options = parseOptions(ctx.options as Record<string, unknown>)
  const directory = ctx.location.directory
  const disposers: Array<() => Promise<void>> = []
  // Always set up: denials and landing records coordinate with the lane owner whatever autoCleanup says.
  // autoCleanup only turns delivery's own inline cleanup and retry on or off.
  const pending = createPendingCleanup({
    ctx,
    cwd: directory,
    env: environment(options),
    host: () => hostWorktrees(ctx),
    ...overrides,
  })

  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: LAND_ACTION,
      description: LAND_DESCRIPTION,
      input: LAND_INPUT,
      output: LAND_OUTPUT,
      execute: async (input, context) => {
        const ask = asserter(ctx, context, LAND_ACTION)
        const outcome = await landPullRequest(input as LandParams, {
          cwd: directory,
          env: environment(options),
          signal: context.signal,
          authorize: (request) => ask(request.resource, { ...request }),
        })
        if (!outcome.ok) {
          const output = landOutput(outcome)
          return { output, content: outcome.text, metadata: metadataOf(output) }
        }
        const receiptPath = outcome.receipt.worktree.path
        const decision = inlineCleanupDecision(
          outcome.receipt,
          options.autoCleanup,
          receiptPath === null || pending === undefined ? { owner: "none" } : pending.ownership(receiptPath),
        )
        // A refused prompt is a denial: recorded, and never retried without a new explicit call.
        let denied = false
        // A skipped run is reported only when the option is on; off keeps the old result.
        const cleanup: CleanupReport | undefined = decision.run
          ? await runInlineCleanup(() => {
              const askCleanup = asserter(ctx, context, CLEANUP_ACTION)
              return cleanupDelivery({ receipt: outcome.receiptPath }, directory, {
                env: environment(options),
                signal: context.signal,
                authorize: async (request) => {
                  try {
                    await askCleanup(request.worktree, { ...request })
                  } catch (error) {
                    denied = true
                    throw error
                  }
                },
                ...pending.removal,
                host: hostWorktrees(ctx),
              })
            })
            : options.autoCleanup
              ? decision.deferred === undefined
                ? { ok: false, skipped: true, reason: decision.reason }
                : { ok: false, deferred: decision.deferred }
              : undefined
        if (denied && cleanup !== undefined) cleanup.denied = true
        // Cleanup that did not finish stays pending: delivery retries it when a turn ends.
        if (cleanup?.ok !== true) {
          await pending.record(outcome.receipt, context.sessionID, { denied }).catch(() => {})
        }
        const output = landOutput(outcome, cleanup)
        const content = cleanup === undefined ? outcome.text : textAfterCleanup(outcome.text, cleanup)
        return { output, content, metadata: metadataOf(output) }
      },
    })
    editor.add({
      name: CLEANUP_ACTION,
      description: CLEANUP_DESCRIPTION,
      input: CLEANUP_INPUT,
      output: CLEANUP_OUTPUT,
      execute: async (input, context) => {
        const ask = asserter(ctx, context, CLEANUP_ACTION)
        let result: CleanupResult
        try {
          result = await cleanupDelivery(input as DeliveryCleanupParams, directory, {
            env: environment(options),
            signal: context.signal,
            ...pending.explicit((req) => ask(req.worktree, { ...req }), context.sessionID),
            host: hostWorktrees(ctx),
          })
        } catch (error) {
          if (!(error instanceof CleanupDeferred)) throw error
          const output = deferredOutput(error.deferred)
          return { output, content: `delivery_cleanup deferred: ${error.deferred}`, metadata: metadataOf(output) }
        }
        await pending.gc()
        const output = cleanupOutput(result)
        const text = result.ok
          ? `delivery_cleanup removed ${result.receipt.worktree.path} and branch ${result.receipt.branch.name}; remote branch ${result.remoteBranchAbsence}.\nreceipt: ${result.path}`
          : `delivery_cleanup refused: ${result.reason}`
        return { output, content: text, metadata: metadataOf(output) }
      },
    })
  })
  disposers.push(() => tools.dispose())

  // Delivery's own retry runs only with autoCleanup; the coordination above does not depend on it.
  if (options.autoCleanup) await pending.start()
  disposers.push(() => pending.dispose())

  if (options.confirm) {
    const gate = await ctx.permission.hook("evaluate", confirmDelivery)
    disposers.push(() => gate.dispose())
  }

  if (options.agents) {
    const files = loadAgents()
    let available: Available[] = []
    try {
      available = ((await ctx.model.list()) as { data?: Available[] }).data ?? []
    } catch {
      available = []
    }
    let modelRoles = false
    let owned = new Set<string>()
    try {
      const listed = await withTimeout(ctx.plugin.list(), PLUGIN_LIST_TIMEOUT_MS)
      modelRoles = hasModelRoles(listed)
      owned = ownedElsewhere(listed, FALLBACK_AGENTS)
    } catch {
      modelRoles = false
    }
    const grant = mcpGrant((ctx.options as Record<string, unknown> | undefined)?.tools, files.map((file) => file.id))
    const agents = await ctx.agent.transform((editor) => {
      for (const file of files) {
        const created = editor.get(file.id) === undefined
        if (!keepFallback(file.id, FALLBACK_AGENTS, owned, !created)) continue
        const model = fallbackModel(file, options.models[file.id], modelRoles, available)
        editor.update(file.id, (draft) => shapeAgent(draft as never, grantTools(file, grant), model, created))
      }
    })
    disposers.push(() => agents.dispose())
  }

  if (options.verdicts) {
    const after = await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "subagent" || event.status !== "completed") return
      const input = (event.input ?? {}) as { agent?: unknown }
      const agent = typeof input.agent === "string" ? input.agent : undefined
      const output = event.result.output as { status?: unknown; sessionID?: unknown } | undefined
      if (output?.status === "running") return
      const text = shellOutput(event.result)
      if (text === undefined) return
      const verdict = parseVerdict(
        text,
        agent !== undefined && (AGENT_IDS as readonly string[]).includes(agent) ? agent : undefined,
      )
      if (verdict === undefined) return
      const result = { ...event.result, metadata: { ...event.result.metadata, delivery: verdict } }
      event.result = "reason" in verdict ? appendResultText(result, malformedNote(verdict, output?.sessionID)) : result
    })
    disposers.push(() => after.dispose())
  }

  if (options.fanOut) {
    const fanOut = readFileSync(FAN_OUT_PATH, "utf8").trim()
    const primary = new Map<string, Promise<boolean>>()
    // Also on compaction and generate, so those requests keep the turns' system prompt and prompt cache.
    const addFanOut = async (event: { sessionID: string; agent: string; tools: object; system: Array<{ type: "text"; text: string }> }) => {
      if ((AGENT_IDS as readonly string[]).includes(event.agent)) return
      if (!("subagent" in event.tools)) return
      let known = primary.get(event.sessionID)
      if (known === undefined) {
        known = isPrimary(ctx, event.sessionID)
        primary.set(event.sessionID, known)
      }
      if (await known) event.system.push({ type: "text", text: fanOut })
    }
    const hooks = [
      await ctx.session.hook("context", addFanOut),
      await ctx.session.hook("compaction", addFanOut),
      await ctx.session.hook("generate", addFanOut),
    ]
    disposers.push(async () => {
      for (const hook of hooks) await hook.dispose()
      primary.clear()
    })
  }

  const skills = await registerSkills(ctx.skill, [SKILL_PATH, FAN_OUT_SKILL_PATH])
  disposers.push(() => skills.dispose())

  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}

export default Plugin.define({
  id: "srobroek.delivery",
  setup: (ctx) => setupDelivery(ctx),
})
