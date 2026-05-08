import { useState } from 'react'
import TraceField from './TraceField.jsx'
import Mascot from './Mascot.jsx'
import { Button, Chip, IconBolt, IconClose, IconWand } from './primitives.jsx'

export default function ClarifyPanel({ originalPrompt, questions, onConfirm, onSkip, onCancel }) {
  const [answers, setAnswers] = useState({})
  const [customs, setCustoms] = useState({})

  const allAnswered = questions.every(q => answers[q.key] || customs[q.key]?.trim())

  function pick(key, value) {
    setAnswers(a => ({ ...a, [key]: value }))
    setCustoms(c => ({ ...c, [key]: '' }))
  }

  function setCustom(key, val) {
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

  function handleConfirm() {
    onConfirm(buildEnrichedPrompt())
  }

  return (
    <div style={{ position: 'relative', minHeight: '100%', background: 'var(--sf-bg)', overflow: 'hidden' }}>
      <TraceField opacity={0.18} />
      <div style={{ position: 'relative', maxWidth: 760, margin: '0 auto', padding: '40px 24px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 24 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <Mascot state="idle" size={56} />
            <div>
              <div className="sf-eyebrow" style={{ marginBottom: 6 }}>조금만 더 알려주세요</div>
              <h2 className="sf-heading-l" style={{ margin: 0 }}>회로 사양 확인</h2>
              <p className="sf-body" style={{ marginTop: 6, fontFamily: 'var(--sf-font-mono)', fontSize: 13, maxWidth: 600 }}>
                <span style={{ color: 'var(--sf-cyan)' }}>›</span>{' '}
                <span style={{ color: 'var(--sf-fg-muted)' }}>{originalPrompt}</span>
              </p>
            </div>
          </div>
          <Button variant="outline" size="md" icon={<IconClose size={14} />} onClick={onCancel}>취소</Button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {questions.map((q, qi) => {
            const picked = answers[q.key]
            const custom = customs[q.key] || ''
            return (
              <div key={q.key || qi} style={{
                background: 'var(--sf-bg-2)',
                border: '1px solid var(--sf-line)',
                borderRadius: 'var(--sf-r-md)',
                padding: '18px 20px',
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
                  <span style={{
                    fontFamily: 'var(--sf-font-mono)', fontSize: 11,
                    color: 'var(--sf-amber)', letterSpacing: '0.06em',
                  }}>Q{qi + 1}</span>
                  <span style={{ fontSize: 14, color: 'var(--sf-fg)', fontWeight: 500 }}>{q.label}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(q.options || []).map((opt, i) => (
                    <Chip key={i} active={picked === opt} onClick={() => pick(q.key, opt)}>
                      {opt}
                    </Chip>
                  ))}
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginTop: 10, padding: '0 0 0 0',
                }}>
                  <IconWand size={13} />
                  <input
                    placeholder="직접 입력 (선택)"
                    value={custom}
                    onChange={e => setCustom(q.key, e.target.value)}
                    style={{
                      flex: 1, height: 32, padding: '0 12px',
                      background: 'var(--sf-bg-3)',
                      border: `1px solid ${custom ? 'var(--sf-amber-line)' : 'var(--sf-line-strong)'}`,
                      borderRadius: 'var(--sf-r-sm)',
                      color: 'var(--sf-fg)', fontFamily: 'var(--sf-font-sans)', fontSize: 13,
                      outline: 'none',
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 24, gap: 12,
        }}>
          <Button variant="ghost" size="md" onClick={onSkip}>건너뛰고 바로 생성</Button>
          <Button
            variant="primary" size="lg"
            icon={<IconBolt size={14} />}
            onClick={handleConfirm}
            disabled={!allAnswered}
          >이 옵션으로 회로 만들기</Button>
        </div>
      </div>
    </div>
  )
}
