import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { CONTEXT7_URL, OPENAI_DOCS_URL, setupDocs } from "./index.ts"

test("adds context7 in every project and disposes it", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect(fake.mcp.get("context7")).toMatchObject({ type: "remote", url: CONTEXT7_URL, oauth: false, codemode: true })
  expect(fake.mcp.has("openaiDeveloperDocs")).toBe(false)
  await cleanup?.()
  expect(fake.mcp.size).toBe(0)
  expect(fake.active()).toBe(0)
})

test("sends the Context7 key only when it is set", async () => {
  const without = createFakeContext()
  await setupDocs(without.context, {})
  expect(without.mcp.get("context7")?.headers).toBeUndefined()
  const withKey = createFakeContext()
  await setupDocs(withKey.context, { CONTEXT7_API_KEY: "ctx7sk" })
  expect(withKey.mcp.get("context7")?.headers).toEqual({ CONTEXT7_API_KEY: "ctx7sk" })
})

test("mcpServers turns the OpenAI docs on and context7 off", async () => {
  const fake = createFakeContext({ options: { mcpServers: { openaiDeveloperDocs: true, context7: false } } })
  await setupDocs(fake.context, {})
  expect([...fake.mcp.keys()]).toEqual(["openaiDeveloperDocs"])
  expect(fake.mcp.get("openaiDeveloperDocs")).toMatchObject({ url: OPENAI_DOCS_URL })
})

test("a configured server wins and mcp off adds nothing", async () => {
  const mine = { type: "remote", url: "https://mine.example/mcp" }
  const configured = createFakeContext({ mcp: { context7: mine } })
  await setupDocs(configured.context, {})
  expect(configured.mcp.get("context7")).toEqual(mine)
  const off = createFakeContext({ options: { mcp: "off" } })
  await setupDocs(off.context, {})
  expect(off.mcp.size).toBe(0)
  expect(off.active()).toBe(0)
})
