# project

Project lifecycle skills. For now: picking a license.

| Skill | When |
| --- | --- |
| `license-picker` | "What license should I use", a new repository without one, relicensing, or a quick question about license mechanics, per-file headers or CLAs |

`license-picker` asks structured questions about the project, the threat model and
commercial goals, recommends an OSI-approved license from its decision matrix,
checks it against ecosystem norms, and offers to write the LICENSE file, manifest
field and headers. Its references live beside it in `references/`.

Ported from the omp-plugins `project` plugin; reference links are now relative
paths. The omp `project-managed-asset-promotion` rule is not ported: it governs
promoting machine-local omp skills and rules. This is the authoritative copy; the
earlier one under `~/.claude/skills` is gone.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/project'
```

Claude Code and Codex install the same skill from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install project@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add project@srobroek-opencode
```

A skill you already have with the same name wins over the plugin's copy.
