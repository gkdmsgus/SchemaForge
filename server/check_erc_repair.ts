// Checks E12-E13: what the skidl runner passes to model- or user-written code, and what it leaves behind.
// No model, no server, no KiCad; needs python + skidl (a missing python is a FAIL, not a skip).
// Usage (from server/): npx tsx check_erc_repair.ts   → exit 0 only if all pass
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { childEnv, runSkidl } from './skidl_run'

let ok = true
const check = (name: string, pass: boolean, info: string) => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Wait until a path is gone (a killed process lets go of its folder a moment later). */
async function gone(path: string, ms = 5000): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (!existsSync(path)) return true
  return !existsSync(path)
}

try {
  execFileSync('python', ['-c', 'import skidl'], { stdio: 'pipe' })
} catch (e) {
  check('python + skidl', false, errText(e).split('\n')[0])
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'sf_erccheck_'))
const out = join(work, 'outputs')
mkdirSync(out)
const blink = readFileSync(join('test_circuits', 'ne555_blink.py'), 'utf8')
/** Python lines inserted after the skidl import: record the folder the code ran in. */
const recordCwd = (marker: string) => `import os, sys, time\nopen(r'${marker}', 'w').write(os.getcwd())\n`
const withPrelude = (code: string, prelude: string) => code.replace(/^from skidl import \*\r?\n/, m => m + prelude)

// E12. secrets never reach the child: API keys, Supabase settings, *SECRET*, *TOKEN*; everything else does
const planted = { OPENAI_API_KEY: 'sk-check', SUPABASE_URL: 'https://check.invalid', MOUSER_API_KEY: 'm',
                  SF_CHECK_SECRET: 's', GH_TOKEN: 't', DB_PASSWORD: 'p', SF_CHECK_PLAIN: 'kept' }
Object.assign(process.env, planted)
const env = childEnv()
const leakProbe = withPrelude(blink,
  'import os, sys\n' +
  `leaked = sorted(k for k in os.environ if k.upper() in (${Object.keys(planted).filter(k => k !== 'SF_CHECK_PLAIN').map(k => `'${k}'`).join(', ')}))\n` +
  "if leaked or os.environ.get('SF_CHECK_PLAIN') != 'kept':\n" +
  "    sys.exit('env leaked=%s plain=%s' % (leaked, os.environ.get('SF_CHECK_PLAIN')))\n")
let e12 = ''
try { await runSkidl(leakProbe, out); e12 = 'child saw no secret and kept SF_CHECK_PLAIN' } catch (e) { e12 = `FAIL ${errText(e).trim().split('\n').pop()}` }
const filtered = Object.keys(planted).filter(k => k in env)
check('E12 secrets stripped from the skidl env', !e12.startsWith('FAIL') && filtered.join() === 'SF_CHECK_PLAIN'
  && !!(env.PATH || env.Path) && (process.platform !== 'win32' || !!env.SYSTEMROOT || !!env.SystemRoot),
  `${e12}; childEnv keeps [${filtered.join(', ')}] of the planted names`)
for (const k of Object.keys(planted)) delete process.env[k]

// E13. the temp folder is removed after a run that works, one that fails and one that times out
const cwdOf = (marker: string) => (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '')
const mOk = join(work, 'cwd_ok.txt'), mFail = join(work, 'cwd_fail.txt'), mSlow = join(work, 'cwd_slow.txt')
let okRun = false, failRun = false, slowRun = ''
try { await runSkidl(withPrelude(blink, recordCwd(mOk)), out); okRun = true } catch { /* reported below */ }
try { await runSkidl(withPrelude(blink, recordCwd(mFail) + "sys.exit('stop here')\n"), out) } catch (e) { failRun = /stop here/.test(errText(e)) }
try { await runSkidl(recordCwd(mSlow) + 'time.sleep(30)\n', out, 2500) } catch (e) { slowRun = errText(e) }
const dirs = [cwdOf(mOk), cwdOf(mFail), cwdOf(mSlow)]
const left: string[] = []
for (const d of dirs) if (!d || !(await gone(d))) left.push(d || '(no folder recorded)')
check('E13 temp folder removed (ok / error / timeout)', okRun && failRun && /timed out/.test(slowRun) && !left.length,
  `ran=${okRun} error=${failRun} timeout="${slowRun}" left=[${left.join(', ')}]`)

try { rmSync(work, { recursive: true, force: true }) } catch { /* leave it */ }
console.log(ok ? '\nALL PASS' : '\nSOME CHECKS FAILED')
process.exit(ok ? 0 : 1)
