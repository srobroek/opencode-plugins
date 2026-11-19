# Governance, forge and defaults

Ask these as one round after the shape is chosen; every answer may be "later" (leave a
visible placeholder such as `@TODO-owner`, never invent one).

## Governance round

- Owner for `CODEOWNERS`: a user or team handle (`@owner`, `@org/team`). Default `* @owner`.
- Security contact for `SECURITY.md`: email or "use the forge's private vulnerability
  reporting". Private reporting only; no public issues with exploit details.
- Conduct contact: only if given. With no working contact, omit `CODE_OF_CONDUCT.md`.
- License (`license-picker`); `none` for an unpublished or work repository, which then
  needs no `LICENSE` and, for Rust, `[licenses.private] ignore = true` in `deny.toml`.
- Public or private repository (decides issue templates, SECURITY.md wording, CodeQL).

## Forge

GitHub is the default. Ask for GitLab, a self-hosted hostname (needed by worktrunk's
`[forge] hostname`), and the default branch (`main`). Other forges are a gap: say so, do
not improvise CI for them. On GitLab use `.gitlab-ci.yml` plus `.gitlab/` issue and merge
request templates, and no `.github/`; semantic-release instead of release-please
(`trunk-dev-release-setup`).

After you create a GitHub repository, set its merge settings once. GitHub has no default
for them, and a template repository does not copy them:

```sh
gh api repos/<owner>/<repo> --method PATCH -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=COMMIT_MESSAGES
```

With these settings, the squash subject is the PR title and the body lists the branch
commits. The
`delivery-git-workflow` skill's `repo-setup-parallel-agents.md` reference, section 6,
gives the reason.

## Defaults gate

Ask once: take the current pins and defaults, or customise? Name what they are so the
answer is informed: tool versions come from current stable at setup time (tell the user the
versions you pinned); job timeout 15 minutes; large-file hook limit 512 KB; commit scopes
unrestricted unless chosen; README install `mise install && just setup`; dev command
`just dev` (only if the project serves something). Do not interrogate each value; change
only what the user raises. Dependency bumps afterwards are Renovate's or Dependabot's job,
not an agent's.
