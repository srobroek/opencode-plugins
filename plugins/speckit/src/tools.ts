/**
 * The `speckit_setup` and `speckit_start` tools: input schemas, input validation and the
 * result each call returns. The plugin entry registers them; nothing here touches the host.
 */

import { isAbsolute, resolve } from "node:path"
import { DEFAULT_INTEGRATION, runSetup, type SetupParams } from "./setup.ts"
import { type Approval, PROFILES, type Profile } from "./spec-start.ts"
import {
  BEADS_LOCK,
  IncompleteStart,
  type LockModule,
  type RuntimeOptions,
  runSpecStart,
} from "./spec-start-runtime.ts"

export const SETUP_TOOL = "speckit_setup"
export const START_TOOL = "speckit_start"

export type ToolOutput = { content: string; metadata: Record<string, unknown> }

export function setupInput(integration: string) {
  return {
    type: "object",
    properties: {
      integration: {
        type: "string",
        description: `specify init integration (default ${integration})`,
      },
      script: { type: "string", enum: ["sh", "ps"], description: "default sh" },
      force: { type: "boolean", description: "Re-run specify init over an existing .specify" },
      workspace: { type: "string", description: "Repository root; defaults to the session directory" },
      installAllowed: {
        type: "boolean",
        description: "Trust the public community catalog (--install-allowed); only after vetting the extensions",
      },
      skipBeads: { type: "boolean", description: "Omit beads and formulas (no molecule workflows)" },
      skipSpecify: { type: "boolean", description: "Formulas and gitignore only" },
    },
    additionalProperties: false,
  } as const
}

export const SETUP_DESCRIPTION =
  "Resumable SpecKit bootstrap in the session's workspace; a rerun skips the phases already done.\n" +
  "Phases: specify init, opt-in community catalog, optional extensions, bd init, bundled bd formulas, gitignore spec-status.md. Extension errors are reported as skipped with reasons; setup continues and retries them on rerun. Other failures stop setup. Each phase has its own timeout."

export const START_INPUT = {
  type: "object",
  properties: {
    spec: {
      type: "string",
      pattern: "^[0-9]{3}-[a-z0-9-]+$",
      description: "NNN-slug spec identity; optional on resume when root is given",
    },
    workspace: { type: "string", description: "Repository root with .beads; defaults to the SpecKit workspace" },
    profile: { type: "string", enum: [...PROFILES], description: "default speckit-feature" },
    root: { type: "string", description: "Existing run root; required when several runs exist" },
    approvals: {
      type: "string",
      enum: ["yes", "no"],
      description: "The user's answer to the approval question; on a migration keep the pending no",
    },
    decision: { type: "string", description: "The user's decision, kept in history" },
    migrate: {
      type: "boolean",
      description: "Only after MIGRATION_REQUIRED: true for the user's yes to migrating, with approvals=no and root",
    },
  },
  additionalProperties: false,
} as const

export const START_DESCRIPTION =
  "Start or resume a spec workflow, with an explicit routine approval choice from the user before pouring.\n" +
  "Persists and reads back the answer, reuses it on resume, and requires separate consent to migrate an existing gated run. Holds the Beads store's write lock for the whole start. Returns CHOICE_REQUIRED or MIGRATION_REQUIRED with a question to ask the user, READY when the run can advance, or INCOMPLETE (store-lock wait ran out, a bd command passed its bound, or cancellation) with the step reached and whether a pour was issued; inspect the run before retrying. Reviews, tests and safety confirmations remain required."

const within = (base: string, path: string | undefined) =>
  path === undefined ? base : isAbsolute(path) ? path : resolve(base, path)

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}

/**
 * The directory a tool call resolves its paths against: the session directory when the
 * input names a `workspace` (relative to the session, as the caller wrote it), else the
 * session's SpecKit workspace, else the session directory.
 */
export function toolDirectory(
  input: unknown,
  session: string,
  speckitWorkspace: (directory: string) => string | undefined,
): string {
  return record(input).workspace === undefined ? (speckitWorkspace(session) ?? session) : session
}

/** The repository `speckit_setup` bootstraps for this input, as `runSetup` resolves it. */
export function setupTarget(input: unknown, directory: string): string {
  const workspace = record(input).workspace
  return typeof workspace === "string" && workspace !== "" ? resolve(directory, workspace) : directory
}

/** Validate `speckit_setup` input, or return why it is unusable. */
export function readSetupParams(input: unknown): SetupParams | string {
  const value = record(input)
  const params: SetupParams = {}
  for (const key of ["integration", "script", "workspace"] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== "string" || field === "") return `${key} must be a non-empty string`
    params[key] = field
  }
  for (const key of ["force", "installAllowed", "skipSpecify", "skipBeads"] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== "boolean") return `${key} must be a boolean`
    params[key] = field
  }
  return params
}

export async function executeSetup(
  input: unknown,
  directory: string,
  integration = DEFAULT_INTEGRATION,
  signal?: AbortSignal,
): Promise<ToolOutput> {
  const params = readSetupParams(input)
  if (typeof params === "string") return { content: `${SETUP_TOOL}: ${params}`, metadata: { ok: false } }
  try {
    const result = await runSetup({ integration, ...params }, directory, signal)
    return { content: result.text, metadata: { ok: result.ok, phases: result.phases } }
  } catch (error) {
    return {
      content: `setup failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { ok: false },
    }
  }
}

/** Validate `speckit_start` input, or return why it is unusable. */
export function readStartParams(input: unknown, directory: string): RuntimeOptions | string {
  const value = record(input)
  if (value.spec === undefined && value.root === undefined) return "spec or root is required"
  const options: RuntimeOptions = { workspace: directory }
  if (value.spec !== undefined) {
    if (typeof value.spec !== "string" || value.spec === "") return "spec must be a non-empty string"
    options.spec = value.spec
  }
  if (value.workspace !== undefined) {
    if (typeof value.workspace !== "string" || value.workspace === "") return "workspace must be a non-empty string"
    options.workspace = within(directory, value.workspace)
  }
  if (value.profile !== undefined) {
    if (!PROFILES.includes(value.profile as Profile)) return `profile must be one of ${PROFILES.join(", ")}`
    options.profile = value.profile as Profile
  }
  if (value.approvals !== undefined) {
    if (value.approvals !== "yes" && value.approvals !== "no") return "approvals must be exactly yes or no"
    options.approvals = value.approvals as Approval
  }
  for (const key of ["root", "decision"] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== "string") return `${key} must be a string`
    options[key] = field
  }
  if (value.migrate !== undefined) {
    if (typeof value.migrate !== "boolean") return "migrate must be a boolean"
    options.migrate = value.migrate
  }
  return options
}

export async function executeStart(
  input: unknown,
  directory: string,
  signal?: AbortSignal,
  lock: LockModule = BEADS_LOCK,
): Promise<ToolOutput> {
  const options = readStartParams(input, directory)
  if (typeof options === "string")
    return { content: `${START_TOOL}: ${options}`, metadata: { ok: false, status: "FAIL" } }
  try {
    const result = await runSpecStart(options, signal, undefined, lock)
    const { text, ...rest } = result
    return { content: text, metadata: { ok: true, ...rest } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const details = error instanceof IncompleteStart ? error.details : { status: "FAIL" }
    return { content: message, metadata: { ok: false, ...details } }
  }
}
