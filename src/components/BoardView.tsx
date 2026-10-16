import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  BoardFrame, BoardModel, BoardPart, BoardPad, BoardTrack, BoardVia, RouteEvent, DrcResult, AiRound, SilkItem,
} from '../types'
import Board3D from './Board3D'
import KiCad3DViewer from './KiCad3DViewer'
import { Stamp, StatusChip } from './StatusUi'
import type { Camera } from '../lib/board3d'
import { HUMAN_ROW, STATE_TONE, TONE_COLOR, checkRows, drcCounts, overall, stateWord, summarize, type Tone } from '../lib/boardChecks'
import { fromBoard, operatingChecks } from '../lib/operatingCheck'
import { KIND_LABEL, loadReviewed, reviewItems, saveReviewed, type ReviewItem } from '../lib/humanReview'
import { assemblyRefs, loadPlaced, placedKey, savePlaced } from '../lib/assembly'
import { buildBom, type BomLine } from '../lib/bom'

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

// Panels sit on the light sheet, so they are light too. Status colours (ok / warn / bad)
// come from TONE_COLOR, shared with the result toolbar.
const UI_BG = 'rgba(255, 255, 255, 0.92)'
const UI_LINE = 'rgba(0, 0, 0, 0.14)'
const UI_FG = '#23262b'
const UI_DIM = '#6b7079'
const MONO = 'var(--sf-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const SANS = 'var(--sf-font-sans, system-ui, -apple-system, "Segoe UI", sans-serif)'

/** One "name value" pair in the status bar; tabular figures so numbers do not jump. */
function Metric({ k, v, tone, testId, title }: { k: string; v: ReactNode; tone?: Tone; testId?: string; title?: string }) {
  return (
    <span data-testid={testId} title={title} style={{ whiteSpace: 'nowrap', cursor: title ? 'help' : undefined }}>
      <span style={{ color: UI_DIM }}>{k} </span>
      <span style={{ color: tone ? TONE_COLOR[tone] : UI_FG, fontWeight: 600 }}>{v}</span>
    </span>
  )
}

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
  /** 'assembly': the finished board only, a part list beside it, a click on a part ticks it as placed */
  mode?: 'build' | 'assembly'
}

/** width of the assembly list beside the board (it sits next to the drawing, never over it) */
const ASSEMBLY_W = 300

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

export default function BoardView({ parts, frames, routes, target, final, drc, ai = [], pcbFilename, hpwlShelf, status, mode = 'build' }: Props) {
  const assembly = mode === 'assembly'
  // a board that was already finished when this view opened (a tab switch, the assembly view) shows finished;
  // the playback runs while it is being made, and again on ↺ 다시 보기
  const [startDone] = useState(() => assembly || (status === 'done' && !!final && frames.length > 0))
  const skipFit = useRef(startDone)
  const [playhead, setPlayhead] = useState(() => (startDone ? Math.max(frames.length - 1, 0) : 0))   // fractional frame index
  const [routeHead, setRouteHead] = useState(() => (startDone ? routes.length : 0))               // fractional routing-event index
  const [fit, setFit] = useState(() => (startDone ? 1 : 0))                                       // 0 = scatter view, 1 = fitted to the board
  const [aiOpenSet, setAiOpen] = useState<boolean | null>(null)   // the AI rounds stay folded to one line over the board
  const [hoverNet, setHoverNet] = useState<string | null>(null)
  const [show, setShow] = useState<Record<string, boolean>>({ 'F.Cu': true, 'B.Cu': true })
  const [zoom, setZoom] = useState(1)
  const [panXY, setPanXY] = useState<[number, number]>([0, 0])
  const [focusId, setFocusId] = useState<string | null>(null)
  const [pickRef, setPickRef] = useState<string | null>(null)                  // part selected for review
  const [reviewed, setReviewed] = useState<Record<string, number>>(() => loadReviewed())
  // null = not chosen by the user yet: the list opens by itself only when something needs a look
  const [panelOpen, setPanelOpen] = useState<boolean | null>(null)
  // like a PCB editor with its 3D viewer open: plan on the left, board on the right
  const [view3d, setView3d] = useState<'2d' | '3d' | 'both'>('both')
  const [cam, setCam] = useState({ yaw: -18, tilt: 52 })
  const [real3d, setReal3d] = useState(true)         // KiCad GLB once the finished board exists
  const [zoom3d, setZoom3d] = useState(1)
  const drag3d = useRef<{ x: number; y: number } | null>(null)
  // a press on the board: where it started, whether it became a drag, and the part under it (assembly)
  const dragRef = useRef<{ x: number; y: number; sx: number; sy: number; moved: boolean; hit: string | null; slop: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const live = useRef({ frames: frames.length, routes: routes.length, fitted: startDone })
  live.current.frames = frames.length
  live.current.routes = routes.length

  // one clock: placement frames first; once the camera has fitted the board, routing events
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      // a frame's timestamp can be a little before the time the effect started: never run the clock backwards
      const dt = Math.max(0, now - last)
      last = Math.max(last, now)
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
    if (!placed) { setFit(0); live.current.fitted = false; skipFit.current = assembly; return }
    // opened on a finished board: already fitted, no camera glide (after ↺ 다시 보기 the glide plays)
    if (skipFit.current) { setFit(1); live.current.fitted = true; return }
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
  }, [placed, assembly])

  // the assembly view draws board.json itself: the AI loop may have moved parts after the playback frames
  const shownParts: BoardPart[] = assembly && final ? final.parts : parts
  const byRef = useMemo(() => Object.fromEntries(shownParts.map(p => [p.ref, p])), [shownParts])

  // interpolated pose of every part at the playhead
  const poses = useMemo(() => {
    const out: Record<string, [number, number, number]> = {}
    if (assembly && final) {
      for (const p of final.parts) out[p.ref] = [p.x, p.y, p.rot]
      return out
    }
    if (!frames.length) return out
    const i = Math.min(Math.max(Math.floor(playhead), 0), frames.length - 1)
    const f = Math.min(Math.max(playhead - i, 0), 1)
    const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)]
    for (const ref of Object.keys(a.parts)) {
      const pa = a.parts[ref], pb = b.parts[ref] || pa
      out[ref] = [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, f < 0.5 ? pa[2] : pb[2]]
    }
    return out
  }, [frames, playhead, assembly, final])

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
    // the assembly view shows the finished board's own copper (tracks after any AI change)
    if (assembly && final) {
      return { tracks: (final.tracks ?? []).map(t => ({ t, net: t.net })), vias: final.vias ?? [], partial: [], routedCount }
    }
    return { tracks, vias, partial, routedCount }
  }, [routes, routeHead, assembly, final])

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

  // the numbers live in the status bar under the drawing now, so the board gets an even margin
  const boardView: Box | null = final
    ? [final.outline[0] - 3, final.outline[1] - 3, final.outline[2] + 3, final.outline[3] + 3]
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

  // every rule with its result (passed ones too), grouped over the same findings
  // what a person confirms against the real parts (kept in this browser)
  const reviewList = useMemo(() => (final ? reviewItems(final) : []), [final])
  const reviewedKeys = useMemo(() => new Set(reviewList.filter(it => reviewed[it.key]).map(it => it.key)), [reviewList, reviewed])
  const reviewedRefs = useMemo(() => reviewList.filter(it => reviewedKeys.has(it.key)).map(it => it.ref), [reviewList, reviewedKeys])
  // assembly: the parts to place (not test pads or holes), grouped like the BOM, and which are placed already
  const asmRefs = useMemo(() => assemblyRefs(final), [final])
  const asmSet = useMemo(() => new Set(asmRefs), [asmRefs])
  const asmLines = useMemo(() => (final
    ? buildBom(final.parts.map(p => ({ ref: p.ref, value: p.value, name: p.part })), { parts: final.parts, unmapped: final.unmapped },
        final.style === 'tht' ? 'tht' : 'smd').lines
    : []), [final])
  const boardKey = useMemo(() => placedKey(pcbFilename, final), [pcbFilename, final])
  const [placedRefs, setPlacedRefs] = useState<Set<string>>(() => loadPlaced(placedKey(pcbFilename, final), assemblyRefs(final)))
  useEffect(() => { setPlacedRefs(loadPlaced(boardKey, asmRefs)) }, [boardKey, asmRefs])
  const aiSkipped = ai.some(r => r.round === 0 && !r.kept)
  const aiOpen = aiOpenSet ?? aiSkipped
  // does it work: numeric checks on the finished board's part values
  const opResults = useMemo(() => (final ? operatingChecks(fromBoard(final)) : []), [final])
  const rows = useMemo(() => checkRows(drc, final, { items: reviewList, reviewed: reviewedKeys }, opResults),
    [drc, final, reviewList, reviewedKeys, opResults])
  const checkSum = summarize(rows)
  const checkHead = overall(checkSum)
  const findingById = useMemo(() => Object.fromEntries(findings.map(f => [f.id, f])), [findings])
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({})
  const drcNow = drcCounts(drc)
  // an all-pass list stays folded to its header so it does not cover the 3D view
  // (it opens by itself only for errors; reviews and warnings show in the header chip)
  const listOpen = panelOpen ?? (!checkSum.pending && checkHead.tone === 'bad')
  const checksRef = useRef<HTMLDivElement>(null)
  // a part picked in 3D scrolls its review item into view
  useEffect(() => {
    if (!pickRef) return
    checksRef.current?.querySelector(`[data-review="${pickRef}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [pickRef, listOpen, openRows])

  /** Centre the 2D view on a point, showing roughly 14 mm around it whatever the board size. */
  function zoomTo(pos: { x: number; y: number }) {
    setZoom(Math.min(6, Math.max(1, (base[2] - base[0]) / 14)))
    // the view centre is base centre + pan, so the pan is the offset from the base centre
    // (adding the old pan here moved every second jump off target)
    setPanXY([pos.x - (base[0] + base[2]) / 2, pos.y - (base[1] + base[3]) / 2])
  }

  function focusOn(f: Finding) {
    setFocusId(f.id)
    if (f.pos) zoomTo(f.pos)
  }

  /** Select a part for review: ring in 2D, tint in 3D, view centred on it. */
  function selectPart(ref: string) {
    setPickRef(ref)
    const pose = poses[ref], p = byRef[ref]
    if (!pose || !p) return
    const b = partBox(p, pose[0], pose[1], pose[2])
    zoomTo({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 })
  }

  /** A part clicked in 3D: select it and, if it has a review item, open the list at it. */
  function pickFrom3d(ref: string) {
    selectPart(ref)
    if (reviewList.some(it => it.ref === ref)) {
      setPanelOpen(true)
      setOpenRows(o => ({ ...o, [HUMAN_ROW]: true }))
    }
  }

  /** Assembly: tick or untick a part as placed on the real board (kept per board file in this browser). */
  function togglePlaced(ref: string) {
    if (!asmSet.has(ref)) return
    setPickRef(ref)
    setPlacedRefs(prev => {
      const next = new Set(prev)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      savePlaced(boardKey, next)
      return next
    })
  }
  function clearPlaced() {
    if (!placedRefs.size || !window.confirm('배치 체크를 모두 지울까요?')) return
    const next = new Set<string>()
    savePlaced(boardKey, next)
    setPlacedRefs(next)
  }

  function toggleReviewed(it: ReviewItem) {
    // once a person is ticking, the list and this row stay open: the last tick turns the row
    // into "통과", which would otherwise fold it away under the cursor
    setPanelOpen(p => p ?? true)
    setOpenRows(o => (HUMAN_ROW in o ? o : { ...o, [HUMAN_ROW]: true }))
    setReviewed(prev => {
      const next = { ...prev }
      if (next[it.key]) delete next[it.key]
      else next[it.key] = Date.now()
      return saveReviewed(next)
    })
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
    const W = 80, H = 16
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
    if (e.button !== 0) return                       // right and middle clicks neither pan nor tick
    const hit = (e.target as Element).getAttribute?.('data-assembly-hit') ?? null
    // a finger wobbles more than a mouse before it lifts: a tap stays a tap within 10 px
    const slop = e.pointerType === 'mouse' ? 4 : 10
    dragRef.current = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, hit, slop }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  function onMove(e: React.PointerEvent) {
    const d = dragRef.current, svg = svgRef.current
    if (!d || !svg) return
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) <= d.slop) return   // not a drag yet: the board stays put
    d.moved = true
    const scale = vw / svg.clientWidth
    setPanXY(([px, py]) => [px - (e.clientX - d.x) * scale, py - (e.clientY - d.y) * scale])
    d.x = e.clientX
    d.y = e.clientY
  }
  function onUp() {
    const d = dragRef.current
    dragRef.current = null
    if (assembly && d && !d.moved && d.hit) togglePlaced(d.hit)
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
  // settled = nothing left to play back; until then the phase chip pulses
  const settled = status === 'error' || routedAll || (placed && routes.length === 0)
  const phaseTone: Tone = status === 'error' || (routedAll && unrouted.length > 0) ? 'bad' : settled ? 'ok' : 'accent'

  const drawTracks = (layer: string) => show[layer] && (
    <g>
      {copper.tracks.filter(x => x.t.layer === layer).map((x, k) => <Track key={k} t={x.t} />)}
      {copper.partial.filter(x => x.t.layer === layer).map((x, k) => <Track key={`p${k}`} t={x.t} frac={x.frac} />)}
    </g>
  )

  return (
    <div style={{ position: 'absolute', inset: 0, background: SHEET, overflow: 'hidden',
      display: 'flex', flexDirection: 'column' }}>
      {/* drawing area: 2D and 3D panes with the panels floating over them */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
      <div style={{ flex: 1, minWidth: 0, display: view3d === '3d' && !assembly ? 'none' : 'block' }}>
      <svg ref={svgRef} data-testid="board-view" viewBox={viewBox} width="100%" height="100%"
        style={{ display: 'block', cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerCancel={() => { dragRef.current = null }}>
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
              {/* review: ring on the selected part, a check badge on parts a person confirmed */}
              {placed && pickRef === ref && (
                <rect data-human-pick={ref} x={box[0] - 0.6} y={box[1] - 0.6} width={box[2] - box[0] + 1.2}
                  height={box[3] - box[1] + 1.2} rx={0.4} fill="none" stroke={TONE_COLOR.accent} strokeWidth={0.2}
                  strokeDasharray="0.8 0.5" style={{ pointerEvents: 'none' }} />
              )}
              {assembly && placed && placedRefs.has(ref) && (
                <g data-placed={ref} style={{ pointerEvents: 'none' }}>
                  <rect x={box[0] - 0.3} y={box[1] - 0.3} width={box[2] - box[0] + 0.6} height={box[3] - box[1] + 0.6} rx={0.3}
                    fill={TONE_COLOR.ok} fillOpacity={0.16} stroke={TONE_COLOR.ok} strokeWidth={0.15} />
                  <g transform={`translate(${box[2]} ${box[1]})`}>
                    <circle r={0.95} fill={TONE_COLOR.ok} stroke="#ffffff" strokeWidth={0.14} />
                    <path d="M -0.45 0 L -0.1 0.36 L 0.48 -0.32" fill="none" stroke="#ffffff" strokeWidth={0.22}
                      strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                </g>
              )}
              {placed && !assembly && reviewedRefs.includes(ref) && (
                <g data-human-ok={ref} transform={`translate(${box[2]} ${box[1]})`} style={{ pointerEvents: 'none' }}>
                  <circle r={0.75} fill={TONE_COLOR.ok} stroke="#ffffff" strokeWidth={0.12} />
                  <path d="M -0.35 0 L -0.08 0.28 L 0.38 -0.25" fill="none" stroke="#ffffff" strokeWidth={0.18}
                    strokeLinecap="round" strokeLinejoin="round" />
                </g>
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
          const c = TONE_COLOR[f.severity === 'error' ? 'bad' : 'warn']
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

        {/* assembly: one click target per part to place, over everything else */}
        {assembly && placed && asmRefs.map(ref => {
          const p = byRef[ref], pose = poses[ref]
          if (!p || !pose) return null
          const b = partBox(p, pose[0], pose[1], pose[2])
          return (
            <rect key={`hit-${ref}`} data-assembly-hit={ref} x={b[0] - 0.4} y={b[1] - 0.4} width={b[2] - b[0] + 0.8} height={b[3] - b[1] + 0.8}
              fill="transparent" style={{ cursor: 'pointer' }}>
              <title>{`${ref} ${p.value} · ${placedRefs.has(ref) ? '배치함 (다시 누르면 해제)' : '눌러서 배치 체크'}`}</title>
            </rect>
          )
        })}
      </svg>
      </div>

      {assembly && placed && (
        <AssemblyPanel lines={asmLines} total={asmRefs.length} placedRefs={placedRefs} pick={pickRef}
          reviewList={reviewList} reviewedKeys={reviewedKeys} hasFurniture={(final?.parts ?? []).length > asmRefs.length}
          onToggle={togglePlaced} onPick={setPickRef} onClear={clearPlaced} onReview={toggleReviewed} />
      )}

      {/* 3D: the same poses and the same copper, tilted (stage 5) */}
      {view3d !== '2d' && !assembly && (
        <div style={{ flex: 1, minWidth: 0, position: 'relative', cursor: real3d && placed ? 'grab' : (drag3d.current ? 'grabbing' : 'grab'),
          borderLeft: view3d === 'both' ? `1px solid ${UI_LINE}` : 'none', touchAction: 'none' }}
          onPointerDown={real3d && placed ? undefined : on3dDown}
          onPointerMove={real3d && placed ? undefined : on3dMove}
          onPointerUp={() => { drag3d.current = null }}
          onWheel={real3d && placed ? undefined : e => setZoom3d(z => Math.min(8, Math.max(0.4, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))))}>
          {real3d && placed && pcbFilename
            ? <KiCad3DViewer pcbFilename={pcbFilename} selected={pickRef} reviewed={reviewedRefs} onPick={pickFrom3d} />
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
          {/* one line always (cut with … on narrow panes) so the checks panel can stop just above it */}
          <div title={real3d && placed ? '실제 KiCad 3D · 드래그 회전 · 휠 확대 · 부품을 누르면 확인 항목' : '배치 애니메이션 · 부품 높이는 표시용 근사값'}
            style={{ position: 'absolute', right: 8, bottom: 8, maxWidth: 'calc(100% - 16px)', boxSizing: 'border-box',
            padding: '4px 8px', borderRadius: 6, background: UI_BG, color: UI_DIM, border: `1px solid ${UI_LINE}`,
            fontFamily: 'var(--sf-font-mono)', fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {real3d && placed ? '실제 KiCad 3D · 드래그 회전 · 휠 확대 · 부품을 누르면 확인 항목' : '배치 애니메이션 · 부품 높이는 표시용 근사값'}
          </div>
        </div>
      )}
      </div>

      {frames.length > 0 && (
        <div style={{ position: 'absolute', right: assembly ? ASSEMBLY_W + 12 : 12, top: 12, display: 'flex', gap: 6 }}>
          {!assembly && (['2d', 'both', '3d'] as const).map(v => (
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
          {assembly && placed && (
            <button onClick={() => { setZoom(1); setPanXY([0, 0]) }} data-testid="board-fit" title="기판 전체 보기"
              style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${UI_LINE}`, background: UI_BG,
                color: UI_FG, fontFamily: 'var(--sf-font-mono)', fontSize: 11, cursor: 'pointer' }}>
              맞춤
            </button>
          )}
          {placed && !assembly && <button onClick={replay} data-testid="board-replay"
            style={{ padding: '4px 10px', borderRadius: 6,
              border: `1px solid ${UI_LINE}`, background: UI_BG,
              color: UI_FG, fontFamily: 'var(--sf-font-mono)', fontSize: 11, cursor: 'pointer' }}>
            ↺ 다시 보기
          </button>}
        </div>
      )}

      {/* AI improvement rounds */}
      {placed && ai.length > 0 && !assembly && (
        <div data-testid="board-ai" style={{ position: 'absolute', left: 12, top: 12, width: aiOpen ? 320 : 'auto', maxWidth: '46%',
          borderRadius: 8, background: UI_BG, color: UI_FG, border: `1px solid ${UI_LINE}`,
          fontFamily: MONO, fontSize: 11, overflow: 'hidden' }}>
          <button type="button" onClick={() => setAiOpen(!aiOpen)} aria-expanded={aiOpen} data-testid="board-ai-toggle"
            title={aiOpen ? '접기' : 'AI 다듬기 라운드 보기'}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none',
              background: 'transparent', cursor: 'pointer', color: UI_FG, font: 'inherit', whiteSpace: 'nowrap' }}>
            <StatusChip tone={aiSkipped ? 'warn' : 'accent'}>{aiSkipped ? 'AI 다듬기 건너뜀' : 'AI 다듬기'}</StatusChip>
            {!aiSkipped && <span style={{ color: UI_DIM }}>채택 {ai.filter(r => r.kept).length}/{ai.filter(r => !r.actions.stop).length}</span>}
            <span aria-hidden="true" style={{ marginLeft: 'auto', color: UI_DIM }}>{aiOpen ? '▾' : '▸'}</span>
          </button>
          {aiOpen && <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {ai.map((r, i) => {
              const d = r.after ? r.after.hpwl - r.before.hpwl : 0
              return (
                <div key={`${r.round}-${r.part ?? i}`} data-ai-kept={r.kept ? '1' : '0'}
                  style={{ padding: '6px 10px', borderTop: `1px solid ${UI_LINE}`, color: UI_FG }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <StatusChip tone={r.kept ? 'ok' : 'idle'}>{r.kept ? '채택' : r.actions.stop ? '중단' : '되돌림'}</StatusChip>
                    <span style={{ color: UI_DIM }}>
                      {r.round > 0 ? `${r.round}라운드` : ''}{r.part ? ` ${r.part === 'width' ? '선 폭' : '배치'}` : ''}
                    </span>
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 11.5, lineHeight: 1.45 }}>{r.reason}</div>
                  {r.after && (
                    <div style={{ color: UI_DIM }}>
                      선 길이 {r.before.hpwl.toFixed(1)} → {r.after.hpwl.toFixed(1)} mm ({d > 0 ? '+' : ''}{d.toFixed(1)}) ·
                      비아 {r.before.vias}→{r.after.vias} · 미배선 {r.after.unrouted} · DRC 오류 {r.after.drcErrors}
                      {r.before.decap != null && r.after.decap != null && r.before.decap > 0 &&
                        <> · 디커플링 {r.before.decap.toFixed(1)}→{r.after.decap.toFixed(1)} mm</>}
                      {r.before.powerWidth != null && r.after.powerWidth != null && (r.before.powerWidth > 0 || r.after.powerWidth > 0) &&
                        <> · 좁은 전원선 {r.before.powerWidth}→{r.after.powerWidth}</>}
                    </div>
                  )}
                  {r.note && <div style={{ color: UI_DIM }}>{r.note}</div>}
                </div>
              )
            })}
          </div>}
        </div>
      )}

      {/* checks: one row per rule, passed rules included; failed rows open to their findings */}
      {placed && !assembly && (
        <div ref={checksRef} data-testid="board-checks" style={{ position: 'absolute', right: 12, top: 48, width: 300, maxWidth: '48%',
          // stops above the 3D hint in the bottom-right corner
          maxHeight: 'calc(100% - 92px)', display: 'flex', flexDirection: 'column',
          borderRadius: 8, background: UI_BG, color: UI_FG, border: `1px solid ${UI_LINE}`,
          fontFamily: MONO, fontSize: 11, overflow: 'hidden' }}>
          <button type="button" onClick={() => setPanelOpen(!listOpen)} aria-expanded={listOpen}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', flexShrink: 0,
              border: 'none', background: 'transparent', cursor: 'pointer', color: UI_FG, font: 'inherit' }}>
            <StatusChip tone={checkHead.tone} busy={checkSum.pending} testId="board-checks-summary">{checkHead.text}</StatusChip>
            <span data-testid="board-checks-passed" style={{ color: UI_DIM, whiteSpace: 'nowrap' }}>
              통과 {checkSum.passed}/{checkSum.ran}
            </span>
            <span aria-hidden="true" style={{ marginLeft: 'auto', color: UI_DIM }}>{listOpen ? '▾' : '▸'}</span>
          </button>
          {listOpen && (
            <div style={{ overflowY: 'auto', minHeight: 0 }}>
              {rows.map((r, idx) => {
                const heading = r.group && (idx === 0 || rows[idx - 1].group !== r.group) ? (
                  <div key={`g-${r.group}`} data-check-group={r.group}
                    style={{ padding: '7px 10px 3px', borderTop: idx ? `1px solid ${UI_LINE}` : undefined, color: UI_DIM,
                      fontFamily: SANS, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', background: 'rgba(0, 0, 0, 0.025)' }}>
                    {r.group}
                  </div>
                ) : null
                const items = r.findings.map(id => findingById[id]).filter(Boolean)
                const expandable = r.id === HUMAN_ROW || items.length > 0 || r.detail.length > 0 || !!r.items?.length
                const open = expandable && (openRows[r.id] ?? (r.state === 'error' || r.state === 'review'))
                const head = (
                  <>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontFamily: SANS, fontSize: 12, lineHeight: '16px' }}>{r.label}</span>
                      <span style={{ display: 'block', fontSize: 9.5, color: UI_DIM, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.id}{r.note ? ` · ${r.note}` : ''}
                      </span>
                    </span>
                    <Stamp row={r} />
                  </>
                )
                const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box' as const, padding: '5px 10px',
                  border: 'none', background: 'transparent', textAlign: 'left' as const, color: UI_FG, font: 'inherit' }
                return (
                  <Fragment key={r.id}>
                  {heading}
                  <div data-check={r.id} data-state={r.state} style={{ borderTop: heading ? 'none' : `1px solid ${UI_LINE}` }}>
                    {expandable
                      ? <button type="button" aria-expanded={open} style={{ ...rowStyle, cursor: 'pointer' }}
                          onClick={() => setOpenRows(o => ({ ...o, [r.id]: !open }))}>{head}</button>
                      : <div style={rowStyle}>{head}</div>}
                    {open && r.id === HUMAN_ROW && (
                      <div data-check-detail={r.id} style={{ paddingBottom: 6 }}>
                        <div style={{ padding: '2px 10px 6px 16px', color: UI_DIM, fontFamily: SANS, lineHeight: 1.45 }}>
                          자동 검사가 볼 수 없는 것만 묻습니다. 실물 부품이나 데이터시트와 맞춰 보고 체크하세요.
                          3D에서 부품을 눌러도 이 목록으로 옵니다.
                        </div>
                        {reviewList.map(it => {
                          const ok = reviewedKeys.has(it.key)
                          const on = pickRef === it.ref
                          return (
                            <div key={it.key} data-review={it.ref} data-review-ok={ok ? '1' : '0'}
                              style={{ margin: '0 8px 6px 10px', padding: '6px 8px', borderRadius: 4,
                                border: `1px solid ${on ? TONE_COLOR.accent : UI_LINE}`,
                                background: on ? 'rgba(106, 76, 181, 0.06)' : 'transparent' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <input type="checkbox" checked={ok} onChange={() => toggleReviewed(it)}
                                  aria-label={`${it.ref} ${KIND_LABEL[it.kind]} 확인함`}
                                  style={{ margin: 0, width: 14, height: 14, flexShrink: 0, accentColor: TONE_COLOR.ok, cursor: 'pointer' }} />
                                <button type="button" onClick={() => selectPart(it.ref)} title="기판에서 보기"
                                  style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700,
                                    color: UI_FG, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                                  {it.ref}
                                </button>
                                <span style={{ minWidth: 0, color: UI_DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {it.value} · {KIND_LABEL[it.kind]}
                                </span>
                              </div>
                              {it.warning && (
                                <div style={{ marginTop: 4, color: TONE_COLOR.bad, fontFamily: SANS, lineHeight: 1.45 }}>{it.warning}</div>
                              )}
                              <div style={{ marginTop: 4, fontFamily: SANS, lineHeight: 1.45 }}>{it.what}</div>
                              <table style={{ marginTop: 4, borderCollapse: 'collapse', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
                                <thead>
                                  <tr>{['패드', '핀', '넷'].map(h => (
                                    <th key={h} scope="col" style={{ padding: '0 12px 0 0', textAlign: 'left', fontWeight: 400, color: UI_DIM }}>{h}</th>
                                  ))}</tr>
                                </thead>
                                <tbody>
                                  {it.pins.map(pn => (
                                    <tr key={pn.pad}>
                                      <td style={{ padding: '0 12px 0 0' }}>{pn.pad}</td>
                                      <td style={{ padding: '0 12px 0 0', fontWeight: 700 }}>{pn.name}</td>
                                      <td style={{ color: UI_DIM }}>{pn.net ?? '연결 없음'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {open && r.id !== HUMAN_ROW && (
                      <div data-check-detail={r.id} style={{ paddingBottom: 4 }}>
                        {r.detail.map((line, k) => (
                          <div key={k} style={{ padding: '2px 10px 2px 16px', color: UI_DIM, lineHeight: 1.45 }}>{line}</div>
                        ))}
                        {items.map(f => (
                          <button type="button" key={f.id} data-finding={f.id} onClick={() => focusOn(f)}
                            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '3px 10px 3px 16px',
                              border: 'none', cursor: f.pos ? 'pointer' : 'default', font: 'inherit', lineHeight: 1.45,
                              background: focusId === f.id ? 'rgba(0, 0, 0, 0.05)' : 'transparent',
                              color: TONE_COLOR[f.severity === 'error' ? 'bad' : 'warn'] }}>
                            {f.text}
                            {f.pos && <span style={{ color: UI_DIM }}> · {f.pos.x.toFixed(1)}, {f.pos.y.toFixed(1)}</span>}
                          </button>
                        ))}
                        {/* per-part results with the calculation behind each */}
                        {r.items?.map((it, k) => (
                          <div key={`${r.id}-${it.ref}-${k}`} data-op={it.ref} data-op-state={it.state}
                            style={{ margin: '0 8px 6px 10px', padding: '5px 8px', borderRadius: 4, border: `1px solid ${UI_LINE}` }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                              <span style={{ flexShrink: 0, minWidth: 52, textAlign: 'center', padding: '0 5px', borderRadius: 3,
                                border: `1px solid ${TONE_COLOR[STATE_TONE[it.state]]}`, color: TONE_COLOR[STATE_TONE[it.state]],
                                fontSize: 10, fontWeight: 700, lineHeight: '16px', whiteSpace: 'nowrap' }}>{stateWord(it.state)}</span>
                              <button type="button" onClick={() => selectPart(it.ref)} title="기판에서 보기"
                                style={{ border: 'none', background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer',
                                  font: 'inherit', fontFamily: SANS, fontSize: 11.5, lineHeight: 1.45, color: UI_FG }}>
                                {it.summary}
                              </button>
                            </div>
                            {it.detail.map((line, k) => (
                              <div key={k} style={{ marginTop: 2, paddingLeft: 60, color: UI_DIM, fontSize: 10.5, lineHeight: 1.45 }}>{line}</div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  </Fragment>
                )
              })}
            </div>
          )}
        </div>
      )}
      </div>

      {/* status bar: the board's numbers in one line, the same values the checks use */}
      <div data-testid="board-status" style={{ position: 'relative', flexShrink: 0, display: 'flex', flexWrap: 'wrap',
        alignItems: 'center', gap: '4px 14px', padding: '6px 12px', background: UI_BG, borderTop: `1px solid ${UI_LINE}`,
        color: UI_FG, fontFamily: MONO, fontSize: 11, lineHeight: '18px', fontVariantNumeric: 'tabular-nums' }}>
        <StatusChip tone={phaseTone} busy={!settled} testId="board-phase">{label}</StatusChip>
        {!placed && cur && <>
          <Metric k="반복" v={cur.iter} />
          <Metric k="선 길이 추정" v={`${cur.hpwl.toFixed(1)} mm`} />
          {spark && <svg width={80} height={16} aria-hidden="true" style={{ display: 'block' }}>
            <path d={spark} fill="none" stroke={RATSNEST} strokeWidth={1.2} />
          </svg>}
        </>}
        {assembly && placed && (
          <Metric testId="board-assembly" k="배치" v={`${placedRefs.size}/${asmRefs.length}`}
            tone={placedRefs.size === asmRefs.length && asmRefs.length > 0 ? 'ok' : undefined}
            title="실물 기판에 부품을 올린 것. 기판에서 부품을 누르거나 오른쪽 목록에서 체크합니다" />
        )}
        {placed && saving != null && !assembly && (
          <Metric testId="board-saving" k="배치" tone="ok"
            v={`격자 대비 −${saving}% (${hpwlShelf?.toFixed(0)} → ${hpwlFinal?.toFixed(0)} mm)`}
            title="선 길이 추정(HPWL): 격자에 늘어놓은 배치와 비교" />
        )}
        {placed && routes.length > 0 && <>
          <Metric testId="board-routing" k="배선" v={`${routedNow}/${connections}`}
            tone={routedAll ? (unrouted.length ? 'bad' : 'ok') : undefined} />
          <Metric testId="board-vias" k="비아" v={copper.vias.length} />
          <Metric testId="board-tracks" k="트랙" v={`${trackLen.toFixed(0)} mm`} />
        </>}
        {placed && outline && (
          <Metric testId="board-size" k="기판" v={`${(outline[2] - outline[0]).toFixed(1)} × ${(outline[3] - outline[1]).toFixed(1)} mm`} />
        )}
        {settled && drcNow && <>
          <Metric testId="board-drc" k="DRC 오류" v={drcNow.errors} tone={drcNow.errors ? 'bad' : 'ok'} />
          <Metric testId="board-unconnected" k="미연결" v={drcNow.unconnected} tone={drcNow.unconnected ? 'bad' : 'ok'} />
        </>}
        {settled && drc && !drc.available && <Metric testId="board-drc" k="DRC" v="건너뜀" tone="warn" title={drc.reason} />}
        {placed && reviewList.length > 0 && (
          <Metric testId="board-review" k="사람 확인" v={`${reviewedKeys.size}/${reviewList.length}`}
            tone={reviewedKeys.size === reviewList.length ? 'ok' : 'warn'}
            title={assembly ? '극성·핀 배열·커넥터 순서처럼 자동 검사가 볼 수 없는 것. 부품을 누르면 오른쪽에서 체크합니다'
              : "극성·핀 배열·커넥터 순서처럼 자동 검사가 볼 수 없는 것. 검사 목록의 '사람 확인'에서 체크합니다"} />
        )}
        {hoverNet && <Metric k="넷" v={hoverNet} />}
      </div>
    </div>
  )
}

/**
 * Assembly list beside the board: the parts grouped like the BOM, one chip per part (✓ when placed),
 * and for the part last touched its review (polarity, pinout) with its own tick.
 */
function AssemblyPanel({ lines, total, placedRefs, pick, reviewList, reviewedKeys, hasFurniture, onToggle, onPick, onClear, onReview }: {
  lines: BomLine[]
  total: number
  placedRefs: Set<string>
  pick: string | null
  reviewList: ReviewItem[]
  reviewedKeys: Set<string>
  hasFurniture: boolean
  onToggle: (ref: string) => void
  /** show a part's details without ticking it */
  onPick: (ref: string) => void
  onClear: () => void
  onReview: (it: ReviewItem) => void
}) {
  const done = placedRefs.size
  const pickLine = pick ? lines.find(l => l.refs.includes(pick)) : undefined
  const pickReviews = pick ? reviewList.filter(it => it.ref === pick) : []
  const toLook = new Set(reviewList.filter(it => !reviewedKeys.has(it.key)).map(it => it.ref))
  const small = { fontSize: 11, color: UI_DIM, lineHeight: 1.45 }
  return (
    <aside data-testid="assembly-panel" aria-label="배치하기"
      style={{ flex: `0 0 ${ASSEMBLY_W}px`, width: ASSEMBLY_W, minWidth: 0, display: 'flex', flexDirection: 'column',
        borderLeft: `1px solid ${UI_LINE}`, background: '#fbfaf7', color: UI_FG, fontFamily: SANS, overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${UI_LINE}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>배치하기</strong>
          <span data-testid="assembly-count" style={{ fontFamily: MONO, fontSize: 11, color: done === total && total ? TONE_COLOR.ok : UI_DIM }}>
            {done}/{total}
          </span>
          <button type="button" onClick={onClear} disabled={!done}
            style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 4, border: `1px solid ${UI_LINE}`, background: 'transparent',
              color: UI_DIM, fontFamily: MONO, fontSize: 10, cursor: done ? 'pointer' : 'default', opacity: done ? 1 : 0.5 }}>
            모두 해제
          </button>
        </div>
        <div role="progressbar" aria-label="배치한 부품" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
          style={{ marginTop: 6, height: 5, borderRadius: 3, background: 'rgba(0, 0, 0, 0.08)', overflow: 'hidden' }}>
          <div style={{ width: `${total ? (done / total) * 100 : 0}%`, height: '100%', background: TONE_COLOR.ok, transition: 'width 0.2s' }} />
        </div>
        <div style={{ ...small, marginTop: 6 }}>기판에서 부품을 누르면 체크되고, 다시 누르면 풀립니다. 끌어서 이동, 휠로 확대합니다.</div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0 10px' }}>
        {lines.map(l => {
          const n = l.refs.filter(r => placedRefs.has(r)).length
          return (
            <div key={l.key} data-assembly-line={l.refs.join(',')} style={{ padding: '6px 12px', borderBottom: `1px solid rgba(0, 0, 0, 0.05)` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, ...small }}>
                <span style={{ color: UI_FG, whiteSpace: 'nowrap' }}>{l.type}</span>
                <span style={{ marginLeft: 'auto', fontFamily: MONO, color: n === l.qty ? TONE_COLOR.ok : UI_DIM }}>{n}/{l.qty}</span>
              </div>
              <div style={{ ...small, fontFamily: MONO, overflowWrap: 'anywhere' }}>{l.value}{l.pkg ? ` · ${l.pkg}` : ''}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {l.refs.map(ref => {
                  const on = placedRefs.has(ref)
                  return (
                    <span key={ref} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    <button type="button" data-assembly-ref={ref} aria-pressed={on}
                      onClick={() => onToggle(ref)}
                      title={`${ref} ${on ? '배치함 (누르면 해제)' : '눌러서 배치 체크'}${toLook.has(ref) ? ' · 극성·핀 배열 확인 필요' : ''}`}
                      style={{ padding: '2px 8px', borderRadius: 12, cursor: 'pointer', fontFamily: MONO, fontSize: 11,
                        border: `1px solid ${on ? TONE_COLOR.ok : pick === ref ? TONE_COLOR.accent : UI_LINE}`,
                        background: on ? TONE_COLOR.ok : '#ffffff', color: on ? '#ffffff' : UI_FG }}>
                      {on ? '✓ ' : ''}{ref}
                    </button>
                    {reviewList.some(it => it.ref === ref) && (
                      <button type="button" data-assembly-info={ref} onClick={() => onPick(ref)}
                        aria-label={`${ref} 극성·핀 배열 보기${toLook.has(ref) ? ' (확인 필요)' : ' (확인함)'}`}
                        title="극성·핀 배열 보기 (배치 체크는 바뀌지 않습니다)"
                        style={{ width: 20, height: 20, padding: 0, borderRadius: 10, cursor: 'pointer', fontFamily: MONO, fontSize: 11, fontWeight: 700,
                          border: `1px solid ${toLook.has(ref) ? TONE_COLOR.warn : UI_LINE}`, background: '#ffffff',
                          color: toLook.has(ref) ? TONE_COLOR.warn : TONE_COLOR.ok }}>
                        {toLook.has(ref) ? '!' : '✓'}
                      </button>
                    )}
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}
        {hasFurniture && <div style={{ ...small, padding: '8px 12px 0' }}>테스트 패드와 고정 구멍은 올릴 부품이 아니라 목록에서 뺐습니다.</div>}
        {reviewList.length > 0 && <div style={{ ...small, padding: '4px 12px 0' }}><span style={{ color: TONE_COLOR.warn, fontWeight: 700 }}>!</span> 단추는 극성이나 핀 배열을 실물과 맞춰 볼 부품입니다. 누르면 배치 체크는 그대로 두고 목록 아래에 확인 내용이 나옵니다.</div>}
      </div>
      {pick && pickLine && (
        <div data-testid="assembly-pick" style={{ padding: '8px 12px', borderTop: `1px solid ${UI_LINE}`, flexShrink: 0, maxHeight: '45%', overflowY: 'auto', background: 'rgba(106, 76, 181, 0.04)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <strong style={{ fontFamily: MONO, fontSize: 12 }}>{pick}</strong>
            <span style={{ ...small, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pickLine.value} · {pickLine.type}{pickLine.pkg ? ` · ${pickLine.pkg}` : ''}
            </span>
          </div>
          <button type="button" onClick={() => onToggle(pick)} aria-pressed={placedRefs.has(pick)}
            style={{ marginTop: 6, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontFamily: SANS, fontSize: 11.5,
              border: `1px solid ${TONE_COLOR.ok}`, background: placedRefs.has(pick) ? TONE_COLOR.ok : 'transparent',
              color: placedRefs.has(pick) ? '#ffffff' : TONE_COLOR.ok }}>
            {placedRefs.has(pick) ? '✓ 배치함' : '배치 체크'}
          </button>
          {pickReviews.map(it => (
            <div key={it.key} data-assembly-review={it.ref} style={{ marginTop: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={reviewedKeys.has(it.key)} onChange={() => onReview(it)}
                  style={{ margin: 0, width: 14, height: 14, accentColor: TONE_COLOR.ok, cursor: 'pointer' }} />
                {KIND_LABEL[it.kind]} 확인함
              </label>
              {it.warning && <div style={{ marginTop: 4, fontSize: 11, color: TONE_COLOR.bad, lineHeight: 1.45 }}>{it.warning}</div>}
              <div style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.45 }}>{it.what}</div>
              <div style={{ ...small, marginTop: 2, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>
                {it.pins.map(pn => `패드 ${pn.pad} = ${pn.name}${pn.net ? ` (${pn.net})` : ''}`).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}

    </aside>
  )
}
