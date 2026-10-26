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
        description: `spec-kit integration for specify init (default ${integration}; codex writes the commands as skills under .agents/skills/)`,
      },
      script: { type: "string", enum: ["sh", "ps"], description: "specify script flavor (default sh)" },
      force: { type: "boolean", description: "Re-run specify init even if .specify exists" },
      workspace: {
        type: "string",
        description: "Repository root, resolved against the session's working directory; defaults to it",
      },
      installAllowed: {
        type: "boolean",
        description:
          "Register the public community catalog as a trusted install source (--install-allowed). Opt in only after vetting the required extensions",
      },
      skipBeads: { type: "boolean", description: "Explicitly omit beads and formulas; molecule workflows unavailable" },
      skipSpecify: { type: "boolean", description: "Skip the specify CLI (formulas and gitignore only)" },
    },
    additionalProperties: false,
  } as const
}

export const SETUP_DESCRIPTION =
  "Resumable SpecKit bootstrap in the session's workspace: specify init, opt-in community catalog, required extensions, bd init, copy the bundled bd formulas, gitignore spec-status.md. Every phase reports done, skipped (already present) or failed, has its own timeout, and a rerun skips the phases already done."

export const START_INPUT = {
  type: "object",
  properties: {
    spec: { type: "string", pattern: "^[0-9]{3}-[a-z0-9-]+$", description: "NNN-slug spec identity" },
    workspace: {
      type: "string",
      description: "Canonical repository root containing .beads; defaults to the session's working directory",
    },
    profile: { type: "string", enum: [...PROFILES], description: "Formula to pour (default speckit-feature)" },
    root: { type: "string", description: "Existing run root; required if multiple runs exist" },
    approvals: {
      type: "string",
      enum: ["yes", "no"],
      description: "Explicit user answer, never inferred from unattended mode",
    },
    decision: { type: "string", description: "Explicit user decision to retain in history" },
    migrate: { type: "boolean", description: "Separate explicit authorization to migrate an existing gated run" },
  },
  required: ["spec"],
  additionalProperties: false,
} as const

export const START_DESCRIPTION =
  "Start or resume a spec workflow: ask for an explicit routine approval choice before pouring, persist and read back the answer, reuse it on resume, and require separate consent to migrate an existing gated run. Holds the Beads store's write lock for the whole start. Returns CHOICE_REQUIRED or MIGRATION_REQUIRED with a question to ask the user, READY when the run can advance, or INCOMPLETE (store-lock wait ran out, a bd command passed its bound, or cancellation) with the step reached and whether a pour was issued; inspect the run before retrying. Reviews, tests and safety confirmations remain required."

const within = (base: string, path: string | undefined) =>
  path === undefined ? base : isAbsolute(path) ? path : resolve(base, path)

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}

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
): Promise<ToolOutput> {
  const params = readSetupParams(input)
  if (typeof params === "string") return { content: `${SETUP_TOOL}: ${params}`, metadata: { ok: false } }
  try {
    const result = await runSetup({ integration, ...params }, directory)
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
  if (typeof value.spec !== "string" || value.spec === "") return "spec is required"
  const options: RuntimeOptions = { spec: value.spec, workspace: directory }
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
