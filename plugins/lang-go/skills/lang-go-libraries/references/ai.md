# Go AI integrations

Prefer official protocol/provider SDKs and add orchestration only for a concrete workflow requirement.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| MCP | `github.com/modelcontextprotocol/go-sdk` `1` | `github.com/mark3labs/mcp-go` `1` for existing integrations or specific API preferences | Bespoke JSON-RPC presented as complete MCP. |
| MCP compatibility | Official SDK `1.8` supports spec `2026-07-28`; SDK `1.7+` also lists older revisions | Pinned older peer protocol for compatibility | New designs relying on roots/sampling/logging deprecated in `2026-07-28`; client OAuth is experimental. |
| MCP transports | Official SDK `1` stdio for local tools; Streamable HTTP for remote services | Compatibility transport only when required by peers | Legacy HTTP+SSE as the new default; stdout logs corrupting stdio; unvalidated origins/auth on HTTP. |
| OpenAI | `github.com/openai/openai-go/v3` `3` | Existing framework integration for proven provider portability | Handwritten HTTP envelopes or retries where SDK features suffice. |
| Anthropic | `github.com/anthropics/anthropic-sdk-go/v2` `2` | Existing compatible SDK during a planned migration | Unsuffixed major `1` imports mistaken for current major `2`. |
| Bedrock | AWS SDK v2 `service/bedrockruntime` `1` Converse | Application tool loop for demonstrated workflow needs | Inventing official Go Strands bindings. |
| Orchestration | Direct SDK and explicit application workflow | `github.com/firebase/genkit/go` `1` for its flow ecosystem; `github.com/cloudwego/eino` `0.9` for graph orchestration; `github.com/tmc/langchaingo` `0.1` for existing integrations | Broad frameworks for one call; assuming every framework is stable major `1`. |
| GenAI telemetry | OTel `1` spans around model/tool boundaries, duration, tokens and failures | Provider/framework instrumentation with reviewed coverage and privacy | Prompts/completions recorded by default; assuming development GenAI/MCP conventions are stable. |

## Rules

- Re-check registry, protocol matrix and transport/auth behavior before adding or upgrading. Pin versions and test peer interoperability.
- Treat tool arguments and results as untrusted boundary data. Authorize each operation; apply execution deadlines, concurrency and output-size limits.
- Keep prompts and completions out of logs/traces unless explicitly approved. Pin conventions separately from SDKs and avoid double instrumentation.
- Use `toolchain-api` for API/protocol choice and `observability.md` for the OTel lifecycle.

## Sources

- [Official Go SDK compatibility](https://github.com/modelcontextprotocol/go-sdk#version-compatibility), [SDK registry](https://pkg.go.dev/github.com/modelcontextprotocol/go-sdk), [mcp-go](https://pkg.go.dev/github.com/mark3labs/mcp-go), [MCP transports](https://modelcontextprotocol.io/specification/latest/basic/transports).
- [OpenAI](https://pkg.go.dev/github.com/openai/openai-go/v3), [Anthropic](https://pkg.go.dev/github.com/anthropics/anthropic-sdk-go/v2), [Genkit](https://pkg.go.dev/github.com/firebase/genkit/go), [Eino](https://pkg.go.dev/github.com/cloudwego/eino), [LangChainGo](https://pkg.go.dev/github.com/tmc/langchaingo).
- [Bedrock Converse](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-call.html), [GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md), [MCP conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md).
