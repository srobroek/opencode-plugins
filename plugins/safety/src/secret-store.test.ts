import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  type Charset,
  commandSecret,
  generateSecret,
  itemTemplate,
  type OnePasswordTarget,
  parseRequest,
  type RunOptions,
  type RunResult,
  runChild,
  STDOUT_CAP,
  type StoreDeps,
  storeSecret,
} from "./secret-store.ts"

/** A dummy value that must never leave the child's stdin. */
const SENTINEL = "SENTINEL-dummy-6ks-not-a-secret"
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const ALPHABETS: Record<Charset, string> = {
  hex: "0123456789abcdef",
  base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  alnum: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  "ascii-printable": Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).join(""),
}

describe("generateSecret", () => {
  for (const [charset, alphabet] of Object.entries(ALPHABETS) as [Charset, string][])
    test(`${charset} draws ${alphabet.length} symbols only`, () => {
      const value = decoder.decode(generateSecret(charset, 4096))
      expect(value).toHaveLength(4096)
      expect([...value].every((c) => alphabet.includes(c))).toBe(true)
      // 4096 draws from at most 94 symbols use nearly all of them.
      expect(new Set(value).size).toBeGreaterThan(alphabet.length * 0.9)
    })

  test("rejects random bytes past the largest multiple of the alphabet size", () => {
    // alnum has 62 symbols, so bytes 248..255 are rejected; 0 -> 'A', 61 -> '9', 247 -> 247 % 62 = 61 -> '9'.
    const stream = [255, 248, 0, 61, 247]
    const random = (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = stream.shift() ?? 0
    }
    expect(decoder.decode(generateSecret("alnum", 3, random))).toBe("A99")
  })
})

describe("parseRequest", () => {
  const base = { name: "API_TOKEN", target: { kind: "fnox-store", provider: "host" } }

  for (const [label, spec, length] of [
    ["hex bytes 16", { charset: "hex", bytes: 16 }, 32],
    ["base64url bytes 32", { charset: "base64url", bytes: 32 }, 43],
    ["alnum bytes 16", { charset: "alnum", bytes: 16 }, 22],
    ["ascii-printable bytes 16", { charset: "ascii-printable", bytes: 16 }, 20],
    ["alnum length 40", { charset: "alnum", length: 40 }, 40],
  ] as const)
    test(`generate ${label} gives ${length} characters`, () => {
      const request = parseRequest({ ...base, generate: spec })
      expect(request.source).toEqual({ kind: "generate", charset: spec.charset, length })
    })

  for (const [label, input] of [
    ["a lowercase name", { ...base, name: "api_token", generate: { charset: "hex", bytes: 16 } }],
    ["a name with a leading digit", { ...base, name: "1TOKEN", generate: { charset: "hex", bytes: 16 } }],
    ["less than 128 bits", { ...base, generate: { charset: "alnum", length: 21 } }],
    ["fewer than 16 bytes", { ...base, generate: { charset: "hex", bytes: 15 } }],
    ["both bytes and length", { ...base, generate: { charset: "hex", bytes: 16, length: 32 } }],
    ["an unknown charset", { ...base, generate: { charset: "base32", length: 64 } }],
    ["both generate and command", { ...base, generate: { charset: "hex", bytes: 16 }, command: { argv: ["gh", "auth", "token"] } }],
    ["neither generate nor command", { ...base }],
    ["an empty argv", { ...base, command: { argv: [] } }],
    ["an item with a slash", { name: "A", target: { kind: "1password", vault: "V", item: "a/b" }, generate: { charset: "hex", bytes: 16 } }],
    ["an unknown target kind", { name: "A", target: { kind: "plain", provider: "p" }, generate: { charset: "hex", bytes: 16 } }],
    ["an unknown field", { ...base, generate: { charset: "hex", bytes: 16 }, value: "x" }],
  ] as const)
    test(`refuses ${label}`, () => {
      expect(() => parseRequest(input)).toThrow()
    })
})

describe("commandSecret", () => {
  for (const [label, stdout, expected] of [
    ["one trailing newline", "abc\n", "abc"],
    ["only one of two trailing newlines", "abc\n\n", "abc\n"],
    ["a CRLF ending", "abc\r\n", "abc"],
    ["no newline", "abc", "abc"],
    ["multi-byte text", "pä🔑\n", "pä🔑"],
    ["inner newlines", "-----BEGIN-----\nx\n-----END-----\n", "-----BEGIN-----\nx\n-----END-----"],
  ] as const)
    test(`keeps the value with ${label}`, () => {
      expect(decoder.decode(commandSecret(encoder.encode(stdout)))).toBe(expected)
    })

  for (const [label, bytes] of [
    ["empty output", encoder.encode("\n")],
    ["a NUL byte", encoder.encode("a\0b")],
    ["invalid UTF-8", new Uint8Array([0x61, 0xc3, 0x28])],
    ["an encoded surrogate", new Uint8Array([0xed, 0xa0, 0x80])],
  ] as const)
    test(`refuses ${label}`, () => {
      expect(() => commandSecret(bytes)).toThrow()
    })
})

describe("itemTemplate", () => {
  test("builds the item JSON with the value as a concealed field, escaped", () => {
    const target: OnePasswordTarget = { kind: "1password", vault: "V", item: "proj api", field: "credential", tags: ["project/proj"] }
    const value = 'dummy"quote\\slash\nline\u0001'
    expect(JSON.parse(decoder.decode(itemTemplate(target, encoder.encode(value))))).toEqual({
      title: "proj api",
      category: "API_CREDENTIAL",
      tags: ["project/proj"],
      fields: [{ id: "credential", label: "credential", type: "CONCEALED", value }],
    })
  })
})

type Call = { argv: string[]; options: RunOptions; stdin?: Uint8Array; stdinCopy?: string }

/** Fake deps: every child run is recorded; `results` answers by argv[0]. */
function fake(overrides: Partial<StoreDeps> = {}, results: Record<string, (call: Call) => RunResult> = {}) {
  const calls: Call[] = []
  const asks: { kind: string; argv?: string[]; cwd?: string }[] = []
  const deps: StoreDeps = {
    directory: "/project",
    env: { PATH: "/bin", HOME: "/home/u" },
    which: (bin) => `/bin/${bin}`,
    providerType: (name) => ({ host: "age", op: "1password", plain: "plain" })[name],
    providersOfType: (type) => (type === "1password" ? ["op"] : []),
    providerVault: (name) => (name === "op" ? "Dev" : undefined),
    askStore: async () => void asks.push({ kind: "store" }),
    askCommand: async (argv, cwd) => void asks.push({ kind: "command", argv, cwd }),
    run: async (argv, options) => {
      const call: Call = {
        argv,
        options,
        ...(options.stdin ? { stdin: options.stdin, stdinCopy: decoder.decode(options.stdin) } : {}),
      }
      calls.push(call)
      const answer = results[argv[0] as string]
      return answer ? answer(call) : { kind: "exited", exitCode: 0 }
    },
    ...overrides,
  }
  return { deps, calls, asks }
}

const issued = (stdout: string): ((call: Call) => RunResult) => () => ({ kind: "exited", exitCode: 0, stdout: encoder.encode(stdout) })
const onePassword = { kind: "1password", vault: "Dev", item: "proj api", tags: ["project/proj"] }
const hex = { charset: "hex", bytes: 16 }

describe("storeSecret into 1Password", () => {
  test("creates the item from stdin JSON, then records the reference with the 1Password provider", async () => {
    const { deps, calls } = fake({ random: (bytes) => bytes.fill(0) })
    const result = await storeSecret({ name: "API_TOKEN", target: onePassword, generate: hex }, deps)
    expect(result).toEqual({ name: "API_TOKEN", reference: "proj api/credential", stored: true })
    expect(calls.map((call) => call.argv)).toEqual([
      ["/bin/op", "item", "create", "--vault=Dev", "-"],
      ["/bin/fnox", "set", "--provider=op", "--", "API_TOKEN", "proj api/credential"],
    ])
    const item = JSON.parse(calls[0]?.stdinCopy ?? "")
    expect(item.fields[0]).toMatchObject({ id: "credential", type: "CONCEALED", value: "0".repeat(32) })
    expect(calls[1]?.options.stdin).toBeUndefined()
  })

  test("passes a description and an explicit config to fnox, and resolves a bare config name like the searched ones", async () => {
    const seen: (string | undefined)[] = []
    const { deps, calls } = fake({
      providersOfType: (_, config) => {
        seen.push(config)
        return ["op"]
      },
    })
    await storeSecret({ name: "A", target: onePassword, generate: hex, description: "proj api", config: "fnox.local.toml" }, deps)
    await storeSecret({ name: "B", target: onePassword, generate: hex, config: "custom.toml" }, deps)
    expect(seen).toEqual([undefined, "custom.toml"])
    expect(calls[1]?.argv).toEqual(["/bin/fnox", "--config=fnox.local.toml", "set", "--provider=op", "--description=proj api", "--", "A", "proj api/credential"])
  })

  for (const [label, providers, target] of [
    ["no 1Password provider", [], onePassword],
    ["two 1Password providers", ["op", "shared"], onePassword],
    ["an unreadable config", undefined, onePassword],
    ["a named provider that is not 1Password", ["op"], { ...onePassword, provider: "host" }],
  ] as const)
    test(`fails closed on ${label}, before anything runs`, async () => {
      const { deps, calls, asks } = fake({ providersOfType: () => (providers === undefined ? undefined : [...providers]) })
      await expect(storeSecret({ name: "A", target, generate: hex }, deps)).rejects.toThrow(/provider/)
      expect(calls).toEqual([])
      expect(asks).toEqual([])
    })

  test("stops on an op failure or timeout with the name and no retry", async () => {
    for (const answer of [{ kind: "exited", exitCode: 1 }, { kind: "timeout" }] as RunResult[]) {
      const { deps, calls } = fake({}, { "/bin/op": () => answer })
      const error = await storeSecret({ name: "API_TOKEN", target: onePassword, generate: hex }, deps).catch((e: Error) => e)
      expect(String(error)).toContain("API_TOKEN")
      expect(String(error)).toContain("not retried")
      expect(calls).toHaveLength(1)
    }
  })

  test("a fnox failure after the item exists names the reference command to finish with", async () => {
    const { deps } = fake({}, { "/bin/fnox": () => ({ kind: "exited", exitCode: 2 }) })
    await expect(storeSecret({ name: "A", target: onePassword, generate: hex }, deps)).rejects.toThrow(
      "fnox set A 'proj api/credential' --provider op",
    )
  })

  test("checks that op and fnox are on PATH before anything runs", async () => {
    for (const missing of ["op", "fnox"]) {
      const { deps, calls } = fake({ which: (bin) => (bin === missing ? null : `/bin/${bin}`) })
      await expect(storeSecret({ name: "A", target: onePassword, generate: hex }, deps)).rejects.toThrow(`${missing} is not on PATH`)
      expect(calls).toEqual([])
    }
  })
})

describe("storeSecret configuration checks", () => {
  for (const [label, vault, reference] of [
    ["the provider's own vault", "Dev", "proj api/credential"],
    ["another vault", "Other", "op://Other/proj api/credential"],
  ] as const)
    test(`records a reference into ${label} that resolves in the vault the item went to`, async () => {
      const { deps, calls } = fake()
      const result = await storeSecret({ name: "A", target: { ...onePassword, vault }, generate: hex }, deps)
      expect(result).toMatchObject({ reference })
      expect(calls[1]?.argv.at(-1)).toBe(reference)
    })

  test("records a full op:// reference when the provider's vault is uncertain", async () => {
    const { deps } = fake({ providerVault: () => undefined })
    expect(await storeSecret({ name: "A", target: onePassword, generate: hex }, deps)).toMatchObject({
      reference: "op://Dev/proj api/credential",
    })
  })

  for (const [label, env] of [
    ["FNOX_CONFIG_DIR", { FNOX_CONFIG_DIR: "/elsewhere" }],
    ["FNOX_CONFIG", { FNOX_CONFIG: "/elsewhere/fnox.toml" }],
    ["an XDG_CONFIG_HOME other than ~/.config", { XDG_CONFIG_HOME: "/elsewhere" }],
  ] as const)
    test(`fails closed when ${label} could point fnox at a config the check did not read`, async () => {
      const { deps, calls, asks } = fake({ env: { PATH: "/bin", HOME: "/home/u", ...env }, home: "/home/u" })
      await expect(storeSecret({ name: "A", target: { kind: "fnox-store", provider: "host" }, generate: hex }, deps)).rejects.toThrow(/config/)
      expect([calls, asks]).toEqual([[], []])
    })

  test("an XDG_CONFIG_HOME of ~/.config is the config the check read", async () => {
    const { deps } = fake({ env: { PATH: "/bin", XDG_CONFIG_HOME: "/home/u/.config" }, home: "/home/u" })
    await expect(storeSecret({ name: "A", target: { kind: "fnox-store", provider: "host" }, generate: hex }, deps)).resolves.toMatchObject({ stored: true })
  })

  test("refuses a vault with a slash, which would break an op:// reference", () => {
    expect(() => parseRequest({ name: "A", target: { ...onePassword, vault: "a/b" }, generate: hex })).toThrow()
  })
})

describe("storeSecret into a fnox store", () => {
  for (const [label, stdout] of [
    ["a leading no-break space", "\u00a0dummy\n"],
    ["a trailing ideographic space", "dummy\u3000\n"],
    ["a trailing line separator", "dummy\u2028\n"],
  ] as const)
    test(`refuses a command value with ${label}, which fnox would trim`, async () => {
      const { deps } = fake({}, { "/bin/gh": issued(stdout) })
      await expect(storeSecret({ name: "A", target: { kind: "fnox-store", provider: "host" }, command: { argv: ["gh"] } }, deps)).rejects.toThrow(/whitespace/)
    })
  test("pipes the value on stdin to fnox set for a value-store provider", async () => {
    const { deps, calls } = fake({}, { "/bin/gh": issued(`${SENTINEL}\n`) })
    const result = await storeSecret({ name: "GH_TOKEN", target: { kind: "fnox-store", provider: "host" }, command: { argv: ["gh", "auth", "token"] } }, deps)
    expect(result).toEqual({ name: "GH_TOKEN", provider: "host", stored: true })
    expect(calls[1]?.argv).toEqual(["/bin/fnox", "set", "--provider=host", "--", "GH_TOKEN"])
    expect(calls[1]?.stdinCopy).toBe(SENTINEL)
  })

  for (const [label, provider] of [
    ["a 1Password provider", "op"],
    ["a plain provider", "plain"],
    ["an unknown provider", "nope"],
  ] as const)
    test(`fails closed on ${label}`, async () => {
      const { deps, calls } = fake()
      await expect(storeSecret({ name: "A", target: { kind: "fnox-store", provider }, generate: hex }, deps)).rejects.toThrow(/value store/)
      expect(calls).toEqual([])
    })

  test("refuses a command value with surrounding whitespace, which fnox would trim", async () => {
    const { deps, calls } = fake({}, { "/bin/gh": issued(` ${SENTINEL}\n`) })
    await expect(storeSecret({ name: "A", target: { kind: "fnox-store", provider: "host" }, command: { argv: ["gh"] } }, deps)).rejects.toThrow(/whitespace/)
    expect(calls).toHaveLength(1)
  })
})

describe("the command source", () => {
  const request = { name: "A", target: onePassword, command: { argv: ["gh", "auth", "token"], cwd: "sub" } }

  test("asks the user with argv and cwd, then runs argv as given with no shell and a capped stdout", async () => {
    const { deps, calls, asks } = fake({}, { "/bin/gh": issued(`${SENTINEL}\n`) })
    await storeSecret(request, deps)
    expect(asks).toEqual([{ kind: "store" }, { kind: "command", argv: ["gh", "auth", "token"], cwd: "/project/sub" }])
    expect(calls[0]?.argv).toEqual(["/bin/gh", "auth", "token"])
    expect(calls[0]?.options).toMatchObject({ cwd: "/project/sub", capture: STDOUT_CAP })
  })

  test("a denied prompt runs nothing", async () => {
    const { deps, calls } = fake({ askCommand: async () => Promise.reject(new Error("denied")) })
    await expect(storeSecret(request, deps)).rejects.toThrow("denied")
    expect(calls).toEqual([])
  })

  for (const [label, answer, message] of [
    ["a non-zero exit", { kind: "exited", exitCode: 3, stdout: encoder.encode(SENTINEL) }, "exit 3"],
    ["output past the cap", { kind: "overflow" }, "64 KiB"],
    ["a timeout", { kind: "timeout" }, "timed out"],
  ] as const)
    test(`fails on ${label} with the stage only and stores nothing`, async () => {
      const { deps, calls } = fake({}, { "/bin/gh": () => answer as RunResult })
      const error = String(await storeSecret(request, deps).catch((e: Error) => e))
      expect(error).toContain(message)
      expect(error).not.toContain(SENTINEL)
      expect(calls).toHaveLength(1)
    })

  test("a command not on PATH runs nothing", async () => {
    const { deps, calls } = fake({ which: (bin) => (bin === "gh" ? null : `/bin/${bin}`) })
    await expect(storeSecret(request, deps)).rejects.toThrow("gh is not on PATH")
    expect(calls).toEqual([])
  })
})

describe("the value stays out of argv, env, the result, errors and logs", () => {
  const logged: string[] = []
  const spies: ReturnType<typeof spyOn>[] = []
  beforeEach(() => {
    logged.length = 0
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      spies.push(spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))))
  })
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  const leaks = (calls: Call[], extra: unknown[]) =>
    [...calls.flatMap((call) => [...call.argv, ...Object.values(call.options.env), call.options.cwd]), ...extra.map((e) => JSON.stringify(e) ?? String(e)), ...logged].filter(
      (text) => String(text).includes(SENTINEL),
    )

  for (const target of [onePassword, { kind: "fnox-store", provider: "host" }])
    test(`only the store's stdin carries it (${target.kind})`, async () => {
      const { deps, calls } = fake({}, { "/bin/gh": issued(`${SENTINEL}\n`) })
      const result = await storeSecret({ name: "A", target, command: { argv: ["gh"] } }, deps)
      expect(leaks(calls, [result])).toEqual([])
      expect(calls.filter((call) => call.stdinCopy?.includes(SENTINEL))).toHaveLength(1)
    })

  test("a failing store reports no value", async () => {
    const { deps, calls } = fake({}, { "/bin/gh": issued(`${SENTINEL}\n`), "/bin/op": () => ({ kind: "exited", exitCode: 1 }) })
    const error = await storeSecret({ name: "A", target: onePassword, command: { argv: ["gh"] } }, deps).catch((e: Error) => e)
    expect(leaks(calls, [String(error), (error as Error).stack])).toEqual([])
  })

  test("the stdin buffers are zeroed once the store is done", async () => {
    const { deps, calls } = fake({}, { "/bin/gh": issued(`${SENTINEL}\n`) })
    await storeSecret({ name: "A", target: onePassword, command: { argv: ["gh"] } }, deps)
    const stdin = calls.flatMap((call) => (call.stdin ? [call.stdin] : []))
    expect(stdin).toHaveLength(1)
    expect(stdin.every((bytes) => bytes.every((b) => b === 0))).toBe(true)
  })
})

describe("runChild", () => {
  const bun = process.execPath
  const options = (more: Partial<RunOptions> = {}): RunOptions => ({ cwd: process.cwd(), env: { ...process.env } as Record<string, string>, timeoutMs: 10_000, ...more })

  test("passes argv as words, with no shell to expand them", async () => {
    const result = await runChild([bun, "-e", "process.stdout.write(process.argv.at(-1))", "$(echo hi);x"], options({ capture: 1024 }))
    expect(result.kind === "exited" && decoder.decode(result.stdout)).toBe("$(echo hi);x")
  })

  test("reports the exit code", async () => {
    expect(await runChild([bun, "-e", "process.exit(3)"], options())).toMatchObject({ kind: "exited", exitCode: 3 })
  })

  test("feeds stdin", async () => {
    const result = await runChild([bun, "-e", "process.stdout.write(String((await Bun.stdin.text()).length))"], options({ stdin: encoder.encode("dummy"), capture: 64 }))
    expect(result.kind === "exited" && decoder.decode(result.stdout)).toBe("5")
  })

  test("stops a child whose stdout passes the cap", async () => {
    const result = await runChild([bun, "-e", "process.stdout.write('x'.repeat(70000)); await Bun.sleep(5000)"], options({ capture: STDOUT_CAP }))
    expect(result.kind).toBe("overflow")
  })

  test("does not wait on a descendant that keeps stdout open after the command exits", async () => {
    const started = Date.now()
    const result = await runChild(["/bin/sh", "-c", "sleep 30 & printf x"], options({ capture: 1024 }))
    expect(result.kind).toBe("lost")
    expect(Date.now() - started).toBeLessThan(8_000)
  }, 15_000)

  test("times out a child that hangs", async () => {
    expect((await runChild([bun, "-e", "await Bun.sleep(10000)"], options({ timeoutMs: 200 }))).kind).toBe("timeout")
  })
})
