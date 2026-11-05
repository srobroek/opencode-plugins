/**
 * Secret redaction for tool output. The OpenCode service inherits the machine's API keys
 * and every shell call inherits the service environment, so an env dump would put real
 * keys into the transcript. This replaces the literal values of secret-looking environment
 * variables with `[REDACTED:NAME]` before a result reaches the model.
 *
 * It matches literal values only: a base64, URL-encoded, split or otherwise transformed
 * copy passes through. It is a leak reducer, not an isolation boundary.
 */

/** Values shorter than this are never redacted: short values collide with ordinary text. */
export const MIN_SECRET_LENGTH = 12

/** `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_ACCESS_KEY*`, `*_CREDENTIAL*`; case-insensitive. */
const SECRET_NAME = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)$|(?:^|_)(?:ACCESS_KEY|CREDENTIALS?)(?:_|$)/i

export type RedactOptions = {
  /** Redact secrets from tool output. Default true. */
  enabled: boolean
  /** Names always treated as secret, whatever they look like. */
  names: readonly string[]
  /** Names never redacted, even when they look secret. */
  exclude: readonly string[]
  minLength: number
}

export const DEFAULT_REDACT: RedactOptions = { enabled: true, names: [], exclude: [], minLength: MIN_SECRET_LENGTH }

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : []

/** `{ redactSecrets: false, redactNames: [...], redactExclude: [...] }`; anything else keeps the default. */
export function readRedactOptions(options: Readonly<Record<string, unknown>> | undefined): RedactOptions {
  return {
    ...DEFAULT_REDACT,
    enabled: options?.redactSecrets !== false,
    names: strings(options?.redactNames),
    exclude: strings(options?.redactExclude),
  }
}

/** Whether a variable name looks like it holds a secret. */
export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name)
}

export type Secret = { name: string; value: string }

/** The secret variables in `env`: secret-looking or listed in `names`, long enough, not excluded. */
export function collectSecrets(
  env: Readonly<Record<string, string | undefined>>,
  options: Pick<RedactOptions, "names" | "exclude" | "minLength"> = DEFAULT_REDACT,
): Secret[] {
  const listed = new Set(options.names)
  const excluded = new Set(options.exclude)
  const found: Secret[] = []
  for (const name of Object.keys(env).sort()) {
    const value = env[name]
    if (value === undefined || value.length < options.minLength || excluded.has(name)) continue
    if (listed.has(name) || looksSecret(name)) found.push({ name, value })
  }
  return found
}

/** Longest value first, so a secret that contains another is replaced whole; one name per value. */
export function orderSecrets(secrets: readonly Secret[]): Secret[] {
  const byValue = new Map<string, Secret>()
  for (const secret of secrets) if (!byValue.has(secret.value)) byValue.set(secret.value, secret)
  return [...byValue.values()].sort((a, b) => b.value.length - a.value.length)
}

export const marker = (name: string) => `[REDACTED:${name}]`

/** `text` with every occurrence of each secret value replaced. `secrets` come from `orderSecrets`. */
export function redactText(text: string, secrets: readonly Secret[]): string {
  let out = text
  for (const secret of secrets) if (out.includes(secret.value)) out = out.split(secret.value).join(marker(secret.name))
  return out
}

const MAX_DEPTH = 32

/**
 * `value` with every string in it (nested arrays and objects included, keys left alone) redacted.
 * Unchanged values keep their identity, so a clean result is returned as is.
 */
export function redactValue<T>(value: T, secrets: readonly Secret[], depth = 0): T {
  if (secrets.length === 0 || depth > MAX_DEPTH) return value
  if (typeof value === "string") return redactText(value, secrets) as T
  if (Array.isArray(value)) {
    const next = value.map((item) => redactValue(item, secrets, depth + 1))
    return next.some((item, index) => item !== value[index]) ? (next as T) : value
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value)
    const next = entries.map(([key, item]) => [key, redactValue(item, secrets, depth + 1)] as const)
    return next.some(([, item], index) => item !== entries[index]?.[1]) ? (Object.fromEntries(next) as T) : value
  }
  return value
}

/**
 * Tracks the secret values seen so far. The set is a snapshot taken at creation, refreshed
 * from the live environment on demand, and only ever grows: a variable unset later is still
 * redacted for the rest of the process.
 */
export function createRedactor(
  env: () => Readonly<Record<string, string | undefined>>,
  options: Pick<RedactOptions, "names" | "exclude" | "minLength"> = DEFAULT_REDACT,
) {
  const known = new Map<string, Secret>()
  let ordered: Secret[] = []
  const add = (secrets: readonly Secret[]) => {
    const before = known.size
    for (const secret of secrets) if (!known.has(secret.value)) known.set(secret.value, secret)
    if (known.size !== before) ordered = orderSecrets([...known.values()])
  }
  add(collectSecrets(env(), options))
  return {
    /** Re-read the environment; cheap (a few hundred names), so call it per result. */
    refresh: () => add(collectSecrets(env(), options)),
    /** Add the secret variables of another environment, for example a shell call's. */
    absorb: (extra: Readonly<Record<string, string | undefined>>) => add(collectSecrets(extra, options)),
    secrets: () => ordered,
    text: (text: string) => redactText(text, ordered),
    value: <T>(value: T) => redactValue(value, ordered),
  }
}

export type Redactor = ReturnType<typeof createRedactor>
