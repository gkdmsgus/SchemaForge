import { useState, useEffect, useRef, useMemo, useCallback } from 'react'

// ── Color palette ─────────────────────────────────────────────
const NET_COLORS = ['#a78bfa','#34d3a0','#f59e0b','#60a5fa','#f87171','#38bdf8','#fb923c','#a3e635']
const COMP_COLORS = { R:'#f59e0b', C:'#60a5fa', Q:'#34d3a0', D:'#f87171', L:'#a78bfa', U:'#38bdf8', SW:'#fb923c', K:'#f59e0b', BT:'#a3e635' }
const BG = '#080a10'
const COMP_FILL = '#0e1018'
const COMP_BORDER = '#1c2030'
const GRID_DOT = '#1a1e2c'
const TEXT_DIM = '#3a4055'
const TEXT_LABEL = '#c8cfe8'
const TEXT_VALUE = '#5a6278'
const PIN_IDLE = '#2a3040'
const PIN_HOVER = '#a78bfa'
const PIN_ACTIVE = '#f59e0b'
const WIRE_PREVIEW = '#a78bfacc'

const COMP_TYPE_LABELS = {
  R:'Resistor', C:'Capacitor', L:'Inductor', D:'Diode/LED',
  Q:'Transistor', U:'IC/Chip', SW:'Switch', K:'Relay',
  LS:'Speaker', BT:'Battery', F:'Fuse', J:'Connector',
}

function compColor(ref) {
  return COMP_COLORS[ref[0].toUpperCase()] || '#64748b'
}

function getMaxPin(ref, nets) {
  let m = 2
  nets.forEach(n => n.nodes.forEach(nd => { if (nd.ref === ref) m = Math.max(m, parseInt(nd.pin) || 2) }))
  return m
}

function getPinLayout(ref, pinCount) {
  const t = ref[0].toUpperCase()
  const PIN_STUB = 14
  if (t === 'Q') {
    return { w: 72, h: 80,
      pins: { 1:{x:-36,y:0,side:'L'}, 2:{x:0,y:-40,side:'T'}, 3:{x:0,y:40,side:'B'} } }
  }
  if (pinCount <= 2) {
    return { w: 80, h: 44,
      pins: { 1:{x:-40,y:0,side:'L'}, 2:{x:40,y:0,side:'R'} } }
  }
  const l = Math.ceil(pinCount / 2), r = Math.floor(pinCount / 2)
  const h = Math.max(72, Math.max(l,r) * 22 + 28)
  const pins = {}
  for (let i=0;i<l;i++) pins[i+1] = {x:-50,y:-h/2+24+i*22,side:'L'}
  for (let i=0;i<r;i++) pins[l+i+1] = {x:50,y:-h/2+24+i*22,side:'R'}
  return { w: 100, h, pins }
}

function pinAbsPos(ref, pin, pos, layouts) {
  const p = pos[ref], l = layouts[ref]
  if (!p || !l) return null
  const pn = l.pins[pin] || l.pins[Object.keys(l.pins)[0]]
  const STUB = 14
  if (pn.side === 'L') return { x: p.x - l.w/2 - STUB, y: p.y + pn.y }
  if (pn.side === 'R') return { x: p.x + l.w/2 + STUB, y: p.y + pn.y }
  if (pn.side === 'T') return { x: p.x + pn.x, y: p.y - l.h/2 - STUB }
  return { x: p.x + pn.x, y: p.y + l.h/2 + STUB }
}

function autoLayout(comps, layouts) {
  const cols = Math.min(Math.ceil(Math.sqrt(Math.max(comps.length,1))), 5)
  const HGAP = 110, VGAP = 100, M = 80
  const cW = Array(cols).fill(0), rH = []
  comps.forEach((c,i) => {
    const col = i%cols, row = Math.floor(i/cols)
    cW[col] = Math.max(cW[col], (layouts[c.ref]?.w||80)+HGAP)
    if (!rH[row]) rH[row]=0
    rH[row] = Math.max(rH[row], (layouts[c.ref]?.h||60)+VGAP)
  })
  const pos = {}
  let cx = M
  for (let col=0;col<cols;col++) {
    let cy = M+30
    for (let row=0;row<Math.ceil(comps.length/cols);row++) {
      const idx=row*cols+col
      if (idx>=comps.length) continue
      pos[comps[idx].ref] = { x: cx+cW[col]/2, y: cy+rH[row]/2 }
      cy += rH[row]
    }
    cx += cW[col]
  }
  const TW = cx+M
  const TH = Object.values(pos).reduce((m,p)=>Math.max(m,p.y),0)+M+80
  return { positions:pos, width:Math.max(TW,700), height:Math.max(TH,480) }
}

function isPowerNet(name) {
  if (!name) return false
  const n = name.toUpperCase()
  return ['GND','AGND','DGND','PGND','SGND','EARTH','PWR','POWER','VBAT','AVCC','VREF'].includes(n)
    || /^VCC/.test(n) || /^VDD/.test(n) || /^VEE/.test(n) || /^VSS/.test(n)
    || /^VIN/.test(n) || /^VOUT/.test(n) || /^3V/.test(n) || /^5V/.test(n)
    || /^12V/.test(n) || /^V3\d/.test(n) || /^V5\d/.test(n) || /^\d+V\d*$/.test(n)
}

function PowerSymbol({ x, y, name, color }) {
  const isGnd = /GND|EARTH|VSS|VEE/i.test(name)
  if (isGnd) {
    return (
      <g pointerEvents="none">
        <line x1={x} y1={y} x2={x} y2={y+16} stroke={color} strokeWidth="1.5" />
        <line x1={x-10} y1={y+16} x2={x+10} y2={y+16} stroke={color} strokeWidth="1.5" />
        <line x1={x-6}  y1={y+21} x2={x+6}  y2={y+21} stroke={color} strokeWidth="1.2" />
        <line x1={x-2}  y1={y+26} x2={x+2}  y2={y+26} stroke={color} strokeWidth="1" />
        <text x={x} y={y+38} textAnchor="middle" fill={color} fontSize="9"
              fontFamily="'IBM Plex Mono',monospace" fontWeight="600">{name}</text>
      </g>
    )
  }
  return (
    <g pointerEvents="none">
      <line x1={x} y1={y} x2={x} y2={y-16} stroke={color} strokeWidth="1.5" />
      <line x1={x-10} y1={y-16} x2={x+10} y2={y-16} stroke={color} strokeWidth="2" />
      <text x={x} y={y-22} textAnchor="middle" fill={color} fontSize="9"
            fontFamily="'IBM Plex Mono',monospace" fontWeight="600">{name}</text>
    </g>
  )
}

// Right-angle wire routing with optional mx (vertical x) and my (middle horizontal y)
// Default: H-V-H (3 segments). With my set: H-V-H-V (5 segments, Z-shape).
function routeWire(ax, ay, bx, by, mx, my) {
  const midX = mx !== undefined ? mx : ax + (bx - ax) * 0.5
  const midY = my !== undefined ? my : by
  return `M${ax},${ay} L${midX},${ay} L${midX},${midY} L${bx},${midY} L${bx},${by}`
}

// Minimum Spanning Tree (Prim's, Manhattan distance) — minimises total wire length
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

export default function CircuitCanvas({ graph, graphDiff = null }) {
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const panDragRef = useRef(null)
  const didPanRef = useRef(false)
  const [positions, setPositions] = useState({})
  const [selected, setSelected] = useState(null)
  const [selectedNet, setSelectedNet] = useState(null) // selected wire index
  const [hoveredNet, setHoveredNet] = useState(null)
  const [hoveredPin, setHoveredPin] = useState(null) // { ref, pin }
  const [wireState, setWireState] = useState(null)     // { fromRef, fromPin }
  const [reconnectState, setReconnectState] = useState(null) // { netIdx, nodeIdx }
  const [wireDrag, setWireDrag] = useState(null)        // { netIdx, segIdx } — for rendering only
  const wireDragRef = useRef(null)                       // live drag state, avoids stale closures
  const [wireBends, setWireBends] = useState({})        // { "ni_i": { mx, my } }
  const [cursor, setCursor] = useState({ x:0, y:0 })
  const [localNets, setLocalNets] = useState(null)
  const [netsHistory, setNetsHistory] = useState([])  // undo stack for net deletions
  const [toast, setToast] = useState(null)             // { msg, timeoutId }
  const [edits, setEdits] = useState({})
  const [editingRef, setEditingRef] = useState(null)
  const [editingValue, setEditingValue] = useState('')

  const comps = graph?.components || []
  const nets = graph?.nets || []
  const effectiveNets = localNets || nets

  // Non-passive wheel listener to allow preventDefault for zoom
  const containerRef = useRef(null)
  const onWheelRef = useRef(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e) => onWheelRef.current?.(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const layouts = useMemo(() => {
    const ls = {}
    comps.forEach(c => { ls[c.ref] = getPinLayout(c.ref, getMaxPin(c.ref, nets)) })
    return ls
  }, [graph])

  const auto = useMemo(() => autoLayout(comps, layouts), [graph, layouts])

  useEffect(() => {
    setPositions(auto.positions)
    setSelected(null)
    setSelectedNet(null)
    setLocalNets(null)
    setNetsHistory([])
    setToast(null)
    setEdits({})
    setWireState(null)
    setWireDrag(null)
    wireDragRef.current = null
    setWireBends({})
    setZoom(1)
    setPan({ x:0, y:0 })
  }, [graph])

  if (!graph || !comps.length) return null

  const W = auto.width, H = auto.height

  function svgPoint(e) {
    const svg = svgRef.current
    if (!svg) return { x:0, y:0 }
    const rect = svg.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / zoom - pan.x,
      y: (e.clientY - rect.top)  / zoom - pan.y,
    }
  }

  // ── Drag / pan — all pointer handling on SVG ─────────────
  function onCompPointerDown(e, ref) {
    if (wireState) return
    e.stopPropagation()
    const pt = svgPoint(e)
    const p = positions[ref] || { x:0, y:0 }
    dragRef.current = { ref, offsetX:pt.x-p.x, offsetY:pt.y-p.y, startX:pt.x, startY:pt.y, moved:false }
    // Capture on SVG so onPointerMove on the SVG always fires during drag
    try { svgRef.current?.setPointerCapture(e.pointerId) } catch(_) {}
  }

  function onSvgPointerDown(e) {
    if (reconnectState) return
    if (wireState && e.button === 0) {
      // 빈 공간 클릭 시 wireState 취소
      setWireState(null)
      return
    }
    if (e.button === 1 || e.altKey || e.button === 0) {
      panDragRef.current = { lastX: e.clientX, lastY: e.clientY }
      didPanRef.current = false
      try { svgRef.current?.setPointerCapture(e.pointerId) } catch (_) {}
      e.preventDefault()
    }
  }

  function onSvgPointerMove(e) {
    const pt = svgPoint(e)
    if (wireState || reconnectState) setCursor(pt)
    const wd = wireDragRef.current
    if (wd) {
      // Capture pointer on first real movement to keep drag smooth
      if (!wd.captured && (Math.abs(pt.x - wd.startX) > 3 || Math.abs(pt.y - wd.startY) > 3)) {
        wd.captured = true
        try { svgRef.current?.setPointerCapture(wd.pointerId) } catch (_) {}
        setWireDrag({ netIdx: wd.netIdx, segIdx: wd.segIdx })
        setSelectedNet(wd.netIdx)
        setSelected(null)
      }
      if (wd.captured) {
        const newMx = wd.startMx + (pt.x - wd.startX)
        const newMy = wd.startMy + (pt.y - wd.startY)
        setWireBends(b => ({ ...b, [`${wd.netIdx}_${wd.segIdx}`]: { mx: newMx, my: newMy } }))
      }
      return
    }
    const d = dragRef.current
    if (d && !wireState) {
      if (!d.moved && (Math.abs(pt.x-d.startX)>4 || Math.abs(pt.y-d.startY)>4)) d.moved = true
      if (d.moved) setPositions(p => ({ ...p, [d.ref]: { x:pt.x-d.offsetX, y:pt.y-d.offsetY } }))
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
    if (wireDragRef.current) {
      const captured = wireDragRef.current.captured
      wireDragRef.current = null
      setWireDrag(null)
      if (captured) {
        dragRef.current = null
        panDragRef.current = null
        try { svgRef.current?.releasePointerCapture(e.pointerId) } catch (_) {}
        return
      }
    }
    if (reconnectState) {
      const pt = svgPoint(e)
      const nearest = findNearestPin(pt.x, pt.y)
      if (nearest) reconnectEndpoint(reconnectState.netIdx, reconnectState.nodeIdx, nearest.ref, nearest.pin)
      else setReconnectState(null)
      dragRef.current = null
      panDragRef.current = null
      try { svgRef.current?.releasePointerCapture(e.pointerId) } catch (_) {}
      return
    }
    const d = dragRef.current
    if (d && !d.moved) setSelected(s => s===d.ref ? null : d.ref)
    dragRef.current = null
    panDragRef.current = null
    try { svgRef.current?.releasePointerCapture(e.pointerId) } catch(_) {}
  }

  // ── Wire drawing ──────────────────────────────────────────
  function onPinPointerDown(e, ref, pinNum) {
    e.stopPropagation()  // 컴포넌트 드래그 차단
    e.preventDefault()
    if (!wireState) {
      const pa = pinAbsPos(ref, pinNum, positions, layouts)
      if (pa) { setWireState({ fromRef: ref, fromPin: String(pinNum) }); setCursor(pa) }
    } else {
      if (wireState.fromRef !== ref || wireState.fromPin !== String(pinNum)) {
        connectPins(wireState.fromRef, wireState.fromPin, ref, String(pinNum))
      }
      setWireState(null)
    }
  }

  function connectPins(ref1, pin1, ref2, pin2) {
    setLocalNets(prev => {
      const base = prev ? [...prev] : nets.map(n => ({ ...n, nodes: [...n.nodes] }))
      const i1 = base.findIndex(n => n.nodes.some(nd => nd.ref===ref1 && String(nd.pin)===String(pin1)))
      const i2 = base.findIndex(n => n.nodes.some(nd => nd.ref===ref2 && String(nd.pin)===String(pin2)))
      if (i1>=0 && i2>=0 && i1!==i2) {
        const merged = [...base]
        merged[i1] = { ...merged[i1], nodes: [...merged[i1].nodes, ...merged[i2].nodes] }
        merged.splice(i2, 1)
        return merged
      } else if (i1>=0) {
        const merged = [...base]
        merged[i1] = { ...merged[i1], nodes: [...merged[i1].nodes, { ref:ref2, pin:String(pin2) }] }
        return merged
      } else if (i2>=0) {
        const merged = [...base]
        merged[i2] = { ...merged[i2], nodes: [...merged[i2].nodes, { ref:ref1, pin:String(pin1) }] }
        return merged
      }
      return [...base, { name:`NET_${base.length+1}`, nodes:[{ ref:ref1, pin:String(pin1) }, { ref:ref2, pin:String(pin2) }] }]
    })
  }

  function showToast(msg) {
    setToast(prev => {
      if (prev?.timeoutId) clearTimeout(prev.timeoutId)
      const id = setTimeout(() => setToast(null), 4500)
      return { msg, timeoutId: id }
    })
  }

  function deleteNet(ni) {
    const base = localNets ? [...localNets] : [...nets]
    const deleted = base[ni]
    setNetsHistory(prev => [...prev.slice(-19), base])
    setLocalNets(base.filter((_, i) => i !== ni))
    setSelectedNet(null)
    showToast(`'${deleted?.name || '선'}' 삭제됨`)
  }

  function undoNetDelete() {
    setNetsHistory(prev => {
      if (!prev.length) return prev
      const next = [...prev]
      const restored = next.pop()
      setLocalNets(restored)
      setToast(null)
      return next
    })
  }

  function findNearestPin(x, y, threshold = 22) {
    let best = null, bestDist = threshold
    comps.forEach(c => {
      const l = layouts[c.ref]
      if (!l) return
      Object.keys(l.pins).forEach(pinNum => {
        const pt = pinAbsPos(c.ref, pinNum, positions, layouts)
        if (!pt) return
        const d = Math.hypot(pt.x - x, pt.y - y)
        if (d < bestDist) { best = { ref: c.ref, pin: pinNum }; bestDist = d }
      })
    })
    return best
  }

  function reconnectEndpoint(netIdx, nodeIdx, newRef, newPin) {
    setLocalNets(prev => {
      let nts = (prev || nets).map(n => ({ ...n, nodes: [...n.nodes] }))
      // Remove the dragged node from its net
      nts[netIdx] = { ...nts[netIdx], nodes: nts[netIdx].nodes.filter((_, i) => i !== nodeIdx) }
      // Find if newRef:newPin already lives in another net
      const destIdx = nts.findIndex(n => n.nodes.some(nd => nd.ref === newRef && String(nd.pin) === String(newPin)))
      if (nts[netIdx].nodes.length === 0) {
        // Net is now empty, remove it
        return nts.filter((_, i) => i !== netIdx)
      }
      if (destIdx >= 0 && destIdx !== netIdx) {
        // Merge dest net into our net
        nts[netIdx] = { ...nts[netIdx], nodes: [...nts[netIdx].nodes, ...nts[destIdx].nodes] }
        nts = nts.filter((_, i) => i !== destIdx)
      } else if (destIdx < 0) {
        nts[netIdx] = { ...nts[netIdx], nodes: [...nts[netIdx].nodes, { ref: newRef, pin: String(newPin) }] }
      }
      return nts
    })
    setReconnectState(null)
    setSelectedNet(null)
  }

  function onEndpointPointerDown(e, netIdx, nodeIdx) {
    e.stopPropagation()
    if (wireState) return
    setReconnectState({ netIdx, nodeIdx })
    setCursor(svgPoint(e))
    try { svgRef.current?.setPointerCapture(e.pointerId) } catch (_) {}
  }

  function onNetClick(e, ni) {
    e.stopPropagation()
    if (wireState) return
    setSelectedNet(ni)
    setSelected(null)
  }

  function onWireDragStart(e, netIdx, segIdx, defaultMx, defaultMy) {
    e.stopPropagation()
    if (wireState || reconnectState) return
    const pt = svgPoint(e)
    // Save to ref only — no pointer capture yet so click still fires normally on <g data-net>
    // (capturing here would redirect click to SVG, which would clear selectedNet)
    wireDragRef.current = { netIdx, segIdx, startMx: defaultMx, startMy: defaultMy, startX: pt.x, startY: pt.y, pointerId: e.pointerId, captured: false }
  }

  // ── Zoom ──────────────────────────────────────────────────
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setZoom(z => Math.min(4, Math.max(0.25, z * (e.deltaY > 0 ? 0.9 : 1.1))))
  }
  onWheelRef.current = onWheel

  // ── Value inline edit ─────────────────────────────────────
  function startEdit(ref, val) {
    setEditingRef(ref)
    setEditingValue(val)
  }
  function commitEdit() {
    if (editingRef) setEdits(es => ({ ...es, [editingRef]: { value: editingValue } }))
    setEditingRef(null)
  }

  const selectedComp = selected ? comps.find(c => c.ref===selected) : null
  const connectedRefs = hoveredNet!=null
    ? new Set(effectiveNets[hoveredNet]?.nodes.map(n=>n.ref)||[])
    : null

  // ── Wire preview path ─────────────────────────────────────
  const wireFromPt = wireState ? pinAbsPos(wireState.fromRef, wireState.fromPin, positions, layouts) : null

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', background:BG, position:'relative' }}>

      {/* toolbar */}
      <div style={{
        display:'flex', alignItems:'center', gap:6, padding:'6px 14px',
        background:'#0b0d14', borderBottom:'1px solid #151821', flexShrink:0,
      }}>
        <span style={{ fontFamily:'var(--sf-font-mono)', fontSize:10, color:TEXT_DIM, letterSpacing:'0.1em' }}>
          {comps.length} COMPS · {effectiveNets.length} NETS
        </span>
        {wireState && (
          <span style={{
            fontFamily:'var(--sf-font-mono)', fontSize:10, color:PIN_ACTIVE,
            letterSpacing:'0.08em', padding:'2px 8px', borderRadius:4,
            background:'rgba(245,158,11,0.1)', border:'1px solid rgba(245,158,11,0.25)',
          }}>
            {wireState.fromRef}[{wireState.fromPin}] → 연결할 핀 클릭 · ESC 취소
          </span>
        )}
        {selectedNet !== null && !wireState && (() => {
          const net = effectiveNets[selectedNet]
          if (!net) return null
          const color = NET_COLORS[selectedNet % NET_COLORS.length]
          return (
            <span style={{ display:'flex', alignItems:'center', gap:8, padding:'2px 10px', borderRadius:4,
              background:'rgba(167,139,250,0.1)', border:'1px solid rgba(167,139,250,0.3)',
              fontFamily:'var(--sf-font-mono)', fontSize:10 }}>
              <span style={{ width:6, height:6, borderRadius:'50%', background:color }} />
              <span style={{ color }}>{net.name}</span>
              <span style={{ color:'#3a4055' }}>
                {net.nodes.map(n => `${n.ref}[${n.pin}]`).join(' → ')}
              </span>
              <span style={{ color:'#3a4055', margin:'0 2px' }}>·</span>
              <span style={{ color:'#5a6278', fontSize:9 }}>끝점 드래그로 재연결</span>
              <button onClick={() => deleteNet(selectedNet)} style={{
                marginLeft:4, padding:'1px 6px', borderRadius:3, border:'1px solid #2a1515',
                background:'transparent', color:'#f87171', cursor:'pointer', fontSize:10
              }}>✕ 삭제</button>
            </span>
          )
        })()}
        {netsHistory.length > 0 && (
          <button onClick={undoNetDelete} style={{
            padding:'2px 8px', borderRadius:4, border:'1px solid #2a1a4a',
            background:'transparent', color:'#a78bfa', cursor:'pointer',
            fontFamily:'var(--sf-font-mono)', fontSize:10,
          }}>↩ 되돌리기</button>
        )}
        {localNets && (
          <span style={{ fontFamily:'var(--sf-font-mono)', fontSize:10, color:'#34d3a0', letterSpacing:'0.08em' }}>● 수정됨</span>
        )}
        <div style={{ flex:1 }} />
        {Object.keys(wireBends).length > 0 && (
          <button onClick={() => setWireBends({})} style={{
            padding:'3px 8px', border:'1px solid #1c2030', borderRadius:4,
            background:'transparent', color:'#a78bfa', cursor:'pointer',
            fontFamily:'var(--sf-font-mono)', fontSize:10,
          }}>↺ 선 초기화</button>
        )}
        <span style={{ fontFamily:'var(--sf-font-mono)', fontSize:10, color:TEXT_DIM }}>
          드래그·이동 · 핀클릭·연결 · 선드래그·경로변경 · 더블클릭·값편집
        </span>
        <div style={{ display:'flex', gap:2 }}>
          {[['−', -0.15], ['+', 0.15], ['⌂', 0]].map(([lbl, d]) => (
            <button key={lbl} onClick={() => {
              if (d===0) { setZoom(1); setPan({x:0,y:0}) }
              else setZoom(z => Math.min(4, Math.max(0.25, z+d)))
            }} style={{
              padding:'3px 8px', border:'1px solid #1c2030', borderRadius:4,
              background:'transparent', color:'#5a6278', cursor:'pointer',
              fontFamily:'var(--sf-font-mono)', fontSize:12,
            }}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* deletion toast */}
      {toast && (
        <div style={{
          position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)',
          zIndex:50, display:'flex', alignItems:'center', gap:10,
          background:'#151821', border:'1px solid #2a3040',
          borderRadius:8, padding:'8px 14px',
          fontFamily:'var(--sf-font-mono)', fontSize:11, color:'#8090b0',
          boxShadow:'0 4px 20px rgba(0,0,0,0.5)',
          animation:'fadeIn 0.15s ease',
        }}>
          <span>{toast.msg}</span>
          <button onClick={undoNetDelete} style={{
            padding:'2px 8px', borderRadius:4, border:'1px solid #2a1a4a',
            background:'transparent', color:'#a78bfa', cursor:'pointer', fontSize:10,
          }}>↩ 되돌리기</button>
          <button onClick={() => setToast(null)} style={{
            background:'none', border:'none', color:'#3a4055', cursor:'pointer', fontSize:14, lineHeight:1,
          }}>×</button>
        </div>
      )}

      {/* canvas */}
      <div ref={containerRef} style={{ flex:1, overflow:'hidden', position:'relative' }}
           onKeyDown={e => { if (e.key==='Escape') setWireState(null) }}
           tabIndex={-1}
      >
        <svg
          ref={svgRef}
          width="100%" height="100%"
          style={{
            display:'block', userSelect:'none', touchAction:'none',
            cursor: (wireState || reconnectState) ? 'crosshair' : (panDragRef.current ? 'grabbing' : 'default'),
          }}
          onPointerMove={onSvgPointerMove}
          onPointerDown={onSvgPointerDown}
          onPointerUp={onSvgPointerUp}
          onContextMenu={e => e.preventDefault()}
          onClick={e => {
            if (didPanRef.current) { didPanRef.current = false; return }
            if (!e.target.closest?.('g[data-comp]') && !e.target.closest?.('g[data-net]')) {
              setSelected(null)
              setSelectedNet(null)
              if (wireState) setWireState(null)
            }
          }}
        >
          <defs>
            <pattern id="flux-dot" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="0" cy="0" r="0.8" fill={GRID_DOT} />
              <circle cx="24" cy="0" r="0.8" fill={GRID_DOT} />
              <circle cx="0" cy="24" r="0.8" fill={GRID_DOT} />
              <circle cx="24" cy="24" r="0.8" fill={GRID_DOT} />
            </pattern>
          </defs>

          {/* background */}
          <rect width="100%" height="100%" fill={BG} />
          <rect width="100%" height="100%" fill="url(#flux-dot)" />

          {/* viewport transform */}
          <g transform={`scale(${zoom}) translate(${pan.x},${pan.y})`}>

            {/* ── Nets ─────────────────────────────────── */}
            {effectiveNets.map((net, ni) => {
              const isPwr = isPowerNet(net.name)
              const color = isPwr
                ? (/GND|EARTH|VSS|VEE/i.test(net.name) ? '#4a7a6a' : '#f08080')
                : NET_COLORS[ni % NET_COLORS.length]
              const pts = net.nodes
                .map(n => pinAbsPos(n.ref, n.pin, positions, layouts))
                .filter(Boolean)
              if (!pts.length) return null
              const isHov = hoveredNet===ni
              const isSel = selectedNet===ni

              // Power nets: draw a symbol at each pin, no wires
              if (isPwr) {
                return (
                  <g key={`net-${ni}`} data-net={ni}
                     onPointerEnter={() => setHoveredNet(ni)}
                     onPointerLeave={() => setHoveredNet(prev=>prev===ni?null:prev)}
                     onClick={e => onNetClick(e, ni)}
                     style={{ cursor:'pointer' }}>
                    {pts.map((pt, pi) => (
                      <g key={pi} opacity={isSel||isHov ? 1 : 0.75}>
                        {isSel && <circle cx={pt.x} cy={pt.y} r="10" fill={color} fillOpacity="0.15" />}
                        <PowerSymbol x={pt.x} y={pt.y} name={net.name} color={color} />
                      </g>
                    ))}
                  </g>
                )
              }

              const mstEdges = buildMST(pts)

              return (
                <g key={`net-${ni}`}
                   data-net={ni}
                   onPointerEnter={() => setHoveredNet(ni)}
                   onPointerLeave={() => setHoveredNet(prev=>prev===ni?null:prev)}
                   onClick={e => onNetClick(e, ni)}
                   style={{ cursor:'pointer' }}>
                  {/* selection glow */}
                  {isSel && mstEdges.map(([ai, bi], i) => {
                    const a=pts[ai], b=pts[bi]
                    const bend = wireBends[`${ni}_${i}`]
                    const mx = bend?.mx ?? a.x+(b.x-a.x)*0.5
                    const my = bend?.my
                    return (
                      <path key={`glow-${i}`} d={routeWire(a.x,a.y,b.x,b.y,mx,my)}
                            fill="none" stroke={color} strokeWidth="8" strokeOpacity="0.18"
                            pointerEvents="none" />
                    )
                  })}
                  {/* MST wire segments */}
                  {mstEdges.map(([ai, bi], i) => {
                    const a=pts[ai], b=pts[bi]
                    const bend = wireBends[`${ni}_${i}`]
                    const defaultMx = a.x+(b.x-a.x)*0.5
                    const mx = bend?.mx ?? defaultMx
                    const my = bend?.my
                    const isDraggingThis = wireDrag?.netIdx===ni && wireDrag?.segIdx===i
                    return (
                      <g key={i}>
                        <path d={routeWire(a.x,a.y,b.x,b.y,mx,my)} fill="none"
                              stroke="transparent" strokeWidth="16" style={{ cursor:'move' }}
                              onPointerDown={e => onWireDragStart(e, ni, i, mx, my ?? b.y)} />
                        <path d={routeWire(a.x,a.y,b.x,b.y,mx,my)} fill="none"
                              stroke={color}
                              strokeWidth={isSel||isDraggingThis ? 2.5 : isHov ? 2.2 : 1.4}
                              strokeOpacity={isSel||isDraggingThis ? 1 : isHov ? 1 : 0.65}
                              pointerEvents="none" />
                        <circle cx={mx} cy={my ?? a.y} r={isSel||isDraggingThis ? 4 : 2.5}
                                fill={color} fillOpacity={isSel||isHov?1:0.6} pointerEvents="none" />
                      </g>
                    )
                  })}
                  {/* net label */}
                  {(isHov || isSel) && mstEdges.length>0 && (() => {
                    const [ai, bi] = mstEdges[0]
                    const a=pts[ai], b=pts[bi]
                    const mx = (wireBends[`${ni}_0`]?.mx) ?? (a.x+b.x)/2
                    const my = Math.min(a.y,b.y)-12
                    return (
                      <g pointerEvents="none">
                        <rect x={mx-28} y={my-12} width={56} height={16} rx="3"
                              fill="rgba(8,10,16,0.85)" stroke={color} strokeWidth="0.8" strokeOpacity="0.6" />
                        <text x={mx} y={my} textAnchor="middle" fill={color}
                              fontSize="9" fontFamily="'IBM Plex Mono',monospace" fontWeight="700">
                          {net.name}
                        </text>
                      </g>
                    )
                  })()}
                </g>
              )
            })}

            {/* ── Endpoint handles for selected net ───── */}
            {selectedNet !== null && !reconnectState && effectiveNets[selectedNet]?.nodes.map((nd, nodeIdx) => {
              const pt = pinAbsPos(nd.ref, nd.pin, positions, layouts)
              if (!pt) return null
              const netColor = NET_COLORS[selectedNet % NET_COLORS.length]
              return (
                <g key={`ep-${nodeIdx}`}
                   onPointerDown={e => onEndpointPointerDown(e, selectedNet, nodeIdx)}
                   style={{ cursor: 'crosshair' }}>
                  <circle cx={pt.x} cy={pt.y} r="14" fill="transparent" />
                  <circle cx={pt.x} cy={pt.y} r="6" fill={netColor}
                          stroke="#080a10" strokeWidth="2"
                          style={{ filter: `drop-shadow(0 0 5px ${netColor})` }} />
                  <text x={pt.x + 10} y={pt.y - 6} fontSize="8.5" fill={netColor}
                        fontFamily="'IBM Plex Mono',monospace" pointerEvents="none"
                        style={{ userSelect: 'none' }}>
                    {nd.ref}[{nd.pin}]
                  </text>
                </g>
              )
            })}

            {/* ── Reconnect drag preview ───────────────── */}
            {reconnectState && (() => {
              const net = effectiveNets[reconnectState.netIdx]
              if (!net) return null
              const fixedNodeIdx = net.nodes.findIndex((_, i) => i !== reconnectState.nodeIdx)
              const fixedNode = fixedNodeIdx >= 0 ? net.nodes[fixedNodeIdx] : null
              const fixedPt = fixedNode ? pinAbsPos(fixedNode.ref, fixedNode.pin, positions, layouts) : null
              const nearest = findNearestPin(cursor.x, cursor.y)
              const snapPt = nearest ? pinAbsPos(nearest.ref, nearest.pin, positions, layouts) : null
              const targetPt = snapPt || cursor
              return (
                <g pointerEvents="none">
                  {fixedPt && (
                    <path d={routeWire(fixedPt.x, fixedPt.y, targetPt.x, targetPt.y)}
                          fill="none" stroke={WIRE_PREVIEW} strokeWidth="2"
                          strokeDasharray="8 4" />
                  )}
                  {snapPt && (
                    <circle cx={snapPt.x} cy={snapPt.y} r="10" fill="none"
                            stroke={PIN_ACTIVE} strokeWidth="2" strokeDasharray="3 2" opacity="0.8" />
                  )}
                  <circle cx={targetPt.x} cy={targetPt.y} r="5"
                          fill={PIN_ACTIVE} opacity="0.9" />
                </g>
              )
            })()}

            {/* ── Wire preview ────────────────────────── */}
            {wireState && wireFromPt && (
              <g pointerEvents="none">
                <path d={routeWire(wireFromPt.x, wireFromPt.y, cursor.x, cursor.y)}
                      fill="none" stroke={WIRE_PREVIEW} strokeWidth="1.8"
                      strokeDasharray="6 4" />
                <circle cx={wireFromPt.x} cy={wireFromPt.y} r="4"
                        fill={PIN_ACTIVE} opacity="0.9" />
                <circle cx={cursor.x} cy={cursor.y} r="4"
                        fill={PIN_ACTIVE} opacity="0.5" />
              </g>
            )}

            {/* ── Components ──────────────────────────── */}
            {comps.map((c, idx) => {
              const p = positions[c.ref]
              const l = layouts[c.ref]
              if (!p || !l) return null
              const color = compColor(c.ref)
              const isSel = selected===c.ref
              const isDim = connectedRefs && !connectedRefs.has(c.ref)
              const val = edits[c.ref]?.value ?? c.value ?? ''
              const typeLabel = COMP_TYPE_LABELS[c.ref[0]?.toUpperCase()] || c.ref[0]?.toUpperCase()
              const diffAdded    = graphDiff?.added?.has(c.ref)
              const diffModified = graphDiff?.modified?.has(c.ref)

              return (
                <g key={c.ref}
                   data-comp={c.ref}
                   transform={`translate(${p.x},${p.y})`}
                   opacity={isDim ? 0.2 : 1}
                   onPointerDown={e => onCompPointerDown(e, c.ref)}
                   onDoubleClick={e => { e.stopPropagation(); startEdit(c.ref, val) }}
                   onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}
                   style={{ cursor: wireState ? 'crosshair' : 'grab', touchAction:'none' }}
                >
                  {/* pin stubs + clickable pin dots */}
                  {Object.entries(l.pins).map(([pinNum, pin]) => {
                    const STUB=14
                    let x1=0,y1=0, ex=0,ey=0
                    if (pin.side==='L') { x1=-l.w/2; y1=pin.y; ex=-l.w/2-STUB; ey=pin.y }
                    else if (pin.side==='R') { x1=l.w/2; y1=pin.y; ex=l.w/2+STUB; ey=pin.y }
                    else if (pin.side==='T') { x1=pin.x; y1=-l.h/2; ex=pin.x; ey=-l.h/2-STUB }
                    else { x1=pin.x; y1=l.h/2; ex=pin.x; ey=l.h/2+STUB }

                    const isHovPin = hoveredPin?.ref===c.ref && String(hoveredPin?.pin)===String(pinNum)
                    const isFromPin = wireState?.fromRef===c.ref && String(wireState?.fromPin)===String(pinNum)
                    const pinColor = isFromPin ? PIN_ACTIVE : isHovPin ? PIN_HOVER : PIN_IDLE

                    return (
                      <g key={pinNum}
                         onPointerEnter={() => setHoveredPin({ ref:c.ref, pin:pinNum })}
                         onPointerLeave={() => setHoveredPin(null)}
                         onPointerDown={e => onPinPointerDown(e, c.ref, pinNum)}
                         style={{ cursor:'crosshair' }}
                      >
                        <line x1={x1} y1={y1} x2={ex} y2={ey}
                              stroke={pinColor} strokeWidth="1.5" />
                        {/* large invisible hit area */}
                        <circle cx={ex} cy={ey} r="8" fill="transparent" />
                        {/* visible pin dot */}
                        <circle cx={ex} cy={ey} r={isHovPin||isFromPin ? 4 : 2.5}
                                fill={pinColor}
                                style={{ transition:'r 0.1s' }} />
                      </g>
                    )
                  })}

                  {/* diff glow */}
                  {(diffAdded || diffModified) && (
                    <rect x={-l.w/2-4} y={-l.h/2-4} width={l.w+8} height={l.h+8} rx="9"
                          fill="none"
                          stroke={diffAdded ? '#34d3a0' : '#f59e0b'}
                          strokeWidth="2"
                          strokeOpacity="0.8"
                          style={{ filter: `drop-shadow(0 0 6px ${diffAdded ? '#34d3a0' : '#f59e0b'})` }}
                    />
                  )}

                  {/* component body */}
                  <rect x={-l.w/2} y={-l.h/2} width={l.w} height={l.h} rx="6"
                        fill={diffAdded ? '#0d2018' : diffModified ? '#1a1506' : COMP_FILL}
                        stroke={isSel ? color : diffAdded ? '#34d3a0' : diffModified ? '#f59e0b' : COMP_BORDER}
                        strokeWidth={isSel || diffAdded || diffModified ? 1.5 : 1}
                        style={{ filter: isSel ? `drop-shadow(0 0 8px ${color}66)` : 'none' }}
                  />

                  {/* index number — flux style */}
                  <text x={-l.w/2+7} y={-l.h/2+13}
                        fill={color} fontSize="9"
                        fontFamily="'IBM Plex Mono',monospace" fontWeight="700"
                        pointerEvents="none" opacity="0.7">
                    {idx+1}
                  </text>

                  {/* ref */}
                  <text x={0} y={-5}
                        textAnchor="middle" fill={TEXT_LABEL}
                        fontSize="12" fontWeight="700"
                        fontFamily="'IBM Plex Mono',monospace"
                        pointerEvents="none">
                    {c.ref}
                  </text>

                  {/* value — inline editable */}
                  {editingRef===c.ref ? (
                    <foreignObject x={-l.w/2+4} y={6} width={l.w-8} height={22}>
                      <input
                        style={{
                          width:'100%', height:22, background:'#1c2030', border:'1px solid '+color,
                          borderRadius:3, color:'#fff', fontSize:11,
                          fontFamily:"'IBM Plex Mono',monospace", padding:'0 4px',
                          outline:'none',
                        }}
                        value={editingValue}
                        autoFocus
                        onChange={e => setEditingValue(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={e => { if (e.key==='Enter') commitEdit(); if (e.key==='Escape') setEditingRef(null) }}
                        onClick={e => e.stopPropagation()}
                      />
                    </foreignObject>
                  ) : (
                    <text x={0} y={l.h/2-8}
                          textAnchor="middle" fill={TEXT_VALUE}
                          fontSize="10" fontFamily="'IBM Plex Mono',monospace"
                          pointerEvents="none">
                      {val}
                    </text>
                  )}

                  {/* type label for larger components */}
                  {l.h >= 60 && (
                    <text x={0} y={8}
                          textAnchor="middle" fill={TEXT_DIM}
                          fontSize="9" fontFamily="'Space Grotesk',sans-serif"
                          pointerEvents="none">
                      {typeLabel}
                    </text>
                  )}
                </g>
              )
            })}

          </g>{/* end viewport transform */}
        </svg>

        {/* ESC hint when drawing wire */}
        {wireState && (
          <div style={{
            position:'absolute', bottom:12, left:'50%', transform:'translateX(-50%)',
            padding:'6px 14px', borderRadius:20,
            background:'rgba(245,158,11,0.12)', border:'1px solid rgba(245,158,11,0.3)',
            fontFamily:'var(--sf-font-mono)', fontSize:11, color:'#f59e0b',
            pointerEvents:'none',
          }}>
            연결할 핀을 클릭하세요 · ESC로 취소
          </div>
        )}

      </div>

      {/* ── Net legend ──────────────────────────────────────── */}
      <div style={{
        padding:'8px 14px', borderTop:'1px solid #151821',
        background:'#0b0d14', flexShrink:0,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
          <span style={{ fontFamily:'var(--sf-font-mono)', fontSize:9, color:TEXT_DIM, letterSpacing:'0.14em', marginRight:4 }}>NETS</span>
          {effectiveNets.map((net, ni) => {
            const isPwr = net.name==='VCC'||net.name==='GND'||net.name==='PWR'
            const color = isPwr
              ? (net.name==='GND' ? '#4a5568' : '#f87171')
              : NET_COLORS[ni % NET_COLORS.length]
            return (
              <div key={ni}
                   onPointerEnter={() => setHoveredNet(ni)}
                   onPointerLeave={() => setHoveredNet(null)}
                   style={{
                     display:'flex', alignItems:'center', gap:5,
                     padding:'3px 8px', borderRadius:4, cursor:'pointer',
                     background: hoveredNet===ni ? '#151821' : 'transparent',
                   }}>
                <span style={{ width:16, height:2, background:color, borderRadius:1, flexShrink:0, display:'block' }} />
                <span style={{ fontFamily:'var(--sf-font-mono)', fontSize:10, color: hoveredNet===ni ? color : '#3a4055', fontWeight:'600' }}>
                  {net.name}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Properties panel (selected comp) ────────────────── */}
      {selectedComp && (
        <div style={{
          position:'absolute', right:0, top:36,
          width:240, bottom:0,
          background:'#0c0e16', borderLeft:'1px solid #151821',
          display:'flex', flexDirection:'column',
          fontFamily:'var(--sf-font-mono)',
        }}>
          <div style={{ padding:'12px 14px', borderBottom:'1px solid #151821', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div>
              <div style={{ fontSize:9, color:TEXT_DIM, letterSpacing:'0.14em', marginBottom:4 }}>PROPERTIES</div>
              <div style={{ fontSize:20, color:compColor(selectedComp.ref), fontWeight:700 }}>{selectedComp.ref}</div>
            </div>
            <button onClick={() => setSelected(null)} style={{ background:'none', border:'none', color:TEXT_DIM, fontSize:18, cursor:'pointer' }}>×</button>
          </div>
          <div style={{ padding:'12px 14px', flex:1, overflowY:'auto' }}>
            <PropRow label="Value">
              <input value={edits[selectedComp.ref]?.value ?? selectedComp.value ?? ''}
                     onChange={e => setEdits(es => ({ ...es, [selectedComp.ref]: { value: e.target.value } }))}
                     style={{
                       width:'100%', boxSizing:'border-box', padding:'5px 8px', height:30,
                       background:'#151821', border:'1px solid #1c2030', borderRadius:4,
                       color:'#c8cfe8', fontSize:12, outline:'none',
                       fontFamily:"'IBM Plex Mono',monospace",
                     }} />
            </PropRow>
            <PropRow label="Type">
              <span style={{ fontSize:11, color:'#5a6278' }}>
                {COMP_TYPE_LABELS[selectedComp.ref[0]?.toUpperCase()] || selectedComp.ref[0]}
              </span>
            </PropRow>
            <PropRow label="Nets">
              <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                {effectiveNets.filter(n => n.nodes.some(nd => nd.ref===selectedComp.ref)).map(n => (
                  <span key={n.name} style={{ fontSize:10, color:'#34d3a0', padding:'3px 6px', background:'#0f1520', borderRadius:3 }}>{n.name}</span>
                ))}
              </div>
            </PropRow>
          </div>
        </div>
      )}
    </div>
  )
}

function PropRow({ label, children }) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:9, color:'#2e3a50', letterSpacing:'0.1em', marginBottom:5 }}>{label.toUpperCase()}</div>
      {children}
    </div>
  )
}
