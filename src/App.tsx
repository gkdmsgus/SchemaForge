import { useState, useRef, useEffect } from 'react'
import Header from './components/Header'
import Settings from './components/Settings'
import WizardPanel from './components/WizardPanel'
import ResultPanel from './components/ResultPanel'
import ClarifyPanel from './components/ClarifyPanel'
import PlanPanel from './components/PlanPanel'
import SideDrawer from './components/SideDrawer'
import AuthModal, { type AuthNotice } from './components/AuthModal'
import LegalPage from './components/LegalPage'
import { getSavedResults, saveResultToLocal } from './components/ResultPanel'
import { Button } from './components/primitives.tsx'
import {
  loadAuth, logout as apiLogout, authFetch, clearAuth, errorText, getMe, getMessages, restoreNetlist, saveSession,
  setAuthExpiredHandler, type AuthUser,
} from './api'
import type {
  AppSettings, LogLine, LogKind, Progress, ClarifyData, PlanData,
  Version, ChatSession, PendingCached, GenerateResult,
  ClarifyApiResponse, SavedSession,
} from './types'
import { useModelName } from './lib/modelName'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/main.scss'

const API = ''

const LEGAL_PAGE: 'terms' | 'privacy' | null =
  window.location.pathname === '/terms' ? 'terms' : window.location.pathname === '/privacy' ? 'privacy' : null

const DEFAULT_SETTINGS: AppSettings = { layout: '2col', skeleton: true, autoRetry: true, clarify: true, plan: true }

function getSettings(): AppSettings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('sf_settings') || '{}') } } catch { return DEFAULT_SETTINGS }
}

function detectStep(msg: string): number {
  if (/netlist|fixing/i.test(msg)) return 2
  if (msg.includes('Searching')) return 0
  if (msg.includes('GPT') || msg.includes('analysing') || msg.includes('analyzing')) return 1
  if (msg.includes('netlist') || msg.includes('Generating')) return 2
  return 0
}

const STEP_TO_PHASE = ['analyzing', 'routing', 'placing']
const STEP_TO_KIND: LogKind[] = ['info', 'plan', 'route']

/** a prompt waiting for the login: direct = generate at once, plan = from the plan step, else from the start */
type PendingRun = { prompt: string; typeKey?: string; skipCache?: boolean; direct?: boolean; plan?: boolean }

/** an error box; refused = the server refused this account, so 재시도 would only repeat the refusal */
type ErrorBox = { text: string; refused?: boolean }

// one object each, so the login modal does not reset when the same notice is set twice
const EXPIRED_NOTICE: AuthNotice = { tone: 'info', text: '로그인이 만료되었습니다. 다시 로그인하세요.' }
const CONFIRMED_NOTICE: AuthNotice = { tone: 'info', text: '가입 확인이 끝났습니다. 로그인하세요.' }

/** what Supabase put after # when it sent the sign-up mail's link back here: a notice, or null (not a link of ours) */
function confirmLinkNotice(hash: string): AuthNotice | null | undefined {
  const q = new URLSearchParams(hash.replace(/^#/, ''))
  const code = q.get('error_code')
  const err = q.get('error_description') || code || q.get('error')
  if (!err && !q.has('access_token') && !q.get('type')) return undefined
  if (err) {
    // anyone can put any words in a link's #error_description, so only a plain error code is shown, never that text
    const shown = code && /^[a-z_]{1,40}$/.test(code) ? ` (${code})` : ''
    return { tone: 'error', text: code === 'otp_expired'
      ? '가입 확인 링크가 만료되었거나 이미 쓰였습니다. 이미 확인했다면 로그인하고, 아니면 다시 가입해 새 메일을 받으세요.'
      : `가입 확인 링크를 열지 못했습니다${shown}. 다시 로그인하거나 가입해 보세요.` }
  }
  return q.get('type') === 'signup' ? CONFIRMED_NOTICE : null
}

function nowTs() {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

export default function App() {
  const modelName = useModelName()
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => loadAuth()?.user ?? null)
  // the login as of now: callbacks made before a login (the modal's onSuccess, its timers) read this
  const authRef = useRef(authUser)
  authRef.current = authUser
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [authNotice, setAuthNotice] = useState<AuthNotice | null>(null)
  // /auth/me said a deployed server will refuse this account's generation: said once near the input
  const [cannotGenerate, setCannotGenerate] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [logLines, setLogLines] = useState<LogLine[]>([])
  const [error, setError] = useState<ErrorBox | null>(null)
  const [result, setResult] = useState<GenerateResult | null>(null)
  const lastPrompt = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)
  const [settings, setSettings] = useState<AppSettings>(getSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [clarify, setClarify] = useState<ClarifyData | null>(null)
  const [plan, setPlan] = useState<PlanData | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(null)
  const [sideDrawerOpen, setSideDrawerOpen] = useState(false)
  const [initialChatSession, setInitialChatSession] = useState<ChatSession | null>(null)
  const [resultKey, setResultKey] = useState(0)
  const [pendingCached, setPendingCached] = useState<PendingCached | null>(null)
  const cachedOfferRef = useRef<HTMLDivElement>(null)
  const pendingGenerateRef = useRef<PendingRun | null>(null)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  // bumped whenever another circuit takes the screen (history open, version pick, new generation, home):
  // a slower answer for the one before (a history load, a session save) does not land on it
  const loadSeq = useRef(0)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'light')
  }, [])

  // Development/demo entry point: /?demo=motor opens a real checked-in test
  // circuit without requiring an OpenAI key. PCB generation still uses the
  // same server stream and BoardView as a normal generated circuit.
  useEffect(() => {
    const demo = new URLSearchParams(window.location.search).get('demo')
    if (!demo) return
    // StrictMode runs this twice in dev; a late second answer would remount the result view mid-PCB.
    let cancelled = false
    fetch(`/demo_result/${encodeURIComponent(demo)}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `HTTP ${r.status}`)
        return r.json() as Promise<GenerateResult>
      })
      .then(data => {
        if (cancelled) return
        lastPrompt.current = `Demo: ${demo}`
        setResult(data)
        setResultKey(k => k + 1)
      })
      .catch(e => { if (!cancelled) setError({ text: `데모 회로를 불러오지 못했습니다: ${(e as Error).message}` }) })
    return () => { cancelled = true }
  }, [])

  // 앱 시작 시 저장된 토큰이 서버에서 유효한지 검증 (만료된 토큰은 api.ts가 한 번 갱신해 본다)
  useEffect(() => {
    if (loadAuth()) checkMe()
  }, [])

  // a login that could not be renewed in the middle of a request (api.ts authFetch): ask for it again
  useEffect(() => {
    setAuthExpiredHandler(() => authExpired())
    return () => setAuthExpiredHandler(null)
  }, [])

  // back from the sign-up mail's link: say how it went, and take the tokens out of the address bar
  // (they are not kept: the person logs in with the password)
  useEffect(() => {
    const notice = confirmLinkNotice(window.location.hash)
    if (notice === undefined) return
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    if (!notice || authRef.current) return
    setAuthNotice(notice)
    setAuthModalOpen(true)
  }, [])

  /** what the server says of the saved login: 401 = gone (cleared quietly); 503 or no answer = kept, nothing shown */
  function checkMe() {
    getMe()
      .then(me => {
        if (me.status === 401) { clearAuth(); setAuthUser(null); setCannotGenerate(false) }
        else if (me.status === 200) setCannotGenerate(me.canGenerate === false)
      })
      .catch(() => {})
  }

  useEffect(() => {
    localStorage.setItem('sf_settings', JSON.stringify(settings))
  }, [settings])

  // the offer sits at the top of the page: asked from the circuit-type panel further down, it appeared out of
  // view and the make button seemed to do nothing (2026-10-29)
  useEffect(() => {
    if (pendingCached) cachedOfferRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [pendingCached])

  function goHome() {
    setResult(null)
    setError(null)
    setProgress(null)
    setLogLines([])
    setClarify(null)
    setPlan(null)
    setVersions([])
    setCurrentVersionId(null)
    setInitialChatSession(null)
    setCurrentSessionId(null)
    // a history open still loading does not come back over the home screen
    loadSeq.current++
  }

  async function handleLoadSession(session: SavedSession) {
    const resultObj: GenerateResult | null = session.result || (session.graph ? { graph: session.graph, filename: session.circuitName || '' } : null)
    if (!resultObj) return
    const seq = ++loadSeq.current
    let messages = session.messages || []
    let aiEdited = false
    if (session.dbId) {
      // a server session: its AI-editor chat is kept on the server. An AI edit saved only the circuit, not the
      // code or the netlist file, so an answer in the chat that changed the circuit means the saved one is an edit
      const saved = await getMessages(session.dbId).catch(() => null)
      if (seq !== loadSeq.current) return
      if (saved) messages = saved
      aiEdited = !!saved?.some(m => m.role === 'assistant' && (m.actions?.length ?? 0) > 0)
      // its netlist file may be gone (Render's disk is wiped on a restart or sleep): written again from the saved
      // circuit, but not when that circuit is an AI edit (the file is the code's circuit) or the chat did not come (unknown)
      if (saved && !aiEdited && resultObj.filename && resultObj.graph) {
        await restoreNetlist(resultObj.filename, resultObj.graph).catch(() => false)
        if (seq !== loadSeq.current) return
      }
    }
    setResult(resultObj)
    lastPrompt.current = session.circuitName || ''
    setInitialChatSession({ messages, graph: session.graph || null, aiEdited })
    // the version strip belongs to the generation before: its versions are other sessions
    setVersions([])
    setCurrentVersionId(null)
    // the favourite button, chat saving and circuit updates act on this session (local-only items have none)
    setCurrentSessionId(session.dbId ?? null)
    setResultKey(k => k + 1)
  }

  function selectVersion(id: string) {
    const v = versions.find(x => x.id === id)
    if (!v || id === currentVersionId) return
    loadSeq.current++
    setResult(v.result)
    lastPrompt.current = v.prompt
    setCurrentVersionId(id)
    // the saves (favourite, chat, circuit updates) go to this version's own session; none while its save is on the way
    setCurrentSessionId(v.sessionId ?? null)
    // shown as it was generated, in a fresh result view: the AI edits and chat on screen were made on the other
    // version (a logged-in session keeps them on the server, opened again from the history)
    setInitialChatSession(null)
    setResultKey(k => k + 1)
  }

  function applyCurrentVersion() {
    if (!currentVersionId) return
    // the applied version is what the saved result of its description opens next time: it kept the newest one
    // generated, so after v1 was applied "불러오기" brought back the v2 just dropped (frame review of 2026-10-30)
    const applied = versions.find(x => x.id === currentVersionId)
    if (applied) saveResultToLocal(applied.result, applied.prompt)
    setVersions(prev => {
      const idx = prev.findIndex(x => x.id === currentVersionId)
      if (idx < 0) return prev
      return prev.slice(0, idx + 1)
    })
  }

  /**
   * A refusal from /clarify, /plan or /generate stops the steps: 401 asks for the login again (the prompt waits
   * for it), 403 says why as the server wrote it, with no retry (it would be refused the same way). true = stopped.
   */
  async function refused(res: Response, pending: PendingRun): Promise<boolean> {
    if (res.status === 401) { authExpired(pending); return true }
    if (res.status === 403) { setError({ text: await errorText(res), refused: true }); return true }
    return false
  }

  async function fetchPlan(prompt: string) {
    setPlan({ originalPrompt: prompt, plan: null, loading: true })
    try {
      const res = await authFetch(`${API}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: prompt }),
      })
      if (await refused(res, { prompt, plan: true })) { setPlan(null); return }
      // any other failure: the plan is optional, so generation goes on without it
      if (!res.ok) throw new Error('plan request failed')
      const data = await res.json()
      setPlan({ originalPrompt: prompt, plan: data, loading: false })
    } catch (e) {
      setPlan(null)
      executeGenerate(prompt)
    }
  }

  function handleCancel() {
    abortRef.current?.abort()
    abortRef.current = null
    goHome()
    setLoading(false)
  }

  async function runGenerate(p: string, typeKey?: string, skipCache = false) {
    if (!p.trim() || loading) return

    // 로그인 필요: 모달 열고 로그인 후 자동 재개
    if (!authRef.current) {
      pendingGenerateRef.current = { prompt: p, typeKey, skipCache }
      setAuthModalOpen(true)
      return
    }

    if (!skipCache) {
      const cached = getSavedResults().find(s => s.prompt === p)
      if (cached) {
        setPendingCached({ prompt: p, typeKey, cached: { ...cached, graph: cached.graph ?? undefined } })
        return
      }
    }

    if (settings.clarify !== false && !typeKey) {
      try {
        const cRes = await authFetch(`${API}/clarify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: p }),
        })
        // refused: no plan or generation after it (they would be refused too)
        if (await refused(cRes, { prompt: p, typeKey, skipCache })) return
        if (cRes.ok) {
          const cData = await cRes.json() as ClarifyApiResponse
          if (cData?.clear === false && Array.isArray(cData.questions) && cData.questions.length) {
            setClarify({ originalPrompt: p, questions: cData.questions })
            return
          }
        }
      } catch (_) {}
    }

    if (settings.plan !== false) return fetchPlan(p)
    return executeGenerate(p)
  }

  /**
   * ↺ on the result screen and 재시도 after an error: the prompt already went through the questions and
   * the plan (their panels are hidden here), so generate straight away, without the cache.
   */
  function regenerate(p: string) {
    if (!p.trim() || loading) return
    if (!authRef.current) {
      pendingGenerateRef.current = { prompt: p, direct: true }
      setAuthModalOpen(true)
      return
    }
    executeGenerate(p)
  }

  /**
   * The server no longer takes the saved login (expired and not renewable, or a dev server that restarted):
   * log in again. A prompt that was refused for it waits and runs after the login.
   */
  function authExpired(pending?: PendingRun) {
    const hadLogin = !!authRef.current || !!loadAuth()
    clearAuth()
    setAuthUser(null)
    authRef.current = null
    setCannotGenerate(false)
    if (pending) pendingGenerateRef.current = pending
    if (hadLogin) setAuthNotice(EXPIRED_NOTICE)
    setAuthModalOpen(true)
  }

  async function executeGenerate(p: string) {
    setClarify(null)
    setPlan(null)
    setPendingCached(null)
    // a new circuit starts without the chat edits of the one on screen (a cached or history load seeds them),
    // and is not the session the favourite button points at until it is saved
    setInitialChatSession(null)
    setCurrentSessionId(null)
    loadSeq.current++
    lastPrompt.current = p
    setLoading(true)
    setError(null)
    setResult(null)
    setProgress({ msg: '준비 중...', step: 0 })
    setLogLines([{ ts: nowTs(), kind: 'info', msg: '생성 요청을 보냈습니다' }])

    const abort = new AbortController()
    abortRef.current = abort
    let gotResult = false

    try {
      const res = await authFetch(`${API}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: p, autoFix: settings.autoRetry !== false }),
        signal: abort.signal,
      })
      if (res.status === 401) {
        // the login ran out or is missing: log in again, and this prompt is generated right after (no error box)
        authExpired({ prompt: p, direct: true })
        setProgress(null)
        setLogLines([])
        return
      }
      if (!res.ok) {
        const why = await errorText(res)
        // a refusal (a deployed server keeps generation for listed accounts) is said as the server wrote it
        setError(res.status === 403 ? { text: why, refused: true } : { text: `서버 오류 (${res.status}): ${why}` })
        setProgress(null)
        return
      }
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (value) buf += decoder.decode(value, { stream: !done })
        if (done) {
          if (buf.trim()) {
            const parts = buf.split('\n\n')
            buf = ''
            for (const part of parts) {
              const evtM = part.match(/^event:[ ]?(.+)$/m)
              const dataM = part.match(/^data:[ ]?([\s\S]+)$/m)
              if (!evtM || !dataM) continue
              const evt = evtM[1].trim()
              const raw = dataM[1].trim()
              if (evt === 'error') {
                let msg = raw
                try { msg = JSON.parse(raw).message || raw } catch (_) {}
                setError({ text: msg }); setProgress(null); setLoading(false)
                return
              } else if (evt === 'done') {
                gotResult = true
              }
            }
          }
          break
        }
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''

        for (const part of parts) {
          const evtM = part.match(/^event:[ ]?(.+)$/m)
          const dataM = part.match(/^data:[ ]?([\s\S]+)$/m)
          if (!evtM || !dataM) continue
          const evt = evtM[1].trim()
          const raw = dataM[1].trim()

          if (evt === 'status') {
            const step = detectStep(raw)
            setProgress({ msg: raw, step })
            setLogLines(prev => {
              const next = [...prev, { ts: nowTs(), kind: STEP_TO_KIND[step] || 'info', msg: raw, cursor: true }]
              if (next.length > 1) next[next.length - 2].cursor = false
              return next.slice(-30)
            })
          } else if (evt === 'error') {
            let msg = raw
            try { msg = JSON.parse(raw).message || raw } catch (_) {}
            setError({ text: msg })
            setProgress(null)
            setLoading(false)
            setLogLines(prev => [...prev, { ts: nowTs(), kind: 'route', msg: `error: ${msg}` }])
            return
          } else if (evt === 'done') {
            gotResult = true
            const d = JSON.parse(raw)
            setResult(d)
            setResultKey(k => k + 1)
            saveResultToLocal(d, p)
            const newVersion: Version = {
              id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              prompt: p,
              result: d,
              time: Date.now(),
              label: p.slice(0, 60),
            }
            if (authRef.current) {
              const shown = loadSeq.current
              saveSession({ prompt: p, code: d.code, guide: d.guide, graph: d.graph, filename: d.filename })
                .then(id => {
                  // the version keeps its session, so picking it again in the strip points the saves back at it
                  setVersions(prev => prev.map(v => (v.id === newVersion.id ? { ...v, sessionId: id } : v)))
                  // the screen still shows this circuit (no history open, version pick or new generation since)
                  if (shown === loadSeq.current) setCurrentSessionId(id)
                })
                .catch(() => {})
            }
            setProgress(null)
            setLogLines(prev => {
              const cleared = prev.map(l => ({ ...l, cursor: false }))
              return [...cleared, { ts: nowTs(), kind: 'info', msg: 'done' }]
            })
            setVersions(prev => {
              const curId = currentVersionId
              const idx = curId ? prev.findIndex(x => x.id === curId) : -1
              const trimmed = idx >= 0 && idx < prev.length - 1 ? prev.slice(0, idx + 1) : prev
              return [...trimmed, newVersion]
            })
            setCurrentVersionId(newVersion.id)
          }
        }
      }
      if (!gotResult && !abort.signal.aborted) {
        setError({ text: '회로 생성 중 연결이 끊겼습니다. 잠시 후 다시 시도해주세요.' })
        setProgress(null)
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError({ text: `네트워크 오류: ${(e as Error).message}` })
      setProgress(null)
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  let wizardPhase = 'composer'
  if (loading) {
    const step = progress?.step ?? 0
    wizardPhase = STEP_TO_PHASE[step] || 'analyzing'
  }

  const headerVariant = result ? 'result' : (loading ? 'generating' : 'composer')
  const modelStatus = loading ? 'busy' : 'ready'

  return (
    <div style={{ minHeight: '100vh', background: 'var(--sf-bg)' }}>
      <SideDrawer
        open={sideDrawerOpen}
        onClose={() => setSideDrawerOpen(false)}
        onLoadSession={handleLoadSession}
        user={authUser}
      />
      <Header
        variant={headerVariant}
        modelLabel={modelName.model}
        modelStatus={modelStatus}
        onSettingsClick={() => setSettingsOpen(true)}
        onLogoClick={goHome}
        onMenuClick={() => setSideDrawerOpen(o => !o)}
        user={authUser}
        onAuthClick={() => setAuthModalOpen(true)}
        onLogout={async () => {
          await apiLogout()
          setAuthUser(null)
          setCannotGenerate(false)
          // the next account must not favourite or update this account's session
          setCurrentSessionId(null)
        }}
      />

      <AuthModal
        open={authModalOpen}
        notice={authNotice}
        onClose={() => {
          setAuthModalOpen(false)
          setAuthNotice(null)
          pendingGenerateRef.current = null
        }}
        onSuccess={(user, _token) => {
          setAuthUser(user)
          authRef.current = user
          setAuthNotice(null)
          checkMe()
          // 로그인 전에 시도했던 생성 요청이 있으면 이어서 실행
          const pending = pendingGenerateRef.current
          if (pending) {
            pendingGenerateRef.current = null
            setTimeout(() => (pending.direct ? executeGenerate(pending.prompt)
              : pending.plan ? fetchPlan(pending.prompt)
                : runGenerate(pending.prompt, pending.typeKey, pending.skipCache)), 100)
          }
        }}
      />

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
      />

      {LEGAL_PAGE && <LegalPage kind={LEGAL_PAGE} />}

      {!LEGAL_PAGE && pendingCached && !result && !loading && (
        <div ref={cachedOfferRef} style={{ maxWidth: 760, margin: '24px auto 0', padding: '0 24px' }}>
          <div style={{
            background: 'var(--sf-bg-2)',
            border: '1px solid var(--sf-amber-line)',
            borderRadius: 'var(--sf-r-md)',
            padding: '14px 18px',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ flex: 1, minWidth: 200, fontSize: 13.5, color: 'var(--sf-fg)' }}>
              이 회로의 저장된 결과가 있어요. 불러올까요?
            </span>
            <Button variant="ghost" size="sm" onClick={() => {
              const { prompt, cached } = pendingCached
              lastPrompt.current = prompt
              setResult(cached.result ?? null)
              setInitialChatSession({ messages: cached.messages || [], graph: cached.result?.graph || null })
              setResultKey(k => k + 1)
              setPendingCached(null)
            }}>불러오기</Button>
            <Button variant="primary" size="sm" onClick={() => {
              const { prompt, typeKey } = pendingCached
              setPendingCached(null)
              runGenerate(prompt, typeKey, true)
            }}>새로 생성</Button>
            <Button variant="ghost" size="sm" onClick={() => setPendingCached(null)}>취소</Button>
          </div>
        </div>
      )}

      {!result && !error && clarify && (
        <ClarifyPanel
          originalPrompt={clarify.originalPrompt}
          questions={clarify.questions}
          onConfirm={(enrichedPrompt: string) => {
            setClarify(null)
            if (settings.plan !== false) fetchPlan(enrichedPrompt)
            else executeGenerate(enrichedPrompt)
          }}
          onSkip={() => {
            const p = clarify.originalPrompt
            setClarify(null)
            if (settings.plan !== false) fetchPlan(p)
            else executeGenerate(p)
          }}
          onCancel={() => setClarify(null)}
        />
      )}

      {!result && !error && !clarify && plan && (
        <PlanPanel
          originalPrompt={plan.originalPrompt}
          plan={plan.plan}
          loading={plan.loading}
          onApprove={() => executeGenerate(plan.originalPrompt)}
          onRegenerate={(feedback: string) => {
            const enriched = feedback
              ? `${plan.originalPrompt}\n\n[수정 요청]\n${feedback}`
              : plan.originalPrompt
            fetchPlan(enriched)
          }}
          onCancel={() => setPlan(null)}
        />
      )}

      {!LEGAL_PAGE && authUser && cannotGenerate && !result && !loading && !error && !clarify && !plan && (
        <div role="status" data-testid="cannot-generate" style={{ maxWidth: 760, margin: '16px auto 0', padding: '0 24px' }}>
          <div style={{
            background: 'var(--sf-bg-2)', border: '1px solid var(--sf-amber-line)', borderRadius: 'var(--sf-r-md)',
            padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            fontSize: 13, color: 'var(--sf-fg)',
          }}>
            <span style={{ flex: 1, minWidth: 200 }}>이 계정은 아직 회로 생성을 쓸 수 없습니다. 데모는 누구나 볼 수 있습니다.</span>
            <Button variant="ghost" size="sm" onClick={() => { window.location.href = '/?demo=motor' }}>데모 보기</Button>
            <Button variant="ghost" size="sm" onClick={() => setCannotGenerate(false)}>닫기</Button>
          </div>
        </div>
      )}

      {!LEGAL_PAGE && !result && !error && !clarify && !plan && (
        <WizardPanel
          phase={wizardPhase}
          initialPrompt=""
          currentPrompt={lastPrompt.current}
          onSubmit={(prompt: string, typeKey?: string) => runGenerate(prompt, typeKey)}
          onCancel={handleCancel}
          logLines={logLines}
          tokensUsed={Math.min(4096, logLines.length * 200)}
          tokenBudget={4096}
        />
      )}

      {error && !result && (
        <div style={{ maxWidth: 760, margin: '40px auto', padding: '24px' }}>
          <div style={{
            background: 'var(--sf-bg-2)', border: '1px solid var(--sf-danger)',
            borderRadius: 'var(--sf-r-md)', padding: 20, color: 'var(--sf-fg)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ flex: 1 }}>{error.text}</span>
            {error.refused ? <>
              {/* the same request would be refused again: offer the demo and the way back instead of 재시도 */}
              <Button variant="ghost" size="md" onClick={() => { window.location.href = '/?demo=motor' }}>데모 보기</Button>
              <Button variant="primary" size="md" onClick={goHome}>처음으로</Button>
            </> : (
              <Button variant="primary" size="md" onClick={() => regenerate(lastPrompt.current)}>재시도</Button>
            )}
          </div>
        </div>
      )}

      {result && (
        <ErrorBoundary key={resultKey} onReset={goHome}>
        <ResultPanel
          key={resultKey}
          result={result}
          setResult={setResult}
          onRegenerate={regenerate}
          onAuthExpired={() => authExpired()}
          lastPrompt={lastPrompt.current}
          versions={versions}
          currentVersionId={currentVersionId}
          onSelectVersion={selectVersion}
          initialChatSession={initialChatSession}
          onApplyVersion={applyCurrentVersion}
          authUser={authUser}
          sessionId={currentSessionId}
        />
        </ErrorBoundary>
      )}
    </div>
  )
}
