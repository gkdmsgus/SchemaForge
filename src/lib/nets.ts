// What the schematic (CircuitCanvas) and the PCB tab's sketch (PCBLayout) both read from a circuit's nets. Each kept
// its own copy, and the two had drifted: a net named V33 was a supply in the schematic and a signal on the sketch.
import type { NetEntry } from '../types'

/** The highest pin number of a part in the nets, at least 2 (a pin written as a name counts as 2). */
export function getMaxPin(ref: string, nets: NetEntry[]): number {
  let m = 2
  nets.forEach(n => n.nodes.forEach(nd => { if (nd.ref === ref) m = Math.max(m, parseInt(nd.pin) || 2) }))
  return m
}

/** A supply or ground net, by its name (GND, VCC, 3V3, V33, 12V ...). */
export function isPowerNet(name: string): boolean {
  if (!name) return false
  const n = name.toUpperCase()
  return ['GND','AGND','DGND','PGND','SGND','EARTH','PWR','POWER','VBAT','AVCC','VREF'].includes(n)
    || /^VCC/.test(n) || /^VDD/.test(n) || /^VEE/.test(n) || /^VSS/.test(n)
    || /^VIN/.test(n) || /^VOUT/.test(n) || /^3V/.test(n) || /^5V/.test(n)
    || /^12V/.test(n) || /^V3\d/.test(n) || /^V5\d/.test(n) || /^\d+V\d*$/.test(n)
}

/** Minimum spanning tree (Prim's, Manhattan distance) over the points: the [from, to] index pairs to draw. */
export function buildMST(pts: { x: number; y: number }[]): number[][] {
  const n = pts.length
  if (n <= 1) return []
  const inMST = new Array(n).fill(false)
  const minDist = new Array(n).fill(Infinity)
  const parent = new Array(n).fill(-1)
  minDist[0] = 0
  const edges = []
  for (let iter = 0; iter < n; iter++) {
    let u = -1
    for (let i = 0; i < n; i++) {
      if (!inMST[i] && (u === -1 || minDist[i] < minDist[u])) u = i
    }
    inMST[u] = true
    if (parent[u] !== -1) edges.push([parent[u], u])
    for (let v = 0; v < n; v++) {
      if (!inMST[v]) {
        const d = Math.abs(pts[u].x - pts[v].x) + Math.abs(pts[u].y - pts[v].y)
        if (d < minDist[v]) { minDist[v] = d; parent[v] = u }
      }
    }
  }
  return edges
}
