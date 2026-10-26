# opencode-plugins

OpenCode V2 plugins by Sjors Robroek. This is the OpenCode counterpart of
[omp-plugins](https://github.com/srobroek/omp-plugins), which targets Oh My Pi.

| Field | Value |
| --- | --- |
| Status | Bootstrap. Only the `example` plugin exists. |
| Host | OpenCode 2.1.4 or later (`@opencode/plugin` 2.x) |
| License | Apache-2.0 |

V1 plugins (`@opencode-ai/plugin`) do not run on V2. Every plugin here uses
`Plugin.define` from `@opencode/plugin`.

## Layout

Each plugin is a workspace package under `plugins/<name>/`:

- `package.json` exports the plugin entry point (`"."`).
- `src/index.ts` default-exports `Plugin.define({ id, setup })`.
- `src/*.test.ts` holds `bun:test` tests next to the code.
- `README.md` describes what the plugin does and how to install it.

Plugin ids use the `srobroek.<name>` prefix.

## Installing a plugin

OpenCode installs a plugin straight from a subdirectory of this repository:

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/<name>'
```

Pin a tag (`#<tag>`) to stop automatic updates.

## Developing

```sh
mise install
bun install
bun run check   # typecheck, lint, test
```

Load a local checkout by adding the plugin directory to `plugins` in
`opencode.json`, or link it into `.opencode/plugins/`.

## Releases

release-please opens a release PR from Conventional Commits and tags each
plugin as `<name>--v<version>`. Add new plugins to
`release-please-config.json` and `.release-please-manifest.json`.

## License

Apache-2.0. See [LICENSE](LICENSE).
