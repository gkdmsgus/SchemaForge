/**
 * npm run test:browser: every browser check, against a vite dev server and an API this script starts and stops itself.
 * The browser checks are every scripts/check_*.mjs but check_live.mjs (it drives the deployed site), found by their
 * names, so a new one joins by itself, and check_3d.ts with BASE (its viewer items: npm test runs it without BASE). Each
 * was run by hand "with npm run dev on" (README), so a screen change was checked only when someone remembered to.
 *
 * The servers listen on ports the OS gives (never 3000 or 8113, the dev ones), or on SF_BROWSER_API_PORT and
 * SF_BROWSER_VITE_PORT (--api-port, --vite-port). The API gets no key: every name SECRET_ENV (server/skidl_run.ts)
 * matches, in the environment or in server/.env (names only), is set to an empty or dummy value, so dotenv, which never
 * overrides a variable that is set, loads none, and the model and Supabase addresses are a closed local port. Both are
 * stopped with every child after the last check, on a failure and on Ctrl+C. On Windows a runner killed outright takes
 * them along too (Node puts the processes it starts in a job object the system closes with it); elsewhere it does not.
 *
 * Run: npm run test:browser [-- drawer check_pcb_sketch ...]   (names with or without check_ and .mjs; --list lists them)
 * A check passes on exit 0 with no FAIL line, inside its time limit (SF_BROWSER_CHECK_MIN, default 20 min). A server
 * without KiCad (/health kicad null) makes the checks that build a board SKIP, which is not a pass. Exit code 0 only if
 * every check picked passed and nothing listens on the two ports afterwards.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET_ENV } from '../server/skidl_run'

const ROOT = path.resolve(import.meta.dirname, '..')

/** scripts/check_*.mjs that stay out: check_live drives the deployed site (its default BASE), behind its proxy */
export const LEFT_OUT = ['check_live.mjs']
/** the checks that build a board, which needs KiCad (README: "KiCad 필요") */
const NEEDS_KICAD = ['scripts/check_board_panel.mjs', 'scripts/check_3d.ts']

export type BrowserCheck = { name: string, file: string, kicad: boolean }

/** every browser check, in the order they run: the .mjs ones by name, then check_3d (it reads the boards made before it) */
export function browserChecks(root = ROOT): BrowserCheck[] {
  const mjs = fs.readdirSync(path.join(root, 'scripts')).filter(f => /^check_.*\.mjs$/.test(f) && !LEFT_OUT.includes(f)).sort()
  return [...mjs.map(f => `scripts/${f}`), 'scripts/check_3d.ts']
    .map(file => ({ name: path.basename(file).replace(/\.(mjs|ts)$/, ''), file, kicad: NEEDS_KICAD.includes(file) }))
}

const POSIX = process.platform !== 'win32'
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const DEV_PORTS = [3000, 8113]
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** something answers on the port, on either loopback address */
async function listening(port: number) {
  const answers = (host: string) => new Promise<boolean>(resolve => {
    const c = net.connect({ port, host })
    c.setTimeout(1000)
    c.once('connect', () => { c.destroy(); resolve(true) })
    c.once('error', () => resolve(false))
    c.once('timeout', () => { c.destroy(); resolve(false) })
  })
  return (await answers('127.0.0.1')) || (await answers('::1'))
}
/** nothing answers on the port and it can be bound */
async function portFree(port: number) {
  if (await listening(port)) return false
  return new Promise<boolean>(resolve => {
    const s = net.createServer().once('error', () => resolve(false)).listen(port, () => s.close(() => resolve(true)))
  })
}
async function osPort(avoid: number[]) {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = net.createServer().once('error', reject).listen(0, () => {
        const p = (s.address() as net.AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    if (!avoid.includes(port) && await portFree(port)) return port
  }
  throw new Error('the OS gave no free port in 20 tries')
}

/** the environment for both servers and the checks: no key reaches them, the model and Supabase are a closed port */
function quietEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  let fileNames: string[] = []
  try {
    // the names only: a value in server/.env is never kept or passed on
    fileNames = fs.readFileSync(path.join(ROOT, 'server', '.env'), 'utf8').split(/\r?\n/)
      .map(l => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1] ?? '').filter(Boolean)
  } catch {}
  for (const k of [...Object.keys(env), ...fileNames]) if (SECRET_ENV.test(k)) env[k] = ''
  return {
    ...env, OPENAI_API_KEY: 'sk-none', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_SERVICE_KEY: 'none', MOUSER_API_KEY: 'none', NODE_ENV: 'development', ALLOWED_EMAILS: '', SF_OUTPUTS_SWEEP: '',
  }
}

/** the process and all its children: taskkill /T on Windows, the process group elsewhere (they start detached there) */
function killTree(pid: number | undefined) {
  if (!pid) return
  if (!POSIX) { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return }
  try { process.kill(-pid, 'SIGTERM') } catch { return }
  for (let i = 0; i < 30; i++) {
    sleepSync(100)
    try { process.kill(-pid, 0) } catch { return }
  }
  try { process.kill(-pid, 'SIGKILL') } catch {}
}
type Proc = { name: string, child: ChildProcess, tail: string[] }
const started: Proc[] = []
let running: ChildProcess | null = null

/** reads a stream line by line, a line split between two chunks kept whole */
function onLines(stream: NodeJS.ReadableStream, each: (line: string) => void) {
  let rest = ''
  stream.on('data', (d: Buffer) => {
    const lines = (rest + d.toString()).split(/\r?\n/)
    rest = lines.pop() ?? ''
    lines.forEach(each)
  })
  stream.on('end', () => { if (rest) each(rest) })
}

function startServer(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string): Proc {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: POSIX, windowsHide: true })
  const log = fs.createWriteStream(logFile)
  const p: Proc = { name, child, tail: [] }
  const keep = (line: string) => { log.write(line + '\n'); if (line.trim()) { p.tail.push(line); if (p.tail.length > 30) p.tail.shift() } }
  onLines(child.stdout!, keep)
  onLines(child.stderr!, keep)
  child.once('exit', () => log.end())
  started.push(p)
  return p
}
const exited = (p: Proc) => p.child.exitCode !== null || p.child.signalCode !== null

/** everything this run started, at once and without waiting for a callback, so it also runs inside a signal handler */
function stopAll() {
  killTree(running?.pid)
  // one that has exited is left alone on Windows: its number may already be another process's
  for (const p of started) if (POSIX || !exited(p)) killTree(p.child.pid)
}

async function waitOk(url: string, procs: Proc[], ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const gone = procs.find(exited)
    if (gone) throw new Error(`${gone.name} exited (code ${gone.child.exitCode}):\n  ${gone.tail.join('\n  ')}`)
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (r.ok) return r
    } catch {}
    await sleep(500)
  }
  throw new Error(`${url} did not answer 200 in ${Math.round(ms / 1000)} s`)
}

type Result = { name: string, verdict: 'PASS' | 'FAIL' | 'SKIP', why: string, seconds: number }

async function runCheck(c: BrowserCheck, base: string, env: NodeJS.ProcessEnv, limitMs: number): Promise<Result> {
  const args = c.file.endsWith('.ts') ? [TSX_CLI, c.file] : [c.file, base]
  console.log(`\n=== ${c.name}: node ${c.file.endsWith('.ts') ? `tsx ${c.file} (BASE=${base})` : `${c.file} ${base}`}`)
  const t0 = Date.now()
  const child = spawn(process.execPath, args, {
    cwd: ROOT, env: c.file.endsWith('.ts') ? { ...env, BASE: base } : env,
    stdio: ['ignore', 'pipe', 'pipe'], detached: POSIX, windowsHide: true,
  })
  running = child
  let failLine = '', skipLine = ''
  const relay = (line: string) => {
    console.log(`  ${line}`)
    const t = line.trim()
    if (!failLine && /^FAIL\b/.test(t)) failLine = t
    if (!skipLine && /^skip\b/i.test(t)) skipLine = t
  }
  onLines(child.stdout!, relay)
  onLines(child.stderr!, relay)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, limitMs)
  const code = await new Promise<number | null>(resolve => {
    child.once('error', e => { relay(`could not start: ${e.message}`); resolve(-1) })
    child.once('close', resolve)
  })
  clearTimeout(timer)
  // a browser it left behind: its process group outlives it (Windows keeps no such group: taskkill /T needs the parent)
  if (POSIX) killTree(child.pid)
  running = null
  const seconds = Math.round((Date.now() - t0) / 1000)
  if (timedOut) return { name: c.name, verdict: 'FAIL', why: `stopped after its limit of ${Math.round(limitMs / 60000)} min`, seconds }
  if (code !== 0) return { name: c.name, verdict: 'FAIL', why: `exit ${code}${failLine ? `, first: ${failLine.slice(0, 120)}` : ''}`, seconds }
  if (failLine) return { name: c.name, verdict: 'FAIL', why: `exit 0 but it printed: ${failLine.slice(0, 120)}`, seconds }
  if (skipLine) return { name: c.name, verdict: 'SKIP', why: `it skipped: ${skipLine.slice(0, 120)}`, seconds }
  return { name: c.name, verdict: 'PASS', why: '', seconds }
}

async function main() {
  const argv = process.argv.slice(2)
  const names: string[] = []
  let apiPort = Number(process.env.SF_BROWSER_API_PORT) || 0
  let vitePort = Number(process.env.SF_BROWSER_VITE_PORT) || 0
  let list = false
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2)
    const value = () => Number(inline ?? argv[++i])
    if (flag === '--list') list = true
    else if (flag === '--api-port') apiPort = value()
    else if (flag === '--vite-port') vitePort = value()
    else if (flag.startsWith('-')) { console.log(`unknown option ${argv[i]} (--list, --api-port N, --vite-port N)`); process.exit(1) }
    else names.push(argv[i])
  }
  const all = browserChecks()
  if (list) { for (const c of all) console.log(`${c.name}${c.kicad ? '  (KiCad)' : ''}`); return 0 }
  const key = (s: string) => path.basename(s).replace(/\.(mjs|ts)$/, '').replace(/^check_/, '')
  const unknown = names.filter(n => !all.some(c => key(c.name) === key(n)))
  if (unknown.length) {
    console.log(`no browser check named ${unknown.join(', ')}. The checks: ${all.map(c => c.name).join(', ')}`)
    return 1
  }
  const picked = names.length ? all.filter(c => names.some(n => key(n) === key(c.name))) : all
  const limitMs = (Number(process.env.SF_BROWSER_CHECK_MIN) || 20) * 60000

  for (const [what, port] of [['API', apiPort], ['vite', vitePort]] as const) {
    if (!port) continue
    if (DEV_PORTS.includes(port)) { console.log(`${what} port ${port} is the dev server's: give another, or none`); return 1 }
    if (!await portFree(port)) { console.log(`${what} port ${port} is in use: give a free one, or none`); return 1 }
  }
  apiPort ||= await osPort([...DEV_PORTS, vitePort])
  vitePort ||= await osPort([...DEV_PORTS, apiPort])
  if (apiPort === vitePort) { console.log('the API and vite need two ports'); return 1 }

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-browser-checks-'))
  const env = quietEnv()
  const base = `http://localhost:${vitePort}`
  console.log(`browser checks: ${picked.map(c => c.name).join(', ')}`)
  console.log(`API on ${apiPort}, vite on ${vitePort} (BASE ${base}), no keys; server logs in ${logDir}`)

  const results: Result[] = []
  const t0 = Date.now()
  try {
    const api = startServer('API', [TSX_CLI, 'index.ts'], path.join(ROOT, 'server'), { ...env, PORT: String(apiPort) }, path.join(logDir, 'api.log'))
    const vite = startServer('vite', [VITE_BIN, '--port', String(vitePort), '--strictPort'], ROOT,
      { ...env, PORT: String(apiPort) }, path.join(logDir, 'vite.log'))
    let health = await (await waitOk(`http://127.0.0.1:${apiPort}/health`, [api, vite], 180000)).json() as { kicad?: string | null }
    // kicad-cli is asked once at startup and answers a moment later
    for (let i = 0; i < 30 && !health.kicad; i++) {
      await sleep(1000)
      health = await (await waitOk(`http://127.0.0.1:${apiPort}/health`, [api, vite], 30000)).json() as { kicad?: string | null }
    }
    await waitOk(`${base}/health`, [api, vite], 120000) // through vite's proxy
    console.log(`servers up in ${Math.round((Date.now() - t0) / 1000)} s, KiCad: ${health.kicad ?? 'none'}`)

    for (const c of picked) {
      const down = [api, vite].find(exited)
      if (down) { results.push({ name: c.name, verdict: 'FAIL', why: `not run: ${down.name} stopped (${path.join(logDir, `${down.name.toLowerCase()}.log`)})`, seconds: 0 }); continue }
      if (c.kicad && !health.kicad) { results.push({ name: c.name, verdict: 'SKIP', why: 'no KiCad on this server (/health kicad null): not a pass', seconds: 0 }); continue }
      const r = await runCheck(c, base, env, limitMs)
      results.push(r)
      console.log(`${r.verdict} ${r.name}  ${r.seconds} s${r.why ? `  ${r.why}` : ''}`)
    }
  } catch (e) {
    console.log(`FAIL the servers: ${(e as Error).message}`)
    for (const c of picked) if (!results.some(r => r.name === c.name)) results.push({ name: c.name, verdict: 'FAIL', why: 'not run: the servers did not start', seconds: 0 })
  } finally {
    stopAll()
  }

  // nothing of this run may stay on the two ports
  let left: number[] = []
  for (let i = 0; i < 20; i++) {
    left = []
    for (const port of [apiPort, vitePort]) if (await listening(port)) left.push(port)
    if (!left.length) break
    await sleep(500)
  }

  const count = (v: Result['verdict']) => results.filter(r => r.verdict === v).length
  console.log(`\nbrowser checks, ${Math.round((Date.now() - t0) / 60000 * 10) / 10} min:`)
  for (const r of results) console.log(`  ${r.verdict} ${r.name}${r.seconds ? `  ${r.seconds} s` : ''}${r.why ? `  ${r.why}` : ''}`)
  console.log(left.length ? `FAIL still listening after the stop: ${left.join(', ')}` : `servers stopped: nothing listens on ${apiPort} or ${vitePort}`)
  const ok = count('PASS') === picked.length && !left.length
  console.log(ok ? `ALL PASS (${picked.length})` : `${count('PASS')} of ${picked.length} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped (not passes)`)
  return ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(sig, () => {
      console.log(`\n${sig}: stopping the running check and both servers`)
      stopAll()
      process.exit(130)
    })
  }
  process.on('uncaughtException', e => { console.log(`FAIL crashed: ${e.stack ?? e}`); stopAll(); process.exit(1) })
  let code = 1
  try { code = await main() } catch (e) { console.log(`FAIL crashed: ${(e as Error).stack ?? e}`); stopAll() }
  process.exitCode = code
  // a keep-alive socket of fetch must not hold the exit
  setTimeout(() => process.exit(code), 3000).unref()
}
