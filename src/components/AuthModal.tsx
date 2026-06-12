import { useState, useEffect, useRef } from 'react'
import { login, register, saveAuth, type AuthUser } from '../api'

interface AuthModalProps {
  open: boolean
  onClose: () => void
  onSuccess: (user: AuthUser, token: string) => void
}

type Mode = 'login' | 'register'

export default function AuthModal({ open, onClose, onSuccess }: AuthModalProps) {
  const [mode, setMode]         = useState<Mode>('login')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [name, setName]         = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [success, setSuccess]   = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) { setError(''); setSuccess(false); setTimeout(() => emailRef.current?.focus(), 100) }
  }, [open, mode])

  useEffect(() => {
    if (!open) return
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [open, onClose])

  if (!open) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (mode === 'register' && password !== confirm) { setError('비밀번호가 일치하지 않습니다.'); return }
    setLoading(true)
    try {
      const { user, token } = await (mode === 'login' ? login : register)(email, password)
      saveAuth(user, token)
      setSuccess(true)
      setTimeout(() => { onSuccess(user, token); onClose() }, 800)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const isLogin = mode === 'login'

  return (
    <>
      <style>{STYLES}</style>
      <div className="auth-overlay" onClick={onClose}>
        <div className="auth-card" onClick={e => e.stopPropagation()}>

          {/* ── Left panel ─────────────────────────────────── */}
          <div className="auth-left">
            <div className="auth-left-inner">
              {/* Logo */}
              <div className="auth-logo">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                  <rect width="28" height="28" rx="8" fill="rgba(255,255,255,0.15)"/>
                  <path d="M6 14h4M18 14h4M14 6v4M14 18v4" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="14" cy="14" r="3" stroke="white" strokeWidth="2"/>
                  <circle cx="6" cy="14" r="1.5" fill="white"/>
                  <circle cx="22" cy="14" r="1.5" fill="white"/>
                  <circle cx="14" cy="6" r="1.5" fill="white"/>
                  <circle cx="14" cy="22" r="1.5" fill="white"/>
                </svg>
                <span>SchemaForge</span>
              </div>

              {/* Headline */}
              <div className="auth-left-headline">
                <h1>{isLogin ? 'Welcome\nback.' : 'Start\nbuilding.'}</h1>
                <p>{isLogin
                  ? 'AI가 설계한 회로들이\n당신을 기다리고 있어요.'
                  : 'AI와 함께 전자 회로를\n설계하는 가장 빠른 방법.'
                }</p>
              </div>

              {/* Features */}
              <div className="auth-features">
                {(isLogin ? LOGIN_FEATURES : REGISTER_FEATURES).map(f => (
                  <div key={f.text} className="auth-feature-item">
                    <div className="auth-feature-icon">{f.icon}</div>
                    <div>
                      <div className="auth-feature-title">{f.title}</div>
                      <div className="auth-feature-desc">{f.text}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Circuit decoration */}
              <CircuitDecoration />
            </div>
          </div>

          {/* ── Right panel ────────────────────────────────── */}
          <div className="auth-right">
            <button className="auth-close" onClick={onClose}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>

            <div className="auth-form-wrap">
              {/* Tab switcher */}
              <div className="auth-tabs">
                <button className={`auth-tab ${isLogin ? 'active' : ''}`} onClick={() => { setMode('login'); setError('') }}>로그인</button>
                <button className={`auth-tab ${!isLogin ? 'active' : ''}`} onClick={() => { setMode('register'); setError('') }}>회원가입</button>
              </div>

              <div className="auth-form-header">
                <h2>{isLogin ? '다시 만나요 👋' : '계정 만들기'}</h2>
                <p>{isLogin ? '계속하려면 로그인하세요.' : '몇 초면 시작할 수 있어요.'}</p>
              </div>

              <form onSubmit={handleSubmit} className="auth-form">
                {!isLogin && (
                  <FloatingInput
                    label="이름 (선택)"
                    type="text"
                    value={name}
                    onChange={setName}
                    placeholder="홍길동"
                  />
                )}
                <FloatingInput
                  ref={emailRef}
                  label="아이디"
                  type="text"
                  value={email}
                  onChange={setEmail}
                  placeholder="아이디 입력"
                  required
                />
                <FloatingInput
                  label="비밀번호"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  placeholder={isLogin ? '••••••••' : '6자 이상 입력'}
                  required
                  minLength={6}
                />
                {!isLogin && (
                  <FloatingInput
                    label="비밀번호 확인"
                    type="password"
                    value={confirm}
                    onChange={setConfirm}
                    placeholder="비밀번호 재입력"
                    required
                    error={confirm.length > 0 && confirm !== password ? '비밀번호가 일치하지 않아요' : ''}
                  />
                )}

                {error && (
                  <div className="auth-error">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M7 4v3.5M7 10h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  className={`auth-submit ${success ? 'success' : ''}`}
                  disabled={loading || success}
                >
                  {success ? (
                    <><CheckIcon /> 완료!</>
                  ) : loading ? (
                    <><Spinner /> {isLogin ? '로그인 중...' : '계정 생성 중...'}</>
                  ) : (
                    <>{isLogin ? '로그인' : '계정 만들기'} <ArrowIcon /></>
                  )}
                </button>
              </form>

              {/* Password hint */}
              {isLogin && (
                <div className="auth-forgot">
                  <button type="button">비밀번호를 잊으셨나요?</button>
                </div>
              )}

              {/* Register checklist */}
              {!isLogin && (
                <div className="auth-checklist">
                  <CheckItem done={password.length >= 6}>6자 이상</CheckItem>
                  <CheckItem done={confirm.length > 0 && confirm === password}>비밀번호 일치</CheckItem>
                  <CheckItem done={email.length >= 4}>아이디 4자 이상</CheckItem>
                </div>
              )}

              <div className="auth-divider"><span>또는</span></div>

              <div className="auth-switch">
                {isLogin ? '처음이신가요?' : '이미 계정이 있으신가요?'}
                {' '}
                <button onClick={() => { setMode(isLogin ? 'register' : 'login'); setError('') }}>
                  {isLogin ? '회원가입 →' : '로그인 →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────────

import React from 'react'

const FloatingInput = React.forwardRef<HTMLInputElement, {
  label: string; type: string; value: string; onChange: (v: string) => void
  placeholder?: string; required?: boolean; minLength?: number; error?: string
}>(({ label, type, value, onChange, placeholder, required, minLength, error }, ref) => {
  const [focused, setFocused] = useState(false)
  const raised = focused || value.length > 0
  return (
    <div className={`fi-wrap ${error ? 'fi-error' : ''} ${focused ? 'fi-focused' : ''}`}>
      <label className={`fi-label ${raised ? 'raised' : ''}`}>{label}</label>
      <input
        ref={ref}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={focused ? placeholder : ''}
        required={required}
        minLength={minLength}
        className="fi-input"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {error && <span className="fi-err-msg">{error}</span>}
    </div>
  )
})
FloatingInput.displayName = 'FloatingInput'

function CheckItem({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <div className={`auth-check-item ${done ? 'done' : ''}`}>
      <span className="auth-check-dot" />
      {children}
    </div>
  )
}

function Spinner() {
  return <span className="auth-spinner" />
}
function CheckIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8l4 4 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
}
function ArrowIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
}

function CircuitDecoration() {
  return (
    <svg className="auth-circuit" viewBox="0 0 220 180" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10 90h30M70 90h30M130 90h30M180 90h30" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M110 10v30M110 70v30M110 120v30M110 160v20" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" strokeLinecap="round"/>
      <rect x="40" y="78" width="24" height="24" rx="4" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5"/>
      <rect x="100" y="40" width="20" height="20" rx="4" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5"/>
      <rect x="150" y="78" width="24" height="24" rx="4" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5"/>
      <circle cx="110" cy="90" r="6" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5"/>
      <circle cx="40" cy="90" r="3" fill="rgba(255,255,255,0.2)"/>
      <circle cx="180" cy="90" r="3" fill="rgba(255,255,255,0.2)"/>
      <circle cx="110" cy="10" r="3" fill="rgba(255,255,255,0.2)"/>
      <circle cx="110" cy="170" r="3" fill="rgba(255,255,255,0.2)"/>
      <path d="M70 60 Q90 60 90 78" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5"/>
      <path d="M150 60 Q130 60 130 78" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5"/>
    </svg>
  )
}

// ── Feature Icons (SVG) ───────────────────────────────────────────

function IcCircuit() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <circle cx="2" cy="8" r="1" fill="currentColor"/>
      <circle cx="14" cy="8" r="1" fill="currentColor"/>
      <circle cx="8" cy="2" r="1" fill="currentColor"/>
      <circle cx="8" cy="14" r="1" fill="currentColor"/>
    </svg>
  )
}

function IcHistory() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 4v4l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3 8a5 5 0 1 1 1.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M2 5.5V8h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function IcBookmark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M4 2h8a1 1 0 0 1 1 1v10.5l-5-3-5 3V3a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
    </svg>
  )
}

function IcBolt() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M9.5 2L4 9h4.5L6.5 14 13 7H8.5L9.5 2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  )
}

// ── Data ──────────────────────────────────────────────────────────

const LOGIN_FEATURES = [
  { icon: <IcBolt />,     title: '빠른 재접근', text: '저장된 회로 세션 즉시 불러오기' },
  { icon: <IcBookmark />, title: '즐겨찾기',   text: '자주 쓰는 회로 북마크 관리' },
]

const REGISTER_FEATURES = [
  { icon: <IcCircuit />,  title: 'AI 회로 설계', text: 'GPT-4o 기반 자동 회로 생성' },
  { icon: <IcHistory />,  title: '세션 저장',    text: '모든 설계 히스토리 자동 보관' },
  { icon: <IcBookmark />, title: '즐겨찾기',    text: '나만의 회로 라이브러리 구축' },
]

// ── Styles ────────────────────────────────────────────────────────

const STYLES = `
.auth-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(15,12,8,0.7);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  animation: authFadeIn 0.18s ease;
}
.auth-card {
  display: flex;
  width: 100%; max-width: 780px;
  min-height: 520px;
  border-radius: 24px;
  overflow: hidden;
  box-shadow: 0 32px 80px rgba(10,8,4,0.45), 0 2px 0 rgba(255,255,255,0.06) inset;
  animation: authSlideUp 0.22s cubic-bezier(0.34,1.4,0.64,1);
}

/* ── Left panel ── */
.auth-left {
  width: 42%;
  background: linear-gradient(145deg, #1a1207 0%, #2d1f0a 50%, #1a1207 100%);
  position: relative; overflow: hidden; flex-shrink: 0;
}
.auth-left::before {
  content: '';
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at 30% 40%, rgba(200,117,21,0.18) 0%, transparent 60%),
              radial-gradient(ellipse at 80% 80%, rgba(29,122,106,0.12) 0%, transparent 50%);
}
.auth-left-inner {
  position: relative; z-index: 1;
  padding: 36px 32px;
  height: 100%;
  display: flex; flex-direction: column; gap: 0;
}
.auth-logo {
  display: flex; align-items: center; gap: 10px;
  font-family: 'Space Grotesk', sans-serif;
  font-size: 15px; font-weight: 700;
  color: rgba(255,255,255,0.9);
  letter-spacing: -0.02em;
  margin-bottom: 40px;
}
.auth-left-headline {
  flex: 1;
}
.auth-left-headline h1 {
  margin: 0 0 12px;
  font-family: 'Space Grotesk', sans-serif;
  font-size: 38px; font-weight: 700;
  color: #fff; line-height: 1.1;
  letter-spacing: -0.03em;
  white-space: pre-line;
}
.auth-left-headline p {
  margin: 0;
  font-size: 13.5px; color: rgba(255,255,255,0.5);
  line-height: 1.6; white-space: pre-line;
}
.auth-features {
  display: flex; flex-direction: column; gap: 14px;
  margin-top: 32px;
}
.auth-feature-item {
  display: flex; align-items: flex-start; gap: 12px;
}
.auth-feature-icon {
  width: 32px; height: 32px;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  color: rgba(255,255,255,0.75);
}
.auth-feature-title {
  font-size: 13px; font-weight: 600;
  color: rgba(255,255,255,0.85);
  font-family: 'Space Grotesk', sans-serif;
  margin-bottom: 2px;
}
.auth-feature-desc {
  font-size: 12px; color: rgba(255,255,255,0.4);
  font-family: 'Space Grotesk', sans-serif;
}
.auth-circuit {
  position: absolute; bottom: -10px; right: -20px;
  width: 180px; opacity: 0.6; pointer-events: none;
}

/* ── Right panel ── */
.auth-right {
  flex: 1;
  background: #fbf7ec;
  position: relative;
  display: flex; align-items: center; justify-content: center;
  padding: 40px 36px;
}
.auth-close {
  position: absolute; top: 18px; right: 18px;
  width: 30px; height: 30px; border-radius: 50%;
  background: rgba(0,0,0,0.06); border: none;
  color: #8a8270; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.auth-close:hover { background: rgba(0,0,0,0.1); color: #1a1611; }
.auth-form-wrap { width: 100%; max-width: 320px; }

/* ── Tabs ── */
.auth-tabs {
  display: flex; gap: 0;
  background: #f0ead8;
  border-radius: 10px; padding: 3px;
  margin-bottom: 28px;
}
.auth-tab {
  flex: 1; padding: 7px; border: none;
  border-radius: 8px; cursor: pointer;
  font-family: 'Space Grotesk', sans-serif;
  font-size: 13px; font-weight: 600;
  transition: all 0.15s;
  background: transparent; color: #8a8270;
}
.auth-tab.active {
  background: #fff;
  color: #1a1611;
  box-shadow: 0 1px 6px rgba(74,52,18,0.14);
}

/* ── Form header ── */
.auth-form-header { margin-bottom: 24px; }
.auth-form-header h2 {
  margin: 0 0 4px;
  font-family: 'Space Grotesk', sans-serif;
  font-size: 22px; font-weight: 700; color: #1a1611;
  letter-spacing: -0.02em;
}
.auth-form-header p {
  margin: 0; font-size: 13px; color: #8a8270;
}

/* ── Form ── */
.auth-form { display: flex; flex-direction: column; gap: 14px; }

/* ── Floating input ── */
.fi-wrap {
  position: relative;
  background: #fff;
  border: 1.5px solid #d6cdb6;
  border-radius: 12px;
  transition: border-color 0.15s, box-shadow 0.15s;
  padding: 10px 14px 8px;
}
.fi-wrap.fi-focused {
  border-color: #c87515;
  box-shadow: 0 0 0 3px rgba(200,117,21,0.1);
}
.fi-wrap.fi-error {
  border-color: #b04826;
  box-shadow: 0 0 0 3px rgba(176,72,38,0.08);
}
.fi-label {
  position: absolute; left: 14px;
  font-family: 'Space Grotesk', sans-serif;
  font-size: 13px; color: #8a8270;
  pointer-events: none;
  transition: all 0.15s cubic-bezier(0.4,0,0.2,1);
  top: 50%; transform: translateY(-50%);
}
.fi-label.raised {
  top: 8px; transform: none;
  font-size: 10px; font-weight: 600;
  color: #c87515; letter-spacing: 0.04em; text-transform: uppercase;
}
.fi-input {
  width: 100%; border: none; outline: none;
  background: transparent; padding: 12px 0 0;
  font-family: 'Space Grotesk', sans-serif;
  font-size: 14px; color: #1a1611;
  box-sizing: border-box;
}
.fi-input::placeholder { color: #b0a895; }
.fi-err-msg {
  display: block; font-size: 11px; color: #b04826;
  margin-top: 3px; font-family: 'Space Grotesk', sans-serif;
}

/* ── Error box ── */
.auth-error {
  display: flex; align-items: center; gap: 7px;
  padding: 10px 14px; border-radius: 10px;
  background: rgba(176,72,38,0.07);
  border: 1px solid rgba(176,72,38,0.18);
  font-size: 13px; color: #b04826;
  font-family: 'Space Grotesk', sans-serif;
}

/* ── Submit button ── */
.auth-submit {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%; padding: 14px;
  background: #1a1611;
  border: none; border-radius: 12px;
  color: #fff; font-family: 'Space Grotesk', sans-serif;
  font-size: 14.5px; font-weight: 700; cursor: pointer;
  transition: all 0.2s; letter-spacing: -0.01em;
}
.auth-submit:hover:not(:disabled) {
  background: #2d2418;
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(26,22,17,0.25);
}
.auth-submit:active:not(:disabled) { transform: none; }
.auth-submit:disabled { opacity: 0.7; cursor: default; transform: none !important; }
.auth-submit.success { background: #1d7a6a; }

/* ── Spinner ── */
.auth-spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  display: inline-block;
  animation: authSpin 0.65s linear infinite;
}

/* ── Checklist ── */
.auth-checklist {
  display: flex; gap: 12px; flex-wrap: wrap;
  margin-top: 10px;
}
.auth-check-item {
  display: flex; align-items: center; gap: 5px;
  font-size: 11.5px; color: #b0a895;
  font-family: 'IBM Plex Mono', monospace;
  transition: color 0.2s;
}
.auth-check-item.done { color: #1d7a6a; }
.auth-check-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #d6cdb6; transition: background 0.2s;
  flex-shrink: 0;
}
.auth-check-item.done .auth-check-dot { background: #1d7a6a; }

/* ── Forgot / divider / switch ── */
.auth-forgot { text-align: right; margin-top: -4px; }
.auth-forgot button {
  background: none; border: none; cursor: pointer;
  font-size: 12px; color: #8a8270;
  font-family: 'Space Grotesk', sans-serif;
  transition: color 0.15s;
}
.auth-forgot button:hover { color: #c87515; }
.auth-divider {
  display: flex; align-items: center; gap: 12px;
  margin: 16px 0 14px;
  color: #b0a895; font-size: 12px;
  font-family: 'IBM Plex Mono', monospace;
}
.auth-divider::before, .auth-divider::after {
  content: ''; flex: 1; height: 1px; background: #e8e1d1;
}
.auth-switch {
  text-align: center; font-size: 13px; color: #8a8270;
  font-family: 'Space Grotesk', sans-serif;
}
.auth-switch button {
  background: none; border: none; cursor: pointer;
  color: #c87515; font-weight: 700; font-size: 13px;
  font-family: 'Space Grotesk', sans-serif;
  padding: 0; transition: opacity 0.15s;
}
.auth-switch button:hover { opacity: 0.75; }

/* ── Animations ── */
@keyframes authFadeIn  { from { opacity:0 } to { opacity:1 } }
@keyframes authSlideUp { from { opacity:0; transform:translateY(20px) scale(0.97) } to { opacity:1; transform:none } }
@keyframes authSpin    { to { transform:rotate(360deg) } }

/* ── Responsive ── */
@media (max-width: 580px) {
  .auth-left { display: none; }
  .auth-card { max-width: 400px; }
  .auth-right { padding: 32px 24px; }
}
`
