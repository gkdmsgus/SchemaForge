// Checks A1-A22: sign-up, sign-in, history, favorites and the AI editor's chat against Supabase (index.ts). A mock
// Supabase runs on a local port: GoTrue (sign-up, the password and refresh grants, /user, logout) and a small
// in-memory PostgREST for sessions, chat_messages and favorites that records the headers of every request. The
// real server runs in production mode with ALLOWED_EMAILS=a@x.com; its model calls go to the mock too. A22 runs it
// once more in development without Supabase (the local sign-in). No real Supabase project, no model, no KiCad.
// Usage (from server/): npx tsx check_auth_flow.ts   → exit 0 only if all pass
import { spawn, type ChildProcess } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'http'
import { createServer as createNetServer, type AddressInfo } from 'net'
import { join } from 'path'

let ok = true
const check = (name: string, pass: boolean, info = '') => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

// ── the mock Supabase ──────────────────────────────────────────────

const SERVICE_KEY = 'SERVICE_KEY'
type Row = Record<string, unknown>
interface MockUser { id: string; email: string; password: string; confirmed: boolean }

const users = new Map<string, MockUser>()                       // by email
const access = new Map<string, { uid: string; exp: number }>()  // access token → owner and expiry; logout drops them
const refresh = new Map<string, string>()                       // refresh token → owner; each works once
const tables: Record<string, Row[]> = { sessions: [], chat_messages: [], favorites: [] }
/** every request the server sent to the mock, with the key it sent */
const seen: { method: string; path: string; grant: string; auth: string; apikey: string }[] = []
/** "Confirm email" off: sign-up answers with a session */
const mock = { confirmOff: false }

const PW = { a: 'pw-a-123456', b: 'pw-b-123456' }
users.set('a@x.com', { id: randomUUID(), email: 'a@x.com', password: PW.a, confirmed: true })
users.set('b@x.com', { id: randomUUID(), email: 'b@x.com', password: PW.b, confirmed: true })

const now = () => Math.floor(Date.now() / 1000)
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const byId = (id: string) => [...users.values()].find(u => u.id === id)

/** a token shaped like Supabase's (header.payload.signature), valid until `exp` or the user's logout */
function issue(u: MockUser, exp = now() + 3600) {
  const token = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: u.id, email: u.email, exp, iat: now(), aud: 'authenticated', role: 'authenticated' }),
    randomBytes(16).toString('base64url')].join('.')
  access.set(token, { uid: u.id, exp })
  return token
}
const userJson = (u: MockUser) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.confirmed ? new Date().toISOString() : null,
  app_metadata: { provider: 'email' }, user_metadata: {},
  identities: [{ id: u.id, user_id: u.id, provider: 'email', identity_data: { email: u.email, sub: u.id } }],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
})
function session(u: MockUser) {
  const rt = randomBytes(12).toString('hex')
  refresh.set(rt, u.id)
  return { access_token: issue(u), token_type: 'bearer', expires_in: 3600, expires_at: now() + 3600, refresh_token: rt, user: userJson(u) }
}

/** created_at a second apart, so "newest first" has one answer */
let clock = Date.parse('2026-01-01T00:00:00Z')
const stamp = () => new Date(clock += 1000).toISOString()

function send(rs: ServerResponse, status: number, body?: unknown) {
  // the API version header makes auth-js read error codes from `code`, as it does with Supabase today
  rs.writeHead(status, { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' })
  rs.end(body === undefined ? '' : JSON.stringify(body))
}
const authError = (rs: ServerResponse, status: number, code: string, message: string) => send(rs, status, { code, message })

function gotrue(method: string, path: string, q: URLSearchParams, token: string, body: Row, rs: ServerResponse) {
  if (method === 'POST' && path === '/signup') {
    const email = String(body.email).toLowerCase()
    if (email === 'rate@x.com') return authError(rs, 429, 'over_email_send_rate_limit', 'email rate limit exceeded')
    if (String(body.password).length < 6) {
      return send(rs, 422, { code: 'weak_password', message: 'Password should be at least 6 characters.', weak_password: { reasons: ['length'] } })
    }
    let u = users.get(email)
    if (u && mock.confirmOff) return authError(rs, 422, 'user_already_exists', 'User already registered')
    // an address already confirmed: Supabase answers with a stand-in user without identities and sends no mail
    if (u?.confirmed && !mock.confirmOff) return send(rs, 200, { ...userJson({ ...u, id: randomUUID() }), identities: [] })
    if (!u) users.set(email, u = { id: randomUUID(), email, password: String(body.password), confirmed: mock.confirmOff })
    // "Confirm email" on: Supabase answers with the user alone
    return send(rs, 200, mock.confirmOff ? session(u) : userJson(u))
  }
  if (method === 'POST' && path === '/token' && q.get('grant_type') === 'password') {
    const u = users.get(String(body.email).toLowerCase())
    if (!u || u.password !== body.password) return authError(rs, 400, 'invalid_credentials', 'Invalid login credentials')
    if (!u.confirmed) return authError(rs, 400, 'email_not_confirmed', 'Email not confirmed')
    return send(rs, 200, session(u))
  }
  if (method === 'POST' && path === '/token' && q.get('grant_type') === 'refresh_token') {
    const uid = refresh.get(String(body.refresh_token))
    refresh.delete(String(body.refresh_token))
    const u = uid ? byId(uid) : undefined
    if (!u) return authError(rs, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
    return send(rs, 200, session(u))
  }
  const t = access.get(token)
  const u = t && t.exp > now() ? byId(t.uid) : undefined
  if (method === 'GET' && path === '/user') return u ? send(rs, 200, userJson(u)) : authError(rs, 403, 'bad_jwt', 'invalid JWT: unknown or expired')
  if (method === 'POST' && path === '/logout') {
    if (!u) return authError(rs, 403, 'bad_jwt', 'invalid JWT')
    for (const [k, v] of access) if (v.uid === u.id) access.delete(k)  // scope=global: every device
    return send(rs, 204)
  }
  send(rs, 404, { code: 'not_found', message: `mock: no ${method} /auth/v1${path}` })
}

/** the columns of schema.sql; NOT NULL ones are refused empty like Postgres does */
const COLUMNS: Record<string, string[]> = {
  sessions: ['id', 'user_id', 'prompt', 'code', 'guide', 'graph', 'filename', 'created_at', 'name'],
  chat_messages: ['id', 'session_id', 'role', 'content', 'actions', 'created_at'],
  favorites: ['id', 'user_id', 'session_id', 'created_at'],
}
const NOT_NULL: Record<string, string[]> = { sessions: ['prompt'], chat_messages: ['session_id', 'role', 'content'], favorites: ['user_id', 'session_id'] }

class PgError { constructor(public status: number, public body: Row) {} }
const noColumn = (table: string, c: string) => new PgError(400, { code: '42703', message: `column ${table}.${c} does not exist` })

/** select=a,b,embedded(c,d): split at the commas outside parentheses */
function splitTop(s: string) {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && !depth) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** a row as select= names it; an embedded table follows <table minus s>_id (favorites.session_id → sessions) */
function project(table: string, row: Row, select: string): Row {
  if (select === '*') return { ...row }
  const out: Row = {}
  for (const item of splitTop(select)) {
    const m = /^(\w+)\((.*)\)$/.exec(item)
    if (m) {
      const fk = `${m[1].replace(/s$/, '')}_id`
      if (!COLUMNS[m[1]] || !COLUMNS[table].includes(fk)) throw new PgError(400, { code: 'PGRST200', message: `no relation ${table} → ${m[1]}` })
      const parent = tables[m[1]].find(r => r.id === row[fk])
      out[m[1]] = parent ? project(m[1], parent, m[2]) : null
    } else {
      if (!COLUMNS[table].includes(item)) throw noColumn(table, item)
      out[item] = row[item]
    }
  }
  return out
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])
/** the filters the server uses: col=eq.value only (anything else fails loudly) */
function matches(table: string, row: Row, q: URLSearchParams) {
  for (const [k, v] of q) {
    if (RESERVED.has(k)) continue
    if (!COLUMNS[table].includes(k)) throw noColumn(table, k)
    if (!v.startsWith('eq.')) throw new PgError(400, { code: 'PGRST100', message: `mock: only eq filters (${k}=${v})` })
    if (String(row[k]) !== v.slice(3)) return false
  }
  return true
}

function checked(table: string, v: Row) {
  for (const k of Object.keys(v)) if (!COLUMNS[table].includes(k)) throw noColumn(table, k)
  return v
}

function insert(table: string, v: Row, onConflict: string | null): Row {
  const row: Row = { ...Object.fromEntries(COLUMNS[table].map(c => [c, null])), id: randomUUID(), created_at: stamp(), ...checked(table, v) }
  for (const c of NOT_NULL[table]) if (row[c] == null) throw new PgError(400, { code: '23502', message: `null value in column "${c}"` })
  if (table === 'chat_messages' && !['user', 'assistant'].includes(String(row.role))) throw new PgError(400, { code: '23514', message: 'role check' })
  if (row.session_id != null && !tables.sessions.some(s => s.id === row.session_id)) throw new PgError(409, { code: '23503', message: 'session_id not in sessions' })
  if (table === 'favorites') {
    const had = tables.favorites.find(f => f.user_id === row.user_id && f.session_id === row.session_id)
    if (had && onConflict === 'user_id,session_id') return Object.assign(had, v)
    if (had) throw new PgError(409, { code: '23505', message: 'duplicate key (user_id, session_id)' })
  }
  tables[table].push(row)
  return row
}

/** delete rows; a session takes its messages and favorites with it (ON DELETE CASCADE) */
function remove(table: string, gone: Row[]) {
  tables[table] = tables[table].filter(r => !gone.includes(r))
  if (table !== 'sessions') return
  const ids = new Set(gone.map(r => r.id))
  for (const t of ['chat_messages', 'favorites']) tables[t] = tables[t].filter(r => !ids.has(r.session_id))
}

function postgrest(method: string, table: string, q: URLSearchParams, headers: IncomingHttpHeaders, body: unknown, rs: ServerResponse) {
  if (!tables[table]) return send(rs, 404, { code: '42P01', message: `relation "public.${table}" does not exist` })
  const represent = String(headers.prefer ?? '').includes('return=representation')
  const single = String(headers.accept ?? '').includes('vnd.pgrst.object')
  const select = q.get('select') ?? '*'
  try {
    project(table, Object.fromEntries(COLUMNS[table].map(c => [c, null])), select)  // a bad select fails before any change
    let rows: Row[]
    if (method === 'GET') {
      rows = tables[table].filter(r => matches(table, r, q))
      const [col, dir] = (q.get('order') ?? '').split('.')
      if (col) rows.sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1))
      if (q.get('limit')) rows = rows.slice(0, Number(q.get('limit')))
    } else if (method === 'POST') {
      rows = (Array.isArray(body) ? body : [body]).map(v => insert(table, v as Row, q.get('on_conflict')))
    } else if (method === 'PATCH') {
      rows = tables[table].filter(r => matches(table, r, q))
      for (const r of rows) Object.assign(r, checked(table, body as Row))
    } else if (method === 'DELETE') {
      rows = tables[table].filter(r => matches(table, r, q))
      remove(table, rows)
    } else {
      return send(rs, 405, { message: `mock: ${method}` })
    }
    const status = method === 'POST' ? 201 : 200
    if (method !== 'GET' && !represent) return send(rs, method === 'POST' ? 201 : 204)
    const out = rows.map(r => project(table, r, select))
    if (!single) return send(rs, status, out)
    if (out.length === 1) return send(rs, status, out[0])
    send(rs, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${out.length} rows`, hint: null })
  } catch (e) {
    if (!(e instanceof PgError)) throw e
    send(rs, e.status, e.body)
  }
}

const mockServer = createServer((rq, rs) => {
  let raw = ''
  rq.on('data', (d: Buffer) => { raw += d.toString() })
  rq.on('end', () => {
    const url = new URL(rq.url ?? '/', 'http://mock')
    const method = rq.method ?? 'GET'
    const auth = String(rq.headers.authorization ?? '')
    seen.push({ method, path: url.pathname, grant: url.searchParams.get('grant_type') ?? '', auth, apikey: String(rq.headers.apikey ?? '') })
    let body: unknown = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { return send(rs, 400, { message: 'mock: body is not JSON' }) }
    if (url.pathname.startsWith('/auth/v1/')) return gotrue(method, url.pathname.slice(8), url.searchParams, auth.replace(/^Bearer /, ''), body as Row, rs)
    if (url.pathname.startsWith('/rest/v1/')) return postgrest(method, url.pathname.slice(9), url.searchParams, rq.headers, body, rs)
    // /clarify's model call: a design request that needs no questions
    if (url.pathname === '/openai/v1/chat/completions') {
      return send(rs, 200, {
        id: 'chatcmpl-mock', object: 'chat.completion', created: now(), model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"clear":true}' }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    send(rs, 404, { message: `mock: no ${method} ${url.pathname}` })
  })
})
const stopMock = () => new Promise<void>(resolve => { mockServer.close(() => resolve()); mockServer.closeAllConnections() })

// ── the real server ────────────────────────────────────────────────

/** a port the system says is free (a fixed or random one can sit in a range Windows reserves for Hyper-V and Docker) */
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo
    s.close(() => resolve(port))
  })
})

/** index.ts on a free port (an empty value is kept: dotenv never overrides one) */
async function startServer(env: Record<string, string>) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const proc = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'index.ts'], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout!.on('data', (d: Buffer) => { log += d.toString() })
  proc.stderr!.on('data', (d: Buffer) => { log += d.toString() })
  proc.on('exit', code => { log += ` [exited ${code}]` })
  let up = false
  for (let t0 = Date.now(); !up && Date.now() - t0 < 30000; await new Promise(r => setTimeout(r, 300))) {
    up = await fetch(base + '/health').then(r => r.ok, () => false)
  }
  return { proc, base, up, log: () => log }
}

async function stopServer(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const gone = new Promise(r => proc.once('exit', r))
  proc.kill()
  await gone
}

/** a response body: whatever JSON the route sent */
type Json = any
let base = ''
async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await r.text()
  let body: Json = {}
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, body, text }
}
const brief = (r: { status: number; text: string }) => `${r.status} ${r.text.replace(/\s+/g, ' ').slice(0, 140)}`
const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)
const keysOf = (o: Json) => Object.keys(o ?? {}).sort().join(',')

const EXPIRED = '로그인이 만료되었습니다. 다시 로그인하세요.'
const DOWN = '로그인 서버(Supabase)에 연결하지 못했습니다. 잠시 후 다시 시도하세요.'
const G = { components: [{ ref: 'R1', value: '1k' }, { ref: 'D1', value: 'RED' }], nets: [{ name: 'GND', nodes: [{ ref: 'D1', pin: '2' }] }] }
const G2 = { components: [{ ref: 'R1', value: '2k' }, { ref: 'D1', value: 'RED' }], nets: [{ name: 'GND', nodes: [{ ref: 'D1', pin: '2' }] }] }

async function flow() {
  // A1. sign-up with "Confirm email" on: a mail to open, no token yet
  const reg = await call('POST', '/auth/register', { body: { email: 'c@x.com', password: 'pw-c-123456' } })
  check('A1 register: needsConfirm, no token', reg.status === 200 && reg.body.needsConfirm === true && !reg.body.token && !reg.body.refresh_token
    && reg.body.message === 'c@x.com로 가입 확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요.', brief(reg))

  // A2. sign-up refusals in Korean: a weak password, the mail rate limit
  const weak = await call('POST', '/auth/register', { body: { email: 'd@x.com', password: '123' } })
  const rate = await call('POST', '/auth/register', { body: { email: 'rate@x.com', password: 'pw-123456' } })
  check('A2 register refusals in Korean', weak.status === 400 && /비밀번호/.test(weak.body.error) && rate.status === 429 && /메일/.test(rate.body.error),
    `${brief(weak)} | ${brief(rate)}`)

  // A2b. signing up again with an address already confirmed: Supabase sends no mail, so the server says to log in
  const again = await call('POST', '/auth/register', { body: { email: 'a@x.com', password: 'pw-other-123456' } })
  check('A2b register an address already confirmed: 409, log in', again.status === 409 && /이미 가입한 이메일/.test(again.body.error) && !again.body.needsConfirm,
    brief(again))

  // A3. sign-up with "Confirm email" off: signed in at once
  mock.confirmOff = true
  const regNow = await call('POST', '/auth/register', { body: { email: 'e@x.com', password: 'pw-e-123456' } })
  mock.confirmOff = false
  check('A3 register, confirm off: user, token, refresh_token', regNow.status === 200 && !regNow.body.needsConfirm && !!regNow.body.token
    && !!regNow.body.refresh_token && regNow.body.user?.email === 'e@x.com' && isUuid(regNow.body.user?.id), brief(regNow))

  // A4. an unconfirmed account cannot log in, and is told why (not "wrong password")
  const unconf = await call('POST', '/auth/login', { body: { email: 'c@x.com', password: 'pw-c-123456' } })
  check('A4 login unconfirmed: 403 email_not_confirmed', unconf.status === 403 && unconf.body.code === 'email_not_confirmed'
    && unconf.body.error === '가입 확인 메일의 링크를 누른 뒤에 로그인할 수 있습니다. 메일이 없으면 스팸함을 확인하세요.', brief(unconf))

  // A5. a wrong password
  const wrong = await call('POST', '/auth/login', { body: { email: 'a@x.com', password: 'nope' } })
  check('A5 login wrong password: 401', wrong.status === 401 && wrong.body.error === '이메일 또는 비밀번호가 올바르지 않습니다.', brief(wrong))

  // A6. a and b log in, one after the other
  const la = await call('POST', '/auth/login', { body: { email: 'a@x.com', password: PW.a } })
  const lb = await call('POST', '/auth/login', { body: { email: 'b@x.com', password: PW.b } })
  const A: string = la.body.token, B: string = lb.body.token
  check('A6 login a and b', la.status === 200 && lb.status === 200 && !!A && !!B && A !== B && !!la.body.refresh_token
    && la.body.user?.email === 'a@x.com' && lb.body.user?.email === 'b@x.com', `${brief(la)} | ${lb.status}`)
  const loginsDone = seen.length

  // A7. a's history: create, list newest first, rename, save an AI edit (graph, code, filename)
  const s1 = await call('POST', '/sessions', { token: A, body: { prompt: 'LED 1', code: 'c1', guide: 'g1', graph: G, filename: 'led1_aaaa.net' } })
  const s2 = await call('POST', '/sessions', { token: A, body: { prompt: 'LED 2', code: 'c2', graph: G, filename: 'led2_bbbb.net' } })
  const sb = await call('POST', '/sessions', { token: B, body: { prompt: 'B circuit', graph: G } })
  const id1: string = s1.body.id, id2: string = s2.body.id
  const ren = await call('PATCH', `/sessions/${id1}`, { token: A, body: { name: '내 LED' } })
  const edit = await call('PATCH', `/sessions/${id2}`, { token: A, body: { graph: G2, code: 'c2-edited', filename: 'led2_cccc.net' } })
  const empty = await call('PATCH', `/sessions/${id2}`, { token: A, body: {} })
  const list = (await call('GET', '/sessions', { token: A })).body.sessions ?? []
  check('A7 a: create, list newest first, rename, PATCH graph/code', [s1, s2, sb].every(r => r.status === 200 && isUuid(r.body.id))
    && ren.status === 200 && ren.body.ok === true && edit.status === 200 && empty.status === 400
    && list.length === 2 && list[0].id === id2 && list[1].id === id1 && list[1].name === '내 LED' && list[0].name === null
    && list[0].code === 'c2-edited' && list[0].filename === 'led2_cccc.net' && list[0].graph?.components?.[0]?.value === '2k'
    && keysOf(list[0]) === 'code,created_at,filename,graph,guide,id,name,prompt', `${list.length} sessions, keys ${keysOf(list[0])}, ${brief(ren)}`)

  // A8. b cannot touch a's session: rename, delete, read or write its messages, star it — all 404, nothing changed
  const tries = {
    rename: await call('PATCH', `/sessions/${id1}`, { token: B, body: { name: 'b was here' } }),
    delete: await call('DELETE', `/sessions/${id1}`, { token: B }),
    read: await call('GET', `/sessions/${id1}/messages`, { token: B }),
    write: await call('POST', `/sessions/${id1}/messages`, { token: B, body: { role: 'user', content: 'x' } }),
    star: await call('POST', '/favorites', { token: B, body: { session_id: id1 } }),
  }
  const still = (await call('GET', '/sessions', { token: A })).body.sessions ?? []
  check("A8 b cannot rename/delete/read a's session: 404", Object.values(tries).every(r => r.status === 404)
    && still.length === 2 && still.find((s: Json) => s.id === id1)?.name === '내 LED' && tables.chat_messages.length === 0,
    Object.entries(tries).map(([k, r]) => `${k} ${r.status}`).join(', '))

  // A9. delete one: a's own session goes, a second delete is 404
  const s3 = await call('POST', '/sessions', { token: A, body: { prompt: 'to delete' } })
  const del1 = await call('DELETE', `/sessions/${s3.body.id}`, { token: A })
  const del2 = await call('DELETE', `/sessions/${s3.body.id}`, { token: A })
  const left = (await call('GET', '/sessions', { token: A })).body.sessions ?? []
  check('A9 delete one session', del1.status === 200 && del1.body.ok === true && del2.status === 404 && left.length === 2
    && !left.some((s: Json) => s.id === s3.body.id), `${brief(del1)} | ${del2.status}`)

  // A10. the AI editor's turn is saved and read back in order; a role the table refuses is a 400, not a 500
  const m1 = await call('POST', `/sessions/${id1}/messages`, { token: A, body: { role: 'user', content: 'R1을 2k로 바꿔줘' } })
  const m2 = await call('POST', `/sessions/${id1}/messages`, { token: A, body: { role: 'assistant', content: '바꿨습니다', actions: [{ type: 'set_value', ref: 'R1', value: '2k' }] } })
  const bad = await call('POST', `/sessions/${id1}/messages`, { token: A, body: { role: 'system', content: 'x' } })
  const msgs = (await call('GET', `/sessions/${id1}/messages`, { token: A })).body.messages ?? []
  check('A10 messages saved and read', m1.status === 200 && m2.status === 200 && m2.body.ok === true && bad.status === 400 && msgs.length === 2
    && msgs[0].role === 'user' && msgs[1].role === 'assistant' && msgs[1].actions?.[0]?.value === '2k'
    && keysOf(msgs[0]) === 'actions,content,created_at,role', `${msgs.length} messages, keys ${keysOf(msgs[0])}, bad ${bad.status}`)

  // A11. favorites: add (twice gives one row), list in the front end's shape, b cannot remove it, a can
  const f1 = await call('POST', '/favorites', { token: A, body: { session_id: id1 } })
  const f1again = await call('POST', '/favorites', { token: A, body: { session_id: id1 } })
  const favs = (await call('GET', '/favorites', { token: A })).body.favorites ?? []
  const bFavs = (await call('GET', '/favorites', { token: B })).body.favorites ?? []
  await call('DELETE', `/favorites/${f1.body.id}`, { token: B })
  const kept = (await call('GET', '/favorites', { token: A })).body.favorites ?? []
  const rm = await call('DELETE', `/favorites/${f1.body.id}`, { token: A })
  const gone = (await call('GET', '/favorites', { token: A })).body.favorites ?? []
  const f = favs[0] ?? {}
  check('A11 favorites: shape {id, sessionId, prompt, graph, filename, createdAt}', f1.status === 200 && isUuid(f1.body.id) && f1again.body.id === f1.body.id
    && favs.length === 1 && keysOf(f) === 'createdAt,filename,graph,id,prompt,sessionId' && f.id === f1.body.id && f.sessionId === id1
    && f.prompt === 'LED 1' && f.filename === 'led1_aaaa.net' && f.graph?.components?.length === 2 && !Number.isNaN(Date.parse(f.createdAt))
    && bFavs.length === 0 && kept.length === 1 && rm.status === 200 && gone.length === 0, `${favs.length} favorite(s): ${JSON.stringify(f).slice(0, 160)}`)
  await call('POST', '/favorites', { token: A, body: { session_id: id1 } })  // starred again for A17's cascade

  // A12. refresh: a new token that works; a used refresh token does not work twice
  const rf = await call('POST', '/auth/refresh', { body: { refresh_token: la.body.refresh_token } })
  const meNew = await call('GET', '/auth/me', { token: rf.body.token })
  const rfAgain = await call('POST', '/auth/refresh', { body: { refresh_token: la.body.refresh_token } })
  const rfNone = await call('POST', '/auth/refresh', { body: {} })
  check('A12 refresh -> new token', rf.status === 200 && !!rf.body.token && rf.body.token !== A && !!rf.body.refresh_token
    && rf.body.refresh_token !== la.body.refresh_token && meNew.status === 200 && meNew.body.user?.email === 'a@x.com'
    && [rfAgain, rfNone].every(r => r.status === 401 && r.body.code === 'auth_expired'), `${brief(rf)} | again ${rfAgain.status} | none ${rfNone.status}`)

  // A13. an expired or garbage token is "log in again", on a requireAuth route and behind the guard alike
  const expired = issue(users.get('a@x.com')!, now() - 60)
  const exp = [
    await call('GET', '/sessions', { token: expired }),
    await call('GET', '/sessions', { token: 'garbage' }),
    await call('POST', '/clarify', { token: expired, body: { description: 'LED 깜빡이' } }),
    await call('GET', '/auth/me', { token: 'garbage' }),
  ]
  check('A13 expired/garbage token: 401 auth_expired', exp.every(r => r.status === 401 && r.body.code === 'auth_expired' && r.body.error === EXPIRED),
    exp.map(brief).join(' | ').slice(0, 300))

  // A14. no token at all: 401 login_required
  const none = [await call('GET', '/sessions'), await call('POST', '/sessions', { body: { prompt: 'x' } }), await call('GET', '/favorites'),
    await call('POST', '/clarify', { body: { description: 'LED 깜빡이' } })]
  check('A14 no token: 401 login_required', none.every(r => r.status === 401 && r.body.code === 'login_required' && typeof r.body.error === 'string' && !!r.body.error),
    none.map(r => `${r.status} ${r.body.code}`).join(', '))

  // A15. the guard: b (not in ALLOWED_EMAILS) is refused with its code; a gets past it (the mock model answers)
  const cb = await call('POST', '/clarify', { token: B, body: { description: 'LED 깜빡이' } })
  const ca = await call('POST', '/clarify', { token: A, body: { description: 'LED 깜빡이' } })
  check('A15 guard: b 403 not_allowed, a passes', cb.status === 403 && cb.body.code === 'not_allowed' && /이 계정은/.test(cb.body.error)
    && ca.status !== 401 && ca.status !== 403, `b ${brief(cb)} | a ${brief(ca)}`)

  // A16. /auth/me says before anything is typed whether this account may generate here
  const meA = await call('GET', '/auth/me', { token: A })
  const meB = await call('GET', '/auth/me', { token: B })
  check('A16 /auth/me canGenerate: a true, b false', meA.status === 200 && meA.body.canGenerate === true && meA.body.user?.email === 'a@x.com'
    && meB.status === 200 && meB.body.canGenerate === false && meB.body.user?.email === 'b@x.com', `${brief(meA)} | ${brief(meB)}`)

  // A17. DELETE /sessions takes all of a's history (its messages and favorites with it) and leaves b's
  const all = await call('DELETE', '/sessions', { token: A })
  const aLeft = (await call('GET', '/sessions', { token: A })).body.sessions ?? []
  const bLeft = (await call('GET', '/sessions', { token: B })).body.sessions ?? []
  const aFavs = (await call('GET', '/favorites', { token: A })).body.favorites ?? []
  check("A17 DELETE /sessions removes only a's", all.status === 200 && all.body.deleted === 2 && aLeft.length === 0 && bLeft.length === 1
    && bLeft[0].prompt === 'B circuit' && aFavs.length === 0 && tables.chat_messages.length === 0, `${brief(all)}, b keeps ${bLeft.length}`)

  // A18. logout ends b's sign-in
  const out = await call('POST', '/auth/logout', { token: B })
  const after = await call('GET', '/sessions', { token: B })
  check('A18 logout', out.status === 200 && after.status === 401 && after.body.code === 'auth_expired', `${brief(out)} | ${brief(after)}`)

  // A19. every PostgREST request carried the service key, those after a's and b's sign-ins too
  const rest = seen.filter(s => s.path.startsWith('/rest/v1/'))
  const late = seen.slice(loginsDone).filter(s => s.path.startsWith('/rest/v1/'))
  const other = rest.filter(s => s.auth !== `Bearer ${SERVICE_KEY}` || s.apikey !== SERVICE_KEY)
  const logins = seen.filter(s => s.grant === 'password').length
  check('A19 PostgREST always with the service key', rest.length > 20 && late.length > 20 && other.length === 0 && logins >= 4,
    `${rest.length} requests (${late.length} after the logins), ${other.length} with another key${other.length ? `: ${other[0].method} ${other[0].path} ${other[0].auth.slice(0, 30)}` : ''}`)

  // A20. Supabase unreachable (a paused project): 503, not "wrong password" and not "log in again"
  await stopMock()
  const down = {
    login: await call('POST', '/auth/login', { body: { email: 'a@x.com', password: PW.a } }),
    register: await call('POST', '/auth/register', { body: { email: 'f@x.com', password: 'pw-f-123456' } }),
    me: await call('GET', '/auth/me', { token: A }),
    sessions: await call('GET', '/sessions', { token: A }),
    clarify: await call('POST', '/clarify', { token: A, body: { description: 'LED' } }),
  }
  check('A20 Supabase down: 503', Object.values(down).every(r => r.status === 503 && r.body.error === DOWN),
    Object.entries(down).map(([k, r]) => `${k} ${r.status}`).join(', '))

  // A21. /netlist/restore writes a netlist Render's disk lost, once; never overwrites; refuses a name with a path
  const name = `restorecheck_${randomUUID().slice(0, 8)}.net`
  const path = join(process.cwd(), 'outputs', name)
  try {
    const first = await call('POST', '/netlist/restore', { body: { filename: name, graph: G } })
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const second = await call('POST', '/netlist/restore', { body: { filename: name, graph: G2 } })
    const same = existsSync(path) && readFileSync(path, 'utf8') === text
    const refused = await Promise.all(['../evil.net', 'x.txt', 'a b.net', ''].map(n => call('POST', '/netlist/restore', { body: { filename: n, graph: G } })))
    const noGraph = await call('POST', '/netlist/restore', { body: { filename: `restorecheck_${randomUUID().slice(0, 8)}.net` } })
    check('A21 /netlist/restore', first.status === 200 && first.body.written === true && /\(ref "R1"\) \(value "1k"\)/.test(text)
      && second.status === 200 && second.body.written === false && same && refused.every(r => r.status === 400) && noGraph.status === 400
      && !existsSync(join(process.cwd(), 'evil.net')), `${brief(first)} | ${brief(second)} | refused ${refused.map(r => r.status).join(',')} | no graph ${noGraph.status}`)
  } finally {
    try { unlinkSync(path) } catch { /* not written */ }
  }
}

// A22. development without Supabase: the password-free local sign-in and an empty history, as before
async function devFlow() {
  const reg = await call('POST', '/auth/register', { body: { email: 'dev@x.com', password: 'x' } })
  const T: string = reg.body.token
  const login = await call('POST', '/auth/login', { body: { email: 'dev@x.com', password: 'x' } })
  const me = await call('GET', '/auth/me', { token: T })
  const s = await call('POST', '/sessions', { token: T, body: { prompt: 'p' } })
  const r = {
    list: await call('GET', '/sessions', { token: T }),
    patch: await call('PATCH', `/sessions/${s.body.id}`, { token: T, body: { name: 'n' } }),
    msgs: await call('GET', `/sessions/${s.body.id}/messages`, { token: T }),
    fav: await call('POST', '/favorites', { token: T, body: { session_id: s.body.id } }),
    favs: await call('GET', '/favorites', { token: T }),
    all: await call('DELETE', '/sessions', { token: T }),
    refresh: await call('POST', '/auth/refresh', { body: {} }),
    unknown: await call('GET', '/sessions', { token: 'not-a-local-token' }),
  }
  check('A22 development without Supabase: local sign-in, empty history', reg.status === 200 && !!T && !reg.body.needsConfirm && reg.body.user?.email === 'dev@x.com'
    && login.status === 200 && !!login.body.token && me.status === 200 && me.body.canGenerate === true && isUuid(s.body.id)
    && r.list.body.sessions?.length === 0 && r.patch.body.ok === true && r.msgs.body.messages?.length === 0 && isUuid(r.fav.body.id)
    && r.favs.body.favorites?.length === 0 && r.all.body.deleted === 0 && r.refresh.status === 401 && r.refresh.body.code === 'auth_expired'
    && r.unknown.status === 401 && r.unknown.body.code === 'auth_expired', `${brief(reg)} | ${Object.entries(r).map(([k, v]) => `${k} ${v.status}`).join(', ')}`)
}

async function main() {
  await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', () => resolve()))
  const mockUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`
  const prod = await startServer({
    NODE_ENV: 'production', SUPABASE_URL: mockUrl, SUPABASE_SERVICE_KEY: SERVICE_KEY, ALLOWED_EMAILS: 'a@x.com',
    OPENAI_API_KEY: 'sk-mock', OPENAI_BASE_URL: `${mockUrl}/openai/v1`,
  })
  try {
    if (!prod.up) return check('A0 production server on the mock Supabase', false, `did not start in 30 s: ${prod.log().trim().slice(-400)}`)
    base = prod.base
    await flow()
  } finally {
    await stopServer(prod.proc)
    if (mockServer.listening) await stopMock()
  }
  const dev = await startServer({ NODE_ENV: 'development', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '' })
  try {
    if (!dev.up) return check('A22 development server', false, `did not start in 30 s: ${dev.log().trim().slice(-400)}`)
    base = dev.base
    await devFlow()
  } finally {
    await stopServer(dev.proc)
  }
}

// exitCode, not process.exit(): exiting with fetch's sockets still open crashed Node on Windows (0xC0000409)
main().catch(e => check('A auth flow', false, (e as Error).stack ?? String(e))).finally(() => { process.exitCode = ok ? 0 : 1 })
