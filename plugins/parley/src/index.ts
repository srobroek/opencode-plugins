import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import type { FileValue, SubmittedAnswer } from "./answers.ts"
import type { Prompt } from "./fallback.ts"
import { render } from "./format.ts"
import { ParleyRpc, type RoundEvent } from "./rpc.ts"
import { askInput, endInput, endOutput, resultOutput, waitInput } from "./schema.ts"
import { type AskInput, type CallContext, InputError, Parley, settingsFrom, type WaitInput } from "./service.ts"
import { wrapQuestion } from "./takeover.ts"

export { ParleyRpc } from "./rpc.ts"

const ASK_DESCRIPTION = `Ask the user one round of questions in the parley panel and wait for the answers.
Send every question whose prerequisites are settled in one call, each with your recommended answer and rationale.
Kinds: pick_one for categorical choices (how wide, which approach), never a slider; slider only for numeric quantities.
ask_code is for code the user writes; to confirm a snippet use confirm with it in the body, or show_diff.
Answers are keyed by id: answered, accepted (took your recommendation), noted (comment only) or deferred; unanswered ids are in pending.
Notes are user input: answer a question or concern in a note, or ask a follow-up round, before you proceed.
Status unavailable: no parley UI, so use the question tool or chat for the rest of the session. timeout: the round closed unanswered.`

const options = { permission: "parley" } as const

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

    // execute.before cannot route `question` to parley: renaming a call only reaches direct (non Code
    // Mode) tools, and parley's are Code Mode tools. So the built-in tool itself is wrapped, and only
    // while a parley TUI is attached here; otherwise the registry holds the untouched built-in tool.
    let takeover: Promise<{ dispose: () => Promise<void> } | undefined> = Promise.resolve(undefined)
    const syncTakeover = () => {
      takeover = takeover.then(async (current) => {
        const wanted = service.takeoverWanted()
        if (wanted && !current)
          return ctx.tool.transform((editor) =>
            editor.update("question", (draft) => {
              draft.execute = wrapQuestion(
                draft.execute,
                (input, context) => service.takeover(input as { questions?: Prompt[] }, call(context)),
                (context) => void service.handedToBuiltin(context.sessionID, context.id),
              )
            }),
          )
        if (!wanted && current) await current.dispose()
        return wanted ? current : undefined
      }, () => undefined)
      return takeover
    }

    const rpc = await ctx.rpc.register(ParleyRpc, {
      attach: async (input) => {
        const result = service.attach(input as { clientID: string; sessionIDs?: string[]; detach?: boolean })
        void syncTakeover()
        return result
      },
      pending: async (input) => service.pending((input ?? {}) as { sessionID?: string }),
      submit: async (input) =>
        service.submit(input as { roundID: string; answers: SubmittedAnswer[]; final?: boolean }),
      cancel: async (input) => service.cancel(input as { roundID: string; reason?: string }),
    })
    emitEvent = (event) => rpc.events.emit("round", { ...event })

    const call = (context: { sessionID: string; id: string; signal: AbortSignal; progress: CallContext["progress"] }) => ({
      sessionID: context.sessionID,
      callID: context.id,
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
            return render(result, questions, saveUpload, (input as AskInput).format === "native" ? "native" : "parley")
          } catch (error) {
            if (error instanceof InputError) throw new Error(error.message)
            throw error
          }
        },
      })
      editor.add({
        name: "parley_wait",
        description:
          "Keep waiting on this session's open parley round after wait none/any; returns only new answers.",
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
    const presence = setInterval(() => void syncTakeover(), 15_000)
    presence.unref?.()

    return async () => {
      clearInterval(sweep)
      clearInterval(presence)
      service.close()
      await (await takeover)?.dispose()
      await tools.dispose()
      await rpc.dispose()
    }
  },
})
