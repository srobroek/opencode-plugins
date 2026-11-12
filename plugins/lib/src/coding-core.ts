/**
 * The coding-core fragment as text, for plugins that put one of its parts in a system prompt
 * instead of an agent file. The import inlines the file into each plugin's bundle at build time.
 */

import text from "./coding-core.md" with { type: "text" }
import { fragmentParts } from "./fragments.ts"

/** The `standards` part: research first, compare with the preferred libraries, middleware, Powertools, OpenTelemetry. */
export const STANDARDS: string = fragmentParts("coding-core", text).get("standards") ?? ""
