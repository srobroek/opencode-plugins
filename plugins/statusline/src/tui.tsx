import { hostname } from "node:os"
import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createMemo, createResource, createSignal, Index, onCleanup, Show } from "solid-js"
import {
  accentIndex,
  buildSegments,
  fitSegments,
  type Options,
  parseOptions,
  type Segment,
  type SegmentInput,
  separators,
  type Tone,
} from "./format.ts"

type Context = Plugin.Context

/** Columns the composer insets this slot by on each side; only seeds the first frame before layout reports a width. */
const COMPOSER_INSET = 2

function Bar(props: { context: Context; options: Options; sessionID: string }) {
  const ctx = props.context
  const theme = ctx.theme
  const host = hostname().split(".")[0]
  const sep = separators(props.options.separator)
  const [width, setWidth] = createSignal(Math.max(0, ctx.renderer.width - 2 * COMPOSER_INSET))

  const session = createMemo(() => ctx.data.session.get(props.sessionID))
  const messages = createMemo(() => ctx.data.session.message.list(props.sessionID))
  const model = createMemo(() => {
    const ref = ctx.ui.model.current()
    if (!ref) return undefined
    return ctx.data.location.model
      .list(session()?.location)
      ?.find((m) => m.providerID === ref.providerID && (m.modelID === ref.modelID || m.id === ref.modelID))
  })
  const vcs = createMemo(() => ctx.data.location.vcs.info(session()?.location))
  const [dirty, { refetch }] = createResource(
    () => session()?.location.directory,
    async (directory) => (await ctx.client.vcs.status({ location: { directory } })).data.length,
  )
  const stops = [
    ctx.data.on("session.execution.succeeded", () => void refetch()),
    ctx.data.on("vcs.branch.updated", () => void refetch()),
  ]
  onCleanup(() => {
    for (const stop of stops) stop()
  })

  const accent = createMemo(() => {
    const palette = theme.categorical
    const scale = palette[accentIndex(session()?.title || props.sessionID, palette.length)]
    return scale?.[ctx.themeMode === "dark" ? 400 : 600] ?? theme.text.base
  })
  const color = (tone: Tone): RGBA => {
    switch (tone) {
      case "accent":
        return accent()
      case "value":
        return theme.text.base
      case "dim":
        return theme.text.muted
      case "label":
        return theme.text.faint
      case "success":
      case "warning":
      case "error":
        return theme.text.feedback[tone].base
    }
  }

  const input = createMemo((): SegmentInput => {
    const s = session()
    return {
      sessionID: props.sessionID,
      hostname: host,
      model: model()?.name,
      variant: ctx.ui.model.current()?.variant,
      agent: s?.agent,
      path: s ? ctx.ui.format.path(s.location.directory) : undefined,
      branch: vcs()?.branch.current,
      // `latest` keeps the last count while a refetch is in flight, so the segment never blinks out.
      dirty: dirty.error ? undefined : dirty.latest,
      title: s?.title,
      cost: s?.cost,
      tokens: s?.tokens,
      messages: messages(),
      revert: s?.revert?.messageID,
      contextWindow: model()?.limit.context,
    }
  })
  const row = createMemo(() => {
    const all = buildSegments(input(), props.options)
    return width() > 0 ? fitSegments(all, width(), sep, input()) : all
  })

  // Index keeps one node per slot, so a changing value updates the span in place instead of remounting it.
  const Side = (p: { segments: Segment[]; sep: string }) => (
    <Index each={p.segments}>
      {(seg, i) => (
        <>
          <Show when={i > 0}>
            <span style={{ fg: theme.text.faint }}>{p.sep}</span>
          </Show>
          <Index each={seg().parts}>
            {(part) => (
              <span style={{ fg: color(part().tone), bold: part().bold ?? false }}>
                {part().text}
              </span>
            )}
          </Index>
        </>
      )}
    </Index>
  )

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
      height={1}
      flexShrink={0}
      onSizeChange={function (this: { width: number }) {
        setWidth(this.width)
      }}
    >
      <text wrapMode="none" truncate flexShrink={1} minWidth={0}>
        <Side segments={row().left} sep={sep.left} />
      </text>
      <text wrapMode="none" flexShrink={0}>
        <Side segments={row().right} sep={sep.right} />
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "srobroek.statusline",
  setup(context) {
    const options = parseOptions(context.options)
    return context.ui.slot({
      append: "session.composer.top",
      render: (input) => <Bar context={context} options={options} sessionID={input.sessionID} />,
    })
  },
})
