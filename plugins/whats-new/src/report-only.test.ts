import { describe, expect, test } from "bun:test"
import { wildcardMatch } from "@srobroek/opencode-lib/patterns"
import {
  AGENT_ID,
  commandMutates,
  DENY_REASON,
  decideEvaluation,
  isDependencyFile,
  reportOnlyPermissions,
} from "./report-only.ts"

const BLOCKED = [
  "npm install lodash",
  "npm update",
  "pnpm add -D vitest",
  "pnpm upgrade",
  "bun add zod@latest",
  "yarn up react",
  "pip install requests",
  "pip3 install -U requests",
  "cargo add serde",
  "cargo update -p tokio",
  "cargo install cargo-audit",
  "go get golang.org/x/tools@latest",
  "uv add httpx",
  "uv pip install httpx",
  "poetry add fastapi",
  "poetry update",
  "cd repo && npm install",
]
const BLOCKED_NESTED = [
  "npm i lodash",
  "npm i react@latest",
  "npm ci",
  "npm --prefix /repo install",
  "/usr/local/bin/npm install",
  "pnpm i",
  "pnpm -C web add zod",
  "pnpm dlx npm-check-updates -u",
  "bun i",
  "yarn",
  "yarn --frozen-lockfile",
  "uv sync",
  "uv lock --upgrade",
  "uv lock -U",
  "uv lock -P httpx",
  "uv lock --upgrade-package=httpx",
  "uv --directory api add httpx",
  "bundle update",
  "bundle install",
  "bundle add rails",
  "gem install rails",
  "composer require vendor/pkg",
  "composer update",
  "ncu -u",
  "npx npm-check-updates -u",
  "python -m pip install requests",
  "python3.12 -m pip install -U requests",
  "poetry install",
  "sudo npm i -g typescript",
  "env CI=1 npm ci",
  "FOO=1 pnpm add zod",
  "time poetry update",
  'bash -c "npm install x"',
  "sh -lc 'uv sync'",
  "echo $(npm i x)",
  'echo "$(npm i x)"',
  "echo `pnpm add x`",
  "git status; uv add httpx",
  "cd a || pip install x",
  "cat <<EOF\n$(npm i x)\nEOF",
]
const BLOCKED_WRAPPED = [
  "doas npm i x",
  "/usr/bin/doas -u root pnpm add x",
  "timeout 60 npm install",
  "timeout -k 5 -s KILL 60 uv sync",
  "stdbuf -oL npm ci",
  "stdbuf -o L bun add x",
  "stdbuf --output=L pnpm add x",
  "exec -a npm-install npm i x",
  "env -S 'npm i x'",
  "env -iS'pnpm add x'",
  "env -C /repo npm ci",
  "sudo -D /repo yarn add x",
  "nice -n 5 timeout 5 stdbuf -oL poetry add x",
  "npx -p npm-check-updates ncu -u",
]
const ALLOWED = [
  "echo 'see: npm install docs'",
  'echo "cd repo && npm install"',
  "printf '%s\\n' npm install",
  'git commit -m "npm install lodash"',
  'grep -rn "pip install" .',
  "cat <<'EOF'\nnpm install\nEOF",
  "cat <<EOF\nnpm install\nEOF",
  "uv add --help",
  "npm install -h",
  "uv lock",
  "uv tree",
  "uv pip list",
  "yarn build",
  "yarn --version",
  "command -v yarn",
  "bundle exec rake",
  "composer show",
  "ncu",
  "python -m pytest",
  "pnpm why zod",
]
const ALLOWED_WRAPPED = [
  "timeout 5 npm view react",
  "env -S 'npm view x'",
  "stdbuf -oL npm run build",
  "command -pv npm",
]
const ALLOWED_INHERITED = ["constructor name npm i x", "npm toString npm i x", "bun hasOwnProperty npm i x"]
const ALLOWED_RESEARCH = [
  "npm view react versions --json",
  "npm run build",
  "bun test",
  "cargo build",
  "go build ./...",
  "git clone --bare https://github.com/x/y",
  "curl -s https://pypi.org/pypi/httpx/json",
  "pip download httpx",
]

describe("isDependencyFile", () => {
  test("matches manifests and lockfiles at any depth", () => {
    for (const path of [
      "package.json",
      "apps/web/package.json",
      "Cargo.toml",
      "crates/core/Cargo.lock",
      "pyproject.toml",
      "go.mod",
      "go.sum",
      "uv.lock",
      "bun.lock",
      "bun.lockb",
      "poetry.lock",
      "yarn.lock",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "apps/web/pnpm-lock.yaml",
    ]) {
      expect(isDependencyFile(path)).toBe(true)
    }
  })

  test("leaves source, docs, and lookalikes alone", () => {
    for (const path of [
      "src/index.ts",
      "REPORT.md",
      "package.json.bak",
      "tsconfig.json",
      "docs/go.mod.md",
      "locked.txt",
    ]) {
      expect(isDependencyFile(path)).toBe(false)
    }
  })
})

describe("commandMutates", () => {
  test("blocks installer and upgrade commands, nested, wrapped and plain", () => {
    for (const command of [...BLOCKED, ...BLOCKED_NESTED, ...BLOCKED_WRAPPED]) {
      expect({ command, blocked: commandMutates(command) }).toEqual({ command, blocked: true })
    }
  })

  test("quoted data, help, lookups, research and read-only subcommands stay allowed", () => {
    for (const command of [...ALLOWED, ...ALLOWED_WRAPPED, ...ALLOWED_INHERITED, ...ALLOWED_RESEARCH]) {
      expect({ command, blocked: commandMutates(command) }).toEqual({ command, blocked: false })
    }
  })
})

/** The effect OpenCode's ordered rules give: the last matching rule wins, else allow (the default policy). */
function ruleEffect(action: string, resource: string): string {
  let effect = "allow"
  for (const rule of reportOnlyPermissions()) {
    if (wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) effect = rule.effect
  }
  return effect
}

describe("reportOnlyPermissions", () => {
  test("denies manifest and lockfile edits at any depth, relative or absolute", () => {
    for (const path of [
      "package.json",
      "apps/web/package.json",
      "/repo/Cargo.toml",
      "crates/core/Cargo.lock",
      "uv.lock",
      "bun.lockb",
      "web/pnpm-lock.yaml",
      "go.sum",
      "Gemfile",
    ]) {
      expect({ path, effect: ruleEffect("edit", path) }).toEqual({ path, effect: "deny" })
    }
    for (const path of ["REPORT.md", "src/index.ts", "package.json.bak", "docs/go.mod.md", "tsconfig.json"]) {
      expect({ path, effect: ruleEffect("edit", path) }).toEqual({ path, effect: "allow" })
    }
  })

  test("denies plainly written installers and dep_apply, allows research commands", () => {
    for (const command of [...BLOCKED.filter((c) => !c.startsWith("cd ")), "yarn", "npm ci", "python -m pip install x"]) {
      expect({ command, effect: ruleEffect("shell", command) }).toEqual({ command, effect: "deny" })
    }
    for (const command of ALLOWED_RESEARCH) {
      expect({ command, effect: ruleEffect("shell", command) }).toEqual({ command, effect: "allow" })
    }
    expect(ruleEffect("dep_apply", "x@1.0.0")).toBe("deny")
  })
})

describe("decideEvaluation", () => {
  const evaluation = (action: string, resources: string[], agent: string = AGENT_ID) => ({
    agent,
    action,
    resources,
    effect: "allow" as "allow" | "ask" | "deny",
    message: undefined as string | undefined,
  })

  test("denies wrapped installers, case-folded manifests and dep_apply for the whats-new agent", () => {
    for (const event of [
      evaluation("shell", ["sudo npm i -g typescript"]),
      evaluation("shell", ["git status", 'bash -c "npm install x"']),
      evaluation("edit", ["PACKAGE.JSON"]),
      evaluation("dep_apply", ["x@1.0.0"]),
    ]) {
      decideEvaluation(event)
      expect(event).toMatchObject({ effect: "deny", message: DENY_REASON })
    }
  })

  test("leaves other agents, research commands and asks it does not block alone", () => {
    for (const event of [
      evaluation("shell", ["sudo npm i -g typescript"], "build"),
      evaluation("shell", ["npm view react versions --json"]),
      evaluation("edit", ["WHATS-NEW.md"]),
    ]) {
      decideEvaluation(event)
      expect(event.effect).toBe("allow")
    }
  })
})
