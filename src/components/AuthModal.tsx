import { useState, useEffect, useRef, useId, type FormEvent, type ReactNode, type Ref } from 'react'
import { login, register, saveAuth, type AuthUser } from '../api'
import Logo from './Logo.tsx'
import { Button, IconCheck, IconClose, Spinner } from './primitives.tsx'

/** a line shown above the form when it opens: the sign-up mail was confirmed, its link failed, or the login ran out */
export interface AuthNotice { tone: 'info' | 'error'; text: string }

interface AuthModalProps {
  open: boolean
  onClose: () => void
  onSuccess: (user: AuthUser, token: string) => void
  notice?: AuthNotice | null
}

type Mode = 'login' | 'register'

// a mail address as Supabase takes it: something@domain.tld
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// One plain panel like the settings, from the tokens (2026-11-08): the dark gradient half with its feature cards, the
// English headline, the emoji and the blur over the page went, as they went from the other screens on 2026-09-17
export default function AuthModal({ open, onClose, onSuccess, notice = null }: AuthModalProps) {
  const [mode, setMode]         = useState<Mode>('login')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [error, setError]       = useState('')
  const [info, setInfo]         = useState('')
  const [loading, setLoading]   = useState(false)
  const [success, setSuccess]   = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)

  // a notice opens the login tab (after the mail link, or when the login ran out)
  useEffect(() => {
    if (!open) return
    setSuccess(false)
    setError(notice?.tone === 'error' ? notice.text : '')
    setInfo(notice?.tone === 'info' ? notice.text : '')
    if (notice) setMode('login')
  }, [open, notice])

  // the modal stays mounted, so what was typed stays too: gone when it closes (2026-11-06 sweep: after a logout the next
  // person opened it on the last password, and pressing 로그인 logged in as that account). The mail address may stay
  useEffect(() => {
    if (!open) { setPassword(''); setConfirm('') }
  }, [open])

  useEffect(() => {
    if (open) setTimeout(() => emailRef.current?.focus(), 100)
  }, [open, mode])

  useEffect(() => {
    if (!open) return
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [open, onClose])

  if (!open) return null

  function switchMode(m: Mode) {
    setMode(m)
    setError('')
    setInfo('')
  }

  /** a login with a token: kept in this browser, then the app goes on (a waiting generation runs) */
  function finish(user: AuthUser, token: string, refreshToken?: string) {
    if (!saveAuth(user, token, refreshToken)) { setError('로그인 응답에 토큰이 없습니다. 잠시 후 다시 시도하세요.'); return }
    setSuccess(true)
    setPassword('')
    setConfirm('')
    setTimeout(() => { onSuccess(user, token); onClose() }, 800)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setInfo('')
    const addr = email.trim()
    if (!EMAIL_RE.test(addr)) { setError('메일 주소 형식이 아닙니다. 예: you@example.com'); return }
    if (mode === 'register' && password !== confirm) { setError('비밀번호가 일치하지 않습니다.'); return }
    setLoading(true)
    try {
      if (mode === 'register') {
        const r = await register(addr, password)
        if (r.needsConfirm) {
          // not logged in yet: the mail's link confirms the address, then the person logs in here
          // (onSuccess is not called, so a generation waiting for the login still waits)
          setConfirm('')
          setMode('login')
          setInfo(r.message)
          return
        }
        finish(r.user, r.token, r.refresh_token)
      } else {
        const r = await login(addr, password)
        finish(r.user, r.token, r.refresh_token)
      }
    } catch (err) {
      // the server's sentence, e.g. 403 email_not_confirmed: open the mail's link first
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const isLogin = mode === 'login'
  const emailOk = EMAIL_RE.test(email.trim())

  return (
    <>
      <style>{STYLES}</style>
      <div className="auth-overlay" onClick={onClose}>
        <div className="auth-card" onClick={e => e.stopPropagation()}>
          <div className="auth-head">
            <Logo size={20} />
            <Button variant="ghost" size="sm" icon={<IconClose size={14} />} onClick={onClose} />
          </div>

          <div className="auth-tabs">
            <button type="button" className={`auth-tab ${isLogin ? 'active' : ''}`} onClick={() => switchMode('login')}>로그인</button>
            <button type="button" className={`auth-tab ${!isLogin ? 'active' : ''}`} onClick={() => switchMode('register')}>회원가입</button>
          </div>

          <h2 className="auth-title">{isLogin ? '로그인' : '계정 만들기'}</h2>
          <p className="auth-lead">{isLogin
            ? '로그인하면 만든 회로가 기록에 남고 즐겨찾기를 쓸 수 있습니다.'
            : '메일 주소와 비밀번호로 계정을 만듭니다. 만든 회로는 기록에 남고 즐겨찾기를 쓸 수 있습니다.'}</p>

          <form onSubmit={handleSubmit} className="auth-form">
            <Field
              ref={emailRef}
              label="이메일"
              type="email"
              autoComplete="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              required
            />
            <Field
              label="비밀번호"
              type="password"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              value={password}
              onChange={setPassword}
              placeholder={isLogin ? '' : '6자 이상'}
              required
              minLength={6}
            />
            {!isLogin && (
              <Field
                label="비밀번호 확인"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={setConfirm}
                placeholder="한 번 더 입력"
                required
                error={confirm.length > 0 && confirm !== password ? '비밀번호가 일치하지 않습니다.' : ''}
              />
            )}

            {!isLogin && (
              <div className="auth-checklist">
                <CheckItem done={emailOk}>메일 주소 형식</CheckItem>
                <CheckItem done={password.length >= 6}>6자 이상</CheckItem>
                <CheckItem done={confirm.length > 0 && confirm === password}>비밀번호 일치</CheckItem>
              </div>
            )}

            {info && !error && (
              <div className="auth-info" role="status">{info}</div>
            )}

            {error && (
              <div className="auth-error">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M7 4v3.5M7 10h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* no password reset yet: the '비밀번호를 잊으셨나요?' link comes back with that flow */}
            <button
              type="submit"
              className={`auth-submit ${success ? 'success' : ''}`}
              disabled={loading || success}
            >
              {success ? (
                <><IconCheck size={16} /> 로그인했습니다</>
              ) : loading ? (
                <><Spinner size={14} /> {isLogin ? '로그인 중' : '계정 만드는 중'}</>
              ) : (
                isLogin ? '로그인' : '계정 만들기'
              )}
            </button>
          </form>
        </div>
      </div>
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────────

/** a field with its name above it (it used to float inside the box, in amber at 10 px) */
function Field({ ref, label, type, value, onChange, placeholder, required, minLength, error, autoComplete }: {
  ref?: Ref<HTMLInputElement>
  label: string; type: string; value: string; onChange: (v: string) => void
  placeholder?: string; required?: boolean; minLength?: number; error?: string; autoComplete?: string
}) {
  const id = useId()
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={ref}
        id={id}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`auth-input ${error ? 'invalid' : ''}`}
      />
      {error && <span id={`${id}-error`} className="auth-field-error">{error}</span>}
    </div>
  )
}

function CheckItem({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <div className={`auth-check-item ${done ? 'done' : ''}`}>
      <span className="auth-check-dot" aria-hidden="true" />
      {children}
    </div>
  )
}

// ── Styles (tokens from src/styles/_sf-tokens.scss) ───────────────

const STYLES = `
.auth-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(26, 22, 17, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  animation: authFadeIn var(--sf-dur-fast) var(--sf-ease);
}
.auth-card {
  width: 100%; max-width: 400px;
  max-height: calc(100vh - 40px); overflow: auto;
  background: var(--sf-bg-2);
  border: 1px solid var(--sf-line-strong);
  border-radius: var(--sf-r-lg);
  box-shadow: var(--sf-shadow-lg);
  padding: 16px 24px 24px;
  font-family: var(--sf-font-sans);
  color: var(--sf-fg);
}
.auth-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px;
}

/* ── Tabs ── */
.auth-tabs {
  display: flex; gap: 2px;
  background: var(--sf-bg-3);
  border: 1px solid var(--sf-line-soft);
  border-radius: var(--sf-r-md); padding: 2px;
  margin-bottom: 20px;
}
.auth-tab {
  flex: 1; height: 32px; border: 1px solid transparent;
  border-radius: var(--sf-r-sm); cursor: pointer;
  font-family: var(--sf-font-sans);
  font-size: 13px; font-weight: 500;
  background: transparent; color: var(--sf-fg-muted);
  transition: background var(--sf-dur-fast) var(--sf-ease), color var(--sf-dur-fast) var(--sf-ease);
}
.auth-tab:hover { color: var(--sf-fg); }
.auth-tab.active {
  background: var(--sf-bg-2);
  border-color: var(--sf-line-strong);
  color: var(--sf-fg); font-weight: 600;
}

/* ── Title ── */
.auth-title {
  margin: 0 0 4px;
  font-size: 20px; font-weight: 600; line-height: 1.25;
  letter-spacing: -0.01em; color: var(--sf-fg);
}
.auth-lead {
  margin: 0 0 20px;
  font-size: 13.5px; line-height: 1.55; color: var(--sf-fg-muted);
  word-break: keep-all;
}

/* ── Form ── */
.auth-form { display: flex; flex-direction: column; gap: 14px; }
.auth-field { display: flex; flex-direction: column; gap: 6px; }
.auth-field label { font-size: 13px; font-weight: 500; color: var(--sf-fg); }
.auth-input {
  height: 40px; padding: 0 12px;
  background: var(--sf-bg-2); color: var(--sf-fg);
  border: 1px solid var(--sf-line-strong);
  border-radius: var(--sf-r-sm);
  font: 14px var(--sf-font-sans);
  outline: none;
  transition: border-color var(--sf-dur-fast) var(--sf-ease), box-shadow var(--sf-dur-fast) var(--sf-ease);
}
.auth-input::placeholder { color: var(--sf-fg-dim); }
.auth-input:focus { border-color: var(--sf-fg); box-shadow: 0 0 0 1px var(--sf-fg); }
.auth-input.invalid { border-color: var(--sf-danger); }
.auth-input.invalid:focus { box-shadow: 0 0 0 1px var(--sf-danger); }
.auth-field-error { font-size: 12px; color: var(--sf-danger); }

/* ── Sign-up checklist ── */
.auth-checklist { display: flex; gap: 14px; flex-wrap: wrap; margin-top: -4px; }
.auth-check-item {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--sf-fg-muted);
}
.auth-check-item.done { color: var(--sf-cyan-deep); }
.auth-check-dot {
  width: 8px; height: 8px; border-radius: 50%;
  border: 1px solid var(--sf-line-strong); flex-shrink: 0;
}
.auth-check-item.done .auth-check-dot { background: var(--sf-cyan); border-color: var(--sf-cyan); }

/* ── Notice and error ── */
.auth-info, .auth-error {
  padding: 10px 12px; border-radius: var(--sf-r-sm);
  font-size: 13px; line-height: 1.5; color: var(--sf-fg);
  word-break: keep-all;
}
.auth-info { background: var(--sf-cyan-soft); border: 1px solid var(--sf-cyan-line); }
.auth-error {
  display: flex; align-items: flex-start; gap: 8px;
  background: var(--sf-danger-soft); border: 1px solid var(--sf-danger-line);
}
.auth-error svg { flex-shrink: 0; margin-top: 3px; color: var(--sf-danger); }

/* ── Submit: dark, as before, until the filled amber reaches 4.5:1 (bd-token-contrast); then Button primary ── */
.auth-submit {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%; height: 44px; margin-top: 4px;
  background: var(--sf-fg); color: var(--sf-bg-2);
  border: 1px solid var(--sf-fg); border-radius: var(--sf-r-sm);
  font: 500 15px var(--sf-font-sans); letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--sf-dur-fast) var(--sf-ease);
}
.auth-submit:hover:not(:disabled) { background: var(--sf-bg-inverse); }
.auth-submit:disabled { opacity: 0.7; cursor: default; }
.auth-submit.success { background: var(--sf-cyan-deep); border-color: var(--sf-cyan-deep); opacity: 1; }

@keyframes authFadeIn { from { opacity: 0 } to { opacity: 1 } }

@media (max-width: 480px) {
  .auth-overlay { padding: 12px; }
  .auth-card { padding: 12px 16px 20px; }
}
`
