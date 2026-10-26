/** @jsxImportSource @opentui/solid */
// Sketch only (not type-checked against @opencode/theme, which is not installed in this repo).
import { Plugin } from "@opencode/plugin/tui"
import type { SessionMessageInfo } from "@opencode/client"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { hostname } from "node:os"

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

// Pure helpers: unit-test these directly.
export function contextSegment(messages: readonly SessionMessageInfo[], window: number | undefined) {
  const last = lastAssistantWithUsage(messages)
  if (!last?.tokens) return undefined
  const t = last.tokens
  const used = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  if (!window) return `${compact(used)}/?`
  return `${((used / window) * 100).toFixed(1)}%/${compact(window)}` // omp formatContextUsage
}

export function activeMs(messages: readonly SessionMessageInfo[]) {
  let ms = 0
  for (const m of messages)
    if (m.type === "assistant" && m.time.completed) ms += m.time.completed - m.time.created
  return ms
}

export function tokenRate(messages: readonly SessionMessageInfo[]) {
  const last = lastAssistantWithUsage(messages)
  if (!last?.tokens || !last.time.streamed || !last.time.completed) return undefined
  const s = (last.time.completed - last.time.streamed) / 1000
  return s > 0 ? `${(last.tokens.output / s).toFixed(1)} tok/s` : undefined
}

export default Plugin.define({
  id: "srobroek.statusline",
  setup(context) {
    const theme = context.theme
    const host = hostname().split(".")[0]

    const Bar = (props: { sessionID: string }) => {
      const session = createMemo(() => context.data.session.get(props.sessionID))
      const messages = createMemo(() => context.data.session.message.list(props.sessionID))
      const model = createMemo(() => {
        const ref = context.ui.model.current()
        const loc = session()?.location
        return context.data.location.model
          .list(loc)
          ?.find((m) => m.providerID === ref?.providerID && m.id === ref?.modelID)
      })
      const vcs = createMemo(() => context.data.location.vcs.info(session()?.location))
      // Dirty counts: VcsFileStatus only has added/deleted/modified (no staged/untracked split).
      const [dirty, { refetch }] = createResource(
        () => session()?.location.directory,
        async (directory) => (await context.client.vcs.status({ location: { directory } })).data,
      )
      const stop = context.data.on("session.execution.succeeded", () => void refetch())
      onCleanup(stop)

      const left = createMemo(() =>
        [
          props.sessionID.replace(/^ses_?/, "").slice(0, 8),
          host,
          model() &&
            `${model()!.name.replace(/^Claude /, "")}${context.ui.model.current()?.variant ? ` · ${context.ui.model.current()!.variant}` : ""}`,
          session()?.agent,
          session() && context.ui.format.path(session()!.location.directory),
          vcs()?.branch.current &&
            `${vcs()!.branch.current}${dirty()?.length ? ` *${dirty()!.length}` : ""}`,
        ].filter(Boolean) as string[],
      )
      const right = createMemo(() => {
        const t = session()?.tokens
        return [
          contextSegment(messages(), model()?.limit.context),
          session()?.title,
          t?.input ? `↑${compact(t.input)}` : undefined,
          t?.output ? `↓${compact(t.output)}` : undefined,
          t?.cache.read ? `⟳${compact(t.cache.read)}` : undefined,
          t?.cache.write ? `✎${compact(t.cache.write)}` : undefined,
          tokenRate(messages()),
          activeMs(messages()) >= 1000 ? `${Math.round(activeMs(messages()) / 1000)}s` : undefined,
        ].filter(Boolean) as string[]
      })

      return (
        <box flexDirection="row" justifyContent="space-between" width="100%" height={1}>
          <text fg={theme.text.muted} wrapMode="none" truncate flexShrink={1}>
            <For each={left()}>{(s, i) => <>{i() ? "  " : ""}{s}</>}</For>
          </text>
          <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
            {right().join("  ")}
          </text>
        </box>
      )
    }

    return context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <Show when={input.sessionID}>{(id) => <Bar sessionID={id()} />}</Show>
      ),
    })
  },
})
