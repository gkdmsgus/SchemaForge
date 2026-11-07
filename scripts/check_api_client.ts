// Checks src/api.ts against a stubbed fetch + localStorage (no server): saving and reading the login, sign-up
// answers, refresh-and-retry on 401 auth_expired (once, shared by concurrent calls), refusal codes, /auth/me,
// favorites and messages shapes, the session routes. The file itself is imported (its imports are types only). Every
// request stays on the page's own address: a build setting that moved half of them (VITE_API_URL) does not come back.
// Usage: npx tsx scripts/check_api_client.ts   → exit 0 only if all pass
import fs from 'node:fs'

// ── stubs ──
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}
type Call = { url: string; method: string; auth: string | null; ctype: string | null; body: string | null }
let calls: Call[] = []
const everyUrl: string[] = []
let handler: (c: Call) => Response | Promise<Response> = () => new Response('{}')
;(globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
  const h = new Headers(init.headers)
  const c = { url, method: init.method ?? 'GET', auth: h.get('Authorization'), ctype: h.get('Content-Type'), body: (init.body as string) ?? null }
  calls.push(c)
  everyUrl.push(url)
  return handler(c)
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail}`}`)
  if (!ok) failed++
}

const api: any = await import('../src/api.ts')
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

// 16 same origin only: the two files that ask the server by themselves read no setting for where it is
reset()
check('every request above went to a path on this page\'s own address', everyUrl.length > 20 && everyUrl.every(u => u.startsWith('/')),
  everyUrl.find(u => !u.startsWith('/')))
const source = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
check('api.ts and modelName.ts read no build setting', !/import\.meta\.env/.test(source('api.ts')) && !/import\.meta\.env/.test(source('lib/modelName.ts')))

// The dev server's proxy (vite.config.ts, read as text) against the server's routes (server/index.ts): vite sends a path
// to the first prefix it starts with, so a prefix no route reaches first does nothing ('/generate_gerber' after
// '/generate', '/test' after '/test_code'), and a route no prefix starts fails in dev only
const root = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const viteConfig = root('vite.config.ts')
const prefixes = [...viteConfig.slice(viteConfig.indexOf('proxy:')).matchAll(/^ {6}'(\/[^']*)':/gm)].map(m => m[1])
const routes = [...root('server/index.ts').matchAll(/^app\.(?:get|post|patch|put|delete)\('(\/[^']*)'/gm)].map(m => m[1])
  .filter(r => r !== '/{*path}')   // the page itself, which vite serves in dev
const firstPrefix = (r: string) => prefixes.find(p => r.startsWith(p))
const used = new Set(routes.map(firstPrefix))
const unused = prefixes.filter(p => !used.has(p)), unserved = routes.filter(r => !firstPrefix(r))
check('the dev proxy: every prefix is the one some server route goes through, and every route has one',
  prefixes.length > 10 && routes.length > 20 && !unused.length && !unserved.length,
  JSON.stringify({ prefixes: prefixes.length, routes: routes.length, unused, unserved }))

// The ports, read as text. Development: the proxy's fallback, the server's default and .env.example's PORT are one port,
// outside 7989-8088, which Windows had reserved on the development PC (8080, then 8002 failed there with EACCES: review of
// 2026-11-07). The images: each sets PORT to the port it exposes, which check_deploy.py and the Jetson script publish, so
// moving the development port does not move the container's
const num = (text: string, re: RegExp) => Number(re.exec(text)?.[1] ?? NaN)
const dev = {
  vite: num(viteConfig, /\.PORT \|\| (\d+)/), server: num(root('server/index.ts'), /const PORT = Number\(process\.env\.PORT\) \|\| (\d+)/),
  example: num(root('server/.env.example'), /^PORT=(\d+)/m),
}
const image = (f: string) => ({ env: num(root(f), /^\s*(?:ENV\s+)?PORT=(\d+)/m), exposed: num(root(f), /^EXPOSE (\d+)/m) })
const images = { docker: image('Dockerfile'), jetson: image('Dockerfile.jetson') }
const published = { checkDeploy: num(root('server/pcb/check_deploy.py'), /\{args\.port\}:(\d+)'/), jetsonRun: num(root('scripts/jetson_run.sh'), /-e PORT=(\d+)/) }
const ports = Object.values(images).flatMap(i => [i.env, i.exposed]).concat(Object.values(published))
check('the ports: one for development, outside 7989-8088; each image sets the PORT it exposes and is published on',
  dev.vite === dev.server && dev.server === dev.example && !(dev.server >= 7989 && dev.server <= 8088)
  && ports.every(p => p === images.docker.exposed) && Number.isInteger(images.docker.exposed),
  JSON.stringify({ dev, images, published }))

// The same file run by vite: a PORT in the environment that both processes got is the API's, but vite's own port is not.
// The preview tool starts vite alone with PORT=3000, and the proxy sent every request back to vite (2026-11-07)
const { loadConfigFromFile } = await import('vite')
const proxyTarget = async (port: string | undefined) => {
  const saved = process.env.PORT
  if (port === undefined) delete process.env.PORT; else process.env.PORT = port
  try {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, new URL('../vite.config.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    return (loaded?.config.server?.proxy as Record<string, unknown> | undefined)?.['/board_model']
  } finally {
    if (saved === undefined) delete process.env.PORT; else process.env.PORT = saved
  }
}
const targets = { none: await proxyTarget(undefined), vite: await proxyTarget('3000'), both: await proxyTarget('8131') }
check('the dev proxy: PORT=3000 (vite\'s own) leaves the API port as without it; a PORT both processes got is followed',
  typeof targets.none === 'string' && !targets.none.endsWith(':3000') && targets.vite === targets.none && targets.both === 'http://localhost:8131',
  JSON.stringify(targets))

console.log(failed ? `\n${failed} FAILED` : '\nall api client checks passed')
process.exitCode = failed ? 1 : 0
