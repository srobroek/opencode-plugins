import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { type CliRenderer, InputRenderable, type KeyEvent, type Renderable, RGBA, SyntaxStyle, TextareaRenderable } from "@opentui/core"
import { createTestRenderer, type MockInput } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { createMemo, createRoot, createSignal, getOwner, onCleanup, Show } from "solid-js"
import { BASE_MODE, INPUT_MODE } from "./focus.ts"
import { createRoundStore, InlineCard, RoundPanel } from "./panel.tsx"
import type { RoundView } from "./rounds.ts"

type Command = { readonly bind?: string | false; readonly enabled?: boolean | (() => boolean); readonly run: (input?: string, event?: KeyEvent) => unknown }
type Layer = {
  readonly mode?: string
  readonly enabled?: boolean | (() => boolean)
  readonly target?: () => Renderable | null | undefined
  readonly priority?: number
  readonly commands?: readonly Command[]
}

const on = (value: boolean | (() => boolean) | undefined) => (typeof value === "function" ? value() : value ?? true)
const keyName = (event: KeyEvent) => [event.ctrl && "ctrl", event.meta && "alt", event.shift && "shift", event.name].filter(Boolean).join("+")
const within = (node: Renderable | null, root: Renderable | null | undefined) => {
  for (let current = node; current; current = current.parent) if (current === root) return true
  return false
}

/**
 * OpenCode v2.2.6's keymap, reduced to what parley relies on: the newest pushed mode owns input
 * (context/keymap.tsx:465, a Solid memo over a signal stack that a push updates synchronously), a layer
 * runs only in its mode and under its target, higher priority first, and a handled key stops there and
 * never reaches the focused renderable (@opentui/keymap dispatchFromRootAtIndex).
 */
function hostKeymap(renderer: CliRenderer) {
  return createRoot((dispose) => {
    const [stack, setStack] = createSignal<readonly { readonly id: symbol; readonly mode: string }[]>([])
    const current = createMemo(() => stack().at(-1)?.mode ?? BASE_MODE)
    const layers = new Set<() => Layer>()
    let leases = 0
    const push = (mode: string) => {
      if (mode === INPUT_MODE) leases++
      const id = Symbol(mode)
      setStack((items) => [...items, { id, mode }])
      return () => setStack((items) => items.filter((item) => item.id !== id))
    }
    const listener = (event: KeyEvent) => {
      const focused = renderer.currentFocusedRenderable
      const active = [...layers]
        .map((factory) => factory())
        .filter((layer) => (layer.mode ?? BASE_MODE) === current() && on(layer.enabled) && (!layer.target || within(focused, layer.target())))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      for (const layer of active)
        for (const command of layer.commands ?? [])
          if (command.bind === keyName(event) && on(command.enabled)) {
            command.run(undefined, event)
            event.preventDefault()
            event.stopPropagation()
            return
          }
    }
    renderer.keyInput.prependListener("keypress", listener)
    const layer = (factory: () => Layer) => {
      layers.add(factory)
      if (getOwner()) onCleanup(() => layers.delete(factory))
      return () => layers.delete(factory)
    }
    return {
      keymap: { layer, mode: { current, push } },
      /** How many parley input-mode leases are held now. */
      held: () => stack().filter((item) => item.mode === INPUT_MODE).length,
      /** How many times parley pushed its input mode. */
      leases: () => leases,
      current,
      dispose: () => { renderer.keyInput.off("keypress", listener); dispose() },
    }
  })
}

type Host = ReturnType<typeof hostKeymap>

/**
 * Another plugin's `context.ui.dialog.select` with a search box, as v2.2.6 shows it: it blurs the focused
 * renderable and pushes the `modal` mode (ui/dialog.tsx:320-324, 400-404), focuses its search input 1 ms
 * later (ui/dialog-select.tsx:678-685), and closes on Esc (ui/dialog.tsx:345-362). On close the prompt
 * takes focus back while no dialog is open (component/prompt/index.tsx:740-752).
 */
function openDialog(renderer: CliRenderer, host: Host, composer: Renderable) {
  const search = new InputRenderable(renderer, { id: "dialog-search", width: 20 })
  renderer.root.add(search)
  renderer.currentFocusedRenderable?.blur()
  const pop = host.keymap.mode.push("modal")
  setTimeout(() => { if (!search.isDestroyed) search.focus() }, 1)
  let open = true
  const close = () => {
    if (!open) return
    open = false
    removeLayer()
    pop()
    search.destroy()
    composer.focus()
  }
  const removeLayer = host.keymap.layer(() => ({ mode: "modal", commands: [{ bind: "escape", run: close }] }))
  return { search, close, open: () => open }
}

const colour = RGBA.fromHex("#ffffff")
const theme: unknown = new Proxy(colour, { get: (target, key) => (key in target ? Reflect.get(target, key) : theme) })

const question = { id: "q", title: "Ship it?", kind: "confirm" as const, recommended: "yes" }
const round: RoundView = { roundID: "r1", sessionID: "s1", number: 1, status: "open", questions: [question], answers: [] }

const settle = () => Bun.sleep(30)

interface Mounted {
  readonly renderer: CliRenderer
  readonly input: MockInput
  readonly host: Host
  readonly composer: TextareaRenderable
  readonly store: ReturnType<typeof createRoundStore>
  /** Parley's hide (card) or minimise (panel) calls. */
  readonly hidden: () => number
  readonly requestFocus: () => void
  readonly mount: () => void
  readonly unmount: () => void
  /** The focused renderable is parley's: the card or panel, or its open edit field. */
  readonly parleyFocused: () => boolean
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup(surface: "card" | "panel", options: { mounted?: boolean } = {}): Promise<Mounted> {
  const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 })
  const host = hostKeymap(renderer)
  const composer = new TextareaRenderable(renderer, { id: "composer", width: 40, height: 1 })
  renderer.root.add(composer)
  composer.focus()
  const store = createRoundStore()
  const [mounted, setMounted] = createSignal(options.mounted ?? true)
  const [focusRequest, setFocusRequest] = createSignal(0)
  let hidden = 0
  const context = {
    renderer,
    theme,
    keymap: host.keymap,
    ui: { toast: { show: () => {} } },
  } as unknown as Plugin.Context
  const syntax = SyntaxStyle.fromStyles({ default: { fg: colour } }, renderer.nativeScene)
  const common = {
    store,
    context,
    round: () => round,
    syntax,
    submit: async () => [],
    dismiss: async () => {},
    focusRequest,
    directory: () => "/repo",
    find: async () => [],
  }
  const panel = {
    name: "srobroek.parley.round",
    sessionID: "s1",
    width: 80,
    presentation: "fullscreen",
    focused: true,
    focus: () => {},
    close: () => { hidden++ },
    toggleFullscreen: () => {},
  } as unknown as PanelInput
  await render(
    () => (
      <box id="parley-host">
        <Show when={mounted()}>
          {surface === "card"
            ? <InlineCard {...common} hide={() => { hidden++ }} expand={() => {}} />
            : <RoundPanel {...common} panel={panel} inline={() => {}} />}
        </Show>
      </box>
    ),
    renderer,
  )
  await settle()
  cleanups.push(async () => {
    setMounted(false)
    await settle()
    host.dispose()
    renderer.destroy()
  })
  const parleyRoot = () => renderer.root.getRenderable("parley-host")
  return {
    renderer,
    input: mockInput,
    host,
    composer,
    store,
    hidden: () => hidden,
    requestFocus: () => setFocusRequest((value) => value + 1),
    mount: () => setMounted(true),
    unmount: () => setMounted(false),
    parleyFocused: () => within(renderer.currentFocusedRenderable, parleyRoot()),
  }
}

describe.each(["card", "panel"] as const)("another plugin's select dialog over the %s", (surface) => {
  test("a focus request re-pushes the lease once and later mode changes do not rerun it", async () => {
    const ui = await setup(surface)
    expect(ui.host.leases()).toBe(1)
    ui.requestFocus()
    await settle()
    expect(ui.host.leases()).toBe(2)
    const dialog = openDialog(ui.renderer, ui.host, ui.composer)
    await settle()
    dialog.close()
    await settle()
    expect(ui.host.leases()).toBe(2)
    expect(ui.host.held()).toBe(1)
    expect(ui.parleyFocused()).toBe(true)
  })
})
