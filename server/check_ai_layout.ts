// Stage-4 checks 25-37: what the model is told and how a proposal is judged, without a model or server.
// Uses the NE555 board from test_circuits (generated into a temp dir).
// Usage (from server/): npx tsx check_ai_layout.ts   — exit 0 only if all pass
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { better, decouplingPairs, describeBoard, heavyPowerNets, metricsOf, parseOhms, precheck, type Overrides } from './ai_layout'

const work = mkdtempSync(join(tmpdir(), 'sf_ailayout_'))
copyFileSync(join('test_circuits', 'ne555_blink.py'), join(work, 'ne555_blink.py'))
execFileSync('python', ['ne555_blink.py'], { cwd: work })
execFileSync('python', [join(process.cwd(), 'pcb_generator.py'), join(work, 'ne555_blink.net'), join(work, 'b.kicad_pcb'), '--style', 'smd'],
  { cwd: process.cwd() })
const board = JSON.parse(readFileSync(join(work, 'b.board.json'), 'utf8'))
const base = (): Overrides => ({
  parts: Object.fromEntries(board.parts.map((p: { ref: string; x: number; y: number; rot: number }) => [p.ref, [p.x, p.y, p.rot]])),
  net_width: {},
})
const part = (ref: string) => board.parts.find((p: { ref: string }) => p.ref === ref)

let ok = true
const check = (name: string, pass: boolean, info: string) => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

// 25. decoupling capacitors are found: a two-pad C between a supply net and GND, measured to an IC pin on that supply
const pairs = decouplingPairs(board)
check('25 decoupling found', pairs.length >= 1 && pairs.every(d => d.ic.startsWith('U') && d.dist > 0),
  pairs.map(d => `${d.cap}/${d.net}->${d.ic}.${d.pin} ${d.dist} mm`).join(', '))

// 26. the prompt carries courtyards, nearest-neighbour gaps and the decoupling distance
const prompt = describeBoard(board, metricsOf({}, 0, board), [])
check('26 prompt has geometry', /keep-out .* mm\), nearest \w+ gap/.test(prompt) && /Decoupling capacitors \(/.test(prompt)
  && /decoupling distance total/.test(prompt), `${prompt.split('\n').length} lines`)

// 27. precheck rejects a move onto another part and a move off the board, and accepts no-op
const cap = pairs[0].cap
const victim = board.parts.find((p: { ref: string; keepout?: number[] }) => p.ref !== cap && p.keepout)
const onTop = base(); onTop.parts[cap] = [victim.x, victim.y, part(cap).rot]
const offBoard = base(); offBoard.parts[cap] = [part(cap).x + 60, part(cap).y, part(cap).rot]
const p1 = precheck(board, onTop), p2 = precheck(board, offBoard), p3 = precheck(board, base())
check('27 precheck', p1.some(s => s.includes('overlap')) && p2.some(s => s.includes('outline')) && p3.length === 0,
  `onTop=[${p1.join('; ')}] offBoard=[${p2.join('; ')}] none=${p3.length}`)

// 27b. the move gpt-5.4-mini actually proposed on 2026-09-15 (C3 +5.5, -2.5 mm), which broke routing, is caught
const real = base(); const c3 = part('C3')
if (c3) real.parts.C3 = [c3.x + 5.5, c3.y - 2.5, c3.rot]
const p5 = c3 ? precheck(board, real) : []
check('27b real rolled-back move caught', !!c3 && p5.some(s => s.startsWith('C3 would overlap')), `[${p5.join('; ')}]`)

// 28. a 90-degree rotation is checked with the turned courtyard (a square-ish part may pass, a long part near a neighbour may not)
const turned = base(); const u = board.parts.find((p: { ref: string }) => p.ref.startsWith('U'))
turned.parts[u.ref] = [u.x, u.y, (u.rot + 90) % 360]
const p4 = precheck(board, turned)
check('28 rotation precheck runs', Array.isArray(p4), `U rotate 90: [${p4.join('; ') || 'no collision'}]`)

// 29. with everything else equal, a shorter decoupling distance wins; a DRC error still outranks it
const m = metricsOf({ hpwl: 80, vias: 5, track_length: 90 }, 0, board)
const closer = { ...m, decap: Math.max(0, m.decap - 2), hpwl: m.hpwl + 3 }
const closerButDrc = { ...closer, drcErrors: 1 }
check('29 score order', better(closer, m) && !better(closerButDrc, m) && !better(m, m),
  `decap ${m.decap} -> ${closer.decap} with HPWL +3 kept; with a DRC error rejected`)

// 29b. the trade gpt-5.4-mini got kept on 2026-09-15 (decap -0.68 mm for HPWL +6.1 mm and one more via)
//      is no longer an improvement; a sub-step decap change falls through to wire length.
const tiny = { ...m, decap: m.decap - 0.68, hpwl: m.hpwl + 6.1, vias: m.vias + 1 }
const tinyShorter = { ...m, decap: m.decap - 0.03, hpwl: m.hpwl - 0.12 }
check('29b small decap gain cannot buy wire length', !better(tiny, m) && better(tinyShorter, m),
  'decap -0.68/HPWL +6.1 rejected, decap -0.03/HPWL -0.12 kept on HPWL')

// 30. precheck agrees with the generator's own overlap check (pcb/board.py, fixed placement, no routing)
//     on a grid of C3 moves, including the two the model proposed that precheck used to let through.
const moves: [number, number][] = [[2, -0.5], [2, 0.5], [2.5, -2.5], [5.5, -2.5], [-1, 0], [0, 1.5], [1, -1], [0, -3]]
const py = `
import json, sys
sys.path.insert(0, 'pcb')
from board import generate
net, work, c3, moves = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4])
base = json.load(open(work + '/b.board.json', encoding='utf-8'))
out = []
for dx, dy in moves:
    ov = {'parts': {p['ref']: [p['x'], p['y'], p['rot']] for p in base['parts']}, 'net_width': {}}
    ov['parts']['C3'] = [c3[0] + dx, c3[1] + dy, c3[2]]
    s = generate(net, work + '/m.kicad_pcb', 'smd', placer='fixed', overrides=ov, route=False)
    out.append([pair for pair in s['overlaps'] if 'C3' in pair])
print(json.dumps(out))
`
if (c3) {
  const gen = JSON.parse(execFileSync('python', ['-c', py, join(work, 'ne555_blink.net'), work,
    JSON.stringify([c3.x, c3.y, c3.rot]), JSON.stringify(moves)], { cwd: process.cwd() }).toString().trim().split('\n').pop()!)
  const rows = moves.map(([dx, dy], i) => {
    const ov = base(); ov.parts.C3 = [c3.x + dx, c3.y + dy, c3.rot]
    const pre = precheck(board, ov).filter(s => s.includes('overlap')).length > 0
    return { move: `${dx},${dy}`, generator: gen[i].length > 0, precheck: pre }
  })
  const agree = rows.every(r => r.generator === r.precheck)
  check('30 precheck = generator overlaps', agree,
    rows.map(r => `${r.move}:${r.generator ? 'G' : '-'}${r.precheck ? 'P' : '-'}`).join(' '))
}

// 31-33. heavy power nets on the relay board. +5V carries K1's coil current directly; GND carries it back
//        through Q1, which switches COIL_LOW. Both start at the router's default 0.5 mm. Widening only +5V
//        clears one, widening both clears both, each step is judged better, and the widened board still
//        passes KiCad DRC. NE555 has no heavy nets.
copyFileSync(join('test_circuits', 'npn_relay.py'), join(work, 'npn_relay.py'))
execFileSync('python', ['npn_relay.py'], { cwd: work })
const relayPy = `
import json, sys
sys.path.insert(0, 'pcb')
from board import generate
net, work = sys.argv[1], sys.argv[2]
a = generate(net, work + '/r1.kicad_pcb', 'smd')
ja = json.load(open(work + '/r1.board.json', encoding='utf-8'))
pos = {p['ref']: [p['x'], p['y'], p['rot']] for p in ja['parts']}
b = generate(net, work + '/r2.kicad_pcb', 'smd', placer='fixed', overrides={'parts': pos, 'net_width': {'+5V': 0.8}})
c = generate(net, work + '/r3.kicad_pcb', 'smd', placer='fixed', overrides={'parts': pos, 'net_width': {'+5V': 0.8, 'GND': 0.8}})
print(json.dumps([a, b, c], default=str))
`
const [sa, sb, sc] = JSON.parse(execFileSync('python', ['-c', relayPy, join(work, 'npn_relay.net'), work], { cwd: process.cwd() })
  .toString().trim().split('\n').pop()!)
const rb = (n: string) => JSON.parse(readFileSync(join(work, `${n}.board.json`), 'utf8'))
const r1 = rb('r1'), r2 = rb('r2'), r3 = rb('r3')
const heavy1 = heavyPowerNets(r1)
const m1 = metricsOf(sa, 0, r1), m2 = metricsOf(sb, 0, r2), m3 = metricsOf(sc, 0, r3)
const plus5 = heavy1.find(h => h.net === '+5V'), gnd = heavy1.find(h => h.net === 'GND')
check('31 relay +5V and GND found', !!plus5 && plus5.parts.includes('K1') && plus5.width === 0.5
  && !!gnd && gnd.parts.some(x => x.startsWith('Q1')) && gnd.width === 0.5 && m1.powerWidth === 2,
  heavy1.map(h => `${h.net}(${h.parts.join('; ')}) ${h.width} mm`).join(', ') + ` -> powerWidth ${m1.powerWidth}`)
check('32 each widening judged better', m2.powerWidth === 1 && m3.powerWidth === 0 && m3.unrouted === 0
  && better(m2, m1) && better(m3, m2) && heavyPowerNets(board).length === 0,
  `powerWidth ${m1.powerWidth} -> ${m2.powerWidth} (+5V) -> ${m3.powerWidth} (+5V, GND); unrouted ${m3.unrouted}; ne555 heavy=${heavyPowerNets(board).length}`)
const kicad = join(process.env.LOCALAPPDATA || '', 'Programs', 'KiCad', '10.0', 'bin', 'kicad-cli.exe')
let drcInfo = 'kicad-cli not found'
let drcOk = false
try {
  execFileSync(kicad, ['pcb', 'drc', '--format', 'json', '--severity-all', '--output', join(work, 'r3.drc.json'), join(work, 'r3.kicad_pcb')])
  const d = JSON.parse(readFileSync(join(work, 'r3.drc.json'), 'utf8'))
  const errors = (d.violations || []).filter((v: { severity: string }) => v.severity === 'error')
  drcOk = errors.length === 0 && (d.unconnected_items || []).length === 0
  drcInfo = `errors ${errors.length}, unconnected ${(d.unconnected_items || []).length}`
} catch (e) { drcInfo = String(e).slice(0, 120) }
check('33 widened relay board passes DRC', drcOk, drcInfo)

// 34-37. multi-step current paths on the MOSFET motor board (test_circuits/nmos_motor.py):
//        +12V -> J2 MOTOR -> MOT_LOW -> Q1 drain-source -> SENSE -> R2 0.1 ohm -> GND.
copyFileSync(join('test_circuits', 'nmos_motor.py'), join(work, 'nmos_motor.py'))
execFileSync('python', ['nmos_motor.py'], { cwd: work })
const motorPy = `
import json, sys
sys.path.insert(0, 'pcb')
from board import generate
net, work = sys.argv[1], sys.argv[2]
a = generate(net, work + '/m1.kicad_pcb', 'smd')
ja = json.load(open(work + '/m1.board.json', encoding='utf-8'))
pos = {p['ref']: [p['x'], p['y'], p['rot']] for p in ja['parts']}
b = generate(net, work + '/m2.kicad_pcb', 'smd', placer='fixed', overrides={'parts': pos, 'net_width': {'+12V': 0.8, 'GND': 0.8}})
print(json.dumps([a, b], default=str))
`
const [ma, mb] = JSON.parse(execFileSync('python', ['-c', motorPy, join(work, 'nmos_motor.net'), work], { cwd: process.cwd() })
  .toString().trim().split('\n').pop()!)
const mot1 = rb('m1'), mot2 = rb('m2')
const mh = heavyPowerNets(mot1)
const mm1 = metricsOf(ma, 0, mot1), mm2 = metricsOf(mb, 0, mot2)
const label = (net: string) => mh.find(h => h.net === net)?.parts.join('; ') || ''
check('34 motor path through Q1 channel and shunt', label('+12V').includes('J2') && label('GND').includes('Q1 > R2 for J2')
  && !mh.some(h => ['PWM', 'GATE', 'SENSE', 'MOT_LOW'].includes(h.net)) && mm1.powerWidth === 2 && !!mot1.parts[0].pad_pins,
  mh.map(h => `${h.net}(${h.parts.join('; ')}) ${h.width} mm`).join(', ') + ` -> powerWidth ${mm1.powerWidth}`)

// 35. what must NOT count: a 10 ohm R2 is not a shunt (path stops, GND only via the 10k gate pull-down which
//     is not followed), and without pad_pins (older boards) the gate is not trusted but the result is the same
const clone = () => JSON.parse(JSON.stringify(mot1))
const noShunt = clone(); noShunt.parts.find((p: { ref: string }) => p.ref === 'R2').value = '10'
const noPins = clone(); noPins.parts.forEach((p: { pad_pins?: unknown }) => { delete p.pad_pins })
const hNoShunt = heavyPowerNets(noShunt).map(h => h.net), hNoPins = heavyPowerNets(noPins).map(h => h.net)
check('35 decoys ignored', !hNoShunt.includes('GND') && hNoShunt.includes('+12V') && hNoPins.includes('GND')
  && parseOhms('0.1') === 0.1 && parseOhms('R10') === 0.1 && parseOhms('0R1') === 0.1 && parseOhms('100m') === 0.1
  && parseOhms('10k') === 10000 && Number.isNaN(parseOhms('100nF')),
  `R2=10 ohm -> [${hNoShunt}]; no pad_pins -> [${hNoPins}]; parseOhms ok`)

// 36. widening both clears the count, is judged better, and the board passes KiCad DRC
let motorDrc = 'not run'
let motorDrcOk = false
try {
  execFileSync(kicad, ['pcb', 'drc', '--format', 'json', '--severity-all', '--output', join(work, 'm2.drc.json'), join(work, 'm2.kicad_pcb')])
  const d = JSON.parse(readFileSync(join(work, 'm2.drc.json'), 'utf8'))
  const errors = (d.violations || []).filter((v: { severity: string }) => v.severity === 'error')
  motorDrcOk = errors.length === 0 && (d.unconnected_items || []).length === 0
  motorDrc = `errors ${errors.length}, unconnected ${(d.unconnected_items || []).length}`
} catch (e) { motorDrc = String(e).slice(0, 120) }
check('36 motor widening kept, DRC clean', mm2.powerWidth === 0 && mm2.unrouted === 0 && better(mm2, mm1) && motorDrcOk,
  `powerWidth ${mm1.powerWidth} -> ${mm2.powerWidth}, unrouted ${mm2.unrouted}, DRC ${motorDrc}`)

// 37. driver IC by name (no footprint for one yet, so a synthetic board): DRV8833 motor supply VM and GND count,
//     the outputs to the motor connector do not
const drv = {
  outline: [0, 0, 30, 30], nets: ['VM', 'GND', 'AOUT1', 'AOUT2', 'AIN1'],
  parts: [
    { ref: 'U1', value: 'DRV8833', part: 'DRV8833', x: 10, y: 10, rot: 0,
      pads: [{ num: '1', net: 'VM' }, { num: '2', net: 'GND' }, { num: '3', net: 'AOUT1' }, { num: '4', net: 'AOUT2' }, { num: '5', net: 'AIN1' }] },
    { ref: 'J1', value: 'MOTOR_A', part: 'Conn_01x02', x: 20, y: 10, rot: 0, pads: [{ num: '1', net: 'AOUT1' }, { num: '2', net: 'AOUT2' }] },
  ],
  tracks: [{ net: 'VM', width: 0.5 }, { net: 'GND', width: 0.8 }, { net: 'AOUT1', width: 0.25 }],
}
const hd = heavyPowerNets(drv as never)
check('37 driver IC supply', hd.some(h => h.net === 'VM' && h.parts.includes('U1')) && hd.some(h => h.net === 'GND')
  && !hd.some(h => h.net.startsWith('AOUT') || h.net === 'AIN1') && metricsOf({}, 0, drv as never).powerWidth === 1,
  hd.map(h => `${h.net}(${h.parts.join('; ')}) ${h.width} mm`).join(', '))

console.log(ok ? 'ALL PASS' : 'SOME CHECKS FAILED')
process.exit(ok ? 0 : 1)
