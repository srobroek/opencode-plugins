---
name: lang-typescript-packaging
description: Use for TypeScript monorepo and package layout (project references, tsc -b, exports maps, barrels, catalogs, --define).
metadata:
  opencode/autoinvoke: false
---

# TypeScript Packaging

Sources: [project references](https://www.typescriptlang.org/docs/handbook/project-references.html), [TSConfig `extends`](https://www.typescriptlang.org/tsconfig/#extends), [Node.js package `exports`](https://nodejs.org/api/packages.html#package-entry-points), [bun catalogs](https://bun.com/docs/pm/catalogs), [pnpm catalogs](https://pnpm.io/catalogs), [bun bundler](https://bun.com/docs/bundler), [publint](https://publint.dev/), [Are the Types Wrong?](https://github.com/arethetypeswrong/arethetypeswrong.github.io), [Biome `noBarrelFile`](https://biomejs.dev/linter/rules/no-barrel-file/). Checked with tsc 7.0 and Bun 1.4.

Module design (functions before classes, unions) is the `quality-code-design` skill's
`typescript.md` reference. This skill is the package and build mechanics.

## Workspace layout

```text
package.json            "workspaces": ["packages/*"] (bun, npm, yarn) or pnpm-workspace.yaml
tsconfig.base.json      shared compiler options
tsconfig.json           solution file: "files": [], "references": [...]
packages/core/          package.json, tsconfig.json, src/
packages/api/           depends on "@shop/core": "workspace:*"
```

Internal dependencies use `"workspace:*"`. Declare every sibling a package imports:
with a hoisted `node_modules` an undeclared import still resolves locally and breaks
for anyone installing the package alone.

## Project references and `tsc -b`

```jsonc
// packages/api/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "composite": true, "declarationMap": true, "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

- `composite: true` on every referenced project; it forces declarations and requires
  every source file to match `include` or `files`. `declarationMap` makes
  go-to-definition land in the sibling's source, not its `.d.ts`.
- The root `tsconfig.json` lists every package in `references` with `"files": []` and
  is checked with `tsc -b`. `tsc --noEmit` on that file checks nothing.
- Relative paths in a config (`outDir`, `rootDir`, `include`) resolve against the file
  that declares them, so a base config shared through `extends` must not set them; set
  them in each package.
- Source-only internal packages are the alternative when every consumer runs
  TypeScript directly (Bun, Vite, tsx): `exports` points at `./src/index.ts`, no build
  step. They cannot be published and type-check as part of each consumer.

## The `exports` map is the public API

```json
{
  "name": "@shop/core",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./testing": { "types": "./dist/testing.d.ts", "default": "./dist/testing.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "sideEffects": false
}
```

- Paths not listed in `exports` cannot be imported, which is how a package keeps its
  internals private. Add a subpath for each supported entry point; never export
  `"./*"` as a shortcut.
- Conditions match in order: `types` first, `default` last. With
  `moduleResolution` set to `nodenext` or `bundler`, TypeScript resolves through the
  same map.
- Before publishing, run `npx publint` and `npx @arethetypeswrong/cli --pack .` to catch
  wrong paths, missing types and ESM/CJS mismatches.
- `sideEffects: false` lets bundlers drop unused modules; leave it out (or list the
  files) when importing a module registers something.

## Barrel files

A barrel is an `index.ts` that re-exports a folder. One at the package entry (what
`exports["."]` points to) is the public API. Barrels inside a package cost more than
they save:

- Importing one name loads every module the barrel re-exports. Test runners, dev
  servers and Node without a bundler pay that on every import.
- They create import cycles, which surface as
  `ReferenceError: Cannot access 'X' before initialization`.

Inside a package, import siblings by path (`./pricing/quote.ts`). Biome's `noBarrelFile`
and `noReExportAll` rules enforce this.

## Catalogs: one version per dependency

```jsonc
// bun: root package.json
{ "workspaces": { "packages": ["packages/*"], "catalog": { "zod": "^4.6.0" } } }
```

```yaml
# pnpm: pnpm-workspace.yaml
packages: ["packages/*"]
catalog:
  zod: ^4.6.0
```

Members write `"zod": "catalog:"`; named catalogs (`catalogs:` / `catalog:testing`)
group versions that move together. A bump is one line in one file.

## Build-time flags and dead-code removal

```ts
declare const __DEBUG__: boolean
if (__DEBUG__) mountDebugPanel()
```

```sh
bun build src/main.ts --define __DEBUG__:false --minify-syntax --outdir dist
```

The bundler replaces the identifier and, with syntax minification on, removes the
dead branch and whatever only it imported; without `--minify-syntax` (or `--minify`)
`if (false)` stays in the output. Bun also has `import { feature } from "bun:bundle"`
with `--feature NAME`. esbuild uses `--define:__DEBUG__=false`, Vite the `define`
option or `import.meta.env.DEV`. Check the output for a debug-only string to confirm
it is gone.
