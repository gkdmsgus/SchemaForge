// Checks D1-D12: what a deployed server (NODE_ENV=production) lets a visitor do (deploy_guard.ts). D1-D6 the rules,
// D7 the names taken from requests, D8 the routes wired to them (index.ts read as text), D9 a real server started
// in production mode with no Supabase: the demo and its gerbers stay open; model calls, code runs and the
// password-free sign-in are refused; a ".." folder does not leave outputs/. D10 render.yaml (read as text). D11 a port in use, D11b one
// Windows reserved (Windows only).
// D12 the built app's cache headers, on a small dist/ of its own. D13 a build in any folder stays out of the image and lint.
// D14 who may call the server from a browser (CORS), live in D9f (no FRONTEND_URL) and D12b (FRONTEND_URL set).
// D15 the commit /health names, live in D9g (SF_COMMIT) and D12c (RENDER_GIT_COMMIT); D15b the Jetson image is given it.
// D16 the file routes from a server under a dot folder (a worktree under .claude/), with names that leave outputs/ refused.
// No model, no KiCad; D9 needs python + skidl (the demo runs a checked-in circuit).
// Usage (from server/): npx tsx check_deploy_guard.ts   → exit 0 only if all pass
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { request } from 'http'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { corsOrigin, fileStem, guardFromEnv, localLoginRefusal, memberRefusal, runningCommit, safeName } from './deploy_guard'

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

// D14. which other pages may call the server from a browser (CORS): development as before (FRONTEND_URL, else any);
//      deployed none, or FRONTEND_URL's only, its trailing / dropped. Every origin was echoed back with credentials
{
  const one = corsOrigin(bare, ' https://app.example/ ')
  const asked = (origin: string | undefined) => {
    let allow: boolean | undefined
    if (typeof one === 'function') one(origin, (_e, a) => { allow = a })
    return allow
  }
  const allow = [asked('https://app.example'), asked('https://evil.example'), asked(undefined)]
  check('D14 CORS: development any or FRONTEND_URL; deployed none, or FRONTEND_URL only', corsOrigin(dev, undefined) === true
    && corsOrigin(dev, 'http://localhost:3000') === 'http://localhost:3000' && corsOrigin(bare, undefined) === null
    && corsOrigin(bare, ' ') === null && typeof one === 'function' && allow.join() === 'true,false,false', `FRONTEND_URL only: ${allow.join(', ')}`)
}

// D15. the commit /health names: SF_COMMIT, else Render's RENDER_GIT_COMMIT, else 'unknown'; 7 characters. Render served
//      an old front end after "Deploy succeeded" and nothing said which commit ran (2026-11-01)
{
  const said = [runningCommit({ SF_COMMIT: '0123456789abcdef', RENDER_GIT_COMMIT: 'fedcba9876543210' }),
    runningCommit({ RENDER_GIT_COMMIT: 'fedcba9876543210' }), runningCommit({ SF_COMMIT: ' ', RENDER_GIT_COMMIT: '' }), runningCommit({})]
  check('D15 the running commit: SF_COMMIT, else RENDER_GIT_COMMIT, else unknown', said.join() === '0123456,fedcba9,unknown,unknown', said.join(', '))
}

// D15b. the Jetson image is given SF_COMMIT (both read as text, nothing run): no image set it, so /health said 'unknown'
//       there. Dockerfile.jetson's last stage takes the build argument into its environment; jetson_run.sh passes HEAD
{
  const root = join(process.cwd(), '..')
  const docker = readFileSync(join(root, 'Dockerfile.jetson'), 'utf8').replace(/\r\n/g, '\n')
  const last = docker.slice(docker.lastIndexOf('\nFROM '))
  const run = readFileSync(join(root, 'scripts', 'jetson_run.sh'), 'utf8').replace(/\r\n/g, '\n')
  const build = run.split('\n').find(l => /^\s*docker build /.test(l)) ?? ''
  const wrong = [!/^ARG SF_COMMIT\b/m.test(last) && 'Dockerfile.jetson: no ARG SF_COMMIT in the last stage',
    !/^ENV (?:[^\n]*\\\n)*\s*SF_COMMIT=\$SF_COMMIT\b/m.test(last) && 'Dockerfile.jetson: SF_COMMIT not in the environment',
    !/^\s*commit=\$\(git rev-parse --short=7 HEAD\b/m.test(run) && 'jetson_run.sh: no commit from git',
    !build.includes('--build-arg SF_COMMIT="$commit"') && 'jetson_run.sh: docker build without SF_COMMIT'].filter(Boolean)
  check('D15b the Jetson image is built with its commit as SF_COMMIT', !wrong.length, wrong.join(' | '))
}

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

// D8b. the board stream's reasons are Korean sentences with what to do, which the screen shows as they are: it showed
//      only "오류", and they were English or the generator's traceback with the server's paths (review of 2026-11-07)
{
  const boardRoute = src.slice(src.indexOf("app.post('/generate_pcb_stream'"), src.indexOf('// ── GET /download_pcb'))
  const sayings = [...(/const PCB_SAYS = \{([^}]*)\}/.exec(src)?.[1] ?? '').matchAll(/^\s*(\w+): '([^']*)',?\s*$/gm)].map(m => ({ key: m[1], text: m[2] }))
  const reasons = [...boardRoute.matchAll(/\berror: ([^{}]+?)\s*\}/g)].map(m => m[1].trim())
  const said = (r: string) => !/stderr|message|String\(/.test(r) && [...r.matchAll(/'([^']*)'/g)].every(q => /[가-힣]/.test(q[1]))
    && ([...r.matchAll(/PCB_SAYS\.(\w+)/g)].every(k => sayings.some(s => s.key === k[1])) && (/PCB_SAYS\.\w+/.test(r) || /'[^']*[가-힣]/.test(r)))
  const unsaid = reasons.filter(r => !said(r))
  const plain = sayings.filter(s => !/[가-힣]/.test(s.text) || !/재시도|주세요|확인/.test(s.text)).map(s => s.key)
  check('D8b the board stream says why in Korean, with what to do; no traceback or English reason', reasons.length >= 9 && sayings.length >= 9
    && !unsaid.length && !plain.length, `${reasons.length} reasons, ${sayings.length} sentences${unsaid.length ? `; not in words: ${unsaid.join(' | ')}` : ''}${plain.length ? `; no step to take: ${plain.join(', ')}` : ''}`)
}

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

// How long a started server may take to answer /health. It answers in about 1 s here, idle or with every core busy
// (0.8-1.0 s, 2026-11-07); 30 s failed D9 once while other work held the PC (about 76% CPU). A server that
// starts costs nothing more, and one that exited is not waited for.
const START_MS = 60000
async function upIn(base: string, proc: ChildProcess) {
  for (const t0 = Date.now(); Date.now() - t0 < START_MS && proc.exitCode === null; await new Promise(r => setTimeout(r, 300))) {
    if (await fetch(base + '/health').then(r => r.ok, () => false)) return true
  }
  return false
}

/** a request with headers fetch may not send (Origin), and the answer's status and headers */
const headers = (port: number, method: string, path: string, sent: Record<string, string>) =>
  new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, method, headers: sent }, r => { r.resume(); resolve({ status: r.statusCode ?? 0, headers: r.headers }) })
      .on('error', reject).end()
  })

async function live() {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const proc = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'index.ts'], {
    // SF_OUTPUTS_SWEEP off: this server runs in the checkout, whose outputs/ holds the checks' fixtures
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '',
           SF_OUTPUTS_SWEEP: '', FRONTEND_URL: '', SF_COMMIT: '0123456789abcdef', RENDER_GIT_COMMIT: '' },
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
    if (!(await upIn(base, proc))) return check('D9 production server', false, `did not start (limit ${START_MS / 1000} s) on port ${port}: ${stderr.trim().slice(-400)}`)
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
    // one after another: one visitor runs two boards at once and the third waits 60 s at most, which a busy PC ran past
    // ("busy" in 2 of 4 npm test runs, 2026-11-09/10). The slots are check_job_slots.ts's; this is the cleaning
    const values: string[] = []
    for (const v of ['0.1" pitch', '470\\', '"470"']) values.push(await board(v))
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

    // D9e. a tab open across a restart asks for files the server no longer has: its gerbers said "PCB file not found." in
    //      the 거버 button's title, and its board "Netlist file not found." (review of 2026-11-07). In Korean, and
    //      board_gone so the screen builds the board again instead of asking for the gerbers again
    const gerberGone = await post('/generate_gerber', { pcbFilename: 'gone_check.kicad_pcb' })
    const gerberSaid = await gerberGone.json().catch(() => ({})) as { error?: string; code?: string }
    const boardGone = await post('/generate_pcb_stream', { filename: 'gone_check.net' })
    const boardSaid = await boardGone.json().catch(() => ({})) as { error?: string }
    check('D9e files gone after a restart: the gerbers and the board say so in Korean, the gerbers with board_gone',
      gerberGone.status === 404 && gerberSaid.code === 'board_gone' && /남아 있지 않습니다/.test(gerberSaid.error ?? '')
      && boardGone.status === 404 && /남아 있지 않습니다/.test(boardSaid.error ?? ''),
      `gerber ${gerberGone.status} ${gerberSaid.code ?? '(no code)'} "${gerberSaid.error}" | board ${boardGone.status} "${boardSaid.error}"`)

    // D9c. a BOM price search spends the operator's Mouser quota, one call per line: a visitor is told refused and keeps
    //      the search links, before any key is read (review of 2026-11-06)
    const mouser = await (await post('/mouser_search', { components: [{ ref: 'R1', value: '1k', name: 'R' }] })).json() as { available?: boolean; refused?: boolean; results?: unknown[] }
    check('D9c /mouser_search refuses a visitor', mouser.available === false && mouser.refused === true && mouser.results?.length === 0, JSON.stringify(mouser))

    // D9f. CORS with no FRONTEND_URL: another site's page gets no allow header, on a plain call or a preflight (D14)
    const evil = { Origin: 'https://evil.example' }
    const plain = await headers(port, 'GET', '/health', evil)
    const preflight = await headers(port, 'OPTIONS', '/generate_pcb_stream',
      { ...evil, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' })
    const allowed = (h: Record<string, unknown>) => Object.keys(h).filter(k => k.startsWith('access-control-allow-'))
    // D9g. the commit it runs, from SF_COMMIT (D15)
    const health = await (await fetch(base + '/health')).json() as { commit?: string }
    check('D9g /health names the commit, from SF_COMMIT', health.commit === '0123456', `commit ${health.commit}`)

    check('D9f CORS, no FRONTEND_URL: no allow header for another site', !allowed(plain.headers).length && !allowed(preflight.headers).length,
      `GET /health ${plain.status} [${allowed(plain.headers).map(k => `${k}: ${plain.headers[k]}`).join('; ')}] · OPTIONS ${preflight.status} [${allowed(preflight.headers).join(', ')}]`)
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise(r => proc.once('exit', r))
      proc.kill()
      await gone
    }
  }
}

// D11. a port already in use is a failure: the server printed "running" and exited 0 (review of 2026-11-06)
async function listenOn(port: number) {
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
  return { code, said }
}
async function portTaken() {
  const held = createServer()
  await new Promise<void>((resolve, reject) => { held.once('error', reject).listen(0, resolve) })
  const { port } = held.address() as { port: number }
  const { code, said } = await listenOn(port)
  held.close()
  check('D11 a port in use: exit 1, not "running"', code === 1 && !/running on/.test(said), `exit ${code}: ${said.trim().split('\n').pop()?.slice(0, 120)}`)
}

// D11b. Windows: a port in a range the system reserved (EACCES, as 8080 and then 8002 on the development PC, review of
//       2026-11-07) says how to see those ranges. Skipped, and not counted, where there is no such range
async function portReserved() {
  const ranges = process.platform !== 'win32' ? '' : await new Promise<string>(resolve => {
    const netsh = spawn('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    netsh.stdout!.on('data', (d: Buffer) => { out += d.toString() })
    netsh.on('error', () => resolve(''))
    netsh.on('exit', () => resolve(out))
  })
  const first = /^\s*(\d+)\s+\d+\s*$/m.exec(ranges)
  if (!first) return console.log('skip D11b a reserved port: no Windows reserved port range here (not counted)')
  const { code, said } = await listenOn(Number(first[1]))
  check('D11b a port Windows reserved: exit 1, and the way to see the reserved ranges', code === 1 && /EACCES/.test(said)
    && /excludedportrange/.test(said), `port ${first[1]}, exit ${code}: ${said.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`)
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
    // FRONTEND_URL with a trailing /, as it may be written (D12b)
    cwd, env: { ...process.env, NODE_ENV: 'production', PORT: String(port), SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '', SF_OUTPUTS_SWEEP: '',
                FRONTEND_URL: 'https://app.example/', SF_COMMIT: '', RENDER_GIT_COMMIT: 'fedcba9876543210' },
    stdio: 'ignore',
  })
  try {
    const base = `http://127.0.0.1:${port}`
    const up = await upIn(base, proc)
    const cache = async (path: string) => {
      const r = await fetch(base + path)
      return `${r.status} ${r.headers.get('cache-control')}`
    }
    const asset = up ? await cache('/assets/index-abc123.js') : 'server did not start'
    const page = up ? await cache('/') : '', route = up ? await cache('/some/route') : ''
    check('D12 hashed assets for a year, index.html every time', /^200 .*max-age=31536000/.test(asset) && /immutable/.test(asset)
      && page === '200 public, max-age=0' && route === '200 public, max-age=0', `/assets: ${asset} | /: ${page} | a route: ${route}`)

    // D12b. CORS with FRONTEND_URL: that page may call it with credentials, another site gets no allow header (D14)
    const cors = async (origin: string) => {
      if (!up) return 'server did not start'
      const h = (await headers(port, 'GET', '/health', { Origin: origin })).headers
      return `${h['access-control-allow-origin'] ?? '-'} ${h['access-control-allow-credentials'] ?? '-'}`
    }
    const app = await cors('https://app.example'), evil = await cors('https://evil.example')
    // D12c. Render's commit when no SF_COMMIT is given (D15)
    const commit = up ? (await (await fetch(base + '/health')).json() as { commit?: string }).commit : 'server did not start'
    check('D12c /health names the commit, from RENDER_GIT_COMMIT', commit === 'fedcba9', `commit ${commit}`)
    check('D12b CORS, FRONTEND_URL set: that page only', app === 'https://app.example true' && evil === '- -',
      `app.example: ${app} | evil.example: ${evil}`)
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise(r => proc.once('exit', r))
      proc.kill()
      await gone
    }
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* the server may hold it a moment longer */ }
  }
}

// D16. the file routes from a server whose folder sits under a dot folder, as a worktree under .claude/ does: send turns
//      away a path with a part that starts with a dot, and it was given the whole path, so /download said 404 for a file
//      that was there and the Netlist tab said the server had no netlist (2026-11-08). A name that leaves outputs/, and
//      a dot file in it, are still refused. A temp folder of its own, with a small dist/ and outputs/
async function dotFolder() {
  const top = mkdtempSync(join(tmpdir(), 'sf_dot_'))
  const cwd = join(top, '.hidden', 'server'), out = join(cwd, 'outputs')
  mkdirSync(join(out, 'dotcheck_gerber'), { recursive: true })
  mkdirSync(join(cwd, 'dist'))
  const files = { 'dist/index.html': '<!doctype html><title>dotcheck page</title>', 'outputs/dotcheck.net': '(export (version D))',
    'outputs/dotcheck.kicad_pcb': '(kicad_pcb dotcheck)', 'outputs/dotcheck_gerber/dotcheck.zip': 'PK dotcheck',
    'outputs/.env': 'SECRET=dotcheck', 'secret.txt': 'SECRET outside outputs' }
  for (const [path, text] of Object.entries(files)) writeFileSync(join(cwd, path), text)
  const port = await freePort()
  const here = process.cwd()
  const proc = spawn(process.execPath, [join(here, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(here, 'index.ts')], {
    cwd, env: { ...process.env, NODE_ENV: 'production', PORT: String(port), SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '', SF_OUTPUTS_SWEEP: '' },
    stdio: 'ignore',
  })
  /** the path exactly as written (fetch would resolve %2E%2E), and the answer's status, attachment name and body */
  const got = (path: string) => new Promise<{ status: number; disposition: string; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, r => {
      let body = ''
      r.on('data', (d: Buffer) => { body += d.toString() })
      r.on('end', () => resolve({ status: r.statusCode ?? 0, disposition: String(r.headers['content-disposition'] ?? ''), body }))
    }).on('error', reject).end()
  })
  try {
    if (!(await upIn(`http://127.0.0.1:${port}`, proc))) return check('D16 file routes under a dot folder', false, `server did not start on port ${port}`)
    const served = {
      '/download/dotcheck.net': ['(export (version D))', 'schematic.net'],
      '/download_pcb/dotcheck.kicad_pcb': ['(kicad_pcb dotcheck)', 'dotcheck.kicad_pcb'],
      '/download_gerber_file/dotcheck_gerber/dotcheck.zip': ['PK dotcheck', 'dotcheck.zip'],
      '/some/route': ['<!doctype html><title>dotcheck page</title>', ''],
    }
    const wrong: string[] = []
    for (const [path, [body, name]] of Object.entries(served)) {
      const a = await got(path)
      if (a.status !== 200 || a.body !== body || (name && !a.disposition.includes(`filename="${name}"`))) wrong.push(`${path} ${a.status} ${a.disposition || a.body.slice(0, 60)}`)
    }
    const refused = ['/download/%2E%2E%2Fsecret.txt', '/download/..%5Csecret.txt', '/download_pcb/%2E%2E%2Fsecret.txt',
      '/download_gerber_file/%2E%2E/secret.txt', '/download_gerber_file/dotcheck_gerber/%2E%2E%2F%2E%2E%2Fsecret.txt',
      '/download/.env', '/download_pcb/.env']
    for (const path of refused) {
      const a = await got(path)
      if (a.status !== 404 || a.body.includes('SECRET')) wrong.push(`${path} ${a.status} (want 404)`)
    }
    check('D16 files are served from a server under a dot folder; a name leaving outputs/ or a dot file is still 404', !wrong.length,
      wrong.length ? wrong.join(' | ') : `${Object.keys(served).length} served, ${refused.length} refused`)
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise(r => proc.once('exit', r))
      proc.kill()
      await gone
    }
    try { rmSync(top, { recursive: true, force: true }) } catch { /* the server may hold it a moment longer */ }
  }
}

// D13. a build left anywhere in the checkout stays out of the image and of lint: a stray server/dist went into the image
//      (.dockerignore's 'dist' is the root's only) and was served there before the image's own build (index.ts takes cwd/dist
//      first), and npm run lint read its 460 errors (review of 2026-11-07). .dockerignore read as Docker reads it, lint by ESLint
async function buildOutput() {
  const root = join(process.cwd(), '..')
  // each line a path pattern from the context's root: * within a name, **/ any folders; a folder that matches takes its contents
  const rules = readFileSync(join(root, '.dockerignore'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const esc = (x: string) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const asRe = (p: string) => new RegExp(`^${p.replace(/\/+$/, '').split('**/').map(part => part.split('*').map(esc).join('[^/]*')).join('(?:.*/)?')}(?:/.*)?$`)
  const dockerSkips = (path: string) => rules.reduce((out, r) => (asRe(r.replace(/^!/, '')).test(path) ? !r.startsWith('!') : out), false)
  const docker = { 'server/dist/index.html': true, 'dist/assets/index-abc.js': true, 'server/.env': true, 'server/index.ts': false, 'src/main.tsx': false }
  const dockerWrong = Object.entries(docker).filter(([path, skip]) => dockerSkips(path) !== skip).map(([path]) => path)
  const { ESLint } = await import('eslint')
  const lint = new ESLint({ cwd: root })
  const lintFiles = { 'server/dist/assets/index-abc.js': true, 'dist/assets/index-abc.js': true, 'server/index.ts': false, 'src/App.tsx': false }
  const lintWrong: string[] = []
  for (const [path, skip] of Object.entries(lintFiles)) if (await lint.isPathIgnored(join(root, path)) !== skip) lintWrong.push(path)
  check('D13 a build anywhere stays out of the image and of lint', !dockerWrong.length && !lintWrong.length,
    `image takes or drops wrongly: ${dockerWrong.join(', ') || 'none'}; lint: ${lintWrong.join(', ') || 'none'}`)
}

// exitCode, not process.exit(): exiting with fetch's sockets still open crashed Node on Windows (0xC0000409)
live().catch(e => check('D9 production server', false, (e as Error).message))
  .then(portTaken).catch(e => check('D11 a port in use', false, (e as Error).message))
  .then(portReserved).catch(e => check('D11b a reserved port', false, (e as Error).message))
  .then(cacheHeaders).catch(e => check('D12 cache headers', false, (e as Error).message))
  .then(dotFolder).catch(e => check('D16 file routes under a dot folder', false, (e as Error).message))
  .then(buildOutput).catch(e => check('D13 a build anywhere', false, (e as Error).message))
  .finally(() => { process.exitCode = ok ? 0 : 1 })
