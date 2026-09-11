import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardFrame, BoardModel, BoardPart, BoardPad } from '../types'

// Draws the real board model (mm) streamed by /generate_pcb_stream and plays the
// placement frames back as an animation. Coordinates follow KiCad: y down,
// rot in degrees counter-clockwise on screen — i.e. SVG rotate(-rot).

const PCB_GREEN = '#0c2418'
const EDGE = '#e8c97a'
const COPPER = '#d9a35a'
const COPPER_HI = '#ffc56f'
const HOLE = '#081a11'
const RATSNEST = '#7fd1ff'
const SILK = '#dfe5dd'
const COURTYARD = 'rgba(223, 229, 221, 0.18)'

const FRAME_MS = 30          // playback: one frame every 30 ms (~70 frames ≈ 2 s)
const FIT_MS = 600           // camera move from the scatter view to the finished board

const PHASE_LABEL: Record<string, string> = {
  force: '부품 모으는 중',
  legalize: '겹침 정리 · 회전',
  refine: '다듬는 중',
}

type Box = [number, number, number, number]

interface Props {
  parts: BoardPart[]
  frames: BoardFrame[]
  target: Box | null            // frame the placer aims for (from the init event)
  final: BoardModel | null      // board.json after "done"
  hpwlShelf?: number
  status: 'streaming' | 'done' | 'error'
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

function PadShape({ p, hi }: { p: BoardPad; hi: boolean }) {
  const fill = hi ? COPPER_HI : COPPER
  const t = `translate(${p.x} ${p.y}) rotate(${-p.angle})`
  const w = p.w, h = p.h
  let body
  if (p.shape === 'circle') body = <circle r={w / 2} fill={fill} />
  else if (p.shape === 'oval') body = <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={Math.min(w, h) / 2} fill={fill} />
  else if (p.shape === 'roundrect') body = <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={Math.min(w, h) * 0.25} fill={fill} />
  else body = <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={fill} />
  return (
    <g transform={t}>
      {body}
      {p.drill ? <circle r={p.drill / 2} fill={HOLE} /> : null}
    </g>
  )
}

export default function BoardView({ parts, frames, target, final, hpwlShelf, status }: Props) {
  const [playhead, setPlayhead] = useState(0)          // fractional frame index
  const [fit, setFit] = useState(0)                    // 0 = scatter view, 1 = fitted to the board
  const [hoverNet, setHoverNet] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [panXY, setPanXY] = useState<[number, number]>([0, 0])
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const framesRef = useRef(frames)
  framesRef.current = frames

  // playback clock: advance toward the newest frame, one frame per FRAME_MS
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      setPlayhead(ph => Math.min(ph + dt / FRAME_MS, Math.max(framesRef.current.length - 1, 0)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const atEnd = frames.length > 0 && playhead >= frames.length - 1
  const finished = status === 'done' && atEnd && !!final

  // camera: after the last frame plays, glide to the finished board
  useEffect(() => {
    if (!finished) { setFit(0); return }
    const start = performance.now()
    let raf = 0
    const step = (now: number) => {
      const t = Math.min((now - start) / FIT_MS, 1)
      setFit(1 - (1 - t) * (1 - t))
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [finished])

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

  // absolute pads -> ratsnest
  const nets = useMemo(() => {
    const pts: Record<string, [number, number][]> = {}
    for (const [ref, [x, y, r]] of Object.entries(poses)) {
      const p = byRef[ref]
      if (!p) continue
      for (const pd of p.pads) {
        if (!pd.net) continue
        const [dx, dy] = rotate(pd.x, pd.y, r)
        ;(pts[pd.net] ||= []).push([x + dx, y + dy])
      }
    }
    return Object.entries(pts).map(([net, list]) => ({ net, list, edges: mst(list) }))
  }, [poses, byRef])

  const cur = frames.length ? frames[Math.min(Math.round(playhead), frames.length - 1)] : null
  const hpwlNow = cur?.hpwl
  const hpwlFinal = final && frames.length ? frames[frames.length - 1].hpwl : null
  const saving = hpwlFinal != null && hpwlShelf ? Math.round((1 - hpwlFinal / hpwlShelf) * 100) : null

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
  function replay() { setPlayhead(0); setZoom(1); setPanXY([0, 0]) }

  const outline = final?.outline
  const label = status === 'error' ? '오류' : finished ? '배치 완료' : (cur ? PHASE_LABEL[cur.phase] : '준비 중')

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--sf-bg-inverse)', overflow: 'hidden' }}>
      <svg ref={svgRef} data-testid="board-view" viewBox={viewBox} width="100%" height="100%"
        style={{ display: 'block', cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={() => { dragRef.current = null }}>
        {/* board: target frame while placing, real outline when done */}
        {outline && fit > 0
          ? <rect x={outline[0]} y={outline[1]} width={outline[2] - outline[0]} height={outline[3] - outline[1]}
              fill={PCB_GREEN} stroke={EDGE} strokeWidth={0.15} opacity={fit} />
          : null}
        {target && fit < 1
          ? <rect x={target[0]} y={target[1]} width={target[2] - target[0]} height={target[3] - target[1]}
              fill={PCB_GREEN} fillOpacity={0.55 * (1 - fit)} stroke={EDGE} strokeOpacity={0.5 * (1 - fit)}
              strokeWidth={0.12} strokeDasharray="0.8 0.6" />
          : null}

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
                <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke={COURTYARD} strokeWidth={0.05} />
                {p.pads.map((pd, k) => <PadShape key={k} p={pd} hi={!!hoverNet && pd.net === hoverNet} />)}
              </g>
              <text x={(box[0] + box[2]) / 2} y={(box[1] + box[3]) / 2} fontSize={size} fill={SILK}
                textAnchor="middle" dominantBaseline="central" fontFamily="var(--sf-font-mono)"
                style={{ pointerEvents: 'none' }} opacity={0.9}>{ref}</text>
            </g>
          )
        })}

        {/* ratsnest */}
        {nets.map(({ net, list, edges }) => edges.map(([a, b], k) => (
          <line key={`${net}-${k}`} x1={list[a][0]} y1={list[a][1]} x2={list[b][0]} y2={list[b][1]}
            stroke={RATSNEST} strokeWidth={hoverNet === net ? 0.22 : 0.1}
            opacity={hoverNet && hoverNet !== net ? 0.25 : 0.8}
            onPointerEnter={() => setHoverNet(net)} onPointerLeave={() => setHoverNet(null)}>
            <title>{net}</title>
          </line>
        )))}
      </svg>

      {/* overlay */}
      <div style={{ position: 'absolute', left: 12, bottom: 12, padding: '8px 10px', borderRadius: 8,
        background: 'rgba(8, 26, 17, 0.82)', color: 'var(--sf-fg-inverse)', fontFamily: 'var(--sf-font-mono)',
        fontSize: 11, lineHeight: 1.5, minWidth: 170 }}>
        <div data-testid="board-phase" style={{ fontWeight: 700, color: finished ? '#5dc8a3' : EDGE }}>{label}</div>
        {cur && <div style={{ opacity: 0.75 }}>반복 {cur.iter} · 선 길이 추정 {hpwlNow?.toFixed(1)} mm</div>}
        {spark && <svg width={120} height={28} style={{ display: 'block', marginTop: 4 }}>
          <path d={spark} fill="none" stroke={RATSNEST} strokeWidth={1.2} />
        </svg>}
        {finished && saving != null && (
          <div data-testid="board-saving" style={{ marginTop: 4, color: '#5dc8a3' }}>
            격자 배치 대비 −{saving}% ({hpwlShelf?.toFixed(0)} → {hpwlFinal?.toFixed(0)} mm)
          </div>
        )}
        {finished && outline && (
          <div style={{ opacity: 0.75 }}>기판 {(outline[2] - outline[0]).toFixed(1)} × {(outline[3] - outline[1]).toFixed(1)} mm</div>
        )}
        {hoverNet && <div style={{ color: RATSNEST }}>넷: {hoverNet}</div>}
      </div>
      {finished && (
        <button onClick={replay} data-testid="board-replay"
          style={{ position: 'absolute', right: 12, top: 12, padding: '4px 10px', borderRadius: 6,
            border: '1px solid rgba(232, 201, 122, 0.5)', background: 'rgba(8, 26, 17, 0.82)',
            color: EDGE, fontFamily: 'var(--sf-font-mono)', fontSize: 11, cursor: 'pointer' }}>
          ↺ 다시 보기
        </button>
      )}
    </div>
  )
}
