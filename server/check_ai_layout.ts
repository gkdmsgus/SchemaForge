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

// 27b. the failure mode from the 2026-09-15 runs: the model slides a capacitor toward its IC and lands on a
//      neighbour (then C3 +5.5, -2.5 mm hit R3). Pinning the offset broke when the board grew, so aim at the
//      nearest part instead and require the move to be caught.
const c3 = part('C3')
const near = c3 && board.parts
  .filter((o: { ref: string; keepout?: number[] }) => o.ref !== 'C3' && o.keepout)
  .map((o: { ref: string; x: number; y: number }) => ({ o, d: Math.hypot(o.x - c3.x, o.y - c3.y) }))
  .sort((a: { d: number }, b: { d: number }) => a.d - b.d)[0]?.o
const real = base()
if (c3 && near) real.parts.C3 = [(c3.x + near.x) / 2, (c3.y + near.y) / 2, c3.rot]
const p5 = c3 && near ? precheck(board, real) : []
check('27b slide onto a neighbour caught', !!near && p5.some(s => s.startsWith('C3 would overlap')),
  `toward ${near?.ref}: [${p5.join('; ')}]`)

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
// fractions of the way to the nearest neighbour (collisions) plus small steps away from it (no collision),
// so the comparison always covers both answers whatever the board looks like
const toNear: [number, number] = near && c3 ? [near.x - c3.x, near.y - c3.y] : [3, 0]
const moves: [number, number][] = [0.5, 0.7, 0.85, 1].map(f => [toNear[0] * f, toNear[1] * f] as [number, number])
  .concat([[-toNear[0] * 0.2, -toNear[1] * 0.2], [0, -0.5], [0.5, 0], [-0.5, 0.5]])
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

// 31-33. load-current nets on the relay board. K1's coil current runs +5V -> K1 -> COIL_LOW -> Q1 C-E -> GND:
//        +5V and GND are [power], COIL_LOW is [path]; all start at the router defaults (0.5 / 0.25 mm).
//        Widening them one group at a time lowers the count and is judged better each step; the fully widened
//        board passes KiCad DRC. NE555 has none.
const kicad = join(process.env.LOCALAPPDATA || '', 'Programs', 'KiCad', '10.0', 'bin', 'kicad-cli.exe')
const drcOf = (pcb: string): { ok: boolean; info: string } => {
  try {
    execFileSync(kicad, ['pcb', 'drc', '--format', 'json', '--severity-all', '--output', pcb + '.drc.json', pcb])
    const d = JSON.parse(readFileSync(pcb + '.drc.json', 'utf8'))
    const errors = (d.violations || []).filter((v: { severity: string }) => v.severity === 'error')
    const unconnected = (d.unconnected_items || []).length
    return { ok: errors.length === 0 && unconnected === 0, info: `errors ${errors.length}, unconnected ${unconnected}` }
  } catch (e) { return { ok: false, info: String(e).slice(0, 120) } }
}
const rb = (n: string) => JSON.parse(readFileSync(join(work, `${n}.board.json`), 'utf8'))
const variants = (script: string, net: string, widths: Record<string, number>[]) => {
  const py = `
import json, sys
sys.path.insert(0, 'pcb')
from board import generate
net, work, prefix, widths = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
out = [generate(net, work + '/' + prefix + '0.kicad_pcb', 'smd')]
base = json.load(open(work + '/' + prefix + '0.board.json', encoding='utf-8'))
pos = {p['ref']: [p['x'], p['y'], p['rot']] for p in base['parts']}
for i, w in enumerate(widths, 1):
    out.append(generate(net, work + '/' + prefix + str(i) + '.kicad_pcb', 'smd', placer='fixed', overrides={'parts': pos, 'net_width': w}))
print(json.dumps(out, default=str))
`
  copyFileSync(join('test_circuits', script + '.py'), join(work, script + '.py'))
  execFileSync('python', [script + '.py'], { cwd: work })
  const sums = JSON.parse(execFileSync('python', ['-c', py, join(work, script + '.net'), work, net, JSON.stringify(widths)],
    { cwd: process.cwd() }).toString().trim().split('\n').pop()!)
  return sums.map((sm: Record<string, unknown>, i: number) => ({ board: rb(net + i), metrics: metricsOf(sm, 0, rb(net + i)), pcb: join(work, `${net}${i}.kicad_pcb`) }))
}
const show = (hs: ReturnType<typeof heavyPowerNets>) => hs.map(h => `${h.net}[${h.kind}](${h.parts.join('; ')}) ${h.width}`).join(', ')

const relayWide = { '+5V': 0.8, GND: 0.8, COIL_LOW: 0.8 }
const relay = variants('npn_relay', 'r', [{ '+5V': 0.8 }, { '+5V': 0.8, GND: 0.8 }, relayWide,
  { ...relayWide, COM: 0.8, NO: 0.8, NC: 0.8 }])
const rh = heavyPowerNets(relay[0].board)
const kindOf = (hs: ReturnType<typeof heavyPowerNets>, net: string) => hs.find(h => h.net === net)?.kind
// the coil side (+5V, COIL_LOW, GND) and the switched side (COM, NO, NC) both carry load current;
// the control signals (IN, BASE) do not
check('31 relay load-current nets', kindOf(rh, '+5V') === 'power' && kindOf(rh, 'GND') === 'power'
  && kindOf(rh, 'COIL_LOW') === 'path' && ['COM', 'NO', 'NC'].every(n => kindOf(rh, n) === 'path')
  && !!rh.find(h => h.net === 'COM')?.parts.join().includes('K1 contact')
  && !rh.some(h => ['IN', 'BASE'].includes(h.net)) && relay[0].metrics.powerWidth === 6,
  `${show(rh)} -> ${relay[0].metrics.powerWidth}`)
const counts = relay.map((v: { metrics: { powerWidth: number } }) => v.metrics.powerWidth)
check('32 each widening judged better', counts.join() === '6,5,4,3,0' && relay[4].metrics.unrouted === 0
  && [1, 2, 3, 4].every(i => better(relay[i].metrics, relay[i - 1].metrics)) && heavyPowerNets(board).length === 0,
  `powerWidth ${counts.join(' -> ')}; unrouted ${relay[4].metrics.unrouted}; ne555 heavy=${heavyPowerNets(board).length}`)
const relayDrc = drcOf(relay[4].pcb)
check('33 widened relay board passes DRC', relayDrc.ok, relayDrc.info)

// 34-37. multi-step current path on the MOSFET motor board (test_circuits/nmos_motor.py):
//        +12V -> J2 MOTOR -> MOT_LOW -> Q1 drain-source -> SENSE -> R2 0.1 ohm -> GND.
const motor = variants('nmos_motor', 'm', [{ '+12V': 0.8, GND: 0.8, MOT_LOW: 0.8, SENSE: 0.8 }])
const mot1 = motor[0].board
const mh = heavyPowerNets(mot1)
const label = (net: string) => mh.find(h => h.net === net)?.parts.join('; ') || ''
check('34 motor path through Q1 channel and shunt', kindOf(mh, '+12V') === 'power' && label('+12V').includes('J2')
  && kindOf(mh, 'GND') === 'power' && label('GND').includes('Q1 > R2 for J2')
  && kindOf(mh, 'MOT_LOW') === 'path' && kindOf(mh, 'SENSE') === 'path'
  && !mh.some(h => ['PWM', 'GATE'].includes(h.net)) && motor[0].metrics.powerWidth === 4 && !!mot1.parts[0].pad_pins,
  `${show(mh)} -> ${motor[0].metrics.powerWidth}`)

// 35. what must NOT count: with a 10 ohm R2 (not a shunt) the path stops at SENSE and GND is not reached — the
//     10k gate pull-down to GND is never followed; without pad_pins (older boards) GND is still reached but the
//     gate net, reachable through a transistor of unknown pin roles, is not counted
const clone = () => JSON.parse(JSON.stringify(mot1))
const noShunt = clone(); noShunt.parts.find((p: { ref: string }) => p.ref === 'R2').value = '10'
const noPins = clone(); noPins.parts.forEach((p: { pad_pins?: unknown }) => { delete p.pad_pins })
const hNoShunt = heavyPowerNets(noShunt).map(h => h.net).sort(), hNoPins = heavyPowerNets(noPins).map(h => h.net).sort()
check('35 decoys ignored', !hNoShunt.includes('GND') && hNoShunt.includes('+12V') && !hNoShunt.includes('GATE')
  && hNoPins.includes('GND') && !hNoPins.includes('GATE')
  && parseOhms('0.1') === 0.1 && parseOhms('R10') === 0.1 && parseOhms('0R1') === 0.1 && parseOhms('100m') === 0.1
  && parseOhms('10k') === 10000 && Number.isNaN(parseOhms('100nF')),
  `R2=10 ohm -> [${hNoShunt}]; no pad_pins -> [${hNoPins}]; parseOhms ok`)

// 36. widening all four clears the count, is judged better, and the board passes KiCad DRC
const motorDrc = drcOf(motor[1].pcb)
check('36 motor widening kept, DRC clean', motor[1].metrics.powerWidth === 0 && motor[1].metrics.unrouted === 0
  && better(motor[1].metrics, motor[0].metrics) && motorDrc.ok,
  `powerWidth ${motor[0].metrics.powerWidth} -> ${motor[1].metrics.powerWidth}, unrouted ${motor[1].metrics.unrouted}, DRC ${motorDrc.info}`)

// 37. driver IC by name (no footprint for one yet, so a synthetic board): DRV8833 supply VM and GND are [power],
//     the outputs to the MOTOR connector are [path], the logic input AIN1 is not counted
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
check('37 driver IC supply and outputs', kindOf(hd, 'VM') === 'power' && kindOf(hd, 'GND') === 'power'
  && kindOf(hd, 'AOUT1') === 'path' && kindOf(hd, 'AOUT2') === 'path' && !hd.some(h => h.net === 'AIN1')
  && metricsOf({}, 0, drv as never).powerWidth === 2,
  `${show(hd)} -> ${metricsOf({}, 0, drv as never).powerWidth}`)

console.log(ok ? 'ALL PASS' : 'SOME CHECKS FAILED')
process.exit(ok ? 0 : 1)
