/**
 * The routed boards the checks read from server/outputs (check_human_review, check_bom, check_fixes): the good demo
 * circuits in both styles, made from the checked-in skidl files when missing or older than the generator. The checks
 * read whatever boards earlier work had left there, so a fresh clone skipped them and a swept folder failed them
 * (H3c: no through-hole N-MOSFET board, 2026-11-06).
 *
 * Run: npx tsx scripts/make_check_boards.ts   (npm test runs it first). Python + skidl, no KiCad, no model.
 * Exit code 0 only if every board exists afterwards.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runSkidl } from '../server/skidl_run'

const server = path.resolve('server')
const outDir = path.join(server, 'outputs')
const CIRCUITS = ['led_basic', 'ne555_blink', 'npn_relay', 'nmos_motor']
const STYLES = ['smd', 'tht'] as const

const mtime = (f: string) => fs.statSync(f).mtimeMs
const pcbDir = path.join(server, 'pcb')
const generator = [path.join(server, 'pcb_generator.py'),
  ...fs.readdirSync(pcbDir).filter(f => f.endsWith('.py') && !f.startsWith('check_') && f !== 'run_checks.py').map(f => path.join(pcbDir, f))]
const generatorTime = Math.max(...generator.map(mtime))

fs.mkdirSync(outDir, { recursive: true })
let made = 0, failed = 0
for (const circuit of CIRCUITS) {
  const source = path.join(server, 'test_circuits', `${circuit}.py`)
  const newest = Math.max(generatorTime, mtime(source))
  const stem = (style: string) => path.join(outDir, `checkboard_${circuit}_${style}`)
  const stale = STYLES.filter(s => !fs.existsSync(`${stem(s)}.board.json`) || mtime(`${stem(s)}.board.json`) < newest)
  if (!stale.length) continue
  try {
    const net = path.join(outDir, `checkboard_${circuit}.net`)
    fs.renameSync(await runSkidl(fs.readFileSync(source, 'utf8'), outDir), net)
    for (const style of stale) {
      const run = spawnSync('python', ['pcb_generator.py', net, `${stem(style)}.kicad_pcb`, '--style', style],
        { cwd: server, encoding: 'utf8', timeout: 120000 })
      if (run.status !== 0 || !fs.existsSync(`${stem(style)}.board.json`)) {
        failed++
        console.log(`FAIL ${circuit} ${style}  ${run.error?.message ?? (run.stderr || '').trim().split('\n').pop()}`)
      } else made++
    }
  } catch (e) {
    failed += stale.length
    console.log(`FAIL ${circuit}  ${(e as Error).message.trim().split('\n').pop()}`)
  }
}
console.log(failed ? `${failed} board(s) not made` : `check boards ready (${made} made, ${CIRCUITS.length * STYLES.length - made} kept)`)
process.exit(failed ? 1 : 0)
