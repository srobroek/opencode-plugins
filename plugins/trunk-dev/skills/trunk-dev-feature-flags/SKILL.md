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
- **Applications and services:** use the [OpenFeature](https://openfeature.dev/docs/reference/concepts/evaluation-api) SDK when a maintained provider exists. Otherwise wrap the backend in the flag module behind `isEnabled(key, context)`. A custom provider needs approval. A provider swap preserves the API. Targeting, bucketing and analytics need separate migration checks.
- **CLIs, libraries and OpenCode plugins:** use a local option or environment accessor, such as `isEnabled("tally-priority")` reading `TALLY_PRIORITY=1`. Libraries take caller decisions and never fetch flags.
- **AWS runtime flags:** default to an [AppConfig feature flag profile](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-creating-configuration-and-profile-feature-flags.html) through the AppConfig Agent (Lambda extension on Lambda), with validators, deployment strategies and alarm rollback. SSM Parameter Store is for static settings, not the default rollout engine. Entitlements and tenant permissions belong in the domain database; rollout flags may restrict authorized access, never grant it.
- Temporary release flags default off to preserve existing behavior. Give each flag an explicit outage default and staleness policy; `false` must not disable a protection. Rust OpenFeature returns errors that the module maps to that default.

For code and storage details, read `quality-code-design`'s `feature-flags.md`; for AWS service specifics, read `aws-guidance`. Several teams or non-AWS services can use a hosted service with an OpenFeature provider or `flagd`; experiments need exposure and outcome metrics.

- In tests, use the SDK's in-memory provider (for example the [JavaScript](https://github.com/open-feature/js-sdk/blob/main/packages/server/src/provider/in-memory-provider/in-memory-provider.ts), [Go](https://pkg.go.dev/github.com/open-feature/go-sdk/openfeature/memprovider), or [Java](https://github.com/open-feature/java-sdk/blob/main/src/main/java/dev/openfeature/sdk/providers/memory/InMemoryProvider.java) one) to run both flag states without a backend.
- Use the same name in code, config, the backend, and the `Flag:` line.
- State in the MR/PR description how to turn the flag on, for example `TALLY_PRIORITY=1` or the AppConfig profile and flag key.
- A compile-time constant or bundler define is not a feature flag: switching it needs a rebuild. Use it only to keep dormant code out of a build, not for rollout or as a kill switch.
- After launch, a remote flag (AppConfig or a hosted service) can stay as a long-lived kill switch. Record it as an operational control in the cleanup chore, and remove temporary release flags on their date.

## Lifecycle and testing

- Temporary flags default off. Name one owner for rollout and removal. State a concrete removal date. When the owner finishes rollout or abandons the feature, they open a cleanup MR/PR and remove the flag and dead path.
- When a flagged `feat` PR/MR merges, trunk-dev creates a cleanup chore bead due on the recorded removal date. That covers `delivery_land`, `gh pr merge`, and `glab mr merge`. Do not create it in advance. If you must create one by hand, set `--due <removal date>` and `--metadata '{"trunk_dev_flag":"<name>"}'` so trunk-dev recognizes it. The named owner closes that chore with the flag-removal PR.
- CI tests both disabled and enabled states. Test flagged behavior in both states. Include relevant interactions when flags combine.
- To run unreleased flagged work locally, install the MR branch or pinned commit SHA. Enable the flag through an environment variable or local config, for example `FEATURE_FLAG_NAME=1`. Pre-merge previews also install the MR/PR branch or pinned SHA, or use a CI artifact built from that SHA. Do not use a moving `next`/`rc` branch: it can include unrelated changes and obscures the tested revision.
- Use truthful commit types. Dormant, not-yet-exposed plumbing is `refactor:` or `chore:`. A separate change that enables the capability for users is `feat:`. Flag removal and cleanup is `chore:` or `refactor:`. Do not mislabel a user-facing feature to avoid a release.

A published prerelease channel can be appropriate for real external testers who need an installable preview release. Treat it as an explicit opt-in testing exception, not the default feature-flag mechanism or a long-lived parallel development branch. For local and pre-merge work, branch/SHA installs test the exact change without publishing a channel.
