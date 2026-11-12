# MCP and model clients

Use maintained protocol SDKs and explicit model adapters, with versioned capabilities and bounded telemetry.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| MCP client/server | Official `rmcp` `3.9` | Unsupported requirement is named and a reviewed alternative passes protocol fixtures | Stale unofficial SDK tutorials or a bespoke JSON-RPC imitation. |
| MCP transports | `rmcp` `3.9` stdio or Streamable HTTP | Existing compatible peer requires a negotiated older protocol | Stdout logs on stdio; treating legacy HTTP+SSE as current Streamable HTTP. |
| OpenAI | Community `async-openai` `0.43` | `reqwest` `0.13` for precise unsupported provider endpoints | Assuming community ownership means official provider support. |
| Multi-provider agents | `rig-core` `0.46` | Thin `async-openai` `0.43`/SDK adapters for a fixed workflow | Framework adoption for one call; ignoring current MSRV `1.97.1` and modular API changes. |
| Anthropic | Reviewed `reqwest` `0.13` adapter | Community `anthropic-async` `0.5` after API/maintenance evaluation | Claiming an official Rust SDK; `anthropic-sdk` `0.1` is an old community release. |
| Bedrock | Service-specific `aws-sdk-*` `1` | `rig-core` `0.46` when its provider covers required operations | Generic abstractions hiding required Converse/streaming/tool capabilities. |
| GenAI telemetry | `opentelemetry_sdk` `0.33`, `tracing-opentelemetry` `0.34` | Existing reviewed instrumentation supplies compatible spans | Prompt/completion capture by default; calling development conventions stable. |

## Rules

- The official SDK README identifies MCP spec `2026-07-28`, with earlier compatibility including `2025-11-25`. Re-check installed features, peer negotiation, transport and auth support rather than assuming all capabilities exist.
- Pin SDK/spec versions; test initialize, capabilities, cancellation, streaming, error handling and HTTP authorization/origin controls.
- Enforce tool authorization outside model output. Bound tool calls, loops, retries, payloads, concurrency and total cost. Keep provider responses validated at the adapter boundary.
- Instrument model/tool operations, token use, latency and failures. GenAI inference/MCP conventions are development and moved to a separate repository; pin the convention used and exclude content unless approved.

## Sources

- [Official Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk), [MCP transports](https://modelcontextprotocol.io/specification/latest/basic/transports), [`rmcp` registry](https://crates.io/crates/rmcp).
- [OpenAI community client](https://docs.rs/async-openai/latest/async_openai/), [Rig](https://docs.rs/rig-core/latest/rig_core/), [Anthropic SDK inventory](https://platform.claude.com/docs/en/api/client-sdks).
- [GenAI convention status](https://github.com/open-telemetry/semantic-conventions-genai), [sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/).
