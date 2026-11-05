// Checks O1-O4: what a deployed server keeps in outputs/ (outputs_sweep.ts). On the Jetson the folder outlives restarts
// on the SD card, and nothing removed from it (review of 2026-11-03).
// Usage (from server/): npx tsx check_outputs_sweep.ts   → exit 0 only if all pass
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sweepOutputs } from './outputs_sweep'

let failed = 0
const check = (name: string, ok: boolean, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

const now = Date.now(), hour = 3600_000
const dir = mkdtempSync(join(tmpdir(), 'sf_sweep_'))
const put = (name: string, bytes: number, ageHours: number) => {
  const p = join(dir, name)
  writeFileSync(p, Buffer.alloc(bytes))
  utimesSync(p, (now - ageHours * hour) / 1000, (now - ageHours * hour) / 1000)
}
try {
  // O1. a day old goes, a gerber folder with its files too; what is newer stays
  put('old.net', 100, 30)
  mkdirSync(join(dir, 'old_gerber'))
  writeFileSync(join(dir, 'old_gerber', 'a.gbr'), Buffer.alloc(50))
  utimesSync(join(dir, 'old_gerber'), (now - 30 * hour) / 1000, (now - 30 * hour) / 1000)
  put('new.net', 100, 1)
  const s1 = sweepOutputs(dir, 24, 1e9, now)
  check('O1 entries older than the day go (a gerber folder with its files), newer ones stay',
    s1.removed.sort().join(',') === 'old.net,old_gerber' && existsSync(join(dir, 'new.net')) && !existsSync(join(dir, 'old_gerber')),
    JSON.stringify(s1))

  // O2. over the size cap, the oldest go until the rest fits, all of them within the day
  put('a.kicad_pcb', 400, 5)
  put('b.kicad_pcb', 400, 4)
  put('c.kicad_pcb', 400, 3)
  const s2 = sweepOutputs(dir, 24, 800, now)
  check('O2 over the cap the oldest go first until the rest fits',
    s2.removed.join(',') === 'a.kicad_pcb,b.kicad_pcb' && s2.bytes === 500 && existsSync(join(dir, 'c.kicad_pcb')) && existsSync(join(dir, 'new.net')),
    JSON.stringify(s2))

  // O3. only a server the deploy images turn it on for sweeps: a dev server, and one the checks start in production
  // mode, keep the checks' fixtures in outputs/ (keyed to NODE_ENV, the deploy-guard check removed one, 2026-11-05)
  const src = readFileSync('index.ts', 'utf8')
  const wired = /if \(process\.env\.SF_OUTPUTS_SWEEP === '1'\) \{[^}]*sweepOutputs\(OUTPUTS_DIR/.test(src) && /setInterval\(sweep, [^)]*\)\.unref\(\)/.test(src)
  check('O3 the server sweeps outputs/ only when SF_OUTPUTS_SWEEP=1, at start and every quarter hour', wired)

  // O4. both deploy images turn it on, and the deploy-guard check's production server turns it off
  const images = ['../Dockerfile', '../Dockerfile.jetson'].map(f => /\bSF_OUTPUTS_SWEEP=1\b/.test(readFileSync(f, 'utf8')))
  const guard = /SF_OUTPUTS_SWEEP: ''/.test(readFileSync('check_deploy_guard.ts', 'utf8'))
  check('O4 deploy images sweep, the guard check does not', images.every(Boolean) && guard, `Dockerfile ${images[0]}, Dockerfile.jetson ${images[1]}, check_deploy_guard ${guard}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
