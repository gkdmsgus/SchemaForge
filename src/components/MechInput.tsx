import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { mechLabel, parseMech, type Mech } from '../lib/mech'

/**
 * The board an enclosure fixes, typed before the PCB is made (기구 조건 step 1): width and height in mm and the M3 holes'
 * spots. Empty is the usual board, sized from the parts with a hole in each corner.
 */
export default function MechInput({ mech, onChange, buttonStyle }: {
  mech: Mech | null
  onChange: (m: Mech | null) => void
  buttonStyle: CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const [w, setW] = useState(mech ? String(mech.width) : '')
  const [h, setH] = useState(mech ? String(mech.height) : '')
  const [holes, setHoles] = useState(mech ? mech.holes.map(([x, y]) => `${x}, ${y}`).join('; ') : '')
  const [error, setError] = useState('')
  // the panel is drawn on the page itself, under the button: the toolbar it sits in scrolls sideways and cut it off
  // (2026-11-17, seen on the LED demo: the box opened but nothing of it showed)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    if (!open) return
    const place = () => {
      const r = button.current?.getBoundingClientRect()
      if (r) setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - 290, window.innerWidth - 298)) })
    }
    place()
    const away = (e: MouseEvent) => {
      const t = e.target as Node
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const apply = () => {
    const { mech: m, error: e } = parseMech(w, h, holes)
    setError(e)
    if (e) return
    onChange(m)
    setOpen(false)
  }
  const clear = () => { setW(''); setH(''); setHoles(''); setError(''); onChange(null); setOpen(false) }
  const field: CSSProperties = { width: '100%', padding: '4px 6px', border: '1px solid var(--sf-line)', borderRadius: 4,
    background: 'var(--sf-bg)', color: 'var(--sf-fg)', fontFamily: 'var(--sf-font-mono)', fontSize: 12 }
  const label: CSSProperties = { display: 'block', marginTop: 8, color: 'var(--sf-fg-muted)', fontSize: 11 }

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button ref={button} type="button" data-testid="mech-toggle" aria-expanded={open} aria-controls="mech-panel" onClick={() => setOpen(o => !o)}
        title="케이스가 정해져 있으면 기판 크기와 고정 구멍 자리를 적습니다"
        style={{ ...buttonStyle, color: mech ? 'var(--sf-cyan-deep)' : buttonStyle.color }}>
        {mech ? `기판 ${mechLabel(mech)}` : '기판 크기'}
      </button>
      {open && at && createPortal(
        <div ref={panel} id="mech-panel" role="dialog" aria-label="기판 크기와 고정 구멍" data-testid="mech-panel"
          style={{ position: 'fixed', top: at.top, left: at.left, zIndex: 1000, width: 290, padding: 12,
            background: 'var(--sf-bg-1)', border: '1px solid var(--sf-line-strong)', borderRadius: 8, boxShadow: 'var(--sf-shadow-md)',
            fontFamily: 'var(--sf-font-sans)', fontSize: 12, lineHeight: 1.5, color: 'var(--sf-fg)', textAlign: 'left' }}>
          <div style={{ fontWeight: 700 }}>기판 크기와 고정 구멍</div>
          <div style={{ color: 'var(--sf-fg-muted)', fontSize: 11 }}>
            케이스가 정해져 있으면 적습니다. 부품은 이 크기 안에서 구멍을 피해 놓이고, 들어가지 않으면 PCB를 만들지 않고 필요한 크기를 알려 줍니다.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <label style={{ ...label, flex: 1 }}>가로 (mm)
              <input data-testid="mech-width" inputMode="decimal" value={w} onChange={e => setW(e.target.value)} placeholder="40" style={field} />
            </label>
            <label style={{ ...label, flex: 1 }}>세로 (mm)
              <input data-testid="mech-height" inputMode="decimal" value={h} onChange={e => setH(e.target.value)} placeholder="30" style={field} />
            </label>
          </div>
          <label style={label}>고정 구멍(M3) 중심 자리: 기판 왼쪽 위에서 x, y (mm), 여러 개는 ; 로
            <textarea data-testid="mech-holes" rows={2} value={holes} onChange={e => setHoles(e.target.value)} placeholder="4, 5; 36, 5; 36, 26; 4, 26"
              style={{ ...field, resize: 'vertical' }} />
          </label>
          {error && <div role="alert" data-testid="mech-error" style={{ marginTop: 6, color: 'var(--sf-danger)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button type="button" data-testid="mech-apply" onClick={apply} style={{ ...buttonStyle, color: 'var(--sf-fg)' }}>적용</button>
            <button type="button" data-testid="mech-clear" onClick={clear} style={buttonStyle}>지우기</button>
          </div>
          <div style={{ marginTop: 8, color: 'var(--sf-fg-muted)', fontSize: 11 }}>
            비워 두면 부품에 맞춰 기판 크기를 정하고 네 모서리에 구멍을 넣습니다. 크기만 적고 구멍 자리를 비우면 구멍을 넣지 않습니다.
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
}
