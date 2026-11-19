# Shared contracts across languages

Read when two languages (or two processes) share a message contract: a host and its SDK, a server and a client in another language. The gates and tools are in `toolchain-api` ("Shared contract across languages", "JSON-RPC over stdio").

## Rules

- **One schema, many consumers:** each language consumes the same generated schema files. A hand-copied schema is a second contract.
- **Pinned generator, regenerate and diff:** CI regenerates with the pinned generator and fails on any diff. A vendored copy is compared byte for byte with the source.
- **Shared conformance corpus:** valid and invalid messages, with the expected outcome, live beside the schemas. Each language runs the whole corpus against its own validator or codec. A language does not fork or filter the corpus; a fixture that only one language passes is checked against the specification first (see `doubles.md`).
- **Cross-language test per message type:** drive the real SDK of one language through the real host of the other, over the real transport. List the message types, and keep a test for each one, including its error replies.
- **Additive-only schema gate:** the schema diff gate in `toolchain-api` runs on the generated files, so a break fails before a consumer does.

## Why

Each side's own tests pass against its own copy of the contract. Only a shared corpus and a test across the real boundary fail when the two sides disagree, and they fail before a release does.

## Test shape

- Put the corpus in one directory with a manifest (`name`, `direction`, `message`, `expected`). The per-language runner reads the manifest; it holds no cases of its own.
- Keep expected outcomes in the corpus, worked out from the specification, never copied from one implementation's output.
- For a message type with several error replies, add one corpus entry per reply, not one parametrised case per language.
- Keep cross-language tests few and at the boundary; field-level rules are the corpus's job.

## Review check

any of these: a schema copied rather than generated, a vendored copy with no byte check, a language skipping corpus entries, a message type with no cross-language test, expected outcomes recorded from an implementation.

## Sources

- [JSON Schema specification](https://json-schema.org/specification), [JSON-RPC 2.0](https://www.jsonrpc.org/specification), [MCP conformance runner](https://github.com/modelcontextprotocol/conformance) (per-scenario wire-schema validation), [Buf breaking rules](https://buf.build/docs/breaking/) (the same idea for protobuf).
