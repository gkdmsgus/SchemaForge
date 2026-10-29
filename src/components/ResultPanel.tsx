import React, { useEffect, useMemo, useRef, useState, Dispatch, SetStateAction } from 'react'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import {
  addFavorite, removeFavorite, getFavorites, saveMessage, updateSession, authFetch, authHeaders, errorText,
  type AuthUser, type SessionPatch,
} from '../api'
import CircuitCanvas from './CircuitCanvas'
import PCBLayout from './PCBLayout'
import BomTable from './BomTable'
import { buildBom, compactRefs, type BomBoard } from '../lib/bom'
import { assemblyRefs } from '../lib/assembly'
import CodeEditor, { type CodeRun, type CodeRunNote } from './CodeEditor'
import KicadGuide from './KicadGuide'
import { toLF, type CodeEdit } from '../lib/pythonCode'
import TraceField from './TraceField.tsx'
import {
  Button, Input,
  IconCheck, IconCopy, IconDownload, IconWand, IconLayers,
} from './primitives.tsx'
import type {
  GenerateResult, Version, ChatSession, NetGraph, ChatMessage, PcbSummary, ErcFinding,
  BoardPart, BoardFrame, BoardModel, RouteEvent, DrcResult, AiRound,
} from '../types'
import BoardView from './BoardView'
import { StatusChip } from './StatusUi'
import OperatingPanel from './OperatingPanel'
import { applyActions, movedPins, skippedAdds } from '../lib/graphEdit'
import { draftWith, ercFixes, opFixes, pinoutStyleFix, type Fix } from '../lib/fixes'
import { pinoutWarnings } from '../lib/humanReview'
import { fromGraph, operatingChecks, operatingHeadline } from '../lib/operatingCheck'
import { STATE_TONE, TONE_COLOR, ercErrorCount } from '../lib/boardChecks'
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

/** After a code run: the saved entry keeps the edited code and its circuit (the chat graph is replaced). */
function updateSavedResult(prompt: string, patch: Pick<GenerateResult, 'code' | 'filename' | 'graph' | 'codeEdited'>) {
  try {
    const saved = getSavedResults()
    const idx = saved.findIndex(s => s.prompt === prompt)
    if (idx < 0) return
    saved[idx] = { ...saved[idx], result: { ...withoutErc(saved[idx].result ?? {}), ...patch }, graph: patch.graph ?? saved[idx].graph }
    localStorage.setItem('sf_saved_results', JSON.stringify(saved))
  } catch { /* storage full or blocked: the edit stays in memory */ }
}

/** Drops checks that describe a previous netlist (the generation step may attach `erc`). */
function withoutErc(r: GenerateResult): GenerateResult {
  const { erc: _previous, ...rest } = r as GenerateResult & { erc?: unknown }
  return rest
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
  /** generate this prompt again now (no cache, no questions or plan: those panels are hidden here) */
  onRegenerate: (p: string) => void
  /** the server rejected the saved login (401) */
  onAuthExpired?: () => void
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
  result, setResult, theme, onRegenerate, onAuthExpired, lastPrompt,
  versions = [], currentVersionId = null, onSelectVersion, onApplyVersion,
  initialChatSession = null, authUser = null, sessionId = null,
}: ResultPanelProps) {
  const resultRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatBoxRef = useRef<HTMLTextAreaElement>(null)
  const [pcbStatus, setPcbStatus] = useState<string | null>(null)
  // why the AI rounds were refused (a deployed server keeps them for listed accounts); the board was built without.
  // login: the refusal was 401 (no login, or it ran out), so the chip says to log in
  const [aiNote, setAiNote] = useState<{ text: string; login: boolean } | null>(null)
  // a change that did not reach the saved session (chat, circuit, favourite): said in the top bar
  const [syncError, setSyncError] = useState<string | null>(null)
  const [pcbFilename, setPcbFilename] = useState<string | null>(null)
  const [pcbStyle, setPcbStyle] = useState<'smd' | 'tht'>('smd')
  const [useAi, setUseAi] = useState(false)
  const [pcbSummary, setPcbSummary] = useState<PcbSummary | null>(null)
  const [board, setBoard] = useState<{
    parts: BoardPart[]; frames: BoardFrame[]; routes: RouteEvent[]; target: [number, number, number, number] | null
    final: BoardModel | null; drc: DrcResult | null; ai: AiRound[]; status: 'streaming' | 'done' | 'error'
  } | null>(null)
  const [gerberStatus, setGerberStatus] = useState<string | null>(null)
  const [gerberInfo, setGerberInfo] = useState<GerberInfo | null>(null)
  const [gerberError, setGerberError] = useState('')
  // which gerber request may still set the state: a new PCB (another style, AI on) makes older answers stale
  const gerberReq = useRef(0)
  const [activeTab, setActiveTab] = useState('Netlist')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = usePanelState('sf_panel_right')
  const [editorOpen, setEditorOpen] = usePanelState('sf_panel_left')
  const [viewMode, setViewMode] = useState('schematic')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => initialChatSession?.messages || [])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  // a session opened from history whose saved circuit is an AI edit: held as an edit (its own copy, so aiEdited
  // holds) that 초기화 goes back to, until a code run replaces the circuit
  const [savedEdit, setSavedEdit] = useState<NetGraph | null>(() =>
    (initialChatSession?.aiEdited && result.graph ? structuredClone(result.graph) : null))
  const [localGraph, setLocalGraph] = useState<NetGraph | null>(() => savedEdit ?? initialChatSession?.graph ?? null)
  const [isFavorited, setIsFavorited] = useState(false)
  const [favId, setFavId] = useState<string | null>(null)
  const [favLoading, setFavLoading] = useState(false)
  const [graphHistory, setGraphHistory] = useState<NetGraph[]>([])
  const [graphDiff, setGraphDiff] = useState<{ added: Set<string>; removed: Set<string>; modified: Set<string> } | null>(null)
  // Code tab: the draft and the last run outlive drawer tab switches
  const [codeEdit, setCodeEdit] = useState<CodeEdit | null>(null)
  const [codeRun, setCodeRun] = useState<CodeRunNote | null>(null)
  // the operating checks open from their chip in the tab bar, so they never sit over the schematic uninvited
  const [opOpen, setOpOpen] = useState(false)
  // the netlist check on the circuit the AI editor changed, run again after every change (a fix made by chat shows at once)
  const [aiErc, setAiErc] = useState<{ graph: NetGraph; findings: ErcFinding[] | null; error?: string } | null>(null)
  const [ercRetry, setErcRetry] = useState(0)       // 다시 점검: runs the check on the same circuit again
  // what the current board was built from, to tell when it no longer matches the circuit
  const [pcbSource, setPcbSource] = useState<{ graph: NetGraph | undefined; style: 'smd' | 'tht' } | null>(null)
  /** text null: the server has no such file (404); failed: the request did not get through (retry offered) */
  const [netText, setNetText] = useState<{ file: string; text: string | null; failed?: boolean } | null>(null)

  const effectiveGraph = localGraph || result?.graph
  // the AI chat changed the circuit (a session opened from history starts with localGraph === result.graph,
  // or with savedEdit when its saved circuit is an AI edit)
  const aiEdited = !!localGraph && localGraph !== result?.graph
  // Identity of the graph object, so chat edits, undo, code runs and version switches all count.
  const pcbStale: 'circuit' | 'style' | null = board?.status !== 'done' || !pcbSource ? null
    : pcbSource.graph !== effectiveGraph ? 'circuit' : pcbSource.style !== pcbStyle ? 'style' : null

  // Netlist tab: the .net file itself, fetched when the tab opens and again after a rerun
  const netFile = result?.filename
  useEffect(() => {
    if (!drawerOpen || activeTab !== 'Netlist' || !netFile || netText?.file === netFile) return
    let off = false
    fetch(`${API}/download/${encodeURIComponent(netFile)}`)
      .then(async r => (r.ok ? { text: await r.text() } : r.status === 404 ? { text: null } : { text: null, failed: true }))
      .catch(() => ({ text: null, failed: true }))
      .then(got => { if (!off) setNetText({ file: netFile, ...got }) })
    return () => { off = true }
  }, [drawerOpen, activeTab, netFile, netText?.file])
  useEffect(() => {
    if (!aiEdited || !localGraph) return
    let off = false
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/erc_graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graph: localGraph }) })
        const data = await res.json().catch(() => null) as { erc?: ErcFinding[] | null; ercError?: string; error?: string } | null
        if (off) return
        const why = res.status === 404 ? '서버에 이 점검 기능이 없습니다. 서버를 최신 코드로 다시 시작하면 됩니다.'
          : res.status === 400 ? '회로에 점검할 수 없는 이름(따옴표나 괄호)이 있습니다.'
            : !res.ok ? `서버가 점검하지 못했습니다 (HTTP ${res.status}).` : undefined
        setAiErc({ graph: localGraph, findings: res.ok && Array.isArray(data?.erc) ? data!.erc! : null, error: why ?? data?.ercError ?? data?.error })
      } catch {
        if (!off) setAiErc({ graph: localGraph, findings: null, error: '서버에 연결하지 못했습니다. 서버가 켜져 있는지 확인합니다.' })
      }
    }, 300)
    return () => { off = true; clearTimeout(timer) }
  }, [aiEdited, localGraph, ercRetry])
  // a session opened again (history, favourites) may already be a favourite: the star starts filled
  useEffect(() => {
    if (!authUser || !sessionId) return
    let off = false
    getFavorites()
      .then(list => {
        if (off) return
        const fav = list.find(f => f.sessionId === sessionId)
        setIsFavorited(!!fav)
        setFavId(fav?.id ?? null)
      })
      .catch(() => { /* the star stays empty; adding it again is harmless (the server keeps one per session) */ })
    return () => { off = true }
  }, [authUser, sessionId])
  const circuitIssues = useMemo(() => validateCircuit(effectiveGraph), [effectiveGraph])
  // does it work: numeric checks on the part values, for the SMD/THT parts the PCB will use
  const opResults = useMemo(() => (effectiveGraph ? operatingChecks(fromGraph(effectiveGraph, pcbStyle)) : []), [effectiveGraph, pcbStyle])
  const opHead = operatingHeadline(opResults)
  const opFixMap = useMemo(() => (effectiveGraph ? opFixes(fromGraph(effectiveGraph, pcbStyle), opResults) : new Map<string, Fix>()), [effectiveGraph, pcbStyle, opResults])
  const aiErcNow = aiEdited && aiErc?.graph === localGraph ? aiErc : null
  const ercShown = aiEdited ? aiErcNow?.findings ?? [] : result?.erc?.findings ?? []
  const ercFixList = useMemo(() => ercFixes(ercShown, aiEdited ? localGraph : result?.graph), [ercShown, aiEdited, localGraph, result?.graph])
  // parts list: the board's footprints once a PCB exists (deps on parts/final, not every streamed frame)
  const boardParts = board?.parts
  const boardFinal = board?.final ?? null
  const bomBoard = useMemo<BomBoard | null>(() => (boardFinal || boardParts?.length
    ? { parts: boardFinal?.parts ?? boardParts ?? [], unmapped: boardFinal?.unmapped ?? [] }
    : null), [boardFinal, boardParts])
  const bomStyle = boardFinal?.style ?? pcbStyle
  // the netlist check /generate ran: shown on the schematic while the circuit is still that netlist
  const ercNotice = useMemo(() => {
    // after an AI edit: the check run on the edited circuit (the generated one no longer applies)
    if (aiEdited) {
      if (!aiErcNow) return { tone: 'ok' as const, head: '바뀐 회로의 연결을 점검하는 중입니다…', lines: [] as string[] }
      if (!aiErcNow.findings) return { tone: 'warn' as const, head: '바뀐 회로의 연결 점검을 돌리지 못했습니다', retry: true,
        lines: [aiErcNow.error ?? '이유를 알 수 없습니다', '회로가 틀렸다는 뜻은 아닙니다. 다시 점검하거나, PCB를 만들면 기판 점검에서 다시 확인합니다.'] }
      const errs = aiErcNow.findings.filter(f => f.severity === 'error')
      if (errs.length) return { tone: 'bad' as const, head: `AI 편집 뒤 연결 점검 오류 ${ercErrorCount(errs)}개`,
        lines: ['AI 편집으로 바뀐 회로를 다시 점검한 결과입니다. 아래처럼 AI에게 다시 요청하거나, 마지막 AI 수정을 되돌립니다.'] }
      return { tone: 'ok' as const, head: 'AI 편집 뒤 연결 점검 통과', lines: ['바뀐 회로를 다시 점검했습니다. 기판은 PCB를 다시 만들어야 바뀝니다.'] }
    }
    const erc = result?.erc
    if (!erc || result?.codeEdited) return null
    const errors = (erc.findings ?? []).filter(f => f.severity === 'error')
    const count = ercErrorCount(errors)
    const rep = erc.repair
    if (!erc.findings) return { tone: 'warn' as const, head: '넷리스트 점검(ERC)을 돌리지 못했습니다',
      lines: [erc.reason ?? '이유를 알 수 없습니다', 'PCB를 만들면 기판 점검에서 다시 확인합니다.'] }
    if (errors.length) return { tone: 'bad' as const, head: `넷리스트 점검(ERC) 오류 ${count}개`,
      lines: [
        rep && !rep.tried ? '자동 재시도가 꺼져 있어 고치지 않았습니다. 아래 해결책을 Code 탭에 넣거나, 설정에서 자동 재시도를 켜고 다시 생성합니다.'
          : rep?.tried && !rep.kept ? `AI가 한 번 고쳐 봤지만 받아들이지 않아 원래 회로를 그대로 둡니다 (${rep.note}). 아래처럼 직접 고칩니다.`
            : rep?.kept ? `AI가 오류 ${rep.before}개 중 ${rep.before - rep.after}개를 고쳤습니다. 남은 오류는 아래처럼 고칩니다.` : 'Code 탭에서 연결을 고치거나 다시 생성합니다.'] }
    if (rep?.kept) return { tone: 'ok' as const, head: `넷리스트 점검(ERC) 오류를 자동으로 고쳤습니다 (오류 ${rep.before} → ${rep.after})`,
      lines: ['AI가 고친 코드를 다시 실행해 오류가 줄고, 맞게 이어져 있던 연결과 부품 값이 그대로일 때만 바꿨습니다. Code 탭에서 확인할 수 있습니다.'] }
    return null
  }, [result?.erc, result?.codeEdited, aiEdited, aiErcNow])
  const sideBom = useMemo(() => buildBom(effectiveGraph?.components ?? [], bomBoard, bomStyle), [effectiveGraph, bomBoard, bomStyle])
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

  /** the saved session (logged in) follows the circuit on screen: reopened from history it is the latest one */
  function saveToSession(patch: SessionPatch) {
    if (!sessionId || !authUser) return
    updateSession(sessionId, patch)
      .then(() => setSyncError(null))
      .catch(e => setSyncError(`바뀐 회로를 기록에 저장하지 못했습니다: ${(e as Error).message}`))
  }

  /** each AI-editor exchange is kept with the saved session, so the chat comes back when it is opened again */
  function saveChat(question: string, reply: ChatMessage) {
    if (!sessionId || !authUser) return
    const sid = sessionId
    // one after the other: the server orders a session's messages by when they arrived
    saveMessage(sid, 'user', question)
      .then(() => saveMessage(sid, 'assistant', reply.content || '...', reply.actions ?? []))
      .then(() => setSyncError(null))
      .catch(e => setSyncError(`AI 편집 대화를 기록에 저장하지 못했습니다: ${(e as Error).message}`))
  }

  function undoGraph() {
    const restored = graphHistory[graphHistory.length - 1]
    if (!restored) return
    setGraphHistory(prev => prev.slice(0, -1))
    setLocalGraph(restored)
    saveToSession({ graph: restored })
  }

  /** 초기화: back to the circuit as generated (or as last saved, for a session opened from history; a saved AI edit stays one) */
  function resetGraph() {
    const back = savedEdit ?? result?.graph
    const changed = effectiveGraph !== back
    setLocalGraph(savedEdit)
    setGraphHistory([])
    if (changed && back) saveToSession({ graph: back })
  }

  // Streams placement and routing (/generate_pcb_stream): parts → init → frame… → route/rip… → done.
  async function generatePCB(opts: { style?: 'smd' | 'tht'; ai?: boolean } = {}) {
    const style = opts.style ?? pcbStyle, ai = opts.ai ?? useAi
    if (opts.style) setPcbStyle(opts.style)
    if (opts.ai != null) setUseAi(opts.ai)
    if (circuitErrors.length) {
      setPcbStatus('invalid')
      setViewMode('schematic')
      return
    }
    // AI-edited graph: the server writes a netlist from it; otherwise use the generated one
    const body = localGraph
      ? { graph: localGraph, baseName: result?.filename?.replace('.net', '') || 'circuit', style, ai }
      : result?.filename ? { filename: result.filename, style, ai } : null
    if (!body) { setPcbStatus('error'); return }

    setPcbSource({ graph: effectiveGraph, style })
    setPcbStatus('loading')
    // Below ~1280 px the two side panels leave the 2D + 3D board view too narrow to read.
    if (window.innerWidth < 1280) { setEditorOpen(false); setSidebarOpen(false) }
    setBoard({ parts: [], frames: [], routes: [], target: null, final: null, drc: null, ai: [], status: 'streaming' })
    gerberReq.current++
    setGerberStatus(null)
    setGerberInfo(null)
    setViewMode('pcb')
    try {
      const res = await authFetch(`${API}/generate_pcb_stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (ai && (res.status === 401 || res.status === 403)) {
        // a deployed server keeps the AI rounds for listed accounts: say why, and build the board without them
        // (401: no login, or it ran out and could not be renewed, so the app also asks for the login)
        const login = res.status === 401
        setAiNote({ text: await errorText(res), login })
        if (login) onAuthExpired?.()
        return generatePCB({ style, ai: false })
      }
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

  /** A circuit check's 해결: its instruction in the AI editor's box, ready to send. */
  function chatFix(text: string) {
    setChatInput(text)
    setEditorOpen(true)
    // the panel may have been closed: focus once it is in the page
    setTimeout(() => {
      const box = chatBoxRef.current
      if (!box) return
      box.focus()
      box.setSelectionRange(box.value.length, box.value.length)
    }, 0)
  }

  /** A fix's lines go into the Code tab draft (on top of a draft already open); running it is the person's call. */
  const canDraft = !!result?.code && !aiEdited && draftWith(result.code, ['x'], 'x') != null
  function draftFix(fix: Fix, note: string) {
    if (!fix.lines?.length || !result?.code || aiEdited) return
    const base = codeEdit?.text ?? result.code
    const text = draftWith(base, fix.lines, note)
    if (!text) return
    setCodeEdit({ text, error: null })
    setActiveTab('Code')
    setDrawerOpen(true)
  }

  /** A successful run in the Code tab replaces the circuit, AI chat edits included (the user confirmed). */
  function applyCodeResult(run: CodeRun) {
    const diff = computeDiff(effectiveGraph ?? null, run.graph)
    const patch = { code: run.code, filename: run.filename, graph: run.graph, codeEdited: true }
    setResult(p => p && { ...withoutErc(p), ...patch })
    setLocalGraph(null)
    setSavedEdit(null)
    setGraphHistory([])
    setGraphDiff(diff)
    setTimeout(() => setGraphDiff(null), 3000)
    updateSavedResult(lastPrompt, patch)
    saveToSession({ graph: run.graph, code: run.code, filename: run.filename })
    const refs = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    setCodeRun({
      filename: run.filename, parts: run.graph.components.length, nets: run.graph.nets.length,
      added: refs(diff.added), removed: refs(diff.removed), modified: refs(diff.modified),
      erc: run.erc, ercError: run.ercError,
    })
  }

  async function generateGerber() {
    if (!pcbFilename) return
    const req = ++gerberReq.current
    setGerberStatus('loading')
    try {
      const res = await fetch(`${API}/generate_gerber`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ pcbFilename }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      if (req !== gerberReq.current) return
      setGerberInfo({ dir: data.gerberDir as string, files: data.files || [], zip: data.zip as string | undefined })
      setGerberStatus('done')
    } catch (e) {
      if (req !== gerberReq.current) return
      setGerberError((e as Error).message)
      setGerberStatus('error')
      console.error('Gerber generation failed:', e)
    }
  }

  function handleCopyPrompt() {
    navigator.clipboard.writeText(lastPrompt || '')
    alert('프롬프트 복사 완료')
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
      const res = await authFetch(`${API}/chat_edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph: effectiveGraph, message: msg, history }),
      })
      if (res.status === 401) {
        // no login, or it ran out: the app asks for it, and the request goes back in the box to send again
        setChatInput(msg)
        onAuthExpired?.()
      }
      // a refusal (a deployed server keeps the AI editor for listed accounts) has no stream: show its reason
      if (!res.ok || !res.body) throw new Error(await errorText(res))

      const reader = res.body.getReader()
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
            let note = ''
            if (actions?.length && snapshot) {
              pushGraphHistory(snapshot)
              newGraph = applyActions(snapshot, actions)
              // pins the edit took off a net they were on: the model may have guessed, so the person sees it
              const moved = movedPins(snapshot, newGraph)
              if (moved.length) note = `\n\n바뀐 연결: ${moved.map(m => `${m.pin} ${m.from} → ${m.to ?? '연결 없음'}`).join(', ')}. 의도와 다르면 위의 되돌리기를 누르세요.`
              const skipped = skippedAdds(snapshot, actions)
              if (skipped.length) note += `\n\n넣지 못한 부품: ${skipped.join(', ')}. 부품 기호(예: C3)를 붙여 다시 요청해 주세요.`
              const diff = computeDiff(snapshot, newGraph)
              setGraphDiff(diff)
              // Let removed parts flash before they disappear, then show diagnostics.
              if (diff.removed.size) setTimeout(() => setLocalGraph(newGraph), 550)
              else setLocalGraph(newGraph)
              setTimeout(() => setGraphDiff(null), 3000)
            }
            const assistantMsg: ChatMessage = { role: 'assistant', content: `${reply as string}${note}`, actions: actions || [] }
            setChatMessages(prev => {
              const next = [...prev.slice(0, -1), assistantMsg]
              updateSavedResultChat(lastPrompt, next, newGraph)
              return next
            })
            saveChat(msg, assistantMsg)
            if (newGraph && newGraph !== snapshot) saveToSession({ graph: newGraph })
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
      setSyncError(`즐겨찾기를 바꾸지 못했습니다: ${(e as Error).message}`)
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

  const lastRun = codeRun && codeRun.filename === result.filename ? codeRun : null
  const codeDirty = !!codeEdit && codeEdit.text !== toLF(result.code ?? '')

  const TOPBAR_H = 44
  // the Code tab is taller so the editor fits without its buttons scrolling away
  const DRAWER_H = !drawerOpen ? 0
    : activeTab === 'Code' ? Math.max(280, Math.min(440, Math.round(window.innerHeight * 0.5))) : 280
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

        {syncError && <StatusChip tone="warn" title={syncError} testId="sync-error">기록 저장 실패</StatusChip>}

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
        <button onClick={() => onRegenerate(lastPrompt)} title="재생성 (저장된 결과 대신 새로 생성)" style={{...iconBtn, fontSize:16}}>↺</button>
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
              {localGraph && localGraph !== savedEdit && (
                <button onClick={resetGraph} style={{
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
                <textarea ref={chatBoxRef} data-testid="chat-input"
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
              { key: 'schematic', label: 'SCHEMATIC', color: 'var(--sf-cyan)', sub: `${components.length} parts`, off: '' },
              { key: 'pcb',       label: 'PCB',        color: 'var(--sf-amber-deep)', sub: `${nets.length} nets`, off: '' },
              // checking off parts placed on the real board: needs a finished PCB
              { key: 'assembly',  label: '배치하기',    color: 'var(--sf-violet)',
                sub: boardFinal ? `${assemblyRefs(boardFinal).length} parts` : 'PCB 후',
                off: boardFinal ? '' : 'PCB를 생성하면 실물 기판에 부품을 올리며 체크할 수 있습니다' },
            ].map(({ key, label, color, sub, off }) => {
              const active = viewMode === key
              return (
                <button key={key} onClick={() => { if (!off) setViewMode(key) }} disabled={!!off} title={off || undefined}
                  data-testid={`view-tab-${key}`} style={{
                  display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, whiteSpace: 'nowrap',
                  padding: '8px 14px', border: 'none', cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.55 : 1,
                  background: active ? 'var(--sf-bg)' : 'transparent',
                  borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
                  borderRight: '1px solid var(--sf-line)',
                  marginBottom: -1, transition: 'background 0.1s',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, opacity: active ? 1 : 0.3 }} />
                  <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10, letterSpacing: '0.12em', fontWeight: active ? 700 : 500, color: active ? color : 'var(--sf-fg-faint)' }}>{label}</span>
                  <span className="sf-tab-sub" style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 9, color: 'var(--sf-fg-faint)', opacity: active ? 0.8 : 0.5 }}>{sub}</span>
                </button>
              )
            })}
            {/* PCB gen buttons in tab bar */}
            {/* the tabs keep their width; on a narrow window these buttons scroll sideways instead */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 12px', marginLeft: 'auto',
              minWidth: 0, overflowX: 'auto', whiteSpace: 'nowrap', scrollbarWidth: 'thin' }}>
              {pcbStatus !== 'loading' && (['smd', 'tht'] as const).map(s => (
                <button key={s}
                  title={s === 'smd' ? '표면실장 부품 (커넥터·릴레이는 구멍 끼움)' : '전부 구멍 끼움 부품 (손납땜 쉬움)'}
                  onClick={() => { if (s !== pcbStyle) { setPcbStyle(s); if (pcbStatus === 'done') setPcbStatus(null) } }}
                  style={{ ...ghostBtn, padding: '2px 6px', fontFamily: 'var(--sf-font-mono)', fontSize: 10,
                    color: pcbStyle === s ? 'var(--sf-cyan)' : 'var(--sf-fg-faint)', opacity: pcbStyle === s ? 1 : 0.6 }}>
                  {s.toUpperCase()}
                </button>
              ))}
              {pcbStatus === 'done' && !pcbStale && pcbSummary && pcbSummary.unmapped.length > 0 && (
                <StatusChip tone="bad" testId="pcb-unmapped"
                  title={pcbSummary.unmapped.map(u => `${u.ref} (${u.part || '?'}): ${u.reason}`).join('\n')}>
                  풋프린트 없음 {pcbSummary.unmapped.length} · {pcbSummary.unmapped.map(u => u.ref).join(', ')}
                </StatusChip>
              )}
              {pcbStatus === 'done' && !pcbStale && pcbSummary && pcbSummary.warnings.length > 0 && (
                <StatusChip tone="bad" testId="pcb-pinout" title={pcbSummary.warnings.join('\n')}>
                  부품 확인 {pcbSummary.warnings.length}
                </StatusChip>
              )}
              {opResults.length > 0 && (
                <button type="button" data-testid="op-toggle" aria-expanded={opOpen && viewMode === 'schematic'} aria-controls="operating-panel"
                  onClick={() => { if (viewMode !== 'schematic') { setViewMode('schematic'); setOpOpen(true) } else setOpOpen(o => !o) }}
                  title={`${opResults.filter(r => r.state !== 'pass').map(r => r.summary).join('\n') || '모든 동작 검사 통과'}\n(눌러서 동작 검사 ${opOpen && viewMode === 'schematic' ? '닫기' : '보기'})`}
                  style={{ padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', flexShrink: 0 }}>
                  <StatusChip tone={STATE_TONE[opHead.state]} testId="op-chip">
                    {opHead.text} {opOpen && viewMode === 'schematic' ? '▴' : '▾'}
                  </StatusChip>
                </button>
              )}
              {pcbStatus !== 'loading' && (
                <button onClick={() => { setUseAi(v => !v); setAiNote(null); if (pcbStatus === 'done') setPcbStatus(null) }}
                  title="AI가 배치·선 굵기에서 고칠 점을 제안합니다. 검사 지표가 좋아질 때만 반영해요 (OpenAI 호출 비용이 듭니다)"
                  style={{ ...ghostBtn, padding: '2px 6px', fontFamily: 'var(--sf-font-mono)', fontSize: 10,
                    color: useAi ? 'var(--sf-violet)' : 'var(--sf-fg-faint)', opacity: useAi ? 1 : 0.6 }}>
                  AI 다듬기 {useAi ? 'ON' : 'OFF'}
                </button>
              )}
              {aiNote && !useAi && <StatusChip tone="warn" title={aiNote.text} testId="ai-note">
                {aiNote.login ? 'AI 다듬기는 로그인 후' : 'AI 다듬기는 허용된 계정만'}
              </StatusChip>}
              {(pcbStatus === null || pcbStatus === 'invalid' || (pcbStatus === 'done' && pcbStale)) && <button onClick={() => generatePCB()} style={{...ghostBtn, color: circuitErrors.length ? 'var(--sf-danger)' : ghostBtn.color}}><IconLayers size={12} /> {circuitErrors.length ? `회로 오류 ${circuitErrors.length}` : pcbStale ? 'PCB 다시 생성' : 'PCB 생성'}</button>}
              {pcbStatus === 'loading' && <StatusChip tone="accent" busy testId="pcb-loading">PCB 생성 중</StatusChip>}
              {/* a board built from a previous circuit: no downloads of files that no longer match */}
              {pcbStatus === 'done' && pcbFilename && !pcbStale && <>
                <button onClick={() => window.location.href = `${API}/download_pcb/${pcbFilename}`} style={ghostBtn}>↓ .kicad_pcb</button>
                {gerberStatus === null && <button onClick={generateGerber} style={ghostBtn}>거버</button>}
                {gerberStatus === 'loading' && <StatusChip tone="accent" busy>거버 생성 중</StatusChip>}
                {/* done: the zip itself is the "done" sign, so the narrow tab bar does not push it out of view */}
                {gerberStatus === 'done' && (gerberInfo?.zip
                  ? <a href={gerberFileUrl(gerberInfo.dir, gerberInfo.zip)} download data-testid="gerber-zip"
                      title="거버 완료 · PCB 업체(JLCPCB 등) 주문 화면에 이 zip 하나를 그대로 올립니다"
                      style={{ ...ghostBtn, textDecoration: 'none', color: TONE_COLOR.ok, borderColor: TONE_COLOR.ok, fontWeight: 600 }}>
                      ↓ 거버 zip
                    </a>
                  : <StatusChip tone="ok">거버 완료</StatusChip>)}
                {gerberStatus === 'error' && (
                  <button onClick={generateGerber} data-testid="gerber-retry" title={`거버를 만들지 못했습니다: ${gerberError}\n눌러서 다시 만듭니다`}
                    style={{ ...ghostBtn, color: 'var(--sf-danger)' }}>거버 다시</button>
                )}
              </>}
              {pcbStatus === 'error' && <button onClick={() => generatePCB()} style={{...ghostBtn, color:'var(--sf-danger)'}}>재시도</button>}
            </div>
          </div>

          {viewMode !== 'schematic' && pcbStale && pcbSource && (
            <div role="status" data-testid="pcb-stale" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              background: 'var(--sf-bg-2)', borderBottom: '1px solid var(--sf-amber)', color: 'var(--sf-amber-deep)', fontSize: 11, lineHeight: 1.5 }}>
              <span style={{ flex: 1 }}>
                {pcbStale === 'circuit'
                  ? '회로가 바뀌었습니다. 이 기판은 바뀌기 전 회로로 만든 것이라 2D·3D·DRC·거버가 지금 회로와 다를 수 있습니다.'
                  : `부품 방식이 바뀌었습니다. 이 기판은 ${pcbSource.style.toUpperCase()} 부품으로 만든 것입니다.`}
              </span>
              <button onClick={() => generatePCB()} style={{ ...ghostBtn, color: 'var(--sf-fg-muted)', flexShrink: 0 }}>PCB 다시 생성</button>
            </div>
          )}
          {viewMode !== 'schematic' && pcbStatus === 'done' && !pcbStale && pcbSummary && pcbSummary.warnings.length > 0 && (() => {
            const parsed = board?.final ? pinoutWarnings(board.final) : new Map()
            const built = (board?.final?.style ?? pcbStyle) === 'tht' ? 'tht' : 'smd'
            return (
              <div role="alert" data-testid="pcb-pinout-banner" style={{ flexShrink: 0, padding: '8px 12px', background: 'var(--sf-bg-2)',
                borderBottom: '1px solid var(--sf-danger)', color: 'var(--sf-danger)', fontSize: 11, lineHeight: 1.5 }}>
                <strong>제작 전 부품 확인 필요</strong>
                {pcbSummary.warnings.map((warning, index) => {
                  const ref = /^(\S+)/.exec(warning)?.[1] ?? ''
                  const w = [...parsed.values()].find(x => x.raw === warning)
                  const part = board?.final?.parts.find(p => p.ref === ref)
                  const other = w && part ? pinoutStyleFix(part.part, w.value, built) : null
                  return (
                    <div key={index} data-pinout-warning={ref} style={{ marginTop: 3 }}>
                      {w ? <div>{ref}: 회로에는 {w.value}라고 적혀 있지만 이 기판은 {w.assumed}의 다리 순서로 만들었습니다.</div> : <div>{warning}</div>}
                      <div style={{ color: 'var(--sf-fg-muted)', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
                        <span>해결: {other ? `${other.toUpperCase()}로 다시 만들면 ${w!.value}와 다리 순서가 같아집니다.`
                          : w ? `${w.assumed}를 사거나, 산 부품의 다리 순서가 같은지 기판의 '방향 확인'에서 맞춰 봅니다.`
                            : '선택한 실제 부품의 데이터시트와 기판 패드 번호를 대조합니다.'}</span>
                        {other && (
                          <button type="button" data-pinout-fix={ref} onClick={() => generatePCB({ style: other })}
                            style={{ ...ghostBtn, padding: '1px 8px', fontSize: 10.5, color: 'var(--sf-cyan)' }}>{other.toUpperCase()}로 다시 만들기</button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })()}

          {viewMode === 'schematic' && ercNotice && (
            <div role={ercNotice.tone === 'bad' ? 'alert' : 'status'} data-testid="erc-notice" style={{ flexShrink: 0, padding: '8px 12px', background: 'var(--sf-bg-2)',
              borderBottom: `1px solid ${ercNotice.tone === 'bad' ? 'var(--sf-danger)' : ercNotice.tone === 'warn' ? 'var(--sf-amber)' : 'var(--sf-line)'}`,
              color: ercNotice.tone === 'bad' ? 'var(--sf-danger)' : ercNotice.tone === 'warn' ? 'var(--sf-amber-deep)' : 'var(--sf-fg-muted)', fontSize: 11, lineHeight: 1.5 }}>
              <strong>{ercNotice.head}</strong>
              {ercNotice.tone === 'bad' && ercShown.map((f, i) => {
                if (f.severity !== 'error') return null
                const fix = ercFixList[i]
                // a fix shared with an earlier finding (one break seen from both ends) is shown once
                const shared = fix && ercFixList.indexOf(fix) !== i
                return (
                  <div key={i} data-erc-finding={i} style={{ marginTop: 4 }}>
                    <div>{f.message}</div>
                    {fix && !shared && (
                      <div data-erc-fix={i} style={{ color: 'var(--sf-fg-muted)', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
                        <span>해결: {fix.text}</span>
                        {fix.chat && (
                          <button type="button" data-erc-chat={i} onClick={() => chatFix(fix.chat!)} title={`AI 편집 입력칸에 넣습니다: ${fix.chat}`}
                            style={{ ...ghostBtn, padding: '1px 8px', fontSize: 10.5, color: 'var(--sf-cyan)', fontWeight: 700 }}>해결 (AI 편집에 넣기)</button>
                        )}
                        {fix.lines && canDraft && (
                          <button type="button" data-erc-draft={i} onClick={() => draftFix(fix, f.message)}
                            style={{ ...ghostBtn, padding: '1px 8px', fontSize: 10.5, color: 'var(--sf-cyan)' }}>Code 탭에 고칠 줄 넣기</button>
                        )}
                      </div>
                    )}
                    {shared && <div style={{ color: 'var(--sf-fg-muted)' }}>해결: 위 항목과 같은 문제입니다.</div>}
                  </div>
                )
              })}
              {ercNotice.lines.map((line, i) => <div key={`l${i}`} style={{ marginTop: 4 }}>{line}</div>)}
              {'retry' in ercNotice && ercNotice.retry && (
                <button type="button" data-testid="erc-retry" onClick={() => { setAiErc(null); setErcRetry(n => n + 1) }}
                  style={{ ...ghostBtn, marginTop: 4, padding: '1px 8px', fontSize: 10.5, color: 'var(--sf-cyan)' }}>다시 점검</button>
              )}
            </div>
          )}

          {/* canvas */}
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            {viewMode === 'schematic'
              ? <CircuitCanvas graph={effectiveGraph} graphDiff={graphDiff} invalidRefs={invalidRefs} />
              : viewMode === 'assembly'
                ? board?.final && board.status === 'done'
                  ? <BoardView key="assembly" mode="assembly" pcbFilename={pcbFilename ?? undefined}
                      parts={board.parts} frames={board.frames} routes={board.routes} target={board.target}
                      final={board.final} drc={board.drc} ai={board.ai} status={board.status} hpwlShelf={pcbSummary?.hpwl_shelf} />
                  : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--sf-fg-dim)', fontSize: 13 }}>
                      {pcbStatus === 'loading' ? 'PCB를 만드는 중입니다. 끝나면 여기서 부품을 체크할 수 있습니다.' : 'PCB를 생성하면 실물 기판에 부품을 올리며 체크할 수 있습니다.'}
                    </div>
              : board
                ? <BoardView key="build" pcbFilename={pcbFilename ?? undefined} onChatFix={chatFix}
                    parts={board.parts} frames={board.frames} routes={board.routes} target={board.target}
                    final={board.final} drc={board.drc} ai={board.ai} status={board.status} hpwlShelf={pcbSummary?.hpwl_shelf} />
                : <>
                    <PCBLayout graph={effectiveGraph} />
                    <div style={{ position: 'absolute', left: 12, bottom: 12, padding: '6px 10px', borderRadius: 6,
                      background: 'var(--sf-bg-2)', color: 'var(--sf-fg-dim)', fontSize: 11 }}>
                      간이 보기예요. PCB 생성을 누르면 실제 부품으로 배치되는 과정이 보여요.
                    </div>
                  </>}
            {viewMode === 'schematic' && opOpen && <OperatingPanel results={opResults} style={pcbStyle} fixes={opFixMap} onClose={() => setOpOpen(false)} onChat={chatFix}
              onDraft={canDraft ? (fix, note) => draftFix(fix, note) : undefined} />}
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
                      <button type="button" data-cir-fix={issue.code} onClick={() => chatFix(issue.chat)}
                        title={`AI 편집 입력칸에 넣습니다: ${issue.chat}`}
                        style={{ marginLeft: 'auto', flexShrink: 0, padding: '2px 9px', borderRadius: 4, border: '1px solid #9fd8c6',
                          background: 'transparent', color: '#9fd8c6', fontFamily: 'var(--sf-font-sans)', fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>
                        해결
                      </button>
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
              {sideBom.lines.map(l => (
                <div key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid var(--sf-bg-1)' }}>
                  <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10, color: 'var(--sf-amber)', minWidth: 32, flexShrink: 0 }}>{compactRefs(l.refs)}</span>
                  <span style={{ fontSize: 10, color: 'var(--sf-fg-dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.type}</span>
                  <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 9, color: 'var(--sf-fg-faint)' }}>{l.value}{l.qty > 1 ? ` ×${l.qty}` : ''}</span>
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
              <button key={t} disabled={disabled} className="sf-drawer-tab" aria-pressed={isActive}
                title={t === 'Code' && codeDirty ? '실행하지 않은 수정이 있습니다' : undefined} onClick={() => {
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
              }}>{t === 'Code' && codeDirty ? 'Code •' : t}</button>
            )
          })}
          <div style={{ flex: 1 }} />
          {drawerOpen && <button onClick={() => setDrawerOpen(false)} style={{...iconBtn, fontSize:16, color:'var(--sf-fg-dim)'}}>×</button>}
        </div>

        {/* drawer content */}
        {drawerOpen && (
          <div style={{ height: DRAWER_H, overflowY: activeTab === 'Code' ? 'hidden' : 'auto', borderTop: '1px solid var(--sf-line)' }}>
            {activeTab === 'Netlist' && (
              <>
                <KicadGuide />
                {aiEdited && <div style={drawerNote}>AI 편집 내용은 이 넷리스트 파일에 없습니다. PCB를 생성하면 편집한 회로로 넷리스트를 새로 만듭니다.</div>}
                <pre style={{ margin:0, padding:'14px 20px', fontFamily:'var(--sf-font-mono)', fontSize:12, lineHeight:1.7, color:'var(--sf-fg-muted)', overflowX:'auto' }}>
                  {result.netlist || (netText && netText.file === result.filename
                    ? netText.text ?? (netText.failed ? '넷리스트를 불러오지 못했습니다.' : '넷리스트 파일을 서버에서 찾지 못했습니다.')
                    : result.filename ? '불러오는 중…' : '이 결과에는 넷리스트 파일이 없습니다.')}
                </pre>
                {netText?.failed && netText.file === result.filename && !result.netlist && (
                  <button onClick={() => setNetText(null)} style={{ ...ghostBtn, margin: '0 20px 14px' }}>다시 불러오기</button>
                )}
              </>
            )}
            {activeTab === 'Guide' && result.guide && (
              <>
                {result.codeEdited && <div style={drawerNote}>이 안내는 처음 생성한 회로 기준입니다. 코드를 고친 뒤에는 부품 설명이 맞지 않을 수 있습니다.</div>}
                <div style={{ padding:'14px 20px', color:'var(--sf-fg-dim)', fontSize:13, lineHeight:1.7, whiteSpace:'pre-wrap' }}>{result.guide}</div>
              </>
            )}
            {activeTab === 'Sources' && (result.sources?.length ?? 0) > 0 && (
              <div style={{ padding:'14px 20px' }}>
                {(result.sources ?? []).map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener" style={{ display:'block', padding:'5px 0', color:'var(--sf-cyan)', fontSize:12, fontFamily:'var(--sf-font-mono)', wordBreak:'break-all' }}>{url}</a>
                ))}
              </div>
            )}
            {activeTab === 'BOM' && (
              <BomTable components={effectiveGraph?.components ?? []} board={bomBoard} style={bomStyle} fileBase={result.filename?.replace(/\.net$/, '')} />
            )}
            {activeTab === 'Code' && (
              <CodeEditor code={result.code ?? ''} edit={codeEdit} setEdit={setCodeEdit} onApplied={applyCodeResult}
                lastRun={lastRun} onDismissRun={() => setCodeRun(null)} aiEdited={aiEdited}
                pcbStale={pcbStale === 'circuit'} onRegeneratePcb={() => generatePCB()} canRun={!!authUser} onAuthExpired={onAuthExpired} />
            )}
            {gerberStatus === 'done' && gerberInfo && activeTab === 'Netlist' && !pcbStale && (
              <GerberFilePanel info={gerberInfo} />
            )}
          </div>
        )}
      </div>
    </div>
  )
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

/** One-line notice at the top of a drawer tab (text stays at 4.5:1 on the drawer's bg-1). */
const drawerNote: React.CSSProperties = {
  margin: '10px 20px 0', padding: '4px 10px', borderLeft: '2px solid var(--sf-amber)',
  color: 'var(--sf-fg-muted)', fontFamily: 'var(--sf-font-sans)', fontSize: 11, lineHeight: 1.5,
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

/** /generate_gerber's answer: the fabrication files in outputs/<dir>/ and the zip of all of them */
type GerberInfo = { dir: string; files?: string[]; zip?: string }

const gerberFileUrl = (dir: string, file: string) => `/download_gerber_file/${dir}/${encodeURIComponent(file)}`

function GerberFilePanel({ info }: { info: GerberInfo }) {
  const { dir, files = [], zip } = info
  const layerLabels = {
    '.gtl': '상단 동박 (Top Copper)',
    '.gbl': '하단 동박 (Bottom Copper)',
    '.gts': '상단 솔더마스크',
    '.gbs': '하단 솔더마스크',
    '.gto': '상단 실크스크린',
    '.gbo': '하단 실크스크린',
    '.gko': '기판 외곽선 (Edge Cuts)',
    '.gm1': '기판 외곽선 (Edge Cuts)',
  }
  function ext(name: string) {
    const m = name.toLowerCase().match(/(\.[a-z0-9]+)$/)
    return m ? m[1] : ''
  }
  // the drill files are split by plating: component and via holes, and the bare mounting holes
  const label = (f: string) => /-NPTH\.drl$/i.test(f) ? '드릴 · 도금 없는 구멍 (나사 구멍)'
    : /\.drl$/i.test(f) ? '드릴 · 도금 구멍 (부품 다리·비아)'
    : (layerLabels as Record<string, string>)[ext(f)] || '기타'
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
        {zip && (
          <a href={gerberFileUrl(dir, zip)} download data-testid="gerber-zip-panel" style={{
            padding: '5px 12px', borderRadius: 'var(--sf-r-sm)', border: '1px solid var(--sf-amber-line)',
            background: 'var(--sf-bg-3)', color: 'var(--sf-amber)', textDecoration: 'none',
            fontFamily: 'var(--sf-font-mono)', fontSize: 11,
          }}>↓ zip 한 번에 받기</a>
        )}
      </div>
      {zip && (
        <p style={{ margin: '0 0 10px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--sf-fg-muted)' }}>
          PCB 업체(JLCPCB 등) 주문 화면에 이 zip 하나를 그대로 올리면 됩니다. 아래는 zip 안의 파일입니다.
        </p>
      )}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 6,
      }}>
        {files.map(f => {
          const e = ext(f)
          return (
            <a
              key={f}
              href={gerberFileUrl(dir, f)}
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
                {label(f)}
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
