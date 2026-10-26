# aws

AWS working guidance as the `aws-guidance` skill, plus the config for the two MCP
servers it relies on.

| Skill | When |
| --- | --- |
| `aws-guidance` | Any AWS task: search the AWS MCP Server for a guided AWS skill first, verify API details against AWS documentation, price with `aws-pricing`, and route secrets through the `aws-secrets-manager` skill |

## MCP servers

The plugin does not add the servers. Add them to `opencode.json` in the projects
that do AWS work:

```jsonc
{
  "mcp": {
    "servers": {
      "aws-mcp": {
        "type": "local",
        "command": [
          "uvx", "mcp-proxy-for-aws-cli@latest",
          "https://aws-mcp.us-east-1.api.aws/mcp", "--read-only", "--skip-auth"
        ],
        "timeout": { "execution": 100000 }
      },
      "aws-pricing": {
        "type": "local",
        "command": ["uvx", "--with", "botocore[crt]", "awslabs.aws-pricing-mcp-server@latest"],
        "environment": { "AWS_REGION": "us-east-1", "FASTMCP_LOG_LEVEL": "ERROR" }
      }
    }
  }
}
```

| Server | Scope |
| --- | --- |
| `aws-mcp` | AWS documentation search, guided AWS skills, regions and regional availability. `--read-only` hides every tool that can change AWS resources; `--skip-auth` lets the documentation and skill tools work without credentials. Queries go to the AWS-hosted endpoint, and authenticated calls appear in CloudTrail for the signing account |
| `aws-pricing` | AWS Price List queries in `us-east-1` and Terraform or CDK cost analysis. The `botocore[crt]` extra loads credentials created by `aws login` |

Prerequisites: `uv` on `PATH`, and AWS credentials in the default chain for
authenticated calls (set `AWS_PROFILE` before starting OpenCode to pick a profile).

### Why the plugin does not add them

`ctx.mcp.transform` could set both servers, but that is not clearly right here:

- OpenCode plugins are usually installed globally. A plugin-added server would
  start two `uvx` processes, running unpinned `@latest` packages and a proxy to a
  remote AWS endpoint, in every project, including ones that never touch AWS. On
  omp the plugin was installed per project for this reason.
- A server added by a transform is not in your config, so you cannot see it there,
  change its flags or pin its versions without overriding the plugin.
- The same skill ships to Claude Code and Codex, where an `.mcp.json` would also
  start the servers on install.

A config entry keeps the choice per project and visible. An opt-in plugin option
that calls `ctx.mcp.transform` can come later if the snippet proves tedious.

## Changes from omp

- `aws-guidance` was an always-applied rule. It is now a skill, loaded when the
  task is about AWS. To make it always on in an AWS project, copy its body into
  that project's `AGENTS.md`.
- `aws-skill-first`, a TTSR reminder on the first `aws`, `cdk` or `sam` shell
  command, is folded into the first bullet of `aws-guidance`.
- The skill no longer assumes the servers came from the plugin, and says to report
  checks it could not run when a server is missing.

Both omp rules adapted the rules file from
[Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws/blob/main/rules/aws-agent-rules.md)
(Apache-2.0).

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/aws'
```

Claude Code and Codex install the skill from this repository's marketplace; add
the two servers to their MCP config the same way:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install aws@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add aws@srobroek-opencode
```
