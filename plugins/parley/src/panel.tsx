import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import {
  type BoxRenderable,
  type Renderable,
  type ScrollBoxRenderable,
  type SyntaxStyle,
  TextAttributes,
  type TextareaRenderable,
} from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { FileValue, SubmittedAnswer } from "./answers.ts"
import { DEFAULT_EMOJIS, optionLabel, type Question, sliderBounds } from "./questions.ts"
import type { RoundView } from "./rounds.ts"
import {
  accept,
  badge,
  choose,
  type Draft,
  editable,
  editText,
  initialDraft,
  mimeFor,
  moveCursor,
  parsePaths,
  rankMove,
  rows,
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
}

async function readFiles(text: string): Promise<FileValue[]> {
  const home = process.env.HOME ?? ""
  const files: FileValue[] = []
  for (const raw of parsePaths(text)) {
    const path = raw.startsWith("~/") ? `${home}${raw.slice(1)}` : raw
    const file = Bun.file(path)
    if (!(await file.exists())) throw new Error(`No such file: ${raw}`)
    const data = Buffer.from(await file.arrayBuffer()).toString("base64")
    files.push({ name: path.split("/").pop() ?? path, path, mime: (file.type || mimeFor(path)).split(";")[0] ?? mimeFor(path), size: file.size, data })
  }
  return files
}

/** Draft, edit and submit state of one round, shared by the full panel and the inline card. */
function createRoundControls(
  props: Pick<PanelProps, "store" | "round" | "submit">,
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
  let textarea: TextareaRenderable | undefined

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

  const startEdit = (field: "note" | "text") => {
    const question = current()
    if (!question) return
    if (field === "text" && !editable(question)) return
    setEditing({ id: question.id, field })
  }

  const finishEdit = async () => {
    const edit = editing()
    const question = questions().find((candidate) => candidate.id === edit?.id)
    const text = textarea?.plainText ?? ""
    setEditing(undefined)
    if (!edit || !question) return
    const draft = draftOf(question.id) ?? initialDraft(question)
    if (edit.field === "note") {
      setDraft(question.id, setNote(draft, text))
      return
    }
    if (question.kind === "ask_image" || question.kind === "ask_file") {
      try {
        const files = text.trim() === "" ? [] : await readFiles(text)
        setDraft(
          question.id,
          files.length === 0 ? initialDraft(question) : { ...draft, status: "answered", value: { files } },
        )
        setErrors([])
      } catch (error) {
        setErrors([error instanceof Error ? error.message : String(error)])
      }
      return
    }
    setDraft(question.id, setText(question, draft, text))
  }

  const submit = async () => {
    const round = props.round()
    if (!round || busy()) return
    if (editing()) await finishEdit()
    setBusy(true)
    try {
      const problems = await props.submit(round, submissions(questions(), Object.fromEntries(questions().map((q) => [q.id, draftOf(q.id) ?? initialDraft(q)]))))
      setErrors(problems)
    } finally {
      setBusy(false)
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
    startEdit,
    finishEdit,
    submit,
    setTextarea: (element: TextareaRenderable) => {
      textarea = element
    },
  }
}

export function RoundPanel(props: PanelProps) {
  const theme = () => props.context.theme
  let scroll: ScrollBoxRenderable | undefined
  const { draftOf, focus, editing, errors, busy, questions, update, moveCard, startEdit, finishEdit, submit, setTextarea } =
    createRoundControls(props, (id) => scroll?.scrollChildIntoView(`parley-card-${id}`))

  props.context.keymap.layer(() => ({
    enabled: () => editing() === undefined,
    commands: [
      { bind: "tab", title: "Next question", group: "Parley", run: () => moveCard(1) },
      { bind: "shift+tab", title: "Previous question", group: "Parley", run: () => moveCard(-1) },
      { bind: "j", title: "Next question", group: "Parley", run: () => moveCard(1) },
      { bind: "k", title: "Previous question", group: "Parley", run: () => moveCard(-1) },
      { bind: "down", title: "Next choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, 1)) },
      { bind: "up", title: "Previous choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, -1)) },
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
      { bind: "left", title: "Decrease", group: "Parley", run: () => update((q, d) => step(q, d, -1)) },
      { bind: "right", title: "Increase", group: "Parley", run: () => update((q, d) => step(q, d, 1)) },
      { bind: "a", title: "Accept recommendation", group: "Parley", run: () => update(accept) },
      { bind: "d", title: "Defer", group: "Parley", run: () => update((q, d) => toggleDefer(d, q)) },
      { bind: "n", title: "Note", group: "Parley", run: () => startEdit("note") },
      { bind: "e", title: "Edit answer", group: "Parley", run: () => startEdit("text") },
      { bind: "ctrl+return", title: "Submit round", group: "Parley", run: () => void submit() },
      { bind: "ctrl+s", title: "Submit round", group: "Parley", run: () => void submit() },
      { bind: "escape", title: "Minimise", group: "Parley", run: () => props.panel.close() },
      {
        bind: "shift+d",
        title: "Dismiss round",
        group: "Parley",
        run: () => {
          const round = props.round()
          if (round) void props.dismiss(round)
        },
      },
      { bind: "pageup", title: "Scroll", group: "Parley", run: () => scroll?.scrollBy(-10) },
      { bind: "pagedown", title: "Scroll", group: "Parley", run: () => scroll?.scrollBy(10) },
    ],
  }))

  props.context.keymap.layer(() => ({
    enabled: () => editing() !== undefined,
    commands: [
      { bind: "escape", title: "Done editing", group: "Parley", run: () => void finishEdit() },
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
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
      <box flexDirection="row" flexShrink={0} gap={2}>
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          {`Parley · round ${props.round()?.number ?? "?"}`}
        </text>
        <Show when={props.round()?.title}>
          <text fg={theme().text.muted} truncate flexGrow={1}>
            {props.round()?.title}
          </text>
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
          {editing()
            ? "esc done · ctrl+enter / ctrl+s submit round"
            : "tab/j/k question · ↑/↓ choice · space choose · a accept · n note · d defer · e edit · shift+↑/↓ J/K rank · ←/→ adjust · ctrl+enter / ctrl+s submit · esc minimise · D dismiss"}
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

/** A one-question round as a compact card above the prompt, with the panel's keys. */
export function InlineCard(props: InlineCardProps) {
  const theme = () => props.context.theme
  const { draftOf, editing, errors, busy, questions, update, startEdit, finishEdit, submit, setTextarea } =
    createRoundControls(props)
  let box: BoxRenderable | undefined
  const question = () => questions()[0]

  // Take focus from the prompt like a dialog does, and hand it back when the card goes away.
  onMount(() => {
    const previous = props.context.renderer.currentFocusedRenderable
    queueMicrotask(() => {
      if (box && !box.isDestroyed) box.focus()
    })
    onCleanup(() => {
      const now = props.context.renderer.currentFocusedRenderable
      if (now && !within(now, box)) return
      if (previous && !previous.isDestroyed) previous.focus()
    })
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

  props.context.keymap.layer(() => ({
    target: () => box,
    enabled: () => editing() === undefined,
    commands: [
      { bind: "down", title: "Next choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, 1)) },
      { bind: "up", title: "Previous choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, -1)) },
      { bind: "j", title: "Next choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, 1)) },
      { bind: "k", title: "Previous choice", group: "Parley", run: () => update((q, d) => moveCursor(q, d, -1)) },
      { bind: "space", title: "Choose", group: "Parley", run: () => update((q, d) => choose(q, d)) },
      ...Array.from({ length: 9 }, (_, index) => ({
        bind: String(index + 1),
        title: `Choose ${index + 1}`,
        group: "Parley",
        run: () => update((q, d) => choose(q, d, index)),
      })),
      { bind: "left", title: "Decrease", group: "Parley", run: () => update((q, d) => step(q, d, -1)) },
      { bind: "right", title: "Increase", group: "Parley", run: () => update((q, d) => step(q, d, 1)) },
      { bind: "a", title: "Accept recommendation", group: "Parley", run: () => update(accept) },
      { bind: "d", title: "Defer", group: "Parley", run: () => update((q, d) => toggleDefer(d, q)) },
      { bind: "n", title: "Note", group: "Parley", run: () => startEdit("note") },
      { bind: "e", title: "Edit answer", group: "Parley", run: () => startEdit("text") },
      { bind: "return", title: "Submit", group: "Parley", run: () => void send() },
      { bind: "ctrl+return", title: "Submit", group: "Parley", run: () => void send() },
      { bind: "ctrl+s", title: "Submit", group: "Parley", run: () => void send() },
      { bind: "f", title: "Full screen", group: "Parley", run: () => props.expand() },
      { bind: "escape", title: "Hide", group: "Parley", run: () => props.hide() },
      {
        bind: "shift+d",
        title: "Dismiss",
        group: "Parley",
        run: () => {
          const round = props.round()
          if (round) void props.dismiss(round)
        },
      },
    ],
  }))

  props.context.keymap.layer(() => ({
    target: () => box,
    enabled: () => editing() !== undefined,
    commands: [
      { bind: "escape", title: "Done editing", group: "Parley", run: () => void done() },
      { bind: "ctrl+return", title: "Submit", group: "Parley", run: () => void submit() },
      { bind: "ctrl+s", title: "Submit", group: "Parley", run: () => void submit() },
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
          : editing()
            ? "esc done · ctrl+s submit"
            : "Parley · 1-9/space choose · enter submit · n note · d defer · e edit · a accept · f full screen · esc hide · D dismiss"}
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
}

function Card(props: CardProps) {
  const theme = () => props.context.theme
  const q = () => props.question
  const value = () => props.draft.value as Record<string, unknown> | undefined
  const recommended = () => {
    const rec = q().recommended
    if (rec === undefined) return undefined
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
            placeholder="Add a note (esc when done)"
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
  const editField = (placeholder: string) => (
    <Show
      when={props.editing === "text"}
      fallback={
        <Show when={editText(q(), props.draft) !== ""}>
          <text fg={theme().text.base} wrapMode="word">
            {editText(q(), props.draft)}
          </text>
        </Show>
      }
    >
      <textarea
        ref={props.textareaRef}
        initialValue={editText(q(), props.draft)}
        placeholder={placeholder}
        minHeight={1}
        maxHeight={q().kind === "ask_code" ? 16 : 8}
        textColor={theme().text.base}
        focusedTextColor={theme().text.base}
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
                {`${sliderBar(q(), current())} ${current()}${q().unit ? ` ${q().unit}` : ""}`}
              </text>
              <text fg={theme().text.faint}>
                {`${q().labels?.min ?? bounds().min} … ${q().labels?.mid ? `${q().labels?.mid} … ` : ""}${q().labels?.max ?? bounds().max}   ←/→ adjust`}
              </text>
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
      <Match when={q().kind === "ask_text" || q().kind === "ask_code"}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.faint}>{q().kind === "ask_code" ? `code${q().language ? ` (${q().language})` : ""} (e):` : "answer (e):"}</text>
          {editField(q().placeholder ?? "Type your answer")}
        </box>
      </Match>
      <Match when={q().kind === "ask_image" || q().kind === "ask_file"}>
        <For each={((props.value?.files as FileValue[] | undefined) ?? []) as FileValue[]}>
          {(file) => <text fg={theme().text.base}>{`📎 ${file.name} (${file.mime}, ${file.size} B)`}</text>}
        </For>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.faint}>{q().multiple ? "paths, one per line (e):" : "path (e):"}</text>
          {editField(q().kind === "ask_image" ? "~/Pictures/screenshot.png" : "./path/to/file")}
        </box>
      </Match>
    </Switch>
  )
}

export const EMOJIS = DEFAULT_EMOJIS
