import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectProject, parseRequirement } from "./dep-detect.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dep-detect-"))
}

function withDir(files: Record<string, string>, run: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = tmp()
    try {
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
      await run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

describe("parseRequirement", () => {
  test("extras and markers", () => {
    expect(parseRequirement('requests[socks]>=2.31.0; python_version < "3.12"')).toEqual(["requests", ">=2.31.0"])
    expect(parseRequirement("uvicorn[standard]==0.30.0")).toEqual(["uvicorn", "==0.30.0"])
  })

  test("options, paths and comments declare nothing", () => {
    expect(parseRequirement("-r base.txt")).toEqual(["", ""])
    expect(parseRequirement("./local")).toEqual(["", ""])
    expect(parseRequirement("# just a comment")).toEqual(["", ""])
    expect(parseRequirement("flask")).toEqual(["flask", "?"])
  })
})

describe("detectProject", () => {
  test(
    "package.json deps",
    withDir(
      { "package.json": JSON.stringify({ dependencies: { react: "^18.2.0" }, devDependencies: { typescript: "~5.4.0" } }) },
      async (dir) => {
        const { rows } = await detectProject(dir)
        expect(rows).toEqual([
          { ecosystem: "npm", name: "react", declared: "^18.2.0", resolved: null, direct: true },
          { ecosystem: "npm", name: "typescript", declared: "~5.4.0", resolved: null, direct: true },
        ])
      },
    ),
  )

  test(
    "package.json and package-lock.json expose declared and resolved versions",
    withDir(
      {
        "package.json": JSON.stringify({ dependencies: { leftpad: "^1.3.0", missing: "^2.0.0" } }),
        "package-lock.json": JSON.stringify({
          lockfileVersion: 3,
          packages: { "": {}, "node_modules/leftpad": { version: "1.3.1" } },
        }),
      },
      async (dir) => {
        const { rows, coverage } = await detectProject(dir)
        expect(rows).toEqual([
          { ecosystem: "npm", name: "leftpad", declared: "^1.3.0", resolved: "1.3.1", direct: true },
          { ecosystem: "npm", name: "missing", declared: "^2.0.0", resolved: null, direct: true },
        ])
        expect(coverage.gaps).toContain("Cargo.lock")
      },
    ),
  )

  test(
    "requirements.txt",
    withDir({ "requirements.txt": "requests==2.31.0\n" }, async (dir) => {
      const { rows } = await detectProject(dir)
      expect(rows).toEqual([{ ecosystem: "pypi", name: "requests", declared: "==2.31.0", resolved: null, direct: true }])
    }),
  )

  test(
    "Python: pyproject declares, uv.lock resolves, transitive and local entries are told apart",
    withDir(
      {
        "pyproject.toml": [
          "[project]",
          'name = "app"',
          'dependencies = ["httpx>=0.27", "Typing_Extensions>=4", "mylib", "vendored @ file:///tmp/vendored"]',
          "[dependency-groups]",
          'dev = ["pytest==8.0.0"]',
        ].join("\n"),
        "requirements.txt": "flask==3.0.0\n",
        "uv.lock": [
          "version = 1",
          '[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }',
          '[[package]]\nname = "httpx"\nversion = "0.27.2"\nsource = { registry = "https://pypi.org/simple" }',
          '[[package]]\nname = "typing-extensions"\nversion = "4.12.2"\nsource = { registry = "https://pypi.org/simple" }',
          '[[package]]\nname = "anyio"\nversion = "4.4.0"\nsource = { registry = "https://pypi.org/simple" }',
          '[[package]]\nname = "mylib"\nversion = "0.0.1"\nsource = { directory = "../mylib" }',
          '[[package]]\nname = "pytest"\nversion = "8.0.0"\nsource = { registry = "https://pypi.org/simple" }',
        ].join("\n"),
      },
      async (dir) => {
        const { rows } = await detectProject(dir)
        expect(rows).toEqual([
          { ecosystem: "pypi", name: "httpx", declared: ">=0.27", resolved: "0.27.2", direct: true },
          { ecosystem: "pypi", name: "Typing_Extensions", declared: ">=4", resolved: "4.12.2", direct: true },
          { ecosystem: "pypi", name: "pytest", declared: "==8.0.0", resolved: "8.0.0", direct: true },
          { ecosystem: "pypi", name: "anyio", declared: "?", resolved: "4.4.0", direct: false },
        ])
      },
    ),
  )

  test(
    "Python: poetry tables declare, poetry.lock resolves, path and directory sources are skipped",
    withDir(
      {
        "pyproject.toml": [
          "[tool.poetry.dependencies]",
          'python = "^3.11"',
          'requests = "^2.31"',
          'mylib = { path = "../mylib", develop = true }',
          "[tool.poetry.group.dev.dependencies]",
          'pytest = { version = "8.0.0" }',
        ].join("\n"),
        "poetry.lock": [
          '[[package]]\nname = "requests"\nversion = "2.32.3"',
          '[[package]]\nname = "urllib3"\nversion = "2.2.2"',
          '[[package]]\nname = "pytest"\nversion = "8.0.0"',
          '[[package]]\nname = "mylib"\nversion = "0.1.0"\ndevelop = true\n[package.source]\ntype = "directory"\nurl = "../mylib"',
        ].join("\n"),
      },
      async (dir) => {
        const { rows } = await detectProject(dir)
        expect(rows).toEqual([
          { ecosystem: "pypi", name: "requests", declared: "^2.31", resolved: "2.32.3", direct: true },
          { ecosystem: "pypi", name: "pytest", declared: "8.0.0", resolved: "8.0.0", direct: true },
          { ecosystem: "pypi", name: "urllib3", declared: "?", resolved: "2.2.2", direct: false },
        ])
      },
    ),
  )

  test(
    "Python: requirements.txt declares only when pyproject declares nothing",
    withDir(
      { "pyproject.toml": '[build-system]\nrequires = ["setuptools"]\n', "requirements.txt": "flask==3.0.0\n" },
      async (dir) => {
        const { rows } = await detectProject(dir)
        expect(rows).toEqual([{ ecosystem: "pypi", name: "flask", declared: "==3.0.0", resolved: null, direct: true }])
      },
    ),
  )

  test(
    "malformed Python collections do not hide valid declarations or crash detection",
    withDir(
      {
        "uv.lock": "package = false",
        "pyproject.toml":
          '[project]\ndependencies = 42\n[project.optional-dependencies]\nbad = false\ngood = ["requests==2.0.0"]\n[dependency-groups]\nbad = 1\ngood = ["pytest==8.0.0"]\n',
        "package.json": '{"dependencies":{"constructor":"1.0.0","__proto__":"2.0.0"},"devDependencies":["invalid"]}',
      },
      async (dir) => {
        const result = await detectProject(dir)
        expect(result.rows).toEqual([
          { ecosystem: "npm", name: "constructor", declared: "1.0.0", resolved: null, direct: true },
          { ecosystem: "npm", name: "__proto__", declared: "2.0.0", resolved: null, direct: true },
          { ecosystem: "pypi", name: "requests", declared: "==2.0.0", resolved: null, direct: true },
          { ecosystem: "pypi", name: "pytest", declared: "==8.0.0", resolved: null, direct: true },
        ])
        expect(result.stderr).toContain("Unscanned:")
      },
    ),
  )

  test(
    "Cargo, go, Ruby and PHP manifests",
    withDir(
      {
        "Cargo.toml": '[dependencies]\nserde = "1.0"\ntokio = { version = "1.38", features = ["full"] }\n',
        "go.mod": "module x\n\ngo 1.22\n\nrequire (\n\tgolang.org/x/tools v0.22.0\n)\nrequire github.com/a/b v1.0.0\n",
        Gemfile: "gem 'rails', '~> 7.1'\ngem \"rake\"\n",
        "composer.json": JSON.stringify({ require: { php: ">=8", "ext-json": "*", "vendor/pkg": "^2.0" } }),
      },
      async (dir) => {
        const { rows } = await detectProject(dir)
        expect(rows.map((row) => `${row.ecosystem}:${row.name}:${row.declared}`)).toEqual([
          "cargo:serde:1.0",
          "cargo:tokio:1.38",
          "go:golang.org/x/tools:v0.22.0",
          "go:github.com/a/b:v1.0.0",
          "rubygems:rails:~> 7.1",
          "rubygems:rake:?",
          "packagist:vendor/pkg:^2.0",
        ])
      },
    ),
  )

  test("a missing directory is exit 2", async () => {
    const result = await detectProject("/nonexistent-dep-detect-dir")
    expect(result).toMatchObject({ ok: false, exit: 2, rows: [] })
  })
})
