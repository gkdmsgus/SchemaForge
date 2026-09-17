// Turns the board model (mm, KiCad coordinates: x right, y down) into flat
// polygons for an SVG 3D view. No WebGL and no extra dependency: the projection
// is orthographic, faces are sorted back-to-front (painter's algorithm), and the
// same board data drives this view and the 2D one, so they can never disagree.
//
// Axes here: x, y as on the board; h = height above the top copper (mm, up).
// tilt 0 = straight down (identical to the 2D view), tilt 90 = edge on.

import type { BoardPart, BoardTrack, BoardVia } from '../types'

export const BOARD_THICK = 1.6      // FR4 standard thickness (mm)
export const COPPER_LIFT = 0.02     // draw copper just off the surface so it never z-fights

export interface Camera {
  yaw: number        // degrees, rotation around the board normal
  tilt: number       // degrees, 0 = top view
  cx: number         // board centre the camera turns around (mm)
  cy: number
}

/** Orthographic projection. Returns screen x/y (mm) and depth (larger = nearer the camera). */
export function project(x: number, y: number, h: number, cam: Camera): [number, number, number] {
  const ry = (cam.yaw * Math.PI) / 180, rt = (cam.tilt * Math.PI) / 180
  const cyw = Math.cos(ry), syw = Math.sin(ry)
  const dx = x - cam.cx, dy = y - cam.cy
  const x1 = dx * cyw - dy * syw
  const y1 = dx * syw + dy * cyw
  const ct = Math.cos(rt), st = Math.sin(rt)
  return [x1, y1 * ct - h * st, y1 * st + h * ct]
}

// ── part heights ─────────────────────────────────────────────────────────────
// Nominal package heights in mm, for display only — they come from the usual
// datasheet values for these packages, not from the footprint files (a
// .kicad_mod carries no height). Checked for coverage over the test boards by
// scripts/check_3d.ts; anything unknown falls back to DEFAULT_HEIGHT.

export const DEFAULT_HEIGHT = 1.5

const HEIGHT_RULES: [RegExp, number][] = [
  // flat features: no body above the board, drawn as a top face only
  [/MountingHole|TestPoint/i, 0],
  [/Relay/i, 15.7],
  [/Buzzer|Speaker/i, 9.5],
  [/BatteryHolder|Battery/i, 6.0],
  [/PinHeader|Conn_|Screw_Terminal|TerminalBlock/i, 8.5],
  [/DIP-\d/i, 4.5],
  [/SOIC|SO-\d|SSOP|TSSOP/i, 1.75],
  [/TO-92/i, 5.2],
  [/TO-220/i, 16.0],
  [/SOT-23|SOT-223/i, 1.2],
  [/LED.*THT|THT.*LED|LED_D\d/i, 5.6],
  [/LED/i, 0.8],
  [/Crystal.*HC|HC-49/i, 4.0],
  [/Crystal/i, 1.2],
  [/CP_Radial|C_Radial/i, 11.0],
  [/CP_Elec/i, 5.4],
  [/C_Disc|C_Rect/i, 4.0],
  [/SW_|Push/i, 5.0],
  [/L_\d|Inductor/i, 1.2],
  [/R_Axial|D_DO-\d|_Horizontal|_Vertical/i, 2.6],
  [/R_\d{4}|C_\d{4}|D_SOD|L_\d{4}/i, 0.6],
]

/** Nominal height of a part's package (mm). Matches on the footprint name, then the part name. */
export function partHeight(footprint: string, part = ''): number {
  for (const [re, h] of HEIGHT_RULES) if (re.test(footprint) || re.test(part)) return h
  return DEFAULT_HEIGHT
}

const COLOR_RULES: [RegExp, string][] = [
  [/Relay/i, '#3a4a6b'],
  [/Buzzer|Speaker/i, '#23262b'],
  [/BatteryHolder|Battery/i, '#8a8f96'],
  [/PinHeader|Conn_|Terminal/i, '#e9e4d6'],
  [/DIP-\d|SOIC|SO-\d|SSOP|TSSOP/i, '#25272c'],
  [/LED/i, '#d64a3a'],
  [/CP_|C_Elec|C_Radial/i, '#2f5d8c'],
  [/Crystal/i, '#b8bcc2'],
  [/TO-92|SOT-23|TO-220/i, '#2a2c31'],
  [/^R_|R_\d{4}|R_Axial/i, '#3a3128'],
  [/^C_|C_\d{4}/i, '#8c7a56'],
  [/^D_|D_SOD|D_DO/i, '#1f2226'],
  [/SW_|Push/i, '#4a4d54'],
]

export function partColor(footprint: string, part = ''): string {
  for (const [re, c] of COLOR_RULES) if (re.test(footprint) || re.test(part)) return c
  return '#3b4048'
}

// ── geometry ─────────────────────────────────────────────────────────────────

export interface Face {
  pts: [number, number][]   // projected screen points (mm)
  depth: number             // centroid depth; larger is nearer the camera
  fill: string
  stroke?: string
  strokeWidth?: number
  opacity?: number
  kind: 'board' | 'part' | 'track' | 'via' | 'pad'
  ref?: string
  net?: string
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map(v => Math.max(0, Math.min(255, Math.round(v * k))))
  return `#${ch.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function rot2(px: number, py: number, deg: number): [number, number] {
  if (!deg) return [px, py]
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [px * c + py * s, -px * s + py * c]   // KiCad: rot is CCW on screen (y down)
}

function face(world: [number, number, number][], cam: Camera, rest: Omit<Face, 'pts' | 'depth'>): Face {
  const pts: [number, number][] = []
  let sum = 0
  for (const [x, y, h] of world) {
    const [sx, sy, dep] = project(x, y, h, cam)
    pts.push([sx, sy])
    sum += dep
  }
  return { ...rest, pts, depth: sum / world.length }
}

/** The FR4 slab: top face plus the four sides down to -BOARD_THICK. */
export function boardFaces(outline: [number, number, number, number], cam: Camera): Face[] {
  const [x1, y1, x2, y2] = outline
  const top = '#0c2418', side = '#081a11'
  const corners: [number, number][] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
  const out: Face[] = [
    face(corners.map(([x, y]) => [x, y, 0] as [number, number, number]), cam,
      { fill: top, stroke: '#e8c97a', strokeWidth: 0.08, kind: 'board' }),
  ]
  for (let k = 0; k < 4; k++) {
    const a = corners[k], b = corners[(k + 1) % 4]
    out.push(face([[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], -BOARD_THICK], [a[0], a[1], -BOARD_THICK]],
      cam, { fill: side, kind: 'board' }))
  }
  return out
}

/** One part as a box: top face plus four sides, shaded by which way each side faces. */
export function partFaces(
  p: BoardPart, x: number, y: number, rot: number, cam: Camera,
): Face[] {
  const [bx1, by1, bx2, by2] = p.bbox
  const h = partHeight(p.footprint, p.part)
  const base = partColor(p.footprint, p.part)
  const local: [number, number][] = [[bx1, by1], [bx2, by1], [bx2, by2], [bx1, by2]]
  const world = local.map(([a, b]) => {
    const [rx, ry] = rot2(a, b, rot)
    return [x + rx, y + ry] as [number, number]
  })
  const out: Face[] = []
  for (let k = 0; h > 0 && k < 4; k++) {
    const a = world[k], b = world[(k + 1) % 4]
    // light from the upper left of the screen: shade by the side's screen direction
    const [ax, ay] = project(a[0], a[1], 0, cam)
    const [bx, by] = project(b[0], b[1], 0, cam)
    const nx = by - ay, ny = -(bx - ax)
    const len = Math.hypot(nx, ny) || 1
    const lit = 0.55 + 0.35 * Math.max(0, (nx / len) * -0.6 + (ny / len) * 0.8)
    out.push(face([[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h], [a[0], a[1], h]], cam,
      { fill: shade(base, lit), kind: 'part', ref: p.ref }))
  }
  out.push(face(world.map(([a, b]) => [a, b, h] as [number, number, number]), cam,
    { fill: shade(base, 1.25), stroke: shade(base, 0.5), strokeWidth: 0.04, kind: 'part', ref: p.ref }))
  return out
}

/** A copper track as a flat quad on its layer's surface. */
export function trackFace(t: BoardTrack, cam: Camera): Face {
  const h = t.layer === 'F.Cu' ? COPPER_LIFT : -BOARD_THICK - COPPER_LIFT
  const dx = t.x2 - t.x1, dy = t.y2 - t.y1
  const len = Math.hypot(dx, dy) || 1
  const ux = (dx / len) * (t.width / 2), uy = (dy / len) * (t.width / 2)   // extend the ends (round caps)
  const nx = (-dy / len) * (t.width / 2), ny = (dx / len) * (t.width / 2)
  const a: [number, number] = [t.x1 - ux, t.y1 - uy]
  const b: [number, number] = [t.x2 + ux, t.y2 + uy]
  return face([[a[0] + nx, a[1] + ny, h], [b[0] + nx, b[1] + ny, h],
               [b[0] - nx, b[1] - ny, h], [a[0] - nx, a[1] - ny, h]], cam,
    { fill: t.layer === 'F.Cu' ? '#c83434' : '#4d7fc4', kind: 'track', net: t.net })
}

/** A via as a short barrel through the board (an octagon prism keeps it cheap). */
export function viaFaces(v: BoardVia, cam: Camera, r = 0.4): Face[] {
  const ring: [number, number][] = []
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    ring.push([v.x + Math.cos(a) * r, v.y + Math.sin(a) * r])
  }
  const out: Face[] = [
    face(ring.map(([x, y]) => [x, y, COPPER_LIFT] as [number, number, number]), cam,
      { fill: '#e8c97a', kind: 'via', net: v.net }),
  ]
  for (let k = 0; k < 8; k++) {
    const a = ring[k], b = ring[(k + 1) % 8]
    out.push(face([[a[0], a[1], COPPER_LIFT], [b[0], b[1], COPPER_LIFT],
                   [b[0], b[1], -BOARD_THICK], [a[0], a[1], -BOARD_THICK]], cam,
      { fill: '#b98f4e', kind: 'via', net: v.net }))
  }
  return out
}

// Depth alone is not enough: the board top is one big polygon, so any single depth
// value for it is wrong somewhere. But the stack here is known — copper lies on the
// board, parts stand on the copper, and a part can only ever cover what is behind or
// under it — so draw by layer first and sort by depth only inside a layer.
const RANK: Record<Face['kind'], number> = { board: 0, track: 1, pad: 2, via: 3, part: 4 }

/** Everything in one list, far faces first, so drawing them in order is correct. */
export function sortFaces(faces: Face[]): Face[] {
  return faces.slice().sort((a, b) => (RANK[a.kind] - RANK[b.kind]) || (a.depth - b.depth))
}

export const faceRank = (f: Face) => RANK[f.kind]

/** Screen bounding box of a set of faces (mm), for fitting the camera. */
export function facesBounds(faces: Face[]): [number, number, number, number] {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const f of faces) for (const [x, y] of f.pts) {
    if (x < x1) x1 = x
    if (y < y1) y1 = y
    if (x > x2) x2 = x
    if (y > y2) y2 = y
  }
  return Number.isFinite(x1) ? [x1, y1, x2, y2] : [0, 0, 1, 1]
}
