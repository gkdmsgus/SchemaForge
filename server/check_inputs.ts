// Checks I1: what the server answers a request it cannot use. Every case is a real request to a server started here,
// in development and in production (NODE_ENV=production), and passes only on the status it names, with JSON whose error
// is a Korean sentence and no stack or server path anywhere in the answer. Express's own pages showed the stack in
// development (a broken JSON body: "SyntaxError ... at JSON.parse" and the server's paths) and English in production.
// I1 the body or address Express could not read: broken JSON, too large, a malformed %-escape; a route that is not there.
// No model, Supabase or Mouser is called: the model's address is a closed port and no Mouser key is given.
// Usage (from server/): npx tsx check_inputs.ts   → exit 0 only if all pass
import { spawn, type ChildProcess } from 'child_process'
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

async function start(mode: 'development' | 'production'): Promise<Server> {
  const port = await freePort()
  const proc = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'index.ts'], {
    env: { ...process.env, NODE_ENV: mode, PORT: String(port), SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '',
           SF_OUTPUTS_SWEEP: '', FRONTEND_URL: '', OPENAI_API_KEY: 'sk-none', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', MOUSER_API_KEY: '', SF_AI_STUB: '' },
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
  } finally {
    await Promise.all([stop(dev), stop(prod)])
  }
}

// exitCode, not process.exit(): exiting with fetch's sockets still open crashed Node on Windows (0xC0000409)
main().catch(e => check('I servers', false, (e as Error).message)).finally(() => { process.exitCode = ok ? 0 : 1 })
