import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { createPlugin, PACK_TOOL, REPOMIX_VERSION } from "./index.ts"

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>

const context = { sessionID: "ses_1", agent: "researcher", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }

const SUMMARY = "  Total Files: 2 files\n Total Tokens: 390 tokens\n  Total Chars: 1,785 chars\n"

function fakeRepomix(seen: string[][]) {
  return async (argv: string[]): Promise<SupervisedRun> => {
    seen.push(argv)
    const output = (argv.find((arg) => arg.startsWith("--output=")) ?? "").slice("--output=".length)
    writeFileSync(output, "<files></files>")
    return { kind: "exited", exitCode: 0, signalCode: null, stdout: SUMMARY, stderr: "" }
  }
}

test("registers the tool, the skill and the npx prompt, and disposes them", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.tools.keys()]).toEqual([PACK_TOOL])
  expect([...fake.skills.keys()]).toEqual(["repomix"])
  expect(fake.hooks("permission")).toEqual(["evaluate"])
  await cleanup?.()
  expect(fake.active()).toBe(0)
  expect(fake.tools.size).toBe(0)
})

test("confirmPack=false leaves the npx fallback to the configured rules", async () => {
  const fake = createFakeContext({ options: { confirmPack: false } })
  await plugin.setup(fake.context)
  expect(fake.hooks("permission")).toEqual([])
})

test("a pack asks for the resolved target and returns the path and metrics only", async () => {
  const root = mkdtempSync(join(tmpdir(), "repomix-tool-"))
  try {
    const seen: string[][] = []
    const fake = createFakeContext({ directory: "/project" })
    await createPlugin({ root, exec: fakeRepomix(seen), which: () => "/bin/repomix", isDirectory: () => true }).setup(
      fake.context,
    )
    const pack = fake.tools.get(PACK_TOOL)?.execute as Execute
    const local = await pack({ directory: "plugins/lib", compress: true }, context)
    expect(local.metadata).toMatchObject({ ok: true, status: "packed", runner: "path", files: 2, tokens: 390 })
    expect(local.content).toContain(`to ${root}/repomix-lib-`)
    expect(fake.asserts[0]).toMatchObject({
      action: PACK_TOOL,
      resources: ["/project/plugins/lib"],
      metadata: { runner: "path", compress: true },
    })
    expect(seen[0]?.[0]).toBe("/bin/repomix")
    expect(seen[0]?.at(-1)).toBe("/project/plugins/lib")

    const remote = await pack({ remote: "yamadashy/repomix", ref: "v1.17.0" }, context)
    expect(remote.metadata.ok).toBe(true)
    expect(fake.asserts[1]?.resources).toEqual(["yamadashy/repomix@v1.17.0"])
    expect(seen[1]?.slice(-2)).toEqual(["--remote=yamadashy/repomix", "--remote-branch=v1.17.0"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("refusals return before any permission prompt or run", async () => {
  const seen: string[][] = []
  const fake = createFakeContext({ directory: "/project" })
  await createPlugin({ exec: fakeRepomix(seen), which: () => "/bin/repomix", isDirectory: () => false }).setup(fake.context)
  const pack = fake.tools.get(PACK_TOOL)?.execute as Execute
  const missing = await pack({ directory: "nope" }, context)
  expect(missing).toMatchObject({ metadata: { ok: false } })
  expect(missing.content).toContain("/project/nope is not a directory")
  expect((await pack({ remote: "--remote-trust-config" }, context)).metadata.ok).toBe(false)
  expect((await pack({ directory: ".", remote: "o/r" }, context)).metadata.ok).toBe(false)
  expect(fake.asserts).toHaveLength(0)
  expect(seen).toHaveLength(0)
})

test("the npx fallback is flagged for the prompt, and a rejection stops the run", async () => {
  const seen: string[][] = []
  const refused = createFakeContext({
    assert: () => {
      throw new Error("rejected")
    },
  })
  await createPlugin({ exec: fakeRepomix(seen), which: () => null }).setup(refused.context)
  const pack = refused.tools.get(PACK_TOOL)?.execute as Execute
  await expect(pack({ remote: "o/r" }, context)).rejects.toThrow("rejected")
  expect(refused.asserts[0]?.metadata).toMatchObject({ runner: "npx" })
  expect(seen).toHaveLength(0)

  const evaluation = await refused.fire.permission("evaluate", {
    sessionID: "ses_1",
    action: PACK_TOOL,
    resources: ["o/r"],
    metadata: { runner: "npx" },
    effect: "allow",
  } as { effect: string; message?: string })
  expect(evaluation.effect).toBe("ask")
  expect(evaluation.message).toContain(`npx --yes repomix@${REPOMIX_VERSION}`)
})
