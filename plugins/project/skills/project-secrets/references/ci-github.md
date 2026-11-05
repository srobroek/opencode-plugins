# Secrets in GitHub Actions

Sources: https://fnox.jdx.dev/guide/ci, /guide/push, /targets/github-actions,
/providers/1password. Ask which approach the user wants; they can be combined.

## A. One service account, fnox reads at run time (preferred)

Only one value ever lives in GitHub: the token. Secrets stay in 1Password and rotate there.

1. Needs the project secrets in a non-Private vault (`proj-<name>` or `dev-shared`).
   Service accounts cannot reach Private, Personal, Employee or the default Shared vault,
   cannot change their vaults after creation, and are rate limited.
2. The user creates a read-only account (the token prints once, so it is theirs to handle;
   do not run this yourself):

   ```sh
   op service-account create "<project> ci" --vault proj-<name>:read_items --expires-in 90d
   ```

   Flags: `--vault <name>:<permission>` (`read_items` default), `--expires-in`, `--raw`
   (token only). Add `--vault dev-shared:read_items` only if CI needs shared keys.
3. The user stores the token as repository secret `OP_SERVICE_ACCOUNT_TOKEN`
   (`gh secret set OP_SERVICE_ACCOUNT_TOKEN`, pasted at the prompt) and also keeps it in 1Password.
4. Workflow (pin actions to SHAs, see `ci-github-actions`):

   ```yaml
   - uses: jdx/mise-action@<sha>            # installs fnox pinned in mise.toml
   - uses: 1Password/install-cli-action@<sha>   # `op`, which fnox's 1password provider runs
   - run: fnox --non-interactive exec --if-missing error -- bun test
     env:
       OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
   ```

   Verify the 1Password action name and inputs on its README before writing it. Add
   `- run: fnox ci-redact` before steps that might print values. Use `fnox check --all`
   as an early step. The local sync cache is not used in CI.
5. Forks: `pull_request` from forks gets no secrets; set `FNOX_IF_MISSING: ignore` only in
   a fork-safe job. Never run fork code in `pull_request_target` with this token.

## B. Push values into GitHub secrets with `fnox push`

Use when the workflow wants plain GitHub secrets (a deploy action that reads
`${{ secrets.X }}`), or the repo should not hold a 1Password token. Experimental in fnox.

```toml
[targets.gh]
type = "github-actions"
repo = "owner/name"            # default: the current directory's repository
# environment = "production"   # an environment secret instead of a repository secret
# org / visibility / repos / app = "actions" | "dependabot" | "codespaces"

[targets.gh-prod]
type = "github-actions"
repo = "owner/name"
environment = "production"

[secrets]
STRIPE_KEY = { provider = "proj", value = "myapp stripe/credential", env = "exec", push = ["gh-prod"] }
```

```sh
fnox push --dry-run            # preview; also: fnox push KEY, --target gh-prod, --force
fnox push                      # asks to confirm
```

- Needs `gh` logged in (`gh auth login`) as someone who can manage secrets. The value goes
  over stdin to `gh secret set`; it is write-only afterwards, so re-run after rotation.
- The GitHub secret name is the fnox key. Names starting with `GITHUB_` are refused.
- Anyone who can change code that runs with the secret can print it; use environments
  with required reviewers for production values. `push` is per secret, so non-pushed
  secrets stay local.
- Profiles can redefine a target, so `fnox -P production push` goes to another environment.
- Ask before pushing: it changes a remote repository. Offer `--dry-run` output first.
