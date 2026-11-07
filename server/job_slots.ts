// How many heavy jobs (a board's python and its first DRC, an AI round's reroute and DRC, a 3D export, gerbers, the
// netlist check) the server runs at once, and who waits. Nothing capped them: 16 demo boards at once took about 2 GB on
// the development PC, the Jetson container's whole memory cap, and the kernel then stops the biggest process (review of
// 2026-11-08). Kept out of index.ts so check_job_slots.ts tests the rules the server uses.

/** a slot this job holds; release() gives it back once, later calls do nothing */
export interface Slot { release: () => void }

/**
 * Why no slot came: full = the waiting line is at its cap, mine = this key already waits for its share, waited = the
 * longest wait passed, gone = the request was stopped (the visitor left, or another request took its board over)
 */
export interface Refused { busy: 'full' | 'mine' | 'waited' | 'gone' }

export type Answer = Slot | Refused

export const refused = (a: Answer): a is Refused => 'busy' in a

/** what one key (a visitor's address) may hold: running at once, and waiting in line */
export interface Share { running: number; waiting: number }

interface Waiter { key: string; give: (a: Answer) => void; done: () => void }

export class Slots {
  private running = 0
  private readonly runningBy = new Map<string, number>()
  private readonly line: Waiter[] = []

  constructor(readonly slots: number, readonly maxWaiting: number, readonly maxWaitMs: number,
              readonly share: Share = { running: Infinity, waiting: Infinity }) {}

  /** what /health shows; never who holds what */
  counts() { return { running: this.running, waiting: this.line.length, slots: this.slots } }

  /**
   * A slot for this key now, or a place in line until one is free. The line is first come, first served, except that
   * a key at its running share lets the next key go first. A stopped signal takes the request out of the line.
   */
  acquire(key: string, signal?: AbortSignal): Promise<Answer> {
    if (signal?.aborted) return Promise.resolve({ busy: 'gone' })
    if (this.canRun(key)) return Promise.resolve(this.grant(key))
    if (this.line.length >= this.maxWaiting) return Promise.resolve({ busy: 'full' })
    if (this.line.filter(w => w.key === key).length >= this.share.waiting) return Promise.resolve({ busy: 'mine' })
    return new Promise<Answer>(resolve => {
      const leave = (why: Refused['busy']) => {
        const at = this.line.indexOf(waiter)
        if (at < 0) return
        this.line.splice(at, 1)
        waiter.done()
        resolve({ busy: why })
        // a key that left may have been the one holding back the line behind it
        this.pump()
      }
      const timer = setTimeout(() => leave('waited'), this.maxWaitMs)
      const onAbort = () => leave('gone')
      const waiter: Waiter = {
        key,
        give: resolve,
        done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.line.push(waiter)
    })
  }

  private canRun(key: string) {
    return this.running < this.slots && (this.runningBy.get(key) ?? 0) < this.share.running
  }

  private grant(key: string): Slot {
    this.running++
    this.runningBy.set(key, (this.runningBy.get(key) ?? 0) + 1)
    let held = true
    return {
      release: () => {
        if (!held) return
        held = false
        this.running--
        const n = (this.runningBy.get(key) ?? 1) - 1
        if (n > 0) this.runningBy.set(key, n)
        else this.runningBy.delete(key)
        this.pump()
      },
    }
  }

  /** hand free slots to the line, in order, skipping a key that runs its share already */
  private pump() {
    for (let i = 0; i < this.line.length && this.running < this.slots;) {
      const w = this.line[i]
      if (!this.canRun(w.key)) { i++; continue }
      this.line.splice(i, 1)
      w.done()
      w.give(this.grant(w.key))
    }
  }
}

/**
 * The key a visitor's jobs are counted under: an IPv4 address as itself (written plain or IPv4-mapped), an IPv6 one by
 * its first 64 bits, the block one home connection gets, so a visitor does not get a share for each address in it.
 */
export function clientKey(ip: string | undefined): string {
  const a = String(ip ?? '').trim().replace(/%.*$/, '').toLowerCase()
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a)
  if (v4) return v4[1]
  if (!a.includes(':')) return a || 'unknown'
  const [head, tail] = a.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`
}
