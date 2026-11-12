/**
 * The coding-core fragment as text, for plugins that put its parts in a system prompt instead of
 * an agent file. The import inlines the file into each plugin's bundle at build time.
 */

import text from "./coding-core.md" with { type: "text" }
import { fragmentParts } from "./fragments.ts"

const parts = fragmentParts("coding-core", text)

/** The `standards` part: research first, compare with the preferred libraries, middleware, Powertools, OpenTelemetry. */
export const STANDARDS: string = parts.get("standards") ?? ""

/** The `testing` part: behavior tests, a distinct risk per test, tests changed and removed with the code. */
export const TESTING: string = parts.get("testing") ?? ""
