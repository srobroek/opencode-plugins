# Python AI and MCP

Choose protocol SDKs, model clients and agent frameworks only for the application capabilities they supply.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| MCP clients/lean servers | Official `mcp` `2`, server API `MCPServer` | `fastmcp` `4` for richer application composition/auth | Confusing standalone FastMCP with the SDK's former built-in FastMCP; stale major/import guidance |
| MCP transports/spec | `mcp` `2`: local stdio; deployed Streamable HTTP; supported modern spec `2026-07-28` | Legacy protocols only for tested peer compatibility | Assuming old handshake/session rules define latest MCP; JSON-RPC alone is not MCP |
| MCP HTTP client | SDK-compatible `httpx2` `2` | Keep `httpx` `0.28` for unrelated service clients | Passing HTTPX objects into MCP v2 HTTPX2 APIs; HTTPX OTel integration does not automatically cover HTTPX2 |
| Provider calls | `anthropic` `2` or `openai` `3` | `boto3` `1` Converse for Bedrock; `anthropic[bedrock]` `2` for Claude-specific SDK | Agent framework for one completion; unvalidated structured outputs |
| Typed agents | `pydantic-ai` `2` when typed outputs/dependencies are required | Direct vendor SDK for simple request/response calls | Adding orchestration without a named requirement |
| Model routing/proxy | `litellm` `1` when routing/provider abstraction is required | Vendor SDK when provider-specific features dominate | Assuming all providers share semantics or retry budgets |
| Stateful orchestration | `langgraph` `1` for graph execution requirements | `langchain` `1` for needed integrations; `strands-agents` `1` for agent loops; `bedrock-agentcore` `1` for AgentCore services | Unbounded tool loops; generic orchestration before a state/recovery requirement |
| GenAI telemetry | `opentelemetry-api`/`opentelemetry-sdk` `1`, manual model/tool spans with OTLP | Official `opentelemetry-instrumentation-openai-v2` `2.4b` after prerelease compatibility checks | GenAI/MCP conventions are Development and moved out of core semconv |
| Anthropic telemetry | Manual spans until approved instrumentation is configured | OpenLLMetry `opentelemetry-instrumentation-anthropic` `0.63` for required coverage | Captures content by default; disable with `TRACELOOP_TRACE_CONTENT=false` unless explicitly approved |

## Rules

- Re-check registries and installed-version documentation before adding MCP or LLM packages. FastMCP docs track main; use exact production pins and test both transport and peer protocol versions.
- Official SDK v1's built-in FastMCP is a maintenance migration path; it is not standalone FastMCP's current package. Do not combine import paths from different SDK generations.
- Report provider/model operation, duration, token usage, tool boundaries and failures without prompt/completion capture by default. Keep portable OTLP as the export boundary.
- Give tool execution explicit permissions, schema validation, call/time/cost budgets and cancellation. Treat model output as untrusted data.
- The complete standalone FastMCP protocol matrix was not verified; prove the required peer combination rather than claiming universal compatibility.

## Sources

- [Official MCP migration](https://py.sdk.modelcontextprotocol.io/migration/), [protocol versions](https://py.sdk.modelcontextprotocol.io/protocol-versions/), [transports](https://modelcontextprotocol.io/specification/latest/basic/transports)
- [FastMCP version policy](https://gofastmcp.com/docs/getting-started/installation.md)
- [OpenAI SDK](https://github.com/openai/openai-python), [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-python), [PydanticAI](https://pydantic.dev/docs/ai/), [LangGraph](https://github.com/langchain-ai/langgraph)
- [Strands](https://github.com/strands-agents/harness-sdk), [AgentCore SDK](https://github.com/aws/bedrock-agentcore-sdk-python)
- [GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md), [MCP conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md)
- [OpenAI instrumentation](https://pypi.org/project/opentelemetry-instrumentation-openai-v2/), [OpenLLMetry](https://www.traceloop.com/docs/openllmetry/introduction), [Anthropic instrumentation](https://pypi.org/project/opentelemetry-instrumentation-anthropic/)
- [Package version registry](https://pypi.org/)
