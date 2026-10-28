// Checks M1-M6: the demo netlists built ahead (demo_cache.ts). M1 every demo circuit is built with the hash
// of its code, M2 a stored netlist is the one skidl makes now (the date, tags and uuids it makes up aside), M3 each visit gets its
// own copy in outputs, M4 a changed or missing circuit falls back to running skidl, M5 /demo_result takes the
// stored netlist first and refuses names like "constructor" (index.ts read as text), M6 the Dockerfile builds
// the cache. Needs python + skidl. Usage (from server/): npx tsx check_demo_cache.ts → exit 0 only if all pass
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEMOS, buildDemoCache, cachedDemo } from './demo_cache'
import { runSkidl } from './skidl_run'

let ok = true
const check = (name: string, pass: boolean, info = '') => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}
/** a netlist without what skidl makes up on every run: the date, each part's SKiDL tag and tstamps uuid */
const same = (t: string) => t.replace(/\r/g, '').replace(/^\s*\(date "[^"]*"\)\n/m, '')
  .replace(/(\(name "SKiDL Tag"\) )"[^"]*"/g, '$1""').replace(/\(tstamps "[0-9a-f-]{36}"\)/g, '(tstamps "")')

async function main() {
  const circuits = join(process.cwd(), 'test_circuits')
  const tmp = mkdtempSync(join(tmpdir(), 'sf_democache_'))
  const cache = join(tmp, 'cache'), out = join(tmp, 'out')
  try {
    const t0 = Date.now()
    const built = await buildDemoCache(circuits, cache)
    const wanted = [...new Set(Object.values(DEMOS))]
    const files = readdirSync(cache)
    check('M1 every demo circuit built', wanted.every(c => files.includes(`${c}.net`) && files.includes(`${c}.json`)) && built.length === wanted.length,
      `${built.length} circuits in ${((Date.now() - t0) / 1000).toFixed(1)} s`)

    const code = readFileSync(join(circuits, 'nmos_motor.py'), 'utf8')
    const fresh = await runSkidl(code, tmp)
    check('M2 stored netlist = a fresh skidl run', same(readFileSync(join(cache, 'nmos_motor.net'), 'utf8')) === same(readFileSync(fresh, 'utf8')))

    mkdirSync(out)
    const a = cachedDemo('nmos_motor', code, cache, out), b = cachedDemo('nmos_motor', code, cache, out)
    check('M3 each visit gets its own copy', !!a && !!b && a !== b && existsSync(a) && existsSync(b)
      && readFileSync(a, 'utf8') === readFileSync(join(cache, 'nmos_motor.net'), 'utf8'), `${a?.slice(-12)} / ${b?.slice(-12)}`)

    check('M4 changed or missing circuit → run skidl', cachedDemo('nmos_motor', code + '\n# edited', cache, out) === null
      && cachedDemo('nmos_motor', code, join(tmp, 'nothing'), out) === null)

    const src = readFileSync(join(process.cwd(), 'index.ts'), 'utf8')
    const route = src.slice(src.indexOf("app.get('/demo_result/:name'"), src.indexOf('// ── GET /health'))
    check('M5 /demo_result: stored netlist first, own names only', /cachedDemo\([^)]*\)\s*\?\?\s*await runSkidl\(code\)/.test(route)
      && /Object\.hasOwn\(DEMOS, name\)/.test(route) && !Object.hasOwn(DEMOS, 'constructor'))

    const docker = readFileSync(join(process.cwd(), '..', 'Dockerfile'), 'utf8')
    check('M6 the image builds the cache', /RUN \.\/node_modules\/\.bin\/tsx build_demo_cache\.ts/.test(docker)
      && docker.indexOf('build_demo_cache.ts') > docker.indexOf('COPY server/ ./server/'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch(e => check('demo cache checks', false, (e as Error).message)).finally(() => { process.exitCode = ok ? 0 : 1 })
