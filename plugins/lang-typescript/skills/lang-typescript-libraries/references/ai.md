# MCP and AI integration

Choose protocol and provider SDKs before implementing transports, tool loops or telemetry conventions.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| MCP server/client | Official `@modelcontextprotocol/server` `2`, `@modelcontextprotocol/client` `2` | Keep maintenance-only `@modelcontextprotocol/sdk` `1` for existing revision `2025-11-25` integrations during migration; `fastmcp` `4` for convenience APIs, `mcp-handler` `2` for framework handlers, `xmcp` `1` for scaffolding. | Guessing API compatibility between the monolithic and split packages; building JSON-RPC and calling it MCP. |
| MCP transports | SDK stdio locally; Streamable HTTP remotely | Legacy HTTP+SSE only for a required older client. | Stdio debug logs on stdout; unauthenticated remote tools; no origin/session validation. |
| MCP specification | Revision `2026-07-28`, supported by split SDK `2`; pin host compatibility | Older revision `2025-11-25` for a documented existing-client requirement. | Equating npm major `2` with a specification revision; copying old handshake/session assumptions into a new implementation. |
| Provider-neutral LLM | `ai` `7` and its compatible provider packages | `openai` `7` or `@anthropic-ai/sdk` `1` for native provider APIs. | A provider abstraction when it hides a needed API; copied retry/tool-call loops. |
| Agent frameworks | A plain SDK/tool loop when that is sufficient | `@mastra/core` `1`, `langchain` `1`, or `@strands-agents/sdk` `1` when their workflow/tool integration solves a named need. | Introducing an agent framework solely for one completion request. |
| AWS models | SDK `3` Bedrock Converse | `@ai-sdk/amazon-bedrock` `5` for AI SDK integration. | Assuming provider capabilities, IAM and streaming are identical across backends. |
| GenAI telemetry | OTel spans/OTLP, compatible SDK instrumentation where tested | Existing gateway tracing for centralized usage accounting. | Treating evolving GenAI semantic conventions as stable; exporting prompts, completions or tool secrets by default. |

## Rules

- Re-check registry versions and official migration docs before adding or upgrading;
  pin provider packages with the core SDK's peer requirements. Test Node and Bun.
- MCP is a protocol boundary: validate tool schemas, authorization, cancellation,
  bounded results and transport security. Use `toolchain-api` for protocol design.
- Re-check the negotiated wire revision and transport behavior, not just the SDK major.
  Current GenAI and MCP semantic conventions are development work, not stable contracts.
- Validate tool arguments and outputs. Allowlist tool capabilities and destinations;
  retries need effect idempotency. Record latency/token usage without content by default.

## Sources

- [Official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), [MCP transports](https://modelcontextprotocol.io/specification/latest/basic/transports).
- [AI SDK](https://ai-sdk.dev/docs/introduction), [OpenAI SDK](https://github.com/openai/openai-node), [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript).
- [Bedrock provider](https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock), [GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), [registry metadata](https://registry.npmjs.org/).
