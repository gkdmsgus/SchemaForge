import { useState, useRef, useEffect } from 'react'
import Header from './components/Header'
import Settings from './components/Settings'
import WizardPanel from './components/WizardPanel'
import ResultPanel from './components/ResultPanel'
import ClarifyPanel from './components/ClarifyPanel'
import PlanPanel from './components/PlanPanel'
import SideDrawer from './components/SideDrawer'
import AuthModal from './components/AuthModal'
import { getSavedResults, saveResultToLocal } from './components/ResultPanel'
import { Button } from './components/primitives.tsx'
import { loadAuth, logout as apiLogout, type AuthUser } from './api'
import type {
  AppSettings, LogLine, LogKind, Progress, ClarifyData, PlanData,
  Version, ChatSession, PendingCached, GenerateResult,
  ClarifyApiResponse, SavedSession,
} from './types'
import './styles/main.scss'

const API = ''

const DEFAULT_SETTINGS: AppSettings = { layout: '2col', skeleton: true, autoRetry: true, clarify: true, plan: true }

function getSettings(): AppSettings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('sf_settings') || '{}') } } catch { return DEFAULT_SETTINGS }
}

function detectStep(msg: string): number {
  if (msg.includes('Searching')) return 0
  if (msg.includes('GPT') || msg.includes('analysing') || msg.includes('analyzing')) return 1
  if (msg.includes('netlist') || msg.includes('Generating')) return 2
  return 0
}

const STEP_TO_PHASE = ['analyzing', 'routing', 'placing']
const STEP_TO_KIND: LogKind[] = ['info', 'plan', 'route']

function nowTs() {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => loadAuth()?.user ?? null)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [logLines, setLogLines] = useState<LogLine[]>([])
  const [error, setError] = useState<string | null>(null)
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

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'light')
  }, [])

  useEffect(() => {
    localStorage.setItem('sf_settings', JSON.stringify(settings))
  }, [settings])

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
  }

  function handleLoadSession(session: SavedSession) {
    const resultObj: GenerateResult | null = session.result || (session.graph ? { graph: session.graph, filename: session.circuitName || '' } : null)
    if (!resultObj) return
    setResult(resultObj)
    lastPrompt.current = session.circuitName || ''
    setInitialChatSession({ messages: session.messages || [], graph: session.graph || null })
    setResultKey(k => k + 1)
  }

  function selectVersion(id: string) {
    const v = versions.find(x => x.id === id)
    if (!v) return
    setResult(v.result)
    lastPrompt.current = v.prompt
    setCurrentVersionId(id)
  }

  function applyCurrentVersion() {
    if (!currentVersionId) return
    setVersions(prev => {
      const idx = prev.findIndex(x => x.id === currentVersionId)
      if (idx < 0) return prev
      return prev.slice(0, idx + 1)
    })
  }

  async function fetchPlan(prompt: string) {
    setPlan({ originalPrompt: prompt, plan: null, loading: true })
    try {
      const res = await fetch(`${API}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: prompt }),
      })
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

    if (!skipCache) {
      const cached = getSavedResults().find(s => s.prompt === p)
      if (cached) {
        setPendingCached({ prompt: p, typeKey, cached: { ...cached, graph: cached.graph ?? undefined } })
        return
      }
    }

    if (settings.clarify !== false && !typeKey) {
      try {
        const cRes = await fetch(`${API}/clarify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: p }),
        })
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

  async function executeGenerate(p: string) {
    setClarify(null)
    setPlan(null)
    setPendingCached(null)
    lastPrompt.current = p
    setLoading(true)
    setError(null)
    setResult(null)
    setProgress({ msg: '준비 중...', step: 0 })
    setLogLines([{ ts: nowTs(), kind: 'info', msg: `forge generate "${p.slice(0, 60)}"` }])

    const abort = new AbortController()
    abortRef.current = abort
    let gotResult = false

    try {
      const res = await fetch(`${API}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: p }),
        signal: abort.signal,
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`서버 오류 (${res.status}): ${text.slice(0, 200)}`)
      }
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''

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
            setError(msg)
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
            setProgress(null)
            setLogLines(prev => {
              const cleared = prev.map(l => ({ ...l, cursor: false }))
              return [...cleared, { ts: nowTs(), kind: 'info', msg: 'done' }]
            })
            const newVersion = {
              id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              prompt: p,
              result: d,
              time: Date.now(),
              label: p.slice(0, 60),
            }
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
        setError('회로 생성 중 연결이 끊겼습니다. 잠시 후 다시 시도해주세요.')
        setProgress(null)
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError(`네트워크 오류: ${(e as Error).message}`)
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
      />
      <Header
        variant={headerVariant}
        modelLabel="GPT-4o"
        modelStatus={modelStatus}
        onSettingsClick={() => setSettingsOpen(true)}
        onLogoClick={goHome}
        onMenuClick={() => setSideDrawerOpen(o => !o)}
        user={authUser}
        onAuthClick={() => setAuthModalOpen(true)}
        onLogout={async () => { await apiLogout(); setAuthUser(null) }}
      />

      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        onSuccess={(user) => setAuthUser(user)}
      />

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
      />

      {pendingCached && !result && !loading && (
        <div style={{ maxWidth: 760, margin: '24px auto 0', padding: '0 24px' }}>
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

      {!result && !error && !clarify && !plan && (
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
            <span style={{ flex: 1 }}>{error}</span>
            <Button variant="primary" size="md" onClick={() => runGenerate(lastPrompt.current)}>재시도</Button>
          </div>
        </div>
      )}

      {result && (
        <ResultPanel
          key={resultKey}
          result={result}
          setResult={setResult}
          onRegenerate={runGenerate}
          lastPrompt={lastPrompt.current}
          versions={versions}
          currentVersionId={currentVersionId}
          onSelectVersion={selectVersion}
          initialChatSession={initialChatSession}
          onApplyVersion={applyCurrentVersion}
        />
      )}
    </div>
  )
}
