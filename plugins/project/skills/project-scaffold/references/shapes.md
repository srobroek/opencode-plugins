# Suggested shapes (from the old presets)

Offer the closest shape as a starting point, then customise. "Shape" selects language
references and capability offers; nothing is imposed. Policy defaults shared by every
shape: license Apache-2.0 (ask; see `license-picker`), default branch `main`, GitHub,
release automation and worktrees on, job timeout 15 min, large-file limit 512 KB.

| Shape | Languages | Offer | Notes |
| --- | --- | --- | --- |
| minimal | none | hygiene hooks, `justfile`, `mise.toml`, docs | install `mise install`, usage `just --list` |
| py-lib | Python | Python gates, release | scopes `lib,docs,ci,deps`; worktrees optional |
| rust-cli | Rust (binary) | Rust gates, release | timeout 20 min; scopes `cli,ci,deps`; usage `just run -- --help` |
| go-service | Go | Go gates, release | scopes `api,ci,deps`; usage `just run` |
| ts-service | TypeScript | TS gates, release | scopes `api,web,ci,deps`; usage `just dev`; Better-T-Stack for apps |
| api-service | TypeScript | + OpenAPI contract (`capabilities.md`) | timeout 20 min |
| gitlab-service | Go | GitLab CI instead of GitHub | no `.github/`; `.gitlab-ci.yml` and `.gitlab/` templates |
| polyglot-service | Go + TypeScript | both gates | timeout 20 min; scopes `api,web,ci,deps` |
| desktop-rust-ts | Rust (library core) + TypeScript | both gates | timeout 25 min; scopes `core,ui,ci,deps` |
| monorepo | Go + TypeScript members | per-member CI jobs | timeout 25 min; `references/monorepo.md` |
| web-app | TypeScript | + i18n, a11y, AWS CDK | timeout 25 min; dev command `bun run dev`; scopes `web,i18n,a11y,infra,ci,deps` |
| fullstack-web | Go + TypeScript | + i18n, a11y, AWS CDK | timeout 25 min; scopes `api,web,i18n,infra,ci,deps` |

Install and usage lines in the README: default `mise install && just setup` and `just dev`;
the old presets used language-specific forms such as `mise install && uv sync` or
`mise install && go mod download && bun install`. Prefer `just setup` so the README does not
drift from the justfile.
