# debate

Stress-test a decision before committing to it. Three skills:

| Skill | When |
| --- | --- |
| `debate` | Two-sided analysis of an architectural decision, technology choice or feature proposal, with a conditional verdict |
| `grilling` | Interview the user in numbered frontier rounds until every branch of a plan is settled; `debate` routes deeper interviews here |
| `to-questionnaire` | User-invoked only: turn a decision the user cannot answer alone into a questionnaire for one other person, written to a named path or `~/tmp` |

Ported from the omp-plugins `debate` plugin. The content is unchanged apart from
references to other skills, which now name the skill. These are the authoritative
copies; earlier copies under `~/.claude/skills` are gone.

`grilling` and `to-questionnaire` are vendored in modified form from
[mattpocock/skills](https://github.com/mattpocock/skills) under the MIT licence. Each
skill directory carries the licence text and a NOTICE listing the changes.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/debate'
```

Claude Code and Codex install the same skills from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install debate@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add debate@srobroek-opencode
```

A skill you already have with the same name wins over the plugin's copy.
