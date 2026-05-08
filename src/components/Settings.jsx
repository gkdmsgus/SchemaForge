import { useState } from 'react'
import { Button, IconClose, IconCheck } from './primitives.jsx'

function getFavorites() {
  try { return JSON.parse(localStorage.getItem('sf_favorites') || '[]') } catch { return [] }
}

const overlay = {
  position: 'fixed', inset: 0, zIndex: 100,
  background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
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

function OptionButton({ active, onClick, children, icon }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 8, padding: '10px 14px',
        background: active ? 'var(--sf-amber-soft)' : 'var(--sf-bg-3)',
        border: `1px solid ${active ? 'var(--sf-amber-line)' : 'var(--sf-line-strong)'}`,
        color: active ? 'var(--sf-amber)' : 'var(--sf-fg-muted)',
        borderRadius: 'var(--sf-r-sm)',
        fontSize: 13, fontFamily: 'var(--sf-font-sans)', fontWeight: 500,
        cursor: 'pointer', transition: 'all var(--sf-dur) var(--sf-ease)',
      }}
    >
      {icon}{children}
    </button>
  )
}

function Toggle({ on, onChange }) {
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
        background: on ? '#11140f' : 'var(--sf-fg-muted)',
        transition: 'left var(--sf-dur) var(--sf-ease)',
      }} />
    </button>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px',
        background: active ? 'var(--sf-amber-soft)' : 'var(--sf-bg-3)',
        border: `1px solid ${active ? 'var(--sf-amber-line)' : 'var(--sf-line-strong)'}`,
        color: active ? 'var(--sf-amber)' : 'var(--sf-fg-muted)',
        borderRadius: 'var(--sf-r-pill)',
        fontSize: 12, fontFamily: 'var(--sf-font-mono)', fontWeight: 500,
        cursor: 'pointer', transition: 'all var(--sf-dur) var(--sf-ease)',
      }}
    >{children}</button>
  )
}

export default function Settings({ open, onClose, settings, setSettings, onClearFavorites }) {
  const [favs, setFavs] = useState(getFavorites)

  function removeFav(name) {
    const next = favs.filter(f => f.name !== name)
    setFavs(next)
    localStorage.setItem('sf_favorites', JSON.stringify(next))
    if (onClearFavorites) onClearFavorites()
  }

  function clearAllFavs() {
    setFavs([])
    localStorage.removeItem('sf_favorites')
    if (onClearFavorites) onClearFavorites()
  }

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

        {/* Layout */}
        <div style={section}>
          <div style={label}>결과 레이아웃</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <OptionButton active={settings.layout === '2col'} onClick={() => setSettings(s => ({ ...s, layout: '2col' }))}>▥ 2컬럼</OptionButton>
            <OptionButton active={settings.layout === '1col'} onClick={() => setSettings(s => ({ ...s, layout: '1col' }))}>▤ 1컬럼</OptionButton>
          </div>
        </div>

        {/* Toggles */}
        <div style={section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ ...label, marginBottom: 0 }}>로딩 스켈레톤</div>
              <div style={desc}>생성 중 미리보기 애니메이션</div>
            </div>
            <Toggle on={settings.skeleton} onChange={() => setSettings(s => ({ ...s, skeleton: !s.skeleton }))} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ ...label, marginBottom: 0 }}>자동 재시도</div>
              <div style={desc}>코드 오류 시 GPT가 자동 수정</div>
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

        {/* Data */}
        <div style={section}>
          <div style={label}>데이터 관리</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button variant="danger" size="md" onClick={clearAllFavs}>즐겨찾기 전체 삭제</Button>
          </div>
          {favs.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {favs.map((f, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', background: 'var(--sf-bg-3)',
                  border: '1px solid var(--sf-line)', borderRadius: 'var(--sf-r-sm)',
                  fontSize: 13, color: 'var(--sf-fg-muted)',
                }}>
                  <span>{f.icon} {f.name}</span>
                  <button onClick={() => removeFav(f.name)} style={{
                    background: 'none', border: 'none', color: 'var(--sf-fg-dim)',
                    cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1,
                  }}>×</button>
                </div>
              ))}
            </div>
          )}
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
