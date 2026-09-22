import React, { useEffect, useMemo, useRef, useState, Dispatch, SetStateAction } from 'react'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import { addFavorite, removeFavorite, authHeaders, type AuthUser } from '../api'
import CircuitCanvas from './CircuitCanvas'
import PCBLayout from './PCBLayout'
import BomTable from './BomTable'
import CodeEditor from './CodeEditor'
import KicadGuide from './KicadGuide'
import TraceField from './TraceField.tsx'
import {
  Button, Input,
  IconCheck, IconCopy, IconDownload, IconWand, IconLayers,
} from './primitives.tsx'
import type {
  GenerateResult, Version, ChatSession, NetGraph, ChatMessage, ChatAction, PcbSummary,
  BoardPart, BoardFrame, BoardModel, RouteEvent, DrcResult, AiRound,
} from '../types'
import BoardView from './BoardView'
import { validateCircuit } from '../lib/circuitValidation'

const API = ''

interface StoredEntry { id: number; name: string; prompt: string; result?: GenerateResult; time: number; messages?: ChatMessage[]; graph?: NetGraph | null }

export function getSavedResults(): StoredEntry[] {
  try { return JSON.parse(localStorage.getItem('sf_saved_results') || '[]') } catch { return [] }
}

function updateSavedResultChat(prompt: string, messages: ChatMessage[], graph: NetGraph | null) {
  const saved = getSavedResults()
  const idx = saved.findIndex(s => s.prompt === prompt)
  if (idx < 0) return
  saved[idx] = { ...saved[idx], messages, graph: graph || saved[idx].graph }
  localStorage.setItem('sf_saved_results', JSON.stringify(saved))
}

export function deleteSavedResult(id: number) {
  const saved = getSavedResults().filter(s => s.id !== id)
  localStorage.setItem('sf_saved_results', JSON.stringify(saved))
  return saved
}

export function saveResultToLocal(result: GenerateResult, prompt: string) {
  const saved = getSavedResults()
  const existing = saved.findIndex(s => s.prompt === prompt)
  if (existing >= 0) saved.splice(existing, 1)
  const entry = { id: Date.now(), name: prompt.slice(0, 40), prompt, result, time: Date.now() }
  saved.unshift(entry)
  while (saved.length > 30) saved.pop()
  localStorage.setItem('sf_saved_results', JSON.stringify(saved))
  return saved
}

interface ResultPanelProps {
  result: GenerateResult
  setResult: Dispatch<SetStateAction<GenerateResult | null>>
  theme?: string
  onRegenerate: (p: string, typeKey?: string) => void
  lastPrompt: string
  versions?: Version[]
  currentVersionId?: string | null
  onSelectVersion?: (id: string) => void
  onApplyVersion?: () => void
  initialChatSession?: ChatSession | null
  authUser?: AuthUser | null
  sessionId?: string | null
}

export default function ResultPanel({
  result, setResult, theme, onRegenerate, lastPrompt,
  versions = [], currentVersionId = null, onSelectVersion, onApplyVersion,
  initialChatSession = null, authUser = null, sessionId = null,
}: ResultPanelProps) {
  const resultRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const [pcbStatus, setPcbStatus] = useState<string | null>(null)
  const [pcbFilename, setPcbFilename] = useState<string | null>(null)
  const [pcbStyle, setPcbStyle] = useState<'smd' | 'tht'>('smd')
  const [useAi, setUseAi] = useState(false)
  const [pcbSummary, setPcbSummary] = useState<PcbSummary | null>(null)
  const [board, setBoard] = useState<{
    parts: BoardPart[]; frames: BoardFrame[]; routes: RouteEvent[]; target: [number, number, number, number] | null
    final: BoardModel | null; drc: DrcResult | null; ai: AiRound[]; status: 'streaming' | 'done' | 'error'
  } | null>(null)
  const [gerberStatus, setGerberStatus] = useState<string | null>(null)
  const [gerberInfo, setGerberInfo] = useState<{ dir: string; files?: string[] } | null>(null)
  const [activeTab, setActiveTab] = useState('Netlist')
  const [iterateText, setIterateText] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = usePanelState('sf_panel_right')
  const [editorOpen, setEditorOpen] = usePanelState('sf_panel_left')
  const [viewMode, setViewMode] = useState('schematic')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => initialChatSession?.messages || [])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [localGraph, setLocalGraph] = useState<NetGraph | null>(() => initialChatSession?.graph || null)
  const [isFavorited, setIsFavorited] = useState(false)
  const [favId, setFavId] = useState<string | null>(null)
  const [favLoading, setFavLoading] = useState(false)
  const [graphHistory, setGraphHistory] = useState<NetGraph[]>([])
  const [graphDiff, setGraphDiff] = useState<{ added: Set<string>; removed: Set<string>; modified: Set<string> } | null>(null)

  const effectiveGraph = localGraph || result?.graph
  const circuitIssues = useMemo(() => validateCircuit(effectiveGraph), [effectiveGraph])
  const circuitErrors = circuitIssues.filter(issue => issue.severity === 'error')
  const invalidRefs = useMemo(() => new Set(circuitIssues.flatMap(issue => issue.refs)), [circuitIssues])

  function computeDiff(before: NetGraph | null, after: NetGraph | null) {
    const beforeRefs = new Set((before?.components || []).map((c: { ref: string }) => c.ref))
    const afterRefs  = new Set((after?.components  || []).map((c: { ref: string }) => c.ref))
    const added    = new Set([...afterRefs].filter(r => !beforeRefs.has(r)))
    const removed  = new Set([...beforeRefs].filter(r => !afterRefs.has(r)))
    const modified = new Set((after?.components || []).filter((c: { ref: string; value?: string; name?: string }) => {
      const old = (before?.components || []).find((o: { ref: string }) => o.ref === c.ref)
      return old && (old.value !== c.value || old.name !== c.name)
    }).map((c: { ref: string }) => c.ref))
    return { added, removed, modified }
  }

  function pushGraphHistory(g: NetGraph) {
    setGraphHistory(prev => [...prev.slice(-19), g])
  }

  function undoGraph() {
    setGraphHistory(prev => {
      if (!prev.length) return prev
      const next = [...prev]
      const restored = next.pop()
      setLocalGraph(restored ?? null)
      return next
    })
  }

  // Streams placement and routing (/generate_pcb_stream): parts → init → frame… → route/rip… → done.
  async function generatePCB() {
    if (circuitErrors.length) {
      setPcbStatus('invalid')
      setViewMode('schematic')
      return
    }
    // AI-edited graph: the server writes a netlist from it; otherwise use the generated one
    const body = localGraph
      ? { graph: localGraph, baseName: result?.filename?.replace('.net', '') || 'circuit', style: pcbStyle, ai: useAi }
      : result?.filename ? { filename: result.filename, style: pcbStyle, ai: useAi } : null
    if (!body) { setPcbStatus('error'); return }

    setPcbStatus('loading')
    // Below ~1280 px the two side panels leave the 2D + 3D board view too narrow to read.
    if (window.innerWidth < 1280) { setEditorOpen(false); setSidebarOpen(false) }
    setBoard({ parts: [], frames: [], routes: [], target: null, final: null, drc: null, ai: [], status: 'streaming' })
    setGerberStatus(null)
    setGerberInfo(null)
    setViewMode('pcb')
    try {
      const res = await fetch(`${API}/generate_pcb_stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let done = false
      while (!done) {
        const chunk = await reader.read()
        if (chunk.done) break
        buf += decoder.decode(chunk.value, { stream: true })
        const blocks = buf.split('\n\n')
        buf = blocks.pop() ?? ''
        for (const block of blocks) {
          const ev = /^event: (\w+)/m.exec(block)?.[1]
          const raw = /^data: (.*)$/m.exec(block)?.[1]
          if (!ev || !raw) continue
          const data = JSON.parse(raw)
          if (ev === 'parts') setBoard(b => b && { ...b, parts: data.parts })
          else if (ev === 'init') setBoard(b => b && { ...b, target: data.frame })
          else if (ev === 'frame') setBoard(b => b && { ...b, frames: [...b.frames, data] })
          else if (ev === 'route' || ev === 'rip') setBoard(b => b && { ...b, routes: [...b.routes, data] })
          else if (ev === 'drc') setBoard(b => b && { ...b, drc: data })
          else if (ev === 'ai') setBoard(b => b && { ...b, ai: [...b.ai, data] })
          else if (ev === 'done') {
            setBoard(b => b && { ...b, final: data.board, status: 'done' })
            setPcbFilename(data.pcbFilename)
            setPcbSummary(data.summary || null)
            setPcbStatus('done')
            done = true
          } else if (ev === 'error') throw new Error(data.error)
        }
      }
      if (!done) throw new Error('stream ended without a result')
    } catch (e) {
      setBoard(b => b && { ...b, status: 'error' })
      setPcbStatus('error')
      console.error('PCB generation failed:', e)
    }
  }

  async function generateGerber() {
    if (!pcbFilename) return
    setGerberStatus('loading')
    try {
      const res = await fetch(`${API}/generate_gerber`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ pcbFilename }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setGerberInfo({ dir: data.gerberDir as string, files: data.files || [] })
      setGerberStatus('done')
    } catch (e) {
      setGerberStatus('error')
      console.error('Gerber generation failed:', e)
    }
  }

  function handleCopyPrompt() {
    navigator.clipboard.writeText(lastPrompt || '')
    alert('프롬프트 복사 완료')
  }

  function handleIterate() {
    if (!iterateText.trim()) return
    onRegenerate(`${lastPrompt}\n[수정 요청]: ${iterateText.trim()}`)
    setIterateText('')
  }

  async function sendChat() {
    const msg = chatInput.trim()
    if (!msg || chatLoading) return
    setChatInput('')
    const userMsg: ChatMessage = { role: 'user', content: msg }
    // Add user msg + empty streaming assistant bubble
    setChatMessages(prev => [...prev, userMsg, { role: 'assistant' as const, content: '', _streaming: true, actions: [] }])
    setChatLoading(true)

    try {
      const history = chatMessages.map(m => ({ role: m.role, content: m.content }))
      const res = await fetch(`${API}/chat_edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ graph: effectiveGraph, message: msg, history }),
      })

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let streamedText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''

        for (const part of parts) {
          const evtM = part.match(/^event: (.+)$/m)
          const dataM = part.match(/^data: ([\s\S]+)$/m)
          if (!evtM || !dataM) continue
          const evt = evtM[1].trim()
          const raw = dataM[1].trim()

          if (evt === 'text') {
            streamedText += JSON.parse(raw)
            setChatMessages(prev => {
              const next = [...prev]
              next[next.length - 1] = { role: 'assistant' as const, content: streamedText, _streaming: true, actions: [] }
              return next
            })
            setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 10)
          } else if (evt === 'done') {
            const { reply, actions } = JSON.parse(raw)
            const snapshot = effectiveGraph ?? null
            let newGraph: NetGraph | null = snapshot
            if (actions?.length && snapshot) {
              pushGraphHistory(snapshot)
              newGraph = applyActions(snapshot, actions) as NetGraph | null
              const diff = computeDiff(snapshot, newGraph)
              setGraphDiff(diff)
              // Let removed parts flash before they disappear, then show diagnostics.
              if (diff.removed.size) setTimeout(() => setLocalGraph(newGraph), 550)
              else setLocalGraph(newGraph)
              setTimeout(() => setGraphDiff(null), 3000)
            }
            const assistantMsg: ChatMessage = { role: 'assistant', content: reply as string, actions: actions || [] }
            setChatMessages(prev => {
              const next = [...prev.slice(0, -1), assistantMsg]
              updateSavedResultChat(lastPrompt, next, newGraph)
              return next
            })
          } else if (evt === 'error') {
            const { message } = JSON.parse(raw)
            setChatMessages(prev => [...prev.slice(0, -1), { role: 'assistant' as const, content: `오류: ${message as string}`, actions: [] }])
          }
        }
      }
    } catch (e) {
      setChatMessages(prev => [...prev.slice(0, -1), { role: 'assistant' as const, content: `오류: ${(e as Error).message}`, actions: [] }])
    }
    setChatLoading(false)
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  async function toggleFavorite() {
    if (!sessionId || favLoading) return
    setFavLoading(true)
    try {
      if (isFavorited && favId) {
        await removeFavorite(favId)
        setIsFavorited(false)
        setFavId(null)
      } else {
        const id = await addFavorite(sessionId)
        setIsFavorited(true)
        setFavId(id)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setFavLoading(false)
    }
  }

  async function exportPDF() {
    if (!resultRef.current) return
    const el = resultRef.current
    const canvas = await html2canvas(el, { backgroundColor: '#f1ece0', scale: 2 })
    const imgData = canvas.toDataURL('image/png')
    const pdf = new jsPDF('p', 'mm', 'a4')
    const w = pdf.internal.pageSize.getWidth()
    const h = (canvas.height * w) / canvas.width
    let yOff = 0
    const pageH = pdf.internal.pageSize.getHeight()
    while (yOff < h) {
      if (yOff > 0) pdf.addPage()
      pdf.addImage(imgData, 'PNG', 0, -yOff, w, h)
      yOff += pageH
    }
    pdf.save('SchemaForge_회로.pdf')
  }

  if (!result) return null

  const components = effectiveGraph?.components || []
  const nets = effectiveGraph?.nets || []
  const bom = components.map(c => ({ ref: c.ref, part: c.name || c.ref, val: c.value || '' }))
  const spec = [
    ['Parts', String(components.length)],
    ['Nets', String(nets.length)],
    ['Filename', result.filename || '—'],
  ]
  const title = (lastPrompt || 'Generated Circuit').slice(0, 60)

  const TOPBAR_H = 44
  const DRAWER_H = drawerOpen ? 280 : 0
  const BOTTOMBAR_H = 38

  return (
    <div ref={resultRef} style={{
      position: 'fixed', inset: 0, top: 58,
      display: 'flex', flexDirection: 'column',
      background: 'var(--sf-bg)',
      zIndex: 10,
    }}>

      {/* ── Top bar ─────────────────────────────────────────── */}
      <div style={{
        height: TOPBAR_H, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 16px',
        background: 'var(--sf-bg-1)',
        borderBottom: '1px solid var(--sf-line-strong)',
      }}>
        <span style={{
          fontFamily: 'var(--sf-font-mono)', fontSize: 12,
          color: 'var(--sf-fg)', fontWeight: 600,
          maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        <span style={{
          fontFamily: 'var(--sf-font-mono)', fontSize: 10,
          color: 'var(--sf-fg-dim)', letterSpacing: '0.04em',
        }}>{result.filename}</span>

        {/* version strip (compact) */}
        {versions.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
            {versions.map((v, i) => {
              const active = v.id === currentVersionId
              return (
                <button key={v.id} onClick={() => onSelectVersion?.(v.id)} style={{
                  padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--sf-font-mono)', fontSize: 10, fontWeight: active ? 700 : 400,
                  background: active ? 'var(--sf-amber)' : 'var(--sf-bg-3)',
                  color: active ? 'var(--sf-fg-inverse)' : 'var(--sf-fg-dim)',
                }}>v{i + 1}</button>
              )
            })}
            {(() => {
              const curIdx = versions.findIndex(v => v.id === currentVersionId)
              return curIdx >= 0 && curIdx < versions.length - 1 ? (
                <button onClick={onApplyVersion} style={{
                  padding: '2px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--sf-font-mono)', fontSize: 10, fontWeight: 700,
                  background: 'var(--sf-cyan-soft)', color: 'var(--sf-cyan)',
                }}>Apply</button>
              ) : null
            })()}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* actions */}
        {authUser && sessionId && (
          <button
            onClick={toggleFavorite}
            disabled={favLoading}
            title={isFavorited ? '즐겨찾기 해제' : '즐겨찾기 추가'}
            style={{
              ...iconBtn,
              color: isFavorited ? '#c87515' : undefined,
              opacity: favLoading ? 0.5 : 1,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill={isFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
              <path d="M4 2h8a1 1 0 0 1 1 1v10.5l-5-3-5 3V3a1 1 0 0 1 1-1z"/>
            </svg>
          </button>
        )}
        <button onClick={handleCopyPrompt} title="프롬프트 복사" style={iconBtn}><IconCopy size={14} /></button>
        <button onClick={() => onRegenerate(lastPrompt)} title="재생성" style={{...iconBtn, fontSize:16}}>↺</button>
        <button onClick={exportPDF} title="PDF" style={{...iconBtn, fontSize:11, letterSpacing:'0.04em', padding:'5px 10px'}}>PDF</button>
        <button
          onClick={() => window.location.href = `${API}/download/${result.filename}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: 'var(--sf-amber)', color: 'var(--sf-fg-inverse)',
            fontFamily: 'var(--sf-font-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          }}
        ><IconDownload size={13} /> .net</button>
        <div style={{ width: 1, height: 20, background: 'var(--sf-line)', margin: '0 4px' }} />
        <button onClick={() => setEditorOpen(o => !o)} data-testid="toggle-left-panel" aria-pressed={editorOpen}
          title={editorOpen ? 'AI 편집 패널 접기' : 'AI 편집 패널 펼치기'} style={{...iconBtn, opacity: editorOpen ? 1 : 0.5}}>
          <PanelIcon side="left" />
        </button>
        <button onClick={() => setSidebarOpen(o => !o)} data-testid="toggle-right-panel" aria-pressed={sidebarOpen}
          title={sidebarOpen ? '사양·BOM 패널 접기' : '사양·BOM 패널 펼치기'} style={{...iconBtn, opacity: sidebarOpen ? 1 : 0.5}}>
          <PanelIcon side="right" />
        </button>
      </div>

      {/* ── Canvas area + sidebars ───────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* LEFT — Chat AI editor (collapses to a rail; state kept so the chat is not lost) */}
        {!editorOpen && <PanelRail side="left" label="AI 편집" onOpen={() => setEditorOpen(true)} />}
        <div data-testid="left-panel" style={{ width: 260, flexShrink: 0, borderRight: '1px solid var(--sf-line-strong)', background: 'var(--sf-bg-1)', display: editorOpen ? 'flex' : 'none', flexDirection: 'column' }}>
          {/* Header */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--sf-line)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--sf-violet)' }} />
            <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10, color: 'var(--sf-violet)', letterSpacing: '0.12em', fontWeight: 700 }}>
              AI EDITOR
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
              <button onClick={() => setEditorOpen(false)} title="접기" aria-label="AI 편집 패널 접기" style={collapseBtn}>‹</button>
              {graphHistory.length > 0 && (
                <button onClick={undoGraph} title="마지막 AI 수정 취소" style={{
                  fontSize: 9, fontFamily: 'var(--sf-font-mono)', color: 'var(--sf-violet)',
                  background: 'none', border: '1px solid var(--sf-violet-line)', borderRadius: 4,
                  padding: '2px 6px', cursor: 'pointer',
                }}>↩ 되돌리기</button>
              )}
              {localGraph && (
                <button onClick={() => { setLocalGraph(null); setGraphHistory([]) }} style={{
                  fontSize: 9, fontFamily: 'var(--sf-font-mono)', color: 'var(--sf-fg-faint)',
                  background: 'none', border: 'none', cursor: 'pointer',
                }}>초기화</button>
              )}
            </div>
          </div>

          <>
              {/* ── Chat messages ── */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {chatMessages.length === 0 && (
                  <div style={{ padding: '16px 8px', textAlign: 'center' }}>
                    <p style={{ fontFamily: 'var(--sf-font-sans)', fontSize: 11, color: 'var(--sf-fg-faint)', lineHeight: 1.6, margin: 0 }}>
                      회로를 수정하고 싶은 걸 자유롭게 말해줘.<br/>
                      컴포넌트 추가·삭제·변경이 바로 반영돼.
                    </p>
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {['저항 하나 추가해줘', 'LED 빼줘', 'R1 값을 100k로 바꿔줘'].map(hint => (
                        <button key={hint} onClick={() => { setChatInput(hint) }} style={{
                          padding: '5px 8px', borderRadius: 6, border: '1px solid var(--sf-line)',
                          background: 'transparent', color: 'var(--sf-fg-faint)', cursor: 'pointer',
                          fontFamily: 'var(--sf-font-sans)', fontSize: 10, textAlign: 'left',
                        }}>{hint}</button>
                      ))}
                    </div>
                  </div>
                )}
                {chatMessages.map((m, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 3 }}>
                    <div style={{
                      maxWidth: '90%', padding: '7px 10px', borderRadius: m.role === 'user' ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                      background: m.role === 'user' ? 'var(--sf-cyan-soft)' : 'var(--sf-bg-1)',
                      border: `1px solid ${m.role === 'user' ? 'var(--sf-cyan-line)' : 'var(--sf-line)'}`,
                      fontFamily: 'var(--sf-font-sans)', fontSize: 11, color: m.role === 'user' ? 'var(--sf-cyan)' : 'var(--sf-fg-muted)', lineHeight: 1.5,
                    }}>
                      {m.content || (m._streaming ? '' : '...')}
                      {m._streaming && (
                        <span style={{
                          display: 'inline-block', width: 2, height: 12,
                          background: 'var(--sf-violet)', marginLeft: 2, verticalAlign: 'middle',
                          animation: 'pulse 0.8s ease-in-out infinite',
                        }} />
                      )}
                    </div>
                    {(m.actions?.length ?? 0) > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, maxWidth: '90%' }}>
                        {(m.actions ?? []).filter(a => a?.type).map((a, j) => (
                          <span key={j} style={{
                            padding: '2px 6px', borderRadius: 4, fontSize: 9,
                            fontFamily: 'var(--sf-font-mono)', letterSpacing: '0.06em',
                            background: a.type.startsWith('add') ? 'var(--sf-cyan-soft)' : a.type.startsWith('remove') ? 'rgba(255,106,91,0.10)' : 'var(--sf-bg-1)',
                            color: a.type.startsWith('add') ? 'var(--sf-cyan)' : a.type.startsWith('remove') ? 'var(--sf-danger)' : 'var(--sf-violet)',
                            border: `1px solid ${a.type.startsWith('add') ? 'var(--sf-cyan-line)' : a.type.startsWith('remove') ? 'rgba(255,106,91,0.30)' : 'var(--sf-line)'}`,
                          }}>
                            {a.type === 'add_component' ? `+${a.ref}` : a.type === 'remove_component' ? `−${a.ref}` : a.type === 'modify_component' ? `~${a.ref}` : a.type === 'add_net' ? `+${a.name}` : a.type === 'remove_net' ? `−${a.name}` : a.type}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {chatLoading && !chatMessages.some(m => m._streaming) && (
                  <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                    <div style={{ padding: '7px 10px', borderRadius: '10px 10px 10px 2px', background: 'var(--sf-bg-1)', border: '1px solid var(--sf-line)' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {[0,1,2].map(i => <span key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--sf-violet)', display: 'block', opacity: 0.5, animation: `pulse ${0.9+i*0.15}s ease-in-out infinite` }} />)}
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Input */}
              <div style={{ padding: '8px 10px', borderTop: '1px solid var(--sf-line)', display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                <textarea
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }}
                  placeholder="수정할 내용 입력..."
                  rows={2}
                  style={{
                    flex: 1, resize: 'none', padding: '6px 8px',
                    background: 'var(--sf-bg-1)', border: '1px solid var(--sf-line)', borderRadius: 8,
                    color: 'var(--sf-fg-muted)', fontSize: 11, fontFamily: 'var(--sf-font-sans)', lineHeight: 1.5,
                    outline: 'none',
                  }}
                />
                <button onClick={sendChat} disabled={chatLoading || !chatInput.trim()} style={{
                  padding: '8px 10px', borderRadius: 8, border: 'none', cursor: chatLoading ? 'wait' : 'pointer',
                  background: 'var(--sf-violet)', color: 'var(--sf-fg-inverse)', fontWeight: 700, fontSize: 13,
                  opacity: chatLoading || !chatInput.trim() ? 0.4 : 1,
                }}>↑</button>
              </div>
            </>
        </div>

        {/* Main canvas — single view with tab switcher */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* view tabs */}
          <div style={{ display: 'flex', alignItems: 'stretch', background: 'var(--sf-bg-1)', borderBottom: '2px solid var(--sf-line-strong)', flexShrink: 0 }}>
            {[
              { key: 'schematic', label: 'SCHEMATIC', color: 'var(--sf-cyan)', sub: `${components.length} parts` },
              { key: 'pcb',       label: 'PCB',        color: 'var(--sf-amber-deep)', sub: `${nets.length} nets` },
            ].map(({ key, label, color, sub }) => {
              const active = viewMode === key
              return (
                <button key={key} onClick={() => setViewMode(key)} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 18px', border: 'none', cursor: 'pointer',
                  background: active ? 'var(--sf-bg)' : 'transparent',
                  borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
                  borderRight: '1px solid var(--sf-line)',
                  marginBottom: -1, transition: 'background 0.1s',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, opacity: active ? 1 : 0.3 }} />
                  <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10, letterSpacing: '0.12em', fontWeight: active ? 700 : 500, color: active ? color : 'var(--sf-fg-faint)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 9, color: 'var(--sf-fg-faint)', opacity: active ? 0.8 : 0.5 }}>{sub}</span>
                </button>
              )
            })}
            {/* PCB gen buttons in tab bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 12px', marginLeft: 'auto' }}>
              {pcbStatus !== 'loading' && (['smd', 'tht'] as const).map(s => (
                <button key={s}
                  title={s === 'smd' ? '표면실장 부품 (커넥터·릴레이는 구멍 끼움)' : '전부 구멍 끼움 부품 (손납땜 쉬움)'}
                  onClick={() => { if (s !== pcbStyle) { setPcbStyle(s); if (pcbStatus === 'done') setPcbStatus(null) } }}
                  style={{ ...ghostBtn, padding: '2px 6px', fontFamily: 'var(--sf-font-mono)', fontSize: 10,
                    color: pcbStyle === s ? 'var(--sf-cyan)' : 'var(--sf-fg-faint)', opacity: pcbStyle === s ? 1 : 0.6 }}>
                  {s.toUpperCase()}
                </button>
              ))}
              {pcbStatus === 'done' && pcbSummary && pcbSummary.unmapped.length > 0 && (
                <span title={pcbSummary.unmapped.map(u => `${u.ref} (${u.part || '?'}): ${u.reason}`).join('\n')}
                  style={{ ...ghostBtn, color: 'var(--sf-danger)', cursor: 'help' }}>
                  ⚠ 풋프린트 없는 부품 {pcbSummary.unmapped.length}개: {pcbSummary.unmapped.map(u => u.ref).join(', ')}
                </span>
              )}
              {pcbStatus === 'done' && pcbSummary && pcbSummary.warnings.length > 0 && (
                <span title={pcbSummary.warnings.join('\n')} style={{ ...ghostBtn, color: 'var(--sf-danger)', cursor: 'help' }}>
                  ⚠ 부품 확인 {pcbSummary.warnings.length}건
                </span>
              )}
              {pcbStatus !== 'loading' && (
                <button onClick={() => { setUseAi(v => !v); if (pcbStatus === 'done') setPcbStatus(null) }}
                  title="AI가 배치·선 굵기에서 고칠 점을 제안합니다. 검사 지표가 좋아질 때만 반영해요 (OpenAI 호출 비용이 듭니다)"
                  style={{ ...ghostBtn, padding: '2px 6px', fontFamily: 'var(--sf-font-mono)', fontSize: 10,
                    color: useAi ? 'var(--sf-violet)' : 'var(--sf-fg-faint)', opacity: useAi ? 1 : 0.6 }}>
                  AI 다듬기 {useAi ? 'ON' : 'OFF'}
                </button>
              )}
              {(pcbStatus === null || pcbStatus === 'invalid') && <button onClick={generatePCB} style={{...ghostBtn, color: circuitErrors.length ? 'var(--sf-danger)' : ghostBtn.color}}><IconLayers size={12} /> {circuitErrors.length ? `회로 오류 ${circuitErrors.length}` : 'PCB 생성'}</button>}
              {pcbStatus === 'loading' && <span style={{...ghostBtn, opacity:0.6, cursor:'default'}}>생성중…</span>}
              {pcbStatus === 'done' && pcbFilename && <>
                <button onClick={() => window.location.href = `${API}/download_pcb/${pcbFilename}`} style={ghostBtn}>↓ .kicad_pcb</button>
                {gerberStatus === null && <button onClick={generateGerber} style={ghostBtn}>거버</button>}
                {gerberStatus === 'loading' && <span style={{...ghostBtn, opacity:0.6, cursor:'default'}}>거버…</span>}
                {gerberStatus === 'done' && <span style={{...ghostBtn, color:'var(--sf-cyan)', cursor:'default'}}>✓ 거버</span>}
              </>}
              {pcbStatus === 'error' && <button onClick={generatePCB} style={{...ghostBtn, color:'var(--sf-danger)'}}>재시도</button>}
            </div>
          </div>

          {viewMode === 'pcb' && pcbStatus === 'done' && pcbSummary && pcbSummary.warnings.length > 0 && (
            <div role="alert" style={{ flexShrink: 0, padding: '8px 12px', background: 'var(--sf-bg-2)',
              borderBottom: '1px solid var(--sf-danger)', color: 'var(--sf-danger)', fontSize: 11, lineHeight: 1.5 }}>
              <strong>제작 전 부품·핀 배열 확인 필요</strong>
              {pcbSummary.warnings.map((warning, index) => <div key={index}>{warning}</div>)}
              <div>선택한 실제 부품의 데이터시트와 기판 패드 번호를 대조하세요. DRC 통과만으로 실물 핀 배열은 보증되지 않습니다.</div>
            </div>
          )}

          {/* canvas */}
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            {viewMode === 'schematic'
              ? <CircuitCanvas graph={effectiveGraph} graphDiff={graphDiff} invalidRefs={invalidRefs} />
              : board
                ? <BoardView pcbFilename={pcbFilename ?? undefined}
                    parts={board.parts} frames={board.frames} routes={board.routes} target={board.target}
                    final={board.final} drc={board.drc} ai={board.ai} status={board.status} hpwlShelf={pcbSummary?.hpwl_shelf} />
                : <>
                    <PCBLayout graph={effectiveGraph} />
                    <div style={{ position: 'absolute', left: 12, bottom: 12, padding: '6px 10px', borderRadius: 6,
                      background: 'var(--sf-bg-2)', color: 'var(--sf-fg-dim)', fontSize: 11 }}>
                      간이 보기예요. PCB 생성을 누르면 실제 부품으로 배치되는 과정이 보여요.
                    </div>
                  </>}
            {circuitIssues.length > 0 && viewMode === 'schematic' && (
              <div role="alert" data-testid="circuit-diagnostics" style={{
                position: 'absolute', left: 14, top: 14, zIndex: 20, width: 440, maxHeight: 230, overflowY: 'auto',
                background: 'rgba(25,20,18,0.96)', border: '1px solid rgba(255,92,92,0.55)', borderRadius: 8,
                boxShadow: '0 10px 30px rgba(0,0,0,0.28)', color: '#f6eee5', fontFamily: 'var(--sf-font-mono)',
              }}>
                <div style={{ padding: '8px 11px', borderBottom: '1px solid rgba(255,255,255,0.12)', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <strong style={{ color: circuitErrors.length ? '#ff7770' : '#f5b942', fontSize: 11 }}>
                    {circuitErrors.length ? `회로 검사 실패 · 오류 ${circuitErrors.length}` : `회로 검사 경고 ${circuitIssues.length}`}
                  </strong>
                  <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 9 }}>PCB 생성 전 검사</span>
                </div>
                {circuitIssues.map((issue, index) => (
                  <div key={`${issue.code}-${index}`} style={{ padding: '9px 11px', borderBottom: index < circuitIssues.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
                    <div style={{ display: 'flex', gap: 7, alignItems: 'baseline' }}>
                      <span style={{ color: issue.severity === 'error' ? '#ff7770' : '#f5b942', fontWeight: 700, fontSize: 10 }}>{issue.code}</span>
                      <strong style={{ fontSize: 11 }}>{issue.title}</strong>
                      {(issue.refs.length > 0 || issue.nets.length > 0) && <span style={{ opacity: 0.55, fontSize: 9 }}>{[...issue.refs, ...issue.nets].join(' · ')}</span>}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 10, lineHeight: 1.45, color: '#d8cfc6' }}>{issue.message}</div>
                    <div style={{ marginTop: 3, fontSize: 9, color: '#9fd8c6' }}>수정: {issue.suggestion}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — SPEC + BOM */}
        {!sidebarOpen && <PanelRail side="right" label="사양 · BOM" onOpen={() => setSidebarOpen(true)} />}
        {sidebarOpen && (
          <div data-testid="right-panel" style={{ width: 240, flexShrink: 0, borderLeft: '1px solid var(--sf-line-strong)', background: 'var(--sf-bg-1)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--sf-line)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10, color: 'var(--sf-fg-faint)', letterSpacing: '0.12em', fontWeight: 700 }}>SPEC</span>
              <button onClick={() => setSidebarOpen(false)} title="접기" aria-label="사양·BOM 패널 접기" style={{ ...collapseBtn, marginLeft: 'auto' }}>›</button>
            </div>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--sf-line)' }}>
              {[
                ['Parts', String(effectiveGraph?.components?.length || 0)],
                ['Nets', String(effectiveGraph?.nets?.length || 0)],
                ['File', result.filename || '—'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--sf-bg-1)' }}>
                  <span style={{ fontSize: 10, color: 'var(--sf-fg-faint)', fontFamily: 'var(--sf-font-mono)' }}>{k}</span>
                  <span style={{ fontSize: 10, color: 'var(--sf-fg-muted)', fontFamily: 'var(--sf-font-mono)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{ padding: '10px 14px 4px', borderBottom: '1px solid var(--sf-line)' }}>
              <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10, color: 'var(--sf-fg-faint)', letterSpacing: '0.12em', fontWeight: 700 }}>BOM</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 14px' }}>
              {(effectiveGraph?.components || []).map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid var(--sf-bg-1)' }}>
                  <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10, color: 'var(--sf-amber)', width: 32, flexShrink: 0 }}>{c.ref}</span>
                  <span style={{ fontSize: 10, color: 'var(--sf-fg-dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.ref}</span>
                  <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 9, color: 'var(--sf-fg-faint)' }}>{c.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom drawer ───────────────────────────────────── */}
      <div style={{
        flexShrink: 0,
        borderTop: '1px solid var(--sf-line)',
        background: 'var(--sf-bg-1)',
      }}>
        {/* tab handle bar */}
        <div style={{ height: BOTTOMBAR_H, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 2 }}>
          {['Netlist', 'Guide', 'Sources', 'BOM', 'Code'].map(t => {
            const isActive = drawerOpen && activeTab === t
            const disabled = (t === 'Guide' && !result.guide) || (t === 'Sources' && !(result.sources?.length))
            return (
              <button key={t} disabled={disabled} onClick={() => {
                if (disabled) return
                if (activeTab === t && drawerOpen) { setDrawerOpen(false) }
                else { setActiveTab(t); setDrawerOpen(true) }
              }} style={{
                padding: '4px 12px', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: 5,
                fontFamily: 'var(--sf-font-mono)', fontSize: 11, letterSpacing: '0.06em',
                background: isActive ? 'var(--sf-line)' : 'transparent',
                color: disabled ? 'var(--sf-fg-faint)' : (isActive ? 'var(--sf-amber)' : 'var(--sf-fg-dim)'),
                fontWeight: isActive ? 700 : 400,
                transition: 'all 0.12s',
              }}>{t}</button>
            )
          })}
          <div style={{ flex: 1 }} />
          {drawerOpen && <button onClick={() => setDrawerOpen(false)} style={{...iconBtn, fontSize:16, color:'var(--sf-fg-dim)'}}>×</button>}
        </div>

        {/* drawer content */}
        {drawerOpen && (
          <div style={{ height: DRAWER_H, overflowY: 'auto', borderTop: '1px solid var(--sf-line)' }}>
            {activeTab === 'Netlist' && (
              <pre style={{ margin:0, padding:'14px 20px', fontFamily:'var(--sf-font-mono)', fontSize:12, lineHeight:1.7, color:'var(--sf-fg-dim)', overflowX:'auto' }}>
                {result.netlist || '(no netlist)'}
              </pre>
            )}
            {activeTab === 'Guide' && result.guide && (
              <div style={{ padding:'14px 20px', color:'var(--sf-fg-dim)', fontSize:13, lineHeight:1.7, whiteSpace:'pre-wrap' }}>{result.guide}</div>
            )}
            {activeTab === 'Sources' && (result.sources?.length ?? 0) > 0 && (
              <div style={{ padding:'14px 20px' }}>
                {(result.sources ?? []).map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener" style={{ display:'block', padding:'5px 0', color:'var(--sf-cyan)', fontSize:12, fontFamily:'var(--sf-font-mono)', wordBreak:'break-all' }}>{url}</a>
                ))}
              </div>
            )}
            {activeTab === 'BOM' && (
              <div style={{ padding:'0 0 16px' }}>
                <BomTable components={result.graph?.components ?? []} guide={result.guide} />
              </div>
            )}
            {activeTab === 'Code' && (
              <div style={{ padding:'0 0 16px' }}>
                <CodeEditor result={result} setResult={setResult} />
                <KicadGuide />
              </div>
            )}
            {gerberStatus === 'done' && gerberInfo && activeTab === 'Netlist' && (
              <GerberFilePanel info={gerberInfo} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function applyActions(graph: NetGraph, actions: ChatAction[]): NetGraph {
  let comps = [...(graph.components || [])]
  let nets  = [...(graph.nets || [])]
  for (const a of actions) {
    if (a.type === 'add_component') {
      if (!comps.find(c => c.ref === a.ref))
        comps = [...comps, { ref: a.ref || '', name: a.name || a.ref || '', value: a.value || '' }]
    } else if (a.type === 'remove_component') {
      comps = comps.filter(c => c.ref !== a.ref)
      nets  = nets.map(n => ({ ...n, nodes: n.nodes.filter((nd: { ref: string }) => nd.ref !== a.ref) })).filter(n => n.nodes.length > 0)
    } else if (a.type === 'modify_component') {
      comps = comps.map(c => c.ref === a.ref ? { ...c, ...(a.value !== undefined ? { value: a.value } : {}) } : c)
    } else if (a.type === 'add_net') {
      nets = [...nets, { name: a.name || '', nodes: a.nodes || [] }]
    } else if (a.type === 'remove_net') {
      nets = nets.filter(n => n.name !== a.name)
    }
  }
  return { ...graph, components: comps, nets }
}

const iconBtn = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '5px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
  background: 'transparent', color: 'var(--sf-fg-dim)',
  transition: 'color 0.12s, background 0.12s',
}

const ghostBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '3px 8px', borderRadius: 4, border: '1px solid var(--sf-line)',
  background: 'transparent', color: 'var(--sf-fg-dim)', cursor: 'pointer',
  fontFamily: 'var(--sf-font-mono)', fontSize: 10, letterSpacing: '0.06em',
}

function PanelLabel({ color, label, sub, extra }: { color: string; label: string; sub?: string; extra?: React.ReactNode }) {
  return (
    <div style={{
      height: 30, flexShrink: 0,
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '0 14px',
      background: 'var(--sf-bg-1)',
      borderBottom: '1px solid var(--sf-line)',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10, color, letterSpacing: '0.12em', fontWeight: 700 }}>{label}</span>
      <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10, color: 'var(--sf-fg-faint)' }}>{sub}</span>
      {extra && <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>{extra}</div>}
    </div>
  )
}

function TimelineStrip({ versions, currentVersionId, onSelectVersion, onApplyVersion }: { versions: Version[]; currentVersionId: string | null; onSelectVersion?: (id: string) => void; onApplyVersion?: () => void }) {
  const currentIdx = versions.findIndex(v => v.id === currentVersionId)
  const isBrowsingPast = currentIdx >= 0 && currentIdx < versions.length - 1
  const futureCount = versions.length - 1 - currentIdx

  return (
    <div style={{
      marginBottom: 20,
      background: 'var(--sf-bg-2)',
      border: '1px solid var(--sf-line)',
      borderRadius: 'var(--sf-r-lg)',
      padding: '12px 16px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10, gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{
            fontFamily: 'var(--sf-font-mono)', fontSize: 11,
            color: 'var(--sf-amber)', letterSpacing: '0.14em',
          }}>TIMELINE</span>
          <span style={{
            fontFamily: 'var(--sf-font-mono)', fontSize: 11,
            color: 'var(--sf-fg-dim)', letterSpacing: '0.06em',
          }}>{currentIdx + 1} / {versions.length} · 이번 세션</span>
        </div>
        {isBrowsingPast && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--sf-fg-dim)', fontFamily: 'var(--sf-font-mono)' }}>
              이후 {futureCount}개 버전 폐기됨
            </span>
            <button
              onClick={onApplyVersion}
              style={{
                padding: '5px 14px',
                background: 'var(--sf-amber)',
                color: 'var(--sf-fg-inverse)',
                border: 'none',
                borderRadius: 'var(--sf-r-pill)',
                fontFamily: 'var(--sf-font-mono)',
                fontSize: 12, fontWeight: 600,
                letterSpacing: '0.06em',
                cursor: 'pointer',
              }}
            >
              ✓ 이 버전으로 Apply
            </button>
          </div>
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'stretch', gap: 8,
        overflowX: 'auto', paddingBottom: 4,
      }}>
        {versions.map((v, i) => {
          const active = v.id === currentVersionId
          const past = currentIdx >= 0 && i > currentIdx
          const time = new Date(v.time)
          const ts = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`
          const compCount = v.result?.graph?.components?.length || 0
          const netCount = v.result?.graph?.nets?.length || 0
          return (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => onSelectVersion?.(v.id)}
                style={{
                  flexShrink: 0,
                  minWidth: 180, maxWidth: 240,
                  padding: '10px 12px',
                  textAlign: 'left',
                  background: active ? 'var(--sf-amber-soft)' : 'var(--sf-bg-3)',
                  border: `1px solid ${active ? 'var(--sf-amber-line)' : 'var(--sf-line)'}`,
                  borderRadius: 'var(--sf-r-md)',
                  color: 'var(--sf-fg)',
                  cursor: 'pointer',
                  opacity: past ? 0.55 : 1,
                  transition: 'all var(--sf-dur) var(--sf-ease)',
                  position: 'relative',
                }}
              >
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  marginBottom: 4,
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: active ? 'var(--sf-amber)' : (past ? 'var(--sf-fg-dim)' : 'var(--sf-cyan)'),
                  }} />
                  <span style={{
                    fontFamily: 'var(--sf-font-mono)', fontSize: 11,
                    color: active ? 'var(--sf-amber)' : 'var(--sf-fg-dim)',
                    fontWeight: 600, letterSpacing: '0.06em',
                  }}>v{i + 1}</span>
                  <span style={{
                    fontFamily: 'var(--sf-font-mono)', fontSize: 10,
                    color: 'var(--sf-fg-dim)', marginLeft: 'auto',
                  }}>{ts}</span>
                </div>
                <div style={{
                  fontSize: 12, color: active ? 'var(--sf-fg)' : 'var(--sf-fg-muted)',
                  fontFamily: 'var(--sf-font-sans)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  marginBottom: 2,
                }}>{v.label}</div>
                <div style={{
                  fontSize: 10, color: 'var(--sf-fg-dim)',
                  fontFamily: 'var(--sf-font-mono)', letterSpacing: '0.04em',
                }}>{compCount}부품 · {netCount}넷</div>
              </button>
              {i < versions.length - 1 && (
                <span style={{
                  flexShrink: 0,
                  fontSize: 14,
                  color: i < currentIdx ? 'var(--sf-amber)' : 'var(--sf-fg-dim)',
                  fontFamily: 'var(--sf-font-mono)',
                }}>→</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GerberFilePanel({ info }: { info: { dir: string; files?: string[] } }) {
  const { dir, files = [] } = info
  const layerLabels = {
    '.gtl': '상단 동박 (Top Copper)',
    '.gbl': '하단 동박 (Bottom Copper)',
    '.gts': '상단 솔더마스크',
    '.gbs': '하단 솔더마스크',
    '.gto': '상단 실크스크린',
    '.gbo': '하단 실크스크린',
    '.gko': '보드 외곽 (Edge Cuts)',
    '.gm1': '메커니컬',
    '.drl': '드릴',
  }
  function ext(name: string) {
    const m = name.toLowerCase().match(/(\.[a-z0-9]+)$/)
    return m ? m[1] : ''
  }
  return (
    <div style={{
      borderTop: '1px solid var(--sf-line)',
      background: 'var(--sf-bg-2)',
      padding: '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <span style={{
          fontFamily: 'var(--sf-font-mono)', fontSize: 11,
          color: 'var(--sf-amber)', letterSpacing: '0.14em',
        }}>GERBER</span>
        <span style={{ fontSize: 11, color: 'var(--sf-fg-dim)', fontFamily: 'var(--sf-font-mono)' }}>
          {files.length}개 파일 · 제조사 업로드 가능
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--sf-fg-dim)', fontFamily: 'var(--sf-font-mono)' }}>
          /outputs/{dir}/
        </span>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 6,
      }}>
        {files.map(f => {
          const e = ext(f)
          const label = (layerLabels as Record<string, string>)[e] || '기타'
          return (
            <a
              key={f}
              href={`/download_gerber_file/${dir}/${encodeURIComponent(f)}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px',
                background: 'var(--sf-bg-3)',
                border: '1px solid var(--sf-line)',
                borderRadius: 'var(--sf-r-sm)',
                color: 'var(--sf-fg)',
                textDecoration: 'none',
                fontSize: 12,
                transition: 'all var(--sf-dur) var(--sf-ease)',
              }}
              onMouseEnter={ev => { ev.currentTarget.style.borderColor = 'var(--sf-amber-line)' }}
              onMouseLeave={ev => { ev.currentTarget.style.borderColor = 'var(--sf-line)' }}
            >
              <span style={{
                fontFamily: 'var(--sf-font-mono)', fontSize: 10,
                color: 'var(--sf-amber)', letterSpacing: '0.06em',
                width: 36,
              }}>{e || '—'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--sf-fg-muted)', fontSize: 11 }}>
                {label}
              </span>
              <span style={{ color: 'var(--sf-cyan)', fontSize: 14 }}>↓</span>
            </a>
          )
        })}
      </div>
    </div>
  )
}


/** Open/closed state of a side panel, remembered per browser. */
function usePanelState(key: string): [boolean, (v: boolean | ((o: boolean) => boolean)) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(key) !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem(key, open ? '1' : '0') } catch { /* storage blocked: keep in memory */ }
  }, [key, open])
  return [open, setOpen]
}

const collapseBtn: React.CSSProperties = {
  width: 20, height: 20, padding: 0, border: '1px solid var(--sf-line)', borderRadius: 3,
  background: 'transparent', color: 'var(--sf-fg-dim)', cursor: 'pointer',
  fontSize: 13, lineHeight: '17px', fontFamily: 'var(--sf-font-mono)',
}

/** Thin strip shown in place of a collapsed panel; the whole strip reopens it. */
function PanelRail({ side, label, onOpen }: { side: 'left' | 'right'; label: string; onOpen: () => void }) {
  return (
    <button onClick={onOpen} data-testid={`${side}-rail`} title={`${label} 펼치기`} aria-label={`${label} 패널 펼치기`}
      style={{
        width: 28, flexShrink: 0, padding: '10px 0', border: 'none', cursor: 'pointer',
        [side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid var(--sf-line-strong)',
        background: 'var(--sf-bg-1)', color: 'var(--sf-fg-dim)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        fontFamily: 'var(--sf-font-sans)', fontSize: 12,
      }}>
      <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 13 }}>{side === 'left' ? '›' : '‹'}</span>
      <span style={{ writingMode: 'vertical-rl', letterSpacing: '0.08em' }}>{label}</span>
    </button>
  )
}

function PanelIcon({ side }: { side: 'left' | 'right' }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <line x1={side === 'left' ? 5.5 : 10.5} y1="2.5" x2={side === 'left' ? 5.5 : 10.5} y2="13.5" />
    </svg>
  )
}
