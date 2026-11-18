# release-please on GitHub

## Token and credentials

Run [release-please-action](https://github.com/googleapis/release-please-action) with a GitHub App token, not `GITHUB_TOKEN`. Events from `GITHUB_TOKEN` do not start workflows, so a release PR it opens gets no CI ([action README](https://github.com/googleapis/release-please-action#readme), "Workflow Triggering").

- Mint the token with [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token#inputs), pinned to a SHA. Pass the App's client ID as `client-id`. Don't use the legacy `app-id` input.
- Store the client ID as the repository variable `RELEASE_APP_CLIENT_ID` and the private key as the secret `RELEASE_APP_PRIVATE_KEY` ([variables](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables), [secrets](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/using-secrets-in-github-actions)). An ID is not sensitive; the key is.
- Skip the release job while the App is not set up. `jobs.<job_id>.if` can read `vars` but not `secrets` ([context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)), so test the variable:

  ```yaml
  release:
    if: ${{ vars.RELEASE_APP_CLIENT_ID != '' }}
  ```

  An unset variable is an empty string, so the job is skipped, not failed, in forks and new repositories.

## First release

release-please inserts its entry above the first version heading it finds (`\n###? v?[0-9[]`) and leaves earlier text where it is ([`Changelog` updater](https://github.com/googleapis/release-please/blob/main/src/updaters/changelog.ts)). A hand-written `## Unreleased` section therefore stays above the new entry and is never folded in. Move its items into the first release PR by hand: edit the PR's changelog and delete the `## Unreleased` heading before you merge it.

## Version records

A release PR bumps the version in every file the config lists ([manifest releaser](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)). Tests should check that those records agree (manifest, package files, generated catalogs), never that they equal a literal version, or each release PR breaks them.

## Pre-release checks

Before you merge a release PR:

- `reuse lint` passes, so shipped files carry license data (`license-picker`, `references/reuse.md`).
- The version-record test and the repository's check command pass on the release PR.
