const MAX_DEPTH = 10

type SessionGet = (input: { sessionID: string }) => Promise<{ parentID?: string | null } | undefined>

/** Resolves any session to its root by walking `parentID`, and caches every session on the walked chain. */
export function createRootResolver(get: SessionGet) {
  const cache = new Map<string, string>()
  return {
    /** Record a session the host reported as a root. */
    markRoot(sessionID: string) {
      cache.set(sessionID, sessionID)
    },
    /** The root id, or undefined when the chain cannot be read in `MAX_DEPTH` steps (callers fail closed). */
    async resolve(sessionID: string): Promise<string | undefined> {
      const chain: string[] = []
      let id = sessionID
      for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
        const known = cache.get(id)
        if (known !== undefined) return remember(chain, known)
        chain.push(id)
        let parent: string | null | undefined
        try {
          const session = await get({ sessionID: id })
          if (session === undefined) return undefined
          parent = session.parentID
        } catch {
          return undefined
        }
        if (!parent) return remember(chain, id)
        id = parent
      }
      return undefined
    },
  }

  function remember(chain: string[], root: string): string {
    for (const id of chain) cache.set(id, root)
    return root
  }
}
