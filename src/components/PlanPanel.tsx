import { useState } from 'react'
import { Button, Spinner } from './primitives.tsx'

interface PlanSpec { label: string; value: string }
interface PlanPart { ref: string; type: string; value: string; role: string }
interface PlanData {
  title?: string
  summary?: string
  topology?: string
  specs?: PlanSpec[]
  parts?: PlanPart[]
  risks?: string[]
}

interface PlanPanelProps {
  originalPrompt: string
  plan: unknown
  loading: boolean
  onApprove: () => void
  onRegenerate: (feedback: string) => void
  onCancel: () => void
}

/** The design plan the model proposes before any circuit is generated. Plain document layout. */
export default function PlanPanel({ originalPrompt, plan, loading, onApprove, onRegenerate, onCancel }: PlanPanelProps) {
  const [editing, setEditing] = useState(false)
  const [feedback, setFeedback] = useState('')

  if (loading) {
    return (
      <main className="sf-flow">
        <header className="sf-flow-head">
          <div>
            <p className="sf-flow-kicker">1단계 · 설계 계획</p>
            <h1 className="sf-flow-title">{originalPrompt.split('\n')[0]}</h1>
          </div>
          <Button variant="outline" size="md" onClick={onCancel}>취소</Button>
        </header>
        <p className="sf-flow-wait"><Spinner size={14} color="var(--sf-amber)" /> 부품과 회로 구성을 정리하고 있습니다.</p>
      </main>
    )
  }

  if (!plan) return null

  const p = plan as PlanData
  const specs = p.specs || []
  const parts = p.parts || []
  const risks = p.risks || []

  return (
    <main className="sf-flow">
      <header className="sf-flow-head">
        <div>
          <p className="sf-flow-kicker">1단계 · 설계 계획 확인</p>
          <h1 className="sf-flow-title">{p.title || '설계 계획'}</h1>
          <p className="sf-flow-prompt">요청: {originalPrompt}</p>
        </div>
        <Button variant="outline" size="md" onClick={onCancel}>취소</Button>
      </header>

      {(p.summary || p.topology) && (
        <section className="sf-flow-section">
          {p.summary && <p className="sf-flow-lede">{p.summary}</p>}
          {p.topology && <p className="sf-flow-meta">회로 방식 <span>{p.topology}</span></p>}
        </section>
      )}

      {specs.length > 0 && (
        <section className="sf-flow-section">
          <h2>사양</h2>
          <dl className="sf-spec-grid">
            {specs.map((s, i) => (
              <div key={i}><dt>{s.label}</dt><dd>{s.value}</dd></div>
            ))}
          </dl>
        </section>
      )}

      {parts.length > 0 && (
        <section className="sf-flow-section">
          <h2>부품 {parts.length}개</h2>
          <div className="sf-table-wrap">
            <table className="sf-table">
              <thead><tr><th>기호</th><th>종류</th><th>값</th><th>역할</th></tr></thead>
              <tbody>
                {parts.map((part, i) => (
                  <tr key={i}>
                    <td className="mono">{part.ref}</td>
                    <td className="mono dim">{part.type}</td>
                    <td>{part.value}</td>
                    <td className="dim">{part.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {risks.length > 0 && (
        <section className="sf-flow-section">
          <h2>설계할 때 주의할 점</h2>
          <ol className="sf-notes">
            {risks.map((r, i) => <li key={i}>{r}</li>)}
          </ol>
        </section>
      )}

      {editing && (
        <section className="sf-flow-section">
          <h2>무엇을 바꿀까요</h2>
          <textarea className="sf-flow-textarea" value={feedback} onChange={e => setFeedback(e.target.value)} autoFocus
            placeholder="예: 출력 전류를 2 A로, 보호 다이오드 추가" />
        </section>
      )}

      <footer className="sf-flow-actions">
        <Button variant="ghost" size="md" onClick={() => {
          if (!editing) { setEditing(true); return }
          if (feedback.trim()) onRegenerate(feedback.trim())
          setFeedback('')
          setEditing(false)
        }}>
          {editing ? (feedback.trim() ? '이 내용으로 계획 다시 짜기' : '수정 닫기') : '계획 고치기'}
        </Button>
        <Button variant="primary" size="lg" onClick={onApprove}>이 계획으로 회로 만들기</Button>
      </footer>
    </main>
  )
}
