// ── SchemaForge API client ────────────────────────────────────────────────────

import type { ChatAction, ChatMessage } from './types'

const BASE = import.meta.env.VITE_API_URL ?? ''

/** the saved access token, or '' (an older build saved "undefined" when a sign-up gave no session) */
function token() {
  const t = (localStorage.getItem('sf_token') ?? '').trim()
  return t === 'undefined' || t === 'null' ? '' : t
}

export function authHeaders(): HeadersInit {
  const t = token()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

/** a refused request: the server's sentence, the HTTP status and its code (auth_expired, login_required, email_not_confirmed, not_allowed) */
export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** { error, code } of a failed answer; a page that is not JSON (a proxy or crash page) gives its status instead */
function failure(status: number, text: string): { error: string; code?: string } {
  try {
    const d = JSON.parse(text) as { error?: unknown; code?: unknown }
    if (typeof d.error === 'string' && d.error) return { error: d.error, code: typeof d.code === 'string' ? d.code : undefined }
  } catch { /* not JSON */ }
  const t = text.trim()
  return { error: t && !t.startsWith('<') ? t.slice(0, 200) : `HTTP ${status}` }
}

/** why a request failed, as the server wrote it ({ error }), else its text or status */
export async function errorText(res: Response): Promise<string> {
  return failure(res.status, await res.text().catch(() => '')).error
}

/** the JSON body of an answer; a failed one becomes an ApiError with the server's text and code */
async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    const f = failure(res.status, text)
    throw new ApiError(f.error, res.status, f.code)
  }
  try { return JSON.parse(text) as T } catch {
    throw new ApiError(`서버 응답을 읽지 못했습니다 (HTTP ${res.status}).`, res.status)
  }
}

// ── Login renewal ─────────────────────────────────────────────────
// A Supabase access token lasts about an hour; the refresh token gets a new one without the password.

let expiredHandler: (() => void) | null = null

/** what the app does when a login cannot be renewed (App: clear it, open the login, keep a waiting generation) */
export function setAuthExpiredHandler(fn: (() => void) | null) {
  expiredHandler = fn
}

// one renewal at a time: requests that fail together wait for the same one
let refreshing: Promise<boolean> | null = null

/** a new access token from the saved refresh token (POST /auth/refresh); false = log in again */
export function refresh(): Promise<boolean> {
  if (refreshing) return refreshing
  const rt = localStorage.getItem('sf_refresh')
  if (!rt) return Promise.resolve(false)
  refreshing = fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt }),
  })
    .then(async res => {
      const data = res.ok ? await res.json().catch(() => null) as { token?: unknown; refresh_token?: unknown } | null : null
      if (typeof data?.token !== 'string' || !data.token) return false
      localStorage.setItem('sf_token', data.token)
      if (typeof data.refresh_token === 'string' && data.refresh_token) localStorage.setItem('sf_refresh', data.refresh_token)
      return true
    })
    .catch(() => false)
    .finally(() => { refreshing = null })
  return refreshing
}

/** 401 with code auth_expired: the token was sent but the server no longer takes it */
async function isExpired(res: Response): Promise<boolean> {
  if (res.status !== 401) return false
  const body = await res.clone().json().catch(() => null) as { code?: unknown } | null
  return body?.code === 'auth_expired'
}

/** fetch with the saved login; an expired token is renewed once and the request sent again */
export async function fetchWithRefresh(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () => {
    const headers = new Headers(init.headers)
    const t = token()
    if (t) headers.set('Authorization', `Bearer ${t}`)
    return fetch(`${BASE}${path}`, { ...init, headers })
  }
  const sent = token()
  const res = await send()
  if (!sent || !(await isExpired(res))) return res
  // another request may have renewed it in the meantime
  const renewed = token() !== sent || await refresh()
  return renewed ? send() : res
}

/** fetchWithRefresh for the app's calls: when the login could not be renewed, the app is told (it asks for it again) */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetchWithRefresh(path, init)
  if (await isExpired(res)) expiredHandler?.()
  return res
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await authFetch(path, body === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return readJson<T>(res)
}

/** a request that needs no login (sign-up, login, netlist restore) */
async function postOpen<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return readJson<T>(res)
}

// ── Auth ──────────────────────────────────────────────────────────

export interface AuthUser { id: string; email: string }
export interface AuthResponse { user: AuthUser; token: string; refresh_token?: string }
/** with "Confirm email" on, a sign-up is not a login yet: the link in the mail confirms the address first */
export type RegisterResult = { needsConfirm: true; message: string } | ({ needsConfirm?: false } & AuthResponse)

export async function register(email: string, password: string): Promise<RegisterResult> {
  const data = await postOpen<{
    needsConfirm?: boolean; message?: string; user?: AuthUser; token?: string; refresh_token?: string
    session?: { access_token?: string; refresh_token?: string } | null
  }>('/auth/register', { email, password })
  const tok = data.token ?? data.session?.access_token ?? ''
  // no token = no login yet (an older server answered { session: null } for this)
  if (data.needsConfirm || !tok || !data.user) {
    return { needsConfirm: true, message: data.message || `${email}로 가입 확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요.` }
  }
  return { user: data.user, token: tok, refresh_token: data.refresh_token ?? data.session?.refresh_token }
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const data = await postOpen<Partial<AuthResponse>>('/auth/login', { email, password })
  if (!data.token || !data.user) throw new ApiError('로그인 응답에 토큰이 없습니다. 잠시 후 다시 시도하세요.', 200)
  return { user: data.user, token: data.token, refresh_token: data.refresh_token }
}

/** forgets the saved login in this browser (the server is not asked) */
export function clearAuth() {
  localStorage.removeItem('sf_token')
  localStorage.removeItem('sf_user')
  localStorage.removeItem('sf_refresh')
}

export async function logout(): Promise<void> {
  // a plain fetch: an expired token is not renewed just to end it
  await fetch(`${BASE}/auth/logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: '{}',
  }).catch(() => {})
  clearAuth()
}

/** false, and nothing saved, for an empty token: a sign-up still waiting for its mail is not a login */
export function saveAuth(user: AuthUser, tok: string, refreshTok?: string): boolean {
  if (!tok || !user) return false
  localStorage.setItem('sf_token', tok)
  localStorage.setItem('sf_user', JSON.stringify(user))
  if (refreshTok) localStorage.setItem('sf_refresh', refreshTok)
  else localStorage.removeItem('sf_refresh')
  return true
}

export function loadAuth(): { user: AuthUser; token: string } | null {
  const tok = token()
  const raw = localStorage.getItem('sf_user')
  if (!tok || !raw) return null
  try {
    const user = JSON.parse(raw) as AuthUser | null
    return user && typeof user === 'object' ? { user, token: tok } : null
  } catch { return null }
}

/**
 * GET /auth/me: is the saved login still good. status 401 = no (clear it); 503 or no answer = the login server
 * is unreachable (keep it). canGenerate false = a deployed server will refuse this account's generation.
 */
export async function getMe(): Promise<{ status: number; canGenerate?: boolean }> {
  const res = await fetchWithRefresh('/auth/me')
  if (!res.ok) return { status: res.status }
  const data = await res.json().catch(() => null) as { canGenerate?: unknown } | null
  return { status: res.status, canGenerate: typeof data?.canGenerate === 'boolean' ? data.canGenerate : undefined }
}

// ── Sessions ──────────────────────────────────────────────────────

export interface DbSession {
  id: string
  name?: string | null
  prompt: string
  code?: string | null
  guide?: string | null
  graph?: unknown
  filename?: string | null
  created_at: string
}

export async function getSessions(): Promise<DbSession[]> {
  const data = await call<{ sessions?: DbSession[] }>('GET', '/sessions')
  return Array.isArray(data.sessions) ? data.sessions : []
}

export async function saveSession(payload: {
  prompt: string; code?: string; guide?: string; graph?: unknown; filename?: string
}): Promise<string> {
  const data = await call<{ id: string }>('POST', '/sessions', payload)
  return data.id
}

export async function deleteSession(id: string): Promise<void> {
  await call('DELETE', `/sessions/${encodeURIComponent(id)}`)
}

/** every session of the logged-in account; how many were deleted */
export async function deleteAllSessions(): Promise<number> {
  const data = await call<{ deleted?: number }>('DELETE', '/sessions')
  return data.deleted ?? 0
}

export interface SessionPatch { name?: string; graph?: unknown; code?: string; filename?: string; guide?: string }

/** PATCH /sessions/:id: a new name, or the circuit after an AI edit or a Code tab run */
export async function updateSession(id: string, patch: SessionPatch): Promise<void> {
  await call('PATCH', `/sessions/${encodeURIComponent(id)}`, patch)
}

export async function renameSession(id: string, name: string): Promise<void> {
  await updateSession(id, { name })
}

// ── Chat Messages ─────────────────────────────────────────────────

/** the AI-editor chat kept with a saved session, oldest first */
export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  const data = await call<{ messages?: { role?: unknown; content?: unknown; actions?: unknown }[] }>(
    'GET', `/sessions/${encodeURIComponent(sessionId)}/messages`)
  return (data.messages ?? [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({
      role: m.role as ChatMessage['role'],
      content: m.content as string,
      actions: Array.isArray(m.actions) ? m.actions as ChatAction[] : [],
    }))
}

export async function saveMessage(sessionId: string, role: ChatMessage['role'], content: string, actions?: ChatAction[]) {
  return call<{ ok: boolean }>('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { role, content, actions })
}

// ── Favorites ─────────────────────────────────────────────────────

export interface DbFavorite {
  id: string
  sessionId: string
  prompt: string
  graph?: unknown
  filename?: string
  createdAt: string
}

type RawFavorite = Partial<DbFavorite> & {
  session_id?: string; created_at?: string
  sessions?: { prompt?: string; graph?: unknown; filename?: string; created_at?: string } | null
}

export async function getFavorites(): Promise<DbFavorite[]> {
  const data = await call<{ favorites?: RawFavorite[] }>('GET', '/favorites')
  // an older server sent the joined row as it came from the database (session_id, sessions: {...})
  return (data.favorites ?? []).filter(f => f.id).map(f => ({
    id: f.id!,
    sessionId: f.sessionId ?? f.session_id ?? '',
    prompt: f.prompt ?? f.sessions?.prompt ?? '',
    graph: f.graph ?? f.sessions?.graph,
    filename: f.filename ?? f.sessions?.filename,
    createdAt: f.createdAt ?? f.created_at ?? f.sessions?.created_at ?? '',
  }))
}

export async function addFavorite(sessionId: string): Promise<string> {
  const data = await call<{ id: string }>('POST', '/favorites', { session_id: sessionId })
  return data.id
}

export async function removeFavorite(id: string): Promise<void> {
  await call('DELETE', `/favorites/${encodeURIComponent(id)}`)
}

// ── Netlist files ─────────────────────────────────────────────────

/**
 * Render's disk is wiped on a restart or sleep: writes a saved session's netlist file again from its circuit
 * (the server never overwrites one that exists). true = it was missing and is written now.
 */
export async function restoreNetlist(filename: string, graph: unknown): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,80}\.net$/.test(filename) || !graph) return false
  const data = await postOpen<{ written?: boolean }>('/netlist/restore', { filename, graph })
  return !!data.written
}
