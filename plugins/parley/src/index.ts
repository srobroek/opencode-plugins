import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import type { FileValue, SubmittedAnswer } from "./answers.ts"
import { render } from "./format.ts"
import { ParleyRpc, type RoundEvent } from "./rpc.ts"
import { askInput, endInput, endOutput, resultOutput, waitInput } from "./schema.ts"
import { type AskInput, type CallContext, InputError, Parley, settingsFrom, type WaitInput } from "./service.ts"

export { ParleyRpc } from "./rpc.ts"

const ASK_DESCRIPTION = `Ask the user one round of questions in the parley panel and wait for the answers.

Send every question you can ask now (questions whose prerequisites are settled) in one call. Each question has a stable \`id\`, a short \`title\`, a markdown \`body\`, a \`kind\`, your \`recommended\` answer and a one-line \`rationale\`. Kinds: pick_one, show_options (options with pros/cons), pick_many, confirm, rank, slider, ask_text, review, rate, thumbs, emoji_react, show_diff, ask_code, ask_image, ask_file.

Answers come back keyed by id with status answered, accepted (took your recommendation), noted (comment only) or deferred (keep it open). Ids still unanswered are listed in \`pending\`.
If the result status is \`unavailable\`, no parley UI is attached: ask with the question tool or in chat for the rest of the session. On \`timeout\`, call parley_wait.`

const options = { codemode: false, permission: "parley" } as const

function saveUpload(file: FileValue) {
  if (file.data === undefined) return undefined
  const dir = path.join(tmpdir(), "parley", crypto.randomUUID())
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, path.basename(file.name))
  writeFileSync(target, Buffer.from(file.data, "base64"))
  return target
}

export default Plugin.define({
  id: "srobroek.parley",
  async setup(ctx) {
    let emitEvent: ((event: RoundEvent) => Promise<void>) | undefined
    const service = new Parley({
      settings: settingsFrom(ctx.options, process.env),
      emit: async (event) => {
        await emitEvent?.(event).catch(() => {})
      },
      questionTool: async () => (await ctx.tool.list()).find((tool) => tool.id === "question"),
    })

    const rpc = await ctx.rpc.register(ParleyRpc, {
      attach: async (input) => service.attach(input as { clientID: string; sessionIDs?: string[]; detach?: boolean }),
      pending: async (input) => service.pending((input ?? {}) as { sessionID?: string }),
      submit: async (input) =>
        service.submit(input as { roundID: string; answers: SubmittedAnswer[]; final?: boolean }),
      cancel: async (input) => service.cancel(input as { roundID: string; reason?: string }),
    })
    emitEvent = (event) => rpc.events.emit("round", { ...event })

    const call = (context: { sessionID: string; signal: AbortSignal; progress: CallContext["progress"] }) => ({
      sessionID: context.sessionID,
      signal: context.signal,
      progress: context.progress,
      tool: context,
    })

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "parley_ask",
        description: ASK_DESCRIPTION,
        input: askInput,
        output: resultOutput,
        options,
        execute: async (input, context) => {
          try {
            const { result, questions } = await service.ask(input as AskInput, call(context))
            return render(result, questions, saveUpload)
          } catch (error) {
            if (error instanceof InputError) throw new Error(error.message)
            throw error
          }
        },
      })
      editor.add({
        name: "parley_wait",
        description:
          "Keep waiting for answers to this session's open parley round (after a timeout or wait:none/any). Returns only answers not returned before.",
        input: waitInput,
        output: resultOutput,
        options,
        execute: async (input, context) => {
          const { result, questions } = await service.wait(input as WaitInput, call(context))
          return render(result, questions, saveUpload)
        },
      })
      editor.add({
        name: "parley_end",
        description:
          "Close the parley for this session once every question is settled and the user confirmed the outcome.",
        input: endInput,
        output: endOutput,
        options,
        execute: async (input, context) => {
          const result = await service.end(context.sessionID, (input as { message?: string }).message)
          return { output: result, content: result.closed > 0 ? "Parley closed." : "No open round; done." }
        },
      })
    })

    const sweep = setInterval(() => service.sweep(), 5 * 60_000)
    sweep.unref?.()

    return async () => {
      clearInterval(sweep)
      service.close()
      await tools.dispose()
      await rpc.dispose()
    }
  },
})
