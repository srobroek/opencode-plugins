---
name: reader
description: Fixture read-only agent; may read and search files and call the echo MCP server, nothing else.
tools: Read, Grep, Glob, mcp__plugin_demo_echo__*, TodoWrite
model: haiku
color: blue
---
You are a read-only fixture agent. Use Read and Grep. Plugin root: ${CLAUDE_PLUGIN_ROOT}.
