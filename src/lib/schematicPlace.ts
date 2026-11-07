// Where the parts an edit adds go on a schematic already on screen. Every edit used to lay the whole circuit out
// again: the 555's nine parts sat in three columns and ten made four, so adding C4 with the AI editor moved every
// part, and undo moved them all back (2026-11-02 tour, 325-329 s). Now the parts there keep their spots, dragged ones
// too, and each new part takes the free spot nearest the parts it shares a net with, inside the part of the drawing
// on screen when there is room there, so the view need not move either; with no room there, the spot that makes the
// view zoom out least (a fourth column in a wide view, not a row on top). Free means the auto layout's room to every
// part: GAP_X beside it or GAP_Y above or below, where the wires and power symbols go.
// A part that comes back (undo of its removal) takes its last spot when that spot clears every part there: undoing
// "LED D1 빼줘" put D1 on the free spot nearest its nets, under U1 instead of beside R1 (2026-11-03 tour, 350-360 s).
// Coming back means the same kind on the same nets (partKey): a new capacitor that gets the ref C4 again after an undo
// goes by its own nets, not to the spot of the C4 undone (review of 2026-11-03).
import type { Box, Pt } from './schematicRoute'
import type { NetGraph } from '../types'

export interface Size { w: number; h: number }

/**
 * Where the parts sat on one result's schematic, kept by the result panel: the schematic is unmounted on the other
 * tabs, and laid out again it moved every part (2026-11-03 tour, 328 s). `at` is the last layout with the graph it was
 * for; `gone` the last spot of each part a graph change took out, by its ref and partKey: by ref alone a diode that
 * took the ref D1 after "LED D1 빼줘" wrote over the LED's spot, and two undos put the LED by its nets (recheck of
 * 2026-11-03). `pins`: how many pins each part (ref and kind) has been drawn with (CircuitCanvas layouts).
 */
export interface Spots { graph?: NetGraph; at: Record<string, Pt>; gone: Record<string, Pt>; pins?: Record<string, number> }

/** a part's ref, kind and the net on each of its pins: the same for a part an undo brings back */
export function partKey(graph: NetGraph, ref: string): string {
  const pins = (graph.nets || []).flatMap(n => n.nodes.filter(nd => nd.ref === ref).map(nd => `${nd.pin}=${n.name}`)).sort()
  return `${ref}|${(graph.components || []).find(c => c.ref === ref)?.name ?? ''}|${pins.join(',')}`
}

/**
 * The spots for `graph` from the layout `was` of graph `from` (the circuit on screen before an edit, or the one the
 * schematic left when another tab was shown; undefined: a new circuit). The parts in both keep their spots exactly,
 * even over each other; those `from` loses go into `gone`; a part that comes back with the same kind and nets gets its
 * spot back when its body clears the others; the rest go by placeAdded. null when there is nothing to keep: the auto
 * layout then.
 */
export function carryOver(from: NetGraph | undefined, was: Record<string, Pt>, graph: NetGraph, gone: Record<string, Pt>,
  size: Record<string, Size>, view: Box | null): Record<string, Pt> | null {
  if (!from) return null
  const refs = (graph.components || []).map(c => c.ref)
  const kept = Object.fromEntries(refs.filter(r => was[r]).map(r => [r, was[r]]))
  for (const ref of Object.keys(was)) if (!refs.includes(ref)) gone[partKey(from, ref)] = was[ref]
  const back = Object.fromEntries(refs.filter(r => !kept[r] && gone[partKey(graph, r)]).map(r => [r, gone[partKey(graph, r)]]))
  if (!Object.keys(kept).length && !Object.keys(back).length) return null
  return placeAdded(kept, refs.filter(r => !kept[r]), size, graph.nets || [], view, back)
}

/** the room between parts, as the auto layout leaves it (CircuitCanvas autoLayout HGAP, VGAP) */
export const GAP_X = 110, GAP_Y = 100
// spots tried every STEP; a spot in a column or row of the parts there costs ALIGN less on each axis; a part in view
// keeps EDGE clear of the view's edge for its pin stubs and power symbols
const STEP = 10, ALIGN = 40, EDGE = 40

/**
 * The kept spots plus one for each added part (in order, each one then taken), from the parts' sizes, the nets
 * (which parts an added one is near) and the visible part of the drawing (null: anywhere). An added part with a spot
 * in `back` (where it was last) goes there first when its body overlaps no part there, the gaps aside: the parts
 * around it may have been dragged closer since.
 */
export function placeAdded(kept: Record<string, Pt>, added: string[], size: Record<string, Size>,
  nets: { nodes: { ref: string }[] }[], view: Box | null = null, back: Record<string, Pt> = {}): Record<string, Pt> {
  const pos: Record<string, Pt> = { ...kept }
  const sz = (ref: string) => size[ref] ?? { w: 80, h: 60 }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
  const clear = (ref: string, p: Pt) => Object.keys(pos).every(r => Math.abs(p.x - pos[r].x) >= (sz(ref).w + sz(r).w) / 2
    || Math.abs(p.y - pos[r].y) >= (sz(ref).h + sz(r).h) / 2)
  // the ones coming back first, so a new part does not take their spot
  for (const ref of [...added.filter(r => back[r]), ...added.filter(r => !back[r])]) {
    if (back[ref] && clear(ref, back[ref])) { pos[ref] = back[ref]; continue }
    const there = Object.keys(pos), { w, h } = sz(ref)
    if (!there.length) { pos[ref] = { x: w / 2 + GAP_X, y: h / 2 + GAP_Y }; continue }
    const near = [...new Set(nets.filter(n => n.nodes.some(nd => nd.ref === ref)).flatMap(n => n.nodes.map(nd => nd.ref)))]
      .filter(r => r !== ref && pos[r])
    const from = near.length ? near : there
    const target = { x: mean(from.map(r => pos[r].x)), y: mean(from.map(r => pos[r].y)) }
    // the parts there; tried: around them, one part and one gap past each side (that ring is always free)
    const all = { x0: Math.min(...there.map(r => pos[r].x - sz(r).w / 2)), y0: Math.min(...there.map(r => pos[r].y - sz(r).h / 2)),
      x1: Math.max(...there.map(r => pos[r].x + sz(r).w / 2)), y1: Math.max(...there.map(r => pos[r].y + sz(r).h / 2)) }
    const x0 = all.x0 - w - GAP_X, x1 = all.x1 + w + GAP_X, y0 = all.y0 - h - GAP_Y, y1 = all.y1 + h + GAP_Y
    const cols = new Set(there.map(r => pos[r].x)), rows = new Set(there.map(r => pos[r].y))
    const grid = (a: number, b: number, line: Set<number>) => {
      const out = new Set(line)
      for (let v = Math.ceil(a / STEP) * STEP; v <= b; v += STEP) out.add(v)
      return [...out].filter(v => v >= a && v <= b).sort((p, q) => p - q)
    }
    const free = (x: number, y: number) => there.every(r => Math.abs(x - pos[r].x) >= (w + sz(r).w) / 2 + GAP_X
      || Math.abs(y - pos[r].y) >= (h + sz(r).h) / 2 + GAP_Y)
    // out of view: how far the view would zoom out to show all the parts with this one (0: no further)
    const away = (x: number, y: number) => {
      if (!view) return 0
      const u = { x0: Math.min(all.x0, x - w / 2) - EDGE, y0: Math.min(all.y0, y - h / 2) - EDGE,
        x1: Math.max(all.x1, x + w / 2) + EDGE, y1: Math.max(all.y1, y + h / 2) + EDGE }
      if (u.x0 >= view.x0 && u.x1 <= view.x1 && u.y0 >= view.y0 && u.y1 <= view.y1) return 0
      return 1 + Math.max(0, (u.x1 - u.x0) / (view.x1 - view.x0) - 1, (u.y1 - u.y0) / (view.y1 - view.y0) - 1)
    }
    let best = { x: x1, y: target.y }, cost = Infinity
    for (const y of grid(y0, y1, rows)) for (const x of grid(x0, x1, cols)) {
      if (!free(x, y)) continue
      const c = away(x, y) * 1e6 + Math.hypot(x - target.x, y - target.y) + (cols.has(x) ? 0 : ALIGN) + (rows.has(y) ? 0 : ALIGN)
      if (c < cost) { cost = c; best = { x, y } }
    }
    pos[ref] = best
  }
  return pos
}
