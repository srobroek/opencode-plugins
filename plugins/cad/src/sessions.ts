import type { BackgroundJob } from "./run.ts"

/** A viewer host `viewer.py serve` started: stopping it needs the same directory and `--session`. */
export type ViewerHost = { cwd: string; session: string }

type Owned = { jobs: Map<number, BackgroundJob>; viewers: Map<string, ViewerHost> }

const key = (host: ViewerHost) => `${host.cwd}\0${host.session}`

/**
 * What `cad_run` left running, by root session: background scripts and viewer hosts. Each is
 * stopped when its session is deleted, and everything when the plugin is disposed.
 */
export class CadSessions {
  private readonly owned = new Map<string, Owned>()

  private entry(root: string): Owned {
    let owned = this.owned.get(root)
    if (owned === undefined) {
      owned = { jobs: new Map(), viewers: new Map() }
      this.owned.set(root, owned)
    }
    return owned
  }

  addJob(root: string, job: BackgroundJob): void {
    this.entry(root).jobs.set(job.pid, job)
  }

  /** Remove and return the session's job with this pid, if it has one. */
  takeJob(root: string, pid: number): BackgroundJob | undefined {
    const job = this.owned.get(root)?.jobs.get(pid)
    if (job !== undefined) this.owned.get(root)?.jobs.delete(pid)
    return job
  }

  addViewer(root: string, host: ViewerHost): void {
    this.entry(root).viewers.set(key(host), host)
  }

  removeViewer(root: string, host: ViewerHost): void {
    this.owned.get(root)?.viewers.delete(key(host))
  }

  /** Remove and return everything the session owns. */
  take(root: string): { jobs: BackgroundJob[]; viewers: ViewerHost[] } {
    const owned = this.owned.get(root)
    this.owned.delete(root)
    return { jobs: [...(owned?.jobs.values() ?? [])], viewers: [...(owned?.viewers.values() ?? [])] }
  }

  roots(): string[] {
    return [...this.owned.keys()]
  }
}
