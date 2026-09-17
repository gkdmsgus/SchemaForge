import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BoardFrame, BoardModel, BoardPart, BoardPad, BoardTrack, BoardVia, RouteEvent, DrcResult, AiRound, SilkItem,
} from '../types'
import Board3D from './Board3D'
import KiCad3DViewer from './KiCad3DViewer'
import type { Camera } from '../lib/board3d'

// Draws the real board model (mm) streamed by /generate_pcb_stream and plays it
// back: placement frames first, then routing events one connection at a time.
// Coordinates follow KiCad: y down, rot in degrees counter-clockwise on screen —
// i.e. SVG rotate(-rot).

// Board colours follow a KiCad layout editor on a light sheet: copper red on the front,
// blue on the back, silkscreen grey, the board itself near-white.
const SHEET = '#efefe9'           // paper behind the board
const PCB_FILL = '#fbfbf7'        // board body
const EDGE = '#2f2f2f'            // Edge.Cuts
const HOLE = '#ffffff'            // drill
const RATSNEST = '#6f9fd8'
const SILK = '#4a4a4a'            // F.SilkS graphics and reference text
const COURTYARD = 'rgba(120, 130, 120, 0.22)'
const LAYER_COLOR: Record<string, string> = { 'F.Cu': '#c83434', 'B.Cu': '#4d7fc4' }
const PAD_HI = '#f2a33c'
const POUR_FILL: Record<string, string> = { 'F.Cu': 'rgba(200, 52, 52, 0.16)', 'B.Cu': 'rgba(77, 127, 196, 0.16)' }
const VIA_RING = '#6f6f6f'
const VIA_SIZE = 0.6, VIA_DRILL = 0.3
const PAD_LABEL_MIN = 1.1         // mm: label a pad with its net once it is at least this big

// Panels sit on the light sheet, so they are light too (the app around them stays dark).
const UI_BG = 'rgba(255, 255, 255, 0.92)'
const UI_LINE = 'rgba(0, 0, 0, 0.14)'
const UI_FG = '#23262b'
const UI_DIM = '#6b7079'
const UI_OK = '#1f7a4d'
const UI_WARN = '#b26a00'
const UI_BAD = '#c0392b'
const UI_ACCENT = '#5a3fa0'

const FRAME_MS = 30          // placement playback: one frame every 30 ms (~70 frames ≈ 2 s)
const FIT_MS = 600           // camera move from the scatter view to the finished board
const ROUTE_MS = 140         // routing playback: one connection every 140 ms

const PHASE_LABEL: Record<string, string> = {
  force: '부품 모으는 중',
  legalize: '겹침 정리 · 회전',
  refine: '다듬는 중',
}

type Box = [number, number, number, number]

interface Props {
  parts: BoardPart[]
  frames: BoardFrame[]
  routes: RouteEvent[]
  target: Box | null            // frame the placer aims for (from the init event)
  final: BoardModel | null      // board.json after "done"
  drc: DrcResult | null         // KiCad design rule check, run by the server after the board is written
  ai?: AiRound[]                // AI improvement rounds (stage 4), empty when the toggle is off
  pcbFilename?: string          // board on the server, for KiCad's own 3D render
  hpwlShelf?: number
  status: 'streaming' | 'done' | 'error'
}

interface Finding {
  id: string
  source: 'DRC' | '회로'
  severity: 'error' | 'warning'
  text: string
  pos?: { x: number; y: number }
}

function rotate(px: number, py: number, rot: number): [number, number] {
  if (!rot) return [px, py]
  const a = (rot * Math.PI) / 180
  const c = Math.cos(a), s = Math.sin(a)
  return [px * c + py * s, -px * s + py * c]
}

function partBox(p: BoardPart, x: number, y: number, rot: number): Box {
  const [x1, y1, x2, y2] = p.bbox
  const pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([a, b]) => rotate(a, b, rot))
  return [x + Math.min(...pts.map(q => q[0])), y + Math.min(...pts.map(q => q[1])),
          x + Math.max(...pts.map(q => q[0])), y + Math.max(...pts.map(q => q[1]))]
}

function union(boxes: Box[]): Box {
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
          Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))]
}

function pad(b: Box, m: number): Box {
  return [b[0] - m, b[1] - m, b[2] + m, b[3] + m]
}

const segLen = (t: BoardTrack) => Math.hypot(t.x2 - t.x1, t.y2 - t.y1)

/** Prim's minimum spanning tree over points (Euclidean) — the ratsnest of one net. */
function mst(pts: [number, number][]): [number, number][] {
  const n = pts.length
  if (n < 2) return []
  const inTree = new Array(n).fill(false)
  const dist = new Array(n).fill(Infinity)
  const parent = new Array(n).fill(-1)
  dist[0] = 0
  const edges: [number, number][] = []
  for (let k = 0; k < n; k++) {
    let u = -1
    for (let i = 0; i < n; i++) if (!inTree[i] && (u === -1 || dist[i] < dist[u])) u = i
    inTree[u] = true
    if (parent[u] >= 0) edges.push([parent[u], u])
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue
      const d = Math.hypot(pts[u][0] - pts[v][0], pts[u][1] - pts[v][1])
      if (d < dist[v]) { dist[v] = d; parent[v] = u }
    }
  }
  return edges
}

function SilkShape({ items }: { items: SilkItem[] }) {
  return (
    <g fill="none" stroke={SILK} strokeLinecap="round" strokeLinejoin="round">
      {items.map((it, k) => {
        if (it.t === 'line') return <line key={k} x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} strokeWidth={it.w} />
        if (it.t === 'circle') return <circle key={k} cx={it.cx} cy={it.cy} r={it.r} strokeWidth={it.w} />
        if (it.t === 'poly') {
          return <polyline key={k} points={it.pts.map(q => `${q[0]},${q[1]}`).join(' ')} strokeWidth={it.w} />
        }
        // arc through three points: centre from the perpendicular bisectors, then one SVG arc
        const { x1, y1, mx, my, x2, y2, w } = it
        const d = 2 * (x1 * (my - y2) + mx * (y2 - y1) + x2 * (y1 - my))
        if (Math.abs(d) < 1e-9) return <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={w} />
        const ux = ((x1 * x1 + y1 * y1) * (my - y2) + (mx * mx + my * my) * (y2 - y1) + (x2 * x2 + y2 * y2) * (y1 - my)) / d
        const uy = ((x1 * x1 + y1 * y1) * (x2 - mx) + (mx * mx + my * my) * (x1 - x2) + (x2 * x2 + y2 * y2) * (mx - x1)) / d
        const r = Math.hypot(x1 - ux, y1 - uy)
        const cross = (mx - x1) * (y2 - y1) - (my - y1) * (x2 - x1)
        const sweep = cross > 0 ? 0 : 1
        return <path key={k} d={`M ${x1} ${y1} A ${r} ${r} 0 0 ${sweep} ${x2} ${y2}`} strokeWidth={w} />
      })}
    </g>
  )
}

function PadShape({ p, hi }: { p: BoardPad; hi: boolean }) {
  // Our generator puts SMD pads on the front; a drilled pad reaches both layers.
  const fill = hi ? PAD_HI : LAYER_COLOR['F.Cu']
  const t = `translate(${p.x} ${p.y}) rotate(${-p.angle})`
  const w = p.w, h = p.h
  let body
  if (p.shape === 'circle') body = <circle r={w / 2} fill={fill} />
  else if (p.shape === 'oval') body = <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={Math.min(w, h) / 2} fill={fill} />
  else if (p.shape === 'roundrect') body = <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={Math.min(w, h) * 0.25} fill={fill} />
  else body = <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={fill} />
  const label = p.net && Math.min(w, h) >= PAD_LABEL_MIN ? p.net : null
  return (
    <g transform={t}>
      {body}
      {p.drill ? <circle r={p.drill / 2} fill={HOLE} stroke={EDGE} strokeWidth={0.05} /> : null}
      {label && !p.drill
        ? <text x={0} y={0} fontSize={Math.min(0.55, Math.min(w, h) * 0.45)} fill="#ffffff" textAnchor="middle"
            dominantBaseline="central" fontFamily="var(--sf-font-mono)" style={{ pointerEvents: 'none' }}
            transform={`rotate(${p.angle})`}>{label}</text>
        : null}
    </g>
  )
}

function Track({ t, frac = 1 }: { t: BoardTrack; frac?: number }) {
  const x2 = t.x1 + (t.x2 - t.x1) * frac, y2 = t.y1 + (t.y2 - t.y1) * frac
  return <line data-track={t.layer} x1={t.x1} y1={t.y1} x2={x2} y2={y2} stroke={LAYER_COLOR[t.layer]}
    strokeWidth={t.width} strokeLinecap="round" opacity={t.layer === 'B.Cu' ? 0.85 : 0.95} />
}

function Via({ v }: { v: BoardVia }) {
  return (
    <g data-via="1">
      <circle cx={v.x} cy={v.y} r={VIA_SIZE / 2} fill={VIA_RING} />
      <circle cx={v.x} cy={v.y} r={VIA_DRILL / 2} fill={HOLE} />
    </g>
  )
}

export default function BoardView({ parts, frames, routes, target, final, drc, ai = [], pcbFilename, hpwlShelf, status }: Props) {
  const [playhead, setPlayhead] = useState(0)          // fractional frame index
  const [routeHead, setRouteHead] = useState(0)        // fractional routing-event index
  const [fit, setFit] = useState(0)                    // 0 = scatter view, 1 = fitted to the board
  const [hoverNet, setHoverNet] = useState<string | null>(null)
  const [show, setShow] = useState<Record<string, boolean>>({ 'F.Cu': true, 'B.Cu': true })
  const [zoom, setZoom] = useState(1)
  const [panXY, setPanXY] = useState<[number, number]>([0, 0])
  const [focusId, setFocusId] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  // like a PCB editor with its 3D viewer open: plan on the left, board on the right
  const [view3d, setView3d] = useState<'2d' | '3d' | 'both'>('both')
  const [cam, setCam] = useState({ yaw: -18, tilt: 52 })
  const [real3d, setReal3d] = useState(true)         // KiCad GLB once the finished board exists
  const [zoom3d, setZoom3d] = useState(1)
  const drag3d = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const live = useRef({ frames: frames.length, routes: routes.length, fitted: false })
  live.current.frames = frames.length
  live.current.routes = routes.length

  // one clock: placement frames first; once the camera has fitted the board, routing events
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      setPlayhead(ph => Math.min(ph + dt / FRAME_MS, Math.max(live.current.frames - 1, 0)))
      if (live.current.fitted) setRouteHead(rh => Math.min(rh + dt / ROUTE_MS, live.current.routes))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const atEnd = frames.length > 0 && playhead >= frames.length - 1
  const placed = status === 'done' && atEnd && !!final

  // camera: after the last frame plays, glide to the finished board, then start routing
  useEffect(() => {
    if (!placed) { setFit(0); live.current.fitted = false; return }
    const start = performance.now()
    let raf = 0
    const step = (now: number) => {
      const t = Math.min((now - start) / FIT_MS, 1)
      setFit(1 - (1 - t) * (1 - t))
      if (t < 1) raf = requestAnimationFrame(step)
      else live.current.fitted = true
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [placed])

  const byRef = useMemo(() => Object.fromEntries(parts.map(p => [p.ref, p])), [parts])

  // interpolated pose of every part at the playhead
  const poses = useMemo(() => {
    const out: Record<string, [number, number, number]> = {}
    if (!frames.length) return out
    const i = Math.floor(playhead)
    const f = playhead - i
    const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)]
    for (const ref of Object.keys(a.parts)) {
      const pa = a.parts[ref], pb = b.parts[ref] || pa
      out[ref] = [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, f < 0.5 ? pa[2] : pb[2]]
    }
    return out
  }, [frames, playhead])

  // copper after applying routing events up to the route head (the current one drawn partly)
  const copper = useMemo(() => {
    const done = Math.floor(routeHead)
    const frac = routeHead - done
    const tracks: { t: BoardTrack; net: string }[] = []
    let vias: BoardVia[] = []
    const routedCount: Record<string, number> = {}
    for (let k = 0; k < Math.min(done, routes.length); k++) {
      const ev = routes[k]
      if (ev.type === 'rip') {
        for (let i = tracks.length - 1; i >= 0; i--) if (tracks[i].net === ev.net) tracks.splice(i, 1)
        vias = vias.filter(v => v.net !== ev.net)
        routedCount[ev.net] = 0
      } else {
        ev.segments.forEach(t => tracks.push({ t, net: ev.net }))
        vias.push(...ev.vias)
        routedCount[ev.net] = (routedCount[ev.net] || 0) + 1
      }
    }
    // the connection being drawn right now: segments grow along their total length
    const partial: { t: BoardTrack; frac: number }[] = []
    const cur = routes[done]
    if (cur && cur.type === 'route' && frac > 0) {
      const total = cur.segments.reduce((s, t) => s + segLen(t), 0) || 1
      let left = frac * total
      for (const t of cur.segments) {
        const L = segLen(t)
        if (left <= 0) break
        partial.push({ t, frac: Math.min(1, left / (L || 1)) })
        left -= L
      }
    }
    return { tracks, vias, partial, routedCount }
  }, [routes, routeHead])

  // views: everything the scatter touches vs the finished board
  const first = frames[0]
  const scatterView = useMemo((): Box | null => {
    if (!first) return null
    const boxes = Object.entries(first.parts)
      .filter(([ref]) => byRef[ref])
      .map(([ref, [x, y, r]]) => partBox(byRef[ref], x, y, r))
    if (target) boxes.push(target)
    return pad(union(boxes), 3)
  }, [first, target, byRef])

  // extra room under the board so the overlay (bottom-left) never covers parts
  const boardView: Box | null = final
    ? [final.outline[0] - 3, final.outline[1] - 3, final.outline[2] + 3,
       final.outline[3] + 3 + (final.outline[3] - final.outline[1]) * 0.35]
    : null
  const base = scatterView && boardView
    ? scatterView.map((v, k) => v + (boardView[k] - v) * fit) as Box
    : scatterView || boardView || [0, 0, 50, 50]
  const cx = (base[0] + base[2]) / 2 + panXY[0], cy = (base[1] + base[3]) / 2 + panXY[1]
  const vw = (base[2] - base[0]) / zoom, vh = (base[3] - base[1]) / zoom
  const viewBox = `${cx - vw / 2} ${cy - vh / 2} ${vw} ${vh}`

  // absolute pads -> ratsnest for nets that are not routed yet
  const padCount = useMemo(() => {
    const c: Record<string, number> = {}
    parts.forEach(p => p.pads.forEach(pd => { if (pd.net) c[pd.net] = (c[pd.net] || 0) + 1 }))
    return c
  }, [parts])
  const connections = Object.values(padCount).reduce((s, n) => s + Math.max(n - 1, 0), 0)
  // routed connections right now (a rip-up sets its net back to 0)
  const routedNow = Object.entries(copper.routedCount)
    .reduce((s, [net, k]) => s + Math.min(k, Math.max((padCount[net] || 0) - 1, 0)), 0)
  const nets = useMemo(() => {
    const pts: Record<string, [number, number][]> = {}
    for (const [ref, [x, y, r]] of Object.entries(poses)) {
      const p = byRef[ref]
      if (!p) continue
      for (const pd of p.pads) {
        if (!pd.net) continue
        if ((copper.routedCount[pd.net] || 0) >= (padCount[pd.net] || 0) - 1) continue   // fully routed
        const [dx, dy] = rotate(pd.x, pd.y, r)
        ;(pts[pd.net] ||= []).push([x + dx, y + dy])
      }
    }
    return Object.entries(pts).map(([net, list]) => ({ net, list, edges: mst(list) }))
  }, [poses, byRef, copper.routedCount, padCount])

  // checks: KiCad DRC (from the server) + netlist checks (from the generator), in one list
  const findings = useMemo((): Finding[] => {
    const out: Finding[] = []
    ;(drc?.violations || []).forEach((v, i) => {
      const pos = v.items.find(it => it.pos)?.pos
      out.push({ id: `drc${i}`, source: 'DRC', severity: v.severity === 'error' ? 'error' : 'warning',
        text: v.description, pos })
    })
    const pos = (ref: string, pin: string) => {
      const p = final?.parts.find(q => q.ref === ref)
      const pd = p?.pads.find(q => q.num === pin)
      if (!p || !pd) return undefined
      const [dx, dy] = rotate(pd.x, pd.y, p.rot)
      return { x: p.x + dx, y: p.y + dy }
    }
    ;(final?.erc || []).forEach((f, i) => {
      out.push({ id: `erc${i}`, source: '회로', severity: f.severity, text: f.message,
        pos: f.refs[0] ? pos(f.refs[0].ref, f.refs[0].pin) : undefined })
    })
    ;(final?.unrouted || []).forEach((u, i) => {
      out.push({ id: `unr${i}`, source: '회로', severity: 'error',
        text: `넷 '${u.net}'의 ${u.from} – ${u.to} 연결을 배선하지 못했습니다` })
    })
    return out
  }, [drc, final])

  const errorCount = findings.filter(f => f.severity === 'error').length
  const warnCount = findings.length - errorCount

  function focusOn(f: Finding) {
    setFocusId(f.id)
    if (!f.pos) return
    // show roughly 14 mm around the spot, whatever the board size
    setZoom(Math.min(6, Math.max(1, (base[2] - base[0]) / 14)))
    setPanXY([f.pos.x - (base[0] + base[2]) / 2 + panXY[0], f.pos.y - (base[1] + base[3]) / 2 + panXY[1]])
  }

  const cur = frames.length ? frames[Math.min(Math.round(playhead), frames.length - 1)] : null
  const hpwlFinal = final && frames.length ? frames[frames.length - 1].hpwl : null
  const saving = hpwlFinal != null && hpwlShelf ? Math.round((1 - hpwlFinal / hpwlShelf) * 100) : null
  const routing = placed && fit >= 1 && routes.length > 0
  const routedAll = placed && routes.length > 0 && routeHead >= routes.length
  const trackLen = copper.tracks.reduce((s, x) => s + segLen(x.t), 0)
  const unrouted = final?.unrouted || []

  // sparkline of HPWL up to the playhead
  const spark = useMemo(() => {
    if (frames.length < 2) return ''
    const shown = frames.slice(0, Math.floor(playhead) + 1)
    const max = Math.max(...frames.map(f => f.hpwl)), min = Math.min(...frames.map(f => f.hpwl))
    const W = 120, H = 28
    return shown.map((f, k) => {
      const x = (k / (frames.length - 1)) * W
      const y = H - ((f.hpwl - min) / Math.max(max - min, 1e-6)) * H
      return `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }, [frames, playhead])

  function onWheel(e: React.WheelEvent) {
    setZoom(z => Math.min(8, Math.max(0.4, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))))
  }
  function onDown(e: React.PointerEvent) {
    dragRef.current = { x: e.clientX, y: e.clientY }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  function onMove(e: React.PointerEvent) {
    const d = dragRef.current, svg = svgRef.current
    if (!d || !svg) return
    const scale = vw / svg.clientWidth
    setPanXY(([px, py]) => [px - (e.clientX - d.x) * scale, py - (e.clientY - d.y) * scale])
    dragRef.current = { x: e.clientX, y: e.clientY }
  }
  function replay() { setPlayhead(0); setRouteHead(0); setZoom(1); setPanXY([0, 0]) }

  // ── 3D view: same poses, same copper, tilted ───────────────────────────────
  const cam3d: Camera = useMemo(() => {
    const b = final?.outline || target || [0, 0, 20, 20]
    return { yaw: cam.yaw, tilt: cam.tilt, cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2 }
  }, [final, target, cam])

  // tracks drawn in 3D include the connection being drawn right now, cut at the same fraction
  const tracks3d = useMemo(() => {
    const out = copper.tracks.map(x => x.t)
    for (const { t, frac } of copper.partial) {
      out.push({ ...t, x2: t.x1 + (t.x2 - t.x1) * frac, y2: t.y1 + (t.y2 - t.y1) * frac })
    }
    return out
  }, [copper])

  function on3dDown(e: React.PointerEvent) {
    drag3d.current = { x: e.clientX, y: e.clientY }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  function on3dMove(e: React.PointerEvent) {
    const d = drag3d.current
    if (!d) return
    setCam(c => ({
      yaw: c.yaw + (e.clientX - d.x) * 0.4,
      tilt: Math.max(0, Math.min(85, c.tilt - (e.clientY - d.y) * 0.3)),
    }))
    drag3d.current = { x: e.clientX, y: e.clientY }
  }

  const outline = final?.outline
  const label = status === 'error' ? '오류'
    : routedAll ? (unrouted.length ? '배선 끝 (미배선 있음)' : '배선 완료')
    : routing ? '배선 중'
    : placed ? '배치 완료'
    : (cur ? PHASE_LABEL[cur.phase] : '준비 중')

  const drawTracks = (layer: string) => show[layer] && (
    <g>
      {copper.tracks.filter(x => x.t.layer === layer).map((x, k) => <Track key={k} t={x.t} />)}
      {copper.partial.filter(x => x.t.layer === layer).map((x, k) => <Track key={`p${k}`} t={x.t} frac={x.frac} />)}
    </g>
  )

  return (
    <div style={{ position: 'absolute', inset: 0, background: SHEET, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
      <div style={{ flex: 1, minWidth: 0, display: view3d === '3d' ? 'none' : 'block' }}>
      <svg ref={svgRef} data-testid="board-view" viewBox={viewBox} width="100%" height="100%"
        style={{ display: 'block', cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={() => { dragRef.current = null }}>
        {/* board: target frame while placing, real outline when done */}
        {outline && fit > 0
          ? <rect x={outline[0]} y={outline[1]} width={outline[2] - outline[0]} height={outline[3] - outline[1]}
              fill={PCB_FILL} stroke={EDGE} strokeWidth={0.12} opacity={fit} />
          : null}
        {target && fit < 1
          ? <rect x={target[0]} y={target[1]} width={target[2] - target[0]} height={target[3] - target[1]}
              fill={PCB_FILL} fillOpacity={0.75 * (1 - fit)} stroke={EDGE} strokeOpacity={0.5 * (1 - fit)}
              strokeWidth={0.12} strokeDasharray="0.8 0.6" />
          : null}

        {/* ground fill: preview of the zone the board file carries */}
        {placed && (final?.pour || []).filter(r => show[r.layer] !== false).map((r, k) => (
          <rect key={`pour${k}`} data-pour={r.layer} x={r.x1} y={r.y1} width={r.x2 - r.x1} height={r.y2 - r.y1}
            fill={POUR_FILL[r.layer] || POUR_FILL['B.Cu']} />
        ))}

        {/* bottom copper under the parts */}
        {drawTracks('B.Cu')}

        {/* parts */}
        {Object.entries(poses).map(([ref, [x, y, r]]) => {
          const p = byRef[ref]
          if (!p) return null
          const [x1, y1, x2, y2] = p.bbox
          const box = partBox(p, x, y, r)
          const size = Math.max(0.6, Math.min(1.2, (box[3] - box[1]) * 0.35, (box[2] - box[0]) * 0.3))
          return (
            <g key={ref} data-ref={ref} data-x={x.toFixed(3)} data-y={y.toFixed(3)} data-rot={r}>
              <g transform={`translate(${x} ${y}) rotate(${-r})`}>
                <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke={COURTYARD} strokeWidth={0.04} />
                {p.silk?.length ? <SilkShape items={p.silk} /> : null}
                {p.pads.map((pd, k) => <PadShape key={k} p={pd} hi={!!hoverNet && pd.net === hoverNet} />)}
                {p.ref_text
                  ? <text x={p.ref_text.x} y={p.ref_text.y} fontSize={Math.max(0.5, p.ref_text.h)} fill={SILK}
                      textAnchor="middle" dominantBaseline="central" fontFamily="var(--sf-font-mono)"
                      transform={`rotate(${-(p.ref_text.angle || 0)} ${p.ref_text.x} ${p.ref_text.y})`}
                      style={{ pointerEvents: 'none' }}>{ref}</text>
                  : null}
              </g>
              {p.ref_text ? null : (
                <text x={(box[0] + box[2]) / 2} y={(box[1] + box[3]) / 2} fontSize={size} fill={SILK}
                  textAnchor="middle" dominantBaseline="central" fontFamily="var(--sf-font-mono)"
                  style={{ pointerEvents: 'none' }}>{ref}</text>
              )}
            </g>
          )
        })}

        {/* top copper and vias over the pads */}
        {drawTracks('F.Cu')}
        {copper.vias.map((v, k) => <Via key={k} v={v} />)}

        {/* check markers */}
        {findings.filter(f => f.pos).map(f => {
          const on = focusId === f.id
          const c = f.severity === 'error' ? UI_BAD : UI_WARN
          const r = on ? 1.6 : 1.1
          return (
            <g key={f.id} data-marker={f.severity} onClick={() => focusOn(f)} style={{ cursor: 'pointer' }}>
              <circle cx={f.pos!.x} cy={f.pos!.y} r={r} fill="none" stroke={c} strokeWidth={0.18}>
                {on && <animate attributeName="r" values={`${r};${r * 1.8};${r}`} dur="1s" repeatCount="indefinite" />}
              </circle>
              {f.severity === 'error' && (
                <g stroke={c} strokeWidth={0.18}>
                  <line x1={f.pos!.x - r * 0.6} y1={f.pos!.y - r * 0.6} x2={f.pos!.x + r * 0.6} y2={f.pos!.y + r * 0.6} />
                  <line x1={f.pos!.x - r * 0.6} y1={f.pos!.y + r * 0.6} x2={f.pos!.x + r * 0.6} y2={f.pos!.y - r * 0.6} />
                </g>
              )}
              <title>{f.text}</title>
            </g>
          )
        })}

        {/* ratsnest of what is still to route */}
        {nets.map(({ net, list, edges }) => edges.map(([a, b], k) => (
          <line key={`${net}-${k}`} x1={list[a][0]} y1={list[a][1]} x2={list[b][0]} y2={list[b][1]}
            stroke={RATSNEST} strokeWidth={hoverNet === net ? 0.22 : 0.1}
            opacity={hoverNet && hoverNet !== net ? 0.25 : 0.8}
            onPointerEnter={() => setHoverNet(net)} onPointerLeave={() => setHoverNet(null)}>
            <title>{net}</title>
          </line>
        )))}
      </svg>
      </div>

      {/* 3D: the same poses and the same copper, tilted (stage 5) */}
      {view3d !== '2d' && (
        <div style={{ flex: 1, minWidth: 0, position: 'relative', cursor: real3d && placed ? 'grab' : (drag3d.current ? 'grabbing' : 'grab'),
          borderLeft: view3d === 'both' ? `1px solid ${UI_LINE}` : 'none', touchAction: 'none' }}
          onPointerDown={real3d && placed ? undefined : on3dDown}
          onPointerMove={real3d && placed ? undefined : on3dMove}
          onPointerUp={() => { drag3d.current = null }}
          onWheel={real3d && placed ? undefined : e => setZoom3d(z => Math.min(8, Math.max(0.4, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))))}>
          {real3d && placed && pcbFilename
            ? <KiCad3DViewer pcbFilename={pcbFilename} />
            : <Board3D parts={parts} poses={poses} tracks={tracks3d} vias={copper.vias}
                outline={fit > 0 ? (final?.outline ?? null) : target} cam={cam3d} zoom={zoom3d}
                showLayer={show} hoverNet={hoverNet} />}
          {pcbFilename && placed && (
            <button data-testid="board-real3d-toggle"
              onClick={() => setReal3d(v => !v)}
              style={{ position: 'absolute', left: 8, top: 8, padding: '4px 10px', borderRadius: 6,
                border: `1px solid ${UI_LINE}`, background: real3d ? UI_FG : UI_BG, color: real3d ? '#fff' : UI_FG,
                fontFamily: 'var(--sf-font-mono)', fontSize: 11, cursor: 'pointer' }}>
              {real3d ? '도형 보기' : '실제 3D'}
            </button>
          )}
          <div style={{ position: 'absolute', right: 8, bottom: 8, padding: '4px 8px', borderRadius: 6,
            background: UI_BG, color: UI_DIM, border: `1px solid ${UI_LINE}`,
            fontFamily: 'var(--sf-font-mono)', fontSize: 10 }}>
            {real3d && placed ? '실제 KiCad 3D · 드래그 회전 · 휠 확대' : '배치 애니메이션 · 부품 높이는 표시용 근사값'}
          </div>
        </div>
      )}
      </div>

      {/* overlay */}
      <div style={{ position: 'absolute', left: 12, bottom: 12, padding: '8px 10px', borderRadius: 8,
        background: UI_BG, color: UI_FG, border: `1px solid ${UI_LINE}`, fontFamily: 'var(--sf-font-mono)',
        fontSize: 11, lineHeight: 1.5, minWidth: 190, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <div data-testid="board-phase" style={{ fontWeight: 700, color: routedAll && !unrouted.length ? UI_OK : UI_FG }}>{label}</div>
        {!placed && cur && <div style={{ opacity: 0.75 }}>반복 {cur.iter} · 선 길이 추정 {cur.hpwl.toFixed(1)} mm</div>}
        {!placed && spark && <svg width={120} height={28} style={{ display: 'block', marginTop: 4 }}>
          <path d={spark} fill="none" stroke={RATSNEST} strokeWidth={1.2} />
        </svg>}
        {placed && saving != null && (
          <div data-testid="board-saving" style={{ color: UI_OK }}>
            배치: 격자 대비 −{saving}% ({hpwlShelf?.toFixed(0)} → {hpwlFinal?.toFixed(0)} mm)
          </div>
        )}
        {placed && routes.length > 0 && (
          <div data-testid="board-routing">
            배선 {routedNow}/{connections} · 비아 {copper.vias.length} · 트랙 {trackLen.toFixed(0)} mm
          </div>
        )}
        {routedAll && unrouted.length > 0 && (
          <div style={{ color: UI_BAD }}>미배선: {unrouted.map(u => `${u.net} (${u.from}–${u.to})`).join(', ')}</div>
        )}
        {placed && outline && (
          <div style={{ opacity: 0.75 }}>기판 {(outline[2] - outline[0]).toFixed(1)} × {(outline[3] - outline[1]).toFixed(1)} mm</div>
        )}
        {hoverNet && <div style={{ color: '#2c5f96' }}>넷: {hoverNet}</div>}
      </div>
      {frames.length > 0 && (
        <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', gap: 6 }}>
          {(['2d', 'both', '3d'] as const).map(v => (
            <button key={v} onClick={() => setView3d(v)} data-testid={`view-${v}`}
              title={v === '2d' ? '평면' : v === 'both' ? '평면 + 3D' : '3D'}
              style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${UI_LINE}`,
                background: view3d === v ? UI_FG : UI_BG,
                color: view3d === v ? '#ffffff' : UI_FG, fontWeight: view3d === v ? 700 : 400,
                fontFamily: 'var(--sf-font-mono)', fontSize: 11, cursor: 'pointer' }}>
              {v === '2d' ? '2D' : v === 'both' ? '나란히' : '3D'}
            </button>
          ))}
          {placed && (['F.Cu', 'B.Cu'] as const).map(L => (
            <button key={L} onClick={() => setShow(s => ({ ...s, [L]: !s[L] }))}
              title={L === 'F.Cu' ? '윗면 구리' : '아랫면 구리'}
              style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${LAYER_COLOR[L]}`,
                background: show[L] ? LAYER_COLOR[L] : UI_BG, color: show[L] ? '#fff' : LAYER_COLOR[L],
                fontFamily: 'var(--sf-font-mono)', fontSize: 11, cursor: 'pointer' }}>
              {L === 'F.Cu' ? 'F' : 'B'}
            </button>
          ))}
          {placed && <button onClick={replay} data-testid="board-replay"
            style={{ padding: '4px 10px', borderRadius: 6,
              border: `1px solid ${UI_LINE}`, background: UI_BG,
              color: UI_FG, fontFamily: 'var(--sf-font-mono)', fontSize: 11, cursor: 'pointer' }}>
            ↺ 다시 보기
          </button>}
        </div>
      )}

      {/* AI improvement rounds */}
      {placed && ai.length > 0 && (
        <div data-testid="board-ai" style={{ position: 'absolute', left: 12, top: 12, width: 320, maxWidth: '48%',
          borderRadius: 8, background: UI_BG, color: UI_FG, border: `1px solid ${UI_LINE}`, boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          fontFamily: 'var(--sf-font-mono)', fontSize: 11, overflow: 'hidden' }}>
          <div style={{ padding: '7px 10px', fontWeight: 700, color: UI_ACCENT }}>
            AI 다듬기 · 채택 {ai.filter(r => r.kept).length}/{ai.filter(r => !r.actions.stop).length}
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {ai.map((r, i) => {
              const d = r.after ? r.after.hpwl - r.before.hpwl : 0
              return (
                <div key={`${r.round}-${r.part ?? i}`} style={{ padding: '6px 10px', borderTop: `1px solid ${UI_LINE}`,
                  color: r.kept ? UI_OK : UI_DIM }}>
                  <div>{r.round > 0 ? `${r.round}라운드` : ''}{r.part ? ` ${r.part === 'width' ? '선 폭' : '배치'}` : ''} {r.kept ? '채택' : r.actions.stop ? '중단' : '되돌림'} — {r.reason}</div>
                  {r.after && (
                    <div style={{ opacity: 0.75 }}>
                      선 길이 {r.before.hpwl.toFixed(1)} → {r.after.hpwl.toFixed(1)} mm ({d > 0 ? '+' : ''}{d.toFixed(1)}) ·
                      비아 {r.before.vias}→{r.after.vias} · 미배선 {r.after.unrouted} · DRC 오류 {r.after.drcErrors}
                      {r.before.decap != null && r.after.decap != null && r.before.decap > 0 &&
                        <> · 디커플링 {r.before.decap.toFixed(1)}→{r.after.decap.toFixed(1)} mm</>}
                      {r.before.powerWidth != null && r.after.powerWidth != null && (r.before.powerWidth > 0 || r.after.powerWidth > 0) &&
                        <> · 좁은 전원선 {r.before.powerWidth}→{r.after.powerWidth}</>}
                    </div>
                  )}
                  {r.note && <div style={{ opacity: 0.6 }}>{r.note}</div>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* checks: KiCad DRC + netlist checks */}
      {placed && (drc || final?.erc) && (
        <div data-testid="board-checks" style={{ position: 'absolute', right: 12, top: 48, width: 300, maxWidth: '48%',
          borderRadius: 8, background: UI_BG, color: UI_FG, border: `1px solid ${UI_LINE}`, boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          fontFamily: 'var(--sf-font-mono)', fontSize: 11, overflow: 'hidden' }}>
          <button onClick={() => setPanelOpen(o => !o)}
            style={{ width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', cursor: 'pointer',
              background: 'transparent', color: findings.length ? (errorCount ? UI_BAD : UI_WARN) : UI_OK,
              fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
            {drc && !drc.available
              ? '검사 도구 없음 (KiCad 미설치)'
              : findings.length === 0
                ? '검사 통과 · 위반 0'
                : `오류 ${errorCount} · 경고 ${warnCount}`}
            <span style={{ float: 'right', opacity: 0.7 }}>{panelOpen ? '▾' : '▸'}</span>
          </button>
          {panelOpen && (
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {drc && !drc.available && (
                <div style={{ padding: '6px 10px', opacity: 0.8 }}>{drc.reason} — 기판 파일은 정상 생성됐어요.</div>
              )}
              {drc?.available && (
                <div style={{ padding: '4px 10px', opacity: 0.7 }}>
                  KiCad 검사: 위반 {(drc.violations || []).length} · 미연결 {drc.unconnected}
                </div>
              )}
              {findings.map(f => (
                <button key={f.id} onClick={() => focusOn(f)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', cursor: 'pointer',
                    border: 'none', borderTop: `1px solid ${UI_LINE}`, fontFamily: 'inherit', fontSize: 11,
                    background: focusId === f.id ? 'rgba(255,255,255,0.10)' : 'transparent',
                    color: f.severity === 'error' ? UI_BAD : UI_WARN }}>
                  <span style={{ opacity: 0.6 }}>[{f.source}]</span> {f.text}
                  {f.pos && <span style={{ opacity: 0.5 }}> · {f.pos.x.toFixed(1)}, {f.pos.y.toFixed(1)}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
