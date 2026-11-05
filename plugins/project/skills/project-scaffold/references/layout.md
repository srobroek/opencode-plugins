# Standard layout

Baseline every project gets, then a sketch per project type. Adapt names; keep the
intent. Top-level placement rules are `architecture-top-level`; the docs files are
`architecture-docs-files`. The `CLAUDE.md` symlink of the old bootstrapper is retired on
purpose: OpenCode V2 reads `AGENTS.md` only.

## Baseline tree

```text
README.md              name, one-line purpose, install, usage, license pointer
LICENSE                unless the project is unpublished (license-picker; "none" is allowed)
CODEOWNERS             `* @owner` (ask for the owner or team)
SECURITY.md            private vulnerability reporting: forge mechanism or a contact
CONTRIBUTING.md        PR expectations, verification command, no credentials in commits
CODE_OF_CONDUCT.md     only when there is a working reporting contact; otherwise omit
AGENTS.md              commands, layout pointers into docs/, project rules; short
.editorconfig  .gitattributes  .gitignore
mise.toml              pinned runtimes and every tool a gate invokes (or .mise/conf.d/<layer>.toml)
justfile               task surface (references/justfile.md)
.pre-commit-config.yaml   prek/pre-commit hooks (references/ci-hooks.md)
scripts/               small project scripts the hooks and tasks call
docs/
  architecture.md      system shape, boundaries, flows
  stack.md             languages, package manager, frameworks, quality tools, with versions
  engineering.md       local workflow, test layout, commit and release rules, env variable names
  operations.md        optional: hosting, secrets handling, monitoring, runbooks
  product.md           optional: user and domain behaviour not owned by a spec
  adr/                 optional: decisions, written when a durable decision is made
.github/               PULL_REQUEST_TEMPLATE.md, ISSUE_TEMPLATE/{bug_report,feature_request}.md,
                       workflows/ (GitLab: .gitlab/issue_templates/bug.md,
                       .gitlab/merge_request_templates/default.md, .gitlab-ci.yml)
```

- ADRs: when and how to record one is `quality-code-design` `references/lifecycle.md`
  ("Durable decisions"). Old ADR fields: title, status, date, decision, rationale,
  alternatives considered, consequences, confirmation. Do not write ADRs for decisions
  nobody made.
- `docs/engineering.md` names environment variables, never values (secrets: `project-secrets`).
- The old scaffold generated a `docs/agents/` steering tree (quality, ci, release, testing,
  docs, env, conventions). Here those live as sections of `docs/engineering.md` and
  `docs/stack.md` that the global OpenCode config already loads; split into more files
  only when a section outgrows its file.
- Issue and PR templates ask for: summary, reproduction (member path, command, inputs),
  expected versus actual, environment (commit, runtime, tool versions), a verification
  checklist (ran the command, recorded result, no credentials), and compatibility notes.

## `.editorconfig`

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.{py,rs}]
indent_size = 4

[*.{md,markdown}]
trim_trailing_whitespace = false

[Makefile]
indent_style = tab

[*.go]
indent_style = tab
```

## `.gitattributes`

```text
* text=auto eol=lf

*.png binary
*.jpg binary
*.webp binary
*.ico binary
*.pdf binary
```

## `.gitignore`

Start from the language's own init output and add: OS junk (`.DS_Store`, `Thumbs.db`,
`*~`, `.nfs*`), `scripts/__pycache__/` and `*.py[cod]` (hook scripts are Python in every
project), `.env*` (keep `.env.example`), `fnox.local.toml` when using `project-secrets`,
build output per language (`target/`, `node_modules/`, `.venv/`, `dist/`), and `.a11y/node_modules/`
when that capability is on.

## Per project type (sketch)

| Type | Shape |
| --- | --- |
| Library | `src/` (or `crates/<name>/`, `internal/` + public package), `tests/`, `docs/`; language reference for the manifest |
| CLI | `src/main.*` or `cmd/<name>/main.go` thin, library code beside it; `just run -- --help` as usage |
| Service | `cmd/api` or `src/server`, `internal/` domain and storage, `openapi.yaml` when it has an HTTP contract, `Dockerfile` only when deployed in a container |
| Web app | `apps/web` or `src/` (Better-T-Stack output), `messages/` + `project.inlang/` if translated, `.a11y/` if scanned, `infrastructure/` if on AWS |
| Desktop (Tauri) | Rust core crate + TypeScript UI; see `lang-rust-tauri`; `just dev` runs both |
| Monorepo | `apps/` deployables and UIs, `services/` backends, `packages/` or `crates/` shared libraries, `infrastructure/`, `docs/`; each member owns its manifest; `references/monorepo.md` |

Name the commit scopes after the real top-level pieces (old presets used `api`, `web`,
`cli`, `core`, `ui`, `i18n`, `a11y`, `infra`, `ci`, `deps`; for a library `lib`, `docs`,
`ci`, `deps`). Ask the user before restricting scopes at all.
