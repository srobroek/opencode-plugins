# claude-compat

Loads Claude Code plugins into OpenCode at runtime, straight from their repositories:
a marketplace directory (`.claude-plugin/marketplace.json`) or a single plugin
directory (`.claude-plugin/plugin.json`). Nothing is copied or converted on disk.
Per project it registers the plugins' skills, agents (as new subagents), commands,
`.mcp.json` servers, and the command hooks OpenCode can express.

Only point it at plugins you trust. Their hooks and MCP servers are programs that
run on your machine, and their skills and agents are instructions the model follows.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/claude-compat'
```

## Configure

Sources can be set in three places. All three apply together, and relative paths
resolve against the **project root** (the location's project directory, so a session
started in a subdirectory or a worktree still finds them).

The loader is default-off during rollout: set `enabled: true` in its plugin options
to activate it. With `enabled` absent or false, it discovers no sources and registers
no skills, agents, commands, hooks or MCP servers. Setting it back to false disables
the loader on config reload.

1. **Plugin options, for every project.** Put them in the global config
   (`~/.config/opencode/opencode.json`):

   ```jsonc
   {
     "plugins": [{
       "package": "github:srobroek/opencode-plugins::path:plugins/claude-compat",
        "options": {
          "enabled": true,
         "sources": [{ "path": "~/src/pace-claude-plugins" }],
         "plugins": ["prototype", "proto-report"]
       }
     }]
   }
   ```

2. **`projects`, per project, from the global config.** Each key is a directory; an
   entry applies to that project and any project inside it:

   ```jsonc
    "options": {
      "enabled": true,
     "projects": {
       "~/work/customer-a": { "sources": [{ "path": "./.claude/marketplace" }], "plugins": ["aidlc"] }
     }
   }
   ```

3. **The project's own `.opencode/claude-compat.json`, opt-in and approval-gated.**
   It takes the same `{ "sources", "plugins" }` shape. Set `"projectFile": true` in
   the plugin options to discover it; the default is **false**. No skills, agents,
   commands, hooks, instructions or MCP servers from it load until you explicitly
   run `/claude-compat-trust` and approve the `claude_compat_trust` permission prompt.
   A global allow-all rule cannot silently approve this permission; a deny still wins.

   The permission resource is the canonical file path plus a SHA-256 digest of its
   contents and every source it names. Local sources are hashed recursively (paths,
   contents, executable bits and symlink targets, including `.git`). Approval is
   remembered in plugin storage per digest, so changing the file or a source requires
   approval again on reload. Unreadable/oversized sources cannot be approved. Git
   sources in project files must pin a full commit SHA; their URL and SHA are hashed
   without fetching unapproved content. An existing cached checkout is also hashed;
    the first approval permits downloading only. The clone changes the digest and stays
    inactive until you run `/claude-compat-trust` again to approve its contents. No reload
    is needed. Activation rechecks the approval after downloads, before reading plugins.
   A change while the prompt is open invalidates
   the approval. Configure only trusted sources in plugin options or the `projects`
   map: those are explicit installs and do not use this gate.

A plugin entry in a project's `opencode.json` replaces the global entry's options; it
does not merge with them. Use `projects` or the project file to add sources for a
single project while keeping the global ones.

A source is `{ "path": "..." }` or `{ "git": "<url>", "ref": "<commit or tag>" }`. A git
source is cloned once into `$XDG_CACHE_HOME/opencode/claude-compat/<hash of url and ref>`
and never updated, so pin an immutable commit. `plugins` filters its group's sources by
plugin name. Without it, every plugin in the marketplace loads. Marketplace entries must
be local paths inside the marketplace, symlinks included. Remote entries (`github`,
`git`, `url`) are reported and skipped.

| Option | Default | Effect |
| --- | --- | --- |
| `enabled` | `false` | Rollout switch: activate the loader; false registers nothing. |
| `sources`, `plugins` | none | Sources for every project that uses this entry. |
| `projects` | none | Directory → `{ sources, plugins }`, applied to that project and the ones inside it. |
| `projectFile` | `false` | Discover `<project>/.opencode/claude-compat.json`; load only after `/claude-compat-trust` approval. |
| `untypedAgents` | `"inherit"` | Agents without `tools:`: `inherit` keeps the session's permissions, `deny` allows nothing. |
| `hooks` | `true` | Run the supported command hooks. |
| `mcp`, `mcpServers` | `"auto"` | `off`, or `always`/`auto` to add servers; `mcpServers: { "<name>": false }` turns single servers off. |
| `instructions` | `false` | Add each plugin's root `CLAUDE.md` to the system prompt. |
| `toolNote` | `true` | Append the Claude → OpenCode tool-name note to every agent prompt. |
| `env` | `[]` | Extra host environment variable names to pass to hooks; values are not specified here. |

Run the `claude_compat_check` tool to see what loaded for the current project and
everything that was dropped or could not be converted.

## Isolation and caching

Every setup works out its project root and reads only the sources configured for that
project. Parsed plugins are cached in memory under a key that starts with the project
root, so two projects never share an entry. Locations within one project share an entry
until the last of them is unloaded, and the next load reads the sources again. Hooks,
the SessionStart listener and the `CLAUDE.md` instructions also check that a session's
directory is inside the project before acting. Tool hooks and instruction hooks fetch
the session directory on every call, so a moved session does not retain its old cwd or
project decision.

## What maps to what

### Skills

`skills/<name>/SKILL.md`, plus any directory in the manifest's `skills`. The skill keeps
its absolute path, so `references/` and scripts beside it resolve. Ids are the skill's
frontmatter `name`, not namespaced. Your own skill of the same name wins, and so does
the first plugin to ship a name. `allowed-tools` is reported, not enforced.

### Agents

`agents/**/*.md`, plus any manifest `agents` paths. Each becomes a **new** subagent with
the id `<plugin>:<name>`, registered through the shared agent loader. If you define an
agent with that id yourself, the imported agent is **skipped**, left untouched and
reported in `claude_compat_check`.

`tools:` becomes a fail-closed permission list: `*` is denied first, then each mapped
tool is allowed. Names that do not map are dropped with a diagnostic and never allowed.
Rule patterns carry over as resources: `Bash(git:*)` allows `shell` on `git *`, and
`Read(src/**)` allows `read` on `src/**`. `disallowedTools` entries become denies after
the allows. An agent with any allowed tool also gets `external_directory: ask`, so files
outside the project stay reachable with approval. Every read/edit grant, including
scoped grants such as `Read(**)` and `Write(src/**)`, restores sensitive `.env`/`.env.*`
asks inside that grant. These may conservatively ask for `.env.example` too.

Imported permission grants never override user/global denies or asks. Registration
intersects the policies rather than blindly appending grants after user restrictions;
a permission-evaluation guard also enforces the exact intersection at runtime, including
session restrictions and wildcard overlaps. Complex overlaps may be conservatively more
restrictive, never less. Imported deny boundaries remain in force even under a global
allow-all policy. OpenCode does not offer a denied tool to the agent at all.

On V2.2.1, new agents initially get native defaults rather than configured global rules;
the loader carries the native `build` agent's configured permission baseline across.

| Claude | OpenCode action |
| --- | --- |
| `Bash` | `shell` |
| `Read` | `read` |
| `Edit`, `Write`, `MultiEdit` | `edit` |
| `Grep`, `Glob` | `grep`, `glob` (`LS` → `glob`) |
| `Task`, `Agent` | `subagent` |
| `WebFetch`, `WebSearch` | `webfetch`, `websearch` |
| `Skill`, `AskUserQuestion` | `skill`, `question` |
| `mcp__<server>__<tool>`, `mcp__<server>__*`, `mcp__<server>` | `<server>_<tool>` / `<server>_*`, plus `execute` (Code Mode) |
| `mcp__plugin_<plugin>_<server>__<tool>` | `<server>_<tool>`, plus `execute` |
| `TodoWrite`, `NotebookEdit`, plan-mode tools, anything else | dropped, reported |

An agent **without** a `tools:` key gets every tool in Claude Code. Here the default,
`untypedAgents: "inherit"`, adds no rules, so the agent runs under the session's
normal permissions: your config's allow, ask and deny rules still apply.
`untypedAgents: "deny"` makes such agents deny-all instead. An explicit empty list
(`tools: []`) always means no tools.

`model:` names a [model-roles](../model-roles/README.md) tier in the
`x-opencode-model-role` header and never pins a model: `haiku` → `cheap`, `sonnet` →
`standard`, `opus` → `strong`, `inherit` or no value → no header. A full model id that
names one of those families maps to its tier, reported. Without model-roles installed,
every agent inherits the session model. `color` is ignored. Other frontmatter
(`permissionMode`, `skills`, `hooks`, `mcpServers`) is reported, not applied.

Agent prompts often name Claude tools (`Bash`, `Task`, `Read`). With `toolNote` on, a
fixed one-paragraph note mapping those names to OpenCode's is appended to every
registered agent's prompt. It is the same text for every agent and every request.

### Commands

`commands/**/*.md`, plus any manifest `commands` paths, as `/<plugin>:<name>`, with
nested directories joined by `:` (`commands/sub/deep.md` → `/<plugin>:sub:deep`). The
command sends its body as a prompt: `$ARGUMENTS` is the whole argument text, `$1`..`$9`
are words counted from 1, and `$ARGUMENTS[N]` is a word counted from 0. Quotes group
words. Replacements are literal. With no placeholder, the arguments are appended.
`allowed-tools`, `model` and inline `` !`command` `` blocks are reported, not run.

### MCP servers

`.mcp.json` at the plugin root and the manifest's `mcpServers` (a path or an inline
object) go through the shared MCP converter. `stdio` servers become `local`, while
`http`, `sse` and Claude's `url` become `remote`. `${CLAUDE_PLUGIN_ROOT}` and other
`${VAR}` / `${VAR:-default}` references are expanded. A server that needs an unset
variable is skipped and reported. Project-file MCP configs are neither registered nor
environment-expanded before trust approval; approving the digest authorizes their
`${VAR}` interpolation, including URL/header values, so review those configs carefully.
Code Mode is on. Your own server of the same name
wins, and so does the first plugin to ship a name.

The plugin only **registers** server configs (`mcp.transform`). OpenCode
**connects** to them itself, when it loads MCP. A server that fails to start, an
unreachable URL or a missing OAuth login shows up in OpenCode's MCP status
(`opencode mcp list`), not in `claude_compat_check`. A server's tools are named
`<server>_<tool>`, with characters outside letters, digits, `_` and `-` normalized to
`_`. Verified on V2.2.1: server `awslabs.echo`, tool `shout` has permission/tool name
`awslabs_echo_shout`, called as `tools.awslabs_echo.shout` through Code Mode `execute`.
Agent MCP permissions and hook matchers use this normalization; the server's configured
name stays `awslabs.echo`.

### Hooks

`hooks/hooks.json` and the manifest's `hooks` (paths or inline objects). Only `command`
hooks of three events run:

| Claude event | OpenCode | Behaviour |
| --- | --- | --- |
| `PreToolUse` | `tool.hook("execute.before")` | Exit 2 refuses the call with stderr as the reason. So does `permissionDecision: "deny"`, legacy `decision: "block"` or `continue: false`. `"ask"` asserts the `claude_hook` permission. `"allow"` cannot bypass OpenCode permissions. Plain stdout is ignored, as in Claude Code. |
| `PostToolUse` | `tool.hook("execute.after")` | Exit-2 stderr, a block `reason` or `additionalContext` is appended to the result the model sees. |
| `SessionStart` (`startup`) | `session.created` event of a top-level session | Stdout or `additionalContext` becomes a synthetic message, steered into the session's first turn. |

Matchers are anchored regexes on Claude tool names. OpenCode's tools answer to their
Claude names (`shell` → `Bash`, `patch` → `Edit`/`Write`/`MultiEdit`, …). A direct MCP
tool `<server>_<tool>` of a loaded plugin's server answers to
`mcp__<server>__<tool>` and `mcp__plugin_<plugin>_<server>__<tool>`. MCP calls made
inside Code Mode `execute` do not reach tool hooks.

Hooks run as `/bin/sh -c <command>` in the session's directory, with Claude's JSON
payload on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`
with Claude field names such as `file_path`, and `tool_response` for PostToolUse).
`CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` are set in their environment, so the
shell expands `${CLAUDE_PLUGIN_ROOT}` in the command with its own quoting. The timeout
is the hook's `timeout` (default 60 s). Each hook runs in its own process group; timeout
or plugin cleanup aborts the whole group and cleanup waits for outstanding work. Late
SessionStart results are discarded after disposal. A hook that times out, cannot start or exits
with any other non-zero code is reported as a warning and never blocks.
`transcript_path` is empty, and `updatedInput` is ignored.

Hooks do **not** inherit the full host environment. Only `PATH`, `HOME`, `USER`,
`SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TERM`, `CLAUDE_PLUGIN_ROOT` and
`CLAUDE_PROJECT_DIR` are passed by default. Add specific names with `env`, for example
`"env": ["AWS_PROFILE"]`; do not expose credentials to untrusted hooks.

**Not run**, warned once at load and listed by `claude_compat_check`: the events
`UserPromptSubmit`, `Stop`, `SubagentStop`, `SubagentStart`, `Notification`,
`PreCompact`, `SessionEnd`, `PermissionRequest` and any other, `SessionStart` for
`resume`/`clear`/`compact`, `prompt` and `agent` hook types, and hooks with an `if`
condition.

### CLAUDE.md and `${CLAUDE_PLUGIN_ROOT}`

Claude Code does not read a plugin's `CLAUDE.md`, so neither does this plugin by
default. With `instructions: true`, each loaded plugin's root `CLAUDE.md` is added to
the system prompt of sessions in the project. The text is fixed at load, so the prompt
cache holds.

`${CLAUDE_PLUGIN_ROOT}` is replaced with the plugin's absolute directory in skill,
agent, command and `CLAUDE.md` bodies and in MCP configs. Hooks get it from the
environment, as described above. Files on disk are not changed. `${CLAUDE_SKILL_DIR}`,
`${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_SESSION_ID}` are reported, not replaced.

## Limits

This is not full Claude Code compatibility. Not supported: LSP servers, output styles,
remote marketplace entries, `skill://` links, hard-coded `~/.claude/plugins` paths, and
Claude-only tools. Sources are read once per load. Reload the location after an
upstream change. Every component directory and final file must stay inside its plugin
after resolving symlinks, including default paths, `SKILL.md` leaves, hooks, MCP files
and `CLAUDE.md`; escaping components are skipped and reported.

## Verification

`bun test plugins/claude-compat` runs against the synthetic fixture marketplace in
`fixtures/marketplace`. Do not commit private marketplace content or credentials to
this repository.
