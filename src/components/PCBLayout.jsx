import { useState, useEffect, useMemo, useRef } from 'react'

const COPPER = '#d9a35a'
const COPPER_GLOW = '#ffc56f'
const PCB_GREEN = '#0c2418'
const PCB_GREEN_DARK = '#081a11'
const PAD_GOLD = '#e8c97a'
const SILK_WHITE = '#dfe5dd'

const COMP_TYPE_LABELS = {
  R: '저항', C: '커패시터', L: '인덕터', D: '다이오드',
  Q: '트랜지스터', U: 'IC', SW: '스위치', LS: '스피커',
  K: '릴레이', BT: '배터리', F: '퓨즈',
}

function getMaxPin(ref, nets) {
  let m = 2
  nets.forEach(n => n.nodes.forEach(nd => { if (nd.ref === ref) m = Math.max(m, parseInt(nd.pin) || 2) }))
  return m
}

// PCB-style footprint sizes (different from schematic — flatter, wider)
function getFootprint(ref, pinCount) {
  const t = ref[0].toUpperCase()
  if (t === 'R' || t === 'D' || t === 'L') {
    // 2-pin SMD-like: two pads at ends
    return {
      w: 60, h: 26,
      pads: [
        { x: -22, y: 0, w: 12, h: 14 },
        { x: 22, y: 0, w: 12, h: 14 },
      ],
      pinIndex: { 1: 0, 2: 1 },
    }
  }
  if (t === 'C') {
    return {
      w: 48, h: 26,
      pads: [
        { x: -16, y: 0, w: 10, h: 14 },
        { x: 16, y: 0, w: 10, h: 14 },
      ],
      pinIndex: { 1: 0, 2: 1 },
    }
  }
  if (t === 'Q') {
    // SOT-23 style 3-pin
    return {
      w: 44, h: 38,
      pads: [
        { x: -16, y: -12, w: 10, h: 8 },
        { x: -16, y: 12, w: 10, h: 8 },
        { x: 16, y: 0, w: 10, h: 8 },
      ],
      pinIndex: { 1: 0, 2: 1, 3: 2 },
    }
  }
  // IC-style DIP: pinCount pins on left/right
  const half = Math.ceil(pinCount / 2)
  const h = Math.max(60, half * 12 + 16)
  const w = 56
  const pads = []
  const pinIndex = {}
  for (let i = 0; i < half; i++) {
    pads.push({ x: -w / 2 + 4, y: -h / 2 + 12 + i * 12, w: 10, h: 6 })
    pinIndex[i + 1] = pads.length - 1
  }
  for (let i = 0; i < pinCount - half; i++) {
    pads.push({ x: w / 2 - 4, y: -h / 2 + 12 + i * 12, w: 10, h: 6 })
    pinIndex[half + i + 1] = pads.length - 1
  }
  return { w, h, pads, pinIndex }
}

function autoLayout(comps, footprints) {
  const cols = Math.min(Math.ceil(Math.sqrt(Math.max(comps.length, 1))), 4)
  const HGAP = 36, VGAP = 36, M = 56
  const cW = Array(cols).fill(0), rH = []
  comps.forEach((c, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    cW[col] = Math.max(cW[col], (footprints[c.ref]?.w || 50) + HGAP)
    if (!rH[row]) rH[row] = 0
    rH[row] = Math.max(rH[row], (footprints[c.ref]?.h || 30) + VGAP)
  })
  const pos = {}
  let cx = M
  for (let col = 0; col < cols; col++) {
    let cy = M + 14
    for (let row = 0; row < Math.ceil(comps.length / cols); row++) {
      const idx = row * cols + col
      if (idx >= comps.length) continue
      pos[comps[idx].ref] = { x: cx + cW[col] / 2, y: cy + rH[row] / 2 }
      cy += rH[row]
    }
    cx += cW[col]
  }
  const TW = cx + M
  const TH = Object.values(pos).reduce((m, p) => Math.max(m, p.y), 0) + M + 30
  return { positions: pos, width: Math.max(TW, 480), height: Math.max(TH, 320) }
}

function padAbs(ref, pin, pos, footprints) {
  const p = pos[ref], fp = footprints[ref]
  if (!p || !fp) return null
  const idx = fp.pinIndex[pin] ?? 0
  const pad = fp.pads[idx]
  if (!pad) return null
  return { x: p.x + pad.x, y: p.y + pad.y, w: pad.w, h: pad.h }
}

function isPowerNet(name) {
  if (!name) return false
  const n = name.toUpperCase()
  return ['GND','AGND','DGND','PGND','SGND','EARTH','PWR','POWER','VBAT','AVCC','VREF'].includes(n)
    || /^VCC/.test(n) || /^VDD/.test(n) || /^VEE/.test(n) || /^VSS/.test(n)
    || /^VIN/.test(n) || /^VOUT/.test(n) || /^3V/.test(n) || /^5V/.test(n)
    || /^12V/.test(n) || /^\d+V\d*$/.test(n)
}

function getPCBTraceColor(name) {
  const n = (name || '').toUpperCase()
  if (/GND|EARTH|VSS|VEE|AGND|DGND|PGND/.test(n)) return '#5dc8a3'
  if (/VCC|VDD|VIN|V\d|^\d+V/.test(n)) return '#e74848'
  return null
}

// PCB trace routing: V-H-V-H with optional mx (mid-x) and my (mid-y)
function routeTrace(ax, ay, bx, by, mx, my) {
  const midY = my !== undefined ? my : by
  const midX = mx !== undefined ? mx : ax
  return `M${ax},${ay} L${ax},${midY} L${midX},${midY} L${midX},${by} L${bx},${by}`
}

// Minimum Spanning Tree (Prim's, Manhattan distance)
function buildMST(pts) {
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

export default function PCBLayout({ graph }) {
  const svgRef = useRef(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [positions, setPositions] = useState({})
  const [hoveredNet, setHoveredNet] = useState(null)
  const [selectedNet, setSelectedNet] = useState(null)
  const [localNets, setLocalNets] = useState(null)
  const [netsHistory, setNetsHistory] = useState([])
  const [toast, setToast] = useState(null)
  const [traceBends, setTraceBends] = useState({})
  const [traceDrag, setTraceDrag] = useState(null)   // for rendering only
  const traceDragRef = useRef(null)                   // live drag state
  const dragRef = useRef(null)
  const panDragRef = useRef(null)
  const didPanRef = useRef(false)

  const comps = graph?.components || []
  const nets = graph?.nets || []
  const effectiveNets = localNets || nets

  const containerRef = useRef(null)
  const onWheelRef = useRef(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e) => onWheelRef.current?.(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const footprints = useMemo(() => {
    const fp = {}
    comps.forEach(c => { fp[c.ref] = getFootprint(c.ref, getMaxPin(c.ref, nets)) })
    return fp
  }, [graph])

  const auto = useMemo(() => autoLayout(comps, footprints), [graph, footprints])

  useEffect(() => {
    setPositions(auto.positions)
    setPan({ x: 0, y: 0 })
    setZoom(1)
    setTraceBends({})
    setTraceDrag(null)
    traceDragRef.current = null
    setSelectedNet(null)
    setLocalNets(null)
  }, [graph])

  if (!graph || !comps.length) return null

  const W = auto.width, H = auto.height

  function svgPoint(e) {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / zoom - pan.x,
      y: (e.clientY - rect.top) / zoom - pan.y,
    }
  }

  function onCompPointerDown(e, ref) {
    e.stopPropagation()
    const pt = svgPoint(e)
    const p = positions[ref] || { x: 0, y: 0 }
    dragRef.current = { ref, offsetX: pt.x - p.x, offsetY: pt.y - p.y, startX: pt.x, startY: pt.y, moved: false }
    try { svgRef.current?.setPointerCapture(e.pointerId) } catch (_) {}
  }

  function onSvgPointerDown(e) {
    if (e.button === 0 || e.button === 1) {
      panDragRef.current = { lastX: e.clientX, lastY: e.clientY }
      didPanRef.current = false
      try { svgRef.current?.setPointerCapture(e.pointerId) } catch (_) {}
      e.preventDefault()
    }
  }

  function showToast(msg) {
    setToast(prev => {
      if (prev?.timeoutId) clearTimeout(prev.timeoutId)
      const id = setTimeout(() => setToast(null), 4500)
      return { msg, timeoutId: id }
    })
  }

  function deleteTrace(ni) {
    const base = localNets ? [...localNets] : [...nets]
    const deleted = base[ni]
    setNetsHistory(prev => [...prev.slice(-19), base])
    setLocalNets(base.filter((_, i) => i !== ni))
    setSelectedNet(null)
    showToast(`'${deleted?.name || '트레이스'}' 삭제됨`)
  }

  function undoTraceDelete() {
    setNetsHistory(prev => {
      if (!prev.length) return prev
      const next = [...prev]
      const restored = next.pop()
      setLocalNets(restored)
      setToast(null)
      return next
    })
  }

  function onTraceDragStart(e, netIdx, segIdx, defaultMx, defaultMy) {
    e.stopPropagation()
    const pt = svgPoint(e)
    traceDragRef.current = { netIdx, segIdx, startMx: defaultMx, startMy: defaultMy, startX: pt.x, startY: pt.y, pointerId: e.pointerId, captured: false }
  }

  function onSvgPointerMove(e) {
    const td = traceDragRef.current
    if (td) {
      const pt = svgPoint(e)
      if (!td.captured && (Math.abs(pt.x - td.startX) > 3 || Math.abs(pt.y - td.startY) > 3)) {
        td.captured = true
        try { svgRef.current?.setPointerCapture(td.pointerId) } catch (_) {}
        setTraceDrag({ netIdx: td.netIdx, segIdx: td.segIdx })
        setSelectedNet(td.netIdx)
      }
      if (td.captured) {
        const newMx = td.startMx + (pt.x - td.startX)
        const newMy = td.startMy + (pt.y - td.startY)
        setTraceBends(b => ({ ...b, [`${td.netIdx}_${td.segIdx}`]: { mx: newMx, my: newMy } }))
      }
      return
    }
    const d = dragRef.current
    if (d) {
      const pt = svgPoint(e)
      if (!d.moved && (Math.abs(pt.x - d.startX) > 3 || Math.abs(pt.y - d.startY) > 3)) d.moved = true
      if (d.moved) setPositions(p => ({ ...p, [d.ref]: { x: pt.x - d.offsetX, y: pt.y - d.offsetY } }))
      return
    }
    const pd = panDragRef.current
    if (pd) {
      const dx = (e.clientX - pd.lastX) / zoom, dy = (e.clientY - pd.lastY) / zoom
      if (Math.abs(e.clientX - pd.lastX) > 2 || Math.abs(e.clientY - pd.lastY) > 2) didPanRef.current = true
      setPan(p => ({ x: p.x + dx, y: p.y + dy }))
      pd.lastX = e.clientX; pd.lastY = e.clientY
    }
  }

  function onSvgPointerUp(e) {
    const td = traceDragRef.current
    if (td) {
      const captured = td.captured
      traceDragRef.current = null
      setTraceDrag(null)
      if (captured) {
        dragRef.current = null
        panDragRef.current = null
        try { svgRef.current?.releasePointerCapture(e.pointerId) } catch (_) {}
        return
      }
    }
    dragRef.current = null
    panDragRef.current = null
    try { svgRef.current?.releasePointerCapture(e.pointerId) } catch (_) {}
  }

  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setZoom(z => Math.min(4, Math.max(0.25, z * (e.deltaY > 0 ? 0.9 : 1.1))))
  }
  onWheelRef.current = onWheel

  // Board outline
  const PAD = 30
  const boardX = PAD, boardY = PAD
  const boardW = W - 2 * PAD, boardH = H - 2 * PAD

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', background:'#080a10', overflow:'hidden' }}>
      {/* toolbar */}
      <div style={{
        display:'flex', alignItems:'center', gap:6, padding:'6px 14px',
        background:'#0b0d14', borderBottom:'1px solid #151821', flexShrink:0,
      }}>
        <span style={{ width:6, height:6, borderRadius:'50%', background:'#d9a35a', flexShrink:0 }} />
        <span style={{ fontFamily:'var(--sf-font-mono)', fontSize:10, color:'#d9a35a', letterSpacing:'0.12em', fontWeight:700 }}>PCB</span>
        <span style={{ fontFamily:'var(--sf-font-mono)', fontSize:10, color:'#2a3040' }}>2층 · Ctrl+스크롤 줌 · 드래그 이동 · 트레이스 드래그 경로변경</span>
        {netsHistory.length > 0 && (
          <button onClick={undoTraceDelete} style={{
            padding:'2px 8px', borderRadius:4, border:'1px solid #2a1a4a',
            background:'transparent', color:'#a78bfa', cursor:'pointer',
            fontFamily:'var(--sf-font-mono)', fontSize:10,
          }}>↩ 되돌리기</button>
        )}
        {localNets && <span style={{ fontFamily:'var(--sf-font-mono)', fontSize:10, color:'#34d3a0' }}>● 수정됨</span>}
        <div style={{ flex:1 }} />
        {Object.keys(traceBends).length > 0 && (
          <button onClick={() => setTraceBends({})} style={{
            padding:'3px 8px', border:'1px solid #1c2030', borderRadius:4,
            background:'transparent', color:COPPER, cursor:'pointer',
            fontFamily:'var(--sf-font-mono)', fontSize:10,
          }}>↺ 트레이스 초기화</button>
        )}
        <div style={{ display:'flex', gap:2 }}>
          {[['−', -0.15], ['+', 0.15], ['⌂', 0]].map(([lbl, d]) => (
            <button key={lbl} onClick={() => {
              if (d === 0) { setZoom(1); setPan({ x: 0, y: 0 }); setPositions(auto.positions) }
              else setZoom(z => Math.min(4, Math.max(0.25, z + d)))
            }} style={{ padding:'3px 8px', border:'1px solid #1c2030', borderRadius:4, background:'transparent', color:'#5a6278', cursor:'pointer', fontFamily:'var(--sf-font-mono)', fontSize:12 }}>{lbl}</button>
          ))}
        </div>
      </div>

      <div ref={containerRef} style={{ flex:1, overflow:'hidden', position:'relative' }}>
        {/* Floating trace info panel */}
        {selectedNet !== null && (() => {
          const net = effectiveNets[selectedNet]
          if (!net) return null
          const isPwr = isPowerNet(net.name)
          const traceColor = getPCBTraceColor(net.name) || COPPER
          return (
            <div style={{
              position:'absolute', right:12, top:'50%', transform:'translateY(-50%)',
              background:'rgba(8,12,18,0.95)', border:`1px solid ${traceColor}44`,
              borderRadius:8, padding:'12px 14px', zIndex:10, minWidth:160,
              boxShadow:`0 0 18px ${traceColor}22`,
              fontFamily:"'IBM Plex Mono','JetBrains Mono',monospace",
              pointerEvents:'auto',
            }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                  <span style={{ width:8, height:8, borderRadius:'50%', background:traceColor, display:'block',
                    boxShadow:`0 0 6px ${traceColor}` }} />
                  <span style={{ fontSize:13, fontWeight:700, color:traceColor }}>{net.name}</span>
                </div>
                <button onClick={() => setSelectedNet(null)} style={{
                  background:'none', border:'none', color:'#3a4055', cursor:'pointer', fontSize:14, padding:'0 2px', lineHeight:1,
                }}>×</button>
              </div>
              <div style={{ fontSize:9, color:'#2e3a50', letterSpacing:'0.1em', marginBottom:6 }}>NODES</div>
              <div style={{ display:'flex', flexDirection:'column', gap:3, marginBottom:12 }}>
                {net.nodes.map((nd, i) => (
                  <span key={i} style={{
                    fontSize:10, color:'#8899b0', padding:'2px 6px',
                    background:'rgba(255,255,255,0.04)', borderRadius:3,
                  }}>{nd.ref}[{nd.pin}]</span>
                ))}
              </div>
              <button onClick={() => deleteTrace(selectedNet)} style={{
                width:'100%', padding:'5px 0', borderRadius:4,
                border:'1px solid rgba(248,113,113,0.3)',
                background:'rgba(248,113,113,0.06)',
                color:'#f87171', cursor:'pointer', fontSize:10,
                fontFamily:"'IBM Plex Mono',monospace",
              }}>✕ 트레이스 삭제</button>
            </div>
          )
        })()}
        {/* deletion toast */}
        {toast && (
          <div style={{
            position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)',
            zIndex:50, display:'flex', alignItems:'center', gap:10,
            background:'#0e1018', border:'1px solid #2a3040',
            borderRadius:8, padding:'8px 14px',
            fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#8090b0',
            boxShadow:'0 4px 20px rgba(0,0,0,0.5)',
          }}>
            <span>{toast.msg}</span>
            <button onClick={undoTraceDelete} style={{
              padding:'2px 8px', borderRadius:4, border:'1px solid #2a1a4a',
              background:'transparent', color:'#a78bfa', cursor:'pointer', fontSize:10,
            }}>↩ 되돌리기</button>
            <button onClick={() => setToast(null)} style={{
              background:'none', border:'none', color:'#3a4055', cursor:'pointer', fontSize:14, lineHeight:1,
            }}>×</button>
          </div>
        )}

        <svg
          ref={svgRef}
          width="100%" height="100%"
          style={{ display:'block', userSelect:'none', touchAction:'none', background: PCB_GREEN_DARK,
            cursor: panDragRef.current ? 'grabbing' : 'grab' }}
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={e => onSvgPointerUp(e)}
          onContextMenu={e => e.preventDefault()}
          onClick={e => {
            if (didPanRef.current) { didPanRef.current = false; return }
            if (!e.target.closest?.('g[data-trace]')) setSelectedNet(null)
          }}
        >
          <g transform={`scale(${zoom}) translate(${pan.x},${pan.y})`}>
              <defs>
                <pattern id="pcb-grid" width="10" height="10" patternUnits="userSpaceOnUse">
                  <circle cx="0" cy="0" r="0.6" fill="rgba(255,255,255,0.05)" />
                </pattern>
                <linearGradient id="pcb-board" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#0e2c1d" />
                  <stop offset="1" stopColor="#0a1f15" />
                </linearGradient>
                <radialGradient id="pad-gradient" cx="50%" cy="50%">
                  <stop offset="0" stopColor="#fce19f" />
                  <stop offset="1" stopColor={PAD_GOLD} />
                </radialGradient>
              </defs>

              {/* Board substrate */}
              <rect
                x={boardX} y={boardY} width={boardW} height={boardH}
                rx="14"
                fill="url(#pcb-board)"
                stroke={COPPER}
                strokeOpacity="0.4"
                strokeWidth="2"
              />
              <rect
                x={boardX + 6} y={boardY + 6}
                width={boardW - 12} height={boardH - 12}
                rx="10"
                fill="url(#pcb-grid)"
              />

              {/* Mounting holes */}
              {[
                { x: boardX + 14, y: boardY + 14 },
                { x: boardX + boardW - 14, y: boardY + 14 },
                { x: boardX + 14, y: boardY + boardH - 14 },
                { x: boardX + boardW - 14, y: boardY + boardH - 14 },
              ].map((h, i) => (
                <g key={`hole-${i}`}>
                  <circle cx={h.x} cy={h.y} r="5" fill={PAD_GOLD} />
                  <circle cx={h.x} cy={h.y} r="2.5" fill={PCB_GREEN_DARK} />
                </g>
              ))}

              {/* Traces (copper) */}
              {effectiveNets.map((net, ni) => {
                const isPwr = isPowerNet(net.name)
                const isHover = hoveredNet === ni
                const isSel = selectedNet === ni
                const traceColor = getPCBTraceColor(net.name) || COPPER
                const op = (isHover || isSel) ? 1 : 0.85
                const w = isSel ? 4 : isHover ? 3.5 : (isPwr ? 3 : 2.2)

                const pts = net.nodes
                  .map(n => padAbs(n.ref, n.pin, positions, footprints))
                  .filter(Boolean)
                  .map(p => ({ x: p.x, y: p.y }))
                if (pts.length < 2) return null

                const mstEdges = buildMST(pts)

                return (
                  <g key={ni}
                     data-trace={ni}
                     onPointerEnter={() => setHoveredNet(ni)}
                     onPointerLeave={() => setHoveredNet(prev => prev === ni ? null : prev)}
                     onClick={e => { e.stopPropagation(); setSelectedNet(ni) }}
                     style={{ cursor: 'pointer' }}
                  >
                    {mstEdges.map(([ai, bi], i) => {
                      const a = pts[ai], b = pts[bi]
                      const bend = traceBends[`${ni}_${i}`]
                      const mx = bend?.mx ?? a.x
                      const my = bend?.my ?? b.y
                      const isDraggingThis = traceDrag?.netIdx===ni && traceDrag?.segIdx===i
                      const path = routeTrace(a.x, a.y, b.x, b.y, mx, my)
                      return (
                        <g key={i}>
                          {(isHover || isSel) && (
                            <path d={path} stroke={COPPER_GLOW} strokeOpacity="0.35"
                                  strokeWidth={w + 5} fill="none" strokeLinecap="round" strokeLinejoin="round"
                                  pointerEvents="none" />
                          )}
                          <path d={path} stroke="transparent" strokeWidth="16" fill="none"
                                style={{ cursor: 'move' }}
                                onPointerDown={e => onTraceDragStart(e, ni, i, mx, my)} />
                          <path d={path} stroke={traceColor} strokeOpacity={op}
                                strokeWidth={isSel||isDraggingThis ? w+0.8 : w}
                                fill="none" strokeLinecap="round" strokeLinejoin="round"
                                pointerEvents="none" />
                          <circle cx={mx} cy={my} r={isSel||isDraggingThis ? 3.5 : 2}
                                  fill={traceColor} fillOpacity={op} pointerEvents="none" />
                        </g>
                      )
                    })}
                  </g>
                )
              })}

              {/* Components (footprints) */}
              {comps.map(c => {
                const p = positions[c.ref]
                const fp = footprints[c.ref]
                if (!p || !fp) return null
                const t = c.ref[0].toUpperCase()
                const dim = hoveredNet != null && !effectiveNets[hoveredNet]?.nodes.some(nd => nd.ref === c.ref)
                const editedValue = c.value || ''

                return (
                  <g
                    key={c.ref}
                    transform={`translate(${p.x},${p.y})`}
                    opacity={dim ? 0.4 : 1}
                    onPointerDown={(e) => onCompPointerDown(e, c.ref)}
                    style={{ cursor: 'grab', touchAction: 'none' }}
                  >
                    {/* Body silkscreen */}
                    <rect
                      x={-fp.w / 2} y={-fp.h / 2}
                      width={fp.w} height={fp.h}
                      rx={t === 'U' ? 3 : 4}
                      fill={t === 'U' ? '#1a1a1a' : (t === 'C' ? '#0d2333' : '#1a1612')}
                      stroke={SILK_WHITE}
                      strokeOpacity="0.4"
                      strokeWidth="1"
                    />
                    {/* Polarity indicator for IC */}
                    {t === 'U' && (
                      <circle cx={-fp.w / 2 + 6} cy={-fp.h / 2 + 6} r="1.6" fill={SILK_WHITE} fillOpacity="0.7" />
                    )}
                    {/* Polarity for diode */}
                    {t === 'D' && (
                      <line x1={5} y1={-fp.h / 2 + 4} x2={5} y2={fp.h / 2 - 4}
                            stroke={SILK_WHITE} strokeOpacity="0.6" strokeWidth="1" />
                    )}
                    {/* Pads */}
                    {fp.pads.map((pad, i) => (
                      <rect
                        key={i}
                        x={pad.x - pad.w / 2} y={pad.y - pad.h / 2}
                        width={pad.w} height={pad.h}
                        rx="1.5"
                        fill="url(#pad-gradient)"
                        stroke={COPPER}
                        strokeWidth="0.5"
                      />
                    ))}
                    {/* Ref label */}
                    <text x={0} y={-fp.h / 2 - 6} textAnchor="middle"
                          fill={SILK_WHITE} fillOpacity="0.85"
                          fontSize="10" fontWeight="600"
                          fontFamily="'IBM Plex Mono','JetBrains Mono',monospace"
                          pointerEvents="none">{c.ref}</text>
                    {/* Value label inside if there's room */}
                    {fp.h >= 36 && (
                      <text x={0} y={4} textAnchor="middle"
                            fill={SILK_WHITE} fillOpacity="0.55"
                            fontSize="8.5"
                            fontFamily="'IBM Plex Mono','JetBrains Mono',monospace"
                            pointerEvents="none">{editedValue}</text>
                    )}
                    {fp.h < 36 && editedValue && (
                      <text x={0} y={fp.h / 2 + 12} textAnchor="middle"
                            fill={SILK_WHITE} fillOpacity="0.55"
                            fontSize="8.5"
                            fontFamily="'IBM Plex Mono','JetBrains Mono',monospace"
                            pointerEvents="none">{editedValue}</text>
                    )}
                  </g>
                )
              })}
          </g>
        </svg>
      </div>

      {/* Legend */}
      <div style={{ padding:'8px 14px', borderTop:'1px solid #151821', background:'#0b0d14', display:'flex', alignItems:'center', gap:14, flexShrink:0 }}>
        <Legend color={COPPER} label="신호" />
        <Legend color="#e74848" label="VCC" />
        <Legend color="#5dc8a3" label="GND" />
        <Legend color={PAD_GOLD} label="패드" />
        <span style={{ marginLeft:'auto', fontSize:9, color:'#2a3040', fontFamily:'var(--sf-font-mono)' }}>풋프린트 시각화</span>
      </div>
    </div>
  )
}

function Legend({ color, label }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:10, color:'#3a4055', fontFamily:'var(--sf-font-mono)' }}>
      <span style={{ width:12, height:2, background:color, borderRadius:1, display:'block' }} />
      {label}
    </div>
  )
}
