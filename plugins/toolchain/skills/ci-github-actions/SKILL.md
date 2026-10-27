---
name: ci-github-actions
description: Use when writing GitHub Actions workflows, required checks, matrices, caches, action pinning or build attestation.
metadata:
  opencode/autoinvoke: false
---

# GitHub Actions CI defaults

Language-neutral workflow structure. Language-specific cache and toolchain setup
lives in the language plugin's skills when installed.

## One required gate

- Make one `ci-gate` job the only required status check. It runs `if: always()`,
  `needs:` every other job, and fails unless they all passed or were allowed to skip:

  ```yaml
  ci-gate:
    if: always()
    needs: [lint, test, build]
    runs-on: ubuntu-latest
    steps:
      - uses: re-actors/alls-green@<sha> # release/v1
        with:
          jobs: ${{ toJSON(needs) }}
          allowed-skips: build
  ```

  Branch protection then names one check, and adding or renaming jobs never
  touches repository settings.
- Never put `paths:` or `paths-ignore:` on the trigger of a workflow whose jobs are
  required checks. A skipped required check stays pending and blocks the merge.
  Skip work inside the workflow instead: a `dorny/paths-filter` job whose outputs
  feed each job's `if:`, with `ci-gate` listing those jobs in `allowed-skips`.

## Matrix and concurrency

- Set `strategy.fail-fast: false` on OS or version matrices, so one failing cell
  does not cancel the others and hide whether the failure is platform-specific.
- Cancel superseded runs on CI workflows only:

  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  ```

  On release, publish, or deploy workflows, omit `cancel-in-progress` (or set it
  `false`); cancelling mid-upload leaves a half-published release.

## Supply chain

- Pin every third-party action to a full commit SHA with the version in a comment
  (`uses: actions/checkout@<40-char sha> # v4.2.2`). `pinact` or `ratchet` pins
  existing workflows.
- Let Dependabot (or Renovate) update the pins: add a `github-actions` ecosystem
  entry to `.github/dependabot.yml`.
- Give each workflow `permissions: contents: read` at the top and widen per job.
- Attest released artifacts with `actions/attest-build-provenance`; the job needs
  `id-token: write` and `attestations: write`. Consumers verify with
  `gh attestation verify`.

## Speed

- Install tools from prebuilt binaries: the `setup-*` actions (`actions/setup-node`,
  `astral-sh/setup-uv`, `oven-sh/setup-bun`, `jdx/mise-action`),
  `taiki-e/install-action`, or `cargo binstall`. Do not compile tools from source on
  every run (`cargo install`, `go install` of large tools, `pip install` from sdists).
- Cache keys: include the OS, the toolchain version, and a hash of the lockfile
  (`hashFiles('**/bun.lock')`). Never key on values that change every run (commit
  SHA, timestamps) or on environment that differs between jobs sharing a cache, such
  as compiler flags; each such value is a guaranteed miss. Use `restore-keys` for a
  partial hit, and remember the 10 GB per-repository cache limit evicts old entries.
- Prefer the setup action's built-in cache (`cache: npm`, `enable-cache: true`) over
  a hand-written `actions/cache` step when it covers the need.
