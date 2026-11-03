// Check for the deploy image, run inside the container by pcb/check_deploy.py (39): what skidl code starts goes with
// it. Code that leaves three `sleep 30` and ends, and code that starts one and times out; afterwards no sleep may
// still run (runSkidl kills the process group: python alone was killed on a timeout, review of 2026-11-03) and no
// zombie may be left (the image starts the server under tini: node does not reap them). Linux only: /proc.
// Usage (in the container, from /app/server): ./node_modules/.bin/tsx check_skidl_tree.ts   → exit 0 only if it passes
import { readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { runSkidl } from './skidl_run'

const procs = () => readdirSync('/proc').filter(p => /^\d+$/.test(p)).map(p => {
  try { return readFileSync(`/proc/${p}/stat`, 'utf8') } catch { return '' }
}).filter(Boolean)
const state = (stat: string) => stat.split(') ')[1]?.[0] ?? ''

const ends = "import subprocess, sys\nfor _ in range(3): subprocess.Popen(['sleep', '30'])\nsys.exit('done')\n"
const hangs = "import subprocess, time\nsubprocess.Popen(['sleep', '30'])\ntime.sleep(30)\n"
try { await runSkidl(ends, tmpdir()) } catch { /* no netlist: expected */ }
try { await runSkidl(hangs, tmpdir(), 2000) } catch { /* times out: expected */ }
await new Promise(r => setTimeout(r, 1500))
const all = procs()
const running = all.filter(s => s.includes('(sleep)') && state(s) !== 'Z').length
const zombies = all.filter(s => state(s) === 'Z').length
const ok = running === 0 && zombies === 0
console.log(`${ok ? 'ok  ' : 'FAIL'} skidl children gone  sleeps still running ${running} of 4, zombies ${zombies}`)
process.exit(ok ? 0 : 1)
