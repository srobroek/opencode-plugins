/**
 * The skip-CI reminder: GitLab and GitHub skip the pipeline for any commit, MR or PR text
 * that contains a skip-CI marker, even quoted as prose. This never blocks; the plugin
 * appends the reminder to the completed call's result.
 */

import { invocations } from "./shell.ts"

const MARKER = /\[(?:skip\s+ci|ci\s+skip|no\s+ci|skip\s+actions)\]/i

export const SKIP_CI_ADVISORY =
  "trunk-dev: this command's commit/MR/PR text contains a skip-CI marker ([skip ci], [ci skip], [no ci] or [skip actions]). GitLab and GitHub skip the pipeline for it even when the marker is quoted as prose; remove the marker when CI must run."

/** Whether a word list is a commit, MR or PR operation whose text the forge reads. */
function forgeText(argv: readonly string[]): readonly string[] | undefined {
  const [head, second] = argv
  if (head === "glab" && second === "mr") return argv.slice(2)
  if (head === "gh" && second === "pr") return argv.slice(2)
  if (head !== "git" && head !== "dgit") return undefined
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] as string
    if (word === "-C" || word === "-c") {
      i++
      continue
    }
    if (word.startsWith("-")) continue
    return word === "commit" ? argv.slice(i + 1) : undefined
  }
  return undefined
}

/** The reminder when a commit, MR or PR command's own words or here-document carry a skip-CI marker. */
export function skipCiAdvisory(command: string, cwd = "/"): string | undefined {
  try {
    for (const invocation of invocations(command, cwd)) {
      const words = forgeText(invocation.argv)
      if (words === undefined) continue
      if (words.some((word) => MARKER.test(word))) return SKIP_CI_ADVISORY
      if (invocation.hereDocuments.some((document) => MARKER.test(document.body))) return SKIP_CI_ADVISORY
    }
    return undefined
  } catch {
    return undefined
  }
}
