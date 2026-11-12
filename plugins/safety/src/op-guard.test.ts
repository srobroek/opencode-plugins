import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { type GuardOptions, hardGate } from "./guards.ts"
import { createPlugin, readOptions } from "./index.ts"
import {
  CHECK_FAILED_MESSAGE,
  FNOX_DUMP_MESSAGE,
  FNOX_SET_MESSAGE,
  LITERAL_MESSAGE,
  MAX_NESTING, NESTING_MESSAGE, OP_MESSAGE } from "./op-guard.ts"

const gate = (command: string, options: GuardOptions = {}) => hardGate(command, "/", options)

const REFUSED_OP = [
  "op read op://x/y/z",
  "op item get x",
  "op.exe read op://x",
  "/usr/local/bin/op read op://x",
  "bash -lc 'op read op://x'",
  "sh -c \"echo hi; op read op://x\"",
  "eval 'op read op://x'",
  "echo op://x | xargs op read",
  "xargs op read",
  "FOO=$(op read op://x) cmd",
  "env A=1 op item get x",
  "sudo op read op://x",
  "command op read op://x",
  "for i in 1 2; do op read $i; done",
  "if true; then op read x; else op signin; fi",
  "op vault list",
  "op vault delete x",
  "op vault edit x",
  "op vault create",
  "fnox exec -- op read x",
  "fnox exec -- bash -c 'op read x'",
  "fnox exec -- bash <<'EOF'\nop read op://x\nEOF",
  "fnox exec -- sh <<EOF\nenv A=1 op item get x\nEOF",
  "fnox exec -- env bash <<'EOF'\nop read x\nEOF",
  "fnox exec -- timeout 5 sh <<'EOF'\nop read x\nEOF",
  "fnox exec -- fnox exec -- bash <<'EOF'\nop read x\nEOF",
  "fnox exec -- sudo -u x env bash -s <<'EOF'\nop read x\nEOF",
]

const REFUSED_LITERAL = [
  "op item create --title t foo=bar",
  "op item create --title t 'f[password]=bar'",
  "op item create --title t 'f[concealed]=bar'",
  "op item create --title t password=hunter2",
  "op item create --title t credential=abc",
  "op item create --title t 'credential=$TOKEN'",
  "op item edit x password=hunter2",
  "op item edit x 'f[password]=abc'",
  "op item create --title t 'sec.f=abc'",
  "op item create --title t 'f[otp]=abc'",
  "op item create --title t 'url=https://x' password=abc",
  "op item create --title t <<< x",
  "op item create --title t - <<< '{\"password\":\"x\"}'",
  "op item create - <<'EOF'\n{\"password\":\"x\"}\nEOF",
  "op item create - <<EOF\n{\"password\":\"x\"}\nEOF",
  "fnox exec -- op item create - <<'EOF'\n{\"password\":\"x\"}\nEOF",
  "fnox exec -- fnox exec -- op item create - <<EOF\n{}\nEOF",
  "fnox exec -- op item create --title t password=abc",
  "bash -c 'op item edit x password=abc'",
]

const REFUSED_REVEAL = [
  "op item create --title t --reveal",
  "op item edit x --reveal",
  "op item edit x --reveal=true",
  "fnox exec -- op item edit x --reveal",
  "op item create - --reveal < t.json",
]

const REFUSED_SET = [
  "fnox set NAME hunter2 --provider host",
  "fnox set NAME hunter2 -p host",
  "fnox set NAME hunter2 -phost",
  "fnox set NAME hunter2 --provider=host",
  "fnox set NAME hunter2 --provider age",
  "fnox set NAME hunter2 --provider team-age",
  "fnox set NAME hunter2 --provider keychain",
  "fnox set NAME --provider host hunter2",
  "fnox -P prod set NAME hunter2 --provider host",
  "fnox set NAME 'a b' --provider host -d desc",
  "fnox exec -- fnox set NAME hunter2 --provider host",
  "bash -c 'fnox set NAME hunter2 --provider host'",
]

const REFUSED_DUMP = [
  "fnox get NAME",
  "fnox export",
  "fnox env",
  "fnox -P prod get NAME",
  "fnox list --values",
  "fnox ls -V",
  "fnox list -fV",
  "fnox secrets --values",
  "fnox exec -- env",
  "fnox exec -- printenv",
  "fnox exec --only A -- printenv A",
  "fnox exec -- export -p",
  "fnox exec -- set",
  "fnox exec -- declare -x",
  "fnox exec -- sh -c 'env'",
  "bash -c 'fnox get X'",
  "fnox exec -- timeout 5 env",
  "fnox exec -- sudo -u x env",
  "fnox exec -- env -i env",
  "fnox exec -- env A=1 timeout 5 env",
  "fnox exec -- sudo -u x printenv",
  "fnox exec -- bash <<'EOF'\nenv\nEOF",
  "fnox exec -- sh -c 'timeout 5 env'",
  "fnox exec -- bash -c set",
  "fnox exec -- env bash <<'EOF'\nenv\nEOF",
  "fnox exec -- fnox exec -- bash <<'EOF'\nprintenv\nEOF",
]

const PASSED = [
  // item writes: values from stdin, a template, a generator, an expansion or a plain typed field
  "op item create --title t - < t.json",
  "op item create --vault v - < t.json",
  "cat t.json | op item create -",
  "cat t.json | op item create --vault V",
  "jq -n --arg v \"$(openssl rand -hex 32)\" '{title:$v}' | op item create --vault V -",
  "op item create --template t.json --vault v",
  "op item create --template=t.json",
  "op item edit x --template t.json",
  "op item create --title t --generate-password",
  "op item create --title t --generate-password=letters,digits,32",
  "op item edit x --generate-password",
  "op item create --title t \"credential=$TOKEN\"",
  "op item create --title t \"password=$(cmd)\"",
  "op item edit x \"f[password]=$(cmd)\"",
  "op item create --title t 'host[text]=db.example.com'",
  "op item create --title t 'site[url]=https://x.example'",
  "op item create --title t 'mail[email]=a@b.c'",
  "op item create --title t 'd[date]=2026-01-01' 'm[monthYear]=202601' 'p[phone]=555'",
  "op item create --title t username=alice url=https://x notesPlain=hello",
  "op item edit x username=alice",
  "op item create --title 'a=b' --url 'https://x?a=b' --vault v",
  "op item create --title t > out.json",
  "op item create --title t - < t.json > out.json 2>/dev/null",
  "fnox exec -- op item create --title t - < t.json",
  "cat t.json | fnox exec -- op item create -",
  "fnox exec -- fnox exec -- op item create --title t \"password=$X\"",
  "fnox exec -- bash <<'EOF'\nop item create --title t --generate-password\nEOF",
  // fnox set
  "fnox set NAME --provider host",
  "printf '%s' \"$TOKEN\" | fnox set NAME --provider host",
  "cmd | fnox set NAME -p host",
  "fnox set NAME --provider host --generate",
  "fnox set NAME --generate --length 48 --provider age",
  "fnox set NAME \"$TOKEN\" --provider host",
  "fnox set NAME \"$(cmd)\" --provider host",
  "fnox set NAME --from-file key.txt --provider host",
  "fnox set NAME 'item/field' --provider proj",
  "fnox set NAME 'item/field' --provider op",
  "fnox set NAME hunter2",
  "fnox set NAME hunter2 --provider other",
  "fnox set NAME hunter2 --provider team",
  "echo \"op read\"",
  "grep 'op read' f",
  "git commit -m \"op read\"",
  "echo op read op://x",
  "op whoami",
  "op --version",
  "op --help",
  "op item get --help",
  "op read --help",
  "op item create --title t",
  "op item create --vault v --title t --category login",
  "op vault create proj",
  "op vault create --help",
  "op vault list --help",
  "fnox exec -- cmd",
  "fnox exec --only NAME -- cmd",
  "fnox exec -- env FOO=1 cmd",
  "fnox exec -- sh -c 'set -e; bun test'",
  "fnox exec -- sh -c 'set -o pipefail; bun test'",
  "fnox exec -- sh -c 'set -- a b; echo $#'",
  "fnox exec -- timeout 5 cmd",
  "fnox exec -- sudo -u x cmd",
  "fnox exec -- bash <<'EOF'\necho hi\nEOF",
  "fnox exec -- op item create --title t > out.json",
  "op item create --title t > out.json",
  "op item create --title t 2>/dev/null",
  "op item create --title t >\\\nout.json",
  "fnox exec -- env bash <<'EOF'\necho hi\nEOF",
  "op item create --title t --format json >out.json 2>&1",
  "fnox check",
  "fnox list",
  "fnox ls --sources",
  "fnox set NAME",
  "fnox sync",
  "fnox doctor",
  "fnox daemon status",
  "fnox daemon start",
  "fnox provider discover op --tags project/x",
]

describe("op-guard", () => {
  for (const command of REFUSED_OP)
    test(`refuses ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: OP_MESSAGE })
    })
  for (const command of REFUSED_LITERAL)
    test(`refuses literal ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: LITERAL_MESSAGE })
    })
  for (const command of REFUSED_REVEAL)
    test(`refuses reveal ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: OP_MESSAGE })
    })
  for (const command of REFUSED_SET)
    test(`refuses fnox set ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: FNOX_SET_MESSAGE })
    })
  for (const command of REFUSED_DUMP)
    test(`refuses dump ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: FNOX_DUMP_MESSAGE })
    })
  for (const command of PASSED)
    test(`passes ${command}`, () => {
      expect(gate(command)).toBeUndefined()
    })

  test("the refusal points to fnox exec and provider discover", () => {
    expect(OP_MESSAGE).toContain("fnox exec -- <cmd>")
    expect(OP_MESSAGE).toContain("fnox provider discover <provider> --tags project/<name>")
  })

  test("opAllow adds subcommand prefixes", () => {
    expect(gate("op vault list")).toBeDefined()
    expect(gate("op vault list --format json", { opAllow: ["vault list"] })).toBeUndefined()
    expect(gate("op vault get x", { opAllow: ["vault list"] })).toBeDefined()
    expect(gate("op item get x", { opAllow: ["vault list"] })).toBeDefined()
  })

  test("disabling the guard lets op through", () => {
    expect(gate("op read x", { disabled: new Set(["op-guard"]) })).toBeUndefined()
  })

  test("readOptions reads disable and opAllow", () => {
    const options = readOptions({ disable: ["op-guard"], opAllow: ["vault list", 3] })
    expect(options.disabled.has("op-guard")).toBe(true)
    expect(options.opAllow).toEqual(["vault list"])
  })
})

setDefaultTimeout(60_000)

const CYCLE = (tail: string) => `fnox exec -- bash <<'EOF'\nfnox exec -- bash\n${tail}\nEOF`
const NESTED = (levels: number) => `${"fnox exec -- ".repeat(levels)}true`

/** Run `command` through the plugin's execute.before hook. */
async function throughHook(command: string, guard: GuardOptions = {}): Promise<unknown> {
  const fake = createFakeContext({
    directory: "/project",
    sessions: [{ id: "ses_1", location: { directory: "/project" } }],
    options: {},
  })
  await createPlugin({
    review: { gh: async () => "[]", timeoutMs: 30_000, budgetMs: 120_000 },
    env: {},
    guard,
  }).setup(fake.context)
  try {
    await fake.fire.tool("execute.before", {
      sessionID: "ses_1",
      agent: "build",
      messageID: "msg_1",
      id: "c1",
      tool: "shell",
      input: { command },
    })
    return "allowed"
  } catch (error) {
    return error instanceof ToolError || error instanceof Error ? error.message : String(error)
  }
}

describe("op-guard cycles, depth and failure", () => {
  const throwing: GuardOptions = {
    analyzeOp: () => {
      throw new Error("boom")
    },
  }

  test("a parsed here-document is not handed to its own body", () => {
    expect(gate(CYCLE("op read x"))?.reason).toBe(OP_MESSAGE)
    expect(gate(CYCLE("env"))?.reason).toBe(FNOX_DUMP_MESSAGE)
    expect(gate(CYCLE("echo hi"))).toBeUndefined()
  })

  test("the cyclic document is refused through the hook", async () => {
    expect(await throughHook(CYCLE("op read x"))).toContain("do not call the 1Password CLI")
    expect(await throughHook(CYCLE("env"))).toContain("prints secret values")
    expect(await throughHook(CYCLE("echo hi"))).toBe("allowed")
  })

  test("nesting past the limit is refused", async () => {
    expect(gate(NESTED(MAX_NESTING - 2))).toBeUndefined()
    expect(gate(NESTED(MAX_NESTING + 4))?.reason).toBe(NESTING_MESSAGE)
    expect(await throughHook(NESTED(MAX_NESTING + 4))).toContain("nesting is too deep")
    expect(await throughHook(NESTED(2))).toBe("allowed")
  })

  test("an op call past the walk's 8-level sh -c limit is refused", async () => {
    const deep = (levels: number, inner: string): string =>
      levels === 0 ? inner : `sh -c '${deep(levels - 1, inner).replaceAll("'", "'\\''")}'`
    expect(gate(deep(9, "op read x"))?.reason).toBe(NESTING_MESSAGE)
    expect(gate(deep(9, "fnox get X"))?.reason).toBe(NESTING_MESSAGE)
    expect(gate(deep(9, "echo hi"))).toBeUndefined()
    expect(gate(deep(3, "op read x"))?.reason).toBe(OP_MESSAGE)
    expect(await throughHook(deep(9, "op read x"))).toContain("nesting is too deep")
    expect(await throughHook(deep(9, "echo hi"))).toBe("allowed")
  })

  test("op-guard fails closed when its analysis throws", async () => {
    expect(gate("echo hi", throwing)).toEqual({ guard: "op-guard", reason: CHECK_FAILED_MESSAGE })
    expect(await throughHook("echo hi", throwing)).toContain("could not check this command")
    expect(gate("echo hi", { ...throwing, disabled: new Set(["op-guard"]) })).toBeUndefined()
  })

  test("the other gates still fail open", async () => {
    const read: GuardOptions = {
      read: () => {
        throw new Error("boom")
      },
    }
    expect(() => gate("git commit -F msg.txt", read)).toThrow("boom")
    expect(await throughHook("git commit -F msg.txt", read)).toBe("allowed")
  })
})
