import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import tui from "./tui.tsx"

type Opts = {
  title: string
  options?: ReadonlyArray<{ title: string; value: unknown }>
  current?: unknown
  actions?: ReadonlyArray<{ bind: string; onTrigger: (value?: never) => void }>
  [key: string]: unknown
}
const ESC = Symbol("esc")
type Trigger = { trigger: string; on?: unknown }
type Step = (opts: Opts) => unknown
const key = (bind: string, on?: unknown): Trigger => ({ trigger: bind, on })

const models = [
  { ref: "a/one", variants: ["low", "high"] },
  { ref: "b/two", variants: [] },
  { ref: "c/three", variants: [] },
]
const tier = (name: string, configured?: Record<string, unknown>) => ({
  name,
  builtin: true,
  source: "derived",
  purpose: `${name} things`,
  distinctVendor: false,
  cost: "",
  candidates: [],
  resolved: "a/one",
  ...(configured === undefined ? {} : { configured }),
})

function harness(script: Step[], opts: { setFails?: string } = {}) {
  const saved: Record<string, Record<string, unknown>> = {}
  const setCalls: Array<{ tier: string; value: unknown }> = []
  const stateCalls: unknown[] = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const seen: Opts[] = []
  let pending: ((value: unknown) => void) | undefined
  const queue = [...script]

  const next = async (o: Opts): Promise<unknown> => {
    seen.push(o)
    const step = queue.shift()
    if (step === undefined) throw new Error(`unscripted dialog: ${o.title}`)
    const result = step(o)
    if (typeof result === "object" && result !== null && "trigger" in result) {
      const { trigger, on } = result as Trigger
      const action = o.actions?.find((a) => a.bind === trigger)
      if (action === undefined) throw new Error(`no action ${trigger}`)
      const closed = new Promise((resolve) => {
        pending = resolve
      })
      action.onTrigger(on as never)
      return closed
    }
    return result === ESC ? undefined : result
  }
  const dialog = {
    select: (o: Opts) => next(o),
    prompt: (o: Opts) => next(o),
    confirm: (o: Opts) => next(o),
    alert: (o: Opts) => next(o),
    clear: () => pending?.(undefined),
  }
  const rpc = {
    state: async (input: { draft?: Record<string, unknown> }) => {
      stateCalls.push(input)
      const tiers = [tier("cheap", saved.cheap), tier("strong", saved.strong)].map((t) => {
        const d = input.draft?.[t.name]
        return d === undefined ? t : { ...t, resolved: d === null ? "auto/default" : `draft:${JSON.stringify(d)}` }
      })
      return { tiers, models, agents: [{ id: "build", tier: "strong", source: "agent", resolved: "a/one#high" }], config: "/cfg" }
    },
    set: async (input: { tier: string; value: Record<string, unknown> | null }) => {
      if (opts.setFails !== undefined) throw new Error(opts.setFails)
      setCalls.push(input)
      if (input.value === null) delete saved[input.tier]
      else saved[input.tier] = input.value
      return { path: "/cfg", warnings: [] }
    },
  }
  let command: (() => void) | undefined
  const context = {
    location: { directory: "/repo" },
    client: { rpc: () => rpc },
    data: { session: { get: () => undefined }, location: { default: () => ({ directory: "/repo" }) } },
    ui: {
      dialog,
      router: { current: () => ({ type: "home" }) },
      toast: { show: (t: { message: string; variant?: string }) => toasts.push(t) },
      slot: (s: { render: () => unknown }) => {
        s.render()
        return () => {}
      },
    },
    keymap: {
      layer: (factory: () => { commands: Array<{ run: () => void }> }) => {
        command = factory().commands[0]?.run
      },
    },
  } as unknown as Plugin.Context

  const run = async () => {
    await tui.setup(context)
    command?.()
    for (let i = 0; i < 200 && queue.length > 0; i++) await Bun.sleep(1)
    await Bun.sleep(5)
    expect(queue).toHaveLength(0)
  }
  return { run, saved, setCalls, stateCalls, toasts, seen }
}

const pick = (value: unknown): Step => () => value
const esc: Step = () => ESC
const titles = (o: Opts) => (o.options ?? []).map((x) => x.title)

describe("/tiers editor", () => {
  test("Esc in Models keeps the draft; Save writes once and the tier list reloads", async () => {
    const h = harness([
      pick("strong"),
      pick("models"),
      pick("b/two"), // toggle
      pick("a/one"), // toggle
      esc, // back to the tier menu, draft kept
      (o) => {
        expect(o.title).toBe("Tier strong")
        expect(o.options?.find((x) => x.value === "models")).toMatchObject({ description: "b/two, a/one" })
        return "save"
      },
      (o) => {
        expect(o.title).toBe("Model tiers") // list reloaded after the save
        return ESC
      },
    ])
    await h.run()
    expect(h.setCalls).toEqual([{ tier: "strong", value: { model: ["b/two", "a/one"] } }])
    expect(h.toasts.at(-1)?.variant).toBe("success")
    expect(h.stateCalls.length).toBeGreaterThanOrEqual(2)
  })

  test("two tiers edited in one session start fresh each time", async () => {
    const h = harness([
      pick("cheap"),
      pick("models"),
      pick("b/two"),
      esc,
      pick("save"),
      pick("strong"),
      (o) => {
        expect(o.options?.find((x) => x.value === "models")).toMatchObject({ description: "auto: none" })
        return "models"
      },
      (o) => {
        expect(titles(o)[0]).toBe("☐ a/one") // nothing carried over from cheap
        return pick("c/three")(o)
      },
      esc,
      pick("save"),
      esc,
    ])
    await h.run()
    expect(h.setCalls).toEqual([
      { tier: "cheap", value: { model: ["b/two"] } },
      { tier: "strong", value: { model: ["c/three"] } },
    ])
  })

  test("ctrl+e pins a variant, reopening on the same row; the preview asks the server with the draft", async () => {
    const h = harness([
      pick("strong"),
      pick("models"),
      pick("a/one"),
      (o) => {
        expect(o.current).toBe("a/one")
        return key("ctrl+e", "a/one")
      },
      (o) => {
        expect(o.title).toBe("a/one: variant")
        expect(titles(o)).toEqual(["Inherit tier effort (→ nearest variant)", "low", "high"])
        return "high"
      },
      (o) => {
        expect(titles(o)[0]).toBe("☑ 1. a/one#high")
        expect(o.current).toBe("a/one")
        return ESC
      },
      (o) => {
        expect(o.options?.find((x) => x.value === "preview")?.title).toContain('"model":["a/one#high"]')
        return "save"
      },
      esc,
    ])
    await h.run()
    expect(h.setCalls).toEqual([{ tier: "strong", value: { model: ["a/one#high"] } }])
    expect(h.stateCalls).toContainEqual({ draft: { strong: { model: ["a/one#high"] } } })
  })

  test("alt+up and alt+down reorder, ctrl+s saves from the Models screen", async () => {
    const h = harness([
      pick("strong"),
      pick("models"),
      pick("a/one"),
      pick("b/two"),
      pick("c/three"),
      () => key("alt+up", "c/three"),
      () => key("alt+up", "c/three"),
      () => key("alt+down", "a/one"),
      (o) => {
        expect(titles(o).slice(0, 3)).toEqual(["☑ 1. c/three", "☑ 2. b/two", "☑ 3. a/one"])
        return key("ctrl+s")
      },
      esc,
    ])
    await h.run()
    expect(h.setCalls).toEqual([{ tier: "strong", value: { model: ["c/three", "b/two", "a/one"] } }])
  })

  test("Cancel with changes confirms; declining keeps editing, accepting writes nothing", async () => {
    const h = harness([
      pick("strong"),
      pick("models"),
      pick("b/two"),
      esc,
      pick("cancel"),
      (o) => {
        expect(o.title).toBe("Discard changes to strong?")
        return false
      },
      (o) => {
        expect(o.options?.find((x) => x.value === "models")).toMatchObject({ description: "b/two" })
        return "cancel"
      },
      () => true,
      esc,
    ])
    await h.run()
    expect(h.setCalls).toEqual([])
  })

  test("Esc at the tier menu without changes leaves without asking", async () => {
    const h = harness([pick("strong"), esc, esc])
    await h.run()
    expect(h.setCalls).toEqual([])
  })

  test("a validation error keeps the draft at the tier menu", async () => {
    const h = harness(
      [
        pick("strong"),
        pick("models"),
        pick("b/two"),
        esc,
        pick("save"),
        (o) => {
          expect(o.options?.find((x) => x.value === "models")).toMatchObject({ description: "b/two" })
          return "cancel"
        },
        () => true,
        esc,
      ],
      { setFails: "Unknown model b/two" },
    )
    await h.run()
    expect(h.toasts.some((t) => t.variant === "error" && t.message.includes("Unknown model"))).toBe(true)
  })

  test("effort set from the tier menu is saved with the tier", async () => {
    const h = harness([pick("strong"), pick("effort"), pick("high"), pick("save"), esc])
    await h.run()
    expect(h.setCalls).toEqual([{ tier: "strong", value: { effort: "high" } }])
  })

  test("Agents shows each agent's tier and model, read-only", async () => {
    const h = harness([
      pick("\u0000agents"),
      (o) => {
        expect(o.options?.[0]).toMatchObject({ title: "build", description: "strong → a/one#high" })
        return ESC
      },
      esc,
    ])
    await h.run()
    expect(h.setCalls).toEqual([])
  })

  test("Add a tier asks name and purpose, then the same tier menu", async () => {
    const h = harness([pick("\u0000add"), () => "docs", () => "writing docs", pick("models"), pick("b/two"), esc, pick("save"), esc])
    await h.run()
    expect(h.setCalls).toEqual([{ tier: "docs", value: { model: ["b/two"], purpose: "writing docs" } }])
  })
})
