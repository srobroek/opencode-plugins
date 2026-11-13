import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { type GuardOptions, hardGate } from "./guards.ts"
import { createPlugin, readOptions } from "./index.ts"
import {
  CHECK_FAILED_MESSAGE,
  FNOX_CONFIG_MESSAGE,
  FNOX_DUMP_MESSAGE,
  FNOX_INDIRECT_MESSAGE,
  FNOX_SET_MESSAGE,
  FNOX_STORE_MESSAGE,
  LITERAL_MESSAGE,
  MAX_NESTING, NESTING_MESSAGE, OP_MESSAGE } from "./op-guard.ts"

/** Provider types as a fnox config would declare them. */
const TYPES: Record<string, string> = {
  host: "keychain",
  age: "age",
  "team-age": "age",
  keychain: "keychain",
  op: "1password",
  proj: "1password",
}
const types = (name: string) => TYPES[name]
const gate = (command: string, options: GuardOptions = {}) => hardGate(command, "/", { providerTypes: types, ...options })

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
  "op item list",
  "op vault get x",
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

const REFUSED_STORE = [
  "openssl rand -hex 8 | fnox set NAME --provider op",
  "echo hunter2 | fnox set NAME --provider other",
  "cmd | fnox set NAME -p op",
  "cmd | fnox set NAME",
  "fnox set NAME --generate --provider op",
  "fnox set NAME --generate",
  "fnox set NAME \"$(openssl rand -hex 8)\" --provider op",
  "fnox set NAME \"$TOKEN\" --provider op",
  "fnox set NAME --provider op <<<\"$TOKEN\"",
  "fnox exec -- sh -c 'cmd | fnox set NAME --provider op'",
  "fnox set NAME --provider op < secret.txt",
  "fnox set NAME --provider op <(openssl rand -hex 8)",
  "fnox set NAME --from-file k.txt --provider op",
  "fnox set NAME 'item/field' --from-file k.txt --provider op",
  "fnox set NAME 'item/field' --generate --provider op",
  "fnox set NAME 'item/field' --default \"$X\" --provider op",
  "cmd | fnox set NAME 'item/field' --provider op",
  "fnox set NAME 'item/field' --provider op <<EOF\nx\nEOF",
  "cmd | fnox exec -- fnox set NAME --provider op",
  "cmd | fnox exec -- sh -c 'fnox set NAME item/field --provider op'",
  "fnox exec -- sh -c 'fnox set NAME item/field --provider op' < secret.txt",
  "fnox set NAME \"item/$X\" --provider op",
  "cmd | fnox set NAME --provider unknown",
  "cmd | fnox -c my.toml set NAME --provider host",
]

const REFUSED_INDIRECT = [
  "echo 'fnox set NAME item/f --provider op' | sh",
  "cat run.sh | bash; fnox set NAME item/f --provider op",
  "sh < run.sh; op item create --vault V -",
  "bash -c \"$SCRIPT\"; fnox set NAME item/f --provider op",
  "echo NAME | xargs fnox set --provider op",
  "echo x | xargs -I{} op item create --vault V -",
  "find . -name k -exec fnox set NAME item/f --provider op \\;",
  "find . -execdir op item edit x - \\;",
  "parallel fnox set {} item/f --provider op ::: A B",
  "env -S 'fnox set NAME item/f --provider op'",
  "eval 'fnox set NAME item/f --provider op'",
  "source ./env.sh; fnox set NAME item/f --provider op",
  ". ./env.sh; op item create --vault V -",
  "alias s='fnox set'; s NAME item/f --provider op",
  "f() { fnox set \"$@\"; }; f NAME item/f --provider op",
  "function f { op item create --vault V -; }; f",
  "$CD /x; cmd | fnox set NAME --provider host",
  "F=fnox; $F set NAME item/f --provider op",
  "$(echo op) item create --vault V -",
  "nix develop -c fnox set NAME item/f --provider op",
  "nix shell nixpkgs#fnox -c fnox set NAME item/f --provider op",
  "nix run nixpkgs#fnox -- set NAME item/f --provider op",
  "direnv exec . fnox set NAME item/f --provider op",
  "mise exec -- fnox set NAME item/f --provider op",
  "mise x -- op item create --vault V -",
  "asdf exec fnox set NAME item/f --provider op",
  "devbox run fnox set NAME item/f --provider op",
  "uv run fnox set NAME item/f --provider op",
  "poetry run fnox set NAME item/f --provider op",
  "npx fnox set NAME item/f --provider op",
  "bunx op item create --vault V -",
  "pnpm dlx fnox set NAME item/f --provider op",
]

const REFUSED_CONFIG = [
  "echo x > fnox.toml; cmd | fnox set NAME --provider host",
  "cmd | fnox set NAME --provider host && mv /tmp/x .fnox.local.toml",
  "cmd | fnox set NAME --provider host; cp a ~/.config/fnox/config.toml",
  "cmd | fnox set NAME --provider host; rm fnox.toml",
  "ln -sf /tmp/x fnox.toml; cmd | fnox set NAME --provider host",
  "tee fnox.prod.toml < x; cmd | fnox set NAME --provider host",
  "fnox provider add host age; cmd | fnox set NAME --provider host",
  "fnox provider remove host; cmd | fnox set NAME --provider host",
  "fnox config edit; cmd | fnox set NAME --provider host",
  "cat x > \"$F\"; cmd | fnox set NAME --provider host",
  "cmd | tee \"$F\"; cmd | fnox set NAME --provider host",
  "cp a \"$HOME/x\"; cmd | fnox set NAME --provider host",
]

const REFUSED_PIPED = [
  "echo hunter2 | op item create -",
  "echo '{\"password\":\"x\"}' | op item create --vault V -",
  "echo -n hunter2 | op item edit x -",
  "printf 'hunter2' | op item create -",
  "printf '%s' hunter2 | op item create -",
  "printf '%s %s' \"$A\" literal | op item create -",
  "jq -n --arg v hunter2 '{title:$v}' | op item create --vault V -",
  "jq -n --argjson v '\"hunter2\"' '{title:$v}' | op item create -",
  "jq -n --arg a \"$A\" --arg v hunter2 '{}' | op item create -",
  "jq -n --arg v \"x$(cmd)\" '{}' | op item create -",
  "cat <<'EOF' | op item create -\n{\"password\":\"x\"}\nEOF",
  "cat <<< hunter2 | op item create -",
  "echo hunter2 | tr a b | op item create -",
  "echo hunter2 | fnox set NAME --provider host",
  "printf hunter2 | fnox set NAME -p age",
  "jq -n --arg v hunter2 '$v' | fnox set NAME --provider keychain",
  "echo hunter2 | fnox exec -- op item create -",
  "echo hunter2 | fnox exec -- fnox set NAME --provider host",
  "fnox exec -- sh -c 'echo hunter2 | op item create -'",
  "bash -c 'echo hunter2 | op item create -'",
  "echo ok && echo hunter2 | op item create -",
]

const REFUSED_MIXED = [
  "op item create --title t \"credential=sk-abc$X\"",
  "op item create --title t \"password=$(cmd)x\"",
  "op item edit x \"f[password]=pre$A$B\"",
  "op item create --title t 'password=$X'",
  "fnox set NAME \"sk-abc$X\" --provider host",
  "fnox set NAME \"$X-literal\" --provider age",
  "fnox set NAME --default \"sk-$X\" --provider host",
  "fnox set NAME --default=\"sk-$X\" --provider host",
  "op item create --title t - <<< \"sk-$X\"",
  "op item create --title t - <<< 'plain'",
  "echo \"sk-$X\" | op item create -",
  "echo \"$X$(cmd)lit\" | op item create -",
  "printf '%s' \"a$X\" | op item create -",
  "jq -n --arg v \"sk-$X\" '{}' | op item create -",
]

const REFUSED_JQ_ARGS = [
  "jq --arg v hunter2 '{title:$v}' | op item create -",
  "jq -c --arg v hunter2 '{}' | op item create -",
  "jq -r --argjson v '\"hunter2\"' '{}' | fnox set NAME --provider host",
  "jq --arg a \"$A\" --arg v hunter2 '{}' | op item create -",
]

const REFUSED_PRINTF = [
  "printf 'hunter2\\n' | op item create -",
  "printf 'pw=%s' \"$X\" | op item create -",
  "printf '%s9' \"$X\" | op item create -",
  "printf '{\"password\":\"%s\"}' \"$TOKEN\" | op item create -",
]

function nested(levels: number, inner: string): string {
  return levels === 0 ? inner : `sh -c '${nested(levels - 1, inner).replaceAll("'", "'\\''")}'`
}

const REFUSED_DEEP = [
  `fnox exec -- ${nested(9, "op read x")}`,
  `fnox exec -- ${nested(9, "echo hi; op item get x")}`,
  `fnox exec -- bash <<'EOF'\n${nested(9, "op read x")}\nEOF`,
  `fnox exec -- fnox exec -- ${nested(9, "fnox get X")}`,
]

const REFUSED_DEFAULT = [
  "fnox set NAME --default hunter2 --provider host",
  "fnox set NAME --default=hunter2 --provider host",
  "fnox set NAME --provider age --default hunter2",
  "fnox set NAME \"$X\" --default hunter2 -p keychain",
  "fnox exec -- fnox set NAME --default hunter2 --provider host",
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
  // piped values from expansions only
  "echo \"$TOKEN\" | op item create -",
  "echo \"$(cmd)\" | op item create -",
  "echo -n \"$TOKEN\" | op item create -",
  "echo | op item create -",
  "printf '%s' \"$TOKEN\" | op item create -",
  "printf '%s' \"$(cmd)\" | op item edit x -",
  "printf '%s\\n' \"$TOKEN\" | op item create -",
  "printf '%s %d%%\\t' \"$A\" \"$B\" | op item create -",
  "printf '{%s}' \"$A\" | op item create -",
  "printf \"$FMT\" \"$TOKEN\" | op item create -",
  "jq -n --arg v \"$(cmd)\" '{title:$v}' | op item create --vault V -",
  "jq --arg v \"$(cmd)\" '{title:$v}' | op item create -",
  "echo \"$(cmd ')')\" | op item create -",
  "op item create --title t \"password=$(cmd ')' )\"",
  "fnox set NAME \"$(cmd ')')\" --provider host",
  "jq -n --arg v \"$TOKEN\" --argjson n \"$N\" '{}' | op item create -",
  "jq -n '{title:\"x\"}' | op item create -",
  "cat <<EOF | op item create -\n{\"password\":\"$TOKEN\"}\nEOF",
  "cat t.json | op item create -",
  "echo hunter2 | cat > out.txt; op item create --title t",
  "echo hunter2; op item create -",
  "echo hunter2 && op item create --title t",
  "echo hunter2 | tr a b",
  "echo hunter2 | fnox set NAME --provider host --generate",
  "echo hunter2 | fnox set NAME --provider host --from-file k.txt",
  "printf '%s' \"$TOKEN\" | fnox set NAME --provider host",
  "echo \"$TOKEN\" | fnox exec -- op item create -",
  // fnox set --default
  "fnox set NAME --default \"$X\" --provider host",
  "fnox set NAME --default hunter2 --provider other",
  "fnox set NAME --default hunter2",
  "fnox set NAME --provider host --generate --default \"$X\"",
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
  "echo x > fnox.toml; fnox set NAME item/field --provider op",
  "cmd | fnox set NAME --provider host; echo ok > out.txt",
  "fnox provider list; cmd | fnox set NAME --provider host",
  "jq -n --arg v \"$(cmd)\" '{}' | op item create --vault V - >/dev/null",
  "nix develop -c cargo test",
  "uv run pytest",
  "npx tsc --noEmit",
  "find . -name x -exec echo {} \\;",
  "echo a | xargs echo",
  "source ./env.sh; cargo build",
  "mise exec -- node app.js",
  "bash -c 'echo hi' > out.txt",
  "fnox set NAME 'op://vault/item/field' --provider op",
  "fnox set NAME --provider op",
  "op vault list",
  "op vault list --format json",
  "fnox exec -- op vault list",
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

/** `fnox set` refusals carry the fnox-set text; the rest the literal-secret text. */
const expectedMixed = (command: string) => (command.startsWith("fnox set") ? FNOX_SET_MESSAGE : LITERAL_MESSAGE)

describe("op-guard", () => {
  for (const command of REFUSED_OP)
    test(`refuses ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: OP_MESSAGE })
    })
  for (const command of REFUSED_LITERAL)
    test(`refuses literal ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: LITERAL_MESSAGE })
    })
  for (const command of REFUSED_STORE)
    test(`refuses fnox set into a provider without storage ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: FNOX_STORE_MESSAGE })
    })
  for (const command of REFUSED_INDIRECT)
    test(`refuses a secret write behind an executor ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: FNOX_INDIRECT_MESSAGE })
    })
  for (const command of REFUSED_CONFIG)
    test(`refuses a fnox set beside a config write ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: FNOX_CONFIG_MESSAGE })
    })
  for (const command of REFUSED_PIPED)
    test(`refuses piped literal ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: LITERAL_MESSAGE })
    })
  for (const command of REFUSED_MIXED)
    test(`refuses mixed literal ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: expectedMixed(command) })
    })
  for (const command of REFUSED_JQ_ARGS)
    test(`refuses jq args without -n ${command}`, () => {
      expect(gate(command)?.reason).toBe(LITERAL_MESSAGE)
    })
  for (const command of REFUSED_PRINTF)
    test(`refuses printf format ${command}`, () => {
      expect(gate(command)?.reason).toBe(LITERAL_MESSAGE)
    })
  for (const command of REFUSED_DEEP)
    test(`refuses hidden deep nesting ${command.slice(0, 40)}`, () => {
      expect(gate(command)?.reason).toBe(NESTING_MESSAGE)
    })
  for (const command of REFUSED_DEFAULT)
    test(`refuses fnox set default ${command}`, () => {
      expect(gate(command)).toEqual({ guard: "op-guard", reason: FNOX_SET_MESSAGE })
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

  describe("an uncertain execution directory is not a value store", () => {
    for (const command of [
      "cd sub && cmd | fnox set NAME --provider host",
      "cd 'sub dir' && cmd | fnox set NAME --provider host",
      "cmd | fnox set NAME --provider host; cd /x",
      "cd /x; cd /y; cmd | fnox set NAME --provider host",
      "pushd /x && cmd | fnox set NAME --provider host",
      "(cd /x && cmd | fnox set NAME --provider host)",
      "bash -c 'cd /x && cmd | fnox set NAME --provider host'",
      "env -C /x sh -c 'cmd | fnox set NAME --provider host'",
      "sudo -D /x sh -c 'cmd | fnox set NAME --provider host'",
      "git -C /x status; cmd | fnox set NAME --provider host",
      "make --directory=/x; cmd | fnox set NAME --provider host",
    ])
      test(`refuses ${command}`, () => {
        expect(gate(command)).toEqual({ guard: "op-guard", reason: FNOX_STORE_MESSAGE })
      })
  })

  test("a value set with no directory change in the command uses the resolved type", () => {
    expect(gate("cmd | fnox set NAME --provider host")).toBeUndefined()
  })

  test("a provider named host that is 1password is not a value store", () => {
    const named = { providerTypes: (name: string) => (name === "host" ? "1password" : undefined) }
    expect(gate("cmd | fnox set NAME --provider host", named)).toEqual({ guard: "op-guard", reason: FNOX_STORE_MESSAGE })
  })

  test("an age-named provider of another type is not a value store", () => {
    const named = { providerTypes: (name: string) => (name === "x-age" ? "1password" : undefined) }
    expect(gate("cmd | fnox set NAME --provider x-age", named)).toEqual({ guard: "op-guard", reason: FNOX_STORE_MESSAGE })
  })

  test("a provider whose type cannot be resolved is not a value store", () => {
    expect(gate("cmd | fnox set NAME --provider host", { providerTypes: () => undefined })?.reason).toBe(FNOX_STORE_MESSAGE)
  })

  for (const type of ["aws-sm", "aws-ps", "azure-sm", "gcp-sm", "bitwarden-sm", "foks", "vault"])
    test(`a provider of the cloud store type ${type} takes a piped value`, () => {
      expect(gate("cmd | fnox set NAME --provider p", { providerTypes: () => type })).toBeUndefined()
    })

  for (const type of ["doppler", "infisical", "azure-ac", "kubernetes", "keeper-sm", "plain", "lua"])
    test(`a provider of the read-only or plaintext type ${type} is not a value store`, () => {
      expect(gate("cmd | fnox set NAME --provider p", { providerTypes: () => type })?.reason).toBe(FNOX_STORE_MESSAGE)
    })

  test("a provider of type age takes a piped value whatever its name", () => {
    expect(gate("cmd | fnox set NAME --provider vault-keys", { providerTypes: () => "age" })).toBeUndefined()
  })

  test("the refusal points to fnox exec and provider discover", () => {
    expect(OP_MESSAGE).toContain("fnox exec -- <cmd>")
    expect(OP_MESSAGE).toContain("fnox provider discover <provider> --tags project/<name>")
  })

  test("opAllow adds subcommand prefixes", () => {
    expect(gate("op item list")).toBeDefined()
    expect(gate("op item list --format json", { opAllow: ["item list"] })).toBeUndefined()
    expect(gate("op item get x", { opAllow: ["item list"] })).toBeDefined()
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
