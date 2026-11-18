# Repository setup for parallel agents (GitHub)

When you create or review a repository's CI, branch protection or landing flow, use this standard. It applies when two or more agents land PRs into one repository at the same time. Workflow structure, action pinning and the `ci-gate` job are in the `ci-github-actions` skill. Release tooling is in `trunk-dev-release-setup`.

## 1. Land on main through a merge queue

- Land every change on main through a merge queue rule in main's ruleset ([managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
- Do not use epic or feature integration branches. They delay work that other workstreams need, collect conflicts in shared files and hide breakage until one large merge. A lead may merge the branches of its workers into its own PR branch (`delivery-fan-out`, FO-6). That one branch ships as one PR.
- Set the queue as follows, and adjust the numbers to the repository ([`merge_queue` rule parameters](https://docs.github.com/en/rest/repos/rules)):
  - `merge_method: SQUASH`.
  - `grouping_strategy: ALLGREEN` ("Only merge non-failing pull requests").
  - `max_entries_to_build: 5` and `max_entries_to_merge: 5`.
  - `min_entries_to_merge: 1` and `min_entries_to_merge_wait_minutes: 0`.
  - `check_response_timeout_minutes`: about twice the slowest full CI run.
- Keep the `pull_request` rule and the `required_status_checks` rule.
- Set `strict_required_status_checks_policy: false`, because a strict policy only forces rebases. The merge queue already tests each group against the latest main ([required status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging)).
- Give agents no bypass. Agents authenticate as the user, so do not add the repository admin role as a bypass actor. The release App in `trunk-dev-release-setup` is the only bypass actor.
- Enable "Automatically delete head branches" (`delete_branch_on_merge: true`) ([automatic deletion of branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)).
- Never run `gh pr merge --auto`. On a queue branch with checks still running, `gh pr merge` enables auto-merge. On a queue branch, `gh pr merge --delete-branch` fails.
- Land with `delivery_land`. On a queue branch it enqueues the reviewed head with `expectedHeadOid`, waits for the queue and proves the merge. It sends no `--delete-branch`, so the queue branch needs no special handling. A push to the PR head removes the PR from the queue. An installed delivery plugin older than merge-queue support merges directly and fails: update it ([pitfalls.md](pitfalls.md), "Landing into a branch that requires a merge queue").
- `delivery_land` cleans up the branch and worktree itself (`autoCleanup`, on by default). With an inactive bead ledger it cleans up inline. With an active ledger it skips the inline cleanup, because the beads close after the land, and retries when the agent's turn ends once the close-out steps in the result's `next` are done. The ledger needs no retiring first. Do not delete the branch or worktree by hand.
- `delivery_land` needs Git 2.38 or newer (`git merge-tree --write-tree` proves the landed content) and refuses on an older Git.
- Record the ruleset JSON in the repository, for example `.github/rulesets/main.json`, or in the PR that turned on the queue. Apply it with `gh api repos/<owner>/<repo>/rulesets --method POST --input <file>`.

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
      "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true,
      "require_code_owner_review": false, "require_last_push_approval": false,
      "required_review_thread_resolution": true, "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": false,
      "required_status_checks": [{ "context": "ci-gate" }] } },
    { "type": "merge_queue", "parameters": {
      "merge_method": "SQUASH", "grouping_strategy": "ALLGREEN",
      "max_entries_to_build": 5, "max_entries_to_merge": 5,
      "min_entries_to_merge": 1, "min_entries_to_merge_wait_minutes": 0,
      "check_response_timeout_minutes": 60 } }
  ]
}
```

### Without a merge queue

GitHub offers merge queues only in public repositories that an organization owns, and in private organization repositories on GitHub Enterprise Cloud. A personal account's repository has no queue. Transfer such a repository to an organization, or use this fallback:

- Set `strict_required_status_checks_policy: true`.
- Keep the full matrix on PRs: do not cut the PR lane (section 2).
- Land one PR at a time. Before you land the next PR, update its branch and let its checks pass.

## 2. Run two CI lanes

- The PR lane runs only what reviewers need:
  - Lint and static checks.
  - One primary build and test leg, for example Linux x64.
  - The oldest and the newest language version that the project supports.

  Keep one run well under the account's limit of concurrent jobs.
- The lane for the queue and main runs the full matrix: every OS and architecture, every language version and the slow suites. It runs on `merge_group` and on `push` to main ([`merge_group` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)).
- After the merge queue is live, cut the PR lane. Without a queue, a PR can land without a full-matrix run.
- Select the lane by event:

  ```yaml
  strategy:
    fail-fast: false
    matrix:
      os: ${{ github.event_name == 'pull_request' && fromJSON('["ubuntu-latest"]') || fromJSON('["ubuntu-latest","macos-latest","windows-latest"]') }}
  ```

  Give a slow suite `if: github.event_name != 'pull_request'`.
- Make one gate job, or a few, the required checks, and keep their names stable. Every required name must exist in both `pull_request` and `merge_group` runs. Otherwise the queue waits for a check that never reports ([troubleshooting status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)).
- Route jobs by the class of the changed paths. A change to docs only skips the heavy suites. A change to one language skips the suites of the other languages. A change to a CI file, for example in `.github/workflows/`, runs every job. Route inside the workflow, never with `paths:` on the trigger (`ci-github-actions`).
- In a `merge_group` run, the path filter compares the group against its base SHA (`github.event.merge_group.base_sha`), not against the diff of one PR. Before you rely on routing, test it in a queue run.

## 3. Do not spend CI on unfinished or superseded work

- A PR whose `draft` field is true runs no CI. Use these trigger types. While `draft` is true, each job skips:

  ```yaml
  on:
    pull_request:
      types: [opened, synchronize, reopened, ready_for_review]
    merge_group:
    push:
      branches: [main]
  jobs:
    test:
      if: ${{ !github.event.pull_request.draft }}
  ```

- A job that a condition skips reports success. So a gate must not pass for jobs that did not run. While `draft` is true, the first step of the gate fails:

  ```yaml
  ci-gate:
    if: always()
    needs: [changes, lint, test-rust, test-python]
    runs-on: ubuntu-latest
    steps:
      - if: ${{ github.event.pull_request.draft }}
        run: |
          echo "::error::draft: CI did not run. Mark the PR ready."
          exit 1
      - uses: re-actors/alls-green@<sha> # release/v1
        with:
          jobs: ${{ toJSON(needs) }}
          allowed-skips: test-rust, test-python # path-routed jobs only
  ```

- Agents open PRs with `gh pr create --draft`. When the work and local checks are done, the agent runs `gh pr ready`. For each fix round, it runs `gh pr ready --undo` and pushes. Then it runs `gh pr ready` again, which starts one full PR run.
- Cancel superseded runs on pull requests only ([control workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)):

  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```

  Never cancel a `merge_group` run or a push to main. Main must keep a result for every commit.
- Chained workflows follow the same skip and cancel rules. Examples are `workflow_run` workflows and reviewdog.

## 4. Caches and capacity

- Save build caches from main only. PR and queue runs restore them, because a run can restore caches from the default branch ([cache access restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache)).
  - Where the action has a save switch, set it from the main-only condition `github.event_name == 'push' && github.ref == 'refs/heads/main'`. `Swatinem/rust-cache` has `save-if`, and `astral-sh/setup-uv` has `save-cache`.
  - Where it has none, turn its built-in cache off and cache by hand. Every run uses `actions/cache/restore`, and only a push to main runs an `actions/cache/save` step gated on the same condition. `actions/setup-node` has neither switch: set `package-manager-cache: false` and leave `cache` unset ([advanced usage](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md)). `actions/setup-go` has no switch either: set `cache: false`. `actions/setup-python` has none: leave `cache` unset.
  - Check the inputs in the action's `action.yml` before you rely on a switch.
- Know the limit of concurrent jobs for each runner pool. GitHub Free allows 20 jobs. Of those, at most 5 run on macOS. See [Actions limits](https://docs.github.com/en/actions/reference/limits).
- Before you add a matrix leg, measure jobs per run and runner minutes per job on a sample of runs: `gh run view <run-id> --json jobs`.
- An agent that watches CI keeps one watch at a long interval. It reads `statusCheckRollup` through GraphQL rather than polling REST ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).

## 5. Guard shared files

- Add a CI check for every file that each new module or package must update. Examples: the release config's extra files, the workspace member list and the lock-file entries. These omissions pass PR CI one PR at a time and break main together, so fail the PR.
- When main goes red, the agent that sees it reports the failing run URL and the suspected PR.
- Do not land onto a red main. Check main first: `gh run list --branch main --event push --limit 1 --json conclusion,url`.

## 6. Dependency and release bots

- Dependabot PRs are not drafts. They run the PR lane and land through the queue.
- Store secrets that Dependabot-triggered workflows need as Dependabot secrets. Actions secrets are not available to them ([Dependabot on GitHub Actions](https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions)).
- Release tooling that reads commit messages (release-please, semantic-release) needs squash merges with Conventional Commit titles. The merge queue squashes with the repository's squash message setting, not with `delivery_land`'s subject. Set `squash_merge_commit_title: PR_TITLE` (`gh api repos/<owner>/<repo> --method PATCH -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY`) ([commit squashing](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests)).

## Checklist for an existing repository

1. `gh api repos/<owner>/<repo>/rules/branches/main` lists `merge_queue`, `pull_request` and `required_status_checks`. The status-check rule is not strict, and the ruleset has no bypass actor except the release App.
2. `gh api repos/<owner>/<repo> --jq '[.delete_branch_on_merge, .squash_merge_commit_title]'` is `[true, "PR_TITLE"]`.
3. The required checks are the gate jobs. Their names appear in both a `pull_request` run and a `merge_group` run.
4. A PR run uses the PR lane. A queue run and a push to main use the full matrix.
5. On a PR whose `draft` field is true, every job reports `skipping` and the gate fails with `draft: CI did not run`.
6. `cancel-in-progress` is true for `pull_request` only.
7. Caches save from pushes to main only.
8. A `merge_group` run tested the path routing: a docs-only group skipped the heavy suites, and a CI-file change ran everything.
9. A CI check fails a PR that adds a module or package without its release config, workspace and lock-file entries.
