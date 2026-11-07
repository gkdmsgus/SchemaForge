// Checks K1-K4: DRC on the development PC reads the vendored footprint table, as the images do (kicad_config.ts). The PC's
// own table takes in all of KiCad's installed libraries: about 10 s and 1.4 GB a DRC, against about 1.5 s and 160 MB.
// K1 the table names every server/pcb/footprints/<name>.pretty as <name> (named with .pretty, every footprint came back
// as lib_footprint_issues and nothing else said so). K2 a development server writes it at start in its temp folder,
// and the demo board's DRC finds no lib_footprint_issues. K3 that DRC reads that table: emptied, every footprint comes
// back as lib_footprint_issues (the PC's own table would have found them all). K4 run_checks.py writes the same table.
// No model; needs python + skidl and KiCad (kicad-cli).
// Usage (from server/): npx tsx check_kicad_config.ts   → exit 0 only if all pass
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { footprintTable, KICAD_VERSION_DIR } from './kicad_config'

let ok = true
const check = (name: string, pass: boolean, info = '') => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

const FOOTPRINTS = join(process.cwd(), 'pcb', 'footprints')
const table = footprintTable(FOOTPRINTS)

// K1
{
  const folders = readdirSync(FOOTPRINTS).filter(f => f.endsWith('.pretty') && statSync(join(FOOTPRINTS, f)).isDirectory()).sort()
  const libs = [...table.matchAll(/\(lib \(name "([^"]+)"\)\(type "KiCad"\)\(uri "([^"]+)"\)/g)].map(m => ({ name: m[1], uri: m[2] }))
  const wrong = libs.filter(l => l.name.endsWith('.pretty') || !existsSync(l.uri) || /\\/.test(l.uri)).map(l => l.name)
  check('K1 the table names each vendored library without .pretty, at its folder', folders.length > 0
    && libs.map(l => `${l.name}.pretty`).join() === folders.join() && !wrong.length,
    `${libs.length} libraries, ${folders.length} folders${wrong.length ? `; wrong: ${wrong.join(', ')}` : ''}`)
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number }
    s.close(() => resolve(port))
  })
})

/** the demo board through the server: its DRC (the drc event) and the files it left in outputs/ */
async function demoBoard(base: string) {
  const demo = await (await fetch(`${base}/demo_result/led`)).json() as { filename?: string }
  if (!demo.filename) return { lib: -1, seconds: 0, said: 'no demo netlist' }
  const text = await (await fetch(`${base}/generate_pcb_stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: demo.filename, style: 'smd' }),
  })).text()
  const event = (name: string) => { const m = new RegExp(`event: ${name}\\ndata: (.+)`).exec(text); return m ? JSON.parse(m[1]) : null }
  const drc = event('drc') as { available?: boolean; reason?: string; seconds?: number; violations?: { type: string }[] } | null
  const done = event('done') as { pcbFilename?: string } | null
  const stem = (done?.pcbFilename ?? demo.filename.replace(/\.net$/, '.kicad_pcb')).replace(/\.kicad_pcb$/, '')
  for (const end of ['.net', '.kicad_pcb', '.board.json', '.kicad_prl']) rmSync(join('outputs', stem + end), { force: true })
  if (!drc?.available) return { lib: -1, seconds: drc?.seconds ?? 0, said: drc ? `DRC did not run: ${drc.reason}` : `no drc event: ${text.slice(-160)}` }
  const kinds: Record<string, number> = {}
  for (const v of drc.violations ?? []) kinds[v.type] = (kinds[v.type] ?? 0) + 1
  return { lib: kinds.lib_footprint_issues ?? 0, seconds: drc.seconds ?? 0, said: JSON.stringify(kinds) }
}

// K2, K3: a development server whose temp folder is the check's own, so the table it writes can be found and changed
async function live() {
  const temp = mkdtempSync(join(tmpdir(), 'sf_kcfg_check_'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development', PORT: String(port), TEMP: temp, TMP: temp, TMPDIR: temp,
    SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '', SF_OUTPUTS_SWEEP: '', SF_AI_STUB: '' }
  delete env.KICAD_CONFIG_HOME
  const proc = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  proc.stdout!.on('data', (d: Buffer) => { said += d.toString() })
  proc.stderr!.on('data', (d: Buffer) => { said += d.toString() })
  try {
    let up = false
    for (const t0 = Date.now(); !up && Date.now() - t0 < 60000 && proc.exitCode === null; await new Promise(r => setTimeout(r, 300))) {
      up = await fetch(base + '/health').then(r => r.ok, () => false)
    }
    if (!up) return check('K2 a development server', false, `did not start in 60 s: ${said.trim().slice(-300)}`)
    const homes = readdirSync(temp).filter(f => f.startsWith('sf_kicad_'))
    const written = homes.map(h => join(temp, h, KICAD_VERSION_DIR, 'fp-lib-table')).find(f => existsSync(f))
    const first = await demoBoard(base)
    check('K2 the development server writes the vendored table, and the demo board\'s DRC finds no lib_footprint_issues',
      !!written && readFileSync(written, 'utf8') === table && first.lib === 0,
      `${written ? 'table written' : `no table in its temp folder (${homes.join(', ') || 'nothing'})`}; DRC ${first.seconds} s ${first.said}`)
    if (!written) return check('K3 the DRC reads that table', false, 'no table to change')
    writeFileSync(written, '(fp_lib_table\n  (version 7)\n)\n')
    const emptied = await demoBoard(base)
    check('K3 the DRC reads that table: emptied, every footprint is lib_footprint_issues', emptied.lib > 0,
      `DRC ${emptied.seconds} s ${emptied.said}`)
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise(r => proc.once('exit', r))
      proc.kill()
      await gone
    }
    try { rmSync(temp, { recursive: true, force: true }) } catch { /* kicad-cli may hold a file a moment longer */ }
  }
}

// K4. run_checks.py's DRC reads a table of its own making: the same text
function runChecksTable() {
  const home = mkdtempSync(join(tmpdir(), 'sf_kcfg_py_'))
  try {
    const py = 'import sys; sys.path.insert(0, sys.argv[1]); from run_checks import vendored_kicad_config; vendored_kicad_config(sys.argv[2], sys.argv[3])'
    const r = spawnSync('python', ['-c', py, join(process.cwd(), 'pcb'), home, FOOTPRINTS], { encoding: 'utf8' })
    const file = join(home, KICAD_VERSION_DIR, 'fp-lib-table')
    const same = existsSync(file) && readFileSync(file, 'utf8') === table
    check('K4 run_checks.py writes the same table as the server', r.status === 0 && same,
      r.status !== 0 ? `python exited ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}` : same ? '' : 'the tables differ')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

runChecksTable()
// exitCode, not process.exit(): exiting with fetch's sockets still open crashed Node on Windows (0xC0000409)
live().catch(e => check('K2 a development server', false, (e as Error).message))
  .finally(() => { process.exitCode = ok ? 0 : 1 })
