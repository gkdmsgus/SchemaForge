// ── SchemaForge API client ────────────────────────────────────────────────────

const BASE = import.meta.env.VITE_API_URL ?? ''

function token() {
  return localStorage.getItem('sf_token') ?? ''
}

export function authHeaders(): HeadersInit {
  const t = token()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

async function post<T>(path: string, body: unknown, auth = false): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? authHeaders() : {}) },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? res.statusText)
  return data as T
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? res.statusText)
  return data as T
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: authHeaders() })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? res.statusText)
  return data as T
}

// ── Auth ──────────────────────────────────────────────────────────

export interface AuthUser { id: string; email: string }
export interface AuthResponse { user: AuthUser; token: string }

export async function register(email: string, password: string): Promise<AuthResponse> {
  const data = await post<{ user: AuthUser; token?: string; session?: { access_token: string } }>(
    '/auth/register', { email, password }
  )
  return { user: data.user, token: data.token ?? data.session?.access_token ?? '' }
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  return post<AuthResponse>('/auth/login', { email, password })
}

export async function logout(): Promise<void> {
  await post('/auth/logout', {}, true).catch(() => {})
  localStorage.removeItem('sf_token')
  localStorage.removeItem('sf_user')
}

export function saveAuth(user: AuthUser, tok: string) {
  localStorage.setItem('sf_token', tok)
  localStorage.setItem('sf_user', JSON.stringify(user))
}

export function loadAuth(): { user: AuthUser; token: string } | null {
  const tok = localStorage.getItem('sf_token')
  const raw = localStorage.getItem('sf_user')
  if (!tok || !raw) return null
  try { return { user: JSON.parse(raw) as AuthUser, token: tok } } catch { return null }
}

// ── Sessions ──────────────────────────────────────────────────────

export interface DbSession {
  id: string
  name?: string
  prompt: string
  guide?: string
  graph?: unknown
  filename?: string
  created_at: string
}

export async function getSessions(): Promise<DbSession[]> {
  const data = await get<{ sessions: DbSession[] }>('/sessions')
  return data.sessions
}

export async function saveSession(payload: {
  prompt: string; code?: string; guide?: string; graph?: unknown; filename?: string
}): Promise<string> {
  const data = await post<{ id: string }>('/sessions', payload, true)
  return data.id
}

export async function deleteSession(id: string): Promise<void> {
  await del(`/sessions/${id}`)
}

export async function renameSession(id: string, name: string): Promise<void> {
  await fetch(`${BASE}/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name }),
  })
}

// ── Chat Messages ─────────────────────────────────────────────────

export async function getMessages(sessionId: string) {
  return get<{ messages: unknown[] }>(`/sessions/${sessionId}/messages`)
}

export async function saveMessage(sessionId: string, role: string, content: string, actions?: unknown) {
  return post(`/sessions/${sessionId}/messages`, { role, content, actions }, true)
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

export async function getFavorites(): Promise<DbFavorite[]> {
  const data = await get<{ favorites: DbFavorite[] }>('/favorites')
  return data.favorites
}

export async function addFavorite(sessionId: string): Promise<string> {
  const data = await post<{ id: string }>('/favorites', { session_id: sessionId }, true)
  return data.id
}

export async function removeFavorite(id: string): Promise<void> {
  await del(`/favorites/${id}`)
}
