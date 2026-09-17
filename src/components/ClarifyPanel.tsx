import { useState } from 'react'
import { Button, Chip } from './primitives.tsx'
import type { ClarifyQuestion } from '../types'

interface ClarifyPanelProps {
  originalPrompt: string
  questions: ClarifyQuestion[]
  onConfirm: (enrichedPrompt: string) => void
  onSkip: () => void
  onCancel: () => void
}

/** Questions asked when the description leaves out something the circuit needs. */
export default function ClarifyPanel({ originalPrompt, questions, onConfirm, onSkip, onCancel }: ClarifyPanelProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [customs, setCustoms] = useState<Record<string, string>>({})

  const answered = questions.filter(q => answers[q.key] || customs[q.key]?.trim()).length
  const allAnswered = answered === questions.length

  function pick(key: string, value: string) {
    setAnswers(a => ({ ...a, [key]: value }))
    setCustoms(c => ({ ...c, [key]: '' }))
  }

  function setCustom(key: string, val: string) {
    setCustoms(c => ({ ...c, [key]: val }))
    if (val.trim()) setAnswers(a => ({ ...a, [key]: '' }))
  }

  function buildEnrichedPrompt() {
    const lines = questions.map(q => {
      const val = customs[q.key]?.trim() || answers[q.key]
      if (!val) return null
      return `- ${q.label.replace(/[?:]$/, '')}: ${val}`
    }).filter(Boolean)
    if (!lines.length) return originalPrompt
    return `${originalPrompt}\n\n[추가 명세]\n${lines.join('\n')}`
  }

  return (
    <main className="sf-flow">
      <header className="sf-flow-head">
        <div>
          <p className="sf-flow-kicker">회로를 정하기 전에 {questions.length}가지만 확인합니다</p>
          <h1 className="sf-flow-title">{originalPrompt}</h1>
        </div>
        <Button variant="outline" size="md" onClick={onCancel}>취소</Button>
      </header>

      <ol className="sf-questions">
        {questions.map((q, qi) => {
          const custom = customs[q.key] || ''
          return (
            <li key={q.key || qi}>
              <h2>{q.label}</h2>
              <div className="options">
                {(q.options || []).map((opt, i) => (
                  <Chip key={i} active={answers[q.key] === opt} onClick={() => pick(q.key, opt)}>{opt}</Chip>
                ))}
              </div>
              <input className="sf-flow-input" placeholder="목록에 없으면 직접 입력" value={custom}
                onChange={e => setCustom(q.key, e.target.value)} />
            </li>
          )
        })}
      </ol>

      <footer className="sf-flow-actions">
        <Button variant="ghost" size="md" onClick={onSkip}>답하지 않고 생성</Button>
        <span className="sf-flow-count">{answered} / {questions.length} 답함</span>
        <Button variant="primary" size="lg" onClick={() => onConfirm(buildEnrichedPrompt())} disabled={!allAnswered}>
          이 답으로 회로 만들기
        </Button>
      </footer>
    </main>
  )
}
