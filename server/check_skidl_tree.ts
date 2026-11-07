// Check for the deploy image, run inside the container by pcb/check_deploy.py (39): what skidl code starts goes with
// it, and no zombie is left (the image starts the server under tini: node does not reap them). Linux only: /proc.
//   quiet    code that leaves three `sleep 300` writing nowhere and ends: they are gone once runSkidl answers (runSkidl
//            kills the process group: python alone was killed, review of 2026-11-03)
//   holding  the same with the sleeps holding python's stderr: runSkidl answers within seconds, not when they end or at
//            its time limit. Python's own exit ends the run: 'close' waits for every holder of the pipe, so this case
//            sat out its 30 s sleeps, and with them a run that left no such child passed with the group kill removed
//            (review of 2026-11-07)
//   hangs    code that starts one sleep and outlasts the time limit: python and its sleep go at the limit
// Usage (in the container, from /app/server): ./node_modules/.bin/tsx check_skidl_tree.ts   → exit 0 only if it passes
import { readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { runSkidl } from './skidl_run'

const procs = () => readdirSync('/proc').filter(p => /^\d+$/.test(p)).map(p => {
  try { return readFileSync(`/proc/${p}/stat`, 'utf8') } catch { return '' }
}).filter(Boolean)
const state = (stat: string) => stat.split(') ')[1]?.[0] ?? ''
const sleeping = () => procs().filter(s => s.includes('(sleep)') && state(s) !== 'Z').length

const LIMIT_MS = 20000
const cases = {
  quiet: { code: "import subprocess, sys\nfor _ in range(3): subprocess.Popen(['sleep', '300'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nsys.exit('done')\n", limit: LIMIT_MS, within: 10000 },
  holding: { code: "import subprocess, sys\nfor _ in range(3): subprocess.Popen(['sleep', '300'])\nsys.exit('done')\n", limit: LIMIT_MS, within: 10000 },
  hangs: { code: "import subprocess, time\nsubprocess.Popen(['sleep', '300'])\ntime.sleep(300)\n", limit: 2000, within: 10000 },
}
let ok = true
for (const [name, c] of Object.entries(cases)) {
  const t0 = Date.now()
  const said = await runSkidl(c.code, tmpdir(), c.limit).then(() => 'a netlist', (e: Error) => e.message.trim().split('\n').pop() ?? '')
  const took = Date.now() - t0
  await new Promise(r => setTimeout(r, 300))
  const left = sleeping()
  const pass = took < c.within && left === 0
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} skidl ${name}: answered in ${took} ms (limit ${c.within} ms), sleeps left ${left}  (${said.slice(0, 60)})`)
}
await new Promise(r => setTimeout(r, 1200))
const zombies = procs().filter(s => state(s) === 'Z').length
ok &&= zombies === 0
console.log(`${zombies === 0 ? 'ok  ' : 'FAIL'} skidl children reaped: zombies ${zombies}`)
console.log(ok ? 'ok   skidl children gone' : 'FAIL skidl children gone')
process.exit(ok ? 0 : 1)
