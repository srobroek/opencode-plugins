# cad: porting the OMP CAD plugin to OpenCode V2

Status: built in bead `opencode-plugins-net.9` as `plugins/cad` (id `srobroek.cad`). Source:
`srobroek/omp-plugins` at `dc89664da1` (first ported at `ab1dac9e48`), directory `cad/`. Checked
against OpenCode 2.2.1 and `@opencode/plugin` 2.1.4.

## What moves and what stays

The CAD engineering core is harness-neutral Python: fifteen skills with their PEP 723 scripts,
schemas, assets, tests and the `lamp-arm` example. It moves unchanged except where it named an
OMP mechanism. The delivery layer is not neutral: `skill://` URIs, OMP `task` dispatch, OMP agent
frontmatter, the multi-harness generator and the OMP eval harness. Each OMP mechanism gets one
OpenCode replacement below.

Layout, kept so the Python tests and `CAD_ROOT = skills/..` lookups keep working:

```text
plugins/cad/
  src/            plugin code (tools, agent registration, session cleanup)
  agents.src/     six worker agents; `bun run build` composes agents/
  skills/         the fifteen CAD skills, scripts and tests (unchanged tree)
  formulas/       eleven Beads formulas, README, smoke-pour.sh
  examples/       lamp-arm, read by the Python tests
```

## Mechanisms

| OMP feature | OpenCode mechanism | Why |
|---|---|---|
| `uv run --script skill://cad-flow/scripts/run.py <skill>/scripts/<x>.py …` and `uv run --script skill://<skill>/scripts/<x>.py …` | `cad_run` tool: `{script: "<skill>/scripts/<x>.py", args: [...]}` | OpenCode has no `skill://` resolver and no skill-directory variable in shell commands. The plugin knows its own `skills/` path, so one tool resolves it and runs the unchanged `run.py` launcher. |
| Long-running preview (`serve.py`) as an OMP background job | `cad_run` with `background: true`, `cad_stop {pid}` | A tool call cannot stay open for a server. The plugin owns the detached process, returns its first stdout line (the URL JSON) and stops it on request, on session deletion or on plugin dispose. |
| Skill references `skill://<skill>/references/x.md` | Relative paths from the skill's base directory (`../cad-record/references/layout.md`) in skill prose; "the cad-record skill's `references/layout.md`" in agent prompts and formulas | OpenCode's skill tool prints "Base directory for this skill" and resolves relative paths against it (checked in the 2.2.1 binary). The CAD skills are siblings, so `../<skill>/` reaches every other one. |
| OMP `task` with `agent: <agent>` | OpenCode subagents registered from `agents/`; the lead uses the `subagent` tool, one call per unit, all in one message | Native V2 delegation. |
| OMP `model: @task` / `@reviewer`, `thinking-level` | `x-opencode-model-role` header: `strong` for part designer and analyst (OMP `high`), `standard` for concept designer and sourcing researcher (OMP `medium`), `reviewer` for both reviewers | The repo's model-roles tiers; no pinned models. |
| OMP `tools:` lists and prompt-only write limits | Ordered V2 permissions, deny `*` first | Writers get `edit` only on `.cad-work/*` plus `cad_run`; no shell. Readers get read, grep, glob and their skills; the sourcing researcher also gets `webfetch`/`websearch`. |
| OMP `autoloadSkills` | Prompt step "Load the `<skill>` skill first" plus a `skill` allow rule for `cad-*` | V2 agents have no preload field; the skill tool is the documented loader. |
| Viewer session key from `PI_SESSION_ID` / `CLAUDE_CODE_SESSION_ID` | `cad_run` sets `CAD_SESSION_ID` to the root OpenCode session id; `session.py` reads it | The tool context carries the session id. Subagent sessions resolve to their root session through `parentID`, so a worker's capture reaches the lead's viewer host. |
| Viewer left running when a session ends | `session.deleted` event: stop that session's viewer hosts (`viewer.py stop` with the recorded `--session`) and its background jobs; plugin cleanup stops all of them | `ctx.event.subscribe` carries `session.deleted`. OpenCode has no separate exit event; the returned cleanup runs on dispose. The 30-minute idle timeout stays as the fallback. |
| `setup.py` copies formulas; `--harness opencode|kiro|claude` copies generated files | `cad_setup` installs the formulas; setup.py keeps runtime provisioning (FreeCAD check, uv, warm-up) and the project's git storage rules (`--storage`) | One formula installer. The plugin itself provides skills and agents, so there is nothing to copy. |
| `preflight.py` harness checks (OMP, Claude, OpenCode copies, Kiro) | One optional `opencode-plugin` check: passes when preflight runs under `cad_run` (`CAD_OPENCODE_PLUGIN` is set), warns with the install command otherwise. The Beads check also reports missing cad formulas and names `cad_setup` | The skills ship only through this plugin, so the other harness checks no longer describe a supported install. Inside OpenCode, running under `cad_run` is proof the plugin loaded. |
| Beads formulas with `skill://` text and `uv run --script skill://…` steps | Same formulas; text names skills and `cad_run` calls. Worker steps keep `execution_mode = "subagent"` and `execution_agent_type = "<cad agent>"` | `plugins/beads` routes subagent calls on `execution_agent_type` (`decideRouting`), so formula steps and agent ids must match; a test checks it. Human gates stay `bd gate resolve` and provisional gates stay plain steps the lead closes, as in the original. |
| cad-recheck git hook | Unchanged and opt-in: `cad_run cad-recheck/scripts/install-hook.py` | It is plain git (`core.hooksPath=.githooks`) and copies its helpers into the project, so it needs no harness. |

### `cad_run`

- Input: `script` (relative to the plugin's `skills/`, or absolute under it), `args` (strings),
  `timeout` (seconds, default 1200, at most 3600), `background` (boolean).
- Runs `uv run --script <skills>/cad-flow/scripts/run.py <script> <args…>` from the session
  directory. `run.py` keeps its containment check and starts the target in uv's environment
  shared by its PEP 723 dependency set, for light and heavy scripts alike.
- The plugin also refuses a script outside `skills/` or not ending in `.py` before spawning, so a
  bad path costs no uv start.
- Environment: the server's environment plus `CAD_SESSION_ID` and `CAD_OPENCODE_PLUGIN`.
- Permission: `ctx.permission.assert` with action `cad_run` and the script path as resource, so
  "always" approves one script. Shipped writer agents allow `cad_run`; reviewers do not have it.
- Result: exit code, duration, stdout, and the stderr tail. Output beyond 100 kB goes to a file
  under the system temp directory and the result names it. A timeout or abort kills the
  process group.
- Background: stdout and stderr go to files; the call returns once stdout has a first line (or
  the process exits, or `timeout` passes, default 120 s), with the pid and both file paths.
  The plugin keeps the child's handle: a script that exits on its own (the preview's idle
  timeout) is forgotten, and `cad_stop` or cleanup signals a process group only while that
  handle reports it running, so a reused pid is never signalled.

Shell commands remain possible for the lead (`uv run --script <base directory>/scripts/x.py`),
but every skill, agent and formula names `cad_run`, so workers carry no shell at all. That is a
stronger boundary than the OMP `uv *` shell prefix, which allowed any `uv run`.

### Agent boundaries

Permissions in V2 are authorization, not a sandbox: `cad_run` scripts run with the user's
authority and write where their CLIs write (`scratch.py deliver` writes `hw/parts/<PN>/`). The
edit rule keeps the agent's own file edits in `.cad-work/`; the scripts keep their documented
output contracts. At registration each agent also gets
`external_directory: allow` for the plugin's `skills/` directory, so a worker can read a CAD
skill reference installed outside the project without a prompt; every other external path
stays `ask`.

## Not ported

- `cad/evals/`: an OMP eval harness (OMP adapter, OMP judge, OMP RPC inventory). It is research
  tooling, not runtime, and its active parts are OMP-specific.
- `cad/harness/`: the generator of Claude Code, Kiro and OpenCode V1 agent copies. The plugin's
  `agents.src/` are the only agent source now.
- Claude Code and Codex export: the skills name `cad_run`, so `package.json` sets
  `"opencode-plugins": { "claude": false, "codex": false }`.
- OMP `CHANGELOG.md`: release-please starts a new one.

## Tests and CI

- `bun test`: plugin registration, `cad_run` path checks, argv, environment, background start and
  stop, session cleanup on `session.deleted`, `cad_setup`, formula routing against the shipped
  agents and `decideRouting`, no `skill://` or OMP wording in formulas.
- Python: every `skills/*/tests/test_*.py` and `skills/*/test_*.py` file runs separately with
  `uv run --no-project --with pyyaml --with jsonschema --with defusedxml python -m unittest`, as
  in omp-plugins. FreeCAD tests skip when `freecadcmd` is missing (CI) and run on a workstation.
- CI: a `changes` job diffs `plugins/cad` and the workflow; the `cad` job runs only when they
  changed, with the uv cache keyed by the PEP 723 headers. Same shape as omp-plugins' `cad` job.

## Revisit when

- OpenCode exposes a skill-directory variable to shell commands: `cad_run` could become prose.
- OpenCode gains an exit event: stop viewers there instead of on dispose.
- A Claude Code or Codex user needs the skills: add a launcher note per harness and export.
