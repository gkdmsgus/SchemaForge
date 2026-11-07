import { CSSProperties, Dispatch, SetStateAction, useEffect, useId, useRef } from 'react'
import { Button, IconClose } from './primitives.tsx'
import type { AppSettings } from '../types'

// no blur behind: the dim layer is enough to set the dialog apart
const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 100,
  background: 'rgba(26, 22, 17, 0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 20,
}
const panel: CSSProperties = {
  width: '100%', maxWidth: 540, maxHeight: '88vh', overflow: 'auto',
  background: 'var(--sf-bg-2)', border: '1px solid var(--sf-line-strong)',
  borderRadius: 'var(--sf-r-lg)', boxShadow: 'var(--sf-shadow-lg)', outline: 'none',
}
const section = {
  padding: '20px 24px', borderBottom: '1px solid var(--sf-line)',
}
// Korean labels in the sans face without tracking: in spaced capitals mono, 자동 재시도 read '자 동 재 시 도'
const label: CSSProperties = { fontFamily: 'var(--sf-font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--sf-fg)' }
const desc = { fontSize: 12, color: 'var(--sf-fg-dim)', marginTop: 2 }

/** an on/off switch named by its label, its state read out as on or off */
function Toggle({ on, onChange, labelledBy, describedBy }: { on: boolean; onChange: () => void; labelledBy: string; describedBy: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={onChange}
      style={{
        position: 'relative', width: 40, height: 22, flexShrink: 0,
        background: on ? 'var(--sf-amber)' : 'var(--sf-bg-3)',
        border: `1px solid ${on ? 'var(--sf-amber)' : 'var(--sf-line-strong)'}`,
        borderRadius: 999, cursor: 'pointer',
        transition: 'all var(--sf-dur) var(--sf-ease)', padding: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 20 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: on ? 'var(--sf-ink-on-amber)' : 'var(--sf-fg-muted)',
        transition: 'left var(--sf-dur) var(--sf-ease)',
      }} />
    </button>
  )
}

interface SettingsProps {
  open: boolean
  onClose: () => void
  settings: AppSettings
  setSettings: Dispatch<SetStateAction<AppSettings>>
}

export default function Settings({ open, onClose, settings, setSettings }: SettingsProps) {
  const id = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  // Esc closes it, as the login window does
  useEffect(() => {
    if (!open) return
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [open, onClose])

  // the focus goes into the dialog when it opens and back where it was (the settings button) when it closes
  useEffect(() => {
    if (!open) return
    const back = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => back?.focus()
  }, [open])

  if (!open) return null

  const rows: { key: string; label: string; desc: string; on: boolean; flip: () => void }[] = [
    { key: 'retry', label: '자동 재시도', desc: '회로 코드가 실행되지 않거나 연결 안 된 핀이 있으면 AI가 한 번 고칩니다.',
      on: settings.autoRetry, flip: () => setSettings(s => ({ ...s, autoRetry: !s.autoRetry })) },
    { key: 'clarify', label: '모호한 프롬프트 되묻기', desc: '"베이스 앰프"처럼 짧게 적으면 회로를 만들기 전에 사양을 묻습니다.',
      on: settings.clarify !== false, flip: () => setSettings(s => ({ ...s, clarify: !(s.clarify !== false) })) },
    { key: 'plan', label: '설계 계획 미리보기', desc: '회로를 만들기 전에 쓸 부품과 구성을 보여 주고 확인받습니다.',
      on: settings.plan !== false, flip: () => setSettings(s => ({ ...s, plan: !(s.plan !== false) })) },
  ]

  return (
    <div style={overlay} onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        style={panel} onClick={e => e.stopPropagation()}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px', borderBottom: '1px solid var(--sf-line)',
        }}>
          <h2 id={`${id}-title`} className="sf-heading-m" style={{ margin: 0 }}>설정</h2>
          <Button variant="ghost" size="sm" icon={<IconClose size={14} />} onClick={onClose} aria-label="닫기" />
        </div>

        {/* Toggles */}
        <div style={section}>
          {rows.map((r, i) => (
            <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: i < rows.length - 1 ? 16 : 0 }}>
              <div style={{ flex: 1 }}>
                <div id={`${id}-${r.key}`} style={label}>{r.label}</div>
                <div id={`${id}-${r.key}-desc`} style={desc}>{r.desc}</div>
              </div>
              <Toggle on={r.on} onChange={r.flip} labelledBy={`${id}-${r.key}`} describedBy={`${id}-${r.key}-desc`} />
            </div>
          ))}
        </div>

        <div style={{
          padding: '14px 24px', textAlign: 'center',
          fontFamily: 'var(--sf-font-mono)', fontSize: 11, color: 'var(--sf-fg-dim)',
          letterSpacing: '0.06em',
        }}>
          SchemaForge v0.4 · React + Node
        </div>
      </div>
    </div>
  )
}
