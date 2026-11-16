# Terraform and OpenTofu testing and quality concerns

Checked 2026-11-16.

Rows follow the spec in
[concerns.md](../../toolchain-languages/references/concerns.md). Shared tools are in
[shared-tools.md](../../toolchain-languages/references/shared-tools.md). Terraform
is 1.17.2 (BSL); OpenTofu is 1.13.9 (MPL-2.0). Commands below use `terraform`; replace
it with `tofu` unless a row says otherwise.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | Built-in: `terraform test` (1.6 or newer) or `tofu test`; plan runs with `mock_provider`, `override_resource`, `override_data` and `override_module` for unit tests | - | Built-in | `terratest`: you need HTTP or SSH probes of deployed resources, or Go orchestration | A module ships endpoints: native tests for logic, Terratest for the probe | every-pr | kitchen-terraform: archived |
| `assertions` | Built-in: `assert` blocks in `run` blocks and `expect_failures` | - | Built-in | None | - | every-pr | `assert` blocks with no `error_message`; `expect_failures` that name no specific variable or check |
| `watch` | N/A: infrastructure code has no inner test loop; run `terraform test` on demand | - | - | None | - | - | - |
| `property` | N/A: HCL has no generator; use `validation` blocks with negative tests | - | - | None | - | - | - |
| `fuzz` | N/A: no fuzzer for HCL | - | - | None | - | - | - |
| `fuzz-continuous` | N/A: no fuzzer for HCL | - | - | None | - | - | - |
| `mutation` | N/A: no maintained tool; negative tests with `expect_failures` check that validations, preconditions and postconditions reject bad input | - | - | None | - | - | - |
| `snapshot` | Built-in: `terraform show -json` of a saved plan, compared with a committed golden file | - | Built-in | None | - | on-demand | Golden files of whole plans: they change on every provider bump and add noise |
| `component` | N/A: infrastructure code has no UI component model | - | - | None | - | - | - |
| `concurrency` | N/A: Terraform runs in parallel only through `parallel = true` with `state_key`; OpenTofu documents no such option | - | - | None | - | - | - |
| `coverage` | N/A: no coverage tool for HCL | - | - | None | - | - | - |
| `benchmark` | N/A: infrastructure is not benchmarked | - | - | None | - | - | - |
| `flaky-order` | N/A: runs are declared in file order and plan runs hold no shared state | - | - | None | - | - | - |
| `integration` | Built-in: `terraform test` apply runs in a sandbox account | - | Built-in | `terratest`: you need probes beyond what `check` blocks and outputs show | - | scheduled | Apply runs against shared or production accounts |
| `contract` | N/A: modules have no independently deployed consumers | - | - | None | - | - | - |
| `api-schema` | N/A: no API schema | - | - | None | - | - | - |
| `load` | N/A: infrastructure code is not load tested | - | - | None | - | - | - |
| `lint` | `tflint` with the bundled terraform ruleset and the provider ruleset (aws, azurerm or google) | >= 0.66.0 · 2026-11-08 · active | `tflint --version` · `mise use tflint` | None | - | every-pr | Running without `tflint --init`: provider rules stay off |
| `format` | Built-in: `terraform fmt -check -recursive` | - | Built-in | None | - | every-pr | - |
| `types` | Built-in: `terraform validate` | - | Built-in | None | - | every-pr | `validate` without `init -backend=false`: it fails on missing providers |
| `sast` | `checkov` on code and on plan JSON from `terraform show -json` | >= 3.4.5 · 2026-11-12 · active | `checkov --version` · `mise use pipx:checkov` | `kics`: you need its query library or a second opinion; `trivy`: opt-in only, from a verified pinned artifact after the March 2026 compromise; `conftest`: org-specific policy written in Rego; `sentinel`: HCP Terraform policy, proprietary | Checkov for the baseline, Conftest for org rules on the plan JSON | every-pr | Terrascan: archived; tfsec: folded into Trivy; kics-github-action by tag: pin it by SHA after the parallel compromise |
| `memory-safety` | N/A: HCL has no memory model | - | - | None | - | - | - |
| `dep-audit` | Built-in: a committed `.terraform.lock.hcl` made with `terraform providers lock -platform=...` for every CI and developer platform | - | Built-in | `renovate`: bumps providers and modules through its terraform manager, though OpenTofu needs `registryUrls` and lock checksum issues need a re-lock; `tfupdate`: you want a scripted bump without a service | Lock file for the pin, Renovate to propose bumps | every-pr + scheduled | A lock file made on one platform: other platforms fail the checksum |
| `dead-code` | `tflint` with `terraform_unused_declarations` | >= 0.66.0 · 2026-11-08 · active | `tflint --version` · `mise use tflint` | None | - | every-pr | - |
| `unused-deps` | `tflint` with `terraform_unused_required_providers` | >= 0.66.0 · 2026-11-08 · active | `tflint --version` · `mise use tflint` | None | - | every-pr | - |
| `complexity` | N/A: no complexity tool for HCL | - | - | None | - | - | - |
| `duplication` | No maintained tool: review repeated resource blocks and extract a module | - | - | None | - | - | - |
| `api-break` | No maintained tool: a native test that pins the old module outputs and input names, semver for releases, and `moved` blocks for renames | - | - | None | - | every-pr | Renaming a resource or output without a `moved` block or a major version |
| `docs` | `terraform-docs` through pre-commit-terraform | >= 0.25.1 · 2026-11-12 · active | `terraform-docs --version` · `mise use terraform-docs` | None | - | every-pr | Hand-edited generated sections |
| `iac-plan` | Built-in: `terraform plan -out=tfplan` and `terraform show`, rendered on the PR | - | Built-in | `tfcmt`: you want the plan posted as a PR comment; `tf-summarize`: you want a table of changes, though it is slow on large plans | - | every-pr | Applying a plan that was not the one reviewed |
| `iac-drift` | Built-in: a scheduled `terraform plan -detailed-exitcode -lock=false` (exit 0 no change, 1 error, 2 drift) | - | Built-in | None | - | scheduled | Treating exit 1 as drift: it is an error |
| `iac-cost` | `infracost` (needs `infracost auth login`; opt-in) | >= 2.19.1 · 2026-11-12 · active | `infracost --version` · `brew install infracost` | None | - | on-demand | Enabling it without an account and the owner's consent |

## Tradeoffs

### test-runner

- **terraform test**: wins because it ships with the tool, mocks providers and needs no extra install; costs run-level `parallel` and `state_key` exist on Terraform only, and `-junit-xml` is unverified on OpenTofu
- **terratest**: wins on HTTP and SSH probes of deployed resources; costs a Go toolchain and slow apply cycles

### integration

- **terraform test**: wins on apply runs in HCL with no extra language; costs probes beyond outputs and `check` blocks
- **terratest**: wins on probes and orchestration across modules; costs Go code to maintain

### sast

- **checkov**: wins on broad rules for code and plan JSON; costs noisy findings that need a baseline
- **kics**: wins on a separate query library; costs pinning its action by SHA
- **trivy**: wins on one scanner for config and images; costs trust, so use it only from a verified pinned artifact
- **conftest**: wins on org-specific policy in Rego; costs you write and own the rules
- **sentinel**: wins inside HCP Terraform policy sets; costs a proprietary language and platform

### dep-audit

- **lock file**: wins because it pins provider hashes with no service; costs a re-lock for each platform
- **renovate**: wins on automatic update PRs; costs OpenTofu `registryUrls` setup and lock checksum fixes
- **tfupdate**: wins on a scripted, service-free bump; costs you schedule and review it yourself

### iac-plan

- **plan and show**: wins because it needs nothing extra; costs reviewers read long output
- **tfcmt**: wins on a PR comment with the plan; costs a CI secret for the comment
- **tf-summarize**: wins on a compact table; costs speed on large plans

## Language-specific

| Topic | Tool | Note |
| --- | --- | --- |
| Test layout | `tests/*.tftest.hcl` | One file per behavior group; `command = plan` for unit runs |
| Negative tests | `expect_failures` | List the variable, check or resource that must fail |
| Module registry | Terraform Registry and OpenTofu Registry | Evaluate official, community and custom modules before you write one |
