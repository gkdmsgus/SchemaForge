import type { ReactNode } from 'react'
import { STATE_TONE, TONE_COLOR, stampText, type CheckRow, type Tone } from '../lib/boardChecks'

// Status pieces shared by the board view and the result toolbar: a chip (dot + short
// label) for "what state is this in", and a stamp for one rule's result. Colours come
// from TONE_COLOR so both read the same on white panels and on the beige app.

const MONO = 'var(--sf-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const PULSE = '@keyframes sf-chip-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.25 } }'

export function StatusChip({ tone, busy = false, title, testId, children }: {
  tone: Tone
  busy?: boolean        // work in progress: the dot pulses
  title?: string
  testId?: string
  children: ReactNode
}) {
  const c = TONE_COLOR[tone]
  return (
    <span data-testid={testId} data-tone={tone} title={title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '1px 8px', borderRadius: 4,
        border: '1px solid rgba(0, 0, 0, 0.14)', background: 'rgba(255, 255, 255, 0.72)', color: c,
        fontFamily: MONO, fontSize: 10.5, fontWeight: 600, lineHeight: '18px', letterSpacing: '0.02em',
        whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', cursor: title ? 'help' : undefined }}>
      {busy && <style>{PULSE}</style>}
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: c, flexShrink: 0,
        animation: busy ? 'sf-chip-pulse 1.1s ease-in-out infinite' : undefined }} />
      {children}
    </span>
  )
}

export function Stamp({ row }: { row: Pick<CheckRow, 'state' | 'count'> }) {
  const c = TONE_COLOR[STATE_TONE[row.state]]
  return (
    <span data-stamp={row.state}
      style={{ flexShrink: 0, minWidth: 52, textAlign: 'center', padding: '0 6px', borderRadius: 3,
        border: `1px solid ${c}`, color: c, fontFamily: MONO, fontSize: 10, fontWeight: 700,
        lineHeight: '16px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
      {stampText(row)}
    </span>
  )
}
