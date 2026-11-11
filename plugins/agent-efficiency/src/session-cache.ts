import type { Context } from "@opencode/plugin/promise/plugin"

export function onSessionDeleted(ctx: Context, evict: (sessionID: string) => void): () => Promise<void> {
  const controller = new AbortController()
  const iterator = ctx.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
  const listening = (async () => {
    try {
      while (!controller.signal.aborted) {
        const next = await iterator.next()
        if (next.done) break
        const event = next.value
        if (event.type === "session.deleted") evict(event.data.sessionID)
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    }
  })()
  // Observe stream failures even if teardown has not started.
  void listening.catch(() => {})
  return async () => {
    controller.abort()
    await iterator.return?.()
  }
}
