// What a deployed server (NODE_ENV=production) lets a visitor do. The demos run checked-in circuits only and stay
// open to everyone. Running code from a request (the Code tab, skidl the model wrote from a description) and
// calling the model are for the accounts in ALLOWED_EMAILS: a Python run can read the server's own keys through
// /proc, and a model call costs money. Development (any other NODE_ENV) is unchanged.
// Kept out of index.ts so check_deploy_guard.ts tests the same rules the server uses.
import { basename } from 'path'

export interface Guard { deployed: boolean; supabase: boolean; allowed: Set<string> }

/** a signed-in account as the guard sees it; confirmed = Supabase has seen the person open the sign-up mail */
export interface Member { email: string; confirmed?: boolean }

export function guardFromEnv(env: NodeJS.ProcessEnv = process.env): Guard {
  return {
    deployed: env.NODE_ENV === 'production',
    supabase: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY),
    allowed: new Set((env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)),
  }
}

const DEMO = '데모(?demo=motor)는 로그인 없이 쓸 수 있습니다.'

/** a refusal as the server sends it; code tells the front end what to do (log in, confirm the mail, nothing) */
export interface Refusal { status: number; error: string; code: 'login_required' | 'email_not_confirmed' | 'not_allowed' }

/**
 * Why this visitor may not run code or call the model here, or null when they may. On a deployed server that is
 * a Supabase account whose mail address was confirmed (an unconfirmed sign-up could name anyone's address) and
 * is listed in ALLOWED_EMAILS; with ALLOWED_EMAILS empty nobody is.
 */
export function memberRefusal(g: Guard, user: Member | undefined): Refusal | null {
  if (!g.deployed) return null
  if (!g.supabase || !user) return { status: 401, code: 'login_required', error: `이 서버에서 회로 생성·AI 편집·코드 실행은 허용된 계정으로 로그인해야 쓸 수 있습니다. ${DEMO}` }
  if (!user.confirmed) return { status: 403, code: 'email_not_confirmed', error: `가입 확인 메일의 링크를 누른 뒤에 쓸 수 있습니다. ${DEMO}` }
  if (!g.allowed.has(user.email.trim().toLowerCase())) return { status: 403, code: 'not_allowed', error: `이 계정은 아직 회로 생성·AI 편집·코드 실행을 쓸 수 없습니다. ${DEMO}` }
  return null
}

/** the password-free sign-in kept for development is never on a deployed server */
export function localLoginRefusal(g: Guard): string | null {
  return g.deployed && !g.supabase ? `이 서버의 로그인은 아직 열려 있지 않습니다. ${DEMO}` : null
}

/** a file or folder name from a request: the last path part, never "" "." or ".." (".." would leave outputs/) */
export function safeName(v: unknown): string | null {
  const s = basename(String(v ?? ''))
  return s && s !== '.' && s !== '..' ? s : null
}

/** the front part of a new file's name, from a request: letters, digits, _ and - only */
export function fileStem(v: unknown, fallback = 'edited'): string {
  return String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || fallback
}
