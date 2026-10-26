import { hostname } from "node:os"
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import {
  accentIndex,
  buildSegments,
  fitSegments,
  type Options,
  parseOptions,
  type Segment,
  separators,
} from "./format.ts"

type Context = Plugin.Context

function Bar(props: { context: Context; options: Options; sessionID: string }) {
  const ctx = props.context
  const theme = ctx.theme
  const host = hostname().split(".")[0]
  const sep = separators(props.options.separator)
  const [width, setWidth] = createSignal(0)

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

  const row = createMemo(() => {
    const s = session()
    const all = buildSegments(
      {
        sessionID: props.sessionID,
        hostname: host,
        model: model()?.name,
        variant: ctx.ui.model.current()?.variant,
        agent: s?.agent,
        path: s ? ctx.ui.format.path(s.location.directory) : undefined,
        branch: vcs()?.branch.current,
        dirty: dirty.error ? undefined : dirty(),
        title: s?.title,
        tokens: s?.tokens,
        messages: messages(),
        revert: s?.revert?.messageID,
        contextWindow: model()?.limit.context,
      },
      props.options,
    )
    return width() > 0 ? fitSegments(all.left, all.right, width(), sep) : all
  })

  const Side = (p: { segments: Segment[]; sep: string }) => (
    <For each={p.segments}>
      {(seg, i) => (
        <>
          <Show when={i() > 0}>
            <span style={{ fg: theme.text.faint }}>{p.sep}</span>
          </Show>
          <span style={{ fg: seg.accent ? accent() : theme.text.muted }}>{seg.text}</span>
        </>
      )}
    </For>
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
