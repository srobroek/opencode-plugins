import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { bannerText, type LockState, readState } from "./state.ts"
import { rootOf } from "./tui-root.ts"

const POLL_MS = 1000

function Banner(props: { context: Plugin.Context; sessionID: string }) {
  const ctx = props.context
  const root = createMemo(() => rootOf((id) => ctx.data.session.get(id), props.sessionID))
  const [state, setState] = createSignal<LockState>(readState(root()))
  const refresh = () => {
    const next = readState(root())
    const was = bannerText(state())
    const now = bannerText(next)
    if (now !== undefined && was === undefined)
      ctx.ui.toast.show({ message: `Bound to PACE customer ${next.customer}`, variant: "success", sessionID: props.sessionID })
    setState(next)
  }
  const timer = setInterval(refresh, POLL_MS)
  onCleanup(() => clearInterval(timer))
  const text = createMemo(() => bannerText(state()))

  return (
    <Show when={text()}>
      <box
        flexDirection="row"
        justifyContent="center"
        alignItems="center"
        width="100%"
        height={3}
        flexShrink={0}
        backgroundColor="#c00000"
      >
        <text wrapMode="none">
          <span style={{ fg: "#ffffff", bold: true }}>{text()}</span>
        </text>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "srobroek.pace-lock",
  setup(context) {
    return context.ui.slot({
      append: "session.composer.top",
      render: (input) => <Banner context={context} sessionID={input.sessionID} />,
    })
  },
})
