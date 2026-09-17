// ============================================================================
// WizardPanel — composer, and the live view while a circuit is generated.
//   phase 'composer'                     → FormComposer (home)
//   phase 'analyzing' | 'routing' | ...  → Generating: the real server steps and log
// Everything shown while generating comes from the server stream: no mascot,
// no decorative trace animation, no invented token counter.
// ============================================================================

import { useEffect, useState } from 'react'
import FormComposer from './FormComposer.tsx'
import { Button, Spinner } from './primitives.tsx'
import type { LogLine } from '../types'

// The server sends three status messages (server/index.ts /generate); App maps them to these phases.
const STEPS = [
  { key: 'analyzing', label: '요구사항 정리', note: '설명을 회로 사양으로 풀어 씁니다' },
  { key: 'routing',   label: '회로 작성',     note: 'GPT-4o가 부품과 연결을 skidl 코드로 씁니다' },
  { key: 'placing',   label: '넷리스트 생성', note: '코드를 실행해 .net을 만듭니다. 오류가 나면 코드를 고쳐 다시 실행합니다' },
]

interface WizardPanelProps {
  phase?: string
  initialPrompt?: string
  currentPrompt?: string
  onSubmit: (prompt: string, typeKey?: string) => void
  onCancel?: () => void
  logLines?: LogLine[]
  tokensUsed?: number
  tokenBudget?: number
}

export default function WizardPanel({ phase = 'composer', currentPrompt = '', onSubmit, onCancel, logLines = [] }: WizardPanelProps) {
  if (phase === 'composer') return <FormComposer onSubmit={onSubmit} />
  return <Generating phase={phase} prompt={currentPrompt} onCancel={onCancel} lines={logLines} />
}

function Generating({ phase, prompt, onCancel, lines }: { phase: string; prompt: string; onCancel?: () => void; lines: LogLine[] }) {
  const current = Math.max(0, STEPS.findIndex(s => s.key === phase))
  const seconds = useElapsed()
  const [head, ...rest] = (prompt.trim() || '회로 생성').split('\n')
  const detail = rest.join('\n').trim()

  return (
    <main className="sf-flow">
      <header className="sf-flow-head">
        <div>
          <p className="sf-flow-kicker">회로 만드는 중 · {seconds}초</p>
          <h1 className="sf-flow-title">{head}</h1>
          {detail && <p className="sf-flow-prompt">{detail}</p>}
        </div>
        <Button variant="outline" size="md" onClick={onCancel}>취소</Button>
      </header>

      <ol className="sf-steps">
        {STEPS.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'todo'
          return (
            <li key={s.key} className={`sf-step is-${state}`}>
              <span className="mark">{state === 'active' ? <Spinner size={12} color="var(--sf-amber)" /> : state === 'done' ? '완료' : `${i + 1}`}</span>
              <div>
                <strong>{s.label}</strong>
                <p>{s.note}</p>
              </div>
            </li>
          )
        })}
      </ol>

      <section className="sf-flow-section">
        <h2>서버 기록</h2>
        {lines.length === 0
          ? <p className="sf-flow-empty">서버 응답을 기다리는 중입니다.</p>
          : (
            <ol className="sf-log">
              {lines.map((l, i) => (
                <li key={i} className={l.cursor ? 'is-live' : ''}>
                  <time>{l.ts}</time>
                  <span>{l.msg.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]+\s*/u, '')}</span>
                </li>
              ))}
            </ol>
          )}
        <p className="sf-flow-note">보통 30초~1분 걸립니다. 끝나면 회로도 화면으로 넘어가고, 거기서 PCB를 만들 수 있습니다.</p>
      </section>
    </main>
  )
}

function useElapsed() {
  const [start] = useState(() => Date.now())
  const [now, setNow] = useState(start)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return Math.floor((now - start) / 1000)
}
