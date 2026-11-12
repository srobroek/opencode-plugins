---
name: architecture-repositories
description: Use when choosing single-language, polyglot monorepo or polyrepo, or laying out a repository with several languages.
metadata:
  opencode/autoinvoke: false
---

# Single-language, polyglot and multi-repository layouts

Checked 2026-11-12. Directory names follow `architecture-top-level`; contract and generated-client placement follows `architecture-ownership`.

## Choose the boundary

Repository, workspace, deployment and release boundaries are separate decisions. Draw each by deployment, ownership and access, not by language.

| Criterion | One language, one repository | Polyglot monorepo | Several repositories |
| --- | --- | --- | --- |
| Deployables and cadence | One product or one ecosystem | Independent deployables that keep their own release cadence | Strong operational or release autonomy |
| Contracts and atomic change | Native package interfaces | Contract and consumer changes land in one pull request | Published contracts that rarely change |
| Ownership | One small, cohesive team | Shared governance with ownership per directory | Autonomous teams with little coordination |
| CI and tooling cost | Lowest | Needs selective jobs and caching as coupling grows | Smaller pipelines, but platform setup repeated in each repository |
| Access control | One trust level | Everyone may read everything | Source visibility must differ |
| Cross-cutting change | Easy | Atomic in source; deployment still rolls out per service | Coordinated pull requests and staged compatibility |

Default for a TypeScript web app with Python Lambda functions that share contracts and owners: one polyglot monorepo, laid out by deployable, with native workspaces per language and an independent deploy pipeline per deployable. Choose separate repositories when source access or team autonomy requires it.

## Lay out by deployable

```text
apps/web/                         TypeScript (bun workspace member)
functions/aws-lambda/orders/      Python (uv project or workspace member)
functions/aws-lambda/billing/
services/api/                     long-lived backend deployable
libs/                             internal shared code by role, per language
packages/api-ts/  packages/api-python/   generated clients, when versioned independently
schemas/                          shared contracts: OpenAPI, protobuf (buf.yaml), JSON Schema
infrastructure/<stack>/           shared CDK or Terraform; deployable-specific IaC stays with the deployable
tools/  scripts/  docs/
```

- Organize by deployable, never by a top-level `typescript/` and `python/` split.
- Each language keeps its native workspace: bun (or pnpm, not both) for JavaScript, uv for Python, a Cargo workspace for Rust; bun, uv and Cargo select members by glob. Go starts with one module; a `go.work` file, which lists module directories with `use`, is for local development across several modules, and CI checks each module with `GOWORK=off`.
- Keep one authoritative lockfile per dependency-resolution domain and install it frozen in CI. A uv workspace resolves all members together; give a Lambda function its own project and `uv.lock` when its dependencies conflict with the others or must stay minimal.
- Package each Lambda function from its own dependency closure (ZIP or image), never from the shared development environment. Build native wheels for the Lambda architecture, and test the packaged artifact on its own: a workspace does not stop one member from importing another member's undeclared dependency.
- Build container images with a per-service context; use named or pruned contexts when a service needs a shared package or the root lockfile.
- Format and lint with each language's own tools (Biome or ESLint, Ruff and a type checker, `gofmt`, rustfmt and Clippy, `terraform fmt`). One shared `prek` or pre-commit config routes hooks by file type; `.editorconfig` covers whitespace.

## Share contracts, not code

- Keep the contract source in `schemas/` (or the owning service's `contracts/`): OpenAPI for HTTP, protobuf with Buf v2 configuration for RPC, JSON Schema for events and files. One authoritative contract per interface; do not maintain the same model in three languages by hand. The API style choice is in `toolchain-api`.
- Generate a native client per language into its consumer or a versioned package. Pin generator versions and options. Commit the output; in CI, regenerate and fail when `git diff --exit-code` reports changes or `git status --porcelain -- <generated dirs>` shows new files. Never hand-edit generated files.
- A contract change selects every consumer's checks.
- Never import across language or package boundaries through relative paths or path hacks.

## Run tasks and builds

| Need | Default | Graduate to | Notes |
| --- | --- | --- | --- |
| Tool versions and one task entrypoint | `mise` (monorepo tasks with explicit config roots) or `just` / Task over native commands | - | `mise` artifact caching is experimental; do not treat it as a build cache |
| Cross-language task graph with caching | - | moon 2 (Bun, Node, Go and Rust fully integrated; Python partial) or Nx 24 with the community Python and Go plugins | Validate the Python integration before relying on it |
| JavaScript-heavy repository | Turborepo 2 | - | It discovers `package.json` workspaces only; non-JS tasks are wrapped, not modelled |
| Python-heavy repository with fine-grained packaging | - | Pants 2 (dependency inference, hermetic runs, Lambda packaging) | Check JS and framework support before adopting it |
| Hermetic builds and remote execution at scale | - | Bazel 9 with `rules_python`, `rules_go`, `rules_js`; Buck2 | Pays off only with dedicated build engineering; pin rules and toolchains |

Keep one thin orchestration entrypoint. Do not rebuild every ecosystem's dependency handling inside another language's tool.

## CI, ownership and releases

- Select jobs by what changed: start with path filters (`dorny/paths-filter`, which supports matrices and `merge_group`), and move to moon or Nx affected graphs when shared libraries make path filters fragile. Inputs include contracts, shared libraries, lockfiles and CI configuration, not only the changed directory.
- Always start the required workflow. Run language or component jobs conditionally, then finish with an always-running gate job that fails on any failed or skipped-by-mistake job. Path-filtering a required workflow out leaves its check pending, and merge queues need the `merge_group` trigger.
- Cache downloads separately from build outputs. Key build caches on sources, contracts, lockfiles, toolchain versions and flags; untrusted pull requests never write to shared caches.
- CODEOWNERS per deployable, plus `schemas/`, `infrastructure/` and CI configuration. Ownership routes review; it does not hide source.
- Release each deployable or package on its own with release-please manifest mode (a release type per path, component-prefixed tags). Link versions only for components that ship together on purpose. Changesets is npm-oriented and needs adapters for Python or Go; `semantic-release-monorepo` is a community extension to validate before use. Deploying stays a separate pipeline step.

## Avoid

- Copying models or helpers between languages instead of generating from one contract.
- One giant CI job that builds and tests every language on every change.
- Generated code without a drift check, or with unpinned generators.
- Forcing incompatible Lambda functions into one Python resolution.
- One language's tool orchestrating everything badly.

## Sources

- Bun workspaces: https://bun.sh/docs/pm/workspaces
- uv workspaces: https://docs.astral.sh/uv/concepts/projects/workspaces/
- Go workspaces: https://go.dev/doc/tutorial/workspaces
- Cargo workspaces: https://doc.rust-lang.org/cargo/reference/workspaces.html
- Buf v2 configuration: https://buf.build/docs/configuration/v2/buf-yaml/
- Lambda Python packaging: https://docs.aws.amazon.com/lambda/latest/dg/python-package.html
- Docker build contexts: https://docs.docker.com/build/building/context/
- mise monorepo tasks: https://mise.jdx.dev/tasks/monorepo.html
- moon: https://moonrepo.dev/docs
- Nx affected: https://nx.dev/docs/features/ci-features/affected
- Turborepo repository structure: https://turborepo.com/docs/crafting-your-repository/structuring-a-repository
- Pants: https://www.pantsbuild.org/stable/docs/introduction/welcome-to-pants
- Bazel: https://bazel.build/about/intro
- GitHub required checks with path filters: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
- release-please manifest mode: https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md
