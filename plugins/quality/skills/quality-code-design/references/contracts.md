# Cross-language and wire contracts

Read when two sides of a boundary must agree on names, shapes, or casing: generated bindings or clients (OpenAPI, protobuf, GraphQL, ts-rs, specta), IPC command registries, or JSON payloads shared between a backend and a frontend. API and event compatibility across versions is in [release.md](release.md).

## Generated code is committed and drift-checked

**Do:** generate bindings from the authoritative side, commit the output, and in CI regenerate and run `git diff --exit-code`. That one gate covers the whole generated surface; consumers use it without repeating it.
**Do not:** generate in a postinstall step nobody reviews, or hand-edit generated files. Change the source or the generator.

## Names are tested, not trusted

**Do:** when one side registers commands or operations by name and the other calls them by string, add a test that fails when the registered set and the called set differ.
**Do not:** rely on a typo surfacing at runtime in the one code path that uses it.

## One wire casing

**Do:** pick one casing for the wire (usually `camelCase` for JSON consumed by JavaScript) and set it once per side: a serializer-wide naming policy, not per-field renames. Add a test that serializes a representative value and checks the keys.
**Do not:** mix casings across payloads. One mismatched key makes the whole payload fail or, worse, silently drops a field.

## Conformance against the real surface

**Do:** run contract or conformance tests against the real backend or the real generated client, at least for the names, casing, and schema of each operation.
**Do not:** let a mock transport stand in for the contract. A mock agrees with whatever the client sends, so name, casing, and schema mismatches pass.

**Exception:** unit tests of client logic can use a fake transport, as long as the fake is itself checked against the real surface (see [verification.md](verification.md)).
