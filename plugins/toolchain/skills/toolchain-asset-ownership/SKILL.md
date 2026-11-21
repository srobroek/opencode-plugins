---
name: toolchain-asset-ownership
description: "Use when adding or changing agentic assets: where OpenCode config, plugins, skills and agents live and who owns them."
metadata:
  opencode/autoinvoke: false
---

# Agentic asset ownership

Keep these ownership boundaries when changing agentic assets; machine-specific guidance in `AGENTS.md` may add local paths:

- chezmoi owns machine-wide OpenCode config under `~/.config/opencode/`: `opencode.json`, the global `AGENTS.md`, and global agents and skills. Use the `chezmoi-editor` skill, when installed, to edit their source rather than the deployed files.
- The `srobroek/opencode-plugins` repository owns installable plugins (skills, agents, and plugin code). Its Claude Code and Codex marketplaces are generated from the same plugins.
- OpenCode loads a plugin's built bundle, not its source. An installed plugin updates from its git source, so a plugin change takes effect only after it is committed (and released, for a pinned tag) and the plugin is updated; a local checkout needs `bun run build` first.
- On a host with a running OpenCode background service, update once and restart on your own schedule. Run one `opencode plugin update` with no target, which updates all outdated plugins, instead of a loop of per-plugin targets. Add `--standalone` to run it against a private server instead of the service. Then restart the service at a planned time, with no live sessions.

When an update fails with `ClientError ECONNRESET` or `Plugin is not configured`, read [references/pitfalls.md](references/pitfalls.md).
