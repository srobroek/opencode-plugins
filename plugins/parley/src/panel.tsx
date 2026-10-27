import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import {
  type BoxRenderable,
  EditBufferRenderable,
  type Renderable,
  type ScrollBoxRenderable,
  type SyntaxStyle,
  TextAttributes,
  type TextareaRenderable,
} from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { FileValue, SubmittedAnswer } from "./answers.ts"
import { clipboardFiles, copyText } from "./clipboard.ts"
import { cardText } from "./copy-text.ts"
import { FocusGuard, INPUT_MODE } from "./focus.ts"
import { DEFAULT_EMOJIS, optionLabel, type Question, sliderBounds, sliderText } from "./questions.ts"
import type { RoundView } from "./rounds.ts"
import {
  type Arrow,
  accept,
  acceptsPath,
  applyCompletion,
  arrowAction,
  badge,
  choose,
  completionQuery,
  countdown,
  type Draft,
  editable,
  editText,
  enterIsNewline,
  initialDraft,
  keyHints,
  mimeFor,
  moveCursor,
  parsePaths,
  parseSlider,
  rankMove,
  rankPaths,
  rows,
  setFiles,
  setNote,
  setText,
  sliderBar,
  step,
  submissions,
  toggleDefer,
} from "./tui-state.ts"

export const PANEL = "srobroek.parley.round"

type Editing = { readonly id: string; readonly field: "note" | "text" } | undefined

/** Card edits that outlive the panel: minimising and reopening a round keeps them. */
export function createRoundStore() {
  const [drafts, setDrafts] = createStore<Record<string, Draft>>({})
  const [focus, setFocus] = createStore<Record<string, number>>({})
  return {
    drafts,
    focus,
    setDraft: (key: string, draft: Draft) => setDrafts(key, reconcile(draft)),
    setFocus: (roundID: string, index: number) => setFocus(roundID, index),
    forget: (roundID: string) => {
      for (const key of Object.keys(drafts)) if (key.startsWith(`${roundID}\u0000`)) setDrafts(key, undefined as never)
      setFocus(roundID, undefined as never)
    },
  }
}

export type RoundStore = ReturnType<typeof createRoundStore>

export interface PanelProps {
  readonly store: RoundStore
  readonly context: Plugin.Context
  readonly panel: PanelInput
  readonly round: () => RoundView | undefined
  readonly syntax: SyntaxStyle
  readonly submit: (round: RoundView, answers: SubmittedAnswer[]) => Promise<string[]>
  readonly dismiss: (round: RoundView) => Promise<void>
  /** The session's directory: relative paths in file cards resolve against it. */
  readonly directory: () => string | undefined
  /** Files and directories under the session directory matching a query (gitignore respected). */
  readonly find: (query: string) => Promise<string[]>
  /** Bumped by `/parley` and alt+p: take focus back. */
  readonly focusRequest: () => number
}

const resolvePath = (raw: string, base: string | undefined) => {
  const home = process.env.HOME ?? ""
  if (raw === "~" || raw.startsWith("~/")) return `${home}${raw.slice(1)}`
  if (raw.startsWith("/") || base === undefined) return raw
  return `${base.replace(/\/$/, "")}/${raw.replace(/^\.\//, "")}`
}

async function readFiles(text: string, base: string | undefined): Promise<FileValue[]> {
  const files: FileValue[] = []
  for (const raw of parsePaths(text)) {
    const path = resolvePath(raw, base)
    const file = Bun.file(path)
    if (!(await file.exists())) throw new Error(`No such file: ${raw}`)
    const data = Buffer.from(await file.arrayBuffer()).toString("base64")
    files.push({ name: path.split("/").pop() ?? path, path: raw, mime: (file.type || mimeFor(path)).split(";")[0] ?? mimeFor(path), size: file.size, data })
  }
  return files
}

/** Draft, edit and submit state of one round, shared by the full panel and the inline card. */
function createRoundControls(
  props: Pick<PanelProps, "store" | "round" | "submit" | "directory" | "find" | "context">,
  onMove?: (id: string) => void,
) {
  const roundID = () => props.round()?.roundID ?? ""
  const key = (id: string) => `${roundID()}\u0000${id}`
  const draftOf = (id: string): Draft | undefined => props.store.drafts[key(id)]
  const setDraft = (id: string, draft: Draft) => props.store.setDraft(key(id), draft)
  const focus = () => props.store.focus[roundID()] ?? 0
  const setFocus = (index: number) => props.store.setFocus(roundID(), index)
  const [editing, setEditing] = createSignal<Editing>()
  const [errors, setErrors] = createSignal<string[]>([])
  const [busy, setBusy] = createSignal(false)
  const [suggestions, setSuggestions] = createSignal<string[]>([])
  const [selected, setSelected] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  let textarea: TextareaRenderable | undefined
  let lookup = 0
  let disposed = false
  const clipboardAbort = new AbortController()
  onCleanup(() => {
    disposed = true
    clipboardAbort.abort()
    ++lookup
  })

  // Ticks while the round has a deadline, for the "closes in" countdown.
  createEffect(() => {
    if (props.round()?.deadline === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const remaining = () => {
    const deadline = props.round()?.deadline
    return deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - now()) / 1000))
  }

  const questions = createMemo(() => props.round()?.questions ?? [])
  const current = () => questions()[focus()]

  // New questions can join an open round; keep existing edits and add drafts for the rest.
  createEffect(() => {
    for (const question of questions()) if (!draftOf(question.id)) setDraft(question.id, initialDraft(question))
  })

  const update = (fn: (question: Question, draft: Draft) => Draft) => {
    const question = current()
    if (!question) return
    const draft = draftOf(question.id) ?? initialDraft(question)
    setDraft(question.id, fn(question, draft))
  }

  const moveCard = (delta: number) => {
    const count = questions().length
    if (count === 0) return
    const next = (focus() + delta + count) % count
    setFocus(next)
    const id = questions()[next]?.id
    if (id) onMove?.(id)
  }

  /** Applies an arrow key to the focused card; question moves go to `toQuestion` (none on the inline card). */
  const arrow = (key: Arrow, toQuestion?: (delta: number) => void) => {
    const question = current()
    const action = question ? arrowAction(question, key) : undefined
    if (!action) return
    if (action.kind === "question") toQuestion?.(action.delta)
    else if (action.kind === "cursor") update((q, d) => moveCursor(q, d, action.delta))
    else update((q, d) => step(q, d, action.delta))
  }

  /** Whether enter in the open text field saves it (not for code, where it starts a new line). */
  const enterSaves = () => {
    const edit = editing()
    const question = questions().find((candidate) => candidate.id === edit?.id)
    return edit !== undefined && question !== undefined && !enterIsNewline(question, edit.field)
  }

  const startEdit = (field: "note" | "text") => {
    const question = current()
    if (!question) return
    if (field === "text" && !editable(question)) return
    setSuggestions([])
    setEditing({ id: question.id, field })
  }

  const fileCard = () => {
    const edit = editing()
    const question = questions().find((candidate) => candidate.id === edit?.id)
    return edit?.field === "text" && (question?.kind === "ask_image" || question?.kind === "ask_file") ? question : undefined
  }

  /** Keeps the suggestion list in step with the path being typed. */
  const onInput = (text: string) => {
    const question = fileCard()
    if (!question) return
    const { query } = completionQuery(text)
    const ticket = ++lookup
    if (query === "") {
      setSuggestions([])
      return
    }
    void props
      .find(query)
      .catch(() => [] as string[])
      .then((found) => {
        if (disposed || ticket !== lookup) return
        setSuggestions(rankPaths(query, found.filter((candidate) => acceptsPath(question, candidate))))
        setSelected(0)
      })
  }

  const moveSuggestion = (delta: number) => {
    const count = suggestions().length
    if (count === 0) return false
    setSelected((index) => (index + delta + count) % count)
  }

  /** Tab in a path field: put the highlighted suggestion in place of the path being typed. */
  const complete = () => {
    const choice = suggestions()[selected()]
    if (!fileCard() || !textarea || textarea.isDestroyed || choice === undefined) return false
    textarea.setText(applyCompletion(textarea.plainText, choice))
    textarea.gotoBufferEnd()
    if (choice.endsWith("/")) onInput(textarea.plainText)
    else setSuggestions([])
  }

  /** ctrl+v on a file card: attach a screenshot or copied files from the system clipboard. */
  const pasteFiles = () => {
    const question = fileCard() ?? current()
    if (!question || (question.kind !== "ask_image" && question.kind !== "ask_file")) return false
    void attach(question)
  }
  const isFileKind = (question: Question | undefined) => question?.kind === "ask_image" || question?.kind === "ask_file"

  // Bound only where they apply: a binding that declines a key hands it to the host's own (↓ opens
  // the subagent view, tab switches agents), which is how keys used to leak out of a card.
  const pasteKeys = () =>
    isFileKind(current()) ? [{ bind: "ctrl+v", title: "Paste file", group: "Parley", run: pasteFiles }] : []
  const copy = async () => {
    const question = current()
    if (!question || editing()) return
    const text = cardText(question, draftOf(question.id) ?? initialDraft(question))
    const copied = await copyText(text, props.context.renderer, clipboardAbort.signal)
    if (disposed) return
    props.context.ui.toast.show({ message: copied ? "Card copied" : "Clipboard unavailable (OSC 52, pbcopy, wl-copy or xclip required)", variant: copied ? "success" : "warning" })
  }
  const pathKeys = () => [
    ...(fileCard() ? [{ bind: "ctrl+v", title: "Paste file", group: "Parley", run: pasteFiles }] : []),
    ...(suggestions().length > 0 ? [{ bind: "tab", title: "Complete path", group: "Parley", run: complete }] : []),
    // Always bound in a field: unclaimed, ↑/↓ reach the host's global bindings (↓ opens the subagent view).
    { bind: "down", title: "Next suggestion / line", group: "Parley", run: () => fieldArrow(1) },
    { bind: "up", title: "Previous suggestion / line", group: "Parley", run: () => fieldArrow(-1) },
  ]

  const fieldArrow = (delta: number) => {
    if (suggestions().length > 0) {
      moveSuggestion(delta)
      return
    }
    if (!textarea || textarea.isDestroyed) return
    if (delta > 0) textarea.moveCursorDown()
    else textarea.moveCursorUp()
  }

  const attach = async (question: Question) => {
    const files = await clipboardFiles(question.kind === "ask_image")
    if (disposed) return
    if (files.length === 0) {
      setErrors(["Nothing to attach on the clipboard (copy a screenshot or a file first)."])
      return
    }
    const draft = draftOf(question.id) ?? initialDraft(question)
    setDraft(question.id, setFiles(question, draft, files, "pasted"))
    setErrors([])
  }

  const finishEdit = async () => {
    const edit = editing()
    const question = questions().find((candidate) => candidate.id === edit?.id)
    const text = textarea?.plainText ?? ""
    setEditing(undefined)
    setSuggestions([])
    if (!edit || !question) return
    const draft = draftOf(question.id) ?? initialDraft(question)
    if (edit.field === "note") {
      setDraft(question.id, setNote(draft, text))
      return
    }
    if (question.kind === "ask_image" || question.kind === "ask_file") {
      try {
        const files = text.trim() === "" ? [] : await readFiles(text, props.directory())
        if (disposed) return
        setDraft(question.id, setFiles(question, draft, files, "typed"))
        setErrors([])
      } catch (error) {
        setErrors([error instanceof Error ? error.message : String(error)])
      }
      return
    }
    if (question.kind === "slider") {
      const parsed = parseSlider(question, text)
      if (parsed !== undefined && "error" in parsed) {
        setErrors([parsed.error])
        return
      }
    }
    setErrors([])
    setDraft(question.id, setText(question, draft, text))
  }

  const submit = async () => {
    const round = props.round()
    if (!round || busy()) return
    if (editing()) await finishEdit()
    setBusy(true)
    try {
      const problems = await props.submit(round, submissions(questions(), Object.fromEntries(questions().map((q) => [q.id, draftOf(q.id) ?? initialDraft(q)]))))
      if (disposed) return
      setErrors(problems)
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  return {
    draftOf,
    focus,
    editing,
    errors,
    busy,
    questions,
    current,
    update,
    moveCard,
    arrow,
    enterSaves,
    startEdit,
    finishEdit,
    submit,
    suggestions,
    selected,
    remaining,
    onInput,
    moveSuggestion,
    complete,
    pasteFiles,
    pasteKeys,
    copy,
    pathKeys,
    /** The open text field, if any, so a focus request lands in it rather than on the card. */
    field: () => (editing() && textarea && !textarea.isDestroyed ? textarea : undefined),
    /** shift+enter: the edit layer's `return` would otherwise take it too. */
    newline: () => {
      if (textarea && !textarea.isDestroyed) textarea.newLine()
    },
    setTextarea: (element: TextareaRenderable) => {
      textarea = element
    },
  }
}

export interface RoundPanelProps extends PanelProps {
  /** Shows a one-question round as the inline card again. */
  readonly inline: () => void
}

export function RoundPanel(props: RoundPanelProps) {
  const theme = () => props.context.theme
  let box: BoxRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  const controls = createRoundControls(props, (id) => scroll?.scrollChildIntoView(`parley-card-${id}`))
  const {
    draftOf,
    focus,
    editing,
    errors,
    busy,
    questions,
    current,
    update,
    moveCard,
    arrow,
    enterSaves,
    startEdit,
    finishEdit,
    submit,
    newline,
    setTextarea,
  } = controls
  const single = () => questions().length === 1
  const ownership = exclusiveFocus(props.context, () => box, controls.field, () => props.panel.focus())
  // A side panel must keep the host's input scope, not just look selected after a prompt click.
  createEffect(() => { if (!ownership.paused() && !props.panel.focused) props.panel.focus() })
  createEffect(() => {
    if (props.focusRequest() > 0) ownership.reclaim()
  })
  /** f: a one-question round goes back to the inline card; a larger one toggles full screen and the side panel. */
  const toggleView = () => {
    if (single()) props.inline()
    else props.panel.toggleFullscreen()
  }

  props.context.keymap.layer(() => ({
    mode: INPUT_MODE,
    priority: 100,
    enabled: () => editing() === undefined,
    commands: [
      { bind: "tab", title: "Next question", group: "Parley", run: () => moveCard(1) },
      { bind: "shift+tab", title: "Previous question", group: "Parley", run: () => moveCard(-1) },
      { bind: "j", title: "Next question", group: "Parley", run: () => moveCard(1) },
      { bind: "k", title: "Previous question", group: "Parley", run: () => moveCard(-1) },
      { bind: "down", title: "Next choice", group: "Parley", run: () => arrow("down", moveCard) },
      { bind: "up", title: "Previous choice", group: "Parley", run: () => arrow("up", moveCard) },
      { bind: "left", title: "Previous / decrease", group: "Parley", run: () => arrow("left", moveCard) },
      { bind: "right", title: "Next / increase", group: "Parley", run: () => arrow("right", moveCard) },
      { bind: "space", title: "Choose", group: "Parley", run: () => update((q, d) => choose(q, d)) },
      { bind: "return", title: "Choose", group: "Parley", run: () => update((q, d) => choose(q, d)) },
      ...Array.from({ length: 9 }, (_, index) => ({
        bind: String(index + 1),
        title: `Choose ${index + 1}`,
        group: "Parley",
        run: () => update((q, d) => choose(q, d, index)),
      })),
      { bind: "shift+up", title: "Move up", group: "Parley", run: () => update((q, d) => rankMove(q, d, -1)) },
      { bind: "shift+down", title: "Move down", group: "Parley", run: () => update((q, d) => rankMove(q, d, 1)) },
      { bind: "shift+k", title: "Move up", group: "Parley", run: () => update((q, d) => rankMove(q, d, -1)) },
      { bind: "shift+j", title: "Move down", group: "Parley", run: () => update((q, d) => rankMove(q, d, 1)) },
      { bind: "a", title: "Accept recommendation", group: "Parley", run: () => update(accept) },
      { bind: "d", title: "Defer", group: "Parley", run: () => update((q, d) => toggleDefer(d, q)) },
      { bind: "n", title: "Note", group: "Parley", run: () => startEdit("note") },
      { bind: "e", title: "Edit answer", group: "Parley", run: () => startEdit("text") },
      { bind: "ctrl+return", title: "Submit round", group: "Parley", run: () => void submit() },
      { bind: "ctrl+s", title: "Submit round", group: "Parley", run: () => void submit() },
      ...controls.pasteKeys(),
      { bind: "y", title: "Copy card text", group: "Parley", run: () => void controls.copy() },
      { bind: "f", title: "Toggle view", group: "Parley", run: toggleView },
      { bind: "escape", title: "Minimise", group: "Parley", run: () => props.panel.close() },
      {
        bind: "shift+d",
        title: "Dismiss round",
        group: "Parley",
        run: () => {
          const round = props.round()
          if (round) void ownership.suspend(() => props.dismiss(round))
        },
      },
      { bind: "pageup", title: "Scroll", group: "Parley", run: () => scroll?.scrollBy(-10) },
      { bind: "pagedown", title: "Scroll", group: "Parley", run: () => scroll?.scrollBy(10) },
    ],
  }))

  props.context.keymap.layer(() => ({
    mode: INPUT_MODE,
    priority: 100,
    enabled: () => editing() !== undefined,
    commands: [
      { bind: "escape", title: "Done editing", group: "Parley", run: () => void finishEdit() },
      { bind: "shift+return", title: "New line", group: "Parley", run: newline },
      ...controls.pathKeys(),
      {
        bind: "return",
        title: "Save",
        group: "Parley",
        run: () => {
          if (!enterSaves()) return newline()
          void finishEdit()
        },
      },
      { bind: "ctrl+return", title: "Submit round", group: "Parley", run: () => void submit() },
      { bind: "ctrl+s", title: "Submit round", group: "Parley", run: () => void submit() },
    ],
  }))

  const answered = () =>
    questions().filter((question) => {
      const draft = draftOf(question.id)
      return draft !== undefined && (draft.status !== "unset" || draft.note.trim() !== "")
    }).length

  return (
    <box ref={(element: BoxRenderable) => (box = element)} focusable flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
      <box flexDirection="row" flexShrink={0} gap={2}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          {`Parley · round ${props.round()?.number ?? "?"}`}
        </text>
        <Show when={props.round()?.title}>
          <text fg={theme().text.muted} truncate flexGrow={1}>
            {props.round()?.title}
          </text>
        </Show>
        <Show when={countdown(controls.remaining())}>
          {(text: () => string) => <text fg={theme().text.feedback.warning.base}>{text()}</text>}
        </Show>
        <text fg={theme().text.muted}>{`${answered()}/${questions().length} ready`}</text>
      </box>
      <Show when={errors().length > 0}>
        <box flexShrink={0} paddingTop={1}>
          <For each={errors()}>{(error) => <text fg={theme().text.feedback.error.base}>{error}</text>}</For>
        </box>
      </Show>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        flexGrow={1}
        paddingTop={1}
        scrollX={false}
        verticalScrollbarOptions={{ visible: true }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <For each={questions()}>
          {(question, index) => (
            <Card
              context={props.context}
              syntax={props.syntax}
              question={question}
              index={index()}
              draft={draftOf(question.id) ?? initialDraft(question)}
              focused={index() === focus()}
              editing={editing()?.id === question.id ? editing()?.field : undefined}
              suggestions={controls.suggestions()}
              selected={controls.selected()}
              onInput={controls.onInput}
              textareaRef={(element) => {
                setTextarea(element)
                queueMicrotask(() => {
                  if (element.isDestroyed) return
                  element.focus()
                  element.gotoBufferEnd()
                })
              }}
            />
          )}
        </For>
      </scrollbox>
      <box flexShrink={0} paddingTop={1} paddingBottom={1}>
        <text fg={theme().text.muted} wrapMode="word">
          {keyHints(
            current(),
            props.panel.presentation === "fullscreen" ? "panel" : "side",
            editing()
              ? { field: editing()?.field ?? "text", enterSaves: enterSaves(), suggestions: controls.suggestions().length > 0 }
              : undefined,
            single(),
          )}
        </text>
      </box>
      <Show when={busy()}>
        <text fg={theme().text.muted}>Submitting…</text>
      </Show>
    </box>
  )
}

export interface InlineCardProps extends Omit<PanelProps, "panel"> {
  /** Hides the card; `/parley` brings it back with its edits. */
  readonly hide: () => void
  /** Moves the round to the full-screen panel. */
  readonly expand: () => void
}

const within = (node: Renderable | null | undefined, root: Renderable | undefined) => {
  for (let current = node; current; current = current.parent) if (current === root) return true
  return false
}

/** When to make sure the inline card has focus after it mounts (ms). */
const SETTLE_MS = [50, 200, 500, 1000, 2000]

/** Both surfaces need native focus AND an input-mode lease: either alone lets composer keys leak. */
function exclusiveFocus(context: Plugin.Context, target: () => Renderable | undefined, field: () => Renderable | undefined, scope?: () => void) {
  const guard = new FocusGuard((mode) => context.keymap.mode.push(mode))
  const [paused, setPaused] = createSignal(false)
  let disposed = false
  const focusNow = () => {
    if (!guard.active) return
    scope?.()
    const node = field() ?? target()
    if (node && !node.isDestroyed) node.focus()
  }
  const grab = () => queueMicrotask(focusNow)
  onMount(() => {
    const renderer = context.renderer
    const previous = renderer.currentFocusedRenderable
    guard.acquire()
    grab()
    const onFocus = () => {
      const focused = renderer.currentFocusedRenderable
      const inside = within(focused, target())
      // Parley's confirmation dialog may own focus; the composer never may.
      if (!inside && focused !== null && !(focused instanceof EditBufferRenderable)) return
      if (guard.moved(inside)) { focusNow(); grab() }
    }
    const onInput = () => {
      const focused = renderer.currentFocusedRenderable
      if (guard.active && focused instanceof EditBufferRenderable && !within(focused, target())) focusNow()
      return false
    }
    renderer.prependInputHandler(onInput)
    renderer.on("focused_renderable", onFocus)
    const checks = SETTLE_MS.map((delay) => setTimeout(() => { if (guard.moved(within(renderer.currentFocusedRenderable, target()))) grab() }, delay))
    onCleanup(() => {
      disposed = true
      guard.release()
      for (const check of checks) clearTimeout(check)
      renderer.off("focused_renderable", onFocus)
      renderer.removeInputHandler(onInput)
      const now = renderer.currentFocusedRenderable
      if ((now === null || within(now, target())) && previous && !previous.isDestroyed) previous.focus()
    })
  })
  return {
    paused,
    reclaim: () => { guard.reclaim(); grab() },
    // Host confirmation dialogs own their own keyboard scope. Temporarily hand the lease to them,
    // never to the prompt, and reacquire only if this surface survived the dialog.
    suspend: async (operation: () => Promise<void>) => {
      setPaused(true)
      guard.release()
      try { await operation() } finally {
        if (!disposed) { guard.acquire(); setPaused(false); grab() }
      }
    },
  }
}

/** A one-question round as a compact card above the prompt, with the panel's keys. */
export function InlineCard(props: InlineCardProps) {
  const theme = () => props.context.theme
  const controls = createRoundControls(props)
  const {
    draftOf,
    editing,
    errors,
    busy,
    questions,
    update,
    arrow,
    enterSaves,
    startEdit,
    finishEdit,
    submit,
    newline,
    setTextarea,
  } = controls
  let box: BoxRenderable | undefined
  const question = () => questions()[0]

  const ownership = exclusiveFocus(props.context, () => box, controls.field)

  // Back to the card on /parley or alt+p.
  createEffect(() => {
    if (props.focusRequest() === 0) return
    ownership.reclaim()
  })


  // The edit textarea held focus; give it back to the card so its keys keep working.
  const done = async () => {
    await finishEdit()
    if (box && !box.isDestroyed) box.focus()
  }

  // Enter on a single choice with nothing picked yet takes the row under the cursor, like the built-in form.
  const send = async () => {
    const q = question()
    const draft = q ? draftOf(q.id) : undefined
    if (q && draft?.status === "unset" && draft.note.trim() === "" && rows(q).length > 0 && q.kind !== "pick_many")
      update((target, current) => choose(target, current))
    await submit()
  }

  const saveAndSend = async () => {
    await done()
    await send()
  }

  props.context.keymap.layer(() => ({
    mode: INPUT_MODE,
    priority: 100,
    target: () => box,
    enabled: () => editing() === undefined,
    commands: [
      { bind: "down", title: "Next choice", group: "Parley", run: () => arrow("down") },
      { bind: "up", title: "Previous choice", group: "Parley", run: () => arrow("up") },
      { bind: "left", title: "Previous / decrease", group: "Parley", run: () => arrow("left") },
      { bind: "right", title: "Next / increase", group: "Parley", run: () => arrow("right") },
      { bind: "j", title: "Next choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, 1)) },
      { bind: "k", title: "Previous choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, -1)) },
      // Claimed so they do not reach the host (shift+tab switches the agent).
      { bind: "tab", title: "Next choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, 1)) },
      { bind: "shift+tab", title: "Previous choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, -1)) },
      { bind: "shift+up", title: "Move up", group: "Parley", run: () => update((q, d) => rankMove(q, d, -1)) },
      { bind: "shift+down", title: "Move down", group: "Parley", run: () => update((q, d) => rankMove(q, d, 1)) },
      { bind: "shift+k", title: "Move up", group: "Parley", run: () => update((q, d) => rankMove(q, d, -1)) },
      { bind: "shift+j", title: "Move down", group: "Parley", run: () => update((q, d) => rankMove(q, d, 1)) },
      { bind: "space", title: "Choose", group: "Parley", run: () => update((q, d) => choose(q, d)) },
      ...Array.from({ length: 9 }, (_, index) => ({
        bind: String(index + 1),
        title: `Choose ${index + 1}`,
        group: "Parley",
        run: () => update((q, d) => choose(q, d, index)),
      })),
      { bind: "a", title: "Accept recommendation", group: "Parley", run: () => update(accept) },
      { bind: "d", title: "Defer", group: "Parley", run: () => update((q, d) => toggleDefer(d, q)) },
      { bind: "n", title: "Note", group: "Parley", run: () => startEdit("note") },
      { bind: "e", title: "Edit answer", group: "Parley", run: () => startEdit("text") },
      { bind: "return", title: "Submit", group: "Parley", run: () => void send() },
      { bind: "ctrl+return", title: "Submit", group: "Parley", run: () => void send() },
      { bind: "ctrl+s", title: "Submit", group: "Parley", run: () => void send() },
      ...controls.pasteKeys(),
      { bind: "y", title: "Copy card text", group: "Parley", run: () => void controls.copy() },
      { bind: "f", title: "Full screen", group: "Parley", run: () => props.expand() },
      { bind: "escape", title: "Hide", group: "Parley", run: () => props.hide() },
      {
        bind: "shift+d",
        title: "Dismiss",
        group: "Parley",
        run: () => {
          const round = props.round()
          if (round) void ownership.suspend(() => props.dismiss(round))
        },
      },
    ],
  }))

  props.context.keymap.layer(() => ({
    mode: INPUT_MODE,
    priority: 100,
    target: () => box,
    enabled: () => editing() !== undefined,
    commands: [
      { bind: "escape", title: "Done editing", group: "Parley", run: () => void done() },
      { bind: "shift+return", title: "New line", group: "Parley", run: newline },
      ...controls.pathKeys(),
      {
        bind: "return",
        title: "Save and submit",
        group: "Parley",
        run: () => {
          if (!enterSaves()) return newline()
          void saveAndSend()
        },
      },
      { bind: "ctrl+return", title: "Submit", group: "Parley", run: () => void saveAndSend() },
      { bind: "ctrl+s", title: "Submit", group: "Parley", run: () => void saveAndSend() },
    ],
  }))

  return (
    <box
      ref={(element: BoxRenderable) => (box = element)}
      focusable
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={question()}>
        {(q: () => Question) => (
          <Card
            context={props.context}
            syntax={props.syntax}
            question={q()}
            index={0}
            draft={draftOf(q().id) ?? initialDraft(q())}
            focused
            editing={editing()?.id === q().id ? editing()?.field : undefined}
            suggestions={controls.suggestions()}
            selected={controls.selected()}
            onInput={controls.onInput}
            textareaRef={(element) => {
              setTextarea(element)
              queueMicrotask(() => {
                if (element.isDestroyed) return
                element.focus()
                element.gotoBufferEnd()
              })
            }}
          />
        )}
      </Show>
      <For each={errors()}>{(error) => <text fg={theme().text.feedback.error.base}>{error}</text>}</For>
      <text fg={theme().text.muted} wrapMode="word">
        {busy()
          ? "Submitting…"
          : `${countdown(controls.remaining()) ? `${countdown(controls.remaining())} · ` : ""}${keyHints(
              question(),
              "card",
              editing()
                ? { field: editing()?.field ?? "text", enterSaves: enterSaves(), suggestions: controls.suggestions().length > 0 }
                : undefined,
            )}`}
      </text>
    </box>
  )
}

interface CardProps {
  readonly context: Plugin.Context
  readonly syntax: SyntaxStyle
  readonly question: Question
  readonly index: number
  readonly draft: Draft
  readonly focused: boolean
  readonly editing: "note" | "text" | undefined
  readonly textareaRef: (element: TextareaRenderable) => void
  /** Path suggestions for the open file field, and the highlighted one. */
  readonly suggestions: readonly string[]
  readonly selected: number
  readonly onInput: (text: string) => void
}

function Card(props: CardProps) {
  const theme = () => props.context.theme
  const q = () => props.question
  const value = () => props.draft.value as Record<string, unknown> | undefined
  const recommended = () => {
    const rec = q().recommended
    if (rec === undefined) return undefined
    // Code is shown as a block below; preselected code would only repeat what the editor shows.
    if (q().kind === "ask_code") return undefined
    if (q().kind === "slider" && typeof rec === "number") return sliderText(q(), rec)
    if (Array.isArray(rec)) return rec.map((id) => optionLabel(q(), String(id))).join(", ")
    if (typeof rec === "object") return JSON.stringify(rec)
    if (typeof rec === "string" && (q().options?.length ?? 0) > 0) return optionLabel(q(), rec)
    return String(rec)
  }
  return (
    <box
      id={`parley-card-${q().id}`}
      border
      borderStyle={props.focused ? "heavy" : "rounded"}
      borderColor={props.focused ? theme().text.action.primary.base : theme().border.base}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      flexDirection="column"
      flexShrink={0}
    >
      <box flexDirection="row" gap={2}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexGrow={1}>
          {`Q${props.index + 1} ${q().title}`}
        </text>
        <text fg={props.draft.status === "deferred" ? theme().text.feedback.warning.base : theme().text.muted}>
          {badge(props.draft, props.question)}
        </text>
      </box>
      <Show when={(q().depends_on?.length ?? 0) > 0}>
        <text fg={theme().text.faint}>{`after: ${q().depends_on?.join(", ")}`}</text>
      </Show>
      <Show when={q().body}>
        <markdown content={q().body ?? ""} syntaxStyle={props.syntax} conceal fg={theme().markdown.text} />
      </Show>
      <Show when={recommended() !== undefined}>
        <text fg={theme().text.feedback.success.base}>{`★ Recommended: ${recommended()}`}</text>
      </Show>
      <Show when={q().kind === "ask_code" && typeof q().recommended === "string" && editText(q(), props.draft) !== q().recommended}>
        <text fg={theme().text.feedback.success.base}>★ Recommended:</text>
        <markdown content={codeBlock(String(q().recommended), q().language)} syntaxStyle={props.syntax} fg={theme().markdown.text} />
      </Show>
      <Show when={q().rationale}>
        <markdown content={`*Why:* ${q().rationale}`} syntaxStyle={props.syntax} conceal fg={theme().text.muted} />
      </Show>
      <box paddingTop={1} flexDirection="column">
        <Body {...props} value={value()} />
      </box>
      <Show when={props.editing === "note"}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.muted}>Note:</text>
          <textarea
            ref={props.textareaRef}
            initialValue={props.draft.note}
            placeholder="Add a note"
            minHeight={1}
            maxHeight={6}
            flexGrow={1}
            textColor={theme().text.base}
            focusedTextColor={theme().text.base}
          />
        </box>
      </Show>
      <Show when={props.editing !== "note" && props.draft.note.trim() !== ""}>
        <text fg={theme().text.muted} wrapMode="word">{`Note: ${props.draft.note}`}</text>
      </Show>
    </box>
  )
}

const codeBlock = (code: string, language?: string) => {
  const fence = code.includes("```") ? "~~~~" : "```"
  return `${fence}${language ?? ""}\n${code}\n${fence}`
}

function Row(props: {
  readonly context: Plugin.Context
  readonly cursor: boolean
  readonly marker: string
  readonly label: string
  readonly description?: string
  readonly recommended?: boolean
}) {
  const theme = () => props.context.theme
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.cursor ? theme().text.action.primary.base : theme().text.faint}>{props.cursor ? "›" : " "}</text>
      <text fg={theme().text.base}>{props.marker}</text>
      <text fg={props.cursor ? theme().text.base : theme().text.muted} attributes={props.cursor ? TextAttributes.BOLD : 0}>
        {props.label}
      </text>
      <Show when={props.recommended}>
        <text fg={theme().text.feedback.success.base}>★</text>
      </Show>
      <Show when={props.description}>
        <text fg={theme().text.faint} wrapMode="word" flexShrink={1}>
          {props.description}
        </text>
      </Show>
    </box>
  )
}

function Body(props: CardProps & { readonly value: Record<string, unknown> | undefined }) {
  const theme = () => props.context.theme
  const q = () => props.question
  const cursorAt = (index: number) => props.focused && props.draft.cursor === index
  const isRec = (id: string) => {
    const rec = q().recommended
    return Array.isArray(rec) ? rec.includes(id) : rec === id
  }
  let field: TextareaRenderable | undefined
  const code = () => q().kind === "ask_code"
  const shown = () => {
    if (q().kind !== "slider") return editText(q(), props.draft)
    const other = (props.value as { other?: string } | undefined)?.other
    return other === undefined ? "" : `other: ${other}`
  }
  const editField = (placeholder: string) => (
    <Show
      when={props.editing === "text"}
      fallback={
        <Show when={shown() !== ""}>
          <Show
            when={code()}
            fallback={
              <text fg={theme().text.base} wrapMode="word">
                {shown()}
              </text>
            }
          >
            <markdown content={codeBlock(shown(), q().language)} syntaxStyle={props.syntax} fg={theme().markdown.text} />
          </Show>
        </Show>
      }
    >
      <textarea
        ref={(element: TextareaRenderable) => {
          field = element
          props.textareaRef(element)
        }}
        initialValue={editText(q(), props.draft)}
        placeholder={placeholder}
        minHeight={code() ? Math.min(16, Math.max(3, editText(q(), props.draft).split("\n").length)) : 1}
        maxHeight={code() ? 16 : 8}
        flexGrow={1}
        textColor={theme().text.base}
        focusedTextColor={theme().text.base}
        onContentChange={() => props.onInput(field?.plainText ?? "")}
      />
    </Show>
  )
  return (
    <Switch>
      <Match when={q().kind === "pick_one" || q().kind === "pick_many"}>
        <For each={q().options ?? []}>
          {(option, index) => {
            const picked = () => {
              const selected = props.value?.selected
              return Array.isArray(selected) ? selected.includes(option.id) : selected === option.id
            }
            const marker = () =>
              q().kind === "pick_many" ? (picked() ? "[x]" : "[ ]") : picked() ? "(•)" : "( )"
            return (
              <Row
                context={props.context}
                cursor={cursorAt(index())}
                marker={marker()}
                label={`${index() + 1}. ${option.label}`}
                {...(option.description ? { description: option.description } : {})}
                recommended={isRec(option.id)}
              />
            )
          }}
        </For>
        <Show when={editable(q())}>
          <box flexDirection="row" gap={1}>
            <text fg={theme().text.faint}>other (e):</text>
            {editField("Type your own answer")}
          </box>
        </Show>
      </Match>
      <Match when={q().kind === "show_options"}>
        <box flexDirection="row" gap={1}>
          <For each={q().options ?? []}>
            {(option, index) => {
              const picked = () => props.value?.selected === option.id
              return (
                <box
                  border
                  borderStyle={picked() ? "double" : "single"}
                  borderColor={cursorAt(index()) ? theme().text.action.primary.base : theme().border.base}
                  flexGrow={1}
                  flexBasis={0}
                  paddingLeft={1}
                  paddingRight={1}
                  flexDirection="column"
                >
                  <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
                    {`${picked() ? "(•)" : "( )"} ${index() + 1}. ${option.label}${isRec(option.id) ? " ★" : ""}`}
                  </text>
                  <Show when={option.description}>
                    <text fg={theme().text.muted} wrapMode="word">
                      {option.description}
                    </text>
                  </Show>
                  <For each={option.pros ?? []}>
                    {(pro) => <text fg={theme().text.feedback.success.base} wrapMode="word">{`+ ${pro}`}</text>}
                  </For>
                  <For each={option.cons ?? []}>
                    {(con) => <text fg={theme().text.feedback.error.base} wrapMode="word">{`− ${con}`}</text>}
                  </For>
                </box>
              )
            }}
          </For>
        </box>
      </Match>
      <Match
        when={
          q().kind === "confirm" ||
          q().kind === "thumbs" ||
          q().kind === "emoji_react" ||
          q().kind === "review" ||
          q().kind === "show_diff"
        }
      >
        <Show when={q().kind === "review"}>
          <Show when={q().markdown}>
            <markdown content={q().markdown ?? ""} syntaxStyle={props.syntax} conceal fg={theme().markdown.text} />
          </Show>
          <For each={q().sections ?? []}>
            {(section) => (
              <markdown
                content={`### ${section.title}\n\n${section.content}`}
                syntaxStyle={props.syntax}
                conceal
                fg={theme().markdown.text}
              />
            )}
          </For>
        </Show>
        <Show when={q().kind === "show_diff"}>
          <diff
            diff={q().diff ?? ""}
            view="unified"
            syntaxStyle={props.syntax}
            {...(q().language ? { filetype: q().language } : {})}
            showLineNumbers
            addedBg={theme().diff.background.added}
            removedBg={theme().diff.background.removed}
            fg={theme().text.base}
          />
        </Show>
        <box flexDirection={q().kind === "emoji_react" ? "row" : "column"} gap={q().kind === "emoji_react" ? 2 : 0}>
          <For each={rows(q())}>
            {(id, index) => {
              const picked = () =>
                props.value?.choice === id || props.value?.decision === id || props.value?.emoji === id
              const label = () => {
                if (q().kind === "confirm") return id === "yes" ? (q().yes_label ?? "Yes") : (q().no_label ?? "No")
                if (q().kind === "thumbs") return id === "up" ? "👍 up" : "👎 down"
                if (q().kind === "emoji_react") return id
                return id === "approve" ? "Approve" : "Request changes"
              }
              return (
                <Row
                  context={props.context}
                  cursor={cursorAt(index())}
                  marker={picked() ? "(•)" : "( )"}
                  label={label()}
                  recommended={q().recommended === id}
                />
              )
            }}
          </For>
        </box>
        <Show when={q().kind === "review" || q().kind === "show_diff"}>
          <box flexDirection="row" gap={1}>
            <text fg={theme().text.faint}>feedback (e):</text>
            {editField("What should change?")}
          </box>
        </Show>
      </Match>
      <Match when={q().kind === "rank"}>
        <For each={(props.value?.order as string[] | undefined) ?? rows(q())}>
          {(id, index) => (
            <Row
              context={props.context}
              cursor={cursorAt(index())}
              marker={`${index() + 1}.`}
              label={optionLabel(q(), id)}
              {...((q().options ?? []).find((option) => option.id === id)?.description
                ? { description: (q().options ?? []).find((option) => option.id === id)?.description ?? "" }
                : {})}
            />
          )}
        </For>
      </Match>
      <Match when={q().kind === "slider"}>
        {(() => {
          const bounds = () => sliderBounds(q())
          const current = () => (props.value?.value as number | undefined) ?? bounds().min
          return (
            <box flexDirection="column">
              <text fg={props.focused ? theme().text.base : theme().text.muted}>
                {`${sliderBar(q(), current())} ${sliderText(q(), current())}`}
              </text>
              <text fg={theme().text.faint}>
                {`${q().labels?.min ?? bounds().min} … ${q().labels?.mid ? `${q().labels?.mid} … ` : ""}${q().labels?.max ?? bounds().max}`}
              </text>
              <box flexDirection="row" gap={1}>
                <text fg={theme().text.faint}>{q().allow_other === true ? "value or other (e):" : "value (e):"}</text>
                {editField(`${bounds().min}–${bounds().max}`)}
              </box>
            </box>
          )
        })()}
      </Match>
      <Match when={q().kind === "rate"}>
        <For each={q().options ?? []}>
          {(option, index) => {
            const bounds = sliderBounds(q())
            const rating = () => (props.value?.ratings as Record<string, number> | undefined)?.[option.id]
            const stars = () => {
              const count = bounds.max - bounds.min + 1
              const filled = rating() === undefined ? 0 : (rating() as number) - bounds.min + 1
              return count <= 10 ? `${"★".repeat(filled)}${"☆".repeat(count - filled)}` : String(rating() ?? "–")
            }
            return (
              <Row
                context={props.context}
                cursor={cursorAt(index())}
                marker={stars()}
                label={option.label}
                {...(option.description ? { description: option.description } : {})}
              />
            )
          }}
        </For>
      </Match>
      <Match when={q().kind === "ask_text"}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.faint}>answer (e):</text>
          {editField(q().placeholder ?? "Type your answer")}
        </box>
      </Match>
      <Match when={q().kind === "ask_code"}>
        <box flexDirection="column">
          <text fg={theme().text.faint}>{`code${q().language ? ` (${q().language})` : ""} (e):`}</text>
          {editField(q().placeholder ?? "Write the code")}
        </box>
      </Match>
      <Match when={q().kind === "ask_image" || q().kind === "ask_file"}>
        <For each={((props.value?.files as FileValue[] | undefined) ?? []) as FileValue[]}>
          {(file) => <text fg={theme().text.base}>{`📎 ${file.name} (${file.mime}, ${file.size} B)`}</text>}
        </For>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.faint}>{q().multiple ? "paths, comma or line separated (e):" : "path (e):"}</text>
          {editField(q().kind === "ask_image" ? "screenshot.png, or ctrl+v to paste one" : "./path/to/file")}
        </box>
        <Show when={props.editing === "text" && props.suggestions.length > 0}>
          <box flexDirection="column" paddingLeft={2}>
            <For each={props.suggestions}>
              {(suggestion, index) => (
                <text
                  fg={index() === props.selected ? theme().text.action.primary.base : theme().text.muted}
                  attributes={index() === props.selected ? TextAttributes.BOLD : 0}
                >
                  {`${index() === props.selected ? "›" : " "} ${suggestion}`}
                </text>
              )}
            </For>
          </box>
        </Show>
      </Match>
    </Switch>
  )
}

export const EMOJIS = DEFAULT_EMOJIS
