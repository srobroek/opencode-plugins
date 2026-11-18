import { devNull } from "node:os"

/**
 * Git's global options for every command that runs inside a checkout this tool does
 * not control (a landed worktree, or another repository's checkout).
 *
 * `core.fsmonitor` is a program `git status` executes and `core.hooksPath` selects
 * hooks, so a hostile checkout's own config could run code; command-line `-c`
 * outranks repository config. `--no-optional-locks` keeps a read from writing the index.
 */
export const SAFE_GIT_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${devNull}`,
  "--no-optional-locks",
] as const
