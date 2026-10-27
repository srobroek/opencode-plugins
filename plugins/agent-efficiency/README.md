# agent-efficiency

Cuts tokens and wasted turns for agents running in OpenCode V2:

- runs calls to the nonexistent `bash` tool as the built-in `shell` tool;
- narrows the built-in `explore` agent to search and web tools with a short scout prompt;
- trims the system prompt of read-only subagents.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/agent-efficiency'
```

## bash alias

Models trained on other harnesses call a `bash` tool. OpenCode V2 names it `shell`,
so each such call fails with "No tool named bash" and the model retries. This plugin
runs a `bash` (or `Bash`) call as the built-in `shell` call it means.

OpenCode runs `tool.hook("execute.before")` before it looks the tool up, and a hook
may rename the call. The plugin's hook renames `bash` and `Bash` to `shell` and maps
the input to `shell`'s shape:

- `command` as a string, or as an argv array (`["bash", "-lc", "script"]` runs
  `script`; another array is shell-quoted and joined). `cmd` is read the same way.
- `workdir`, `cwd` or `working_directory` becomes `workdir`.
- `timeout` or `timeout_ms` (milliseconds) becomes `timeout`.
- `background` or `run_in_background` becomes `background`.
- Every other field, such as `description`, is dropped.

The call then runs as the built-in `shell` tool, not a copy: the same permission
rules and prompts, timeout, working directory checks and background jobs. Every
`execute.after` hook sees `shell`. If the session's agent cannot use `shell`, the
call fails just as a `shell` call would.

Nothing is added to the request: no tool definition and no system prompt text.

A plugin that registers a real `bash` tool keeps it; the hook leaves the call alone.

### Ordering with guards

Hooks run in plugin load order. A guard whose `execute.before` hook runs before this
plugin's sees the call still named `bash`. The guards in this repository (`safety`,
`trunk-dev`, `worktrunk`, `beads`, `chezmoi`, `rust`, `speckit`) treat `bash` and
`Bash` as `shell`, so they hold in any order. Load this plugin first when you also
run third-party guards keyed on `shell`.

## Lean explore

The plugin reshapes the built-in `explore` agent:

- Tools: `read`, `grep`, `glob`, `websearch` and `webfetch`. No `shell`, so the
  shell tool description is not sent. Skills and `execute` (the Code Mode catalog)
  stay denied.
- Reading `.env` files and leaving the working directory ask first.
- The prompt asks for a summary, the relevant files as `path:start-end` with what
  each holds, how the pieces connect, and the URLs of web sources.

It sets no model and no tier header. With `model-roles`, `explore` keeps its default
`cheap` tier; without it, `explore` runs on the session model.

The rules are appended after explore's own and start with `* deny`, so they replace
any `explore` permissions from your config. Set `explore: false` to keep the stock
agent and your config.

## Lean subagents

A subagent's system prompt repeats parts of the parent's that a read-only agent does
not need: the user's global AGENTS.md (push and scratch rules), the model identity
block ("# Your Model") and the hint about moving a session into a worktree. For child
sessions of the agents in `leanSubagents`, a `context` hook removes them before each
request. The project's AGENTS.md stays, so explore and the reviewers still know the
project. The result depends only on the agent and the prompt, so the prompt cache
prefix holds across steps.

Each AGENTS.md file is its own "Instructions from: <path>" section. A file under the
global config directory (`OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode` or
`~/.config/opencode`, and their resolved paths) is `global-instructions`; every other
file, including `instructions` entries from your config, is `project-instructions`.

The default agents are read-only: `explore`, `pr-reviewer`, `adversarial-challenger`,
`design-critic`, `a11y-auditor` and `speckit-verify`, plus `seance`,
`security-reviewer` and `code-reviewer`. `architect` and `journey-validator` are left
out because the project's AGENTS.md shapes their output. Agents that change code
(`general`, `implementer*`, `operator`, `shepherd`, `mechanic`, `ui-implementer`) are
never trimmed unless you list them.

The environment block (working directory, platform) and the date stay. AGENTS.md
files that OpenCode loads later, when the agent reads a file under a directory with
its own AGENTS.md, still arrive as messages.

Measured on OpenCode 2.1.4 with Claude Haiku 4.5, one global AGENTS.md (869 bytes)
and one project AGENTS.md (3,981 bytes), first request in tokens:

| Agent | Untrimmed | Default (`global-instructions`, `identity`, `worktree`) | `instructions`, `identity`, `worktree` |
| --- | --- | --- | --- |
| `explore` | 3,536 | 3,148 | 1,948 |
| `adversarial-challenger` | 4,792 | 4,404 | 3,204 |

Providers cache only prompt prefixes above a minimum (4,096 tokens for Claude Haiku
4.5 on Bedrock), so a prompt this short may be sent uncached until the conversation
grows.

## Shell permissions and compound commands

OpenCode already splits a compound command into its simple commands and checks each
one against the `shell` rules. `cd` (and `pushd`, `popd`, `chdir`) is not checked as
a command; its target is checked as a directory instead. With `shell: "git *"` allowed:

| Command | Result |
| --- | --- |
| `cd sub && git status` | allowed |
| `cd sub; git status` | allowed |
| `git status 2>&1` | allowed |
| `git log \| head -1` | denied: `head` needs its own rule |
| `cd sub && git status && touch f` | denied: `touch` |
| `cd /outside && git status` | denied by `external_directory`, not `shell` |

So when `cd X && git diff` fails in a subagent, X is outside the session's directory
(often a worktree) and the agent's `external_directory` rule, usually the `* deny` it
starts with, rejects it. Moving the call into `workdir` does not help: OpenCode checks
`workdir` against the same rule. Allow the worktree root for that agent in your config, for example
`external_directory: "~/tmp/worktrees/*"`, or start the subagent in the worktree. No
`shell` pattern is needed, and none should be widened to cover `&& anything`.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "github:srobroek/opencode-plugins::path:plugins/agent-efficiency",
      "options": { "leanSubagents": ["explore", "pr-reviewer"], "leanDrop": ["instructions", "identity"] }
    }
  ]
}
```

| Option | Default | Effect |
| --- | --- | --- |
| `bashAlias` | `true` | `false` leaves `bash` calls to fail as unknown tools. |
| `explore` | `true` | `false` keeps the built-in `explore` agent as OpenCode and your config define it. |
| `leanSubagents` | the read-only agents above | Agent ids whose child sessions get the trimmed prompt. `false` or `[]` turns it off. |
| `leanDrop` | `["global-instructions", "identity", "worktree"]` | Which segments to remove: `global-instructions`, `project-instructions`, `identity`, `worktree`. `instructions` stands for both AGENTS.md segments. |
