// 의견 남기기: a visitor's 1-5 rating, a short opinion and the circuit on the screen, sent with no login
// (POST /feedback, server/feedback.ts). Asked for on 2026-11-17 in place of a separate survey form for the presentation.
// The server says in Korean why it refused one; the dialog shows that sentence as it is. scripts/check_feedback.mjs

import { CSSProperties, useEffect, useId, useRef, useState } from 'react'
import { Button, IconClose } from './primitives.tsx'
import { ApiError, sendFeedback } from '../api'

const COMMENT_MAX = 500
const CIRCUIT_MAX = 80
const RATINGS: [number, string][] = [[1, '별로예요'], [2, '아쉬워요'], [3, '보통이에요'], [4, '좋아요'], [5, '아주 좋아요']]

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 100,
  background: 'rgba(26, 22, 17, 0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16,
}
const panel: CSSProperties = {
  width: '100%', maxWidth: 460, maxHeight: '90vh', overflow: 'auto',
  background: 'var(--sf-bg-2)', border: '1px solid var(--sf-line-strong)',
  borderRadius: 'var(--sf-r-lg)', boxShadow: 'var(--sf-shadow-lg)', outline: 'none',
}
const label: CSSProperties = { display: 'block', fontFamily: 'var(--sf-font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--sf-fg)', marginBottom: 6 }
const field: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px',
  background: 'var(--sf-bg)', color: 'var(--sf-fg)', border: '1px solid var(--sf-line-strong)',
  borderRadius: 'var(--sf-r-sm)', fontFamily: 'var(--sf-font-sans)', fontSize: 14,
}
const hint: CSSProperties = { fontSize: 12, color: 'var(--sf-fg-dim)', marginTop: 4 }

interface FeedbackDialogProps {
  open: boolean
  onClose: () => void
  /** the circuit on the screen (a demo's name or the description), filled in for the visitor to keep or clear */
  circuit?: string
}

/** mounted on each opening, so it starts empty with the circuit on the screen now already filled in */
export default function FeedbackDialog({ open, ...rest }: FeedbackDialogProps) {
  return open ? <OpenDialog {...rest} /> : null
}

function OpenDialog({ onClose, circuit = '' }: Omit<FeedbackDialogProps, 'open'>) {
  const id = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [where, setWhere] = useState(() => [...circuit.replace(/\s+/g, ' ').trim()].slice(0, CIRCUIT_MAX).join(''))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  // Esc closes it, as the settings and login windows do
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  // the focus goes into the dialog when it opens and back to the 의견 button when it closes
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => back?.focus()
  }, [])

  const length = [...comment].length
  const submit = async () => {
    if (!rating || sending) return
    setSending(true); setError('')
    try {
      await sendFeedback({ rating, comment: comment.trim() || undefined, circuit: where.trim() || undefined })
      setSent(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 보내 주세요.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        style={panel} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--sf-line)' }}>
          <h2 id={`${id}-title`} className="sf-heading-m" style={{ margin: 0 }}>의견 남기기</h2>
          <Button variant="ghost" size="sm" icon={<IconClose size={14} />} onClick={onClose} aria-label="닫기" />
        </div>

        {sent ? (
          <div style={{ padding: '24px 20px', textAlign: 'center' }}>
            <p role="status" style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--sf-fg)' }}>보내 주셔서 고마워요! 더 나아지는 데 쓰겠습니다.</p>
            <Button variant="primary" size="md" onClick={onClose}>닫기</Button>
          </div>
        ) : (
          <form style={{ padding: '16px 20px 20px' }} onSubmit={e => { e.preventDefault(); void submit() }}>
            <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--sf-fg-dim)' }}>
              써 보신 느낌을 짧게 알려 주세요. 로그인하지 않아도 되고, 이름이나 메일 주소는 받지 않아요.
            </p>

            <div id={`${id}-rating`} style={label}>얼마나 쓸 만했나요?</div>
            <div role="radiogroup" aria-labelledby={`${id}-rating`} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              {RATINGS.map(([n, word]) => (
                <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n}점, ${word}`}
                  onClick={() => setRating(n)}
                  style={{
                    flex: 1, minWidth: 0, padding: '8px 0', cursor: 'pointer', fontSize: 15, lineHeight: 1.2,
                    background: rating >= n ? 'var(--sf-amber-fill)' : 'var(--sf-bg)',
                    color: rating >= n ? '#fff8ef' : 'var(--sf-fg-dim)',
                    border: `1px solid ${rating >= n ? 'var(--sf-amber-fill)' : 'var(--sf-line-strong)'}`,
                    borderRadius: 'var(--sf-r-sm)',
                  }}>
                  ★<span style={{ display: 'block', fontSize: 12 }}>{n}</span>
                </button>
              ))}
            </div>
            <div style={{ ...hint, marginBottom: 16, minHeight: 16 }}>{rating ? RATINGS[rating - 1][1] : '별을 눌러 골라 주세요.'}</div>

            <label htmlFor={`${id}-comment`} style={label}>하고 싶은 말 (선택)</label>
            <textarea id={`${id}-comment`} value={comment} rows={4} maxLength={COMMENT_MAX}
              onChange={e => setComment(e.target.value)} placeholder="좋았던 점, 헷갈렸던 점, 있었으면 하는 기능"
              style={{ ...field, resize: 'vertical' }} />
            <div style={{ ...hint, textAlign: 'right' }} aria-live="polite">{length} / {COMMENT_MAX}자</div>

            <label htmlFor={`${id}-circuit`} style={{ ...label, marginTop: 8 }}>보던 회로 (선택)</label>
            <input id={`${id}-circuit`} value={where} maxLength={CIRCUIT_MAX} onChange={e => setWhere(e.target.value)}
              placeholder="예: 모터 데모" style={field} />
            <div style={hint}>메일 주소 같은 개인정보는 적지 마세요. <a href="/privacy" target="_blank" rel="noreferrer">처리방침</a></div>

            {error && <p role="alert" style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--sf-danger)' }}>{error}</p>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <Button variant="ghost" size="md" type="button" onClick={onClose}>취소</Button>
              <Button variant="primary" size="md" type="submit" disabled={!rating || sending} loading={sending}>보내기</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
