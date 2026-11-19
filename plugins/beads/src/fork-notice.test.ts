import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { forkNotice } from "./fork-notice.ts"
import { setupBeads } from "./index.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const quietEnv = { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv

function claimsOf(ids: string[]) {
  return {
    actors: ["opencode/main/ses_orig"],
    claims: Object.fromEntries(ids.map((id) => [`store\0${id}`, { id, actor: "opencode/main/ses_orig", store: "store" }])),
  }
}

async function start(storage: Record<string, unknown>, hookFails = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "beads-fork-")))
  roots.push(directory)
  const fake = createFakeContext({
    directory,
    storage,
    sessions: [{ id: "ses_orig" }, { id: "ses_fork", fork: { sessionID: "ses_orig" } }],
  })
  const hook = fake.context.session.hook as (name: string, callback: never) => Promise<unknown>
  const context = hookFails
    ? {
        ...fake.context,
        session: {
          ...fake.context.session,
          hook: (name: string, callback: never) =>
            name === "fork" ? Promise.reject(new Error(`unknown hook ${name}`)) : hook(name, callback),
        },
      }
    : fake.context
  const cleanup = await setupBeads(context as never, { env: quietEnv, pinFor: () => undefined })
  return { fake, cleanup }
}

const synthetic = (fake: Awaited<ReturnType<typeof start>>["fake"]) =>
  fake.calls.filter((call) => call.method === "session.synthetic")

describe("forkNotice", () => {
  test("lists at most 10 ids, then the rest as a count", () => {
    const ids = Array.from({ length: 13 }, (_, i) => `b-${i + 1}`)
    const text = forkNotice("ses_orig", claimsOf(ids) as never)
    expect(text).toContain("b-1, b-2, b-3, b-4, b-5, b-6, b-7, b-8, b-9, b-10 and 3 more;")
    expect(text).not.toContain("b-11")
  })
})

describe("session.fork hook", () => {
  test("a fork of a session with claims gets one notice and the original's claims stay", async () => {
    const state = claimsOf(["b-1", "b-2"])
    const { fake, cleanup } = await start({ "claims/ses_orig": structuredClone(state) })
    await fake.fire.session("fork", { sessionID: "ses_fork" })
    const sent = synthetic(fake)
    expect(sent).toHaveLength(1)
    const input = sent[0]?.input as { sessionID: string; text: string }
    expect(input.sessionID).toBe("ses_fork")
    expect(input.text).toBe(
      "This session is a fork of ses_orig. That session holds b-1, b-2; this one holds no claims. Claim before working on a bead (bd update <id> --claim), or pick other work.",
    )
    expect(await fake.context.storage.get("claims/ses_orig")).toEqual(state)
    expect(await fake.context.storage.get("claims/ses_fork")).toBeUndefined()
    expect(await fake.context.storage.get("leases/ses_orig")).toBeUndefined()
    await cleanup()
  })

  test("a fork of a session with no claims gets nothing", async () => {
    const { fake, cleanup } = await start({})
    await fake.fire.session("fork", { sessionID: "ses_fork" })
    expect(synthetic(fake)).toHaveLength(0)
    await cleanup()
  })

  test("a host that rejects the hook still loads beads", async () => {
    const { fake, cleanup } = await start({}, true)
    expect(fake.hooks("session")).not.toContain("fork")
    expect(fake.hooks("session")).toContain("context")
    await cleanup()
  })
})
