# toolchain

Toolchain, backend, infrastructure and operations defaults, as skills the model
loads when the description matches.

In OpenCode the `toolchain-*` and `ops-*` skills set `opencode/autoinvoke: false` and are
listed as one router, `toolchain-guide`, whose body maps each situation to the skill to load
by id; the other skills stay listed. Claude Code and Codex ignore that metadata, so there
every skill is listed and triggers directly.

| Skill | When |
| --- | --- |
| `toolchain-stack-defaults` | Stack, package manager, task runner, adding a dependency (bun, uv, mise, just; deps through the package manager CLI) |
| `toolchain-frontend` | Frontend framework, UI kit, client and server state |
| `toolchain-infrastructure` | Terraform/OpenTofu vs CDK vs Kubernetes and Helm |
| `toolchain-languages` | Per-language library and tool picks (Rust, TypeScript, Python, Go) |
| `toolchain-quality-observability` | Logging, tracing, security scanners |
| `toolchain-asset-ownership` | Where OpenCode config, plugins, skills and agents live: chezmoi, this repository |
| `coexistence-worktree` | Other agents or humans editing the same checkout; moving to a linked worktree |
| `shell-language` | Shell portability, quoting, command safety, shellcheck |
| `terraform-language` | Terraform, OpenTofu and HCL conventions |
| `infrastructure-tfstate-guard` | Any Terraform or OpenTofu state operation or `*.tfstate` edit |
| `backend-background-jobs` | Workers, queues, retries, idempotency, dead letters |
| `ops-toolchain-cache-policy` | Shared, bounded download and compiler caches; worktree build output |
| `ops-no-global-cargo-target` | Setting `CARGO_TARGET_DIR` or `[build].target-dir` to a global directory |

## Changes from omp

On omp these were rules. Three were tool-triggered (TTSR) rules that fired on a
matching shell command or file edit; here every rule is a skill, and the regex
triggers are gone.

- `infrastructure-tfstate-guard` interrupted `terraform state rm/mv/push`, `rm`
  of a `*.tfstate` file, and redirects over `terraform.tfstate`. To keep a hard
  gate, add permission rules (test each pattern before relying on it):

  ```jsonc
  {
    "permissions": [
      { "action": "edit", "resource": "**/*.tfstate", "effect": "deny" },
      { "action": "edit", "resource": "**/*.tfstate.*", "effect": "deny" },
      { "action": "shell", "resource": "terraform state rm *", "effect": "ask" },
      { "action": "shell", "resource": "terraform state mv *", "effect": "ask" },
      { "action": "shell", "resource": "terraform state push *", "effect": "ask" },
      { "action": "shell", "resource": "tofu state rm *", "effect": "ask" },
      { "action": "shell", "resource": "tofu state mv *", "effect": "ask" },
      { "action": "shell", "resource": "tofu state push *", "effect": "ask" }
    ]
  }
  ```

- `ops-no-global-cargo-target` advised on edits that set a global Cargo target
  directory in `.cargo/config.toml`, shell profiles, mise config or CI workflows.
- `toolchain-asset-ownership` described omp config under `~/.omp/agent/` and the
  omp marketplace; it now describes `~/.config/opencode/` and this repository.
- `toolchain-stack-defaults` no longer mentions the omp `prefer-tools-advisory` and
  `dep-manifest-advisory` extensions, which are not ported.
- References to other rules and skills name the skill (`quality-code-design` is in
  the quality plugin; `chezmoi-editor` is not in this repository).

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/toolchain'
```

Claude Code and Codex install the same skills from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install toolchain@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add toolchain@srobroek-opencode
```
