import { useEffect, useState } from 'react'
import { OP_RULES, operatingHeadline, type OpResult, type OpState } from '../lib/operatingCheck'
import { STATE_TONE, TONE_COLOR, stateWord } from '../lib/boardChecks'
import { StatusChip } from './StatusUi'
import type { Fix } from '../lib/fixes'

// "Does it work?" on the schematic, before a PCB exists. It never blocks PCB generation:
// it says which parts will not work and why, with the numbers.

const MONO = 'var(--sf-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const SANS = 'var(--sf-font-sans, system-ui, -apple-system, "Segoe UI", sans-serif)'
const LINE = 'rgba(0, 0, 0, 0.14)'
const FG = '#23262b'
const DIM = '#6b7079'
const RANK: Record<OpState, number> = { pass: 0, unknown: 1, warn: 2, error: 3 }

export default function OperatingPanel({ results, style, fixes, onDraft, onClose }: {
  results: OpResult[]; style: 'smd' | 'tht'
  /** fixes found by re-running the checks on a changed copy, keyed rule|ref */
  fixes?: Map<string, Fix>
  /** put a fix's lines into the Code tab (absent: the code no longer describes the circuit) */
  onDraft?: (fix: Fix, note: string) => void
  /** shown from the chip in the tab bar; the close button and Esc hide it again */
  onClose: () => void
}) {
  const head = operatingHeadline(results)
  const [detail, setDetail] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!results.length) return null
  const sorted = [...results].sort((a, b) => RANK[b.state] - RANK[a.state] ||
    OP_RULES.findIndex(r => r[0] === a.rule) - OP_RULES.findIndex(r => r[0] === b.rule))
  const label = Object.fromEntries(OP_RULES)

  return (
    // below the schematic's own toolbar (zoom buttons), under the chip that opened it
    <div id="operating-panel" data-testid="operating-panel" role="dialog" aria-label="동작 검사"
      style={{ position: 'absolute', right: 14, top: 52, zIndex: 19, width: 380, maxWidth: 'calc(100% - 28px)',
        maxHeight: 'calc(100% - 66px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 8,
        background: 'rgba(255, 255, 255, 0.97)', border: `1px solid ${LINE}`, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.14)',
        color: FG, fontFamily: MONO, fontSize: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: '7px 10px', flexShrink: 0 }}>
        <StatusChip tone={STATE_TONE[head.state]} testId="operating-summary">{head.text}</StatusChip>
        <span style={{ color: DIM, fontFamily: SANS }}>동작 검사 · {style.toUpperCase()} 부품 기준</span>
        <button type="button" onClick={onClose} aria-label="동작 검사 닫기" data-testid="operating-close"
          style={{ marginLeft: 'auto', padding: '0 4px', border: 'none', background: 'transparent', color: DIM, fontSize: 14, lineHeight: 1, cursor: 'pointer' }}>✕</button>
      </div>
      {(
        <div style={{ overflowY: 'auto', minHeight: 0, borderTop: `1px solid ${LINE}` }}>
          <div style={{ padding: '6px 10px', color: DIM, fontFamily: SANS, lineHeight: 1.45 }}>
            부품 값으로 계산해 "실제로 동작하는지"를 봅니다. 필요한 값(커넥터로 들어오는 전원, 모터 전류)을 모르면 판단 불가로 둡니다. PCB 생성은 막지 않습니다.
          </div>
          {sorted.map((r, i) => {
            const key = `${r.rule}-${r.ref}-${i}`
            const shown = detail[key] ?? r.state === 'error'
            const c = TONE_COLOR[STATE_TONE[r.state]]
            return (
              <div key={key} data-op={r.ref} data-op-rule={r.rule} data-op-state={r.state} style={{ borderTop: `1px solid ${LINE}` }}>
                <button type="button" onClick={() => setDetail(d => ({ ...d, [key]: !shown }))} aria-expanded={shown}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', boxSizing: 'border-box', padding: '6px 10px',
                    border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', color: FG, font: 'inherit' }}>
                  <span style={{ flexShrink: 0, minWidth: 52, textAlign: 'center', padding: '0 5px', borderRadius: 3, border: `1px solid ${c}`,
                    color: c, fontSize: 10, fontWeight: 700, lineHeight: '16px', whiteSpace: 'nowrap' }}>{stateWord(r.state)}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 9.5, color: DIM }}>{label[r.rule]}</span>
                    <span style={{ display: 'block', fontFamily: SANS, fontSize: 11.5, lineHeight: 1.45 }}>{r.summary}</span>
                  </span>
                </button>
                {shown && r.detail.length > 0 && (
                  <div style={{ padding: '0 10px 7px 70px' }}>
                    {r.detail.map((line, k) => <div key={k} style={{ color: DIM, fontSize: 10.5, lineHeight: 1.45 }}>{line}</div>)}
                  </div>
                )}
                {r.state !== 'pass' && (() => {
                  const fix = fixes?.get(`${r.rule}|${r.ref}`)
                  const text = fix?.text ?? r.fix ?? (r.cause && r.cause !== r.ref ? `${r.cause}의 문제를 먼저 고치면 이 항목도 다시 판단합니다.` : null)
                  if (!text) return null
                  return (
                    <div data-op-fix={r.ref} style={{ padding: '0 10px 7px 70px', fontFamily: SANS, fontSize: 11, lineHeight: 1.45, color: FG }}>
                      <span style={{ color: TONE_COLOR.ok, fontWeight: 700 }}>해결 </span>{text}
                      {fix?.lines && onDraft && (
                        <button type="button" data-op-draft={r.ref} onClick={() => onDraft(fix, r.summary)}
                          style={{ display: 'block', marginTop: 4, padding: '2px 8px', borderRadius: 4, border: `1px solid ${TONE_COLOR.ok}`,
                            background: 'transparent', color: TONE_COLOR.ok, fontFamily: SANS, fontSize: 10.5, cursor: 'pointer' }}>
                          Code 탭에 고칠 줄 넣기
                        </button>
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
