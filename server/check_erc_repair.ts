// Checks E1-E28: the netlist check (ERC) /generate runs before any PCB, how its one repair round is
// judged (E1-E11, E14, E17), what the skidl runner passes to model- or user-written code and leaves
// behind (E12-E13, E18, E22-E23), the /generate and /test_code wiring read as text (E15-E16), the pin names
// erc.py shares with the front end (E19), where findings point on the board (E20), the prompt's
// ref= rule run in skidl (E21), pad numbers by board style through /erc_graph (E24), a netlist written from a
// graph, which has no pintype (E25-E27), and the supply pins no_bypass reads (E28).
// No model, no server, no KiCad; needs python + skidl (a missing python is a FAIL).
// The broken circuit is test_circuits/ne555_blink.py with U1 RESET left open (the 2026-10 generation).
// Usage (from server/): npx tsx check_erc_repair.ts   → exit 0 only if all pass
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { childEnv, runSkidl, STDERR_KEPT } from './skidl_run'
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
// Time limits for runs that should finish: the server's own (skidl 90 s, ERC 30 s) ran out while the PC paged with about
// 2 GB of memory free (E12 and E25 on 2026-11-10), and a run that was only slow is not what these items check. The items
// about a time limit keep theirs (E2's 1 ms, E13's 2.5 s, E23's 4 s)
const SKIDL_MS = 240000, ERC_MS = 120000
const erc = (p: string) => runErc(p, cwd, ERC_MS)
const run = (c: string) => runSkidl(c, out, SKIDL_MS)
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

// E10. the feedback names the pin and carries the Korean message; warnings are never fed back. It keeps ref= too:
//      a repair that drops it is renumbered by creation order and judgeRepair rejects the parts as changed
const fb = ercFeedback(fix1)
const synthetic: ErcFinding[] = [
  { rule: 'unpowered_rail', severity: 'warning', message: 'w', refs: [{ ref: 'U1', pin: '8' }], net: 'VCC' },
  { rule: 'output_conflict', severity: 'warning', message: 'w', refs: [{ ref: 'U1', pin: '3' }], net: 'OUT' },
  { rule: 'no_ground', severity: 'error', message: 'GND 넷이 없습니다', refs: [], net: null },
]
check('E10 feedback and rules', fb.includes('U1 pin 4 (RESET)') && fb.includes('U1의 RESET 핀(4번)이 어느 넷에도 연결되지 않았습니다')
  && fb.includes('the same ref=, ref prefix') && fixableErrors(synthetic).map(f => f.rule).join() === 'no_ground', fb.split('\n')[1])

// E11. SYSTEM_PROMPT SECTION 1 (read as text, like run_checks check_templates) carries the wiring and LED rules,
//      CTRL on a net of its own (2026-11-03 takes 1 and 3: the blinker made CTRL's 10nF and still wired
//      u1['CTRL'] += gnd) and every ref set with ref= (take 2: the Guide's C2 was the code's c2, which skidl had
//      numbered C3 by creation order)
const src = readFileSync('index.ts', 'utf8')
const section1 = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('═══ SECTION 2'))
const rules = { reset: section1.includes("u1['RESET'] += vcc") && /RESET → VCC/.test(section1),
                ctrl: /CTRL → a 10nF capacitor to GND/.test(section1),
                ctrlNet: section1.includes("u1['CTRL'] += ctrl"),
                refs: /Give every Part its reference with ref=/.test(section1) && /never create a Part inline/.test(section1),
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
try { await runSkidl(blink.replace("d1.value = 'RED'", 'd1.value = RED'), out, SKIDL_MS) } catch (e) { colourErr = errText(e) }
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

// E21. the prompt's ref= example holds in skidl: made before any C1, it keeps its ref; an unnamed part made first
//      takes C1 and pushes an explicit ref='C1' to C1_1 (why the prompt forbids a Part inside a += line)
const example = /^(\w+) = (Part\(tool=SKIDL, name='C', ref_prefix='C', )ref='(C\d+)', pins=\[\.\.\.\]\)/m.exec(section1)
const capPins = /- Capacitor: Part\(tool=SKIDL, name='C', ref_prefix='C', pins=(\[[^\r\n]*\])\)/.exec(section1)?.[1]
const refsOf = (lines: string[]) => {
  const code = ['from skidl import *', ...lines, "print(','.join(p.ref for p in default_circuit.parts))"].join('\n')
  try { return execFileSync('python', ['-c', code], { cwd: work, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim().split('\n').pop() } catch (e) { return errText(e).split('\n')[0] }
}
const given = example && capPins ? refsOf([`${example[1]} = ${example[2]}ref='${example[3]}', pins=${capPins})`, `c1 = ${example[2]}ref='C1', pins=${capPins})`]) : 'no example'
const unnamed = example && capPins ? refsOf([`${example[2]}pins=${capPins})`, `c1 = ${example[2]}ref='C1', pins=${capPins})`]) : 'no example'
check('E21 ref= in skidl', !!example && given === `${example[3]},C1` && unnamed === 'C1,C1_1',
  `example ${example?.[3]} then C1 -> ${given}; unnamed then C1 -> ${unnamed}`)

// E25. a netlist in graphToNetlist's shape (server/index.ts: an AI edit, a session reopened from the history) has no
//      pintype: a regulator's or bridge's output powers its net and two tied outputs conflict (2026-11-06: false
//      "no source" on 5V, conflicts never found). Only the pins the templates mark count, and a pintype the node has wins.
type GraphPin = [ref: string, pin: string, pintype?: string]
const graphNet = async (name: string, comps: [ref: string, part: string][], nets: [name: string, nodes: GraphPin[]][]) => {
  const path = join(work, `graph_${name}.net`)
  const compLines = comps.map(([ref, part]) => `    (comp (ref "${ref}") (value "${ref}")\n      (description "${part}")\n      (footprint "")\n      (libsource (lib "NO_LIB") (part "${part}"))\n    )`)
  const netLines = nets.map(([net, nodes], i) => `    (net (code ${i + 1}) (name "${net}")\n` +
    nodes.map(([ref, pin, type]) => `      (node (ref "${ref}") (pin "${pin}")${type ? ` (pintype "${type}")` : ''})`).join('\n') + '\n    )')
  writeFileSync(path, `(export (version "D")\n  (components\n${compLines.join('\n')}\n  )\n  (nets\n${netLines.join('\n')}\n  )\n)`)
  return erc(path)
}
const rulesOn = (r: ErcRun, rule: string) => (r.ok ? r.findings.filter(f => f.rule === rule).map(f => f.net) : [`did not run: ${r.reason}`])
const regParts: [string, string][] = [['BT1', 'Battery'], ['U1', 'REG'], ['R1', 'R'], ['D1', 'LED']]
const regRest: [string, GraphPin[]][] = [['VIN', [['BT1', '1'], ['U1', '3']]], ['GND', [['BT1', '2'], ['U1', '1'], ['D1', '2']]], ['LED_A', [['R1', '2'], ['D1', '1']]]]
const regOut = await graphNet('reg', regParts, [['5V', [['U1', '2'], ['R1', '1']]], ...regRest])
const regIn = await graphNet('reg_in', regParts, [['5V', [['U1', '3'], ['R1', '1']]], ...regRest])
const regTyped = await graphNet('reg_typed', regParts, [['5V', [['U1', '2', 'PASSIVE'], ['R1', '1']]], ...regRest])
const bridge = await graphNet('bridge', [['D1', 'Bridge'], ['R1', 'R']], [['+12V', [['D1', '3'], ['R1', '1']]], ['GND', [['D1', '4'], ['R1', '2']]]])
const timers: [string, string][] = [['U1', 'NE555'], ['U2', 'NE555'], ['U3', 'OpAmp'], ['R1', 'R']]
const tied = await graphNet('tied', timers, [['OUT', [['U1', '3'], ['U2', '3'], ['U3', '3'], ['R1', '1']]], ['GND', [['U1', '1'], ['R1', '2']]]])
const oneOut = await graphNet('one_out', timers, [['OUT', [['U1', '3'], ['U2', '2'], ['U3', '1'], ['R1', '1']]], ['GND', [['U1', '1'], ['R1', '2']]]])
const conflict = tied.ok ? tied.findings.find(f => f.rule === 'output_conflict') : undefined
check('E25 graph netlist: sources and outputs by template', rulesOn(regOut, 'unpowered_rail').length === 0 && rulesOn(bridge, 'unpowered_rail').length === 0
  && rulesOn(regIn, 'unpowered_rail').join() === '5V' && rulesOn(regTyped, 'unpowered_rail').join() === '5V'
  && conflict?.net === 'OUT' && conflict.refs.map(r => r.ref).join() === 'U1,U2,U3' && rulesOn(oneOut, 'output_conflict').length === 0,
  `reg=[${rulesOn(regOut, 'unpowered_rail')}] bridge=[${rulesOn(bridge, 'unpowered_rail')}] reg IN=[${rulesOn(regIn, 'unpowered_rail')}] typed=[${rulesOn(regTyped, 'unpowered_rail')}]` +
  ` tied=[${conflict?.refs.map(r => r.ref)}] one=[${rulesOn(oneOut, 'output_conflict')}]`)

// E26. the same circuit finds the same with and without pintype: the demos, and the prompt's REG, Battery and NE555
//      templates run in skidl with a 5V rail fed only by the regulator and two 555 outputs tied together
const templateOf = (name: string) => new RegExp(`Part\\(tool=SKIDL, name='${name}', ref_prefix='\\w+', pins=\\[.*\\]\\)`).exec(section1)?.[0] ?? `missing_${name}`
const fromPrompt = [
  'from skidl import *',
  "vin, rail, gnd, led_a, out = Net('VIN'), Net('5V'), Net('GND'), Net('LED_A'), Net('OUT')",
  `bt1 = ${templateOf('Battery')}`, `u1 = ${templateOf('REG')}`, `u2 = ${templateOf('NE555')}`, `u3 = ${templateOf('NE555')}`,
  `r1 = ${templateOf('R')}`, `d1 = ${templateOf('LED')}`,
  "bt1['+'] += vin", "bt1['-'] += gnd", "u1['IN'] += vin", "u1['OUT'] += rail", "u1['GND'] += gnd",
  "r1['p1'] += rail", "r1['p2'] += led_a", "d1['A'] += led_a", "d1['K'] += gnd",
  "u2['OUT'] += out", "u3['OUT'] += out", "u2['GND'] += gnd", "u3['GND'] += gnd", "u2['VCC'] += rail", "u3['VCC'] += rail",
  'generate_netlist()', '',
].join('\n')
const noPintype = (text: string) => text.replace(/\s*\(pintype "[^"]*"\)/g, '')
const sameBoth: string[] = []
let withConflict = 0
let unbypassed = ''
for (const [name, code] of [...['led_basic', 'ne555_blink', 'npn_relay', 'nmos_motor', 'bridge_supply'].map(c => [c, readFileSync(join('test_circuits', `${c}.py`), 'utf8')]), ['from_prompt', fromPrompt]]) {
  const net = await run(code)
  const stripped = join(work, `nopintype_${name}.net`)
  writeFileSync(stripped, noPintype(readFileSync(net, 'utf8')))
  const [a, b] = [await erc(net), await erc(stripped)]
  const same = a.ok && b.ok && !readFileSync(stripped, 'utf8').includes('pintype') && JSON.stringify(a.findings) === JSON.stringify(b.findings)
  if (!same) sameBoth.push(`${name}: ${a.ok ? a.findings.map(f => f.rule) : a.reason} / ${b.ok ? b.findings.map(f => f.rule) : b.reason}`)
  if (name === 'from_prompt' && a.ok) withConflict = a.findings.filter(f => f.rule === 'output_conflict').length
  // no capacitor anywhere: the regulator's IN and both 555s' VCC have none to ground, with pintype and without
  if (name === 'from_prompt' && a.ok && b.ok) {
    unbypassed = [a, b].map(r => r.findings.filter(f => f.rule === 'no_bypass').map(f => `${f.refs[0]?.ref}.${f.refs[0]?.sym ?? f.refs[0]?.pin}`).join(',')).join(' / ')
  }
}
check('E26 same findings with and without pintype; the prompt circuit with no capacitor has no_bypass on U1 IN, U2 and U3 VCC either way',
  !sameBoth.length && withConflict === 1 && unbypassed === 'U1.3,U2.8,U3.8 / U1.3,U2.8,U3.8',
  `differ=[${sameBoth.join(' | ')}] conflicts in the prompt circuit=${withConflict} no_bypass=${unbypassed}`)

// E27. erc.py PIN_TYPES against the templates (read as text, like E11): exactly the pins they mark PWROUT or OUTPUT, each
//      with the pin name PIN_NAMES gives that number and a pad in the (part, pin) table of both styles, or a documented
//      unmapped part. A renumbered template fails here instead of quietly making a pin a source.
const templates = [...section1.matchAll(/Part\(tool=SKIDL, name='(\w+)', ref_prefix='\w+', pins=\[(.*)\]\)/g)]
  .map(m => ({ part: m[1], pins: [...m[2].matchAll(/Pin\(num=(\d+),name='([^']+)',func=Pin\.types\.(\w+)\)/g)].map(p => ({ num: p[1], name: p[2], func: p[3] })) }))
const wantTypes = Object.fromEntries(templates.flatMap(t => {
  const marked = t.pins.filter(p => p.func === 'PWROUT' || p.func === 'OUTPUT')
  return marked.length ? [[t.part, Object.fromEntries(marked.map(p => [p.num, p.func === 'PWROUT' ? 'POWER-OUT' : 'OUTPUT']))]] : []
}))
const py = JSON.parse(execFileSync('python', ['-c', [
  'import json, sys', "sys.path.insert(0, 'pcb')", 'import erc, footprints_table as ft',
  'print(json.dumps({"types": erc.PIN_TYPES, "names": erc.PIN_NAMES, "unmapped": list(ft.KNOWN_UNMAPPED),',
  '  "pads": {f"{part}/{pin}/{style}": ft.TABLE.get((part, style), (0, 0, {}))[2].get(int(pin))',
  '           for part, pins in erc.PIN_TYPES.items() for pin in pins for style in ("smd", "tht")}}))',
].join('\n')], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()) as
  { types: Record<string, Record<string, string>>; names: Record<string, string[]>; unmapped: string[]; pads: Record<string, string | null> }
const canon = (o: Record<string, Record<string, string>>) => JSON.stringify(Object.entries(o).map(([k, v]) => [k, Object.entries(v).sort()]).sort())
const pinDrift = Object.entries(py.types).flatMap(([part, pins]) => Object.keys(pins).flatMap(num => {
  const name = templates.find(t => t.part === part)?.pins.find(p => p.num === num)?.name
  const named = py.names[part]?.[Number(num) - 1]
  const nameBad = py.names[part] && named !== name ? [`${part}.${num} named ${named}, template ${name}`] : []
  const padBad = !py.unmapped.includes(part) && (!py.pads[`${part}/${num}/smd`] || !py.pads[`${part}/${num}/tht`]) ? [`${part}.${num} has no pad`] : []
  return [...nameBad, ...padBad]
}))
check('E27 PIN_TYPES match the part templates', templates.length >= 15 && canon(py.types) === canon(wantTypes) && !pinDrift.length,
  `${templates.length} templates; erc.py=${canon(py.types)}; prompt=${canon(wantTypes)}; drift=[${pinDrift.join(' | ')}]`)

// E28. erc.py SUPPLY_PINS (the pins no_bypass wants a capacitor on) against the templates: exactly the pins they mark PWRIN,
//      less the ground pin. A renumbered template, or a new IC template, fails here instead of quietly going unchecked.
const wantSupply = Object.fromEntries(templates.flatMap(t => {
  const pins = t.pins.filter(p => p.func === 'PWRIN' && p.name !== 'GND').map(p => p.num)
  return pins.length ? [[t.part, pins]] : []
}))
let supply: Record<string, string[]> | string
try {
  supply = JSON.parse(execFileSync('python', ['-c', "import json, sys; sys.path.insert(0, 'pcb'); import erc; print(json.dumps(erc.SUPPLY_PINS))"],
    { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()) as Record<string, string[]>
} catch (e) { supply = errText(e).trim().split('\n').pop() ?? 'python failed' }
const canonPins = (o: Record<string, string[]>) => JSON.stringify(Object.entries(o).map(([k, v]) => [k, [...v].sort()]).sort())
check('E28 SUPPLY_PINS match the PWRIN pins of the templates, less GND',
  typeof supply !== 'string' && Object.keys(wantSupply).length >= 3 && canonPins(supply) === canonPins(wantSupply),
  `erc.py=${typeof supply === 'string' ? supply : canonPins(supply)}; prompt=${canonPins(wantSupply)}`)

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
try { await runSkidl(leakProbe, out, SKIDL_MS); e12 = 'child saw no secret and kept SF_CHECK_PLAIN' } catch (e) { e12 = `FAIL ${errText(e).trim().split('\n').pop()}` }
const filtered = Object.keys(planted).filter(k => k in env)
check('E12 secrets stripped from the skidl env', !e12.startsWith('FAIL') && filtered.join() === 'SF_CHECK_PLAIN'
  && !!(env.PATH || env.Path) && (process.platform !== 'win32' || !!env.SYSTEMROOT || !!env.SystemRoot),
  `${e12}; childEnv keeps [${filtered.join(', ')}] of the planted names`)
for (const k of Object.keys(planted)) delete process.env[k]

// E13. the temp folder is removed after a run that works, one that fails and one that times out
const cwdOf = (marker: string) => (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '')
const mOk = join(work, 'cwd_ok.txt'), mFail = join(work, 'cwd_fail.txt'), mSlow = join(work, 'cwd_slow.txt')
let okRun = false, failRun = false, slowRun = ''
try { await runSkidl(withPrelude(blink, recordCwd(mOk)), out, SKIDL_MS); okRun = true } catch { /* reported below */ }
try { await runSkidl(withPrelude(blink, recordCwd(mFail) + "sys.exit('stop here')\n"), out, SKIDL_MS) } catch (e) { failRun = /stop here/.test(errText(e)) }
try { await runSkidl(recordCwd(mSlow) + 'time.sleep(30)\n', out, 2500) } catch (e) { slowRun = errText(e) }
const dirs = [cwdOf(mOk), cwdOf(mFail), cwdOf(mSlow)]
const left: string[] = []
for (const d of dirs) if (!d || !(await gone(d))) left.push(d || '(no folder recorded)')
check('E13 temp folder removed (ok / error / timeout)', okRun && failRun && /timed out/.test(slowRun) && !left.length,
  `ran=${okRun} error=${failRun} timeout="${slowRun}" left=[${left.join(', ')}]`)

// E22. what the code prints goes nowhere: 1 MB on stdout filled a pipe nobody read, and a circuit that works was
//      reported as timed out after 90 s (review of 2026-11-06). The time limit is its own, far above a normal run
const chatty = withPrelude(blink, "import sys\nsys.stdout.write('x' * (1 << 20)); sys.stdout.flush()\n")
let e22 = ''
try { await runSkidl(chatty, out, SKIDL_MS); e22 = 'netlist written' } catch (e) { e22 = `FAIL ${errText(e).trim().split('\n').pop()}` }
check('E22 1 MB on stdout does not stall the code', e22 === 'netlist written', e22)

// E23. stderr is kept to its last 64 KB. Without a limit, code that writes to it forever took the whole server down in
//      about 2 s (RangeError: Invalid string length in the data handler, 800 MB); and the Code tab reads the line
//      number out of the traceback's end, so that end stays
let tail = ''
try { await runSkidl(withPrelude(blink, "import sys\nsys.stderr.write('x' * (1 << 20) + '\\n'); sys.stderr.flush()\nraise NameError('the last line')\n"), out, SKIDL_MS) } catch (e) { tail = errText(e) }
const rss0 = process.memoryUsage().rss
let flood = ''
try { await runSkidl("import sys\nwhile True: sys.stderr.write('x' * 65536)\n", out, 4000) } catch (e) { flood = errText(e) }
const grew = Math.round((process.memoryUsage().rss - rss0) / 1048576)
check('E23 stderr capped, its end kept', /NameError: the last line/.test(tail) && tail.length <= STDERR_KEPT && /timed out/.test(flood) && grew < 300,
  `traceback end kept=${/NameError: the last line/.test(tail)} ${tail.length} chars; endless stderr: "${flood.slice(0, 60)}", RSS +${grew} MB`)

// E24. the same floating NPN base is pad 1 on an SMD board and pad 2 on a through-hole one, and /erc_graph (read as text)
//      checks with the style it is sent: it always ran SMD, so a THT board's finding named the wrong pad (review of 2026-11-06)
const relay = readFileSync(join('test_circuits', 'npn_relay.py'), 'utf8')
const noBase = relay.replace(/^q1\['B'\] \+= base\r?\n/m, '')
const noBaseNet = await run(noBase)
const baseOf = (r: ErcRun) => (r.ok ? r.findings.flatMap(f => f.refs).find(x => x.ref === 'Q1') : undefined)
const smdBase = baseOf(await runErc(noBaseNet, cwd, ERC_MS, 'smd')), thtBase = baseOf(await runErc(noBaseNet, cwd, ERC_MS, 'tht'))
const ercRoute = src.slice(src.indexOf("app.post('/erc_graph'"), src.indexOf('// ── GET /download/:filename'))
check('E24 pad numbers by board style', noBase !== relay && smdBase?.pin === '1' && thtBase?.pin === '2' && smdBase?.sym === '1' && thtBase?.sym === '1'
  && /runErc\(netPath, process\.cwd\(\), undefined, pcbStyle\(style\)\)/.test(ercRoute),
  `smd ${JSON.stringify(smdBase)} tht ${JSON.stringify(thtBase)} route passes the style: ${/pcbStyle\(style\)/.test(ercRoute)}`)

try { rmSync(work, { recursive: true, force: true }) } catch { /* leave it */ }
console.log(ok ? '\nALL PASS' : '\nSOME CHECKS FAILED')
process.exit(ok ? 0 : 1)
