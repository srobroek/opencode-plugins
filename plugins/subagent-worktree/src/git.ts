/** The git and wt commands the plugin runs, behind a replaceable runner. */

export type RunResult = { code: number; stdout: string; stderr: string }
export type Runner = (argv: string[]) => Promise<RunResult>

export const spawnRunner: Runner = async (argv) => {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

export function createGit(run: Runner) {
  const git = async (directory: string, ...args: string[]) => {
    const result = await run(["git", "-C", directory, ...args])
    return result.code === 0 ? result.stdout.trim() : undefined
  }
  return {
    run,
    isWorkTree: async (directory: string) => (await git(directory, "rev-parse", "--is-inside-work-tree")) === "true",
    commit: (directory: string, ref: string) => git(directory, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`),
    /** The checked-out branch, or undefined on a detached HEAD. */
    branch: (directory: string) => git(directory, "symbolic-ref", "--quiet", "--short", "HEAD"),
    isLocalBranch: async (directory: string, name: string) =>
      (await git(directory, "show-ref", "--verify", "--quiet", `refs/heads/${name}`)) !== undefined,
    createBranch: async (directory: string, name: string) =>
      (await git(directory, "switch", "--quiet", "-c", name)) !== undefined,
    deleteBranch: async (directory: string, name: string) =>
      (await git(directory, "branch", "--quiet", "-d", name)) !== undefined,
    /** Commits on HEAD since `base`, and whether the tree has changes; undefined when git fails. */
    status: async (directory: string, base: string) => {
      const ahead = await git(directory, "rev-list", "--count", `${base}..HEAD`)
      const porcelain = await git(directory, "status", "--porcelain")
      if (ahead === undefined || porcelain === undefined) return undefined
      return { ahead: Number.parseInt(ahead, 10) || 0, dirty: porcelain !== "" }
    },
  }
}

export type Git = ReturnType<typeof createGit>
