import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

/** The fnox config the fake snapshot reports; a test mutates it to model a change. */
type Config = { types: Record<string, string>; vaults: Record<string, string>; digest: string; readable: boolean }

type Ask = { kind: string; argv?: string[]; cwd?: string; resources?: string[]; file?: string; provider?: string }

/** Fake deps: every child run is recorded; `results` answers by argv[0]. Paths resolve to themselves unless `links` maps them. */
function fake(overrides: Partial<StoreDeps> = {}, results: Record<string, (call: Call, config: Config) => RunResult> = {}, links: Record<string, string | null> = {}) {
  const calls: Call[] = []
  const asks: Ask[] = []
  const reads: (string | undefined)[] = []
  const config: Config = { types: { host: "age", op: "1password", plain: "plain" }, vaults: { op: "Dev" }, digest: "d1", readable: true }
  const deps: StoreDeps = {
    directory: "/project",
    roots: ["/project"],
    env: { PATH: "/bin", HOME: "/home/u" },
    which: (bin) => `/bin/${bin}`,
    realpath: (path) => (path in links ? (links[path] ?? undefined) : path),
    snapshot: (path) => {
      reads.push(path)
      if (!config.readable) return undefined
      const types = { ...config.types }
      const vaults = { ...config.vaults }
      return {
        digest: config.digest,
        typeOf: (name) => types[name],
        ofType: (type) => Object.keys(types).filter((name) => types[name] === type),
        setting: (name, key) => (key === "vault" ? vaults[name] : undefined),
      }
    },
    askExternal: async (external) => void asks.push({ kind: "external", resources: external.map((item) => item.resource) }),
    askStore: async (_, destination) => void asks.push({ kind: "store", file: destination.file, provider: destination.provider }),
    askCommand: async (argv, cwd) => void asks.push({ kind: "command", argv, cwd }),
    run: async (argv, options) => {
      const call: Call = {
        argv,
        options,
        ...(options.stdin ? { stdin: options.stdin, stdinCopy: decoder.decode(options.stdin) } : {}),
      }
      calls.push(call)
      const answer = results[argv[0] as string]
      return answer ? answer(call, config) : { kind: "exited", exitCode: 0 }
    },
    ...overrides,
  }
  return { deps, calls, asks, config, reads }
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
      ["/bin/fnox", "--config=/project/fnox.toml", "set", "--provider=op", "--", "API_TOKEN", "proj api/credential"],
    ])
    const item = JSON.parse(calls[0]?.stdinCopy ?? "")
    expect(item.fields[0]).toMatchObject({ id: "credential", type: "CONCEALED", value: "0".repeat(32) })
    expect(calls[1]?.options.stdin).toBeUndefined()
  })

  test("passes a description and the canonical config path to fnox, and reads exactly that file", async () => {
    const { deps, calls, reads } = fake()
    await storeSecret({ name: "A", target: onePassword, generate: hex, description: "proj api", config: "fnox.local.toml" }, deps)
    expect(reads).toEqual(["/project/fnox.local.toml", "/project/fnox.local.toml"])
    expect(calls[1]?.argv).toEqual([
      "/bin/fnox",
      "--config=/project/fnox.local.toml",
      "set",
      "--provider=op",
      "--description=proj api",
      "--",
      "A",
      "proj api/credential",
    ])
  })

  for (const [label, types, target] of [
    ["no 1Password provider", { host: "age" }, onePassword],
    ["two 1Password providers", { op: "1password", shared: "1password" }, onePassword],
    ["a named provider that is not 1Password", { op: "1password", host: "age" }, { ...onePassword, provider: "host" }],
  ] as const)
    test(`fails closed on ${label}, before anything runs`, async () => {
      const { deps, calls, asks, config } = fake()
      config.types = { ...types }
      await expect(storeSecret({ name: "A", target, generate: hex }, deps)).rejects.toThrow(/provider/)
      expect([calls, asks]).toEqual([[], []])
    })

  test("fails closed on an unreadable config, before anything runs", async () => {
    const { deps, calls, asks, config } = fake()
    config.readable = false
    await expect(storeSecret({ name: "A", target: onePassword, generate: hex }, deps)).rejects.toThrow(/config/)
    expect([calls, asks]).toEqual([[], []])
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
    const { deps, config } = fake()
    config.vaults = {}
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

describe("a config change while the value is obtained", () => {
  const command = { argv: ["gen"] }
  for (const [label, target, change] of [
    ["a store provider switched to plain", { kind: "fnox-store", provider: "host" }, (c: Config) => {
      c.types.host = "plain"
      c.digest = "d2"
    }],
    ["the 1Password provider switched to plain", onePassword, (c: Config) => {
      c.types.op = "plain"
      c.digest = "d2"
    }],
    ["an edit that keeps the provider types", { kind: "fnox-store", provider: "host" }, (c: Config) => {
      c.digest = "d2"
    }],
    ["a config that no longer reads", onePassword, (c: Config) => {
      c.readable = false
    }],
  ] as const)
    test(`refuses ${label}, with no op item create and no fnox set`, async () => {
      const { deps, calls } = fake(
        {},
        {
          // The command edits the config the tool's own snapshot reads.
          "/bin/gen": (_, config) => {
            change(config)
            return { kind: "exited", exitCode: 0, stdout: encoder.encode(`${SENTINEL}\n`) }
          },
        },
      )
      const error = String(await storeSecret({ name: "A", target, command }, deps).catch((e: Error) => e))
      expect(error).toMatch(/config changed/)
      expect(error).not.toContain(SENTINEL)
      expect(calls.map((call) => call.argv[0])).toEqual(["/bin/gen"])
    })
})

describe("the config path", () => {
  const store = { kind: "fnox-store", provider: "host" } as const

  test("a path outside the session's directories asks external_directory before anything else", async () => {
    const { deps, asks, calls } = fake()
    await storeSecret({ name: "A", target: store, generate: hex, config: "../other/fnox.toml" }, deps)
    expect(asks[0]).toEqual({ kind: "external", resources: ["/other/*"] })
    expect(asks[1]).toMatchObject({ kind: "store", file: "/other/fnox.toml" })
    expect(calls[0]?.argv[1]).toBe("--config=/other/fnox.toml")
  })

  test("a refused external_directory stores nothing and asks nothing more", async () => {
    const { deps, asks, calls } = fake({ askExternal: async () => Promise.reject(new Error("rejected")) })
    await expect(storeSecret({ name: "A", target: store, generate: hex, config: "/elsewhere/fnox.toml" }, deps)).rejects.toThrow("rejected")
    expect([asks, calls]).toEqual([[], []])
  })

  test("a symlink inside the project that points outside counts as outside, and fnox gets the target", async () => {
    const { deps, asks, calls } = fake({}, {}, { "/project/fnox.local.toml": "/elsewhere/real.toml" })
    await storeSecret({ name: "A", target: store, generate: hex, config: "fnox.local.toml" }, deps)
    expect(asks[0]).toEqual({ kind: "external", resources: ["/elsewhere/*"] })
    expect(asks[1]).toMatchObject({ kind: "store", file: "/elsewhere/real.toml" })
    expect(calls[0]?.argv[1]).toBe("--config=/elsewhere/real.toml")
  })

  test("a path inside the project asks no external_directory", async () => {
    const { deps, asks } = fake()
    await storeSecret({ name: "A", target: store, generate: hex, config: "sub/fnox.toml" }, deps)
    expect(asks.map((ask) => ask.kind)).toEqual(["store"])
  })

  test("a config file that does not exist is refused before anything runs", async () => {
    const { deps, asks, calls } = fake({}, {}, { "/project/fnox.toml": null })
    await expect(storeSecret({ name: "A", target: store, generate: hex }, deps)).rejects.toThrow(/does not exist/)
    expect([asks, calls]).toEqual([[], []])
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
    expect(calls[1]?.argv).toEqual(["/bin/fnox", "--config=/project/fnox.toml", "set", "--provider=host", "--", "GH_TOKEN"])
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
    expect(asks).toEqual([
      { kind: "store", file: "/project/fnox.toml", provider: "op" },
      { kind: "command", argv: ["gh", "auth", "token"], cwd: "/project/sub" },
    ])
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

  test("with reap, ends what the command left running in its process group once it exits", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "secret-store-reap-"))
    try {
      const marker = join(dir, "late")
      const result = await runChild(["/bin/sh", "-c", `(sleep 1; touch '${marker}') >/dev/null 2>&1 & printf v`], options({ capture: 64, reap: true }))
      expect(result.kind).toBe("exited")
      await Bun.sleep(1_500)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("times out a child that hangs", async () => {
    expect((await runChild([bun, "-e", "await Bun.sleep(10000)"], options({ timeoutMs: 200 }))).kind).toBe("timeout")
  })
})
