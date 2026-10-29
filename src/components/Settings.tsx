import { CSSProperties, Dispatch, SetStateAction } from 'react'
import { Button, IconClose } from './primitives.tsx'
import type { AppSettings } from '../types'

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 100,
  background: 'rgba(26, 22, 17, 0.45)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 20,
}
const panel = {
  width: '100%', maxWidth: 540, maxHeight: '88vh', overflow: 'auto',
  background: 'var(--sf-bg-2)', border: '1px solid var(--sf-line-strong)',
  borderRadius: 'var(--sf-r-lg)', boxShadow: 'var(--sf-shadow-lg)',
}
const section = {
  padding: '20px 24px', borderBottom: '1px solid var(--sf-line)',
}
const label = {
  fontFamily: 'var(--sf-font-mono)', fontSize: 11, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: 'var(--sf-fg-dim)', marginBottom: 12,
}
const desc = { fontSize: 12, color: 'var(--sf-fg-dim)', marginTop: 2 }

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      style={{
        position: 'relative', width: 40, height: 22,
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
  if (!open) return null

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px', borderBottom: '1px solid var(--sf-line)',
        }}>
          <div>
            <div className="sf-eyebrow" style={{ marginBottom: 4 }}>SETTINGS</div>
            <h2 className="sf-heading-m" style={{ margin: 0 }}>설정</h2>
          </div>
          <Button variant="ghost" size="sm" icon={<IconClose size={14} />} onClick={onClose} aria-label="닫기" />
        </div>

        {/* Toggles */}
        <div style={section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ ...label, marginBottom: 0 }}>자동 재시도</div>
              <div style={desc}>코드 오류·연결 안 된 핀을 GPT가 한 번 고침</div>
            </div>
            <Toggle on={settings.autoRetry} onChange={() => setSettings(s => ({ ...s, autoRetry: !s.autoRetry }))} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ ...label, marginBottom: 0 }}>모호한 프롬프트 되묻기</div>
              <div style={desc}>"베이스 앰프" 같은 짧은 입력 시 사양 질문</div>
            </div>
            <Toggle on={settings.clarify !== false} onChange={() => setSettings(s => ({ ...s, clarify: !(s.clarify !== false) }))} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div style={{ ...label, marginBottom: 0 }}>설계 계획 미리보기</div>
              <div style={desc}>회로 생성 전 부품·토폴로지 plan을 보여주고 승인 받기</div>
            </div>
            <Toggle on={settings.plan !== false} onChange={() => setSettings(s => ({ ...s, plan: !(s.plan !== false) }))} />
          </div>
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
