// Checks src/api.ts against a stubbed fetch + localStorage (no server): saving and reading the login, sign-up
// answers, refresh-and-retry on 401 auth_expired (once, shared by concurrent calls), refusal codes, /auth/me,
// favorites and messages shapes, the session routes. api.ts reads import.meta.env, so a copy with that one
// expression replaced is imported from the system temp folder (its imports are types only).
// Usage: npx tsx scripts/check_api_client.ts   → exit 0 only if all pass
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api.ts')
const OUT = path.join(os.tmpdir(), `sf_api_under_test_${process.pid}.mts`)
fs.writeFileSync(OUT, fs.readFileSync(SRC, 'utf8').replace('import.meta.env.VITE_API_URL', 'undefined'))

// ── stubs ──
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}
type Call = { url: string; method: string; auth: string | null; ctype: string | null; body: string | null }
let calls: Call[] = []
let handler: (c: Call) => Response | Promise<Response> = () => new Response('{}')
;(globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
  const h = new Headers(init.headers)
  const c = { url, method: init.method ?? 'GET', auth: h.get('Authorization'), ctype: h.get('Content-Type'), body: (init.body as string) ?? null }
  calls.push(c)
  return handler(c)
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail}`}`)
  if (!ok) failed++
}

const api = await import(pathToFileURL(OUT).href)
let expiredCalls = 0
api.setAuthExpiredHandler(() => { expiredCalls++ })
const reset = () => { store.clear(); calls = []; expiredCalls = 0 }

// 1-3 saveAuth / loadAuth
reset()
check('saveAuth refuses an empty token', api.saveAuth({ id: '1', email: 'a@b.c' }, '') === false && !store.has('sf_token'))
check('saveAuth stores the refresh token', api.saveAuth({ id: '1', email: 'a@b.c' }, 'T1', 'R1') === true && store.get('sf_refresh') === 'R1')
api.saveAuth({ id: '1', email: 'a@b.c' }, 'T2')
check('saveAuth without a refresh token drops an older one', !store.has('sf_refresh') && store.get('sf_token') === 'T2')
store.set('sf_token', 'undefined'); store.set('sf_user', '{"id":"1","email":"a@b.c"}')
check('loadAuth ignores the "undefined" token an older build saved', api.loadAuth() === null)
store.set('sf_token', '')
check('loadAuth ignores an empty token', api.loadAuth() === null)

// 4 register shapes
reset()
handler = () => json(200, { needsConfirm: true, message: 'a@b.c로 가입 확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요.' })
let r = await api.register('a@b.c', 'pw1234')
check('register: needsConfirm passes the server message', r.needsConfirm === true && r.message.startsWith('a@b.c로'))
handler = () => json(200, { user: { id: 'u', email: 'a@b.c' }, session: null })
r = await api.register('a@b.c', 'pw1234')
check('register: an older server with session null also means needsConfirm', r.needsConfirm === true)
handler = () => json(200, { user: { id: 'u', email: 'a@b.c' }, token: 'TK', refresh_token: 'RT' })
r = await api.register('a@b.c', 'pw1234')
check('register: a session gives user, token and refresh_token', !r.needsConfirm && r.token === 'TK' && r.refresh_token === 'RT')
handler = () => json(429, { error: '메일 발송 한도를 넘었습니다.' })
try { await api.register('a@b.c', 'pw1234'); check('register: 4xx throws', false) } catch (e: any) {
  check('register: 4xx throws the server text with its status', e.message === '메일 발송 한도를 넘었습니다.' && e.status === 429)
}
check('register sends no Authorization header', calls.every(c => c.auth === null))

// 5 login errors
reset()
handler = () => json(403, { error: '가입 확인 메일의 링크를 누른 뒤에 로그인할 수 있습니다. 메일이 없으면 스팸함을 확인하세요.', code: 'email_not_confirmed' })
try { await api.login('a@b.c', 'x'); check('login 403 throws', false) } catch (e: any) {
  check('login 403 email_not_confirmed: server text and code', e.status === 403 && e.code === 'email_not_confirmed' && e.message.startsWith('가입 확인 메일'))
}
handler = () => new Response('<html>Bad gateway</html>', { status: 502 })
try { await api.login('a@b.c', 'x'); check('login 502 throws', false) } catch (e: any) {
  check('a non-JSON error page reads as its status, not HTML', e.message === 'HTTP 502', e.message)
}
handler = () => json(200, { user: { id: 'u', email: 'a@b.c' } })
try { await api.login('a@b.c', 'x'); check('login without token throws', false) } catch (e: any) {
  check('login answered without a token is an error, not a login', /토큰/.test(e.message))
}

// 6 refresh and retry
reset()
api.saveAuth({ id: 'u', email: 'a@b.c' }, 'OLD', 'R-OLD')
handler = c => {
  if (c.url === '/auth/refresh') return json(200, { token: 'NEW', refresh_token: 'R-NEW' })
  return c.auth === 'Bearer NEW' ? json(200, { sessions: [] }) : json(401, { error: '로그인이 만료되었습니다. 다시 로그인하세요.', code: 'auth_expired' })
}
const list = await api.getSessions()
check('auth_expired: refreshed once, request sent again, answer used', Array.isArray(list) && calls.map(c => c.url).join(',') === '/sessions,/auth/refresh,/sessions')
check('refresh saves the new token and refresh token', store.get('sf_token') === 'NEW' && store.get('sf_refresh') === 'R-NEW')
check('refresh request carries the refresh token', JSON.parse(calls[1].body!).refresh_token === 'R-OLD')
check('a renewed login does not call the expired handler', expiredCalls === 0)

// 7 refresh fails
reset()
api.saveAuth({ id: 'u', email: 'a@b.c' }, 'OLD', 'R-OLD')
handler = c => c.url === '/auth/refresh' ? json(401, { error: 'x', code: 'auth_expired' }) : json(401, { error: '로그인이 만료되었습니다. 다시 로그인하세요.', code: 'auth_expired' })
const res7 = await api.authFetch('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
check('refresh refused: the 401 comes back and the app is told once', res7.status === 401 && expiredCalls === 1, `status ${res7.status} handler ${expiredCalls}`)
check('the 401 body is still readable by the caller', (await res7.json()).code === 'auth_expired')
check('Content-Type of the caller is kept next to the token', calls[0].auth === 'Bearer OLD' && calls[0].ctype === 'application/json')

// 7b no refresh token (local dev login)
reset()
api.saveAuth({ id: 'u', email: 'a@b.c' }, 'DEV')
handler = () => json(401, { error: '로그인이 만료되었습니다. 다시 로그인하세요.', code: 'auth_expired' })
await api.authFetch('/chat_edit', { method: 'POST' })
check('no refresh token: no refresh request, the app is told', calls.length === 1 && expiredCalls === 1)

// 8 login_required
reset()
handler = () => json(401, { error: '로그인해야 쓸 수 있습니다.', code: 'login_required' })
const res8 = await api.authFetch('/generate', { method: 'POST' })
check('login_required (no token): no refresh, no expired handler', res8.status === 401 && calls.length === 1 && expiredCalls === 0)

// 9 concurrent 401s share one refresh
reset()
api.saveAuth({ id: 'u', email: 'a@b.c' }, 'OLD', 'R-OLD')
handler = async c => {
  if (c.url === '/auth/refresh') { await new Promise(r => setTimeout(r, 30)); return json(200, { token: 'NEW', refresh_token: 'R-NEW' }) }
  return c.auth === 'Bearer NEW' ? json(200, { favorites: [] }) : json(401, { error: 'x', code: 'auth_expired' })
}
await Promise.all([api.getFavorites(), api.getSessions().catch(() => null), api.getFavorites()])
check('three requests failing together renew the login once', calls.filter(c => c.url === '/auth/refresh').length === 1)

// 10 getMe 503 keeps the login
reset()
api.saveAuth({ id: 'u', email: 'a@b.c' }, 'T', 'R')
handler = () => json(503, { error: '로그인 서버(Supabase)에 연결하지 못했습니다. 잠시 후 다시 시도하세요.' })
const me = await api.getMe()
check('getMe 503: status 503, token kept, no handler', me.status === 503 && store.get('sf_token') === 'T' && expiredCalls === 0)
handler = () => json(200, { user: { id: 'u', email: 'a@b.c' }, canGenerate: false })
check('getMe 200 passes canGenerate', (await api.getMe()).canGenerate === false)
handler = c => c.url === '/auth/refresh' ? json(401, { error: 'x', code: 'auth_expired' }) : json(401, { error: 'x', code: 'auth_expired' })
const me401 = await api.getMe()
check('getMe 401 after a failed refresh: 401 back, the handler is not called (start-up stays quiet)', me401.status === 401 && expiredCalls === 0)

// 11 logout
reset()
api.saveAuth({ id: 'u', email: 'a@b.c' }, 'T', 'R')
handler = () => json(200, { ok: true })
await api.logout()
check('logout clears token, user and refresh token', !store.has('sf_token') && !store.has('sf_user') && !store.has('sf_refresh'))
check('logout sends the token and is never refreshed', calls.length === 1 && calls[0].auth === 'Bearer T')

// 12 favourites: new and old shapes
reset()
handler = () => json(200, { favorites: [
  { id: 'f1', sessionId: 's1', prompt: 'LED', graph: { components: [] }, filename: 'a.net', createdAt: '2026-10-28T00:00:00Z' },
  { id: 'f2', session_id: 's2', created_at: '2026-10-27T00:00:00Z', sessions: { prompt: '555', graph: { components: [] }, filename: 'b.net' } },
] })
const favs = await api.getFavorites()
check('favourites: the contract shape passes through', favs[0].sessionId === 's1' && favs[0].prompt === 'LED' && favs[0].createdAt.startsWith('2026'))
check('favourites: an older joined row is reshaped', favs[1].sessionId === 's2' && favs[1].prompt === '555' && favs[1].filename === 'b.net' && !!favs[1].createdAt)

// 13 restoreNetlist
reset()
handler = () => json(200, { ok: true, written: true })
check('restoreNetlist: a bad filename is not sent', (await api.restoreNetlist('../x.net', {})) === false && calls.length === 0)
check('restoreNetlist: a good one is sent and says written', (await api.restoreNetlist('led_ab12cd34.net', { components: [] })) === true && calls[0].url === '/netlist/restore')

// 14 messages
reset()
handler = () => json(200, { messages: [
  { role: 'user', content: 'R1 100k', actions: null, created_at: 'x' },
  { role: 'assistant', content: '바꿨습니다', actions: [{ type: 'modify_component', ref: 'R1' }], created_at: 'y' },
  { role: 'system', content: 'drop me' },
] })
const msgs = await api.getMessages('s1')
check('getMessages: roles kept, null actions become [], others dropped', msgs.length === 2 && msgs[0].actions.length === 0 && msgs[1].actions[0].ref === 'R1')

// 15 session routes
reset()
handler = () => json(200, { deleted: 3 })
check('deleteAllSessions: DELETE /sessions, returns the count', (await api.deleteAllSessions()) === 3 && calls[0].method === 'DELETE' && calls[0].url === '/sessions')
handler = () => json(404, { error: 'Session not found' })
try { await api.renameSession('s1', 'new'); check('rename 404 throws', false) } catch (e: any) {
  check('renameSession: PATCH, and a 404 throws (the drawer puts the name back)', e.status === 404 && calls.at(-1)!.method === 'PATCH' && JSON.parse(calls.at(-1)!.body!).name === 'new')
}

fs.rmSync(OUT)
console.log(failed ? `\n${failed} FAILED` : '\nall api client checks passed')
process.exitCode = failed ? 1 : 0
