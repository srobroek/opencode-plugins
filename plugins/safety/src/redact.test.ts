import { describe, expect, test } from "bun:test"
import {
  collectSecrets,
  createRedactor,
  looksSecret,
  orderSecrets,
  readRedactOptions,
  redactText,
  redactValue,
} from "./redact.ts"

const KEY = "tvly-dummy-0123456789abcdef"
const OTHER = "brv-dummy-fedcba9876543210"

describe("looksSecret", () => {
  test.each([
    "TAVILY_API_KEY",
    "GITLAB_AWS_DEV_TOKEN",
    "APP_SECRET",
    "DB_PASSWORD",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_CREDENTIALS",
    "gh_token",
    "TOKEN",
  ])("%s", (name) => expect(looksSecret(name)).toBe(true))
  test.each(["PATH", "HOME", "TOKENIZER_DIR", "KEYBOARD", "API_KEY_FILE_NAME", "SSH_AUTH_SOCK", "SECRETARY"])(
    "%s is not secret",
    (name) => expect(looksSecret(name)).toBe(false),
  )
})

describe("collectSecrets", () => {
  test("takes long values of secret-looking names only", () => {
    const secrets = collectSecrets({ TAVILY_API_KEY: KEY, PATH: "/usr/local/bin:/usr/bin:/bin", SHORT_TOKEN: "abc123" })
    expect(secrets).toEqual([{ name: "TAVILY_API_KEY", value: KEY }])
  })
  test("applies the extra names, the exclusions and the minimum length", () => {
    const env = { CUSTOM: "custom-value-123456", SOME_TOKEN: KEY, MY_KEY: "twelve-chars" }
    const secrets = collectSecrets(env, { names: ["CUSTOM", "MY_KEY"], exclude: ["SOME_TOKEN"], minLength: 13 })
    expect(secrets.map((secret) => secret.name)).toEqual(["CUSTOM"])
  })
  test("skips unset values", () => {
    expect(collectSecrets({ A_TOKEN: undefined })).toEqual([])
  })
})

describe("redactText", () => {
  const secrets = orderSecrets(collectSecrets({ TAVILY_API_KEY: KEY, BRAVE_API_KEY: OTHER }))

  test("replaces an exact value", () => {
    expect(redactText(KEY, secrets)).toBe("[REDACTED:TAVILY_API_KEY]")
  })
  test("replaces a value inside longer output and every occurrence", () => {
    const text = `TAVILY_API_KEY=${KEY}\nexport X="${KEY}" # again ${KEY}.`
    expect(redactText(text, secrets)).toBe(
      "TAVILY_API_KEY=[REDACTED:TAVILY_API_KEY]\nexport X=\"[REDACTED:TAVILY_API_KEY]\" # again [REDACTED:TAVILY_API_KEY].",
    )
  })
  test("replaces several secrets", () => {
    expect(redactText(`a ${KEY} b ${OTHER} c`, secrets)).toBe("a [REDACTED:TAVILY_API_KEY] b [REDACTED:BRAVE_API_KEY] c")
  })
  test("does not redact on the name alone", () => {
    const text = "TAVILY_API_KEY is set; BRAVE_API_KEY=<hidden>"
    expect(redactText(text, secrets)).toBe(text)
  })
  test("leaves short values untouched", () => {
    const short = orderSecrets(collectSecrets({ A_TOKEN: "abc", B_TOKEN: "eleven-char" }))
    expect(short).toEqual([])
    expect(redactText("abc eleven-char", short)).toBe("abc eleven-char")
  })
  test("replaces the longest value first when one contains another", () => {
    const nested = orderSecrets(collectSecrets({ A_TOKEN: "prefix-secret-0001", B_TOKEN: "prefix-secret-0001-long" }))
    expect(redactText("x prefix-secret-0001-long y", nested)).toBe("x [REDACTED:B_TOKEN] y")
  })
  test("keeps one name for two variables holding the same value", () => {
    const same = orderSecrets(collectSecrets({ A_TOKEN: KEY, B_TOKEN: KEY }))
    expect(redactText(KEY, same)).toBe("[REDACTED:A_TOKEN]")
  })
  test("treats a value with regex or replacement characters literally", () => {
    const odd = orderSecrets(collectSecrets({ A_SECRET: "a.b*c$&(d)[e]+f?g" }))
    expect(redactText("see a.b*c$&(d)[e]+f?g, not aXbbc", odd)).toBe("see [REDACTED:A_SECRET], not aXbbc")
  })
})

describe("redactValue", () => {
  const secrets = orderSecrets(collectSecrets({ TAVILY_API_KEY: KEY }))

  test("redacts content parts, output and metadata, leaving other fields alone", () => {
    const result = {
      content: [{ type: "text", text: `key ${KEY}` }, { type: "file", uri: "file:///x", mime: "text/plain" }],
      output: { output: `K=${KEY}`, exit: 0, lines: [KEY, 1, null] },
      metadata: { note: KEY, ok: true },
    }
    expect(redactValue(result, secrets)).toEqual({
      content: [{ type: "text", text: "key [REDACTED:TAVILY_API_KEY]" }, { type: "file", uri: "file:///x", mime: "text/plain" }],
      output: { output: "K=[REDACTED:TAVILY_API_KEY]", exit: 0, lines: ["[REDACTED:TAVILY_API_KEY]", 1, null] },
      metadata: { note: "[REDACTED:TAVILY_API_KEY]", ok: true },
    })
  })
  test("returns the same object when nothing matches", () => {
    const result = { content: "clean", output: { exit: 0 } }
    expect(redactValue(result, secrets)).toBe(result)
  })
  test("returns the input when there are no secrets", () => {
    const result = { content: KEY }
    expect(redactValue(result, [])).toBe(result)
  })
  test("passes through a string content", () => {
    expect(redactValue(`x${KEY}`, secrets)).toBe("x[REDACTED:TAVILY_API_KEY]")
  })
})

describe("createRedactor", () => {
  test("snapshots at creation, picks up later variables, and remembers removed ones", () => {
    const env: Record<string, string | undefined> = { TAVILY_API_KEY: KEY }
    const redactor = createRedactor(() => env)
    expect(redactor.text(`${KEY} ${OTHER}`)).toBe(`[REDACTED:TAVILY_API_KEY] ${OTHER}`)
    env.BRAVE_API_KEY = OTHER
    redactor.refresh()
    expect(redactor.text(OTHER)).toBe("[REDACTED:BRAVE_API_KEY]")
    delete env.TAVILY_API_KEY
    redactor.refresh()
    expect(redactor.text(KEY)).toBe("[REDACTED:TAVILY_API_KEY]")
  })
  test("absorbs the secrets of another environment", () => {
    const redactor = createRedactor(() => ({}))
    redactor.absorb({ SHELL_ONLY_TOKEN: OTHER, PATH: "/bin" })
    expect(redactor.text(OTHER)).toBe("[REDACTED:SHELL_ONLY_TOKEN]")
  })
})

describe("readRedactOptions", () => {
  test("is on by default", () => {
    expect(readRedactOptions(undefined)).toMatchObject({ enabled: true, names: [], exclude: [] })
  })
  test("reads the flag and the name lists, ignoring junk", () => {
    expect(readRedactOptions({ redactSecrets: false, redactNames: ["A", 1, ""], redactExclude: "B" })).toMatchObject({
      enabled: false,
      names: ["A"],
      exclude: [],
    })
  })
})
