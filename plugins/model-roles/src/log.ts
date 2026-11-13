/**
 * Warnings to the OpenCode log. The promise plugin API has no logger and the host does not
 * capture `console`, but plugins share the host's `effect` instance: the fiber that runs
 * `setup` carries the host's services, logger included, so an effect run with them logs
 * to `opencode.log`. Without that fiber (tests, another host) it falls back to `console.warn`.
 */

import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"

export type Warn = (message: string, data?: Record<string, unknown>) => void

/** A logger bound to the current fiber's services. Call it in the synchronous part of `setup`. */
export function hostWarn(source: string): Warn {
  const services = Fiber.getCurrent()?.context
  return (message, data) => {
    const text = `${source}: ${message}`
    if (services !== undefined) {
      try {
        Effect.runForkWith(services)(data === undefined ? Effect.logWarning(text) : Effect.logWarning(text, data))
        return
      } catch {
        // Fall through to the console.
      }
    }
    if (data === undefined) console.warn(text)
    else console.warn(text, data)
  }
}
