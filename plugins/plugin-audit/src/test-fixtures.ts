/** In-memory snapshots for the pure check tests. */

import type { Json, PluginSnapshot, RepoSnapshot } from "./model.ts"

/** The optional @opencode/plugin peer that AGENTS.md requires; spread it into a manifest that must pass the peer rule. */
export const OPTIONAL_PEER = {
  peerDependencies: { "@opencode/plugin": "^2.1.4" },
  peerDependenciesMeta: { "@opencode/plugin": { optional: true } },
}

export function plugin(name: string, manifest: Json = {}, extra: Partial<PluginSnapshot> = {}): PluginSnapshot {
  return {
    name,
    manifest: {
      private: true,
      type: "module",
      exports: { ".": "./dist/index.js" },
      files: ["dist", "index.js"],
      ...manifest,
    },
    src: [],
    skills: [],
    agents: [],
    hasSkillsDir: false,
    hasAgentsDir: false,
    hasReadme: true,
    hasChangelog: true,
    tests: ["index.test.ts"],
    ...extra,
  }
}

export function repo(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return { root: {}, plugins: [], ...overrides }
}
