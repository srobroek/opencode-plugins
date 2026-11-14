import type { LocationRef } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { TiersRpc } from "./rpc.ts"
import {
  AGENT_DEFAULT,
  agentDetailOptions,
  agentOptions,
  agentTierCurrent,
  agentTierOptions,
  CHANGE_TIER,
  createDraft,
  dirty,
  entryRef,
  entryVariant,
  INHERIT,
  modelOptions,
  move,
  reset,
  setEffort,
  setPurpose,
  setVariant,
  type TierDraft,
  type TierMenuValue,
  tierMenuOptions,
  toConfig,
  toggle,
  toPreviewDraft,
  variantOptions,
  withVariant,
} from "./tiers-draft.ts"
import { type AgentRow, EFFORT_CHOICES, readState, type TierRow, type TierState, tierNameError, tierSummary } from "./tiers-ui.ts"

const ADD = "\u0000add"
const AGENTS = "\u0000agents"
const DEFAULT = "\u0000default"

/** What a key action in the Models screen asked for before it closed the dialog. */
type Intent = { kind: "variant" | "up" | "down" | "save"; ref: string }

export default Plugin.define({
  id: "srobroek.model-roles",
  setup(context) {
    const rpc = context.client.rpc(TiersRpc)
    const dialog = context.ui.dialog

    const location = (): LocationRef => {
      const route = context.ui.router.current()
      const session = route.type === "session" ? context.data.session.get(route.sessionID) : undefined
      return session?.location ?? context.location ?? context.data.location.default()
    }

    const toast = (message: string, variant: "info" | "success" | "error" = "info") => context.ui.toast.show({ message, variant })

    const load = async (at: LocationRef, draft?: Record<string, unknown>): Promise<TierState | undefined> => {
      try {
        return readState((await rpc.state(draft === undefined ? {} : { draft }, { location: at })) as unknown)
      } catch (error) {
        toast(`Tiers: ${(error as Error).message}`, "error")
        return undefined
      }
    }

    /** What the tier resolves to with the draft laid over the saved config. */
    const previewOf = async (at: LocationRef, draft: TierDraft): Promise<string | undefined> => {
      if (!dirty(draft)) return draft.row.resolved ?? "nothing available"
      const state = await load(at, toPreviewDraft(draft))
      return state?.tiers.find((t) => t.name === draft.row.name)?.resolved ?? "nothing available"
    }

    const pickEffort = async (draft: TierDraft): Promise<TierDraft> => {
      const value = await dialog.select<string>({
        title: `${draft.row.name}: effort`,
        options: [
          { title: "Tier default", value: DEFAULT, description: "Remove the setting" },
          ...EFFORT_CHOICES.map((effort) => ({
            title: effort,
            value: effort,
            ...(effort === "auto" ? { description: "The auto decider picks per spawn; else the tier's default effort" } : {}),
          })),
        ],
        current: draft.effort ?? DEFAULT,
      })
      if (value === undefined) return draft
      return setEffort(draft, value === DEFAULT ? undefined : value)
    }

    /** Pin or release the variant of one entry; returns the draft and the entry's new text. */
    const pickVariant = async (draft: TierDraft, state: TierState, entry: string): Promise<{ draft: TierDraft; entry: string }> => {
      const ref = entryRef(entry)
      const value = await dialog.select<string>({
        title: `${ref}: variant`,
        options: variantOptions(state.models.find((m) => m.ref === ref)),
        current: entryVariant(entry) ?? INHERIT,
      })
      if (value === undefined) return { draft, entry }
      const variant = value === INHERIT ? undefined : value
      return { draft: setVariant(draft, entry, variant), entry: withVariant(entry, variant) }
    }

    /**
     * One select over every model; Enter toggles, keys act on the highlighted row. An action
     * records its intent and closes the select, and the loop opens it again.
     */
    const editModels = async (start: TierDraft, state: TierState): Promise<{ draft: TierDraft; save: boolean }> => {
      let draft = start
      let current: string | undefined
      for (;;) {
        let intent: Intent | undefined
        const act = (kind: Intent["kind"]) => (ref: string) => {
          intent = { kind, ref }
          dialog.clear()
        }
        const value = await dialog.select<string>({
          title: `${draft.row.name}: models (fallback order)`,
          placeholder: `Enter toggles. ${draft.row.cost || "Search models"}`,
          options: modelOptions(draft, state.models),
          ...(current === undefined ? {} : { current }),
          actions: [
            { bind: "ctrl+e", title: "variant", onTrigger: act("variant") },
            { bind: "alt+up", title: "up", onTrigger: act("up") },
            { bind: "alt+down", title: "down", onTrigger: act("down") },
            { bind: "ctrl+s", title: "save", selection: "none", onTrigger: () => act("save")("") },
          ],
        })
        const asked = intent as Intent | undefined
        if (asked !== undefined) {
          if (asked.kind === "save") return { draft, save: true }
          current = asked.ref
          if (!draft.models.includes(asked.ref)) {
            toast("Select the model first (Enter).")
            continue
          }
          if (asked.kind === "variant") {
            const picked = await pickVariant(draft, state, asked.ref)
            draft = picked.draft
            current = picked.entry
          } else draft = move(draft, asked.ref, asked.kind)
          continue
        }
        if (value === undefined) return { draft, save: false }
        draft = toggle(draft, value)
        current = value
      }
    }

    /** The toast after a save: where it went, and any model that is not available now. */
    const saved = (result: { path?: string; warnings?: unknown }, what: string, shadowed?: string) => {
      const warnings = Array.isArray(result.warnings) ? result.warnings.filter((w): w is string => typeof w === "string") : []
      const note = [...(shadowed === undefined ? [] : [shadowed]), ...warnings].join(" ")
      toast(`${what} ${result.path ?? "the global config"}.${note === "" ? "" : ` ${note}`}`, note === "" ? "success" : "info")
    }

    const save = async (at: LocationRef, state: TierState, draft: TierDraft): Promise<boolean> => {
      const name = draft.row.name
      if (state.agentConfig?.origin === "project") {
        const go = await dialog.confirm({
          title: "A project config sets the tiers",
          message: `${state.agentConfig.path ?? "A project config"} has its own model-roles entry. A save here goes to the global config and will not change this project's tiers.`,
          label: { confirm: "Save to global anyway", cancel: "Cancel" },
        })
        if (go !== true) return false
      }
      try {
        const result = (await rpc.set({ tier: name, value: toConfig(draft) ?? null }, { location: at })) as { path?: string; warnings?: unknown; shadowedBy?: string }
        if (result.shadowedBy !== undefined) {
          saved(result, `Tier ${name} ${draft.isNew ? "added" : "saved"}; written to`, `${result.shadowedBy} overrides it here, so nothing changed in this project.`)
          return true
        }
        saved(result, `Tier ${name} ${draft.isNew ? "added" : "saved"} and applied; written to`)
        return true
      } catch (error) {
        toast(`Tier ${name} not saved: ${(error as Error).message}`, "error")
        return false
      }
    }

    const discard = async (draft: TierDraft): Promise<boolean> =>
      !dirty(draft) ||
      (await dialog.confirm({
        title: `Discard changes to ${draft.row.name}?`,
        message: "The models, effort and purpose you changed are not saved.",
        label: { confirm: "Discard", cancel: "Keep editing" },
      })) === true

    /** The tier menu: leaves on a save or a confirmed discard; a sub-screen's Esc keeps the draft. */
    const editTier = async (at: LocationRef, state: TierState, start: TierDraft): Promise<void> => {
      let draft = start
      for (;;) {
        const action = await dialog.select<TierMenuValue>({
          title: `Tier ${draft.row.name}`,
          placeholder: tierSummary(draft.row),
          options: tierMenuOptions(draft, await previewOf(at, draft)),
        })
        if (action === undefined || action === "cancel") {
          if (await discard(draft)) return
        } else if (action === "models") {
          const edited = await editModels(draft, state)
          draft = edited.draft
          if (edited.save && (await save(at, state, draft))) return
        } else if (action === "effort") draft = await pickEffort(draft)
        else if (action === "purpose") {
          const purpose = await dialog.prompt({ title: `${draft.row.name}: purpose`, description: "When should the spawner pick this tier?", value: draft.purpose })
          if (purpose !== undefined && purpose.trim() !== "") draft = setPurpose(draft, purpose)
        } else if (action === "reset") draft = reset(draft)
        else if (action === "save" && (await save(at, state, draft))) return
      }
    }

    const addTier = async (at: LocationRef, state: TierState) => {
      const existing = state.tiers.map((t) => t.name)
      let name: string | undefined
      for (;;) {
        name = (await dialog.prompt({ title: "New tier", description: "Lowercase name, for example docs", placeholder: "docs" }))?.trim()
        if (name === undefined || name === "") return
        const error = tierNameError(name, existing)
        if (error === undefined) break
        toast(error, "error")
      }
      const purpose = (await dialog.prompt({ title: `${name}: purpose`, description: "When should the spawner pick this tier?" }))?.trim()
      if (purpose === undefined || purpose === "") return
      const row: TierRow = { name, builtin: false, source: "standard", purpose, distinctVendor: false, cost: "", candidates: [], configured: { purpose } }
      await editTier(at, state, createDraft(row, true))
    }

    /** Pick the agent's tier and save it at once; true when the config changed. */
    const changeAgentTier = async (at: LocationRef, state: TierState, agent: AgentRow): Promise<boolean> => {
      if (state.agentConfig?.origin === "project") {
        const go = await dialog.confirm({
          title: "A project config sets the agents",
          message: `${state.agentConfig.path ?? "A project config"} has its own model-roles entry. A save here goes to the global config and will not change this project's tier for ${agent.id}.`,
          label: { confirm: "Save to global anyway", cancel: "Cancel" },
        })
        if (go !== true) return false
      }
      const value = await dialog.select<string>({
        title: `${agent.id}: tier`,
        placeholder: "Pick a tier, or the agent default",
        options: agentTierOptions(state.tiers),
        current: agentTierCurrent(agent),
      })
      if (value === undefined) return false
      try {
        const result = (await rpc.setAgent({ agent: agent.id, tier: value === AGENT_DEFAULT ? null : value }, { location: at })) as { path?: string; shadowedBy?: string }
        if (result.shadowedBy !== undefined) {
          toast(`Agent ${agent.id}: written to ${result.path ?? "the global config"}, but ${result.shadowedBy} overrides it here, so nothing changed in this project.`, "info")
          return true
        }
        toast(`Agent ${agent.id} ${value === AGENT_DEFAULT ? "uses its default tier" : `uses tier ${value}`}; applied, written to ${result.path ?? "the global config"}.`, "success")
        return true
      } catch (error) {
        toast(`Agent ${agent.id} not saved: ${(error as Error).message}`, "error")
        return false
      }
    }

    /** One agent's facts and actions; a save reloads and shows the menu again. Esc or Back returns to the list. */
    const showAgent = async (at: LocationRef, start: TierState, id: string): Promise<TierState | undefined> => {
      let state = start
      for (;;) {
        const agent = state.agents.find((a) => a.id === id)
        if (agent === undefined) return state
        const action = await dialog.select<string>({ title: `Agent ${agent.id}`, options: agentDetailOptions(agent, state.agentConfig) })
        if (action !== CHANGE_TIER) return state
        if (await changeAgentTier(at, state, agent)) {
          const fresh = await load(at)
          if (fresh === undefined) return undefined
          state = fresh
        }
      }
    }

    const showAgents = async (at: LocationRef, start: TierState) => {
      let state = start
      let current: string | undefined
      for (;;) {
        const id = await dialog.select<string>({
          title: "Agents",
          placeholder: "Enter shows an agent and changes its tier",
          options: state.agents.length === 0 ? [{ title: "No agents", value: "", disabled: true }] : agentOptions(state.agents, state.agentConfig),
          ...(current === undefined ? {} : { current }),
        })
        if (id === undefined) return
        current = id
        const next = await showAgent(at, state, id)
        if (next === undefined) return
        state = next
      }
    }

    const open = async () => {
      const at = location()
      let current: string | undefined
      for (;;) {
        const state = await load(at)
        if (state === undefined) return
        if (state.error !== undefined) {
          await dialog.alert({ title: "Tiers", message: state.error })
          return
        }
        const choice = await dialog.select<string>({
          title: "Model tiers",
          placeholder:
            state.config === undefined
              ? "Pick a tier"
              : state.agentConfig?.origin === "project"
                ? `Saved to ${state.config}; ${state.agentConfig.path ?? "the project config"} overrides the tiers here`
                : `Saved to ${state.config}`,
          options: [
            ...state.tiers.map((row) => ({
              title: row.name,
              value: row.name,
              description: `${tierSummary(row)}${row.purposeMissing ? " (no purpose)" : ""}${state.agentConfig?.origin === "project" ? " · overridden by the project config" : ""}`,
              footer: row.cost,
            })),
            { title: "Agents…", value: AGENTS, description: "See each agent's tier and change it" },
            { title: "Add a tier…", value: ADD },
          ],
          ...(current === undefined ? {} : { current }),
        })
        if (choice === undefined) return
        current = choice
        if (choice === ADD) await addTier(at, state)
        else if (choice === AGENTS) await showAgents(at, state)
        else {
          const row = state.tiers.find((t) => t.name === choice)
          if (row !== undefined) await editTier(at, state, createDraft(row))
        }
      }
    }

    const disposeCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "model-roles.tiers",
              title: "Model tiers",
              description: "Pick models, effort and purpose per model tier, or add a tier",
              group: "Model roles",
              palette: true,
              slash: { name: "tiers" },
              run: () => {
                void open()
              },
            },
          ],
        }))
        return null
      },
    })

    return async () => {
      disposeCommands()
    }
  },
})
