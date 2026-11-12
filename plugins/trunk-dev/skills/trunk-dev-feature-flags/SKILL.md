---
name: trunk-dev-feature-flags
description: Use when adding a feat change, writing a PR Flag line, or rolling out or removing a default-off feature flag.
metadata:
  opencode/autoinvoke: false
---

# Feature flag decisions

Gate every new feature behind a default-off flag. This includes breaking `feat!` changes.

- The flag lets unfinished work merge to the default branch without exposing it, so the branch stays releasable.
- Turning the flag off rolls the feature back without a revert.
- Fixes, refactors, chores, docs, and other non-feature changes need no flag.

Keep flags cheap and short-lived. [Fowler](https://martinfowler.com/articles/feature-toggles.html) explains the carrying cost of toggles. [LaunchDarkly](https://launchdarkly.com/docs/guides/flags/technical-debt) warns that stale flags become debt. [DORA](https://dora.dev/capabilities/working-in-small-batches/) recommends small batches. [Feature flag guidance](https://docs.getunleash.io/concepts/feature-flags) separates temporary release flags from long-lived operational controls.

## Record the decision

Add exactly one `Flag:` line to the MR/PR description (and therefore to the squash commit body when the forge copies it):

<code>Flag: &lt;flag-name&gt; (default off; owner &lt;alias&gt;; remove by YYYY-MM-DD)</code> for the PR that adds a feature behind a new flag

<code>Flag: &lt;flag-name&gt; (enable; owner &lt;alias&gt;; remove by YYYY-MM-DD)</code> for the rollout PR that turns an existing flag on for users

<code>Flag: none &mdash; &lt;one-line reason&gt;</code> (non-feature changes only, such as a breaking `fix!` or `refactor!`)

A `feat` MR/PR names a real flag; `Flag: none` is not valid for it. A rollout PR keeps the flag's original owner and removal date. Do not retype a feature as `fix` or `chore` to avoid the flag. Do not substitute other field names or omit the owner or removal date for a temporary flag. A no-flag decision includes a concise reason.

## Choose the mechanism

Follow the repository's existing flag mechanism when it has one, keeping these boundaries:

- Put typed keys, defaults and metadata in one flag module. Feature code never reads environment, config, SSM or AppConfig directly. Decide once at the request or job edge and inject the decision.
- **Applications, services and CLIs:** default to the [OpenFeature](https://openfeature.dev/docs/reference/concepts/evaluation-api) client through the flag module, with one provider over the backend chosen by need. If no maintained provider exists in the language, stop and ask before writing one; never silently use a backend wrapper. Review third-party providers as dependencies. A provider swap preserves the API; targeting, bucketing and analytics need separate migration checks.
- **flags.yaml:** repository file in flagd format for local development, CLIs, services outside AWS and flags changed with a deploy.
- **SSM Parameter Store:** simple runtime on/off toggles on AWS without staged rollout.
- **AppConfig:** feature flag profile through the Agent (Lambda extension on Lambda) for kill switches and gradual or percentage rollout, with validators, deployment strategies and alarm rollback.
- **Libraries and OpenCode plugins:** libraries take caller decisions and never evaluate flags; OpenCode plugins keep plugin options because the host config is their backend.
- Entitlements and tenant permissions belong in the domain database, not flags; rollout flags may restrict authorized access, never grant it.
- Temporary release flags default off to preserve existing behavior. Give each flag an explicit outage default and staleness policy; `false` must not disable a protection. Rust OpenFeature returns errors that the module maps to that default.

For code, file format and provider details, read `quality-code-design`'s `feature-flags.md`; for AWS service specifics, read `aws-guidance`. Keep an existing flag service. Adding a hosted service or choosing an experiment platform needs approval; experiments need exposure and outcome metrics.

- In tests, use the SDK's in-memory provider to run both flag states without a backend. Rust `0.3` uses `MockFeatureProvider` with `test-util` instead; see `feature-flags.md` for language details.
- Use the same name in code, config, the backend, and the `Flag:` line.
- State in the MR/PR description how to turn the flag on, for example change `new-ui.defaultVariant` to `"on"` in `flags.yaml`, or name the AppConfig profile and flag key.
- A compile-time constant or bundler define is not a feature flag: switching it needs a rebuild. Use it only to keep dormant code out of a build, not for rollout or as a kill switch.
- After launch, a remote flag (AppConfig or a hosted service) can stay as a long-lived kill switch. Record it as an operational control in the cleanup chore, and remove temporary release flags on their date.

## Lifecycle and testing

- Temporary flags default off. Name one owner for rollout and removal. State a concrete removal date. When the owner finishes rollout or abandons the feature, they open a cleanup MR/PR and remove the flag and dead path.
- When a flagged `feat` PR/MR merges, trunk-dev creates a cleanup chore bead due on the recorded removal date. That covers `delivery_land`, `gh pr merge`, and `glab mr merge`. Do not create it in advance. If you must create one by hand, set `--due <removal date>` and `--metadata '{"trunk_dev_flag":"<name>"}'` so trunk-dev recognizes it. The named owner closes that chore with the flag-removal PR.
- CI tests both disabled and enabled states. Test flagged behavior in both states. Include relevant interactions when flags combine.
- To run unreleased flagged work locally, install the MR branch or pinned commit SHA. Enable the flag in `flags.yaml` (or plugin options for an OpenCode plugin). Pre-merge previews also install the MR/PR branch or pinned SHA, or use a CI artifact built from that SHA. Do not use a moving `next`/`rc` branch: it can include unrelated changes and obscures the tested revision.
- Use truthful commit types. Dormant, not-yet-exposed plumbing is `refactor:` or `chore:`. A separate change that enables the capability for users is `feat:`. Flag removal and cleanup is `chore:` or `refactor:`. Do not mislabel a user-facing feature to avoid a release.

A published prerelease channel can be appropriate for real external testers who need an installable preview release. Treat it as an explicit opt-in testing exception, not the default feature-flag mechanism or a long-lived parallel development branch. For local and pre-merge work, branch/SHA installs test the exact change without publishing a channel.
