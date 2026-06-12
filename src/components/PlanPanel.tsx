import { useState, ReactNode } from 'react'
import TraceField from './TraceField.tsx'
import Mascot from './Mascot.tsx'
import { Button, Spinner, IconBolt, IconClose, IconCheck } from './primitives.tsx'

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

export default function PlanPanel({ originalPrompt, plan, loading, onApprove, onRegenerate, onCancel }: PlanPanelProps) {
  const [editing, setEditing] = useState(false)
  const [feedback, setFeedback] = useState('')

  if (loading) {
    return (
      <div style={{ position: 'relative', minHeight: '100%', background: 'var(--sf-bg)', overflow: 'hidden' }}>
        <TraceField opacity={0.18} />
        <div style={{ position: 'relative', maxWidth: 760, margin: '0 auto', padding: '120px 24px', textAlign: 'center' }}>
          <Mascot state="working" size={64} style={{ margin: '0 auto 20px' }} />
          <div className="sf-eyebrow" style={{ marginBottom: 12 }}>STEP 01 · PLAN</div>
          <h2 className="sf-heading-l" style={{ marginBottom: 10 }}>설계 계획 짜는 중...</h2>
          <p className="sf-body" style={{ color: 'var(--sf-fg-muted)', marginBottom: 24 }}>
            부품과 토폴로지를 정리하고 있어요. 잠시만요.
          </p>
          <Spinner size={20} color="var(--sf-amber)" />
        </div>
      </div>
    )
  }

  if (!plan) return null

  const p = plan as PlanData
  const specs = p.specs || []
  const parts = p.parts || []
  const risks = p.risks || []

  return (
    <div style={{ position: 'relative', minHeight: '100%', background: 'var(--sf-bg)', overflow: 'hidden' }}>
      <TraceField opacity={0.18} />
      <div style={{ position: 'relative', maxWidth: 880, margin: '0 auto', padding: '40px 24px 80px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 24 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <Mascot state="idle" size={56} />
            <div>
              <div className="sf-eyebrow" style={{ marginBottom: 6 }}>STEP 01 · PLAN</div>
              <h2 className="sf-heading-l" style={{ margin: 0 }}>{p.title || '설계 계획'}</h2>
              <p className="sf-body" style={{ marginTop: 8, fontFamily: 'var(--sf-font-mono)', fontSize: 13, maxWidth: 600 }}>
                <span style={{ color: 'var(--sf-cyan)' }}>›</span>{' '}
                <span style={{ color: 'var(--sf-fg-muted)' }}>{originalPrompt.slice(0, 120)}{originalPrompt.length > 120 ? '…' : ''}</span>
              </p>
            </div>
          </div>
          <Button variant="outline" size="md" icon={<IconClose size={14} />} onClick={onCancel}>취소</Button>
        </div>

        {/* Summary + Topology */}
        <div style={{
          background: 'var(--sf-bg-2)',
          border: '1px solid var(--sf-line-strong)',
          borderRadius: 'var(--sf-r-lg)',
          padding: '20px 22px',
          marginBottom: 16,
        }}>
          {p.summary && (
            <p style={{
              margin: '0 0 14px',
              fontSize: 15, lineHeight: 1.6, color: 'var(--sf-fg)',
            }}>{p.summary}</p>
          )}
          {p.topology && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{
                fontFamily: 'var(--sf-font-mono)', fontSize: 11,
                color: 'var(--sf-amber)', letterSpacing: '0.14em',
              }}>TOPOLOGY</span>
              <span style={{ fontSize: 13, color: 'var(--sf-fg-muted)', fontFamily: 'var(--sf-font-mono)' }}>
                {p.topology}
              </span>
            </div>
          )}
        </div>

        {/* Specs */}
        {specs.length > 0 && (
          <Section title="사양" num="01">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
              {specs.map((s, i) => (
                <div key={i} style={{
                  background: 'var(--sf-bg-2)',
                  border: '1px solid var(--sf-line)',
                  borderRadius: 'var(--sf-r-sm)',
                  padding: '10px 12px',
                }}>
                  <div style={{ fontSize: 11, color: 'var(--sf-fg-dim)', fontFamily: 'var(--sf-font-mono)', letterSpacing: '0.06em' }}>
                    {s.label}
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--sf-fg)', fontWeight: 600, marginTop: 2 }}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Parts */}
        {parts.length > 0 && (
          <Section title="부품 목록" num="02" badge={`${parts.length}개`}>
            <div style={{
              background: 'var(--sf-bg-2)',
              border: '1px solid var(--sf-line)',
              borderRadius: 'var(--sf-r-md)',
              overflow: 'hidden',
            }}>
              {parts.map((p, i) => (
                <div key={i} style={{
                  display: 'grid',
                  gridTemplateColumns: '64px 90px 1fr 1.4fr',
                  gap: 12,
                  padding: '10px 14px',
                  borderBottom: i < parts.length - 1 ? '1px solid var(--sf-line)' : 'none',
                  alignItems: 'baseline',
                  fontSize: 13,
                }}>
                  <span style={{
                    fontFamily: 'var(--sf-font-mono)', fontSize: 12,
                    color: 'var(--sf-amber)', fontWeight: 600,
                  }}>{p.ref}</span>
                  <span style={{
                    fontFamily: 'var(--sf-font-mono)', fontSize: 11,
                    color: 'var(--sf-fg-dim)',
                  }}>{p.type}</span>
                  <span style={{ color: 'var(--sf-fg)', fontWeight: 500 }}>{p.value}</span>
                  <span style={{ color: 'var(--sf-fg-muted)' }}>{p.role}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Risks */}
        {risks.length > 0 && (
          <Section title="설계 주의사항" num="03">
            <ul style={{
              margin: 0, padding: 0, listStyle: 'none',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              {risks.map((r, i) => (
                <li key={i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  background: 'var(--sf-bg-2)',
                  border: '1px solid var(--sf-line)',
                  borderRadius: 'var(--sf-r-sm)',
                  padding: '10px 14px',
                  fontSize: 13, color: 'var(--sf-fg-muted)',
                }}>
                  <span style={{ color: 'var(--sf-amber)', marginTop: 1 }}>⚠</span>
                  <span style={{ flex: 1, lineHeight: 1.5 }}>{r}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Feedback / Regenerate */}
        {editing && (
          <div style={{ marginBottom: 16 }}>
            <div style={{
              background: 'var(--sf-bg-2)',
              border: '1px solid var(--sf-amber-line)',
              borderRadius: 'var(--sf-r-md)',
              padding: 6,
            }}>
              <textarea
                value={feedback}
                onChange={e => setFeedback(e.target.value)}
                placeholder="어떻게 바꿀까요? 예: 출력 전류 더 크게, 더 저렴한 부품, 보호 회로 추가"
                style={{
                  width: '100%', minHeight: 64,
                  background: 'transparent', border: 'none', outline: 'none', resize: 'vertical',
                  padding: '12px 14px', color: 'var(--sf-fg)',
                  fontFamily: 'var(--sf-font-sans)', fontSize: 14, lineHeight: 1.5,
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 28, gap: 12, flexWrap: 'wrap',
        }}>
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              if (editing) {
                onRegenerate(feedback.trim())
                setFeedback('')
                setEditing(false)
              } else {
                setEditing(true)
              }
            }}
          >
            {editing ? (feedback.trim() ? '피드백으로 다시 짜기' : '돌아가기') : '다시 짜기'}
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon={<IconCheck size={14} />}
            onClick={onApprove}
          >
            이대로 회로 만들기 →
          </Button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, num, badge, children }: { title: string; num: string; badge?: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <span style={{
          fontFamily: 'var(--sf-font-mono)', fontSize: 11,
          color: 'var(--sf-amber)', letterSpacing: '0.14em',
        }}>{num}</span>
        <span style={{
          fontFamily: 'var(--sf-font-mono)', fontSize: 11,
          color: 'var(--sf-fg-dim)', letterSpacing: '0.14em', textTransform: 'uppercase',
        }}>{title}</span>
        {badge && (
          <span style={{
            fontFamily: 'var(--sf-font-mono)', fontSize: 10,
            color: 'var(--sf-cyan)', letterSpacing: '0.06em',
            padding: '2px 8px',
            background: 'var(--sf-bg-3)',
            border: '1px solid var(--sf-line)',
            borderRadius: 'var(--sf-r-pill)',
          }}>{badge}</span>
        )}
        <span style={{ flex: 1, height: 1, background: 'var(--sf-line)' }} />
      </div>
      {children}
    </div>
  )
}
