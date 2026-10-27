import { hasAny, packageDependencies, packageDirectories } from "@srobroek/opencode-lib/project-markers"

/** Files or directories whose presence alone marks frontend work. */
export const FRONTEND_MARKERS = [
  ".storybook",
  "DESIGN.md",
  "index.html",
  "components.json",
  "tailwind.config.js",
  "tailwind.config.ts",
] as const

const FRONTEND_PACKAGES =
  /^(?:react|react-dom|vue|svelte|@sveltejs\/kit|solid-js|preact|@angular\/core|next|nuxt|astro|lit|@remix-run\/.+|@builder\.io\/qwik|ember-source|storybook|@storybook\/.+|tailwindcss|react-native|expo)$/

/** Whether `directory`, or a workspace package one level below `apps/`, `packages/` or `web/`, is a frontend project. */
export function isFrontendProject(directory: string): boolean {
  return packageDirectories(directory).some(
    (dir) => hasAny(dir, FRONTEND_MARKERS) || packageDependencies(dir).some((name) => FRONTEND_PACKAGES.test(name)),
  )
}
