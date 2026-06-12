import { useState, CSSProperties } from 'react'
import { login, register, saveAuth, type AuthUser } from '../api'
import { Button } from './primitives.tsx'

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 200,
  background: 'rgba(26,22,17,0.6)', backdropFilter: 'blur(6px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
}

const panel: CSSProperties = {
  width: '100%', maxWidth: 400,
  background: 'var(--sf-bg-2)', border: '1px solid var(--sf-line-strong)',
  borderRadius: 'var(--sf-r-lg)', boxShadow: 'var(--sf-shadow-lg)',
  padding: '32px 28px',
}

const inputStyle: CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--sf-bg-3)', border: '1px solid var(--sf-line-strong)',
  borderRadius: 'var(--sf-r-sm)', color: 'var(--sf-fg)',
  fontFamily: 'var(--sf-font-sans)', fontSize: 14,
  boxSizing: 'border-box', outline: 'none',
}

interface AuthModalProps {
  open: boolean
  onClose: () => void
  onSuccess: (user: AuthUser, token: string) => void
}

export default function AuthModal({ open, onClose, onSuccess }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (!open) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const fn = mode === 'login' ? login : register
      const { user, token } = await fn(email, password)
      saveAuth(user, token)
      onSuccess(user, token)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 8px', fontFamily: 'var(--sf-font-sans)', fontSize: 22, fontWeight: 700, color: 'var(--sf-fg)' }}>
          {mode === 'login' ? '로그인' : '회원가입'}
        </h2>
        <p style={{ margin: '0 0 24px', fontSize: 13, color: 'var(--sf-fg-dim)' }}>
          {mode === 'login' ? '회로 세션과 즐겨찾기를 저장하세요.' : '무료 계정을 만들어 시작하세요.'}
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            style={inputStyle}
            type="email"
            placeholder="이메일"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
          />
          <input
            style={inputStyle}
            type="password"
            placeholder="비밀번호 (6자 이상)"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
          />

          {error && (
            <div style={{ fontSize: 13, color: 'var(--sf-danger, #ef4444)', padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6 }}>
              {error}
            </div>
          )}

          <Button variant="primary" size="md" type="submit" disabled={loading} style={{ marginTop: 4 }}>
            {loading ? '처리 중...' : mode === 'login' ? '로그인' : '계정 만들기'}
          </Button>
        </form>

        <div style={{ marginTop: 20, textAlign: 'center', fontSize: 13, color: 'var(--sf-fg-dim)' }}>
          {mode === 'login' ? (
            <>계정이 없으신가요?{' '}
              <button onClick={() => { setMode('register'); setError('') }}
                style={{ background: 'none', border: 'none', color: 'var(--sf-amber)', cursor: 'pointer', fontWeight: 600, padding: 0 }}>
                회원가입
              </button>
            </>
          ) : (
            <>이미 계정이 있으신가요?{' '}
              <button onClick={() => { setMode('login'); setError('') }}
                style={{ background: 'none', border: 'none', color: 'var(--sf-amber)', cursor: 'pointer', fontWeight: 600, padding: 0 }}>
                로그인
              </button>
            </>
          )}
        </div>

        <button onClick={onClose} style={{
          position: 'absolute', top: 0, right: 0, margin: '12px 14px',
          background: 'none', border: 'none', color: 'var(--sf-fg-dim)',
          fontSize: 20, cursor: 'pointer', lineHeight: 1,
        }}>×</button>
      </div>
    </div>
  )
}
