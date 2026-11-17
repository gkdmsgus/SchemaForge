// Checks I1-I2, F1-F4: what the server answers a request it cannot use. Every case is a real request to a server started here,
// in development and in production (NODE_ENV=production), and passes only on the status it names, with JSON whose error
// is a Korean sentence and no stack or server path anywhere in the answer. Express's own pages showed the stack in
// development (a broken JSON body: "SyntaxError ... at JSON.parse" and the server's paths) and English in production.
// I1 the body or address Express could not read: broken JSON, too large, a malformed %-escape; a route that is not there.
// I2 a field of the wrong type or missing on each route that reads a body (a number for a description was a TypeError).
// F1 an opinion (POST /feedback, 의견 남기기) the server cannot use: 400 in Korean on both servers. F2 one it can is kept as
// one JSON line of rating, comment and circuit only (no address, nothing else sent), 500 Korean letters fit. F3 the sixth
// from one address in ten minutes is 429 in Korean, another address still gets through. F4 the file is a dot file in
// outputs/ (the file routes refuse dot files: check_deploy_guard D16) and the server names it nowhere in its answers.
// No model, Supabase or Mouser is called: the model's address is a closed port and no Mouser key is given.
// Usage (from server/): npx tsx check_inputs.ts   → exit 0 only if all pass
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { request } from 'http'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

let ok = true
const check = (name: string, pass: boolean, info = '') => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number }
    s.close(() => resolve(port))
  })
})

interface Server { port: number; proc: ChildProcess; said: () => string }

/** where each server keeps the opinions it is sent (SF_FEEDBACK_FILE), not the checkout's outputs/ */
const FEEDBACK_DIR = mkdtempSync(join(tmpdir(), 'sf_feedback_'))
const feedbackFile = (mode: string) => join(FEEDBACK_DIR, `${mode}.jsonl`)

async function start(mode: 'development' | 'production'): Promise<Server> {
  const port = await freePort()
  const proc = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'index.ts'], {
    env: { ...process.env, NODE_ENV: mode, PORT: String(port), SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '',
           SF_OUTPUTS_SWEEP: '', FRONTEND_URL: '', OPENAI_API_KEY: 'sk-none', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', MOUSER_API_KEY: '', SF_AI_STUB: '',
           SF_FEEDBACK_FILE: feedbackFile(mode) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let said = ''
  proc.stdout!.on('data', (d: Buffer) => { said += d.toString() })
  proc.stderr!.on('data', (d: Buffer) => { said += d.toString() })
  for (const t0 = Date.now(); Date.now() - t0 < 60000 && proc.exitCode === null; await new Promise(r => setTimeout(r, 300))) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false)) return { port, proc, said: () => said }
  }
  throw new Error(`${mode} server did not start in 60 s: ${said.trim().slice(-300)}`)
}

async function stop(s: Server | undefined) {
  if (!s || s.proc.exitCode !== null || s.proc.signalCode !== null) return
  const gone = new Promise(r => s.proc.once('exit', r))
  s.proc.kill()
  await gone
}

/** a request sent as written (the path not resolved, the body not encoded), and the answer */
const ask = (port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
    const sent = body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }
    const r = request({ host: '127.0.0.1', port, path, method, headers: sent }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', d => { text += d })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text }))
    })
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })

/** what may not be in an answer: a stack, a traceback, a server path (this checkout, node_modules, the temp folder) */
const LEAKS = [/\bat .+[(:]\d+/, /Traceback/, /node_modules/, /[A-Za-z]:\\/, /\/app\//, /\/tmp\//]
const leaks = (text: string) => [...LEAKS.filter(re => re.test(text)).map(re => re.source),
  ...[process.cwd(), tmpdir()].filter(p => text.includes(p) || text.includes(p.replace(/\\/g, '\\\\')))]

interface Case { name: string; method: string; path: string; body?: string; status: number; token?: boolean }

/** one case on one server: the status, a JSON error that is a Korean sentence, nothing leaked */
async function run(s: Server, c: Case, token: string) {
  const r = await ask(s.port, c.method, c.path, c.body, c.token && token ? { Authorization: `Bearer ${token}` } : {})
  let error = ''
  try { error = String((JSON.parse(r.text) as { error?: unknown }).error ?? '') } catch { /* not JSON */ }
  const wrong = [r.status !== c.status && `status ${r.status} (want ${c.status})`, !/json/.test(r.type) && `not JSON (${r.type || 'no type'})`,
    !/[가-힣]/.test(error) && 'no Korean sentence', ...leaks(r.text).map(l => `leaks ${l}`)].filter(Boolean)
  return wrong.length ? `${c.name}: ${wrong.join(', ')} [${r.text.slice(0, 120).replace(/\s+/g, ' ')}]` : ''
}

const json = (v: unknown) => JSON.stringify(v)

// I1. what Express itself turned down before any route, and an address no route has
const I1: Case[] = [
  { name: 'broken JSON', method: 'POST', path: '/plan', body: '{"description":', status: 400 },
  { name: 'body over 100 kB', method: 'POST', path: '/auth/login', body: json({ email: 'a'.repeat(200_000), password: 'x' }), status: 413 },
  { name: 'a malformed %-escape', method: 'GET', path: '/download/%E0%A4%A', status: 400 },
  { name: 'no such route', method: 'POST', path: '/no_such_route', body: '{}', status: 404 },
]

// I2. a field of the wrong type or missing, on each route that reads a body (not the board, 3D, gerber and ERC routes).
//     Development only past the sign-in: production refuses these routes to a visitor first (check_deploy_guard D9)
const ID = '00000000-0000-4000-8000-000000000000'
const GRAPH = { components: [], nets: [] }
const I2_SIGN_IN: Case[] = [
  { name: 'register: email a number', method: 'POST', path: '/auth/register', body: json({ email: 5, password: 'x' }), status: 400 },
  { name: 'login: email a list, password an object', method: 'POST', path: '/auth/login', body: json({ email: ['a'], password: {} }), status: 400 },
]
const post = (path: string, body: unknown, name: string, token = false): Case => ({ name: `${path} ${name}`, method: 'POST', path, body: json(body), status: 400, token })
const I2: Case[] = [
  post('/sessions', { prompt: 123 }, 'prompt a number', true),
  post('/sessions', { prompt: 'x', graph: 'a word' }, 'graph a word', true),
  post('/sessions', { prompt: 'x', code: {} }, 'code an object', true),
  { name: '/sessions a list for a body', method: 'POST', path: '/sessions', body: '[1,2]', status: 400, token: true },
  { name: 'PATCH /sessions graph a number', method: 'PATCH', path: `/sessions/${ID}`, body: json({ graph: 5 }), status: 400, token: true },
  { name: 'PATCH /sessions nothing to change', method: 'PATCH', path: `/sessions/${ID}`, body: '{}', status: 400, token: true },
  post(`/sessions/${ID}/messages`, { role: 'user', content: 5 }, 'content a number', true),
  post(`/sessions/${ID}/messages`, { role: 'user', content: 'hi', actions: 'x' }, 'actions a word', true),
  post('/favorites', { session_id: 5 }, 'session_id a number', true),
  post('/clarify', { description: 5 }, 'description a number'),
  post('/clarify', {}, 'no description'),
  post('/plan', { description: {} }, 'description an object'),
  post('/generate', { description: ['x'] }, 'description a list'),
  post('/chat_edit', { graph: { components: 'x', nets: [] }, message: 'x' }, 'parts a word'),
  post('/chat_edit', { graph: { components: [], nets: [{ name: 'A' }] }, message: 'x' }, 'a net with no pin list'),
  post('/chat_edit', { graph: GRAPH, message: 'x', history: 'x' }, 'history a word'),
  post('/chat_edit', { graph: GRAPH, message: 5 }, 'message a number'),
  post('/test_code', { code: 5 }, 'code a number', true),
  // the enclosure's board (2026-11-17): refused before any slot or file, on both servers (the board route is open to all)
  post('/generate_pcb_stream', { filename: 'x.net', mech: 'big' }, 'mech a word'),
  post('/generate_pcb_stream', { filename: 'x.net', mech: { width: 3, height: 30 } }, 'mech 3 mm wide'),
  post('/generate_pcb_stream', { filename: 'x.net', mech: { width: '40', height: 30 } }, 'mech width a word'),
  post('/generate_pcb_stream', { filename: 'x.net', mech: { width: 40, height: 30, holes: [[50, 5]] } }, 'a hole off the board'),
  post('/generate_pcb_stream', { filename: 'x.net', mech: { width: 40, height: 30, holes: Array.from({ length: 13 }, () => [10, 10]) } }, '13 holes'),
  post('/mouser_search', { components: 'x' }, 'components a word'),
  post('/mouser_search', { components: [5] }, 'a line a number'),
  post('/mouser_search', { components: [{ ref: 'R1', value: {} }] }, 'a value an object'),
  post('/mouser_search', { components: Array.from({ length: 61 }, (_, i) => ({ ref: `R${i + 1}`, value: '-' })) }, '61 lines'),
]

// F1. an opinion the server cannot use
const F1: Case[] = [
  post('/feedback', {}, 'no rating'),
  post('/feedback', { rating: 0 }, 'rating 0'),
  post('/feedback', { rating: 6 }, 'rating 6'),
  post('/feedback', { rating: 3.5 }, 'rating 3.5'),
  post('/feedback', { rating: '5' }, 'rating a word'),
  post('/feedback', { rating: 4, comment: 5 }, 'comment a number'),
  post('/feedback', { rating: 4, comment: '가'.repeat(501) }, 'comment 501 letters'),
  post('/feedback', { rating: 4, circuit: {} }, 'circuit an object'),
  post('/feedback', { rating: 4, circuit: 'x'.repeat(81) }, 'circuit 81 letters'),
  post('/feedback', { rating: 4, ip: '1.2.3.4' }, 'a field it does not take'),
  { name: '/feedback a list for a body', method: 'POST', path: '/feedback', body: '[5]', status: 400 },
]

/** a JSON body sent as from the address `from` (the one proxy in front is trusted: index.ts 'trust proxy') */
const sendFeedback = (s: Server, body: unknown, from: string) =>
  ask(s.port, 'POST', '/feedback', json(body), { 'X-Forwarded-For': from }).then(r => ({ ...r, error: (() => {
    try { return String((JSON.parse(r.text) as { error?: unknown }).error ?? '') } catch { return '' }
  })() }))
const lines = (mode: string) => { try { return readFileSync(feedbackFile(mode), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) } catch { return [] } }

async function main() {
  let dev: Server | undefined, prod: Server | undefined
  try {
    ;[dev, prod] = await Promise.all([start('development'), start('production')])
    // a local sign-in (development has no Supabase here): the token for the routes that need a login
    const login = await fetch(`http://127.0.0.1:${dev.port}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: json({ email: 'input-check@example.com', password: 'x' }) }).then(r => r.json() as Promise<{ token?: string }>)
    const token = login.token ?? ''
    const both = async (name: string, cases: Case[]) => {
      const bad = [...await Promise.all(cases.map(c => run(dev!, c, token))), ...await Promise.all(cases.map(c => run(prod!, c, token).then(w => w && `production ${w}`)))].filter(Boolean)
      check(name, !bad.length, bad.length ? bad.join(' | ') : `${cases.length} requests on both servers`)
    }
    await both('I1 a body or address Express could not read, a route not there: 400/413/404 in Korean, no stack', I1)
    await both('I2 sign-in with a field of the wrong type: 400 in Korean', I2_SIGN_IN)
    const bad = (await Promise.all(I2.map(c => run(dev!, c, token)))).filter(Boolean)
    check('I2 a field of the wrong type or missing, each route that reads a body: 400 in Korean, no stack', !!token && !bad.length,
      !token ? 'no local sign-in token' : bad.length ? bad.join(' | ') : `${I2.length} requests`)

    // F1-F4 (the refused ones first: nothing is kept for them)
    await both('F1 an opinion the server cannot use: 400 in Korean', F1)
    const kept0 = [...lines('development'), ...lines('production')].length
    const good = await sendFeedback(dev!, { rating: 4, comment: ' 데모가 빨라요\r\n좋아요 ', circuit: 'Demo: motor' }, '203.0.113.7')
    const long = await sendFeedback(dev!, { rating: 1, comment: '가'.repeat(500) }, '203.0.113.7')
    const kept = lines('development')
    const keys = kept.map(l => Object.keys(l).sort().join(','))
    check('F2 an opinion is kept as one line of rating, comment, circuit and time, no address; 500 Korean letters fit',
      kept0 === 0 && good.status === 200 && long.status === 200 && kept.length === 2 && keys.every(k => k === 'circuit,comment,created_at,rating')
      && kept[0].comment === '데모가 빨라요\n좋아요' && kept[0].circuit === 'Demo: motor' && kept[0].rating === 4 && kept[1].comment === '가'.repeat(500)
      && kept[1].circuit === null && !readFileSync(feedbackFile('development'), 'utf8').includes('203.0.113'),
      `before ${kept0}, ${good.status} ${long.status}, ${kept.length} line(s): ${keys.join(' | ')}`)

    const five = await Promise.all(Array.from({ length: 5 }, (_, i) => sendFeedback(prod!, { rating: 5, comment: `F3 ${i}` }, '198.51.100.20')))
    const sixth = await sendFeedback(prod!, { rating: 5 }, '198.51.100.20')
    const other = await sendFeedback(prod!, { rating: 5 }, '198.51.100.21')
    check('F3 the sixth opinion from one address in ten minutes is 429 in Korean, another address still gets through',
      five.every(r => r.status === 200) && sixth.status === 429 && /[가-힣]/.test(sixth.error) && /10분에 5번/.test(sixth.error)
      && other.status === 200 && lines('production').length === 6,
      `${five.map(r => r.status).join(',')} then ${sixth.status} "${sixth.error}", another ${other.status}, ${lines('production').length} kept`)

    const named = /FEEDBACK_FILE = .*join\(OUTPUTS_DIR, '([^']+)'\)/.exec(readFileSync('index.ts', 'utf8'))?.[1] ?? ''
    const said = [good, long, ...five, sixth, other].map(r => r.text).join(' ')
    check('F4 the opinions file is a dot file in outputs/, named in no answer', named.startsWith('.') && !said.includes('jsonl') && !said.includes(FEEDBACK_DIR),
      `outputs/${named}`)
  } finally {
    await Promise.all([stop(dev), stop(prod)])
    rmSync(FEEDBACK_DIR, { recursive: true, force: true })
  }
}

// exitCode, not process.exit(): exiting with fetch's sockets still open crashed Node on Windows (0xC0000409)
main().catch(e => check('I servers', false, (e as Error).message)).finally(() => { process.exitCode = ok ? 0 : 1 })
