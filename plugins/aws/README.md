# aws

AWS working guidance as the `aws-guidance` skill, plus the two MCP servers it relies
on, added in AWS projects.

| Skill | When |
| --- | --- |
| `aws-guidance` | Any AWS task: search the AWS MCP Server for a guided AWS skill first, verify API details against AWS documentation, price with `aws-pricing`, and route secrets through the `aws-secrets-manager` skill |

## MCP servers

The plugin adds the servers in [`.mcp.json`](.mcp.json), with pinned versions:

| Server | Command | Scope |
| --- | --- | --- |
| `aws-mcp` | `uvx mcp-proxy-for-aws-cli@1.7.0 https://aws-mcp.us-east-1.api.aws/mcp --read-only --skip-auth` | AWS documentation search, guided AWS skills, regions and regional availability. `--read-only` hides every tool that can change AWS resources; `--skip-auth` lets the documentation and skill tools work without credentials. Queries go to the AWS-hosted endpoint, and authenticated calls appear in CloudTrail for the signing account |
| `aws-pricing` | `uvx --with botocore[crt] awslabs.aws-pricing-mcp-server@1.1.1`, with `AWS_REGION=us-east-1` | AWS Price List queries in `us-east-1` and Terraform or CDK cost analysis. The `botocore[crt]` extra loads credentials created by `aws login` |

In OpenCode both run in Code Mode with a 120 s startup timeout, since the first start
downloads the `uvx` environment, and `aws-mcp` gets a 100 s execution timeout.

Prerequisites: `uv` on `PATH`, and AWS credentials in the default chain for
authenticated calls (set `AWS_PROFILE` before starting OpenCode to pick a profile).

### When OpenCode adds them

By default (`mcp: "auto"`) the plugin adds the servers only where the session's
directory or its project root looks like AWS work, so a globally installed plugin
does not start two `uvx` processes in every project. It checks, without recursing:

- `cdk.json`, `cdk.context.json`, `samconfig.*`, `.aws-sam/`, `serverless.{yml,yaml,ts}`,
  `amplify/backend.ts`, `amplify/.config`, `copilot/.workspace`, `.chalice/`,
  `buildspec.yml` or `appspec.yml`
- a `*.tf` file naming the AWS provider, or a CloudFormation or SAM template, at the
  root or in `infra/`, `infrastructure/`, `terraform/`, `iac/`, `deploy/`,
  `cloudformation/` or `cfn/`
- a Pulumi stack file with `aws:` config
- an AWS dependency: `aws-cdk-lib`, `@aws-sdk/*`, `@pulumi/aws`, `serverless` or `sst`
  in `package.json`; `boto3`, `aws-cdk-lib` or `pulumi-aws` in `requirements.txt`,
  `pyproject.toml`, `Pipfile` or `setup.py`; the AWS SDK or CDK in `go.mod`

The check runs when the plugin loads for a directory; run `/reload` after adding the
first marker to a new project.

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/opencode-plugins::path:plugins/aws",
    "options": {
      "mcp": "always",                          // "auto" (default), "always", or "off" for no servers
      "mcpServers": { "aws-pricing": false }    // turn single servers off (or on) by name
    }
  }]
}
```

A server under the same name in your `opencode.json` wins: the plugin leaves it as you
configured it. Use that to change flags or versions, for example to add `--profile`,
or set `"disabled": true` to keep it configured but off.

### Claude Code and Codex

The marketplace export ships the same `.mcp.json`, so installing the plugin there
starts both servers in every project; there is no project check. Disable them per
project in that harness's MCP settings when they are not wanted. Neither file uses
`${VAR}` substitution, which Codex does not expand in a plugin's `.mcp.json`.

## Changes from omp

- `aws-guidance` was an always-applied rule. It is now a skill, loaded when the
  task is about AWS. To make it always on in an AWS project, copy its body into
  that project's `AGENTS.md`.
- `aws-skill-first`, a TTSR reminder on the first `aws`, `cdk` or `sam` shell
  command, is folded into the first bullet of `aws-guidance`.
- The skill says to report checks it could not run when a server is missing.
- The servers are pinned instead of `@latest` and, in OpenCode, added only in AWS
  projects instead of wherever the plugin is installed.

Both omp rules adapted the rules file from
[Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws/blob/main/rules/aws-agent-rules.md)
(Apache-2.0).

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/aws'
```

Claude Code and Codex install the skill and both servers from this repository's
marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install aws@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add aws@srobroek-opencode
```
