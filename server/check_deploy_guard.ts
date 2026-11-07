// Checks D1-D12: what a deployed server (NODE_ENV=production) lets a visitor do (deploy_guard.ts). D1-D6 the rules,
// D7 the names taken from requests, D8 the routes wired to them (index.ts read as text), D9 a real server started
// in production mode with no Supabase: the demo and its gerbers stay open; model calls, code runs and the
// password-free sign-in are refused; a ".." folder does not leave outputs/. D10 render.yaml (read as text). D11 a port in use.
// D12 the built app's cache headers, on a small dist/ of its own.
// No model, no KiCad; D9 needs python + skidl (the demo runs a checked-in circuit).
// Usage (from server/): npx tsx check_deploy_guard.ts   → exit 0 only if all pass
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { request } from 'http'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileStem, guardFromEnv, localLoginRefusal, memberRefusal, safeName } from './deploy_guard'

let ok = true
const check = (name: string, pass: boolean, info = '') => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

const dev = guardFromEnv({ NODE_ENV: 'development' })
const bare = guardFromEnv({ NODE_ENV: 'production' })
const env = { NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', ALLOWED_EMAILS: ' Me@Example.com , you@example.com' }
const full = guardFromEnv(env)
const me = { email: 'me@example.com', confirmed: true }

// D1. development is unchanged: no login needed, the local sign-in stays
check('D1 development: open', memberRefusal(dev, undefined) === null && localLoginRefusal(dev) === null)

// D2. deployed without Supabase: nobody runs code or calls the model, and the password-free sign-in is off
check('D2 deployed, no Supabase: closed', memberRefusal(bare, me)?.status === 401 && !!localLoginRefusal(bare),
  memberRefusal(bare, me)?.error)

// D3. deployed with Supabase: a visitor without a login is refused; the Supabase sign-in is not the local one
check('D3 no login: 401', memberRefusal(full, undefined)?.status === 401 && localLoginRefusal(full) === null)

// D4. an unconfirmed sign-up can name anyone's address, so a listed address counts only once confirmed
check('D4 unconfirmed: 403', memberRefusal(full, { email: 'me@example.com', confirmed: false })?.status === 403
  && memberRefusal(full, { email: 'me@example.com' })?.status === 403)

// D5. a confirmed listed address gets in, whatever its case and the spaces around it in ALLOWED_EMAILS
check('D5 listed: allowed', memberRefusal(full, me) === null && memberRefusal(full, { email: 'YOU@example.com', confirmed: true }) === null,
  [...full.allowed].join(','))

// D6. anyone else is refused, and an empty ALLOWED_EMAILS lets nobody in
const noList = guardFromEnv({ ...env, ALLOWED_EMAILS: ' , ' })
check('D6 not listed: 403', memberRefusal(full, { email: 'other@example.com', confirmed: true })?.status === 403
  && noList.allowed.size === 0 && memberRefusal(noList, me)?.status === 403)

// D7. names from requests: no path, never "." or ".."; a new file's name keeps letters, digits, _ and - only
check('D7 names from requests', safeName('..') === null && safeName('.') === null && safeName('') === null && safeName(undefined) === null
  && safeName('a/b/../x.gbr') === 'x.gbr' && safeName('board_gerber') === 'board_gerber'
  && fileStem('../../etc/x') === 'etcx' && fileStem('') === 'edited' && fileStem(undefined) === 'edited' && fileStem('motor-2_v1') === 'motor-2_v1')

// D8. index.ts (read as text): each route that runs code or calls the model goes through the guard
const src = readFileSync(join(process.cwd(), 'index.ts'), 'utf8')
const route = (path: string) => src.split('\n').find(l => l.startsWith(`app.post('${path}'`)) ?? ''
const guarded = ['/clarify', '/plan', '/chat_edit', '/generate', '/test_code'].filter(p => !/requireMember/.test(route(p)))
const stream = src.slice(src.indexOf("app.post('/generate_pcb_stream'"), src.indexOf('const useAi'))
const auth = src.slice(src.indexOf("app.post('/auth/register'"), src.indexOf("app.post('/auth/logout'"))
const uncalled = ["'/render_board'", "'/generate_pcb'", "'/generate_pcb_from_graph'", 'runPcbGenerator'].filter(r => src.includes(r))
  .concat(["'/render_board'", "'/generate_pcb'"].filter(r => readFileSync(join(process.cwd(), '..', 'vite.config.ts'), 'utf8').includes(r)))
check('D8 routes wired to the guard', guarded.length === 0 && !uncalled.length && /memberRefusal\(GUARD/.test(stream)
  && (auth.match(/localLoginRefusal\(GUARD\)/g) ?? []).length === 2
  && !/\$\{\(baseName as string\)/.test(src) && (src.match(/fileStem\(baseName\)/g) ?? []).length === 1
  && !/basename\(req\.params/.test(src),
  guarded.length || uncalled.length ? `not guarded: ${guarded.join(', ')}; still there: ${uncalled.join(', ')}` : '')

// D10. render.yaml (the Render Blueprint, read as text): every secret is declared with sync: false and no value, the
//      plan is free, the health check is a route the server has, and PORT is the one Render routes to
{
  const yaml = readFileSync(join(process.cwd(), '..', 'render.yaml'), 'utf8')
  const SECRETS = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ALLOWED_EMAILS', 'MOUSER_API_KEY']
  const entries = yaml.split(/\n\s*- key: /).slice(1).map(e => ({ key: e.split(/[\s#]/)[0], body: e.split('\n').slice(1).map(l => l.replace(/#.*/, '').trim()).filter(Boolean).filter(l => !l.startsWith('- ')) }))
  const secret = entries.filter(e => SECRETS.includes(e.key))
  const bad = secret.filter(e => !(e.body.length === 1 && e.body[0] === 'sync: false')).map(e => e.key)
  const health = /healthCheckPath:\s*(\/\S*)/.exec(yaml)?.[1]
  const port = entries.find(e => e.key === 'PORT')?.body[0]
  check('D10 render.yaml', secret.length === SECRETS.length && !bad.length && /^\s*plan:\s*free\b/m.test(yaml)
    && !!health && src.includes(`app.get('${health}'`) && port === 'value: "10000"',
    `${secret.length}/${SECRETS.length} secrets${bad.length ? `, not sync:false only: ${bad.join(', ')}` : ''}, health ${health}, ${port}`)

  // D10b. no web search left: nothing has called it since 2026-06, and every deploy guide still asked for a key
  const places = { 'index.ts': src, 'render.yaml': yaml, '.env.example': readFileSync('.env.example', 'utf8'), 'DEPLOY.md': readFileSync(join('..', 'DEPLOY.md'), 'utf8'), 'package.json': readFileSync('package.json', 'utf8'), 'package-lock.json': readFileSync('package-lock.json', 'utf8') }
  const left = Object.entries(places).filter(([, text]) => /tavily/i.test(text)).map(([f]) => f)
  check('D10b no web search left', !left.length && !src.includes('sourceUrls'), left.length ? `still in ${left.join(', ')}` : '')
}

// D9. the real server in production mode, no Supabase (an empty value is kept: dotenv never overrides one)
/** a port the system says is free (a fixed or random one can sit in a range Windows reserves for Hyper-V and Docker) */
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number }
    s.close(() => resolve(port))
  })
})

async function live() {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const proc = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'index.ts'], {
    // SF_OUTPUTS_SWEEP off: this server runs in the checkout, whose outputs/ holds the checks' fixtures
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '',
           SF_OUTPUTS_SWEEP: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  proc.stdout!.on('data', (d: Buffer) => { stderr += d.toString() })
  proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
  proc.on('exit', code => { stderr += ` [exited ${code}]` })
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  // the path exactly as written: fetch would resolve %2E%2E to ".." and ask for another path, a raw client does not
  const raw = (path: string) => new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, r => { r.resume(); resolve(r.statusCode ?? 0) }).on('error', reject).end()
  })
  try {
    let up = false
    for (let t0 = Date.now(); !up && Date.now() - t0 < 30000; await new Promise(r => setTimeout(r, 300))) {
      up = await fetch(base + '/health').then(r => r.ok, () => false)
    }
    if (!up) return check('D9 production server', false, `did not start in 30 s on port ${port}: ${stderr.trim().slice(-400)}`)
    const demo = await fetch(base + '/demo_result/led')
    type Graph = { components: { ref: string; value: string }[]; nets: unknown[] }
    const demoBody = demo.ok ? await demo.json() as { filename?: string; graph?: Graph } : {}
    const codes = {
      demo: demo.status,
      generate: (await post('/generate', { prompt: 'LED' })).status,
      chat_edit: (await post('/chat_edit', { message: 'x', graph: { components: [], nets: [] } })).status,
      clarify: (await post('/clarify', { prompt: 'LED' })).status,
      plan: (await post('/plan', { prompt: 'LED' })).status,
      test_code: (await post('/test_code', { code: 'print(1)' })).status,
      login: (await post('/auth/login', { email: 'a@b.c', password: 'x' })).status,
      register: (await post('/auth/register', { email: 'a@b.c', password: 'x' })).status,
      ai_board: (await post('/generate_pcb_stream', { filename: demoBody.filename, ai: true })).status,
      // before deploy_guard.ts this sent server/index.ts (the one route with two names: "..", then a file)
      dotdot: await raw('/download_gerber_file/%2E%2E/index.ts'),
      // nothing on the screen called these, and anyone could: a 2000x1400 render took 17-30 s on 16 cores (review of 2026-11-06)
      pcb_route: (await post('/generate_pcb', {})).status,
      pcb_graph_route: (await post('/generate_pcb_from_graph', {})).status,
    }
    const want = { demo: 200, generate: 401, chat_edit: 401, clarify: 401, plan: 401, test_code: 401, login: 503, register: 503, ai_board: 401, dotdot: 404, pcb_route: 404, pcb_graph_route: 404 }
    const wrong = Object.entries(want).filter(([k, v]) => codes[k as keyof typeof codes] !== v)
    check('D9 production server: demo open, the rest refused', wrong.length === 0 && !!demoBody.filename,
      wrong.length ? wrong.map(([k, v]) => `${k} ${codes[k as keyof typeof codes]} (want ${v})`).join(', ') : JSON.stringify(codes))

    // D9b. the board route cleans a graph as /erc_graph does: a value like 0.1" passed the netlist check there and the
    //      generator died on it here (IndexError, review of 2026-11-06). Open to all, so the demo's graph will do
    const graph = demoBody.graph ?? { components: [], nets: [] }
    const resistor = graph.components.find(c => /^R\d/.test(c.ref))?.ref
    const board = async (value: string) => {
      const sent = { ...graph, components: graph.components.map(c => (c.ref === resistor ? { ...c, value } : c)) }
      const text = await (await post('/generate_pcb_stream', { graph: sent, baseName: 'guardcheck' })).text()
      const done = /event: done\ndata: (.+)/.exec(text)
      if (!done) return `no done: ${text.slice(-160).trim()}`
      const d = JSON.parse(done[1]) as { pcbFilename: string; board: { parts: { ref: string; value: string }[] } }
      const stem = d.pcbFilename.replace('.kicad_pcb', '')
      for (const end of ['.net', '.kicad_pcb', '.board.json', '.kicad_prl']) rmSync(join('outputs', stem + end), { force: true })
      return d.board.parts.find(q => q.ref === resistor)?.value ?? '(no part)'
    }
    const values = await Promise.all(['0.1" pitch', '470\\', '"470"'].map(board))
    const noGraph = await post('/generate_pcb_stream', { graph: {} })
    check('D9b a graph on the board route is cleaned: inch mark, trailing backslash, quotes; not a graph is 400', !!resistor
      && values.join() === '0.1 pitch,470,470' && noGraph.status === 400 && /json/.test(noGraph.headers.get('content-type') ?? ''),
      `${JSON.stringify(values)} graph {} -> ${noGraph.status}`)

    // D9d. a graph with no part left (none sent, only blank references, nets alone): the generator died on it and the SSE
    //      error carried its traceback with the server's paths (review of 2026-11-07). 400 with a short Korean sentence
    //      before anything runs; /erc_graph keeps checking such a graph (no GND)
    const empties = [{ components: [], nets: [] }, { components: [{ ref: ' ' }], nets: [] },
      { components: [], nets: [{ name: 'A', nodes: [{ ref: 'R1', pin: '1' }, { ref: 'R1', pin: '2' }] }] }]
    const answers = await Promise.all(empties.map(async g => {
      const r = await post('/generate_pcb_stream', { graph: g, baseName: 'guardcheck' })
      return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() }
    }))
    const said = (text: string) => { try { return String(JSON.parse(text).error) } catch { return '' } }
    const emptyErc = await (await post('/erc_graph', { graph: { components: [], nets: [] } })).json() as { erc?: { rule: string }[] }
    check('D9d a graph with no parts: 400 in Korean, no traceback; /erc_graph still checks it',
      answers.every(a => a.status === 400 && /json/.test(a.type) && /부품이 하나도 없는/.test(said(a.text)) && !/Traceback|\.py\b/.test(a.text))
      && emptyErc.erc?.some(f => f.rule === 'no_ground') === true,
      `${answers.map(a => `${a.status} ${said(a.text) || a.text.slice(0, 80).replace(/\s+/g, ' ')}`).join(' | ')}; /erc_graph ${JSON.stringify(emptyErc.erc?.map(f => f.rule))}`)

    // D9c. a BOM price search spends the operator's Mouser quota, one call per line: a visitor is told refused and keeps
    //      the search links, before any key is read (review of 2026-11-06)
    const mouser = await (await post('/mouser_search', { components: [{ ref: 'R1', value: '1k', name: 'R' }] })).json() as { available?: boolean; refused?: boolean; results?: unknown[] }
    check('D9c /mouser_search refuses a visitor', mouser.available === false && mouser.refused === true && mouser.results?.length === 0, JSON.stringify(mouser))
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise(r => proc.once('exit', r))
      proc.kill()
      await gone
    }
  }
}

// D11. a port already in use is a failure: the server printed "running" and exited 0 (review of 2026-11-06)
async function portTaken() {
  const held = createServer()
  await new Promise<void>((resolve, reject) => { held.once('error', reject).listen(0, resolve) })
  const { port } = held.address() as { port: number }
  const proc = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'index.ts'], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '', SF_OUTPUTS_SWEEP: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let said = ''
  proc.stdout!.on('data', (d: Buffer) => { said += d.toString() })
  proc.stderr!.on('data', (d: Buffer) => { said += d.toString() })
  const code = await new Promise<number | null | string>(resolve => {
    const late = setTimeout(() => { proc.kill(); resolve('still running after 60 s') }, 60000)
    proc.once('exit', c => { clearTimeout(late); resolve(c) })
  })
  held.close()
  check('D11 a port in use: exit 1, not "running"', code === 1 && !/running on/.test(said), `exit ${code}: ${said.trim().split('\n').pop()?.slice(0, 120)}`)
}

// D12. a file under /assets has its hash in its name, so it is kept for a year; index.html names the current ones, so it
//      is asked for every time. Everything came with max-age=0 (review of 2026-11-06). The server runs in a temp folder
//      that holds a small dist/, so no build is needed and no outputs/ of the checkout is touched
async function cacheHeaders() {
  const cwd = mkdtempSync(join(tmpdir(), 'sf_static_'))
  mkdirSync(join(cwd, 'dist', 'assets'), { recursive: true })
  writeFileSync(join(cwd, 'dist', 'index.html'), '<!doctype html>')
  writeFileSync(join(cwd, 'dist', 'assets', 'index-abc123.js'), 'export {}')
  const port = await freePort()
  const here = process.cwd()
  const proc = spawn(process.execPath, [join(here, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(here, 'index.ts')], {
    cwd, env: { ...process.env, NODE_ENV: 'production', PORT: String(port), SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '', SF_OUTPUTS_SWEEP: '' },
    stdio: 'ignore',
  })
  try {
    const base = `http://127.0.0.1:${port}`
    let up = false
    for (let t0 = Date.now(); !up && Date.now() - t0 < 30000; await new Promise(r => setTimeout(r, 300))) {
      up = await fetch(base + '/health').then(r => r.ok, () => false)
    }
    const cache = async (path: string) => {
      const r = await fetch(base + path)
      return `${r.status} ${r.headers.get('cache-control')}`
    }
    const asset = up ? await cache('/assets/index-abc123.js') : 'server did not start'
    const page = up ? await cache('/') : '', route = up ? await cache('/some/route') : ''
    check('D12 hashed assets for a year, index.html every time', /^200 .*max-age=31536000/.test(asset) && /immutable/.test(asset)
      && page === '200 public, max-age=0' && route === '200 public, max-age=0', `/assets: ${asset} | /: ${page} | a route: ${route}`)
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise(r => proc.once('exit', r))
      proc.kill()
      await gone
    }
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* the server may hold it a moment longer */ }
  }
}

// exitCode, not process.exit(): exiting with fetch's sockets still open crashed Node on Windows (0xC0000409)
live().catch(e => check('D9 production server', false, (e as Error).message))
  .then(portTaken).catch(e => check('D11 a port in use', false, (e as Error).message))
  .then(cacheHeaders).catch(e => check('D12 cache headers', false, (e as Error).message))
  .finally(() => { process.exitCode = ok ? 0 : 1 })
