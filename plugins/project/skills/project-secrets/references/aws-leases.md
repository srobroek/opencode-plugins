# AWS credentials for personal (non-Isengard) projects

Sources: https://fnox.jdx.dev/guide/leases, /leases/aws-sts, /leases/command.
Amazon-internal Isengard accounts use their own tooling (`ada`, Isengard); do not use
fnox leases for them. Ask: which AWS organization or account, is IAM Identity Center
(SSO) set up, which role does the project need, which region?

## Baseline: IAM Identity Center profile

Use `aws sso login --profile <profile>` and `AWS_PROFILE=<profile>`; no stored key. Run
project commands with the profile set (`AWS_PROFILE=<profile> aws ...`, or in the mise
task env). Often this is enough. Avoid IAM user access keys.

## Least privilege per project: `aws-sts` lease

When a project should run with a narrow role rather than the SSO role:

```toml
[leases.aws]
type = "aws-sts"
region = "eu-west-1"
role_arn = "arn:aws:iam::<account>:role/<project>-dev"   # trust policy allows the caller
profile = "<sso-profile>"        # bootstrap identity used to call AssumeRole
duration = "1h"                  # default 15m; max 12h, capped by the role's max session
```

```sh
aws sso login --profile <sso-profile>
fnox exec -- aws sts get-caller-identity     # shows the assumed role; leaks no key
```

`fnox exec` creates the lease, injects `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
`AWS_SESSION_TOKEN`, and reuses it until about 5 minutes before expiry
(`fnox lease list --active`). Leases cannot be revoked early: they expire. The caller needs
`sts:AssumeRole` on the role. Assuming a role from an SSO session is role chaining, which
AWS limits to 1 hour, so keep `duration` at `"1h"` or less for that setup. The session
name appears in CloudTrail as `fnox-exec-<lease>`. If leases are not reused between runs,
check `fnox lease list` and that the project's `default_provider` can encrypt (a project
age provider); the user's global config has none.

Without a `profile`, fnox uses the SDK's default chain (env keys, `AWS_PROFILE`,
`~/.aws/config`). Under `fnox exec`, missing bootstrap credentials only skip the lease
with a warning, so run `fnox exec -- aws sts get-caller-identity` to confirm.

## Mirror the SSO session: `command` lease

If the SSO role itself is right but the tool needs plain env credentials:

```toml
[leases.aws]
type = "command"
create_command = "aws configure export-credentials --profile <sso-profile> --format process | jq '{credentials: {AWS_ACCESS_KEY_ID: .AccessKeyId, AWS_SECRET_ACCESS_KEY: .SecretAccessKey, AWS_SESSION_TOKEN: .SessionToken}, expires_at: .Expiration}'"
```

The command must print one JSON object `{credentials: {...}, expires_at}` on stdout
(strings only, RFC 3339 expiry) and diagnostics on stderr. A `command` lease resolves the
whole profile and is skipped when `--only`/`--except` is used. `fnox get` cannot read
its keys; use `fnox exec`. Needs `jq` (pin it with mise). The output shape of
`export-credentials --format process` follows the `credential_process` schema; test with a
real profile before relying on it.

## IAM user keys (last resort)

Only when no SSO or role is possible. Create the item in 1Password. The agent can store a key from `aws iam create-access-key` with the forms in `references/store.md`,
reference it as the lease's bootstrap, and keep it out of commands:

```toml
[secrets]
AWS_ACCESS_KEY_ID     = { provider = "proj", value = "aws iam/access key id",     env = false }
AWS_SECRET_ACCESS_KEY = { provider = "proj", value = "aws iam/secret access key", env = false }
```

Combine with the `aws-sts` lease above so commands only ever see temporary credentials.
Never use the `plain` provider for them. Ask the user to rotate the key on a schedule.
