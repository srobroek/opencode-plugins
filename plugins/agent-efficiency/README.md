# agent-efficiency

Cuts tokens and wasted turns for agents running in OpenCode V2:

- runs calls to the nonexistent `bash` tool as the built-in `shell` tool;
- narrows the built-in `explore` agent to search and web tools with a short scout prompt;
- trims the system prompt of read-only subagents.

## Lead routing

`lead` defaults to `true`. Primary sessions with the `subagent` tool receive delegation instructions on context, compaction and generate requests.
The instructions route code work to `coder`, lookups to `explore`, bounded commands to `operator`, and reviews to the reviewer agents.
The plugin removes bullets whose agent ids are all unregistered. The session's filtered text stays fixed for prompt caching.
Deleting a session evicts its cached text.
Child sessions receive no lead block. Set `lead: false` to disable it.
When delivery also loads, set delivery's `fanOut: false` to avoid two lead blocks.

## Foreground wait guard

`waitGuard` defaults to `true`. Foreground shell calls that run `sleep` are refused, including aliases mapped to `shell`.
The guard checks command positions in chains, pipelines, loops and subshells, including `timeout N sleep`.
Quoted data such as `echo "sleep 5"` passes. Shell calls with `background: true` pass.
Here-document text passed to non-shell commands also passes, unless it contains an executable command substitution.
Shell scripts supplied through `-c` flags (including `-lc` and `-ec`) or standard-input here-documents are checked.
The guard also checks `eval` scripts and commands supplied to `xargs`.
Parameter expansions such as `${sleep}` are data; command substitutions inside them are checked.
Use a background watcher such as `gh pr checks 12 --watch` instead of foreground polling.
Set `waitGuard: false` to disable the guard.

## Large-read guard

An untargeted `read` of a big text file costs far more tokens than the part an agent needs. The guard refuses the first such read of each path in a session, with a message that points to `read` with `offset`/`limit`, `grep`, or delegating to `explore` (files) or `operator` (logs and command output). Spotify's "shunt" plugin ([Portal by Spotify cut my Claude Code token usage by 90%](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90)) takes the same approach. It also found that summaries lack line numbers, so the message asks for them and exact reads stay possible.

- It applies to primary sessions and to child sessions whose agent is in `largeRead.agents`. It never applies to `explore`, `operator`, `mechanic`, `researcher` or the reviewers.
- A `read` with no `offset` and no `limit` of a text file over `bytes` or `lines` is refused. A read with `offset` or `limit` always passes, as do images, PDFs and other binary files, directories and missing files.
- A shell command that runs `cat`, `less` or `more` on such a file is refused when its output is not piped or redirected. This covers `sh -c`, loops and `cd dir && cat file`. `head`, `tail`, `sed -n`, `grep`, `rg`, `wc`, `cat file | filter` and `cat > file` pass.
- Each path is refused once per session. A second untargeted read of the same path passes, so an agent that needs the whole file gets it.
- The size check reads at most 1 MiB, so the line count of a larger file is a lower bound. It runs asynchronously with a 500 ms deadline (`timeoutMs`); on a timeout, an error or a failed session lookup the read is allowed.

```jsonc
{ "options": { "largeRead": { "bytes": 32768, "lines": 350, "timeoutMs": 500, "agents": ["coder", "general", "implementer", "implementer-high"] } } }
```

## Subagent scratch reminders

`scratchReminder` defaults to `true`. In child sessions, the plugin watches write, edit, patch and shell write destinations under the scratch root.
The root is the real path of `os.tmpdir()` plus `opencode`. With `/tmp` as the temporary directory, it resolves to `/tmp/opencode` on Linux or `/private/tmp/opencode` on macOS.
Shell destinations include literal `mkdir` paths and `mktemp` templates. Dynamic paths that cannot be resolved statically are skipped.
Destinations follow literal `cd` commands, subshell scopes and wrapper working directories.
Creators inside shell scripts, `eval`, `xargs` and loop bodies use the same script discovery as the wait guard.
When a completed call creates a top-level scratch entry, its tool result asks the subagent to delete that entry before reporting.
Entries present before the call are never noted. Each session receives at most three notes, with each entry noted once.
Deleting a session clears its cached directory, pending calls and reminder history.
Subsequent calls retain the session's reminder counts unless the session is deleted.
Reminders do not change the system prompt. Set `scratchReminder: false` to disable them.

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
`trunk-dev`, `worktrunk`, `beads`, `chezmoi`, `speckit`) treat `bash` and
`Bash` as `shell`, so they hold in any order. Load this plugin first when you also
run third-party guards keyed on `shell`.

## Lean explore

The plugin reshapes the built-in `explore` agent:

- Tools: `read`, `grep`, `glob`, `websearch` and `webfetch`. No `shell`, so the
  shell tool description is not sent. Skills and `execute` (the Code Mode catalog)
  stay denied.
- Reading `.env` files and leaving the working directory ask first.
- Steps: 60. On the final step, OpenCode removes tools and asks for a summary.
- The prompt asks for a summary, the relevant files as `path:start-end` with what
  each holds, how the pieces connect, and the URLs of web sources.

It sets no model and no tier header. With `model-roles`, `explore` keeps its default
`cheap` tier; without it, `explore` runs on the session model.

The rules are appended after explore's own and start with `* deny`, so they replace
any `explore` permissions from your config. Set `explore: false` to keep the stock
agent and your config.

## Lean subagents

A subagent's system prompt repeats parts of the parent's that a read-only agent does
not need: the model identity block ("# Your Model") and the hint about moving a
session into a worktree. For child sessions of the agents in `leanSubagents`, a
`context` hook removes them before each request, and `compaction` and `generate`
hooks do the same for those requests. Every AGENTS.md stays by default: the user's
global one carries rules that apply everywhere, so keep it short, and the project's
tells explore and the reviewers about the project. Add `global-instructions` or
`project-instructions` to `leanDrop` to drop them too. The result depends only on the
agent and the prompt, so the prompt cache prefix holds across steps and compaction.

Each AGENTS.md file is its own "Instructions from: <path>" section. A file under the
global config directory (`OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode` or
`~/.config/opencode`, and their resolved paths) is `global-instructions`; every other
file, including `instructions` entries from your config, is `project-instructions`.

The default agents are read-only: `explore`, `pr-reviewer`, `adversarial-challenger`,
`design-critic`, `a11y-auditor`, `speckit-verify` and `speckit-sync`, plus `seance`,
`security-reviewer`, `code-reviewer`, `researcher`, `architect`, and cad's
`cad-mech-reviewer`, `cad-dfm-reviewer` and `cad-sourcing-researcher`. They keep every
AGENTS.md, so the project's still shapes their output. `journey-validator` writes run
files, so it is left out. Agents that change code
(`general`, `implementer*`, `operator`, `shepherd`, `mechanic`, `ui-implementer`) are
never trimmed unless you list them.

The environment block (working directory, platform) and the date stay. AGENTS.md
files that OpenCode loads later, when the agent reads a file under a directory with
its own AGENTS.md, still arrive as messages.

Measured on OpenCode 2.1.4 with Claude Haiku 4.5, one global AGENTS.md (869 bytes)
and one project AGENTS.md (3,981 bytes), first request in tokens:

| Agent | Untrimmed | Default (`identity`, `worktree`) | Plus `global-instructions` | `instructions`, `identity`, `worktree` |
| --- | --- | --- | --- | --- |
| `explore` | 3,587 | 3,484 | 3,194 | 1,993 |
| `adversarial-challenger` | 4,282 | 4,129 | 3,833 | 2,629 |

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
| `lead` | `true` | Adds primary-only delegation instructions. |
| `waitGuard` | `true` | Refuses foreground shell commands that run `sleep`. |
| `largeRead` | `true` | Refuses a first untargeted read of a large text file. `false` turns it off; an object sets `bytes` (32768), `lines` (350), `timeoutMs` (500) and `agents` (`coder`, `general`, `implementer`, `implementer-high`). |
| `scratchReminder` | `true` | Notes newly created scratch entries in child-session tool results. |
| `explore` | `true` | `false` keeps the built-in `explore` agent as OpenCode and your config define it. |
| `tools` | `["context7_*", "aws-mcp_*"]` | MCP tool patterns the narrowed `explore` may call, named `<server>_<tool>` (for example `["context7_*", "<server>_<tool>"]`). `false` or `[]` allows none. Only read-only tools belong here; a pattern matching a built-in action such as `shell`, `edit` or `*` is refused with a warning. The rules go after explore's own, so they win over its leading `* deny`. |
| `leanSubagents` | the read-only agents above | Agent ids whose child sessions get the trimmed prompt. `false` or `[]` turns it off. |
| `leanDrop` | `["identity", "worktree"]` | Which segments to remove: `global-instructions`, `project-instructions`, `identity`, `worktree`. `instructions` stands for both AGENTS.md segments. |
