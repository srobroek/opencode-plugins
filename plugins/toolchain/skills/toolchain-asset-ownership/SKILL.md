---
name: toolchain-asset-ownership
description: Use when adding or changing agentic assets, to know where OpenCode config, plugins, skills, and agents live and who owns them.
---

# Agentic asset ownership

Keep these ownership boundaries when changing agentic assets; machine-specific guidance in `AGENTS.md` may add local paths:

- chezmoi owns machine-wide OpenCode config under `~/.config/opencode/`: `opencode.json`, the global `AGENTS.md`, and global agents and skills. Use the `chezmoi-editor` skill, when installed, to edit their source rather than the deployed files.
- The `srobroek/opencode-plugins` repository owns installable plugins (skills, agents, and plugin code). Its Claude Code and Codex marketplaces are generated from the same plugins.
- OpenCode loads a plugin's built bundle, not its source. An installed plugin updates from its git source, so a plugin change takes effect only after it is committed (and released, for a pinned tag) and the plugin is updated; a local checkout needs `bun run build` first.
