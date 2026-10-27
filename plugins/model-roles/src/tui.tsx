import type { LocationRef } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { TiersRpc } from "./rpc.ts"
import {
  applyEdit,
  configuredModels,
  EFFORT_CHOICES,
  type PickModel,
  readState,
  remainingModels,
  type TierEdit,
  type TierRow,
  type TierState,
  tierNameError,
  tierSummary,
} from "./tiers-ui.ts"

const ADD = "\u0000add"
const DONE = "\u0000done"
const AUTO = "\u0000auto"
const DEFAULT = "\u0000default"

type Action = "models" | "effort" | "purpose" | "reset"

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

    const load = async (at: LocationRef): Promise<TierState | undefined> => {
      try {
        return readState((await rpc.state({}, { location: at })) as unknown)
      } catch (error) {
        toast(`Tiers: ${(error as Error).message}`, "error")
        return undefined
      }
    }

    /** Pick models in fallback order until Done; Auto resets the list. */
    const pickModels = async (row: TierRow, models: ReadonlyArray<PickModel>): Promise<string[] | "auto" | undefined> => {
      const picked: string[] = []
      for (;;) {
        const remaining = remainingModels(models, picked)
        const value = await dialog.select<string>({
          title: picked.length === 0 ? `${row.name}: first model` : `${row.name}: model ${picked.length + 1} (fallback order)`,
          placeholder: "Search models",
          options: [
            ...(picked.length > 0 ? [{ title: `Done (${picked.join(", ")})`, value: DONE }] : []),
            { title: "Auto: derive from the catalog", value: AUTO, description: "Drop the list" },
            ...remaining.map((m) => ({
              title: m.ref,
              value: m.ref,
              ...(m.variants.length > 0 ? { description: m.variants.join(", ") } : {}),
              category: m.ref.split("/")[0] ?? "",
            })),
          ],
        })
        if (value === undefined) return undefined
        if (value === DONE) return picked
        if (value === AUTO) return "auto"
        picked.push(value)
      }
    }

    const pickEffort = async (row: TierRow): Promise<{ effort: string | undefined } | undefined> => {
      const value = await dialog.select<string>({
        title: `${row.name}: effort`,
        options: [
          { title: "Tier default", value: DEFAULT, description: "Remove the setting" },
          ...EFFORT_CHOICES.map((effort) => ({
            title: effort,
            value: effort,
            ...(effort === "auto" ? { description: "The auto decider picks per spawn; else the model default" } : {}),
          })),
        ],
        ...(row.configured?.effort !== undefined ? { current: row.configured.effort } : {}),
      })
      if (value === undefined) return undefined
      return { effort: value === DEFAULT ? undefined : value }
    }

    const save = async (at: LocationRef, row: TierRow, edit: TierEdit) => {
      const value = applyEdit(row, edit)
      try {
        const result = (await rpc.set({ tier: row.name, value: value ?? null }, { location: at })) as { path?: string }
        toast(`Tier ${row.name} saved to ${result.path ?? "the global config"}; it applies once the config reloads.`, "success")
      } catch (error) {
        toast(`Tier ${row.name} not saved: ${(error as Error).message}`, "error")
      }
    }

    const editTier = async (at: LocationRef, state: TierState, row: TierRow) => {
      const action = await dialog.select<Action>({
        title: `Tier ${row.name}`,
        placeholder: tierSummary(row),
        options: [
          {
            title: "Models",
            value: "models",
            description: configuredModels(row).join(", ") || `auto: ${row.candidates.join(", ") || "none"}`,
          },
          { title: "Effort", value: "effort", description: row.effort ?? "model default" },
          { title: "Purpose", value: "purpose", description: row.purpose },
          { title: "Reset to auto", value: "reset", description: row.builtin ? "Remove this tier's settings" : "Keep only the purpose" },
        ],
      })
      if (action === undefined) return
      if (action === "models") {
        const models = await pickModels(row, state.models)
        if (models !== undefined) await save(at, row, { kind: "models", models })
      } else if (action === "effort") {
        const effort = await pickEffort(row)
        if (effort !== undefined) await save(at, row, { kind: "effort", effort: effort.effort })
      } else if (action === "purpose") {
        const purpose = await dialog.prompt({ title: `${row.name}: purpose`, description: "When should the spawner pick this tier?", value: row.purpose })
        if (purpose !== undefined && purpose.trim() !== "") await save(at, row, { kind: "purpose", purpose })
      } else await save(at, row, { kind: "reset" })
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
      const row: TierRow = { name, builtin: false, source: "standard", purpose, distinctVendor: false, cost: "", candidates: [] }
      const models = await pickModels(row, state.models)
      if (models === undefined) return
      const effort = await pickEffort(row)
      const value = applyEdit(
        { ...row, configured: { purpose, ...(effort?.effort === undefined ? {} : { effort: effort.effort }) } },
        { kind: "models", models },
      )
      try {
        const result = (await rpc.set({ tier: name, value: value ?? null }, { location: at })) as { path?: string }
        toast(`Tier ${name} added to ${result.path ?? "the global config"}.`, "success")
      } catch (error) {
        toast(`Tier ${name} not saved: ${(error as Error).message}`, "error")
      }
    }

    const open = async () => {
      const at = location()
      const state = await load(at)
      if (state === undefined) return
      if (state.error !== undefined) {
        await dialog.alert({ title: "Tiers", message: state.error })
        return
      }
      const choice = await dialog.select<string>({
        title: "Model tiers",
        placeholder: state.config === undefined ? "Pick a tier" : `Saved to ${state.config}`,
        options: [
          ...state.tiers.map((row) => ({
            title: row.name,
            value: row.name,
            description: `${tierSummary(row)}${row.purposeMissing ? " (no purpose)" : ""}`,
            footer: row.cost,
          })),
          { title: "Add a tier…", value: ADD },
        ],
      })
      if (choice === undefined) return
      if (choice === ADD) return addTier(at, state)
      const row = state.tiers.find((t) => t.name === choice)
      if (row !== undefined) await editTier(at, state, row)
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
