/**
 * The `/tiers` editor's draft: one tier's unsaved models (fallback order, each with an
 * optional `#variant`), effort and purpose, the pure operations on it, the config it
 * produces and the options each menu shows. The TUI entry only wires these to dialogs.
 */

import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import type { AgentTierSource } from "./resolve.ts"
import type { TierConfig } from "./tiers.ts"
import { type AgentRow, applyEdit, configuredModels, type PickModel, type TierEdit, type TierRow, tierSummary } from "./tiers-ui.ts"

export type TierDraft = {
  row: TierRow
  /** Entries in fallback order: `provider/model`, `provider/model#variant` or `@tier`. */
  models: string[]
  effort?: string
  purpose: string
  /** Reset to auto was asked: the saved settings are dropped. */
  reset: boolean
  /** A tier not saved yet, so it is always worth saving. */
  isNew: boolean
  initial: { models: string[]; effort?: string; purpose: string }
}

export type Direction = "up" | "down"

/** The model an entry names, without its `#variant`. */
export const entryRef = (entry: string): string => entry.split("#")[0] ?? entry

/** An entry's `#variant`, if any. */
export const entryVariant = (entry: string): string | undefined => {
  const at = entry.indexOf("#")
  return at < 0 ? undefined : entry.slice(at + 1)
}

export function createDraft(row: TierRow, isNew = false): TierDraft {
  const models = configuredModels(row)
  const purpose = row.configured?.purpose ?? row.purpose
  const effort = row.configured?.effort
  return {
    row,
    models: [...models],
    purpose,
    reset: false,
    isNew,
    initial: { models: [...models], purpose, ...(effort === undefined ? {} : { effort }) },
    ...(effort === undefined ? {} : { effort }),
  }
}

const withModels = (draft: TierDraft, models: string[]): TierDraft => ({ ...draft, models })

/** The entry that names `entry`'s model with `variant` (none: inherit the tier effort). */
export const withVariant = (entry: string, variant: string | undefined): string => (variant === undefined ? entryRef(entry) : `${entryRef(entry)}#${variant}`)

/**
 * Select a model (a bare `provider/model`) at the end of the order, or drop the entry
 * given. Entries are identified by their whole text, so two rows of one model with
 * different variants stay apart.
 */
export function toggle(draft: TierDraft, entry: string): TierDraft {
  return withModels(draft, draft.models.includes(entry) ? draft.models.filter((e) => e !== entry) : [...draft.models, entry])
}

/** Move an entry one place in the fallback order; the ends stay put. */
export function move(draft: TierDraft, entry: string, direction: Direction): TierDraft {
  const from = draft.models.indexOf(entry)
  const to = direction === "up" ? from - 1 : from + 1
  if (from < 0 || to < 0 || to >= draft.models.length) return draft
  const models = [...draft.models]
  models.splice(from, 1)
  models.splice(to, 0, entry)
  return withModels(draft, models)
}

/** Pin one entry to a variant, or `undefined` to let it inherit the tier effort. */
export function setVariant(draft: TierDraft, entry: string, variant: string | undefined): TierDraft {
  const index = draft.models.indexOf(entry)
  if (index < 0) return draft
  const models = [...draft.models]
  models[index] = withVariant(entry, variant)
  return withModels(draft, models)
}

export function setEffort(draft: TierDraft, effort: string | undefined): TierDraft {
  const { effort: _drop, ...rest } = draft
  return effort === undefined ? rest : { ...rest, effort }
}

export function setPurpose(draft: TierDraft, purpose: string): TierDraft {
  return { ...draft, purpose }
}

/** Back to auto: no models, no effort, the saved purpose kept for a custom tier. */
export function reset(draft: TierDraft): TierDraft {
  const { effort: _drop, ...rest } = draft
  return { ...rest, models: [], purpose: draft.initial.purpose, reset: true }
}

const sameConfig = (a: TierConfig | undefined, b: TierConfig | undefined): boolean => {
  const key = (c: TierConfig | undefined) => JSON.stringify(Object.entries(c ?? {}).sort(([x], [y]) => x.localeCompare(y)))
  return key(a) === key(b)
}

/** Whether saving would change the tier: the draft's resulting config against the untouched draft's. */
export function dirty(draft: TierDraft): boolean {
  return draft.isNew || !sameConfig(toConfig(draft), toConfig(createDraft(draft.row)))
}

/** The config to save (`undefined`: remove the entry). Goes through `applyEdit`; variants stay. */
export function toConfig(draft: TierDraft): TierConfig | undefined {
  const { row } = draft
  const start: TierConfig | undefined = draft.reset
    ? row.builtin
      ? undefined
      : { model: "auto", purpose: draft.initial.purpose }
    : row.configured
  let config = start
  const step = (edit: TierEdit) => {
    const { configured: _old, ...rest } = row
    config = applyEdit(config === undefined ? rest : { ...rest, configured: config }, edit)
  }
  // An absent model setting stays absent (a legacy roles-backed tier keeps its candidates) until Models or Reset changes it.
  const { models, initial } = draft
  const touched = draft.isNew || draft.reset || models.length !== initial.models.length || models.some((e, i) => e !== initial.models[i])
  if (touched) step({ kind: "models", models })
  step({ kind: "effort", effort: draft.effort })
  const purpose = draft.purpose.trim()
  if (purpose !== "" && purpose !== draft.initial.purpose) step({ kind: "purpose", purpose })
  return config
}

/** The draft as the `state` RPC's `draft` argument, to preview what it would resolve to. */
export const toPreviewDraft = (draft: TierDraft): Record<string, TierConfig | null> => ({ [draft.row.name]: toConfig(draft) ?? null })

export type TierMenuValue = "models" | "effort" | "purpose" | "preview" | "reset" | "save" | "cancel"

const modelsSummary = (draft: TierDraft): string =>
  draft.models.length === 0 ? `auto: ${draft.row.candidates.join(", ") || "none"}` : draft.models.join(", ")

/** An unset effort: the tier's own, with its level when the state knows it and the draft did not clear a saved one. */
const tierEffortText = (draft: TierDraft): string =>
  draft.row.effort !== undefined && draft.initial.effort === undefined ? `Tier default (${draft.row.effort})` : "Tier default"

/** The tier menu: Models, Effort, Purpose, Preview, Reset, Save, Cancel. */
export function tierMenuOptions(draft: TierDraft, preview: string | undefined): DialogSelectOption<TierMenuValue>[] {
  return [
    { title: "Models", value: "models", description: modelsSummary(draft) },
    { title: "Effort", value: "effort", description: draft.effort ?? tierEffortText(draft) },
    { title: "Purpose", value: "purpose", description: draft.purpose },
    { title: `Preview: ${preview ?? "…"}`, value: "preview", description: "What this tier resolves to with the draft" },
    { title: "Reset to auto", value: "reset", description: draft.row.builtin ? "Remove this tier's settings" : "Keep only the purpose" },
    { title: dirty(draft) ? "Save *" : "Save", value: "save", description: "Write the tier and apply it" },
    { title: "Cancel", value: "cancel", description: dirty(draft) ? "Discard the changes" : "Back to the tier list" },
  ]
}

const MARK: Record<string, string> = {
  unhealthy: "unhealthy",
  "unknown-id": "unknown model",
  "unknown-variant": "unknown variant",
  "provider-unavailable": "not available now",
}

/** Selected models first in fallback order, numbered; then the rest. A selected entry the host does not list stays visible. */
export function modelOptions(draft: TierDraft, available: ReadonlyArray<PickModel>): DialogSelectOption<string>[] {
  const health = new Map((draft.row.health ?? []).map((h) => [h.entry, h.status]))
  const listed = new Set(available.map((m) => m.ref))
  const selected = draft.models.map((entry, i): DialogSelectOption<string> => {
    const ref = entryRef(entry)
    const variant = entryVariant(entry)
    const mark = MARK[health.get(entry) ?? ""]
    return {
      title: `☑ ${i + 1}. ${entry}`,
      value: entry,
      description: [variant === undefined ? "inherits tier effort" : `variant ${variant}`, mark].filter(Boolean).join(", "),
      ...(!listed.has(ref) && !entry.startsWith("@") ? { footer: "not listed now" } : {}),
    }
  })
  const chosen = new Set(draft.models.map(entryRef))
  const rest = available
    .filter((m) => !chosen.has(m.ref))
    .map(
      (m): DialogSelectOption<string> => ({
        title: `☐ ${m.ref}`,
        value: m.ref,
        ...(m.variants.length > 0 ? { description: `variants: ${m.variants.join(", ")}` } : {}),
      }),
    )
  return [...selected, ...rest]
}

export const INHERIT = "\u0000inherit"

/** The variant submenu for one model. */
export function variantOptions(model: PickModel | undefined): DialogSelectOption<string>[] {
  return [
    { title: "Inherit tier effort (→ nearest variant)", value: INHERIT },
    ...(model?.variants ?? []).map((v) => ({ title: v, value: v })),
  ]
}

/** Short rows: a DialogSelect row has room for an id and a few words, so the model and description live in the details menu. */
export function agentOptions(agents: ReadonlyArray<AgentRow>): DialogSelectOption<string>[] {
  return agents.map((a) => ({
    title: a.id,
    value: a.id,
    description: `${a.tier ?? "no tier"}${a.pinned !== undefined ? " · own model" : ""}`,
  }))
}

const SOURCE_TEXT: Record<AgentTierSource, string> = {
  options: "your setting",
  header: "agent default",
  implicit: "auto-classified",
}

/** Where an agent's tier comes from, in words. */
export function sourceText(source: AgentTierSource | undefined): string {
  return source === undefined ? "none" : SOURCE_TEXT[source]
}

/** Break `text` into lines of at most `width` characters, at spaces where it can. */
export function wrap(text: string, width = 52): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let rest = word; rest !== ""; ) {
      const room = line === "" ? width : width - line.length - 1
      if (rest.length <= room) {
        line = line === "" ? rest : `${line} ${rest}`
        rest = ""
      } else if (line !== "") {
        lines.push(line)
        line = ""
      } else {
        lines.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
    }
  }
  if (line !== "") lines.push(line)
  return lines
}

export const CHANGE_TIER = "\u0000change"
export const BACK = "\u0000back"

/** The details menu of one agent: one disabled row per fact (long text wrapped over rows), then the actions. */
export function agentDetailOptions(agent: AgentRow): DialogSelectOption<string>[] {
  const fact = (label: string, value: string): DialogSelectOption<string>[] =>
    wrap(`${label}: ${value}`).map((line, i) => ({ title: i === 0 ? line : `  ${line}`, value: "", disabled: true }))
  return [
    ...fact("Tier", agent.tier ?? "no tier (session model)"),
    ...fact("From", sourceText(agent.source)),
    ...fact("Resolves to", agent.tier === undefined ? "the session model" : (agent.resolved ?? "nothing available")),
    ...(agent.pinned === undefined ? [] : fact("Own model", `${agent.pinned} (wins over the tier)`)),
    ...(agent.description === undefined ? [] : fact("About", agent.description)),
    { title: "Change tier…", value: CHANGE_TIER },
    { title: "Back", value: BACK },
  ]
}

export const AGENT_DEFAULT = "\u0000agent-default"

/** The tier picker for one agent: the agent default first, then every tier with its summary. */
export function agentTierOptions(tiers: ReadonlyArray<TierRow>): DialogSelectOption<string>[] {
  return [
    { title: "Agent default", value: AGENT_DEFAULT, description: "Remove your setting; the agent's own tier or auto-classification applies" },
    ...tiers.map((t) => ({ title: t.name, value: t.name, description: tierSummary(t) })),
  ]
}

/** The picker row to mark: the agent's own setting, else the agent default. */
export const agentTierCurrent = (agent: AgentRow): string => (agent.source === "options" && agent.tier !== undefined ? agent.tier : AGENT_DEFAULT)
