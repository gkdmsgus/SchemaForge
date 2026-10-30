// Right-angle wires for the schematic that go around the parts. A wire bent once halfway between its two pins
// ran through the part bodies in between: the 555 blinker's LED net crossed D1, R1, R2 and R3, so it read as a
// wire from D1's GND pin to R1's VCC pin (frame review of 2026-10-30).
// Each link (two pins of one net) is found by A* on a grid of lines every STEP units plus a line through every
// pin, so a wire starts and ends exactly on its pins. Part boxes and power symbols are walls and so is the spot
// around another net's pin; running along another net's wire costs a lot, crossing it or bending a little.

export interface Pt { x: number; y: number }
export interface Box { x0: number; y0: number; x1: number; y1: number }
export type Side = 'L' | 'R' | 'T' | 'B'
/** A pin's end, the side of the part it leaves from, and its net (-1: on no net). */
export interface PinEnd extends Pt { side: Side; net: number }
export interface Link { net: number; a: PinEnd; b: PinEnd }

// lines closer than GAP are one channel: a wire there sits on top of the other (two pins' lines can be 4 apart)
const STEP = 20, NEAR = 5, GAP = 7, ROOM = 40, PIN_CLEAR = 13
// ALONG: per unit run on another net's wire; PIN_TURN: a wire turning right at a pin instead of leaving it straight
// (two wires coming at a part's pins from above and below read as one line through them)
const BEND = 20, PIN_TURN = 60, CROSS = 12, JUNCTION = 400, ALONG = 30, H = 1.2
// directions 0 +x, 1 -x, 2 +y, 3 -y; the reverse of d is d ^ 1
const OUT: Record<Side, number> = { R: 0, L: 1, B: 2, T: 3 }
const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1]

/** Grid lines: one through every pin, and one every STEP between them that is not right beside a pin's. */
function lines(must: number[], lo: number, hi: number): number[] {
  const m = [...new Set(must)].sort((a, b) => a - b)
  const out = [...m]
  for (let v = Math.ceil(lo / STEP) * STEP; v <= hi; v += STEP) if (!m.some(u => Math.abs(u - v) < NEAR)) out.push(v)
  return out.sort((a, b) => a - b)
}

/** The route of every link, in order (each one avoids the ones before it), or null where none was found. */
export function routeLinks(links: Link[], walls: Box[], pins: PinEnd[]): (Pt[] | null)[] {
  if (!links.length) return []
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of [...walls, ...pins.map(p => ({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }))]) {
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1)
  }
  const ends = [...pins, ...links.flatMap(l => [l.a, l.b])]
  const xs = lines(ends.map(p => p.x), x0 - ROOM, x1 + ROOM), ys = lines(ends.map(p => p.y), y0 - ROOM, y1 + ROOM)
  const nx = xs.length, ny = ys.length, N = nx * ny
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, j) => [v, j]))
  const at = (p: Pt) => yi.get(p.y)! * nx + xi.get(p.x)!

  const wall = new Uint8Array(N)
  for (const b of walls)
    for (let j = 0; j < ny; j++) if (ys[j] > b.y0 && ys[j] < b.y1)
      for (let i = 0; i < nx; i++) if (xs[i] > b.x0 && xs[i] < b.x1) wall[j * nx + i] = 1
  // the net of the pin a point is close to: -2 none, -3 pins of two nets
  const nearPin = new Int32Array(N).fill(-2)
  for (const p of pins)
    for (let j = 0; j < ny; j++) if (Math.abs(ys[j] - p.y) < PIN_CLEAR)
      for (let i = 0; i < nx; i++) if (Math.abs(xs[i] - p.x) < PIN_CLEAR) {
        const k = j * nx + i
        nearPin[k] = nearPin[k] === -2 || nearPin[k] === p.net ? p.net : -3
      }
  // what earlier wires use: the net on each grid edge (h: k to k+1, v: k to k+nx, marked on every line of its
  // channel) and point, and where one bends
  const hUse = new Int32Array(N).fill(-1), vUse = new Int32Array(N).fill(-1), use = new Int32Array(N).fill(-1)
  const bend = new Uint8Array(N)
  const channel = (vs: number[]) => vs.map(v => vs.flatMap((w, n) => (Math.abs(w - v) < GAP ? [n] : [])))
  const rowsNear = channel(ys), colsNear = channel(xs)

  // search state per (point, direction); `seen` holds the link that last touched a state, so nothing is cleared
  const g = new Float64Array(N * 4), from = new Int32Array(N * 4), seen = new Int32Array(N * 4).fill(-1)
  const done = new Int32Array(N * 4).fill(-1)
  return links.map(({ net, a, b }, li) => {
    const s = at(a), t = at(b), endDir = OUT[b.side] ^ 1
    if (s === t) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]
    const heap = new Heap()
    // the length still to go, and a bend if it is not straight on; a little greedy (H), so a clear way is
    // taken at once instead of every way of the same length being tried
    const h = (k: number) => {
      const dx = Math.abs(xs[k % nx] - b.x), dy = Math.abs(ys[(k / nx) | 0] - b.y)
      return H * (dx + dy + (dx && dy ? BEND : 0))
    }
    const st0 = s * 4 + OUT[a.side]
    g[st0] = 0; from[st0] = -1; seen[st0] = li
    heap.push(st0, h(s))
    let found = -1
    while (heap.size) {
      const st = heap.pop()
      if (done[st] === li) continue
      done[st] = li
      const u = st >> 2, d = st & 3
      if (u === t) { found = st; break }
      const ui = u % nx, uj = (u / nx) | 0
      for (let d2 = 0; d2 < 4; d2++) {
        if (d2 === (d ^ 1)) continue
        const vi = ui + DX[d2], vj = uj + DY[d2]
        if (vi < 0 || vi >= nx || vj < 0 || vj >= ny) continue
        const v = vj * nx + vi
        if (v !== t && (wall[v] || (nearPin[v] !== -2 && nearPin[v] !== net))) continue
        const len = d2 < 2 ? Math.abs(xs[vi] - xs[ui]) : Math.abs(ys[vj] - ys[uj])
        let c = len
        if (d2 !== d) c += (u === s ? PIN_TURN : BEND) + (use[u] >= 0 && use[u] !== net ? JUNCTION : 0)   // a corner on another wire reads as a join
        const e = d2 === 0 ? hUse[u] : d2 === 1 ? hUse[v] : d2 === 2 ? vUse[u] : vUse[v]
        if (e >= 0 && e !== net) c += ALONG * len
        if (use[v] >= 0 && use[v] !== net) c += bend[v] ? JUNCTION : CROSS
        if (v === t && d2 !== endDir) c += PIN_TURN
        const ns = v * 4 + d2, ng = g[st] + c
        if (seen[ns] !== li || ng < g[ns]) { seen[ns] = li; g[ns] = ng; from[ns] = st; heap.push(ns, ng + h(v)) }
      }
    }
    if (found < 0) return null
    const path: number[] = []
    for (let st = found; st >= 0; st = from[st]) path.push(st >> 2)
    path.reverse()
    // keep the ends and the corners, and mark what this wire now uses
    const pts: Pt[] = []
    path.forEach((k, n) => {
      const prev = path[n - 1], next = path[n + 1]
      const corner = prev === undefined || next === undefined || (next - k) !== (k - prev)
      if (use[k] < 0) use[k] = net
      if (corner) {
        // another wire passing right beside a corner reads as joining it too
        pts.push({ x: xs[k % nx], y: ys[(k / nx) | 0] })
        for (const r of rowsNear[(k / nx) | 0]) for (const c of colsNear[k % nx]) {
          const q = r * nx + c
          if (use[q] < 0) use[q] = net
          if (use[q] === net) bend[q] = 1
        }
      }
      if (next !== undefined) {
        const lo = Math.min(k, next), i = lo % nx, j = (lo / nx) | 0
        if (Math.abs(next - k) === 1) { for (const r of rowsNear[j]) if (hUse[r * nx + i] < 0) hUse[r * nx + i] = net }
        else for (const c of colsNear[i]) if (vUse[j * nx + c] < 0) vUse[j * nx + c] = net
      }
    })
    return pts
  })
}

/** A binary min-heap of grid states by priority. */
class Heap {
  private k: number[] = []
  private p: number[] = []
  get size() { return this.k.length }
  push(key: number, pri: number) {
    const k = this.k, p = this.p
    let i = k.length
    k.push(key); p.push(pri)
    while (i > 0) {
      const up = (i - 1) >> 1
      if (p[up] <= pri) break
      k[i] = k[up]; p[i] = p[up]; i = up
    }
    k[i] = key; p[i] = pri
  }
  pop(): number {
    const k = this.k, p = this.p, top = k[0]
    const key = k.pop()!, pri = p.pop()!
    if (k.length) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= k.length) break
        if (c + 1 < k.length && p[c + 1] < p[c]) c++
        if (p[c] >= pri) break
        k[i] = k[c]; p[i] = p[c]; i = c
      }
      k[i] = key; p[i] = pri
    }
    return top
  }
}
