/**
 * The routed boards the checks read from server/outputs (check_human_review, check_bom, check_fixes, check_operating,
 * check_board_checks): the good demo circuits in both styles, made from the checked-in skidl files when missing or older
 * than the generator. The checks read whatever boards earlier work had left there, so a fresh clone skipped them and a
 * swept folder failed them (H3c: no through-hole N-MOSFET board, 2026-11-06).
 *
 * Each board keeps the netlist it was made from under its own name, checkboard_<circuit>_<style>.net beside
 * checkboard_<circuit>_<style>.board.json, as the app keeps <name>.net beside <name>.board.json: check_bom B8d and
 * check_operating O9 compare a board with the circuit of the .net of the same name. One shared checkboard_<circuit>.net
 * paired with nothing, so a fresh clone failed both ("0 pairs", "0 boards", 2026-11-07).
 *
 * Run: npx tsx scripts/make_check_boards.ts   (npm test runs it first). Python + skidl, no KiCad, no model.
 * Exit code 0 only if every board and its netlist exist afterwards.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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
const stem = (circuit: string, style: string) => path.join(outDir, `checkboard_${circuit}_${style}`)

fs.mkdirSync(outDir, { recursive: true })
let made = 0, failed = 0
for (const circuit of CIRCUITS) {
  const source = path.join(server, 'test_circuits', `${circuit}.py`)
  const newest = Math.max(generatorTime, mtime(source))
  const stale = STYLES.filter(s => [`${stem(circuit, s)}.board.json`, `${stem(circuit, s)}.net`]
    .some(f => !fs.existsSync(f) || mtime(f) < newest))
  if (!stale.length) continue
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sf_checkboard_'))
  try {
    // 240 s, not the server's 90: a paging PC (about 2 GB free, 2026-11-10) ran the server's limit out on circuits that work
    const net = await runSkidl(fs.readFileSync(source, 'utf8'), work, 240000)
    for (const style of stale) {
      fs.copyFileSync(net, `${stem(circuit, style)}.net`)
      const run = spawnSync('python', ['pcb_generator.py', `${stem(circuit, style)}.net`, `${stem(circuit, style)}.kicad_pcb`, '--style', style],
        { cwd: server, encoding: 'utf8', timeout: 120000 })
      if (run.status !== 0 || !fs.existsSync(`${stem(circuit, style)}.board.json`)) {
        failed++
        console.log(`FAIL ${circuit} ${style}  ${run.error?.message ?? (run.stderr || '').trim().split('\n').pop()}`)
      } else made++
    }
  } catch (e) {
    failed += stale.length
    console.log(`FAIL ${circuit}  ${(e as Error).message.trim().split('\n').pop()}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
const missing = CIRCUITS.flatMap(c => STYLES.flatMap(s => [`${stem(c, s)}.board.json`, `${stem(c, s)}.net`]))
  .filter(f => !fs.existsSync(f)).map(f => path.basename(f))
if (missing.length && !failed) console.log(`FAIL check boards  missing ${missing.join(', ')}`)
const bad = failed || missing.length
console.log(bad ? `${failed} board(s) not made${missing.length ? `, ${missing.length} file(s) missing` : ''}`
  : `check boards ready (${made} made, ${CIRCUITS.length * STYLES.length - made} kept)`)
process.exit(bad ? 1 : 0)
