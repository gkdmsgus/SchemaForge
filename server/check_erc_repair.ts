// Checks E1-E20: the netlist check (ERC) /generate runs before any PCB, how its one repair round is
// judged (E1-E11, E14, E17), what the skidl runner passes to model- or user-written code and leaves
// behind (E12-E13, E18), the /generate and /test_code wiring read as text (E15-E16), the pin names
// erc.py shares with the front end (E19), and where findings point on the board (E20).
// No model, no server, no KiCad; needs python + skidl (a missing python is a FAIL).
// The broken circuit is test_circuits/ne555_blink.py with U1 RESET left open (the 2026-10 generation).
// Usage (from server/): npx tsx check_erc_repair.ts   → exit 0 only if all pass
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { childEnv, runSkidl } from './skidl_run'
import {
  ercFeedback, errorKeys, fixableErrors, judgeRepair, repairErc, runErc, stubErcFix,
  type ErcFinding, type ErcOk, type ErcRun, type RepairDeps,
} from './erc_repair'

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

const work = mkdtempSync(join(tmpdir(), 'sf_erccheck_'))
try {
  // in the temp dir: importing skidl writes skidl_REPL.* into the current folder
  execFileSync('python', ['-c', 'import skidl'], { stdio: 'pipe', cwd: work })
} catch (e) {
  check('python + skidl', false, errText(e).split('\n')[0])
  process.exit(1)
}

const out = join(work, 'outputs')
mkdirSync(out)
const blink = readFileSync(join('test_circuits', 'ne555_blink.py'), 'utf8')
/** Python lines inserted after the skidl import: record the folder the code ran in. */
const recordCwd = (marker: string) => `import os, sys, time\nopen(r'${marker}', 'w').write(os.getcwd())\n`
const withPrelude = (code: string, prelude: string) => code.replace(/^from skidl import \*\r?\n/, m => m + prelude)

const RESET_LINE = /^u1\['RESET'\] \+= vcc\r?\n/m
const broken = blink.replace(RESET_LINE, '')
const cwd = process.cwd()
const erc = (p: string) => runErc(p, cwd)
const run = (c: string) => runSkidl(c, out)
const guideOf = 'original guide'
const fixedNet = await run(blink)
const brokenNet = await run(broken)
const fixedErc = await erc(fixedNet)
const brokenErc = await erc(brokenNet)
const sameRun = (r: ErcRun): ErcOk => (r.ok ? r : { ok: true, findings: [], components: [], nets: [] })

// E1. the pre-PCB check sees the open RESET (one fixable error, U1 pin 4) and the parts; the good circuit is clean;
//     the full board generator reports exactly the same findings for the broken netlist
const fix1 = brokenErc.ok ? fixableErrors(brokenErc.findings) : []
execFileSync('python', [join(cwd, 'pcb_generator.py'), brokenNet, join(work, 'broken.kicad_pcb')], { cwd, stdio: 'pipe' })
const boardErc = JSON.parse(readFileSync(join(work, 'broken.board.json'), 'utf8')).erc
check('E1 ERC before PCB', broken !== blink && brokenErc.ok && fix1.length === 1 && fix1[0].rule === 'floating_pin'
  && fix1[0].refs.length === 1 && fix1[0].refs[0].ref === 'U1' && fix1[0].refs[0].pin === '4'
  && fix1[0].refs[0].sym === '4' && fix1[0].refs[0].name === 'RESET' && brokenErc.nets.length > 0
  && brokenErc.components.length === 9 && fixedErc.ok && fixedErc.findings.length === 0
  && JSON.stringify(boardErc) === JSON.stringify(brokenErc.findings),
  `fixture edited=${broken !== blink} broken=[${errorKeys(sameRun(brokenErc).findings)}] parts=${sameRun(brokenErc).components.length}` +
  ` good=${fixedErc.ok ? fixedErc.findings.length : 'did not run'} board=${JSON.stringify(boardErc) === JSON.stringify(sameRun(brokenErc).findings) ? 'same' : 'different'}`)

// E2. a check that did not run is not a pass: missing netlist, 1 ms timeout, no pcb_generator.py in cwd
const missing = await erc(join(work, 'nope.net'))
const quick = await runErc(brokenNet, cwd, 1)
const noGen = await runErc(brokenNet, work)
check('E2 failed ERC is ok:false', !missing.ok && !quick.ok && !noGen.ok,
  [missing, quick, noGen].map(r => (r.ok ? 'ok:true' : r.reason)).join(' | '))

/** repairErc with a fake model; counts the calls. */
async function attempt(answer: () => Promise<string>, deps: Partial<RepairDeps> = {}) {
  let calls = 0
  const r = await repairErc({ code: broken, guide: guideOf, netPath: brokenNet, erc: sameRun(brokenErc) },
    { ask: () => { calls++; return answer() }, run, erc, ...deps })
  return { ...r, calls }
}
const kept0 = (r: Awaited<ReturnType<typeof attempt>>) =>
  !r.kept && r.code === broken && r.netPath === brokenNet && r.guide === guideOf && existsSync(brokenNet) && r.calls === 1

// E3. a good repair is kept: code, guide and netlist replaced, the old netlist handed back to delete
const good = await attempt(async () => `${blink}\n---GUIDE---\n가이드`)
const stub = await attempt(async () => stubErcFix(broken))
check('E3 good repair kept', good.kept && good.before === 1 && good.after === 0 && good.guide === '가이드'
  && good.code.trim() === blink.trim() && good.discard === brokenNet && good.netPath !== brokenNet && good.calls === 1
  && stub.kept && stub.guide === guideOf && stub.after === 0,
  `kept=${good.kept} ${good.note} discard=${good.discard === brokenNet ? 'old net' : good.discard}; stub kept=${stub.kept} ${stub.note}`)

// E4. deleting the part the error is on is rejected, even though the floating pin is gone
const noU1 = broken.split(/\r?\n/).filter(l => !/^u1\b/.test(l)).join('\n')
const del = await attempt(async () => noU1)
check('E4 deleting U1 rejected', !/^u1\b/m.test(noU1) && kept0(del) && del.note.includes('U1')
  && !!del.discard && del.discard !== brokenNet, `kept=${del.kept} note=${del.note}`)

// E5. code that does not run is dropped, with no second (code-fix) model call
const syntax = await attempt(async () => 'from skidl import *\nu1 = Part(\ngenerate_netlist()\n')
check('E5 broken code rejected', kept0(syntax) && syntax.discard === null, `calls=${syntax.calls} note=${syntax.note}`)

// E6. no improvement is no repair (1 -> 1)
const same = await attempt(async () => broken)
check('E6 no improvement rejected', kept0(same) && same.after === 1, `note=${same.note}`)

// E7. the model failing (a timeout) keeps the original and says so
const late = await attempt(async () => { throw new Error('timeout of 45000ms exceeded') })
check('E7 model timeout keeps original', kept0(late) && /timeout/.test(late.note) && late.discard === null, `note=${late.note}`)

// E8. the ERC failing on the repaired netlist is never a pass
let ercCalls = 0
const blind = await attempt(async () => blink, {
  erc: async () => { ercCalls++; return { ok: false, reason: 'ERC 시간 초과 (30000 ms)' } },
})
check('E8 ERC failure on the repair rejected', kept0(blind) && ercCalls === 1 && !!blind.discard && /시간 초과/.test(blind.note),
  `note=${blind.note}`)

// E9. changing an original value alongside the fix is rejected
const r1Changed = blink.replace("r1.value = '10k'", "r1.value = '12k'")
const val = await attempt(async () => r1Changed)
check('E9 value change rejected', r1Changed !== blink && kept0(val) && val.note.includes('R1') && val.after === 0,
  `note=${val.note}`)

// E10. the feedback names the pin and carries the Korean message; warnings are never fed back
const fb = ercFeedback(fix1)
const synthetic: ErcFinding[] = [
  { rule: 'unpowered_rail', severity: 'warning', message: 'w', refs: [{ ref: 'U1', pin: '8' }], net: 'VCC' },
  { rule: 'output_conflict', severity: 'warning', message: 'w', refs: [{ ref: 'U1', pin: '3' }], net: 'OUT' },
  { rule: 'no_ground', severity: 'error', message: 'GND 넷이 없습니다', refs: [], net: null },
]
check('E10 feedback and rules', fb.includes('U1 pin 4 (RESET)') && fb.includes('U1의 RESET 핀(4번)이 어느 넷에도 연결되지 않았습니다')
  && fixableErrors(synthetic).map(f => f.rule).join() === 'no_ground', fb.split('\n')[1])

// E11. SYSTEM_PROMPT SECTION 1 (read as text, like run_checks check_templates) carries the wiring and LED rules
const src = readFileSync('index.ts', 'utf8')
const section1 = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('═══ SECTION 2'))
const rules = { reset: section1.includes("u1['RESET'] += vcc") && /RESET → VCC/.test(section1),
                ctrl: /CTRL → a 10nF capacitor to GND/.test(section1),
                decoupling: /VCC → VCC, with a 100nF capacitor/.test(section1),
                astable: /TRIG and pin 6 THRES on one net/.test(section1),
                led: ['RED', 'GREEN', 'YELLOW', 'BLUE', 'WHITE'].every(c => section1.includes(`'${c}'`)) && /Use 'RED' when/.test(section1) }
check('E11 prompt rules', Object.values(rules).every(Boolean), JSON.stringify(rules))

// E15. the /generate ERC block (read as text): every status names the netlist (App.tsx detectStep keeps the
//      wizard step), none has a line break (sse() writes one data: line), and no timer aborts the request
const block = src.slice(src.indexOf('// Netlist check (ERC) before any PCB'), src.indexOf('const filename = basename(outputPath)'))
const statuses = [...block.matchAll(/sse\('status',\s*([`'])([\s\S]*?)\1\)/g)].map(m => m[2])
  .concat([...block.matchAll(/\?\s*`([^`]*)`\s*:\s*`([^`]*)`/g)].flatMap(m => [m[1], m[2]]))
check('E15 /generate ERC statuses', block.length > 0 && statuses.length >= 6
  && statuses.every(s => /netlist/i.test(s) && !s.includes('\\n')) && !/abort\(\)/.test(block) && /erc: ercDone/.test(src),
  `${statuses.length} statuses: ${statuses.map(s => s.slice(0, 24)).join(' | ')}`)

// E16. /test_code (read as text): login required, the code runs untrimmed, the ERC is report-only (no model)
const testCode = src.slice(src.indexOf("app.post('/test_code'"), src.indexOf('// ── GET /download/:filename'))
check('E16 /test_code contract', /^app\.post\('\/test_code', requireAuth/.test(testCode) && !/code\b[^\n=]*=[^\n]*\.trim\(\)/.test(testCode)
  && /runSkidl\(code\)/.test(testCode) && /runErc\(/.test(testCode) && !/askErcFix|repairErc/.test(testCode)
  && testCode.includes("'The netlist has no parts.'") && testCode.includes('ercError'),
  testCode.split('\n').slice(0, 3).map(l => l.trim()).join(' / '))

// E14. the judge on its own: a new error key or more warnings is rejected even when the count drops
const fp = (ref: string, pin: string): ErcFinding => ({ rule: 'floating_pin', severity: 'error', message: '', refs: [{ ref, pin }], net: null })
const parts = sameRun(brokenErc).components
const base: ErcOk = { ok: true, findings: [fp('U1', '4'), fp('U1', '5')], components: parts, nets: [] }
const swapped = judgeRepair(base, { ok: true, findings: [fp('R1', '1')], components: parts, nets: [] })
const noisier = judgeRepair(base, { ok: true, findings: [fp('U1', '4'), synthetic[0]], components: parts, nets: [] })
const better = judgeRepair(base, { ok: true, findings: [fp('U1', '4')], components: [...parts, { ref: 'C9', value: '10nF', part: 'C' }], nets: [] })
check('E14 judge', !swapped.keep && !noisier.keep && better.keep,
  `swap: ${swapped.keep ? 'kept' : swapped.why} | warn: ${noisier.keep ? 'kept' : noisier.why} | new part allowed: ${better.keep}`)

// E17. a fix may wire the broken pin, not move pins that were already right: RESET fixed but the LED turned
//      around, or TRIG moved to GND, is rejected; the error count alone would have kept both
const fixedRest = (edit: (c: string) => string) => attempt(async () => edit(blink))
const ledFlip = await fixedRest(c => c.replace("d1['A'] += led_a", "d1['A'] += gnd").replace("d1['K'] += gnd", "d1['K'] += led_a"))
const trigGnd = await fixedRest(c => c.replace("u1['TRIG'] += thres", "u1['TRIG'] += gnd"))
check('E17 rewiring correct pins rejected', kept0(ledFlip) && /맞게 이어져 있던 핀/.test(ledFlip.note) && /D1\./.test(ledFlip.note)
  && kept0(trigGnd) && /U1\.2/.test(trigGnd.note) && ledFlip.after === 0 && trigGnd.after === 0,
  `led: ${ledFlip.note} | trig: ${trigGnd.note}`)

// E18. Python's tracebacks reach the Code tab without colour codes, even when the parent sets FORCE_COLOR
process.env.FORCE_COLOR = '1'
let colourErr = ''
try { await runSkidl(blink.replace("d1.value = 'RED'", 'd1.value = RED'), out) } catch (e) { colourErr = errText(e) }
delete process.env.FORCE_COLOR
const envC = childEnv({ FORCE_COLOR: '1', PATH: 'x' })
check('E18 plain tracebacks', /NameError/.test(colourErr) && !colourErr.includes('\x1b[') && envC.PYTHON_COLORS === '0' && !('FORCE_COLOR' in envC),
  `NameError=${/NameError/.test(colourErr)} ansi=${colourErr.includes('\x1b[')} PYTHON_COLORS=${envC.PYTHON_COLORS}`)

// E19. erc.py names pins with the same table as the front end (src/lib/humanReview.ts PIN_NAMES)
const table = (text: string, start: RegExp) => {
  const body = (start.exec(text)?.[1] ?? '')
  return Object.fromEntries([...body.matchAll(/'?([A-Za-z_0-9]+)'?:\s*\[([^\]]*)\]/g)].map(m => [m[1], [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1])]))
}
const pyNames = table(readFileSync(join('pcb', 'erc.py'), 'utf8'), /PIN_NAMES = \{([\s\S]*?)\n\}/)
const tsNames = table(readFileSync(join('..', 'src', 'lib', 'humanReview.ts'), 'utf8'), /PIN_NAMES[^=]*= \{([\s\S]*?)\n\}/)
const sorted = (o: Record<string, string[]>) => JSON.stringify(Object.entries(o).sort())
check('E19 pin names match the front end', Object.keys(pyNames).length >= 10 && sorted(pyNames) === sorted(tsNames),
  `${Object.keys(pyNames).length} in erc.py, ${Object.keys(tsNames).length} in humanReview.ts`)

// E20. every rule's refs sit on the board pad (the board view marks it) and carry the symbol pin: an LED anode
//      (symbol 1, pad 2 in the LED footprint) on a typo net; error keys and status sites use the symbol pin
const typoNet = await run(blink.replace("d1['A'] += led_a", "d1['A'] += Net('LEDA')"))
const typo = await erc(typoNet)
const anode = typo.ok ? typo.findings.flatMap(f => f.refs).find(r => r.ref === 'D1') : undefined
check('E20 refs on the pad, keys by symbol pin', !!anode && anode.pin === '2' && anode.sym === '1' && anode.name === 'A'
  && typo.ok && errorKeys(typo.findings).includes('single_pin_net D1.1'),
  `D1 ref=${JSON.stringify(anode)} keys=[${typo.ok ? errorKeys(typo.findings).join(', ') : typo.reason}]`)

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
