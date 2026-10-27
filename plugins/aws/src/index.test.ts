import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

const root = mkdtempSync(join(tmpdir(), "aws-plugin-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function project(name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

test("registers aws-guidance and no servers outside an AWS project", async () => {
  const fake = createFakeContext({ directory: project("plain") })
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(["aws-guidance"])
  expect(fake.mcp.size).toBe(0)
  expect(fake.active()).toBe(1)
  await cleanup?.()
  expect(fake.active()).toBe(0)
})

test("adds both pinned servers in an AWS project and removes them on cleanup", async () => {
  const fake = createFakeContext({ directory: project("cdk", { "cdk.json": "{}" }) })
  const cleanup = await plugin.setup(fake.context)
  expect(fake.mcp.get("aws-mcp")).toEqual({
    type: "local",
    command: ["uvx", "mcp-proxy-for-aws-cli@1.7.0", "https://aws-mcp.us-east-1.api.aws/mcp", "--read-only", "--skip-auth"],
    codemode: true,
    timeout: { startup: 120000, execution: 100000 },
  })
  expect(fake.mcp.get("aws-pricing")).toMatchObject({
    command: ["uvx", "--with", "botocore[crt]", "awslabs.aws-pricing-mcp-server@1.1.1"],
    environment: { AWS_REGION: "us-east-1", FASTMCP_LOG_LEVEL: "ERROR" },
  })
  await cleanup?.()
  expect(fake.mcp.size).toBe(0)
})

test("mcp always adds the servers anywhere; mcpServers drops one", async () => {
  const fake = createFakeContext({
    directory: project("plain"),
    options: { mcp: "always", mcpServers: { "aws-pricing": false } },
  })
  await plugin.setup(fake.context)
  expect([...fake.mcp.keys()]).toEqual(["aws-mcp"])
})

test("no shipped server version is unpinned", async () => {
  const text = await Bun.file(new URL("../.mcp.json", import.meta.url)).text()
  expect(text).not.toContain("@latest")
})
