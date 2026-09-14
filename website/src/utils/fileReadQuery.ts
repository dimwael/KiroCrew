/**
 * The ONE `/api/file-read` read for a side-panel tab.
 *
 * Three callers read a file into a tab: `usePanelDocumentActions.openFile`
 * (chip / tree click), `SidePanel`'s `HydratingFileTab` (a restored tab after
 * a reload), and `MarkdownPanel`'s own disk refresh (Refresh, Cancel, the file
 * watch). Each
 * replaces the tab's buffer AND its "is this still text" verdict, so the one
 * thing that must never happen is an OLDER read landing after a NEWER one: the
 * editor would come back over bytes it cannot represent and a save would write
 * them over the newer file. A per-caller counter cannot rule that out, because
 * the callers race each other, not just themselves. So every read takes a
 * ticket here, and a read that was overtaken by a live read does not hand back
 * its own bytes: it hands back the outcome of the path's newest live read, so
 * every caller that asked receives the same, latest answer -- a click that
 * raced the panel's refresh still opens its tab, with the refresh's bytes.
 * Only a read its caller withdrew (an abort on unmount or path change) answers
 * `superseded`; it drops out of the ordering entirely. There is deliberately no
 * cache: one extra GET on a reopen is the price of having exactly one order.
 */
import { fileReadUrl } from './fileReadUrl'

/** Outcome of an arbitrated read. `superseded` means the caller withdrew this
 *  read (aborted it) and must apply nothing and say nothing. An overtaken read
 *  never answers `superseded`: it answers with the newest live read's outcome. */
export type FileRead =
  | { kind: 'ok'; text: string; binary: boolean }
  | { kind: 'failed'; status: number; error?: unknown }
  | { kind: 'superseded' }

interface LiveRead {
  ticket: number
  promise: Promise<FileRead>
}

interface PathReads {
  /** Reads of this path that have not been aborted, ascending by ticket. A
   *  completed read stays here so an older straggler can adopt its promise
   *  until the whole entry is released. An aborted read is removed because it
   *  was withdrawn and must not order another caller's result. */
  live: LiveRead[]
  inflight: number
}

const paths = new Map<string, PathReads>()
let nextTicket = 0

// Test-only visibility for proving settled paths do not stay retained.
export function __inflightPathsForTest(): string[] { return [...paths.keys()] }

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError'

export function readFile(filePath: string, signal?: AbortSignal): Promise<FileRead> {
  const ticket = ++nextTicket
  const entry = paths.get(filePath) ?? { live: [], inflight: 0 }
  paths.set(filePath, entry)
  entry.inflight += 1
  const me: LiveRead = {
    ticket,
    promise: undefined as unknown as Promise<FileRead>,
  }
  entry.live.push(me)

  const withdraw = () => { entry.live = entry.live.filter(read => read !== me) }
  const newerLive = (): LiveRead | null => {
    const newest = entry.live[entry.live.length - 1]
    return newest && newest.ticket > ticket ? newest : null
  }

  // Adopt the newest live read's outcome. If it was withdrawn while awaited,
  // look again: the next-newest live read now owns the path's answer. When no
  // live read is newer, this read's own outcome is the latest answer.
  const settle = async (own: FileRead): Promise<FileRead> => {
    // A caller that withdrew after the response arrived (the panel unmounted
    // between the fetch resolving and this point) still gets nothing to apply.
    if (signal?.aborted) { withdraw(); return { kind: 'superseded' } }
    for (;;) {
      const newer = newerLive()
      if (!newer) return own
      const adopted = await newer.promise
      if (adopted.kind !== 'superseded') return adopted
    }
  }

  const run = async (): Promise<FileRead> => {
    // readFile never rejects on transport or body errors: cold-tab hydration
    // and the panel refresh apply its result from a `.then` without a `.catch`.
    const outcomeForThrow = (error: unknown): Promise<FileRead> => {
      // An abort is the caller withdrawing (unmount, path change): remove it
      // before answering so any straggler awaiting it sees the shorter order.
      if (isAbort(error)) {
        withdraw()
        return Promise.resolve({ kind: 'superseded' })
      }
      return settle({ kind: 'failed', status: 0, error })
    }
    let res: Response
    try {
      res = signal ? await fetch(fileReadUrl(filePath), { signal }) : await fetch(fileReadUrl(filePath))
    } catch (error) {
      return outcomeForThrow(error)
    }
    // The verdict comes from the HEADER, not the body shape: a `.json` text file
    // is served as application/json too, so the content type cannot tell them apart.
    const binary = res.headers.get('X-File-Binary') === 'true'
    let text = ''
    if (res.ok && !binary) {
      try {
        text = await res.text()
      } catch (error) {
        return outcomeForThrow(error)
      }
    }
    return settle(res.ok
      ? { kind: 'ok', text, binary }
      : { kind: 'failed', status: res.status })
  }

  me.promise = run().finally(() => {
    entry.inflight -= 1
    if (entry.inflight === 0 && paths.get(filePath) === entry) {
      paths.delete(filePath)
    }
  })
  return me.promise
}
