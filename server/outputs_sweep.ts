// What a deployed server keeps in outputs/: every netlist, board and gerber folder stayed for good, and some of them are
// written without a login (/netlist/restore, a demo's board). On Render the disk went with each restart; on the Jetson
// the container's layer is on the SD card the other services share, and a client posting graphs filled it at about
// 21 MB/s in a test (review of 2026-11-03). So entries older than keepHours go, and the oldest go first while the
// folder is over maxBytes. A saved session needs none of them: its netlist is written again from its graph.
import { readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

export interface Swept { removed: string[]; bytes: number }

/** the size of a file, or of a folder and everything in it */
function sizeOf(path: string): number {
  const st = statSync(path)
  if (!st.isDirectory()) return st.size
  return readdirSync(path).reduce((n, name) => n + sizeOf(join(path, name)), 0)
}

/** removes the entries of dir older than keepHours, then the oldest while the rest is over maxBytes */
export function sweepOutputs(dir: string, keepHours: number, maxBytes: number, now = Date.now()): Swept {
  const entries = readdirSync(dir).map(name => {
    const path = join(dir, name)
    try { return { name, path, mtime: statSync(path).mtimeMs, bytes: sizeOf(path) } } catch { return null }
  }).filter((e): e is NonNullable<typeof e> => !!e).sort((a, b) => a.mtime - b.mtime)
  const removed: string[] = []
  let total = entries.reduce((n, e) => n + e.bytes, 0)
  for (const e of entries) {
    if (now - e.mtime <= keepHours * 3600_000 && total <= maxBytes) break
    try { rmSync(e.path, { recursive: true, force: true }); removed.push(e.name); total -= e.bytes } catch { /* in use: next time */ }
  }
  return { removed, bytes: total }
}
