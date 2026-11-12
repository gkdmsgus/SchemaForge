/**
 * Checks for the operating check ("does this circuit actually work?", src/lib/operatingCheck.ts).
 *
 * Run: npx tsx scripts/check_operating.ts
 * Good/bad circuit pairs that differ by one fault, hand-calculated numbers, the parts table,
 * schematic vs board agreement on real boards in server/outputs, and the demo circuits in
 * server/test_circuits (run through skidl). Exit code 0 only if every check passes.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  fromBoard, fromGraph, operatingChecks, operatingHeadline, parseFarads, parseOhms, parseVolts, voltsFromName,
  type OpResult, type OpRule, type OpState,
} from '../src/lib/operatingCheck.ts'
import { validateCircuit } from '../src/lib/circuitValidation.ts'
import { PIN_NAMES } from '../src/lib/humanReview.ts'
import { SPECS } from '../src/lib/partSpecs.ts'
import type { BoardModel, NetGraph } from '../src/types.ts'
import { parseNetlist } from '../server/netlist.ts'

let failed = 0
function check(name: string, ok: boolean, info = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`)
}

// ── tiny circuit builder: components [ref, template, value], nets [name, 'R1.1', ...] ──
type Comp = [string, string, string]
function circuit(comps: Comp[], nets: [string, ...string[]][]): NetGraph {
  return {
    components: comps.map(([ref, name, value]) => ({ ref, name, value })),
    nets: nets.map(([name, ...nodes]) => ({ name, nodes: nodes.map(n => ({ ref: n.split('.')[0], pin: n.split('.')[1] })) })),
  }
}
/** every result the synthetic circuits produce, checked as a whole at the end (O14) */
const ALL: OpResult[] = []
const run = (g: NetGraph, style: 'smd' | 'tht' | null = null) => { const rs = operatingChecks(fromGraph(g, style)); ALL.push(...rs); return rs }
const pick = (rs: OpResult[], rule: OpRule, ref?: string) => rs.find(r => r.rule === rule && (!ref || r.ref === ref))
const is = (rs: OpResult[], rule: OpRule, state: OpState, ref?: string, text?: RegExp) => {
  const r = pick(rs, rule, ref)
  return !!r && r.state === state && (!text || text.test(r.summary))
}
const show = (rs: OpResult[], rule: OpRule, ref?: string) => {
  const r = pick(rs, rule, ref)
  return r ? `${r.state}: ${r.summary}` : `(no ${rule} result)`
}
/** two circuits that differ only in what `mutate` changes */
const variant = (g: NetGraph, mutate: (c: NetGraph) => void): NetGraph => { const c = structuredClone(g); mutate(c); return c }
const setValue = (ref: string, value: string) => (c: NetGraph) => { c.components.find(x => x.ref === ref)!.value = value }
/** move one pin ('U1.4') to another net, creating the net if needed */
const movePin = (pin: string, to: string) => (c: NetGraph) => {
  const [ref, num] = pin.split('.')
  c.nets.forEach(n => { n.nodes = n.nodes.filter(x => !(x.ref === ref && String(x.pin) === num)) })
  const net = c.nets.find(n => n.name === to) ?? (c.nets.push({ name: to, nodes: [] }), c.nets[c.nets.length - 1])
  net.nodes.push({ ref, pin: num })
}
/** the same circuit with its parts, nets and pins listed in reverse */
const reversed = (g: NetGraph): NetGraph => ({ components: [...g.components].reverse(), nets: [...g.nets].reverse().map(n => ({ ...n, nodes: [...n.nodes].reverse() })) })
const full = (rs: OpResult[]) => rs.map(r => `${r.rule}/${r.ref}/${r.state}/${r.summary}`).sort().join('\n')
const near = (a: number | null, b: number | null) => (a == null || b == null ? a === b : Math.abs(a - b) <= Math.abs(b) * 1e-9)

// O1. reading values ────────────────────────────────────────────────────────────
{
  const ohms: [string, number | null][] = [['680', 680], ['10k', 1e4], ['4k7', 4700], ['4.7k', 4700], ['1M', 1e6], ['100R', 100], ['0R1', 0.1], ['10 Ω', 10], ['0.1', 0.1], ['abc', null], ['100m', 0.1], ['100mΩ', 0.1],
    ['R10', 0.1], ['R47', 0.47], ['r10', 0.1], ['100mR', 0.1], ['10mR', 0.01], ['1R0', 1], ['2M2', 2.2e6], ['R', null], ['m', null], ['k10', null]]
  const farads: [string, number | null][] = [['100nF', 1e-7], ['10uF', 1e-5], ['0.1uF', 1e-7], ['22p', 2.2e-11], ['1u', 1e-6], ['104', null], ['22μF', 2.2e-5], ['10', null],
    ['4u7', 4.7e-6], ['4n7', 4.7e-9], ['2n2', 2.2e-9], ['1u0', 1e-6], ['2p2', 2.2e-12], ['4μ7', 4.7e-6], ['4u7F', 4.7e-6], ['100MF', null], ['100M', null], ['4M7', null], ['100mF', 0.1], ['47uF', 4.7e-5], ['10NF', 1e-8], ['1UF', 1e-6], ['1n4148', null], ['2n7000', null]]
  const volts: [string, number | null][] = [['9V', 9], ['3.7 V', 3.7], ['3V3', 3.3], ['SRD-05VDC-SL-C', 5], ['12VDC', 12], ['RED', null], ['2x1.5V', 3], ['12V2A', 12]]
  const names: [string, number | null][] = [['GND', 0], ['+5V', 5], ['12V', 12], ['3V3', 3.3], ['+3.3V', 3.3], ['VCC', null], ['PWM', null]]
  const bad = [
    ...ohms.filter(([s, v]) => !near(parseOhms(s), v)).map(([s]) => `ohms ${s}`),
    ...farads.filter(([s, v]) => !near(parseFarads(s), v)).map(([s]) => `farads ${s}`),
    ...volts.filter(([s, v]) => !near(parseVolts(s), v)).map(([s]) => `volts ${s}`),
    ...names.filter(([s, v]) => !near(voltsFromName(s), v)).map(([s]) => `net ${s}`),
  ]
  check('O1 value parsers', bad.length === 0, bad.join(', '))
  // what those values decide (2026-11-06 sweep: R10 under an emitter read "이미터가 GND가 아닌 구성", a 555 with 4u7 "단위가
  // 필요합니다"). The same circuit with the value written either way gives the same verdicts
  const states = (rs: OpResult[]) => rs.map(r => `${r.rule}/${r.ref}/${r.state}`).sort().join(' ')
  const sensed = (value: string) => run(circuit(
    [['J1', 'Conn_01x03', 'PWR_IN'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '5V'], ['R2', 'R', value]],
    [['+5V', 'J1.1', 'K1.1', 'D1.2'], ['IN', 'J1.2', 'R1.1'], ['GND', 'J1.3', 'R2.2'], ['BASE', 'R1.2', 'Q1.1'], ['COIL_LOW', 'Q1.2', 'K1.2', 'D1.1'], ['SENSE', 'Q1.3', 'R2.1']]))
  const timed = (value: string) => run(circuit(
    [['BT1', 'Battery', '9V'], ['U1', 'NE555', 'NE555'], ['R1', 'R', '1k'], ['R2', 'R', '10k'], ['C1', 'C', value], ['C2', 'C', '100nF'], ['R3', 'R', '470'], ['D1', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'U1.8', 'U1.4', 'R1.1', 'C2.1'], ['GND', 'BT1.2', 'U1.1', 'C1.2', 'C2.2', 'D1.2'], ['DISCH', 'U1.7', 'R1.2', 'R2.1'], ['TH', 'U1.2', 'U1.6', 'R2.2', 'C1.1'], ['OUT', 'U1.3', 'R3.1'], ['A', 'R3.2', 'D1.1']]))
  check('O1b R10 and 0.1, 4u7 and 4.7uF give the same verdicts; 100MF is not read as 0.1 F',
    states(sensed('R10')) === states(sensed('0.1')) && !/GND가 아닌/.test(sensed('R10').map(r => r.summary).join())
    && states(timed('4u7')) === states(timed('4.7uF')) && pick(timed('4u7'), 'op_555')?.summary === pick(timed('4.7uF'), 'op_555')?.summary
    && is(timed('100MF'), 'op_555', 'unknown', 'U1', /단위가 필요합니다/),
    `${show(sensed('R10'), 'op_drive')} / ${show(timed('4u7'), 'op_555')} / ${show(timed('100MF'), 'op_555')}`)
  // an empty value reaches the netlist and the board as the reference (server/index.ts graphToNetlist), and R1 reads like
  // 0.1 Ω: on the finished board a resistor with no value read as 70 A through the LED and 490 W, not as no value
  const limited = (ref: string, value: string) => circuit([['BT1', 'Battery', '9V'], [ref, 'R', value], ['D1', 'LED', 'RED']],
    [['VCC', 'BT1.1', `${ref}.1`], ['A', `${ref}.2`, 'D1.1'], ['GND', 'D1.2', 'BT1.2']])
  const onBoard = (g: NetGraph) => operatingChecks(fromBoard({ style: null, parts: g.components.map(c => {
    const pads = g.nets.flatMap(n => n.nodes.filter(nd => nd.ref === c.ref).map(nd => ({ num: nd.pin, net: n.name })))
    return { ref: c.ref, part: c.name, value: c.value, pads, pad_pins: Object.fromEntries(pads.map(p => [p.num, Number(p.num)])) }
  }) } as unknown as BoardModel))
  const asWritten = limited('R1', 'R1'), asTenth = limited('R10', 'R10'), other = limited('R3', 'R10')
  check('O1c a resistor whose value is its own reference has no value, on the schematic and the board; R10 on another part is 0.1 Ω',
    states(onBoard(asWritten)) === states(run(limited('R1', ''))) && is(onBoard(asWritten), 'op_led', 'unknown', 'D1', /값/) && !pick(onBoard(asWritten), 'op_rpower')
    && is(run(asWritten), 'op_led', 'unknown', 'D1') && is(onBoard(asTenth), 'op_led', 'unknown', 'D1')
    && is(onBoard(other), 'op_led', 'error', 'D1', /R3 0\.1 Ω/) && is(run(other), 'op_led', 'error', 'D1', /R3 0\.1 Ω/),
    `${show(onBoard(asWritten), 'op_led')} / ${show(onBoard(asWritten), 'op_rpower')} / ${show(onBoard(other), 'op_led')}`)
}

// O2. parts table: every limit has a number and a source, nothing left as a placeholder ──
{
  const problems: string[] = []
  const walk = (o: unknown, at: string) => {
    if (o == null) return
    if (typeof o === 'object' && 'v' in (o as object) && 'src' in (o as object)) {
      const n = o as { v: number; src: string }
      if (!Number.isFinite(n.v)) problems.push(`${at} value`)
      if (!n.src || /PENDING|TODO/i.test(n.src)) problems.push(`${at} source`)
      return
    }
    if (typeof o === 'object') for (const [k, v] of Object.entries(o as object)) walk(v, `${at}.${k}`)
  }
  walk(SPECS, 'SPECS')
  if (/PENDING|TODO/.test(SPECS.timer.NE555.formula_src)) problems.push('555 formula source')
  check('O2 parts table has numbers and sources', problems.length === 0, problems.join(', ') || 'all limits sourced')
}

// O3. LED: good / bad pairs ─────────────────────────────────────────────────────
const led = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED']],
  [['VCC', 'BT1.1', 'R1.1'], ['GND', 'BT1.2', 'D1.2'], ['LED_A', 'R1.2', 'D1.1']])
{
  const good = run(led)
  // (9 - 1.9) / 680 with the through-hole red LED (lower VF) when the board style is unknown
  check('O3 LED 9 V / 680 Ω passes at 10.44 mA', is(good, 'op_led', 'pass', 'D1', /10\.4 mA/), show(good, 'op_led'))
  check('O3b 10 Ω instead of 680 Ω: too much current', is(run(variant(led, setValue('R1', '10'))), 'op_led', 'error', 'D1', /최대 30 mA/),
    show(run(variant(led, setValue('R1', '10'))), 'op_led'))
  const rev = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'R1.1'], ['GND', 'BT1.2', 'D1.1'], ['LED_A', 'R1.2', 'D1.2']])
  check('O3c LED reversed', is(run(rev), 'op_led', 'error', 'D1', /거꾸로/), show(run(rev), 'op_led'))
  const noR = circuit([['BT1', 'Battery', '9V'], ['D1', 'LED', 'RED']], [['VCC', 'BT1.1', 'D1.1'], ['GND', 'BT1.2', 'D1.2']])
  check('O3d no series resistor', is(run(noR), 'op_led', 'error', 'D1', /직렬 저항이 없어/), show(run(noR), 'op_led'))
  // 24 V, 820 Ω: 26.95 mA is within the LED's 30 mA, but the resistor burns 0.596 W > 0.25 W
  const hot = variant(variant(led, setValue('BT1', '24V')), setValue('R1', '820'))
  const h = run(hot, 'tht')
  check('O3e resistor overheats though the LED is fine', is(h, 'op_led', 'pass', 'D1') && is(h, 'op_rpower', 'error', 'R1', /596 mW/),
    `${show(h, 'op_led')} | ${show(h, 'op_rpower')}`)
  const viaConn = circuit([['J1', 'Conn_01x02', 'PWR_IN'], ['R1', 'R', '680'], ['D1', 'LED', 'RED']],
    [['VCC', 'J1.1', 'R1.1'], ['GND', 'J1.2', 'D1.2'], ['LED_A', 'R1.2', 'D1.1']])
  check('O3f supply through a connector: 판단 불가 with 3.3/5 V figures', is(run(viaConn), 'op_led', 'unknown', 'D1', /3\.3 V면.*5 V면/),
    show(run(viaConn), 'op_led'))
  // white, RGB and a two-colour LED have no datasheet in the table: 판단 불가, never pass (GREEN was one until 2026-11-08)
  const noData = ['WHITE', 'RGB', 'RED/GREEN', 'YELLOW-GREEN', 'ORANGE'].filter(c => !is(run(variant(led, setValue('D1', c))), 'op_led', 'unknown', 'D1'))
  check('O3g LED colour with no datasheet (white, RGB, two colours): 판단 불가, never pass', !noData.length, noData.join(', '))
  // the other colours of the same Kingbright families (src/lib/partSpecs.ts): blue VF 3.3~4.0 V @ 20 mA in both, so 5 V
  // through 680 Ω is (5 − 4.0) / 680 = 1.47 mA up to (5 − 3.3) / 680 = 2.5 mA; 3.3 V reaches no more than its 3.3 V VF;
  // green on 9 V / 680 Ω: THT WP7113GD (9 − 2.4) / 680 = 9.71 mA up to (9 − 2) / 680 = 10.3 mA, SMD APT2012SGC (9 − 2.5) / 680 = 9.56 mA up to
  // (9 − 2.2) / 680 = 10 mA, its 25 mA rating; yellow THT WP7113YD (9 − 1.95) / 680 = 10.4 mA; written in Korean or in a value name too
  const blue5 = variant(variant(led, setValue('BT1', '5V')), setValue('D1', 'BLUE'))
  const blue33 = variant(variant(led, setValue('BT1', '3.3V')), setValue('D1', 'BLUE'))
  const as = (c: string, style: 'smd' | 'tht' | null = null) => run(variant(led, setValue('D1', c)), style)
  check('O3i blue, green and yellow LEDs read their datasheets: 5 V blue 1.47~2.5 mA, 3.3 V blue not lit, green 25 mA rating, 파랑/LED_BLUE_SMD/초록/노랑 read',
    is(run(blue5, 'smd'), 'op_led', 'pass', 'D1', /1\.47~2\.5 mA/) && is(run(blue5, 'tht'), 'op_led', 'pass', 'D1', /1\.47~2\.5 mA/)
    && is(run(blue33, 'smd'), 'op_led', 'error', 'D1', /켜지지 않음.*3\.3 V 이하/)
    && is(as('GREEN', 'tht'), 'op_led', 'pass', 'D1', /9\.71~10\.3 mA \(최대 25 mA/) && is(as('GREEN', 'smd'), 'op_led', 'pass', 'D1', /9\.56~10 mA \(최대 25 mA/)
    && is(as('YELLOW', 'tht'), 'op_led', 'pass', 'D1', /~10\.4 mA \(최대 30 mA/)
    && full(as('초록')) === full(as('GREEN')) && full(as('노랑')) === full(as('YELLOW')) && full(as('파랑')) === full(as('BLUE'))
    && full(as('LED_BLUE_SMD')) === full(as('BLUE'))
    && !!pick(run(blue5, 'smd'), 'op_led', 'D1')?.detail.some(d => /APT2012QBC\/D/.test(d)),
    [show(run(blue5, 'smd'), 'op_led'), show(run(blue33, 'smd'), 'op_led'), show(as('GREEN', 'tht'), 'op_led'), show(as('GREEN', 'smd'), 'op_led'), show(as('YELLOW', 'tht'), 'op_led')].join(' / '))
  const smd = run(led, 'smd')
  check('O3h SMD uses the 0805 LED (VF 2.0 V): 10.29 mA', is(smd, 'op_led', 'pass', 'D1', /10\.3 mA/), show(smd, 'op_led'))
}

// O4. relay, flyback diode, NPN drive ──────────────────────────────────────────
const relay = circuit(
  [['J1', 'Conn_01x03', 'PWR_IN'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '5V'], ['C1', 'C', '100nF']],
  [['+5V', 'J1.1', 'K1.1', 'D1.2', 'C1.1'], ['IN', 'J1.2', 'R1.1'], ['GND', 'J1.3', 'Q1.3', 'C1.2'], ['BASE', 'R1.2', 'Q1.1'], ['COIL_LOW', 'Q1.2', 'K1.2', 'D1.1']])
const flipD1 = (c: NetGraph) => {
  const pos = c.nets.find(n => n.name === '+5V')!, low = c.nets.find(n => n.name === 'COIL_LOW')!
  pos.nodes = pos.nodes.map(n => (n.ref === 'D1' ? { ref: 'D1', pin: '1' } : n))
  low.nodes = low.nodes.map(n => (n.ref === 'D1' ? { ref: 'D1', pin: '2' } : n))
}
{
  const good = run(relay)
  check('O4 relay demo: flyback, coil, switch, drive all pass',
    ['op_flyback', 'op_relay', 'op_switch', 'op_drive'].every(r => pick(good, r as OpRule)?.state === 'pass') && good.every(r => r.state === 'pass'),
    good.map(r => `${r.rule}:${r.state}`).join(' '))
  // coil 70 Ω −10% = 63 Ω, switch drop 0: the largest current the transistor can see
  check('O4b switch current 5 V ÷ 63 Ω = 79.4 mA', is(good, 'op_switch', 'pass', 'Q1', /79\.4 mA/), show(good, 'op_switch'))
  const rev = variant(relay, flipD1)
  check('O4c flyback diode reversed', is(run(rev), 'op_flyback', 'error', undefined, /거꾸로/), show(run(rev), 'op_flyback'))
  const noD = variant(relay, c => { c.components = c.components.filter(x => x.ref !== 'D1'); c.nets.forEach(n => { n.nodes = n.nodes.filter(x => x.ref !== 'D1') }) })
  check('O4d no flyback diode', is(run(noD), 'op_flyback', 'error', undefined, /보호 다이오드가 없습니다/), show(run(noD), 'op_flyback'))
  check('O4e base 10 kΩ: not enough base current', is(run(variant(relay, setValue('R1', '10k'))), 'op_drive', 'error', 'Q1'),
    show(run(variant(relay, setValue('R1', '10k'))), 'op_drive'))
  check('O4f base 1.5 kΩ: only a 5 V signal is enough', is(run(variant(relay, setValue('R1', '1.5k'))), 'op_drive', 'warn', 'Q1', /5 V 신호에서만/),
    show(run(variant(relay, setValue('R1', '1.5k'))), 'op_drive'))
  check('O4g 12 V relay on 5 V: coil never pulls in', is(run(variant(relay, setValue('K1', '12V'))), 'op_relay', 'error', 'K1', /붙지 않습니다/),
    show(run(variant(relay, setValue('K1', '12V'))), 'op_relay'))
  // BC547: its gain row is at VCE 5 V, so only the forced-beta row (100 mA / 5 mA) proves it on
  const bc = run(variant(relay, setValue('Q1', 'BC547')))
  check('O4h BC547: only a 5 V signal saturates it (IC/IB 20 row), current within 100 mA',
    is(bc, 'op_drive', 'warn', 'Q1', /5 V 신호에서만/) && is(bc, 'op_switch', 'pass', 'Q1'), `${show(bc, 'op_drive')} | ${show(bc, 'op_switch')}`)
  const unk = run(variant(relay, setValue('Q1', 'XYZ123')), 'smd')
  check('O4i unknown transistor: calculated as the footprint part, and says so',
    !!pick(unk, 'op_drive')?.detail.some(d => /MMBT3904 기준/.test(d)), pick(unk, 'op_drive')?.detail[0])
}

// O5. N-MOSFET ──────────────────────────────────────────────────────────────────
const motor = circuit(
  [['J1', 'Conn_01x03', 'PWR_IN'], ['J2', 'Conn_01x02', 'MOTOR'], ['R1', 'R', '100'], ['R2', 'R', '0.1'], ['R3', 'R', '10k'],
    ['Q1', 'Q_NMOS', '2N7002'], ['D1', 'D', '1N4148'], ['C1', 'CP', '100uF']],
  [['+12V', 'J1.1', 'J2.1', 'D1.2', 'C1.1'], ['PWM', 'J1.2', 'R1.1'], ['GND', 'J1.3', 'R3.2', 'R2.2', 'C1.2'],
    ['GATE', 'R1.2', 'R3.1', 'Q1.1'], ['MOT_LOW', 'J2.2', 'Q1.2', 'D1.1'], ['SENSE', 'Q1.3', 'R2.1']])
{
  const m = run(motor)
  check('O5 motor demo: flyback ok, motor current unknown, gate marginal',
    is(m, 'op_flyback', 'pass') && is(m, 'op_switch', 'unknown', 'Q1', /115 mA/) && is(m, 'op_drive', 'warn', 'Q1', /3\.26 V \/ 4\.94 V/),
    m.map(r => `${r.rule}:${r.state}`).join(' '))
  const load = circuit([['V', 'Conn_01x02', 'PWR'], ['RG', 'R', '100'], ['RL', 'R', '47'], ['Q1', 'Q_NMOS', '2N7002']],
    [['+5V', 'RG.1'], ['+12V', 'V.1', 'RL.1'], ['GND', 'V.2', 'Q1.3'], ['GATE', 'RG.2', 'Q1.1'], ['DRAIN', 'RL.2', 'Q1.2']])
  const l = run(load)
  check('O5b 12 V / 47 Ω load = 255 mA > 2N7002 115 mA', is(l, 'op_switch', 'error', 'Q1', /255 mA/), show(l, 'op_switch'))
  check('O5c gate fed from +5V: fully on, no pull-down needed', is(l, 'op_drive', 'pass', 'Q1'), show(l, 'op_drive'))
  const low = variant(load, c => { c.nets.find(n => n.name === '+5V')!.name = '+1V8' })
  check('O5d 1.8 V gate < 2.5 V threshold', is(run(low), 'op_drive', 'error', 'Q1', /켜지지 않을 수 있습니다/), show(run(low), 'op_drive'))
  // the sense resistor under Q1 carries the motor current: 2 A through 0.1 Ω is 2² × 0.1 = 0.4 W, over the 0805's 125 mW and
  // the THT 250 mW (docs/fabrication-guide.md found it by hand); 0.1 A is 1 mW; with no current on the motor, at most
  // 2N7002's ID 115 mA flows: 0.115² × 0.1 = 1.32 mW, a pass with that basis, not a second 판단 불가 (2026-11-08: no R2 line)
  const amps = (v: string, style: 'smd' | 'tht' | null = null) => run(variant(motor, setValue('J2', v)), style)
  const r2 = (rs: OpResult[]) => pick(rs, 'op_rpower', 'R2')
  const where = /^Q1 아래 전류 감지 저항 R2 발열/
  check('O5e the sense resistor R2 under Q1 is heated by the motor current: 2 A error (400 mW, SMD and THT), 0.1 A pass (1 mW), no current: ID 115 mA (1.32 mW)',
    is(amps('MOTOR 12V 2A'), 'op_rpower', 'error', 'R2', /400 mW ≥ 정격 125 mW/) && is(amps('MOTOR 12V 2A', 'tht'), 'op_rpower', 'error', 'R2', /400 mW ≥ 정격 250 mW/)
    && is(amps('MOTOR 12V 0.1A'), 'op_rpower', 'pass', 'R2', /최대 1 mW/) && is(run(motor), 'op_rpower', 'pass', 'R2', /최대 1\.32 mW/)
    && !!r2(run(motor))?.detail.some(d => /ID 최대 115 mA/.test(d))
    && [amps('MOTOR 12V 2A'), amps('MOTOR 12V 0.1A'), run(motor)].every(rs => where.test(r2(rs)?.summary ?? '')),
    [show(amps('MOTOR 12V 2A'), 'op_rpower', 'R2'), show(amps('MOTOR 12V 0.1A'), 'op_rpower', 'R2'), show(run(motor), 'op_rpower', 'R2'), r2(run(motor))?.detail[0] ?? ''].join(' / '))
  // under an NPN's emitter the base current goes through it too: the relay coil's 79.4 mA plus at most 5 V ÷ R1 1 kΩ = 5 mA
  // of base, (84.4 mA)² × 1 Ω = 7.12 mW
  const npn = run(circuit(
    [['J1', 'Conn_01x03', 'PWR_IN'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '5V'], ['R2', 'R', '1']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2'], ['IN', 'J1.2', 'R1.1'], ['GND', 'J1.3', 'R2.2'], ['BASE', 'R1.2', 'Q1.1'], ['COIL_LOW', 'Q1.2', 'K1.2', 'D1.1'], ['SENSE', 'Q1.3', 'R2.1']]))
  check('O5f the emitter sense resistor under an NPN carries the base current too', is(npn, 'op_rpower', 'pass', 'R2', /^Q1 아래 전류 감지 저항 R2/)
    && !!r2(npn)?.detail.some(d => /\+ 베이스 최대 5 mA/.test(d)), `${show(npn, 'op_rpower', 'R2')} · ${r2(npn)?.detail[0]}`)
}

// O6. 555 timer ─────────────────────────────────────────────────────────────────
const timer = circuit(
  [['BT1', 'Battery', '9V'], ['U1', 'NE555', 'NE555'], ['R1', 'R', '10k'], ['R2', 'R', '68k'], ['C1', 'CP', '10uF'], ['C2', 'C', '10nF'],
    ['C3', 'C', '100nF'], ['R3', 'R', '680'], ['D1', 'LED', 'RED']],
  [['VCC', 'BT1.1', 'U1.8', 'U1.4', 'R1.1', 'C3.1'], ['GND', 'BT1.2', 'U1.1', 'C1.2', 'C2.2', 'C3.2', 'D1.2'], ['DISCH', 'R1.2', 'U1.7', 'R2.1'],
    ['THRES', 'R2.2', 'U1.6', 'U1.2', 'C1.1'], ['CTRL', 'U1.5', 'C2.1'], ['OUT', 'U1.3', 'R3.1'], ['LED_A', 'R3.2', 'D1.1']])
{
  const t = run(timer)
  // 1.44 / ((10k + 2 x 68k) x 10 uF) = 0.986 Hz; LED (9 - 1.7 - 2.3 Vf max) / 680 = 7.35 mA up to (9 - 1.9) / 680 = 10.4 mA
  check('O6 555 demo: 0.986 Hz, LED 7.35~10.4 mA', is(t, 'op_555', 'pass', 'U1', /0\.986 Hz/) && is(t, 'op_led', 'pass', 'D1', /7\.35~10\.4 mA/),
    `${show(t, 'op_555')} | ${show(t, 'op_led')}`)
  check('O6b 3 V battery: below 4.5 V minimum', is(run(variant(timer, setValue('BT1', '3V'))), 'op_555', 'error', 'U1', /동작 범위/),
    show(run(variant(timer, setValue('BT1', '3V'))), 'op_555'))
  check('O6c RESET tied to GND', is(run(variant(timer, movePin('U1.4', 'GND'))), 'op_555', 'error', 'U1', /RESET/), show(run(variant(timer, movePin('U1.4', 'GND'))), 'op_555'))
  check('O6d RESET floating', is(run(variant(timer, movePin('U1.4', 'RST'))), 'op_555', 'warn', 'U1', /떠 있어/), show(run(variant(timer, movePin('U1.4', 'RST'))), 'op_555'))
}

// O7. regulator ─────────────────────────────────────────────────────────────────
const reg = circuit([['BT1', 'Battery', '9V'], ['U1', 'REG', 'AMS1117-3.3'], ['C1', 'CP', '22uF']],
  [['VIN', 'BT1.1', 'U1.3'], ['GND', 'BT1.2', 'U1.1', 'C1.2'], ['V3', 'U1.2', 'C1.1']])
{
  check('O7 9 V into AMS1117-3.3 with 22 µF', is(run(reg), 'op_reg', 'pass', 'U1'), show(run(reg), 'op_reg'))
  check('O7b 3.7 V in: 0.4 V headroom < 1.3 V', is(run(variant(reg, setValue('BT1', '3.7V'))), 'op_reg', 'error', 'U1', /유지하지 못합니다/),
    show(run(variant(reg, setValue('BT1', '3.7V'))), 'op_reg'))
  check('O7c 18 V in > 15 V max', is(run(variant(reg, setValue('BT1', '18V'))), 'op_reg', 'error', 'U1', /최대 15 V/),
    show(run(variant(reg, setValue('BT1', '18V'))), 'op_reg'))
  check('O7d only 100 nF on the output', is(run(variant(reg, setValue('C1', '100nF'))), 'op_reg', 'warn', 'U1', /22 µF/),
    show(run(variant(reg, setValue('C1', '100nF'))), 'op_reg'))
  // 7805: TI guarantees regulation from 7.5 V in (2.5 V over the 5 V output)
  const r7805 = variant(reg, setValue('U1', 'LM7805'))
  check('O7e 9 V into LM7805 passes', is(run(r7805), 'op_reg', 'pass', 'U1', /여유 4 V/), show(run(r7805), 'op_reg'))
  check('O7e2 7 V into LM7805: 2 V < 2.5 V headroom', is(run(variant(r7805, setValue('BT1', '7V'))), 'op_reg', 'error', 'U1', /최소 2.5 V/),
    show(run(variant(r7805, setValue('BT1', '7V'))), 'op_reg'))
  check('O7e3 7812: limits not looked up → 판단 불가', is(run(variant(reg, setValue('U1', 'LM7812'))), 'op_reg', 'unknown', 'U1'),
    show(run(variant(reg, setValue('U1', 'LM7812'))), 'op_reg'))
  // an LM1117-3.3 (limits not looked up) still gives its output 3.3 V: 0.1 Ω from that output to GND is 109 W
  // (2026-11-03 tour, S28: the power circuit's R1 "출력 전압 모니터링" sat from VOUT to GND and only 판단 불가 showed);
  // only a voltage after a dash is read (review of 2026-11-03): 2.85 is not 2.8 (2.85² ÷ 0.1 = 81.2 W), a package
  // suffix after it stays; ADJ ones, and ST12 with no dash (12 V, not 1.2 V), read none
  const shunt = circuit([['J1', 'Conn_01x02', 'USB'], ['U1', 'REG', 'LM1117-3.3'], ['C1', 'C', '10uF'], ['C2', 'C', '10uF'], ['R1', 'R', '0.1']],
    [['+5V', 'J1.1', 'U1.3', 'C1.1'], ['GND', 'J1.2', 'U1.1', 'C1.2', 'C2.2', 'R1.2'], ['VOUT', 'U1.2', 'C2.1', 'R1.1']])
  const as = (value: string) => run(variant(shunt, setValue('U1', value)))
  const none = ['LM1117-ADJ', 'LM1117 ADJ 1.25V', 'NCP1117ST12T3G', 'AMS1117 SOT-223', 'AMS1117 ADJ 1.25V']
    .filter(x => pick(as(x), 'op_rpower', 'R1') || !is(as(x), 'op_reg', 'unknown', 'U1', /자료가 없습니다/))
  // on 3.7 V in the 1117 dropout holds its output back, and the short is still found, as with an AMS1117 short of input
  const low = run(variant(shunt, c => { c.components.push({ ref: 'BT1', name: 'Battery', value: '3.7V' }); movePin('BT1.1', '+5V')(c); movePin('BT1.2', 'GND')(c) }))
  const lowR1 = pick(low, 'op_rpower', 'R1')
  check('O7e4 LM1117-3.3: no verdict on it, but its 3.3 V output finds 0.1 Ω to GND (109 W), on 3.7 V in too; 2.85 V read whole; ADJ, a package name and no-dash read no voltage',
    is(run(shunt), 'op_reg', 'unknown', 'U1', /LM1117-3\.3/) && is(run(shunt), 'op_rpower', 'error', 'R1', /109 W/)
    && is(as('AZ1117H-3.3TRE1'), 'op_rpower', 'error', 'R1', /109 W/) && is(as('LM1117-2.85'), 'op_rpower', 'error', 'R1', /81\.2 W/)
    && is(as('LM1117-2.85'), 'op_reg', 'unknown', 'U1', /LM1117-2\.85/) && !none.length
    && lowR1?.state === 'error' && /109 W/.test(lowR1.summary) && lowR1.detail.some(t => /입력이 충분하다고 보면/.test(t)),
    [show(run(shunt), 'op_rpower', 'R1'), show(as('LM1117-2.85'), 'op_rpower', 'R1'), `read a voltage: [${none}]`, `3.7 V in: ${show(low, 'op_rpower', 'R1')}`].join(' / '))
  // the regulator output becomes a known supply for what it feeds
  const fed = circuit([['BT1', 'Battery', '9V'], ['U1', 'REG', 'AMS1117-3.3'], ['C1', 'CP', '22uF'], ['R1', 'R', '100'], ['D1', 'LED', 'RED']],
    [['VIN', 'BT1.1', 'U1.3'], ['GND', 'BT1.2', 'U1.1', 'C1.2', 'D1.2'], ['V3', 'U1.2', 'C1.1', 'R1.1'], ['LED_A', 'R1.2', 'D1.1']])
  check('O7f LED fed by the 3.3 V output: (3.3 − 1.9) / 100 = 14 mA', is(run(fed), 'op_led', 'pass', 'D1', /14 mA/), show(run(fed), 'op_led'))
  // an LM1117-3.3 gives its output only with the AMS1117's 1.3 V dropout over it: on 3.7 V in its LED is not passed,
  // caused by U1, as with an AMS1117 (review of 2026-11-03: it passed at 10~14 mA); on 9 V it passes. An AMS1117 with
  // a package letter (AMS1117CD-3.3) keeps the AMS1117's own limits
  const lm = variant(fed, setValue('U1', 'LM1117-3.3')), lmLow = run(variant(lm, setValue('BT1', '3.7V')))
  const lowLed = pick(lmLow, 'op_led', 'D1')
  check('O7f2 LM1117-3.3 on 3.7 V: its LED not passed (cause U1, AMS1117 dropout named); on 9 V it passes; AMS1117CD-3.3 reads as AMS1117',
    !!lowLed && lowLed.state === 'unknown' && lowLed.cause === 'U1' && lowLed.detail.concat(lowLed.summary).some(t => /AMS1117의 최소 전압 차 1\.3 V/.test(t))
    && is(run(lm), 'op_led', 'pass', 'D1', /14 mA/)
    && is(run(variant(variant(fed, setValue('U1', 'AMS1117CD-3.3')), setValue('BT1', '3.7V'))), 'op_reg', 'error', 'U1', /유지하지 못합니다/),
    [show(lmLow, 'op_led'), lowLed?.detail.join(' | ') ?? '', show(run(lm), 'op_led')].join(' / '))
  // a 1117's voltage written with a V for the point (2026-11-06 sweep: AMS1117-3V3 read 3 V, its right +3V3 net an
  // op_power error, and the LED it feeds was reckoned on 3 V; 1V8 read 1 V, 2V5 2 V), a package after it too
  const named3V3 = (value: string) => run(variant(fed, c => { setValue('U1', value)(c); c.nets.find(n => n.name === 'V3')!.name = '+3V3' }))
  const out = (value: string, v: RegExp) => is(run(variant(reg, setValue('U1', value))), 'op_reg', 'pass', 'U1', v)
  const v3 = named3V3('AMS1117-3V3'), pkg = named3V3('AMS1117-3V3 SOT-223')
  check('O7f3 AMS1117-3V3, 1V8, 2V5 and with a package after it read their voltage; a +3V3 net agrees; LM1117-3V3 too, still no verdict',
    !v3.some(r => r.rule === 'op_power') && is(v3, 'op_led', 'pass', 'D1', /14 mA/) && is(v3, 'op_reg', 'pass', 'U1', /→ 3\.3 V/)
    && !pkg.some(r => r.rule === 'op_power') && is(pkg, 'op_led', 'pass', 'D1', /14 mA/)
    && out('AMS1117-1V8', /→ 1\.8 V/) && out('AMS1117-2V5', /→ 2\.5 V/) && out('AMS1117-3.3', /→ 3\.3 V/)
    && is(named3V3('LM1117-3V3'), 'op_reg', 'unknown', 'U1', /LM1117-3\.3/) && is(named3V3('LM1117-3V3'), 'op_led', 'pass', 'D1', /14 mA/),
    [show(v3, 'op_power'), show(v3, 'op_reg'), show(pkg, 'op_reg'), show(run(variant(reg, setValue('U1', 'AMS1117-1V8'))), 'op_reg')].join(' / '))
}

// O8. headline ──────────────────────────────────────────────────────────────────
{
  const h1 = operatingHeadline(run(variant(led, setValue('R1', '10'))))
  const h2 = operatingHeadline(run(led))
  const h3 = operatingHeadline(run(motor))
  // 10 Ω: the LED current and the resistor heat are one fault; the motor's unknown current shows next to its warning
  check('O8 headline: one fault counts once, unknowns stay visible, all-pass says so',
    h1.state === 'error' && h1.text === '동작 안 됨 1' && h2.text === '동작 검사 통과' && h3.text === '동작 경고 1 · 판단 불가 1',
    `${h1.text} | ${h2.text} | ${h3.text}`)
}

// O12. findings from the adversarial review: one circuit per finding ─────────────
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])

  // crash: coil supply named VCC (voltage unknown), the switch side found from the transistor
  const vccRelay = circuit([['J1', 'Conn_01x03', 'PWR_IN'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '5V']],
    [['VCC', 'J1.1', 'K1.1', 'D1.2'], ['IN', 'J1.2', 'R1.1'], ['GND', 'J1.3', 'Q1.3'], ['BASE', 'R1.2', 'Q1.1'], ['COIL_LOW', 'Q1.2', 'K1.2', 'D1.1']])
  let crash = ''
  let vr: OpResult[] = []
  try { vr = run(vccRelay) } catch (e) { crash = String(e) }
  add('crash: relay on an unnamed supply', !crash && is(vr, 'op_flyback', 'pass', 'K1') && is(vr, 'op_relay', 'unknown', 'K1'), crash || `${show(vr, 'op_flyback')} | ${show(vr, 'op_relay')}`)

  // base straight on +5V that also feeds an LED resistor
  const baseOnRail = circuit([['BT1', 'Battery', '5V'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'BT1.1', 'R1.1', 'Q1.1'], ['LED_A', 'R1.2', 'D1.1'], ['LED_K', 'D1.2', 'Q1.2'], ['GND', 'BT1.2', 'Q1.3']])
  add('base tied to a rail with no resistor', is(run(baseOnRail), 'op_drive', 'error', 'Q1', /저항 없이/), show(run(baseOnRail), 'op_drive'))

  // 2N7002 gate on 24 V
  const gate24 = circuit([['J1', 'Conn_01x02', 'PWR'], ['RL', 'R', '1k'], ['Q1', 'Q_NMOS', '2N7002']],
    [['+24V', 'J1.1', 'RL.1', 'Q1.1'], ['DRAIN', 'RL.2', 'Q1.2'], ['GND', 'J1.2', 'Q1.3']])
  add('gate 24 V ≥ VGS max 20 V', is(run(gate24), 'op_drive', 'error', 'Q1', /최대 20 V/), show(run(gate24), 'op_drive'))

  // base resistor whose far end goes nowhere
  const dangling = variant(relay, c => { c.components = c.components.filter(x => x.ref !== 'J1'); c.nets.forEach(n => { n.nodes = n.nodes.filter(x => x.ref !== 'J1') }) })
  add('base resistor left open', is(run(dangling), 'op_drive', 'error', 'Q1', /아무 데도/), show(run(dangling), 'op_drive'))

  // a net named +5V that a 9 V battery feeds: the battery wins and the name is reported
  const misnamed = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '150'], ['D1', 'LED', 'RED']],
    [['+5V', 'BT1.1', 'R1.1'], ['GND', 'BT1.2', 'D1.2'], ['LED_A', 'R1.2', 'D1.1']])
  const mn = run(misnamed)
  add('name +5V on a 9 V battery', is(mn, 'op_power', 'error', undefined, /\+5V/) && is(mn, 'op_led', 'error', 'D1', /47\.3 mA/), `${show(mn, 'op_power')} | ${show(mn, 'op_led')}`)

  // battery backwards between GND and +9V
  const backwards = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED']],
    [['GND', 'BT1.1', 'D1.2'], ['+9V', 'BT1.2', 'R1.1'], ['LED_A', 'R1.2', 'D1.1']])
  const bw = run(backwards)
  add('battery backwards', is(bw, 'op_power', 'error', 'BT1', /거꾸로/) && pick(bw, 'op_led')?.state !== 'pass', `${show(bw, 'op_power')} | ${show(bw, 'op_led')}`)

  // two 9 V batteries in series, listed in either order: 18 V at the top
  const stack = (order: Comp[]) => circuit([...order, ['R1', 'R', '330'], ['D1', 'LED', 'RED']],
    [['TOP', 'BT1.1', 'R1.1'], ['MID', 'BT1.2', 'BT2.1'], ['GND', 'BT2.2', 'D1.2'], ['LED_A', 'R1.2', 'D1.1']])
  const s1 = run(stack([['BT1', 'Battery', '9V'], ['BT2', 'Battery', '9V']])), s2 = run(stack([['BT2', 'Battery', '9V'], ['BT1', 'Battery', '9V']]))
  add('series batteries, either order: (18 − 1.9) / 330 = 48.8 mA', is(s1, 'op_led', 'error', 'D1', /48\.8 mA/) && is(s2, 'op_led', 'error', 'D1', /48\.8 mA/),
    `${show(s1, 'op_led')} | ${show(s2, 'op_led')}`)

  // 9 V and 3 V in parallel
  const parallel = circuit([['BT1', 'Battery', '9V'], ['BT2', 'Battery', '3V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'BT2.1', 'R1.1'], ['GND', 'BT1.2', 'BT2.2', 'D1.2'], ['LED_A', 'R1.2', 'D1.1']])
  add('batteries of different voltage in parallel', is(run(parallel), 'op_power', 'error', 'BT2', /맞물려/), show(run(parallel), 'op_power'))

  // a net named GND that the battery never reaches
  const islandGnd = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'R1.1'], ['BAT_NEG', 'BT1.2'], ['LED_A', 'R1.2', 'D1.1'], ['GND', 'D1.2']])
  const ig = run(islandGnd)
  add('GND not tied to the battery', is(ig, 'op_power', 'error', 'BT1', /아무 데도|이어져 있지 않습니다/) && pick(ig, 'op_led')?.state !== 'pass', `${show(ig, 'op_power')} | ${show(ig, 'op_led')}`)

  // 555 RESET on OUT, THRES, DISCH; RESET through a resistor that goes nowhere
  const rst = ['OUT', 'THRES', 'DISCH'].map(to => run(variant(timer, movePin('U1.4', to))))
  add('555 RESET tied to OUT / THRES / DISCH', rst.every(r => is(r, 'op_555', 'error', 'U1', /RESET/)), rst.map(r => show(r, 'op_555')).join(' | '))
  const rstR = variant(variant(timer, movePin('U1.4', 'RST')), c => { c.components.push({ ref: 'R9', name: 'R', value: '10k' }); c.nets.find(n => n.name === 'RST')!.nodes.push({ ref: 'R9', pin: '1' }); c.nets.push({ name: 'NOWHERE', nodes: [{ ref: 'R9', pin: '2' }] }) })
  add('555 RESET through a resistor to nothing', is(run(rstR), 'op_555', 'warn', 'U1', /떠 있어/), show(run(rstR), 'op_555'))

  // 555 CTRL on GND or VCC, DISCH on GND
  const ctlG = run(variant(timer, movePin('U1.5', 'GND'))), ctlV = run(variant(timer, movePin('U1.5', 'VCC'))), disG = run(variant(timer, movePin('U1.7', 'GND')))
  add('555 CTRL on GND / VCC, DISCH on GND', is(ctlG, 'op_555', 'error', 'U1', /CTRL/) && is(ctlV, 'op_555', 'error', 'U1', /CTRL/) && is(disG, 'op_555', 'error', 'U1', /DISCH/),
    `${show(ctlG, 'op_555')} | ${show(ctlV, 'op_555')} | ${show(disG, 'op_555')}`)

  // electrolytic backwards: on a regulator output, and as the 555 timing capacitor
  const capRev = run(variant(reg, c => { movePin('C1.1', 'GND')(c); movePin('C1.2', 'V3')(c) }))
  const tcapRev = run(variant(timer, c => { movePin('C1.1', 'GND')(c); movePin('C1.2', 'THRES')(c) }))
  add('electrolytic backwards (regulator, 555)', is(capRev, 'op_cap', 'error', 'C1', /거꾸로/) && is(capRev, 'op_reg', 'warn', 'U1') &&
    is(tcapRev, 'op_cap', 'error', 'C1') && pick(tcapRev, 'op_555')?.state !== 'pass', `${show(capRev, 'op_cap')} | ${show(capRev, 'op_reg')} | ${show(tcapRev, 'op_555')}`)

  // Greek mu
  const mu = run(variant(reg, setValue('C1', '0.1μF')))
  add('0.1μF (Greek mu) is read', near(parseFarads('22μF'), 22e-6) && is(mu, 'op_reg', 'warn', 'U1', /0\.1 µF/), show(mu, 'op_reg'))

  // 7805 output named +3V3
  const r33 = circuit([['BT1', 'Battery', '9V'], ['U1', 'REG', 'LM7805'], ['R1', 'R', '68'], ['D1', 'LED', 'RED']],
    [['VIN', 'BT1.1', 'U1.3'], ['GND', 'BT1.2', 'U1.1', 'D1.2'], ['+3V3', 'U1.2', 'R1.1'], ['LED_A', 'R1.2', 'D1.1']])
  add('regulator output named for another voltage', is(run(r33), 'op_power', 'error', 'U1', /\+3V3/) && is(run(r33), 'op_led', 'error', 'D1', /45\.6 mA/),
    `${show(run(r33), 'op_power')} | ${show(run(r33), 'op_led')}`)

  // regulator output on GND; input and output on one net; input and output swapped
  const outGnd = run(variant(reg, movePin('U1.2', 'GND'))), inOut = run(variant(reg, movePin('U1.2', 'VIN')))
  const swapped = run(variant(reg, c => { movePin('U1.2', 'VIN')(c); movePin('U1.3', 'V3')(c) }))
  add('regulator output shorted / bypassed / swapped', is(outGnd, 'op_reg', 'error', 'U1', /단락/) && is(inOut, 'op_reg', 'error', 'U1', /우회/) && is(swapped, 'op_reg', 'error', 'U1', /바뀐/),
    `${show(outGnd, 'op_reg')} | ${show(inOut, 'op_reg')} | ${show(swapped, 'op_reg')}`)

  // relay part number whose series name holds another voltage
  const g5v = run(variant(relay, setValue('K1', 'G5V-1 DC12')))
  add('relay G5V-1 DC12 is not read as 5 V', is(g5v, 'op_relay', 'unknown', 'K1'), show(g5v, 'op_relay'))

  // resistor heat outside LED strings: 1 kΩ collector load at 12 V, 10 Ω across 9 V, RA of 10 Ω
  const coll = circuit([['J1', 'Conn_01x02', 'PWR'], ['RC', 'R', '1k'], ['RB', 'R', '4.7k'], ['Q1', 'Q_NPN', '2N3904']],
    [['+12V', 'J1.1', 'RC.1'], ['+5V', 'RB.1'], ['GND', 'J1.2', 'Q1.3'], ['BASE', 'RB.2', 'Q1.1'], ['COL', 'RC.2', 'Q1.2']])
  const across = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '10']], [['VCC', 'BT1.1', 'R1.1'], ['GND', 'BT1.2', 'R1.2']])
  const ra10 = run(variant(timer, setValue('R1', '10')))
  add('resistor heat: collector load, across a battery, 555 RA', is(run(coll), 'op_rpower', 'error', 'RC', /144 mW/) && is(run(across), 'op_rpower', 'error', 'R1', /8\.1 W/) &&
    is(ra10, 'op_rpower', 'error', 'R1', /4\.05 W/), `${show(run(coll), 'op_rpower', 'RC')} | ${show(run(across), 'op_rpower')} | ${show(ra10, 'op_rpower', 'R1')}`)

  // a switch or relay contact that shorts the supply
  const swShort = circuit([['BT1', 'Battery', '9V'], ['SW1', 'SW', 'PUSH']], [['VCC', 'BT1.1', 'SW1.1'], ['GND', 'BT1.2', 'SW1.2']])
  const contact = run(variant(relay, c => { c.nets.find(n => n.name === '+5V')!.nodes.push({ ref: 'K1', pin: '3' }); c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'K1', pin: '4' }) }))
  add('switch / relay contact across the supply', is(run(swShort), 'op_short', 'error', 'SW1') && is(contact, 'op_short', 'error', 'K1', /NO/), `${show(run(swShort), 'op_short')} | ${show(contact, 'op_short')}`)

  // two timing capacitors in parallel: 20 µF → 0.493 Hz
  const twoCaps = variant(timer, c => { c.components.push({ ref: 'C4', name: 'CP', value: '10uF' }); c.nets.find(n => n.name === 'THRES')!.nodes.push({ ref: 'C4', pin: '1' }); c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'C4', pin: '2' }) })
  add('555 parallel timing capacitors summed', is(run(twoCaps), 'op_555', 'pass', 'U1', /0\.493 Hz/), show(run(twoCaps), 'op_555'))

  // infrared LED is not a red LED
  add('INFRARED is not RED', is(run(variant(led, setValue('D1', 'INFRARED'))), 'op_led', 'unknown', 'D1'), show(run(variant(led, setValue('D1', 'INFRARED'))), 'op_led'))

  // 4 V coil supply, base well driven: 58 mA is above the 50 mA VCE(sat) row → VCE ≤ 1 V → coil 3 V < 3.75 V
  const relay4 = circuit([['J1', 'Conn_01x02', 'PWR'], ['RB', 'R', '620'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '5V']],
    [['+4V', 'J1.1', 'K1.1', 'D1.2'], ['+5V', 'RB.1'], ['GND', 'J1.2', 'Q1.3'], ['BASE', 'RB.2', 'Q1.1'], ['COIL', 'Q1.2', 'K1.2', 'D1.1']])
  add('VCE(sat) row by current: 4 V relay does not pull in', is(run(relay4), 'op_relay', 'error', 'K1', /3 V < 동작 전압 3\.75 V/), show(run(relay4), 'op_relay'))

  // base with only a pull-down; 555 output straight into a base
  const pullOnly = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904'], ['R2', 'R', '10k']],
    [['VCC', 'BT1.1', 'R1.1'], ['LED_A', 'R1.2', 'D1.1'], ['LED_K', 'D1.2', 'Q1.2'], ['GND', 'BT1.2', 'Q1.3', 'R2.2'], ['BASE', 'Q1.1', 'R2.1']])
  const outBase = variant(timer, c => { c.components.push({ ref: 'Q1', name: 'Q_NPN', value: '2N3904' }); movePin('Q1.1', 'OUT')(c); movePin('Q1.3', 'GND')(c); movePin('Q1.2', 'NC1')(c) })
  add('base with only a pull-down / 555 straight into a base', is(run(pullOnly), 'op_drive', 'error', 'Q1', /GND 쪽/) && is(run(outBase), 'op_drive', 'error', 'Q1', /저항 없이/),
    `${show(run(pullOnly), 'op_drive')} | ${show(run(outBase), 'op_drive')}`)

  // LED backwards behind a transistor
  const revBehind = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '10k']],
    [['VCC', 'BT1.1', 'R1.1', 'RB.1'], ['LED_K', 'R1.2', 'D1.2'], ['COL', 'D1.1', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'BT1.2', 'Q1.3']])
  add('LED backwards behind a transistor', is(run(revBehind), 'op_led', 'error', 'D1', /거꾸로/), show(run(revBehind), 'op_led'))

  // 0 Ω is no resistor
  add('0R in series is no resistor', is(run(variant(led, setValue('R1', '0R'))), 'op_led', 'error', 'D1', /직렬 저항이 없어/), show(run(variant(led, setValue('R1', '0R'))), 'op_led'))

  // timing capacitor value without a unit
  add('555 capacitor value unreadable', is(run(variant(timer, setValue('C1', '10'))), 'op_555', 'unknown', 'U1', /C1 값 '10'/), show(run(variant(timer, setValue('C1', '10'))), 'op_555'))

  // motor straight across the battery: no switch, nothing to protect
  const direct = circuit([['BT1', 'Battery', '9V'], ['J2', 'Conn_01x02', 'MOTOR']], [['VCC', 'BT1.1', 'J2.1'], ['GND', 'BT1.2', 'J2.2']])
  add('motor with no switch: no flyback error', !pick(run(direct), 'op_flyback'), show(run(direct), 'op_flyback'))

  // math: IB between IC/hFE and IC/10 only guarantees VCE ≤ 1 V: 4.5 − 1 = 3.5 V < 3.75 V
  const relay45 = circuit([['J1', 'Conn_01x02', 'PWR'], ['RB', 'R', '1.5k'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '5V']],
    [['+4.5V', 'J1.1', 'K1.1', 'D1.2', 'RB.1'], ['GND', 'J1.2', 'Q1.3'], ['BASE', 'RB.2', 'Q1.1'], ['COIL', 'Q1.2', 'K1.2', 'D1.1']])
  const r45 = run(relay45)
  add('gain row only: coil gets 3.5 V', is(r45, 'op_relay', 'error', 'K1', /3\.5 V/) && !!pick(r45, 'op_drive')?.detail.some(d => /포화는 보장되지 않음/.test(d)), `${show(r45, 'op_relay')} | ${show(r45, 'op_drive')}`)

  // math: 2N7002 RDS(on) 7.5 Ω in series with the coil at 4 V
  const mosRelay = circuit([['J1', 'Conn_01x02', 'PWR'], ['Q1', 'Q_NMOS', '2N7002'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '5V']],
    [['+4V', 'J1.1', 'K1.1', 'D1.2'], ['+5V', 'Q1.1'], ['GND', 'J1.2', 'Q1.3'], ['COIL', 'Q1.2', 'K1.2', 'D1.1']])
  add('RDS(on) drop counted: coil 3.57 V', is(run(mosRelay), 'op_relay', 'error', 'K1', /3\.57 V/), show(run(mosRelay), 'op_relay'))

  // math: 555 at 5 V with a 47 Ω LED resistor: with no output drop, (5 − 1.9) / 47 = 66 mA
  const t5 = run(variant(variant(timer, setValue('BT1', '5V')), setValue('R3', '47')))
  add('555 LED current uses no output drop for the limit', is(t5, 'op_led', 'error', 'D1', /66 mA/), show(t5, 'op_led'))

  // math: anode and cathode resistors both counted in the switch load
  const twoR = circuit([['BT1', 'Battery', '5V'], ['RA', 'R', '150'], ['RK', 'R', '150'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '15k']],
    [['+5V', 'BT1.1', 'RA.1', 'RB.1'], ['A', 'RA.2', 'D1.1'], ['K', 'D1.2', 'RK.1'], ['COL', 'RK.2', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'BT1.2', 'Q1.3']])
  add('LED with resistors on both sides: one current', is(run(twoR), 'op_drive', 'pass', 'Q1') && is(run(twoR), 'op_switch', 'pass', 'Q1', /10\.3 mA/),
    `${show(run(twoR), 'op_drive')} | ${show(run(twoR), 'op_switch')}`)

  // math: 100 V shown as 100 V
  add('100 V is written as 100 V', !!pick(run(relay), 'op_flyback')?.detail.some(d => /역전압 정격 100 V/.test(d)), pick(run(relay), 'op_flyback')?.detail.join(' / ') ?? '')

  // math: collector current below the gain table → no answer
  const tiny = circuit([['J1', 'Conn_01x02', 'PWR'], ['RC', 'R', '100k'], ['RB', 'R', '1M'], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'J1.1', 'RC.1', 'RB.1'], ['GND', 'J1.2', 'Q1.3'], ['BASE', 'RB.2', 'Q1.1'], ['COL', 'RC.2', 'Q1.2']])
  add('IC below the hFE table → 판단 불가, µA shown', is(run(tiny), 'op_drive', 'unknown', 'Q1', /범위/) && /µA/.test(pick(run(tiny), 'op_drive')!.detail.join(' ')),
    show(run(tiny), 'op_drive'))

  // math: RA + RB limit grows with VCC: 3.2 MΩ is too much at 4.5 V, 4 MΩ is fine at 9 V
  const big45 = run(variant(variant(variant(timer, setValue('BT1', '4.5V')), setValue('R1', '1.6M')), setValue('R2', '1.6M')))
  const big9 = run(variant(variant(timer, setValue('R1', '2M')), setValue('R2', '2M')))
  add('555 RA + RB limit scales with VCC', is(big45, 'op_555', 'warn', 'U1', /타이밍 저항 합 3\.2 MΩ > 최대 3\.06 MΩ/) && is(big9, 'op_555', 'pass', 'U1'),
    `${show(big45, 'op_555')} | ${show(big9, 'op_555')}`)

  // math: absolute maximum ratings compared with ≥, and a warning band below them
  const reg15 = run(variant(reg, setValue('BT1', '15V'))), reg14 = run(variant(reg, setValue('BT1', '14V')))
  const ledAt = (name: string) => run(circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '100'], ['D1', 'LED', 'RED']],
    [[name, 'J1.1', 'R1.1'], ['GND', 'J1.2', 'D1.2'], ['LED_A', 'R1.2', 'D1.1']]))
  add('rating itself fails, 90% warns', is(reg15, 'op_reg', 'error', 'U1') && is(reg14, 'op_reg', 'warn', 'U1') &&
    is(ledAt('+4.9V'), 'op_led', 'error', 'D1') && is(ledAt('+4.7V'), 'op_led', 'warn', 'D1', /28 mA/),
    `${show(reg15, 'op_reg')} | ${show(reg14, 'op_reg')} | ${show(ledAt('+4.9V'), 'op_led')} | ${show(ledAt('+4.7V'), 'op_led')}`)

  // math: numbers next to their limit never read the same
  const two2 = circuit([['V', 'Conn_01x02', 'PWR'], ['RA', 'R', '68'], ['RB', 'R', '120'], ['Q1', 'Q_NMOS', '2N7002']],
    [['+5V', 'V.1', 'RA.1', 'RB.1', 'Q1.1'], ['GND', 'V.2', 'Q1.3'], ['D', 'RA.2', 'RB.2', 'Q1.2']])
  const div = circuit([['J1', 'Conn_01x02', 'PWR'], ['RG', 'R', '100'], ['RP', 'R', '100k'], ['RL', 'R', '1k'], ['Q1', 'Q_NMOS', '2N7002']],
    [['+5V', 'J1.1', 'RG.1', 'RL.1'], ['GATE', 'RG.2', 'RP.1', 'Q1.1'], ['GND', 'J1.2', 'Q1.3', 'RP.2'], ['D', 'RL.2', 'Q1.2']])
  add('115.2 mA ≥ 115 mA, gate 4.995 V not 5 V', is(run(two2), 'op_switch', 'error', 'Q1', /115\.2 mA ≥ 최대 115 mA/) && is(run(div), 'op_drive', 'warn', 'Q1', /4\.995 V/),
    `${show(run(two2), 'op_switch')} | ${show(run(div), 'op_drive')}`)

  // real circuits: reversed flyback also stops the relay and overloads the switch, but is one fault
  const rv = run(variant(relay, flipD1))
  add('reversed flyback: relay and switch fail too, headline counts 1', is(rv, 'op_relay', 'error', 'K1') && is(rv, 'op_switch', 'error', 'Q1') &&
    operatingHeadline(rv).text === '동작 안 됨 1', `${show(rv, 'op_relay')} | ${show(rv, 'op_switch')} | ${operatingHeadline(rv).text}`)

  // real circuits: three LEDs sharing one resistor (anode side and cathode side); 10 Ω version fails
  const shareTop = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '470'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED'], ['D3', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'R1.1'], ['LED_A', 'R1.2', 'D1.1', 'D2.1', 'D3.1'], ['GND', 'BT1.2', 'D1.2', 'D2.2', 'D3.2']])
  const shareBot = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '470'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'D1.1', 'D2.1'], ['LED_K', 'D1.2', 'D2.2', 'R1.1'], ['GND', 'BT1.2', 'R1.2']])
  add('LEDs sharing a resistor: warn, 10 Ω error', is(run(shareTop), 'op_led', 'warn', 'D1', /나눠/) && is(run(shareBot), 'op_led', 'warn', 'D1', /나눠/) &&
    is(run(variant(shareTop, setValue('R1', '10'))), 'op_led', 'error', 'D1'), `${show(run(shareTop), 'op_led')} | ${show(run(shareBot), 'op_led')}`)

  // real circuits: two LEDs in series on one resistor
  const series = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'R1.1'], ['A1', 'R1.2', 'D1.1'], ['MID', 'D1.2', 'D2.1'], ['GND', 'BT1.2', 'D2.2']])
  add('series LEDs: (9 − 2 × 1.9) / 330 = 15.8 mA, 10 Ω error', is(run(series), 'op_led', 'pass', 'D1', /15\.8 mA/) && is(run(variant(series, setValue('R1', '10'))), 'op_led', 'error', 'D1'),
    `${show(run(series), 'op_led')} | ${show(run(variant(series, setValue('R1', '10'))), 'op_led')}`)

  // real circuits: motor current read from the value
  const m05 = run(variant(motor, setValue('J2', 'MOTOR 0.5A')))
  add('motor current from the value: 500 mA > 115 mA', is(m05, 'op_switch', 'error', 'Q1', /500 mA/) && is(run(motor), 'op_switch', 'unknown', 'Q1', /MOTOR 0\.3A/),
    `${show(m05, 'op_switch')} | ${show(run(motor), 'op_switch')}`)

  // real circuits: the gate divider loss is named for the 5 V signal
  add('gate divider loss explained', is(run(motor), 'op_drive', 'warn', 'Q1', /분압/), show(run(motor), 'op_drive'))

  // real circuits: 555 below its supply range is one fault; the LED it drives is 판단 불가
  const t3 = run(variant(timer, setValue('BT1', '3V')))
  add('555 on 3 V: LED not judged, headline counts 1', is(t3, 'op_led', 'unknown', 'D1') && operatingHeadline(t3).text === '동작 안 됨 1', `${show(t3, 'op_led')} | ${operatingHeadline(t3).text}`)

  for (const [name, ok, info] of F) check(`O12 ${name}`, ok, info)
}

// O13. findings from the second review: one circuit per finding ────────────────
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  const head = (rs: OpResult[]) => operatingHeadline(rs).text

  // series walk stops at a supply or GND net, even one with only two pins on it
  const twoLeds = circuit([['R1', 'R', '330'], ['R2', 'R', '330'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED']],
    [['+5V', 'R1.1', 'R2.1'], ['A1', 'R1.2', 'D1.1'], ['A2', 'R2.2', 'D2.1'], ['GND', 'D1.2', 'D2.2']])
  const tl = run(twoLeds)
  add('two LEDs on a two-pin rail: each 9.39 mA', is(tl, 'op_led', 'pass', 'D1', /9\.39 mA/) && is(tl, 'op_led', 'pass', 'D2', /9\.39 mA/), `${show(tl, 'op_led', 'D1')} | ${show(tl, 'op_led', 'D2')}`)
  const lowRail = circuit([['R1', 'R', '100'], ['R2', 'R', '1k'], ['D1', 'LED', 'RED']],
    [['+12V', 'R1.1'], ['A', 'R1.2', 'D1.1'], ['GND', 'D1.2', 'R2.2'], ['+3V3', 'R2.1']])
  add('walk does not cross GND to +3V3: (12 − 1.9) / 100 = 101 mA', is(run(lowRail), 'op_led', 'error', 'D1', /101 mA/), show(run(lowRail), 'op_led'))
  const bleeder = circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '680'], ['R2', 'R', '10k'], ['D1', 'LED', 'RED']],
    [['+9V', 'J1.1', 'R1.1', 'R2.1'], ['A', 'R1.2', 'D1.1'], ['GND', 'J1.2', 'D1.2', 'R2.2']])
  add('bleeder resistor does not join the LED string', is(run(bleeder), 'op_led', 'pass', 'D1', /10\.4 mA/), show(run(bleeder), 'op_led'))
  const npnLed = circuit([['R1', 'R', '330'], ['RB', 'R', '1k'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'R1.1', 'RB.1'], ['A', 'R1.2', 'D1.1'], ['K', 'D1.2', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'Q1.3']])
  add('NPN LED driver on a two-pin rail', is(run(npnLed), 'op_led', 'pass', 'D1') && is(run(npnLed), 'op_drive', 'pass', 'Q1'), `${show(run(npnLed), 'op_led')} | ${show(run(npnLed), 'op_drive')}`)
  const twoHot = circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '47'], ['R2', 'R', '47'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED']],
    [['+5V', 'J1.1', 'R1.1', 'R2.1'], ['A1', 'R1.2', 'D1.1'], ['A2', 'R2.2', 'D2.1'], ['GND', 'J1.2', 'D1.2', 'D2.2']])
  add('47 Ω per LED: 66 mA errors are not hidden', is(run(twoHot), 'op_led', 'error', 'D1', /66 mA/) && is(run(twoHot), 'op_led', 'error', 'D2', /66 mA/), `${show(run(twoHot), 'op_led', 'D1')} | ${show(run(twoHot), 'op_led', 'D2')}`)

  // a relay fed from a 555 output with its other end on GND, diode the right way round
  const t12 = variant(timer, setValue('BT1', '12V'))
  const coil555 = variant(t12, c => {
    c.components.push({ ref: 'K1', name: 'Relay', value: '12V' }, { ref: 'D9', name: 'D', value: '1N4148' })
    c.nets.find(n => n.name === 'OUT')!.nodes.push({ ref: 'K1', pin: '1' }, { ref: 'D9', pin: '2' })
    c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'K1', pin: '2' }, { ref: 'D9', pin: '1' })
  })
  const connCoil = circuit([['J1', 'Conn_01x02', 'DRV'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148']],
    [['DRIVE', 'J1.1', 'K1.1', 'D1.2'], ['GND', 'J1.2', 'K1.2', 'D1.1']])
  add('coil from 555 OUT to GND: 10.3~12 V, diode not called backwards', is(run(coil555), 'op_relay', 'pass', 'K1', /10\.3~12 V/) && is(run(connCoil), 'op_relay', 'unknown', 'K1'),
    `${show(run(coil555), 'op_relay')} | ${show(run(connCoil), 'op_relay')}`)

  // a battery terminal that goes nowhere
  const looseNeg = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED']],
    [['+9V', 'BT1.1', 'R1.1'], ['BAT_NEG', 'BT1.2'], ['LED_A', 'R1.2', 'D1.1'], ['GND', 'D1.2']])
  const ln = run(looseNeg)
  add('battery − going nowhere: error, LED not judged', is(ln, 'op_power', 'error', 'BT1', /아무 데도/) && is(ln, 'op_led', 'unknown', 'D1') && head(ln) === '동작 안 됨 1', `${show(ln, 'op_power')} | ${show(ln, 'op_led')} | ${head(ln)}`)
  const secondCell = circuit([['BT1', 'Battery', '5V'], ['BT2', 'Battery', '12V'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '12V']],
    [['+5V', 'BT1.1', 'R1.1'], ['GND', 'BT1.2', 'Q1.3'], ['V12', 'BT2.1', 'K1.1', 'D1.2'], ['BAT2_NEG', 'BT2.2'], ['BASE', 'R1.2', 'Q1.1'], ['COIL', 'K1.2', 'D1.1', 'Q1.2']])
  add('second battery with a loose −: relay not passed', is(run(secondCell), 'op_power', 'error', 'BT2') && pick(run(secondCell), 'op_relay')?.state !== 'pass', `${show(run(secondCell), 'op_power')} | ${show(run(secondCell), 'op_relay')}`)

  // a power switch on the battery − side, and a coin cell beside a USB-powered part
  const negSwitch = circuit([['BT1', 'Battery', '9V'], ['SW1', 'SW', 'POWER'], ['U1', 'REG', 'LM7805'], ['R1', 'R', '330'], ['D1', 'LED', 'RED']],
    [['VBAT', 'BT1.1', 'U1.3'], ['BAT_N', 'BT1.2', 'SW1.1'], ['GND', 'SW1.2', 'U1.1', 'D1.2'], ['+5V', 'U1.2', 'R1.1'], ['LA', 'R1.2', 'D1.1']])
  const ns = run(negSwitch)
  add('power switch on the − side: works when closed', !pick(ns, 'op_power') && is(ns, 'op_reg', 'pass', 'U1') && is(ns, 'op_led', 'pass', 'D1', /9\.39 mA/), ns.map(r => `${r.rule}:${r.state}`).join(' '))
  const coin = circuit([['J1', 'Conn_01x02', 'USB'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['BT2', 'Battery', '3V'], ['R2', 'R', '100'], ['D2', 'LED', 'RED']],
    [['+5V', 'J1.1', 'R1.1'], ['GND', 'J1.2', 'D1.2'], ['LA', 'R1.2', 'D1.1'], ['CELL_P', 'BT2.1', 'R2.1'], ['CA', 'R2.2', 'D2.1'], ['CELL_N', 'BT2.2', 'D2.2']])
  const cn = run(coin)
  add('separate coin cell beside a USB part: no error', !pick(cn, 'op_power') && is(cn, 'op_led', 'pass', 'D1') && is(cn, 'op_led', 'pass', 'D2'), cn.map(r => `${r.rule}/${r.ref}:${r.state}`).join(' '))

  // "does it light" uses the maximum forward voltage
  const lowSeries = circuit([['BT1', 'Battery', '4.5V'], ['R1', 'R', '47'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'R1.1'], ['A1', 'R1.2', 'D1.1'], ['MID', 'D1.2', 'D2.1'], ['GND', 'BT1.2', 'D2.2']])
  const dim = circuit([['BT1', 'Battery', '3V'], ['R1', 'R', '1k'], ['D1', 'LED', 'RED']], [['VCC', 'BT1.1', 'R1.1'], ['GND', 'BT1.2', 'D1.2'], ['LA', 'R1.2', 'D1.1']])
  add('2 × 2.3 V > 4.5 V may not light; 0.7 mA is dim', is(run(lowSeries), 'op_led', 'warn', 'D1', /켜지지 않을 수/) && is(run(dim), 'op_led', 'warn', 'D1', /어둡/),
    `${show(run(lowSeries), 'op_led')} | ${show(run(dim), 'op_led')}`)

  // one fault counts once
  const backwards = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED']],
    [['GND', 'BT1.1', 'D1.2'], ['+9V', 'BT1.2', 'R1.1'], ['LED_A', 'R1.2', 'D1.1']])
  const midRev = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED'], ['D3', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'R1.1'], ['A1', 'R1.2', 'D1.1'], ['M1', 'D1.2', 'D2.2'], ['M2', 'D2.1', 'D3.1'], ['GND', 'BT1.2', 'D3.2']])
  const hotNpn = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '10'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '1k']],
    [['VCC', 'BT1.1', 'R1.1', 'RB.1'], ['LA', 'R1.2', 'D1.1'], ['LK', 'D1.2', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'BT1.2', 'Q1.3']])
  const mr = run(midRev)
  add('reversed battery / middle LED reversed / LED overload on a switch: each counts 1',
    head(run(backwards)) === '동작 안 됨 1' && head(mr) === '동작 안 됨 1' && is(mr, 'op_led', 'error', 'D2', /앞뒤/) && head(run(hotNpn)) === '동작 안 됨 1',
    `${head(run(backwards))} | ${head(mr)} ${show(mr, 'op_led')} | ${head(run(hotNpn))}`)

  // VCEO also for a motor with a fixed current
  const motor48 = circuit([['J1', 'Conn_01x03', 'PWR_IN'], ['J2', 'Conn_01x02', 'MOTOR 50mA'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148']],
    [['+48V', 'J1.1', 'J2.1', 'D1.2'], ['+5V', 'R1.1'], ['GND', 'J1.3', 'Q1.3'], ['BASE', 'R1.2', 'Q1.1'], ['COL', 'J2.2', 'Q1.2', 'D1.1']])
  add('48 V motor on a 40 V transistor', is(run(motor48), 'op_switch', 'error', 'Q1', /VCEO/), show(run(motor48), 'op_switch'))

  // regulator short of input: what it feeds is not judged at its nominal output
  const short = circuit([['BT1', 'Battery', '3.7V'], ['U1', 'REG', 'AMS1117-5.0'], ['C1', 'CP', '22uF'], ['R1', 'R', '470'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '5V']],
    [['VIN', 'BT1.1', 'U1.3'], ['GND', 'BT1.2', 'U1.1', 'C1.2', 'Q1.3'], ['+5V', 'U1.2', 'C1.1', 'K1.1', 'D1.2', 'R1.1'], ['BASE', 'R1.2', 'Q1.1'], ['COIL', 'K1.2', 'D1.1', 'Q1.2']])
  const sh = run(short)
  add('regulator short of input: relay not passed, counted once', is(sh, 'op_reg', 'error', 'U1') && pick(sh, 'op_relay')?.state !== 'pass' && head(sh) === '동작 안 됨 1',
    `${show(sh, 'op_relay')} | ${head(sh)}`)

  // regulator output pin on a connector rail: swapped
  const swapped = circuit([['J1', 'Conn_01x02', 'PWR'], ['U1', 'REG', 'LM7805'], ['R1', 'R', '330'], ['D1', 'LED', 'RED']],
    [['+12V', 'J1.1', 'U1.2', 'R1.1'], ['GND', 'J1.2', 'U1.1', 'D1.2'], ['+5V', 'U1.3'], ['LA', 'R1.2', 'D1.1']])
  add('regulator on a connector rail, pins swapped', is(run(swapped), 'op_reg', 'error', 'U1', /바뀐/) && is(run(swapped), 'op_led', 'error', 'D1', /30\.6 mA/),
    `${show(run(swapped), 'op_reg')} | ${show(run(swapped), 'op_led')}`)

  // a rail named +5V behind a power switch from a 9 V battery: the name is wrong, not a short
  const swRail = circuit([['BT1', 'Battery', '9V'], ['SW1', 'SW', 'POWER'], ['R1', 'R', '150'], ['D1', 'LED', 'RED']],
    [['BAT', 'BT1.1', 'SW1.1'], ['+5V', 'SW1.2', 'R1.1'], ['GND', 'BT1.2', 'D1.2'], ['LED_A', 'R1.2', 'D1.1']])
  const sr = run(swRail)
  add('wrong rail name behind a switch', !pick(sr, 'op_short') && is(sr, 'op_power', 'error', undefined, /\+5V/) && is(sr, 'op_led', 'error', 'D1', /47\.3 mA/),
    sr.map(r => `${r.rule}:${r.state}`).join(' '))

  // 555 RESET pulled up to its own VCC from a connector; RESET held low until a button closes
  const connTimer = variant(timer, c => { c.components.find(x => x.ref === 'BT1')!.name = 'Conn_01x02'; c.components.find(x => x.ref === 'BT1')!.value = 'PWR' })
  const rstPull = variant(variant(connTimer, movePin('U1.4', 'RST')), c => {
    c.components.push({ ref: 'R4', name: 'R', value: '10k' })
    c.nets.find(n => n.name === 'VCC')!.nodes.push({ ref: 'R4', pin: '1' })
    c.nets.find(n => n.name === 'RST')!.nodes.push({ ref: 'R4', pin: '2' })
  })
  const rstButton = variant(variant(timer, movePin('U1.4', 'RST')), c => {
    c.components.push({ ref: 'R4', name: 'R', value: '10k' }, { ref: 'SW1', name: 'SW', value: 'RUN' })
    c.nets.find(n => n.name === 'RST')!.nodes.push({ ref: 'R4', pin: '1' }, { ref: 'SW1', pin: '1' })
    c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'R4', pin: '2' })
    c.nets.find(n => n.name === 'VCC')!.nodes.push({ ref: 'SW1', pin: '2' })
  })
  add('555 RESET: pull-up to its own VCC is fine, a button-held RESET says so',
    !/RESET/.test(pick(run(rstPull), 'op_555')!.summary) && is(run(rstButton), 'op_555', 'warn', 'U1', /SW1 스위치/),
    `${show(run(rstPull), 'op_555')} | ${show(run(rstButton), 'op_555')}`)

  // 555 RA of 0 Ω; CTRL on a lower rail
  const ra0 = run(variant(timer, setValue('R1', '0')))
  const ctl5 = variant(t12, c => {
    c.components.push({ ref: 'U2', name: 'REG', value: 'LM7805' })
    movePin('U1.5', '+5V')(c)
    c.nets.find(n => n.name === '+5V')!.nodes.push({ ref: 'U2', pin: '2' })
    c.nets.find(n => n.name === 'VCC')!.nodes.push({ ref: 'U2', pin: '3' })
    c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'U2', pin: '1' })
  })
  add('555 RA 0 Ω is an error, CTRL on 5 V is a warning', is(ra0, 'op_555', 'error', 'U1', /0 Ω RA/) && is(run(ctl5), 'op_555', 'warn', 'U1', /CTRL/),
    `${show(ra0, 'op_555')} | ${show(run(ctl5), 'op_555')}`)

  // flyback: a mechanical switch is a warning; a diode across resistor and coil protects the transistor
  const mech = circuit([['BT1', 'Battery', '9V'], ['SW1', 'SW', 'PUSH'], ['J2', 'Conn_01x02', 'MOTOR 0.2A']],
    [['+9V', 'BT1.1', 'J2.1'], ['M', 'J2.2', 'SW1.1'], ['GND', 'BT1.2', 'SW1.2']])
  const wideD = circuit([['J1', 'Conn_01x02', 'PWR'], ['RS', 'R', '100'], ['K1', 'Relay', '5V'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '1k'], ['D1', 'D', '1N4148']],
    [['+12V', 'J1.1', 'RS.1', 'D1.2'], ['KTOP', 'RS.2', 'K1.1'], ['COIL', 'K1.2', 'Q1.2', 'D1.1'], ['+5V', 'RB.1'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'J1.2', 'Q1.3']])
  add('flyback: mechanical switch warns, diode around resistor + coil passes', pick(run(mech), 'op_flyback')?.state !== 'error' && is(run(wideD), 'op_flyback', 'pass'),
    `${show(run(mech), 'op_flyback')} | ${show(run(wideD), 'op_flyback')}`)

  // sense resistor in the source lowers VGS
  const senseR = circuit([['J1', 'Conn_01x02', 'PWR'], ['RL', 'R', '47'], ['RS', 'R', '1'], ['Q1', 'Q_NMOS', 'NDS7002A']],
    [['+5V', 'J1.1', 'RL.1', 'Q1.1'], ['GND', 'J1.2', 'RS.2'], ['D', 'RL.2', 'Q1.2'], ['S', 'Q1.3', 'RS.1']])
  add('1 Ω source resistor: VGS 4.89 V < 5 V', is(run(senseR), 'op_drive', 'warn', 'Q1', /4\.89 V/), show(run(senseR), 'op_drive'))

  // no series resistor is an error whatever the supply voltage; 555 straight into a base likewise
  const bareLed = circuit([['J1', 'Conn_01x02', 'PWR'], ['D1', 'LED', 'RED']], [['VCC', 'J1.1', 'D1.1'], ['GND', 'J1.2', 'D1.2']])
  const outBaseConn = variant(connTimer, c => { c.components.push({ ref: 'Q1', name: 'Q_NPN', value: '2N3904' }); movePin('Q1.1', 'OUT')(c); movePin('Q1.3', 'GND')(c); movePin('Q1.2', 'NC1')(c) })
  add('no resistor with an unknown supply is still an error', is(run(bareLed), 'op_led', 'error', 'D1', /직렬 저항이 없어/) && is(run(outBaseConn), 'op_drive', 'error', 'Q1', /저항 없이/),
    `${show(run(bareLed), 'op_led')} | ${show(run(outBaseConn), 'op_drive')}`)

  // KiCad ground names
  const gndd = variant(timer, c => { c.nets.find(n => n.name === 'GND')!.name = 'GNDD' })
  add('GNDD is ground', is(run(gndd), 'op_555', 'pass', 'U1'), show(run(gndd), 'op_555'))

  // text: no Infinity/NaN, no "0 mA < 0 mA", limits that read differently, values shown
  const c0 = run(variant(timer, setValue('C1', '0uF')))
  const weakBase = circuit([['J1', 'Conn_01x02', 'PWR'], ['RB', 'R', '1k'], ['RC', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'J1.1', 'RC.1'], ['+0.5V', 'RB.1'], ['BASE', 'RB.2', 'Q1.1'], ['COL', 'RC.2', 'Q1.2'], ['GND', 'J1.2', 'Q1.3']])
  const rsum = run(variant(variant(variant(timer, setValue('BT1', '5V')), setValue('R1', '1k')), setValue('R2', '3.4M')))
  const vceo = circuit([['J1', 'Conn_01x02', 'PWR'], ['RC', 'R', '10k'], ['RB', 'R', '10k'], ['Q1', 'Q_NPN', '2N3904']],
    [['+40.04V', 'J1.1', 'RC.1'], ['+5V', 'RB.1'], ['BASE', 'RB.2', 'Q1.1'], ['COL', 'RC.2', 'Q1.2'], ['GND', 'J1.2', 'Q1.3']])
  const noVal = run(circuit([['BT1', 'Battery', '9V'], ['U2', 'REG', '']], [['VIN', 'BT1.1', 'U2.3'], ['GND', 'BT1.2', 'U2.1'], ['OUT', 'U2.2']]))
  add('text: 0 µF, no base current, 3.401 MΩ, 40.04 V, empty value', !/Infinity|NaN/.test(c0.map(r => r.summary).join(' ')) &&
    is(run(weakBase), 'op_drive', 'error', 'Q1', /흐르지 않습니다/) && is(rsum, 'op_555', 'warn', 'U1', /3\.401 MΩ > 최대 3\.4 MΩ/) &&
    is(run(vceo), 'op_switch', 'error', 'Q1', /40\.04 V ≥ VCEO 40 V/) && is(noVal, 'op_reg', 'unknown', 'U2', /값 없음/),
    `${show(c0, 'op_555')} | ${show(run(weakBase), 'op_drive')} | ${show(rsum, 'op_555')} | ${show(run(vceo), 'op_switch')} | ${show(noVal, 'op_reg')}`)

  // malformed input does not crash
  let crash = ''
  try {
    operatingChecks(fromGraph({ components: [{ ref: 'R1', name: 'R', value: 680 as unknown as string }], nets: [{ name: 'X' } as unknown as NetGraph['nets'][number]] }))
    operatingChecks(fromBoard({ parts: undefined } as unknown as BoardModel))
    operatingChecks(fromBoard({ parts: [{ ref: 'R1', part: 'R', value: '1k', pad_pins: {} }] } as unknown as BoardModel))
  } catch (e) { crash = String(e) }
  add('malformed graph and board do not crash', !crash, crash)

  for (const [name, ok, info] of F) check(`O13 ${name}`, ok, info)
}

// O15. findings from the third review: one circuit per finding ─────────────────
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  const head = (rs: OpResult[]) => operatingHeadline(rs).text
  const all = (rs: OpResult[]) => rs.map(r => `${r.rule}/${r.ref}:${r.state}`).join(' ')

  // crash: a battery between a connector rail and a net a switch ties to GND (the walk back from GND stopped at the rail)
  const railSwitch = circuit([['BT1', 'Battery', '3.7V'], ['J1', 'Conn_01x02', 'PWR'], ['SW1', 'SW', 'PUSH'], ['R1', 'R', '1k']],
    [['+3.3V', 'BT1.1', 'J1.1', 'SW1.1'], ['N6', 'BT1.2', 'J1.2'], ['GND', 'SW1.2', 'R1.1'], ['X', 'R1.2']])
  const rsw = run(railSwitch)
  add('battery on a connector rail with a switch to GND: no crash', !pick(rsw, 'op_data') && is(rsw, 'op_power', 'error', 'BT1', /GND/), `${all(rsw)} ${show(rsw, 'op_power')}`)

  // the order parts and pins are listed in does not change any answer
  const twoButtons = circuit([['J1', 'Conn_01x02', 'PWR'], ['SW1', 'SW', 'UP'], ['SW2', 'SW', 'DOWN'], ['R1', 'R', '4.7k']],
    [['+5V', 'J1.1', 'SW1.1'], ['N1', 'SW1.2', 'SW2.1', 'R1.1'], ['GND', 'J1.2', 'SW2.2', 'R1.2']])
  const chain = circuit([['BT1', 'Battery', '3.7V'], ['BT2', 'Battery', '9V'], ['R1', 'R', '1k']],
    [['GNDA', 'BT2.1', 'R1.1'], ['+12V', 'BT2.2', 'BT1.1'], ['+9V', 'BT1.2', 'R1.2']])
  const orderDiff = [twoButtons, chain, railSwitch, relay, timer, motor].filter(g => full(run(g)) !== full(run(reversed(g))))
  add('listing order does not change the answer', orderDiff.length === 0, orderDiff.map(g => `${full(run(g))} ≠ ${full(run(reversed(g)))}`).join(' || ').slice(0, 600))

  // a motor on a connector is a load, not a supply: the 12 V behind the switch reaches the rail named +9V
  const motorRail = circuit([['BT1', 'Battery', '12V'], ['SW1', 'SW', 'POWER'], ['J2', 'Conn_01x02', 'MOTOR 0.2A'], ['D1', 'D', '1N4148'], ['R1', 'R', '330'], ['D2', 'LED', 'RED']],
    [['VBAT', 'BT1.1', 'SW1.1'], ['+9V', 'SW1.2', 'J2.1', 'D1.2', 'R1.1'], ['GND', 'BT1.2', 'J2.2', 'D1.1', 'D2.2'], ['LA', 'R1.2', 'D2.1']])
  const mr = run(motorRail)
  add('motor connector does not make a rail: wrong name, not a short; LED at 12 V', !pick(mr, 'op_short') && is(mr, 'op_power', 'error', undefined, /\+9V/) &&
    is(mr, 'op_led', 'error', 'D2', /30\.6 mA/), `${all(mr)} | ${show(mr, 'op_led')}`)

  // flyback with a mechanical switch: the diode's cathode goes to the higher end, wherever the switch is
  const hiSw = (d: [string, string]) => circuit([['BT1', 'Battery', '9V'], ['SW1', 'SW', 'POWER'], ['J2', 'Conn_01x02', 'MOTOR 0.2A'], ['D1', 'D', '1N4148']],
    [['+9V', 'BT1.1', 'SW1.1'], ['X', 'SW1.2', 'J2.1', d[1]], ['GND', 'BT1.2', 'J2.2', d[0]]])
  const good = run(hiSw(['D1.1', 'D1.2'])), shorting = run(hiSw(['D1.2', 'D1.1']))
  const negSw = run(circuit([['BT1', 'Battery', '9V'], ['SW1', 'SW', 'POWER'], ['J2', 'Conn_01x02', 'MOTOR 0.2A'], ['D1', 'D', '1N4148']],
    [['VBAT', 'BT1.1', 'J2.1', 'D1.2'], ['BN', 'BT1.2', 'SW1.1'], ['GND', 'SW1.2', 'J2.2', 'D1.1']]))
  const hiRelay = run(circuit([['J1', 'Conn_01x02', 'PWR'], ['SW1', 'SW', 'BTN'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148']],
    [['+5V', 'J1.1', 'SW1.1'], ['KH', 'SW1.2', 'K1.1', 'D1.2'], ['GND', 'J1.2', 'K1.2', 'D1.1']]))
  // a diode across the battery does not protect a motor behind a high-side switch
  const acrossBat = run(circuit([['BT1', 'Battery', '9V'], ['SW1', 'SW', 'POWER'], ['J2', 'Conn_01x02', 'MOTOR 0.2A'], ['D1', 'D', '1N4148']],
    [['+9V', 'BT1.1', 'SW1.1', 'D1.2'], ['X', 'SW1.2', 'J2.1'], ['GND', 'BT1.2', 'J2.2', 'D1.1']]))
  add('flyback: high-side and battery-side switches, cathode to the higher end',
    is(good, 'op_flyback', 'pass', 'J2') && is(shorting, 'op_flyback', 'error', 'J2', /거꾸로/) && is(negSw, 'op_flyback', 'pass', 'J2') &&
    is(hiRelay, 'op_flyback', 'pass', 'K1') && is(acrossBat, 'op_flyback', 'warn', 'J2', /보호 다이오드가 없습니다/),
    [good, shorting, negSw, hiRelay, acrossBat].map(r => show(r, 'op_flyback')).join(' | '))

  // a loose battery terminal only takes away nets nothing else feeds
  const coinOnUsb = run(circuit([['J1', 'Conn_01x02', 'USB'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['BT1', 'Battery', '3V']],
    [['+5V', 'J1.1', 'R1.1'], ['GND', 'J1.2', 'D1.2', 'BT1.2'], ['LA', 'R1.2', 'D1.1'], ['CELL', 'BT1.1']]))
  add('loose coin cell on a USB board: the USB part is still judged', is(coinOnUsb, 'op_power', 'error', 'BT1') && is(coinOnUsb, 'op_led', 'pass', 'D1', /9\.39 mA/) &&
    head(coinOnUsb) === '동작 안 됨 1', `${all(coinOnUsb)} | ${head(coinOnUsb)}`)

  // a regulator with no power in gives no output: what it feeds is not judged at its nominal voltage
  const deadReg = run(circuit([['BT1', 'Battery', '9V'], ['U1', 'REG', 'LM7805'], ['C1', 'CP', '22uF'], ['R1', 'R', '68'], ['D1', 'LED', 'RED']],
    [['VIN', 'BT1.1', 'U1.3'], ['BN', 'BT1.2'], ['GND', 'U1.1', 'C1.2', 'D1.2'], ['VOUT', 'U1.2', 'C1.1', 'R1.1'], ['LA', 'R1.2', 'D1.1']]))
  const swReg = run(circuit([['J1', 'Conn_01x02', 'PWR'], ['SW1', 'SW', 'POWER'], ['U1', 'REG', 'LM7805'], ['C1', 'CP', '22uF'], ['R1', 'R', '100'], ['D1', 'LED', 'RED']],
    [['+3.3V', 'J1.1', 'SW1.1'], ['VSW', 'SW1.2', 'U1.3'], ['GND', 'J1.2', 'U1.1', 'C1.2', 'D1.2'], ['VOUT', 'U1.2', 'C1.1', 'R1.1'], ['LA', 'R1.2', 'D1.1']]))
  add('regulator on a dead battery: LED not judged; short of input: a fault behind it still counts',
    is(deadReg, 'op_led', 'unknown', 'D1') && head(deadReg) === '동작 안 됨 1' && is(swReg, 'op_reg', 'error', 'U1', /유지하지 못합니다/) &&
    // with enough input the 7805 gives 5 V and the 100 Ω LED takes (5 − 1.9) ÷ 100 = 31 mA: a fault of its own
    is(swReg, 'op_led', 'error', 'D1', /31 mA/) && !pick(swReg, 'op_led', 'D1')?.cause && head(swReg) === '동작 안 됨 2',
    `${all(deadReg)} ${head(deadReg)} | ${all(swReg)} ${head(swReg)}`)

  // a button to GND with a pull-up is an input that is low only while pressed, not a pin tied to GND
  const resetButton = variant(variant(timer, movePin('U1.4', 'RST')), c => {
    c.components.push({ ref: 'R4', name: 'R', value: '10k' }, { ref: 'SW1', name: 'SW', value: 'STOP' })
    c.nets.find(n => n.name === 'RST')!.nodes.push({ ref: 'R4', pin: '2' }, { ref: 'SW1', pin: '1' })
    c.nets.find(n => n.name === 'VCC')!.nodes.push({ ref: 'R4', pin: '1' })
    c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'SW1', pin: '2' })
  })
  const rb = run(resetButton)
  const offButton = run(circuit([['J1', 'Conn_01x02', 'PWR'], ['RB', 'R', '4.7k'], ['SW1', 'SW', 'OFF'], ['Q1', 'Q_NPN', '2N3904'], ['RL', 'R', '330'], ['D1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'RB.1', 'RL.1'], ['BASE', 'RB.2', 'SW1.1', 'Q1.1'], ['GND', 'J1.2', 'SW1.2', 'Q1.3'], ['LA', 'RL.2', 'D1.1'], ['LK', 'D1.2', 'Q1.2']]))
  const viaInput = run(circuit([['J1', 'Conn_01x02', 'PWR'], ['RP', 'R', '10k'], ['SW1', 'SW', 'BTN'], ['RB', 'R', '4.7k'], ['Q1', 'Q_NPN', '2N3904'], ['RL', 'R', '330'], ['D1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'RP.1', 'RL.1'], ['IN', 'RP.2', 'SW1.1', 'RB.1'], ['GND', 'J1.2', 'SW1.2', 'Q1.3'], ['BASE', 'RB.2', 'Q1.1'], ['LA', 'RL.2', 'D1.1'], ['LK', 'D1.2', 'Q1.2']]))
  const shunt = run(circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['SW1', 'SW', 'BTN']],
    [['+5V', 'J1.1', 'R1.1'], ['X', 'R1.2', 'D1.1', 'SW1.1'], ['GND', 'J1.2', 'D1.2', 'SW1.2']]))
  const pressOn = run(circuit([['J1', 'Conn_01x02', 'PWR'], ['SW1', 'SW', 'BTN'], ['RP', 'R', '10k'], ['Q1', 'Q_NMOS', '2N7002'], ['RL', 'R', '330'], ['D1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'SW1.1', 'RL.1'], ['G', 'SW1.2', 'RP.1', 'Q1.1'], ['GND', 'J1.2', 'RP.2', 'Q1.3'], ['LA', 'RL.2', 'D1.1'], ['LK', 'D1.2', 'Q1.2']]))
  add('button to GND with a pull-up: 555 reset button, press-to-off base, LED shorted by a button',
    is(rb, 'op_555', 'pass', 'U1', /0\.986 Hz/) && is(offButton, 'op_drive', 'pass', 'Q1') && is(viaInput, 'op_drive', 'unknown', 'Q1', /SW1/) &&
    is(shunt, 'op_led', 'pass', 'D1', /8\.18~9\.39 mA/) && is(pressOn, 'op_drive', 'pass', 'Q1'),
    [show(rb, 'op_555'), show(offButton, 'op_drive'), show(viaInput, 'op_drive'), show(shunt, 'op_led'), show(pressOn, 'op_drive')].join(' | '))

  // math: the source resistor's drop adds to the switch's: 3.95 − (3 Ω × 62.7 mA ÷ 1.048 + 1 Ω × 62.7 mA) = 3.71 V < 3.75 V
  const senseRelay = run(circuit([['J1', 'Conn_01x03', 'PWR'], ['Q1', 'Q_NMOS', 'NDS7002A'], ['RS', 'R', '1'], ['D1', 'D', '1N4148'], ['K1', 'Relay', '5V']],
    [['+3.95V', 'J1.1', 'K1.1', 'D1.2'], ['+12V', 'J1.2', 'Q1.1'], ['GND', 'J1.3', 'RS.2'], ['S', 'Q1.3', 'RS.1'], ['COIL', 'Q1.2', 'K1.2', 'D1.1']]))
  add('sense resistor drop counted in the coil voltage', is(senseRelay, 'op_relay', 'error', 'K1', /3\.71 V < 동작 전압 3\.75 V/), show(senseRelay, 'op_relay'))

  // a coil from VCC to the 555 output (the output sinks it): neither pin order calls the flyback diode backwards
  const sinkCoil = (coilOnOut: string, coilOnVcc: string) => variant(variant(timer, setValue('BT1', '12V')), c => {
    c.components.push({ ref: 'K1', name: 'Relay', value: '12V' }, { ref: 'D9', name: 'D', value: '1N4148' })
    c.nets.find(n => n.name === 'OUT')!.nodes.push({ ref: 'K1', pin: coilOnOut }, { ref: 'D9', pin: '1' })
    c.nets.find(n => n.name === 'VCC')!.nodes.push({ ref: 'K1', pin: coilOnVcc }, { ref: 'D9', pin: '2' })
  })
  const sk1 = run(sinkCoil('1', '2')), sk2 = run(sinkCoil('2', '1'))
  add('coil sunk by a 555 output: not an error, same in either pin order', is(sk1, 'op_relay', 'unknown', 'K1') && is(sk2, 'op_relay', 'unknown', 'K1') &&
    is(sk1, 'op_flyback', 'pass', 'K1'), `${show(sk1, 'op_relay')} | ${show(sk2, 'op_relay')}`)

  // one fault counts once even two steps away: battery backwards → LED reversed → transistor gets no base current
  const revChain = run(circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '1k']],
    [['GND', 'BT1.1', 'Q1.3'], ['+9V', 'BT1.2', 'R1.1', 'RB.1'], ['LA', 'R1.2', 'D1.1'], ['LK', 'D1.2', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1']]))
  const err = (rule: OpRule, ref: string, cause?: string): OpResult => ({ rule, ref, state: 'error', summary: ref, detail: ['x'], ...(cause ? { cause } : {}) })
  const loop = operatingHeadline([err('op_led', 'D1', 'Q1'), err('op_drive', 'Q1', 'D1'), err('op_power', 'BT1')]).text
  const deep = operatingHeadline([err('op_power', 'BT1'), err('op_led', 'D1', 'BT1'), err('op_drive', 'Q1', 'D1'), err('op_switch', 'Q2', 'Q1')]).text
  add('cause chains and loops count once', head(revChain) === '동작 안 됨 1' && loop === '동작 안 됨 2' && deep === '동작 안 됨 1' &&
    !!pick(revChain, 'op_drive')?.detail.some(d => /BT1 전원 전압 문제에서 이어진/.test(d)), `${head(revChain)} | ${loop} | ${deep} | ${pick(revChain, 'op_drive')?.detail[0]}`)

  // text: particles after part names and values, no "null" for an open pin
  const noD = run(variant(relay, c => { c.components = c.components.filter(x => x.ref !== 'D1'); c.nets.forEach(n => { n.nodes = n.nodes.filter(x => x.ref !== 'D1') }) }))
  const emptyRb = run(circuit([['J1', 'Conn_01x02', 'PWR'], ['RB', 'R', ''], ['RC', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'J1.1', 'RC.1', 'RB.1'], ['BASE', 'RB.2', 'Q1.1'], ['COL', 'RC.2', 'Q1.2'], ['GND', 'J1.2', 'Q1.3']]))
  const senseR3 = run(circuit([['J1', 'Conn_01x02', 'PWR'], ['RL', 'R', '47'], ['R3', 'R', '1'], ['Q1', 'Q_NMOS', 'NDS7002A']],
    [['+5V', 'J1.1', 'RL.1', 'Q1.1'], ['GND', 'J1.2', 'R3.2'], ['D', 'RL.2', 'Q1.2'], ['S', 'Q1.3', 'R3.1']]))
  const openCoil = run(circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['K1', 'Relay', '5V']],
    [['+5V', 'J1.1', 'R1.1'], ['BASE', 'R1.2', 'Q1.1'], ['COIL', 'Q1.2', 'K1.2'], ['GND', 'J1.2', 'Q1.3']]))
  const texts = [show(noD, 'op_flyback'), pick(run(timer), 'op_555')!.detail.join(' '), show(emptyRb, 'op_drive'), show(senseR3, 'op_drive'), show(openCoil, 'op_switch')]
  add('text: Q1을, MΩ과, (값 없음)을, R3으로, no null', /Q1을 망가뜨릴/.test(texts[0]) && /3\.4 MΩ과 15 V/.test(texts[1]) && /\(값 없음\)을 읽지/.test(texts[2]) &&
    /감지 저항 R3으로/.test(texts[3]) && /전원 쪽 핀 연결 없음/.test(texts[4]) && !/null/.test(texts.join(' ')), texts.map(t => t.slice(0, 120)).join(' | '))

  // battery values written as a cell voltage times a count
  const cells: [string, number | null][] = [['1.5V x4', 6], ['3.7V×2', 7.4], ['1.5V x4 AA', 6], ['2x1.5V', 3], ['12V2A', 12], ['12V x 2A', 12], ['9V', 9]]
  const misread = cells.filter(([s, v]) => !near(parseVolts(s), v))
  add('"1.5V x4" is 6 V', misread.length === 0, misread.map(([s]) => `${s} → ${parseVolts(s)}`).join(', '))

  for (const [name, ok, info] of F) check(`O15 ${name}`, ok, info)
}

// O16. gaps the third review left open: one circuit per item ──────────────────
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  const G: NetGraph[] = []
  const op = (g: NetGraph) => { G.push(g); return run(g) }

  // a MOSFET has to stand the load supply across drain and source once it turns off (VDSS 60 V, like a BJT's VCEO)
  const highV = (v: string) => circuit([['J1', 'Conn_01x02', 'PWR'], ['BT1', 'Battery', v], ['RL', 'R', '10k'], ['RG', 'R', '100'], ['RP', 'R', '100k'], ['Q1', 'Q_NMOS', '2N7002']],
    [['+5V', 'J1.1', 'RG.1'], ['VH', 'BT1.1', 'RL.1'], ['GND', 'J1.2', 'BT1.2', 'RP.2', 'Q1.3'], ['G', 'RG.2', 'RP.1', 'Q1.1'], ['D', 'RL.2', 'Q1.2']])
  const v60 = op(highV('60V')), v48 = op(highV('48V'))
  add('MOSFET drain: 60 V supply ≥ VDSS 60 V is an error, 48 V passes', is(v60, 'op_switch', 'error', 'Q1', /60 V ≥ VDSS 60 V/) && is(v48, 'op_switch', 'pass', 'Q1'),
    `${show(v60, 'op_switch')} | ${show(v48, 'op_switch')}`)

  // battery → resistor → switch → LED: the series walk goes on through the closed switch
  const swLed = op(circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['SW1', 'SW', 'ON'], ['D1', 'LED', 'RED']],
    [['VBAT', 'BT1.1', 'R1.1'], ['N1', 'R1.2', 'SW1.1'], ['N2', 'SW1.2', 'D1.1'], ['GND', 'BT1.2', 'D1.2']]))
  // and on to a transistor below the LED
  const swQ = op(circuit([['J1', 'Conn_01x02', 'PWR'], ['RL', 'R', '330'], ['D1', 'LED', 'RED'], ['SW1', 'SW', 'ON'], ['RB', 'R', '4.7k'], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'J1.1', 'RL.1', 'RB.1'], ['LA', 'RL.2', 'D1.1'], ['LK', 'D1.2', 'SW1.1'], ['COL', 'SW1.2', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'J1.2', 'Q1.3']]))
  // two LEDs on one resistor, one of them behind a switch: with the switch open the other takes all 31 mA, never the 15.5 mA average
  const swPair = op(circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '100'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED'], ['SW1', 'SW', 'ON']],
    [['+5V', 'J1.1', 'R1.1'], ['X', 'R1.2', 'D1.1', 'D2.1'], ['Z', 'D2.2', 'SW1.1'], ['GND', 'J1.2', 'D1.2', 'SW1.2']]))
  const ledOf = (rs: OpResult[]) => rs.filter(r => r.rule === 'op_led')
  add('LED behind a closed switch: judged through it, the switch shown, the share of a switched LED counted on the others',
    is(swLed, 'op_led', 'pass', 'D1', /10\.4 mA/) && !!pick(swLed, 'op_led', 'D1')?.detail.some(d => /SW1.*닫힌 것으로/.test(d)) &&
    is(swQ, 'op_led', 'pass', 'D1') && is(swQ, 'op_switch', 'pass', 'Q1') &&
    is(swPair, 'op_led', 'error', 'D1', /31 mA ≥ 최대 30 mA/) && !ledOf(swPair).some(r => r.state === 'pass'),
    `${show(swLed, 'op_led')} | ${show(swQ, 'op_led')} | ${show(swQ, 'op_switch')} | ${ledOf(swPair).map(r => `${r.state}: ${r.summary}`).join(' / ')}`)

  // relay contacts (COM–NO) carry a voltage like a closed switch: a motor on them needs a flyback diode too
  const relayMotor = (diode: [string, string] | null, value = 'MOTOR 0.2A') => circuit([
    ['J1', 'Conn_01x02', 'PWR'], ['BT1', 'Battery', '12V'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'],
    ['J2', 'Conn_01x02', value], ...(diode ? [['D2', 'D', '1N4148'] as Comp] : [])],
  [['+5V', 'J1.1', 'K1.1', 'D1.2', 'RB.1'], ['COIL', 'K1.2', 'D1.1', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'J1.2', 'BT1.2', 'Q1.3', 'J2.2', ...(diode ? [diode[0]] : [])],
    ['VBAT', 'BT1.1', 'K1.3'], ['M', 'K1.4', 'J2.1', ...(diode ? [diode[1]] : [])]])
  const rmNone = op(relayMotor(null)), rmGood = op(relayMotor(['D2.1', 'D2.2'])), rmBad = op(relayMotor(['D2.2', 'D2.1']))
  // an LED behind the contacts, and a 555 reset that the contacts pull low against a pull-up (not "tied to GND")
  const relayLed = op(circuit([['J1', 'Conn_01x02', 'PWR'], ['K1', 'Relay', '5V'], ['R1', 'R', '330'], ['D1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'R1.1', 'K1.1'], ['C', 'R1.2', 'K1.3'], ['NO', 'K1.4', 'D1.1'], ['GND', 'J1.2', 'D1.2', 'K1.2']]))
  const relayReset = op(variant(variant(timer, movePin('U1.4', 'RST')), c => {
    c.components.push({ ref: 'R4', name: 'R', value: '10k' }, { ref: 'K2', name: 'Relay', value: '5V' })
    c.nets.find(n => n.name === 'RST')!.nodes.push({ ref: 'R4', pin: '2' }, { ref: 'K2', pin: '4' })
    c.nets.find(n => n.name === 'VCC')!.nodes.push({ ref: 'R4', pin: '1' }, { ref: 'K2', pin: '1' })
    c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'K2', pin: '3' }, { ref: 'K2', pin: '2' })
  }))
  add('relay contacts carry like a closed switch: motor flyback warns/passes/errors, LED judged, pulled-up reset not tied',
    is(rmNone, 'op_flyback', 'warn', 'J2', /보호 다이오드가 없습니다/) && !!pick(rmNone, 'op_flyback', 'J2')?.detail.some(d => /K1 접점/.test(d)) &&
    is(rmGood, 'op_flyback', 'pass', 'J2') && is(rmBad, 'op_flyback', 'error', 'J2', /거꾸로/) &&
    is(relayLed, 'op_led', 'pass', 'D1', /9\.39 mA/) && !!pick(relayLed, 'op_led', 'D1')?.detail.some(d => /K1 접점은 닫힌 것으로/.test(d)) &&
    is(relayReset, 'op_555', 'pass', 'U1') && !!pick(relayReset, 'op_555', 'U1')?.detail.some(d => /K2 접점이 닫혀 있는 동안/.test(d)),
    [show(rmNone, 'op_flyback', 'J2'), show(rmGood, 'op_flyback', 'J2'), show(rmBad, 'op_flyback', 'J2'), show(relayLed, 'op_led'), show(relayReset, 'op_555')].join(' | '))

  // a relay pulls in before its contacts close: a coil fed only through its own NO contact never starts, and a
  // latch contact across a weak transistor does not make the first pull-in good
  const selfFed = op(circuit([['J1', 'Conn_01x02', 'PWR'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'J1.1', 'K1.3', 'RB.1'], ['KH', 'K1.4', 'K1.1', 'D1.2'], ['COIL', 'K1.2', 'D1.1', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'J1.2', 'Q1.3']]))
  const latch = (rb: string) => op(circuit([['J1', 'Conn_01x02', 'PWR'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['RB', 'R', rb], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2', 'RB.1'], ['COIL', 'K1.2', 'D1.1', 'Q1.2', 'K1.4'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'J1.2', 'Q1.3', 'K1.3']]))
  const weak = latch('100k')
  add('relay coil judged with its own contacts open: self-fed coil and weak latch are not a pass',
    !is(selfFed, 'op_relay', 'pass', 'K1') && operatingHeadline(selfFed).text !== '동작 검사 통과' && !is(weak, 'op_relay', 'pass', 'K1') &&
    !!pick(selfFed, 'op_relay', 'K1')?.detail.some(d => /자기 접점/.test(d)),
    `${show(selfFed, 'op_relay')} · ${operatingHeadline(selfFed).text} | ${show(weak, 'op_relay')}`)

  // a closed contact does not overwrite a regulator output (two sources meet: a short), and a relay whose coil
  // has nowhere to get current never closes its contact
  const regContact = op(circuit([['J1', 'Conn_01x02', 'PWR'], ['BT1', 'Battery', '9V'], ['U1', 'REG', 'AMS1117-3.3'], ['C1', 'CP', '22uF'], ['K1', 'Relay', '5V'],
    ['RK', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148']],
  [['+5V', 'J1.1', 'K1.1', 'D1.2', 'RK.1', 'K1.3'], ['GND', 'J1.2', 'BT1.2', 'U1.1', 'C1.2', 'Q1.3'], ['VIN', 'BT1.1', 'U1.3'], ['V33', 'U1.2', 'C1.1', 'K1.4'],
    ['COIL', 'K1.2', 'D1.1', 'Q1.2'], ['B', 'RK.2', 'Q1.1']]))
  const openCoilRelay = op(circuit([['BT1', 'Battery', '12V'], ['K1', 'Relay', '5V'], ['J2', 'Conn_01x02', 'MOTOR 0.2A']],
    [['VBAT', 'BT1.1', 'K1.3', 'K1.1'], ['M', 'K1.4', 'J2.1'], ['GND', 'BT1.2', 'J2.2']]))
  add('contact onto a regulator output is a short; a relay with an open coil pin does not close',
    is(regContact, 'op_short', 'error', 'K1', /V33\(3\.3 V\)/) && is(openCoilRelay, 'op_flyback', 'unknown', 'J2'),
    `${show(regContact, 'op_short')} | ${show(regContact, 'op_cap')} | ${show(openCoilRelay, 'op_flyback', 'J2')}`)

  // two LEDs on one resistor, one behind a switch: a shared resistor, not "no resistor". The most current is
  // with the switch open (the other LED alone: 31 mA through 100 Ω), the least with both on
  const swShare = (r: string, swSide: 'cathode' | 'anode') => circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', r], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED'], ['SW1', 'SW', 'ON']],
    swSide === 'cathode'
      ? [['+5V', 'J1.1', 'D1.1', 'D2.1'], ['Y', 'D1.2', 'SW1.1'], ['X', 'SW1.2', 'D2.2', 'R1.1'], ['GND', 'J1.2', 'R1.2']]
      : [['+5V', 'J1.1', 'R1.1'], ['X', 'R1.2', 'SW1.1', 'D2.1'], ['Y', 'SW1.2', 'D1.1'], ['GND', 'J1.2', 'D1.2', 'D2.2']])
  const ss330 = op(swShare('330', 'cathode')), ss100 = op(swShare('100', 'cathode')), ssAnode = op(swShare('100', 'anode'))
  // the switch on the far side of the LED (the power analysis carries +5V through it before the walk gets there)
  const ssFar = op(circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED'], ['SW1', 'SW', 'ON']],
    [['+5V', 'J1.1', 'D1.1', 'SW1.1'], ['M', 'SW1.2', 'D2.1'], ['X', 'D1.2', 'D2.2', 'R1.1'], ['GND', 'J1.2', 'R1.2']]))
  add('LEDs sharing a resistor, one behind a switch: shared, worst case with the switch open',
    is(ss330, 'op_led', 'warn', 'D1', /D1·D2가 R1 하나를 나눠 씁니다.*4\.7~9\.39 mA/) && !!pick(ss330, 'op_led', 'D1')?.detail.some(d => /SW1이 열리면/.test(d)) &&
    is(ss100, 'op_led', 'error', 'D1', /31 mA ≥ 최대 30 mA/) && is(ssAnode, 'op_led', 'error', 'D1', /31 mA ≥ 최대 30 mA/) &&
    is(ssFar, 'op_led', 'warn', 'D1', /D1·D2가 R1 하나를 나눠 씁니다.*4\.7~9\.39 mA/) &&
    ![ss330, ss100, ssAnode, ssFar].some(rs => rs.some(r => r.rule === 'op_led' && /직렬 저항이 없어/.test(r.summary))),
    [ss330, ss100, ssAnode, ssFar].map(rs => rs.filter(r => r.rule === 'op_led').map(r => `${r.state}: ${r.summary}`).join(' / ')).join(' | '))

  // a 555 reset button to GND with no pull-up floats when released: a warning; a reset wired to GND, or to the 555's own switched ground, stays an error
  const resetPlain = (extra: (c: NetGraph) => void) => variant(variant(timer, movePin('U1.4', 'RST')), c => {
    c.components.push({ ref: 'SW1', name: 'SW', value: 'STOP' })
    c.nets.find(n => n.name === 'RST')!.nodes.push({ ref: 'SW1', pin: '1' })
    c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'SW1', pin: '2' })
    extra(c)
  })
  const rFloat = op(resetPlain(() => {}))
  const rTied = op(variant(timer, movePin('U1.4', 'GND')))
  const rOwnGnd = op(resetPlain(c => { movePin('U1.1', 'RST')(c) }))
  add('555 reset button without pull-up: floats (warn), tied reset still an error',
    is(rFloat, 'op_555', 'warn', 'U1', /4번 핀\(RESET\)은 SW1을 누르는 동안 GND로 내려가지만, 스위치를 놓으면 떠 있어/) &&
    is(rTied, 'op_555', 'error', 'U1', /GND에 묶여/) && is(rOwnGnd, 'op_555', 'error', 'U1', /GND에 묶여/),
    [show(rFloat, 'op_555'), show(rTied, 'op_555'), show(rOwnGnd, 'op_555')].join(' | '))

  const orderDiff = G.filter(g => full(run(g)) !== full(run(reversed(g))))
  add('listing order does not change these answers', orderDiff.length === 0, orderDiff.map(g => `${full(run(g))} ≠ ${full(run(reversed(g)))}`).join(' || ').slice(0, 600))

  for (const [name, ok, info] of F) check(`O16 ${name}`, ok, info)
}

// O14. every verdict from the circuits above: basis shown, no NaN, no "same < same" ────
/** what is wrong with these verdicts as text: NaN, no basis, "x < x", a pass carrying a cause line */
function verdictProblems(rs: OpResult[]): string[] {
  const problems: string[] = []
  const strict = /(?<![\d.\-−])([\d.]+ (?:mA|µA|V|mW|W|Ω|kΩ|MΩ)) [<>] (?:최대 |최소 |필요 |허용 |정격 |동작 전압 )?\1(?![\d.])/
  for (const r of rs) {
    const text = `${r.summary} ${r.detail.join(' ')}`
    if (/NaN|undefined|Infinity/.test(text)) problems.push(`${r.rule}/${r.ref}: ${r.summary}`)
    if (r.state !== 'unknown' && r.detail.length === 0) problems.push(`${r.rule}/${r.ref} no basis: ${r.summary}`)
    if (strict.test(r.summary)) problems.push(`${r.rule}/${r.ref} reads equal: ${r.summary}`)
    if (r.state === 'pass' && r.detail.some(d => /이어진 결과/.test(d))) problems.push(`${r.rule}/${r.ref} pass with a cause line`)
  }
  return problems
}
{
  const problems = verdictProblems(ALL)
  check('O14 every verdict above: basis, no NaN, distinct numbers', problems.length === 0 && ALL.length > 100, `${ALL.length} results${problems.length ? ' · ' + [...new Set(problems)].slice(0, 4).join(' | ') : ''}`)
}

// O17. cause attribution left open after review round 3 ────────────────────────
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  const head = (rs: OpResult[]) => operatingHeadline(rs).text

  // K2 (12 V coil on 5 V) never pulls in, and its contact is what feeds K1's coil: K1 cannot pass
  const chain = circuit(
    [['J1', 'Conn_01x03', 'PWR_IN'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['D1', 'D', '1N4148'], ['K2', 'Relay', '12V'],
      ['K1', 'Relay', '5V'], ['D2', 'D', '1N4148']],
    [['+5V', 'J1.1', 'K2.1', 'D1.2', 'K2.3'], ['IN', 'J1.2', 'R1.1'], ['GND', 'J1.3', 'Q1.3', 'K1.2', 'D2.1'], ['BASE', 'R1.2', 'Q1.1'],
      ['COIL2', 'Q1.2', 'K2.2', 'D1.1'], ['K1TOP', 'K2.4', 'K1.1', 'D2.2']])
  const ch = run(chain)
  const k1 = pick(ch, 'op_relay', 'K1')
  add('relay fed through a relay that never pulls in: not passed, caused by K2, counted once',
    is(ch, 'op_relay', 'error', 'K2', /붙지 않습니다/) && !!k1 && k1.state !== 'pass' && k1.cause === 'K2' && head(ch).startsWith('동작 안 됨 1') && !/판단 불가/.test(head(ch)),
    `${show(ch, 'op_relay', 'K2')} | ${k1 ? `${k1.state}/${k1.cause}: ${k1.summary}` : '(none)'} | ${head(ch)}`)
  // the same with K2 pulling in (5 V coil): K1 is judged through the closed contact and passes
  const chainOk = variant(chain, setValue('K2', '5V'))
  add('relay fed through a working relay still passes', is(run(chainOk), 'op_relay', 'pass', 'K1'), show(run(chainOk), 'op_relay', 'K1'))

  // a 10 Ω LED on a transistor whose base resistor also goes nowhere: two faults, not one
  const hot = (rb: string, baseFrom: string) => circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '10'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', rb]],
    [['VCC', 'BT1.1', 'R1.1', ...(baseFrom === 'VCC' ? ['RB.1'] : [])], ['LA', 'R1.2', 'D1.1'], ['LK', 'D1.2', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1'], ['GND', 'BT1.2', 'Q1.3'],
      ...(baseFrom === 'VCC' ? [] : [[baseFrom, 'RB.1'] as [string, string]])])
  const open = run(hot('1k', 'NOWHERE')), weak = run(hot('1M', 'VCC')), ok = run(hot('1k', 'VCC'))
  add('LED fault does not hide an independent base fault; a drive short only because of the LED follows the LED',
    !pick(open, 'op_drive', 'Q1')?.cause && head(open) === '동작 안 됨 2' &&
    // even with the LED held to 30 mA the 1 MΩ base falls short: an error of its own, counted next to the LED
    is(weak, 'op_drive', 'error', 'Q1', /LED를 정격 전류로 줄여도/) && !pick(weak, 'op_drive', 'Q1')?.cause && head(weak) === '동작 안 됨 2' &&
    head(ok) === '동작 안 됨 1',
    `${show(open, 'op_drive')} [${head(open)}] | ${show(weak, 'op_drive')} [${head(weak)}] | ${head(ok)}`)

  for (const [name, ok2, info] of F) check(`O17 ${name}`, ok2, info)
}

// O18. review round 4: relays that never pull in, and whose fault a verdict follows ───────
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  const head = (rs: OpResult[]) => operatingHeadline(rs).text
  const notPass = (rs: OpResult[], rule: OpRule, ref: string) => !!pick(rs, rule, ref) && pick(rs, rule, ref)!.state !== 'pass'
  const reversed = (g: NetGraph): NetGraph => ({ components: [...g.components].reverse(), nets: [...g.nets].reverse().map(n => ({ ...n, nodes: [...n.nodes].reverse() })) })
  const states = (rs: OpResult[]) => rs.map(r => `${r.rule}/${r.ref}/${r.state}`).sort().join(' ')

  // two relays holding each other only through their contacts never start; with a start button they do
  const mutual = circuit([['J1', 'Conn_01x02', 'PWR'], ['K1', 'Relay', '5V'], ['K2', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['D2', 'D', '1N4148'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.3', 'K2.3', 'R1.1'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'K2.2', 'D2.1', 'L1.2'], ['A', 'K2.4', 'K1.1', 'D1.2'], ['B', 'K1.4', 'K2.1', 'D2.2'], ['LA', 'R1.2', 'L1.1']])
  const started = variant(mutual, c => { c.components.push({ ref: 'SW1', name: 'SW', value: 'START' }); c.nets.find(n => n.name === '+5V')!.nodes.push({ ref: 'SW1', pin: '1' }); c.nets.find(n => n.name === 'A')!.nodes.push({ ref: 'SW1', pin: '2' }) })
  add('mutual latch never starts; with a start button it does', notPass(run(mutual), 'op_relay', 'K1') && notPass(run(mutual), 'op_relay', 'K2') && head(run(mutual)) !== '동작 검사 통과' &&
    is(run(started), 'op_relay', 'pass', 'K1') && is(run(started), 'op_relay', 'pass', 'K2'),
    `${show(run(mutual), 'op_relay', 'K1')} · ${head(run(mutual))} | ${show(run(started), 'op_relay', 'K1')}`)

  // a self-holding relay whose only start path is a relay that never pulls in
  const deadStart = circuit([['J1', 'Conn_01x02', 'PWR'], ['K1', 'Relay', '5V'], ['K2', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['D2', 'D', '1N4148'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.3', 'K2.3', 'K2.1', 'D2.2'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'K2.2', 'D2.1', 'L1.2'], ['H', 'K1.4', 'K2.4', 'K1.1', 'D1.2', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const ds = run(deadStart)
  add('latch started only by a dead relay: K1 and its LED not passed, one fault', notPass(ds, 'op_relay', 'K1') && notPass(ds, 'op_led', 'L1') && head(ds) === '동작 안 됨 1',
    `${show(ds, 'op_relay', 'K1')} | ${show(ds, 'op_led', 'L1')} | ${head(ds)}`)

  // an unrelated dead relay does not turn a self-fed coil into a pass, nor become its cause
  const selfFedPlus = circuit([['J1', 'Conn_01x02', 'PWR'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'],
    ['K2', 'Relay', '12V'], ['D2', 'D', '1N4148'], ['R9', 'R', '330'], ['L9', 'LED', 'RED']],
  [['+5V', 'J1.1', 'K1.3', 'RB.1', 'K2.1', 'D2.2', 'K2.3'], ['KH', 'K1.4', 'K1.1', 'D1.2'], ['COIL', 'K1.2', 'D1.1', 'Q1.2'], ['BASE', 'RB.2', 'Q1.1'],
    ['GND', 'J1.2', 'Q1.3', 'K2.2', 'D2.1', 'L9.2'], ['N9', 'K2.4', 'R9.1'], ['A9', 'R9.2', 'L9.1']])
  const sp = run(selfFedPlus)
  add('unrelated dead relay leaves a self-fed coil alone', notPass(sp, 'op_relay', 'K1') && pick(sp, 'op_relay', 'K1')?.cause !== 'K2',
    `${show(sp, 'op_relay', 'K1')} cause=${pick(sp, 'op_relay', 'K1')?.cause}`)

  // an overvoltage relay on a transistor that never turns on does not close its contact
  const overOff = circuit([['J1', 'Conn_01x03', 'PWR'], ['K2', 'Relay', '5V'], ['D2', 'D', '1N4148'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['Q1', 'Q_NPN', '2N3904'],
    ['RB', 'R', '1k'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
  [['+12V', 'J1.1', 'K2.1', 'D2.2'], ['+5V', 'J1.3', 'K2.3', 'K1.3'], ['GND', 'J1.2', 'Q1.3', 'K1.2', 'D1.1', 'L1.2', 'RB.1'], ['COIL', 'K2.2', 'D2.1', 'Q1.2'],
    ['B', 'RB.2', 'Q1.1'], ['T1', 'K2.4', 'K1.1', 'D1.2'], ['L', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  add('overvoltage relay behind a transistor that never turns on: K1 and L1 not passed', notPass(run(overOff), 'op_relay', 'K1') && notPass(run(overOff), 'op_led', 'L1'),
    `${show(run(overOff), 'op_relay', 'K1')} | ${show(run(overOff), 'op_led', 'L1')}`)

  // a regulator fed through a dead relay's contact has no output
  const regBehind = circuit([['J1', 'Conn_01x03', 'PWR'], ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['U1', 'REG', 'L7805'], ['C1', 'CP', '10uF'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+9V', 'J1.1', 'K1.3'], ['+5V', 'J1.3', 'K1.1', 'D1.2'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'U1.1', 'C1.2', 'L1.2'], ['VIN', 'K1.4', 'U1.3'], ['VOUT', 'U1.2', 'C1.1', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  add('regulator behind a dead contact: its LED not passed, one fault', notPass(run(regBehind), 'op_led', 'L1') && head(run(regBehind)) === '동작 안 됨 1',
    `${show(run(regBehind), 'op_led', 'L1')} | ${head(run(regBehind))}`)

  // a three-relay chain gives the same answers in any listing order
  const chain3 = circuit([['J1', 'Conn_01x02', 'PWR'], ['K1', 'Relay', '5V'], ['K2', 'Relay', '5V'], ['K3', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['D2', 'D', '1N4148'], ['D3', 'D', '1N4148'],
    ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
  [['+5V', 'J1.1', 'K3.1', 'D3.2', 'K3.3', 'K2.3', 'K1.3'], ['GND', 'J1.2', 'K3.2', 'D3.1', 'K2.2', 'D2.1', 'K1.2', 'D1.1', 'L1.2'], ['T2', 'K3.4', 'K2.1', 'D2.2'],
    ['T1', 'K2.4', 'K1.1', 'D1.2'], ['L', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const c3a = run(chain3), c3b = run(reversed(chain3))
  add('three-relay chain: same in any order, L1 not passed, one fault', states(c3a) === states(c3b) && notPass(c3a, 'op_led', 'L1') && head(c3a) === '동작 안 됨 1' && head(c3b) === '동작 안 됨 1',
    `${head(c3a)} / ${head(c3b)} · ${show(c3a, 'op_led', 'L1')}`)

  // a changeover contact: COM fed only through its own NO is no short through NC
  const spdt = circuit([['J1', 'Conn_01x03', 'PWR'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2', 'K1.4'], ['+3V3', 'J1.3', 'K1.5'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'L1.2'], ['OUT', 'K1.3', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  add('changeover contact is not a short', !pick(run(spdt), 'op_short'), show(run(spdt), 'op_short'))

  // two results of one rule and part keep their own texts and causes
  const twoNames = circuit([['BT1', 'Battery', '4.5V'], ['K2', 'Relay', '12V'], ['D2', 'D', '1N4148'], ['SW1', 'SW', 'S'], ['R1', 'R', '1k'], ['R2', 'R', '1k']],
    [['VBAT', 'BT1.1', 'K2.3', 'SW1.1', 'K2.1', 'D2.2'], ['GND', 'BT1.2', 'K2.2', 'D2.1', 'R1.2', 'R2.2'], ['+5V', 'K2.4', 'R1.1'], ['+3V3', 'SW1.2', 'R2.1']])
  const tn = run(twoNames).filter(r => r.rule === 'op_power' && /\+3V3/.test(r.summary))
  add('+3V3 mismatch reported once, not blamed on K2', tn.length === 1 && !tn[0].cause, tn.map(r => `${r.state}/${r.cause}: ${r.summary}`).join(' | '))

  // a fault that stays when the dead relay's contact closes is its own fault
  const hotBehind = circuit([['J1', 'Conn_01x02', 'PWR'], ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['R1', 'R', '10'], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2', 'K1.3'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'L1.2'], ['NO', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const hb = run(hotBehind)
  add('10 Ω LED behind a dead relay: its own error, two faults', is(hb, 'op_led', 'error', 'L1') && !pick(hb, 'op_led', 'L1')?.cause && head(hb) === '동작 안 됨 2',
    `${show(hb, 'op_led', 'L1')} | ${head(hb)}`)

  // a chain through a relay that cannot be judged still ends at the first fault
  const viaUnknown = circuit([['J1', 'Conn_01x02', 'PWR'], ['K2', 'Relay', '12V'], ['D2', 'D', '1N4148'], ['K3', 'Relay', '5V'], ['D3', 'D', '1N4148'], ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'],
    ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
  [['+5V', 'J1.1', 'K2.1', 'D2.2', 'K2.3', 'K3.1', 'D3.2', 'K3.3'], ['GND', 'J1.2', 'K2.2', 'D2.1', 'Q1.3', 'L1.2'], ['DRV', 'K2.4', 'RB.1'], ['B', 'RB.2', 'Q1.1'],
    ['COIL', 'K3.2', 'D3.1', 'Q1.2'], ['NO', 'K3.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const openBase = circuit([['J1', 'Conn_01x02', 'PWR'], ['Q3', 'Q_NPN', '2N3904'], ['R8', 'R', '1k'], ['K3', 'Relay', '5V'], ['D3', 'D', '1N4148'], ['R1', 'R', '1k'], ['D1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K3.1', 'D3.2', 'K3.3'], ['GND', 'J1.2', 'Q3.3', 'D1.2'], ['B3', 'Q3.1', 'R8.2'], ['NOWHERE', 'R8.1'], ['C3', 'K3.2', 'D3.1', 'Q3.2'], ['LA', 'K3.4', 'R1.1'], ['LB', 'R1.2', 'D1.1']])
  add('chains through results that could not be judged count once', head(run(viaUnknown)) === '동작 안 됨 1' && head(run(openBase)) === '동작 안 됨 1',
    `${head(run(viaUnknown))} | ${head(run(openBase))}`)

  // the cause named is the relay's coil, not its other fault
  const ncShort = circuit([['J1', 'Conn_01x02', 'PWR'], ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2', 'K1.3'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'L1.2', 'K1.5'], ['NO', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  add('knock-on text names the relay coil', !!pick(run(ncShort), 'op_led', 'L1')?.detail.some(d => /K1 릴레이 코일 전압 문제에서 이어진/.test(d)),
    pick(run(ncShort), 'op_led', 'L1')?.detail[0] ?? '')

  // a backwards battery is the cause only of what it feeds
  const twoBats = circuit([['BT1', 'Battery', '9V'], ['BT2', 'Battery', '5V'], ['R5', 'R', '1k'], ['RB', 'R', '1M'], ['Q1', 'Q_NPN', '2N3904'], ['RL', 'R', '470'], ['D1', 'LED', 'RED']],
    [['+9V', 'BT1.1', 'RB.1', 'RL.1'], ['GND', 'BT1.2', 'BT2.1', 'Q1.3'], ['+5V', 'BT2.2', 'R5.1'], ['N5', 'R5.2'], ['BASE', 'RB.2', 'Q1.1'], ['LK', 'Q1.2', 'D1.2'], ['LA', 'RL.2', 'D1.1']])
  const noRb = circuit([['BT1', 'Battery', '9V'], ['Q1', 'Q_NPN', '2N3904'], ['R1', 'R', '470'], ['D1', 'LED', 'RED']],
    [['GND', 'BT1.1', 'Q1.3'], ['+9V', 'BT1.2', 'Q1.1', 'R1.1'], ['LA', 'R1.2', 'D1.1'], ['LK', 'D1.2', 'Q1.2']])
  add('backwards battery does not swallow faults on other rails or a missing base resistor',
    !pick(run(twoBats), 'op_drive', 'Q1')?.cause && head(run(twoBats)) === '동작 안 됨 2' && !pick(run(noRb), 'op_drive', 'Q1')?.cause && head(run(noRb)) === '동작 안 됨 2',
    `${show(run(twoBats), 'op_drive')} [${head(run(twoBats))}] | ${show(run(noRb), 'op_drive')} [${head(run(noRb))}]`)

  // transistor attribution: a weak base under an LED with no resistor, a source resistor lifted by an LED,
  // a load drawing less as the switch voltage rises, a shared resistor with a switched LED
  const bareWeak = circuit([['J1', 'Conn_01x02', 'PWR'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '1M']],
    [['+5V', 'J1.1', 'D1.1', 'RB.1'], ['GND', 'J1.2', 'Q1.3'], ['COL', 'D1.2', 'Q1.2'], ['B', 'RB.2', 'Q1.1']])
  const mosSense = circuit([['J1', 'Conn_01x02', 'PWR'], ['BT1', 'Battery', '9V'], ['R1', 'R', '2'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NMOS', '2N7000'], ['RS', 'R', '1'], ['RG', 'R', '100'], ['RP', 'R', '100k']],
    [['+5V', 'J1.1', 'RG.1'], ['+9V', 'BT1.1', 'R1.1'], ['GND', 'J1.2', 'BT1.2', 'RS.2', 'RP.2'], ['LA', 'R1.2', 'D1.1'], ['D', 'D1.2', 'Q1.2'], ['S', 'Q1.3', 'RS.1'], ['G', 'RG.2', 'RP.1', 'Q1.1']])
  const res47 = circuit([['J1', 'Conn_01x02', 'PWR'], ['RB', 'R', '10k'], ['RL', 'R', '47'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'J1.1', 'RB.1', 'RL.1'], ['GND', 'J1.2', 'Q1.3'], ['B', 'RB.2', 'Q1.1'], ['LA', 'RL.2', 'D1.1'], ['COL', 'D1.2', 'Q1.2']])
  const sharedSw = circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '62'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED'], ['SW1', 'SW', 'S'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '7.5k']],
    [['+5V', 'J1.1', 'R1.1', 'RB.1'], ['X', 'R1.2', 'D1.1', 'D2.1'], ['COL', 'D1.2', 'SW1.2', 'Q1.2'], ['K2', 'D2.2', 'SW1.1'], ['B', 'RB.2', 'Q1.1'], ['GND', 'J1.2', 'Q1.3']])
  add('transistor attribution: weak base under a bare LED is its own; LED-lifted source, a 47 Ω LED and a shared resistor follow the LED',
    is(run(bareWeak), 'op_drive', 'error', 'Q1') && !pick(run(bareWeak), 'op_drive', 'Q1')?.cause && head(run(bareWeak)) === '동작 안 됨 2' &&
    pick(run(mosSense), 'op_drive', 'Q1')?.cause === 'D1' && head(run(mosSense)) === '동작 안 됨 1' &&
    pick(run(res47), 'op_drive', 'Q1')?.cause === 'D1' && head(run(res47)) === '동작 안 됨 1' &&
    head(run(sharedSw)) === '동작 안 됨 1',
    [show(run(bareWeak), 'op_drive'), head(run(bareWeak)), show(run(mosSense), 'op_drive'), head(run(mosSense)), show(run(res47), 'op_drive'), head(run(res47)), head(run(sharedSw))].join(' | '))

  // an unknown motor current is not the LED's fault; the overloaded switch follows the LED over its rating
  const motorLed = circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '10'], ['D1', 'LED', 'RED'], ['J2', 'Conn_01x02', 'MOTOR'], ['D2', 'D', '1N4148'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '1k']],
    [['+5V', 'J1.1', 'R1.1', 'J2.1', 'D2.2', 'RB.1'], ['LA', 'R1.2', 'D1.1'], ['COL', 'D1.2', 'J2.2', 'D2.1', 'Q1.2'], ['B', 'RB.2', 'Q1.1'], ['GND', 'J1.2', 'Q1.3']])
  const twoStrings = circuit([['J1', 'Conn_01x02', 'PWR'], ['R1', 'R', '100'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED'], ['D3', 'LED', 'RED'], ['R4', 'R', '10'], ['D4', 'LED', 'RED'],
    ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '1k']],
  [['+5V', 'J1.1', 'R1.1', 'R4.1', 'RB.1'], ['A1', 'R1.2', 'D1.1'], ['M1', 'D1.2', 'D2.1'], ['M2', 'D2.2', 'D3.1'], ['A4', 'R4.2', 'D4.1'], ['COL', 'D3.2', 'D4.2', 'Q1.2'],
    ['B', 'RB.2', 'Q1.1'], ['GND', 'J1.2', 'Q1.3']])
  add('unknown motor current is not blamed on an LED; overload follows the LED over its rating',
    !pick(run(motorLed), 'op_drive', 'Q1')?.cause && pick(run(twoStrings), 'op_switch', 'Q1')?.cause === 'D4',
    `${show(run(motorLed), 'op_drive')} cause=${pick(run(motorLed), 'op_drive', 'Q1')?.cause} | op_switch cause=${pick(run(twoStrings), 'op_switch', 'Q1')?.cause}`)

  // a coil with no supply side, and a diode across a plain connector
  const coilGnd = circuit([['J1', 'Conn_01x02', 'PWR_IN'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148']],
    [['+5V', 'J1.1', 'R1.1'], ['GND', 'J1.2', 'Q1.3', 'K1.1', 'D1.2'], ['BASE', 'R1.2', 'Q1.1'], ['COL', 'Q1.2', 'K1.2', 'D1.1']])
  const solenoid = circuit([['J2', 'Conn_01x02', 'PWR_IN'], ['R1', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['J1', 'Conn_01x02', 'SOLENOID'], ['D1', 'D', '1N4148']],
    [['+5V', 'J2.1', 'R1.1', 'J1.1', 'D1.1'], ['GND', 'J2.2', 'Q1.3'], ['BASE', 'R1.2', 'Q1.1'], ['COL', 'Q1.2', 'J1.2', 'D1.2']])
  add('coil pin on GND says the coil has no supply; a diode across a plain connector counts once',
    is(run(coilGnd), 'op_relay', 'error', 'K1', /전원 쪽이 없습니다/) && head(run(solenoid)) === '동작 안 됨 1',
    `${show(run(coilGnd), 'op_relay')} | ${head(run(solenoid))}`)

  // a drive that fails with or without the relay contact is its own fault
  const weakSig = circuit([['J1', 'Conn_01x02', 'PWR'], ['K2', 'Relay', '12V'], ['D3', 'D', '1N4148'], ['RB', 'R', '1M'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904']],
    [['+5V', 'J1.1', 'K2.1', 'D3.2', 'K2.3', 'R1.1'], ['GND', 'J1.2', 'K2.2', 'D3.1', 'Q1.3'], ['SIG', 'K2.4', 'RB.1'], ['B', 'RB.2', 'Q1.1'], ['LA', 'R1.2', 'D1.1'], ['COL', 'D1.2', 'Q1.2']])
  add('weak base behind a dead relay contact stays its own fault', is(run(weakSig), 'op_drive', 'error', 'Q1') && !pick(run(weakSig), 'op_drive', 'Q1')?.cause && head(run(weakSig)) === '동작 안 됨 2',
    `${show(run(weakSig), 'op_drive')} | ${head(run(weakSig))}`)

  for (const [name, ok, info] of F) check(`O18 ${name}`, ok, info)
}

// O19. review round 5: relays switch over (COM–NO and COM–NC), compared one at a time; causes and counts ──
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  const head = (rs: OpResult[]) => operatingHeadline(rs).text
  const notPass = (rs: OpResult[], rule: OpRule, ref: string) => !!pick(rs, rule, ref) && pick(rs, rule, ref)!.state !== 'pass'
  const cz = (refs: Comp[], nets: [string, ...string[]][]) => run(circuit(refs, nets))
  const PWR: Comp = ['J1', 'Conn_01x02', 'PWR']

  // two dead relays, one with a 10 Ω LED behind it: the LED is its own fault whatever the names
  const twoDead = (a: string, b: string) => cz([PWR, [a, 'Relay', '12V'], [b, 'Relay', '12V'], ['D1', 'D', '1N4148'], ['D2', 'D', '1N4148'], ['R1', 'R', '10'], ['L1', 'LED', 'RED'], ['R2', 'R', '330'], ['L2', 'LED', 'RED']],
    [['+5V', 'J1.1', `${a}.1`, `${b}.1`, 'D1.2', 'D2.2', `${a}.3`, `${b}.3`], ['GND', 'J1.2', `${a}.2`, `${b}.2`, 'D1.1', 'D2.1', 'L1.2', 'L2.2'],
      ['NOH', `${a}.4`, 'R1.1'], ['LA1', 'R1.2', 'L1.1'], ['NOC', `${b}.4`, 'R2.1'], ['LA2', 'R2.2', 'L2.1']])
  const td1 = twoDead('K1', 'K2'), td2 = twoDead('K2', 'K1')
  add('dead relays: the LED behind one is its own fault, names do not matter', head(td1) === '동작 안 됨 3' && head(td2) === '동작 안 됨 3' && !pick(td1, 'op_led', 'L1')?.cause,
    `${head(td1)} / ${head(td2)} · ${show(td1, 'op_led', 'L1')}`)

  // a relay used only through COM–NC still has its short checked
  const ncOnly = cz([PWR, ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148']],
    [['+5V', 'J1.1', 'RB.1', 'K1.1', 'D1.2', 'K1.3'], ['B', 'RB.2', 'Q1.1'], ['C', 'Q1.2', 'K1.2', 'D1.1'], ['GND', 'J1.2', 'Q1.3', 'K1.5']])
  add('COM–NC short checked without an NO', is(ncOnly, 'op_short', 'error', 'K1', /NC/), show(ncOnly, 'op_short'))

  // a battery stacked through an open contact is not connected; through a closed one it is no short
  const floatStack = cz([PWR, ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['BT2', 'Battery', '9V'], ['R1', 'R', '1k'], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'K1.3', 'L1.2'], ['B', 'BT2.2', 'K1.4'], ['T', 'BT2.1', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const stackShort = cz([['BT1', 'Battery', '5V'], ['K1', 'Relay', '12V'], ['D9', 'D', '1N4148'], ['BT2', 'Battery', '4V'], ['R1', 'R', '1k']],
    [['GND', 'BT1.2', 'K1.2', 'D9.1', 'R1.2'], ['A', 'BT1.1', 'K1.1', 'D9.2', 'K1.3'], ['B', 'K1.4', 'BT2.2'], ['C', 'BT2.1', 'R1.1']])
  add('battery behind an open contact: LED not passed, no false short', notPass(floatStack, 'op_led', 'L1') && !pick(stackShort, 'op_short'),
    `${show(floatStack, 'op_led', 'L1')} | ${show(stackShort, 'op_short')}`)

  // a relay driven by a 555 output: normal wiring passes; a backwards diode is an error of its own
  const t555 = (dA: string, dK: string, extra = false) => run(variant(variant(variant(timer, setValue('BT1', '12V')), setValue('R3', '1k')), c => {
    c.components.push({ ref: 'K1', name: 'Relay', value: '12V' }, { ref: 'D9', name: 'D', value: '1N4148' })
    c.nets.find(n => n.name === 'OUT')!.nodes.push({ ref: 'K1', pin: '1' })
    c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'K1', pin: '2' })
    c.nets.find(n => n.name === dA)!.nodes.push({ ref: 'D9', pin: '1' }); c.nets.find(n => n.name === dK)!.nodes.push({ ref: 'D9', pin: '2' })
    if (extra) { c.components.push({ ref: 'R7', name: 'R', value: '10' }, { ref: 'L7', name: 'LED', value: 'RED' }); c.nets.find(n => n.name === 'VCC')!.nodes.push({ ref: 'R7', pin: '1' }); c.nets.push({ name: 'A7', nodes: [{ ref: 'R7', pin: '2' }, { ref: 'L7', pin: '1' }] }); c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'L7', pin: '2' }) }
  }))
  const okDrive = t555('GND', 'OUT'), badDrive = t555('OUT', 'GND', true)
  add('relay on a 555 output: passes; a backwards diode counts on its own', is(okDrive, 'op_flyback', 'pass', 'K1') && head(okDrive) === '동작 검사 통과' &&
    is(badDrive, 'op_flyback', 'error', 'K1') && head(badDrive) === '동작 안 됨 2', `${show(okDrive, 'op_flyback')} · ${head(okDrive)} | ${head(badDrive)}`)

  // two relays tying different rails to one output: one short
  const twoRails = cz([['J1', 'Conn_01x03', 'PWR'], ['K1', 'Relay', '12V'], ['K2', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['D2', 'D', '1N4148'], ['R1', 'R', '1k']],
    [['+5V', 'J1.1', 'K1.1', 'K2.1', 'D1.2', 'D2.2', 'K2.3'], ['GND', 'J1.2', 'K1.2', 'K2.2', 'D1.1', 'D2.1', 'R1.2'], ['+12V', 'J1.3', 'K1.3'], ['OUT', 'K1.4', 'K2.4', 'R1.1']])
  add('two contacts joining two rails: one short', twoRails.filter(r => r.rule === 'op_short').length === 1, twoRails.filter(r => r.rule === 'op_short').map(r => r.summary).join(' | '))

  // a regulator behind a dead contact and a switch; a regulator whose GND pin goes nowhere
  const regSw = cz([['J1', 'Conn_01x03', 'PWR'], ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['SW1', 'SW', 'S'], ['U1', 'REG', 'L7805'], ['C1', 'CP', '10uF'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+9V', 'J1.1', 'K1.3'], ['+5V', 'J1.3', 'K1.1', 'D1.2'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'U1.1', 'C1.2', 'L1.2'], ['M', 'K1.4', 'SW1.1'], ['VIN', 'SW1.2', 'U1.3'],
      ['VOUT', 'U1.2', 'C1.1', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const regNoGnd = cz([['BT1', 'Battery', '9V'], ['U1', 'REG', 'L7805'], ['C1', 'CP', '10uF'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['VIN', 'BT1.1', 'U1.3'], ['GND', 'BT1.2', 'C1.2', 'L1.2'], ['RG', 'U1.1'], ['+5V', 'U1.2', 'C1.1', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  add('regulator behind a dead contact and a switch, or with no ground: its LED not passed', notPass(regSw, 'op_led', 'L1') && notPass(regNoGnd, 'op_led', 'L1'),
    `${show(regSw, 'op_led', 'L1')} | ${show(regNoGnd, 'op_led', 'L1')}`)

  // one MOSFET pulls two coils, the second fed through the first relay's NO: works
  const twoCoils = cz([PWR, ['RG', 'R', '100'], ['RP', 'R', '100k'], ['Q1', 'Q_NMOS', '2N7000'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['K2', 'Relay', '5V'], ['D2', 'D', '1N4148']],
    [['+5V', 'J1.1', 'RG.1', 'K1.1', 'D1.2', 'K1.3'], ['G', 'RG.2', 'RP.1', 'Q1.1'], ['GND', 'J1.2', 'RP.2', 'Q1.3'], ['C', 'Q1.2', 'K1.2', 'D1.1', 'K2.2', 'D2.1'], ['T2', 'K1.4', 'K2.1', 'D2.2']])
  add('second coil fed through the first relay: works', head(twoCoils) === '동작 검사 통과', `${head(twoCoils)} · ${show(twoCoils, 'op_relay', 'K2')}`)

  // two dead relays in series: what is behind both follows them; a fault there of its own still counts
  const series2 = (lr: string) => cz([PWR, ['K1', 'Relay', '12V'], ['K2', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['D2', 'D', '1N4148'], ...(lr ? [['R1', 'R', lr] as Comp] : []), ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.1', 'K2.1', 'D1.2', 'D2.2', 'K1.3'], ['GND', 'J1.2', 'K1.2', 'K2.2', 'D1.1', 'D2.1', 'L1.2'], ['M', 'K1.4', 'K2.3'],
      ...(lr ? [['NO2', 'K2.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']] as [string, ...string[]][] : [['NO2', 'K2.4', 'L1.1']] as [string, ...string[]][])])
  add('two dead relays in series: LED follows them; a bare LED there is its own fault', head(series2('330')) === '동작 안 됨 2' && head(series2('')) === '동작 안 됨 3',
    `${head(series2('330'))} | ${head(series2(''))}`)

  // only unknowns: counted by root; a warning under an unknown root still counts as a warning
  const unkRelay = (r1: string) => cz([PWR, ['K1', 'Relay', 'HK19F'], ['D1', 'D', '1N4148'], ['R1', 'R', r1], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2', 'K1.3'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'L1.2'], ['NO', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  add('unknown-only headline counts roots; a warning behind an unknown relay is a warning', head(unkRelay('330')) === '판단 불가 1' && head(unkRelay('110')) === '동작 경고 1 · 판단 불가 1',
    `${head(unkRelay('330'))} | ${head(unkRelay('110'))}`)

  // a changeover indicator (LEDs on NO and NC) is a normal circuit
  const spdtLeds = cz([PWR, ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['R1', 'R', '330'], ['L1', 'LED', 'RED'], ['R2', 'R', '330'], ['L2', 'LED', 'RED']],
    [['+5V', 'J1.1', 'RB.1', 'K1.1', 'D1.2', 'K1.3'], ['B', 'RB.2', 'Q1.1'], ['C', 'Q1.2', 'K1.2', 'D1.1'], ['GND', 'J1.2', 'Q1.3', 'L1.2', 'L2.2'],
      ['NO', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1'], ['NC', 'K1.5', 'R2.1'], ['LB', 'R2.2', 'L2.1']])
  add('changeover indicator passes', head(spdtLeds) === '동작 검사 통과', `${head(spdtLeds)} · ${show(spdtLeds, 'op_led', 'L2')}`)

  // a coil with both pins on one net is an error
  const coilOneNet = cz([PWR, ['K1', 'Relay', '5V'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['X', 'K1.1', 'K1.2'], ['+5V', 'J1.1', 'K1.3'], ['GND', 'J1.2', 'L1.2'], ['NO', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  add('coil pins on one net: error, LED follows it', is(coilOneNet, 'op_relay', 'error', 'K1') && head(coilOneNet) === '동작 안 됨 1', `${show(coilOneNet, 'op_relay')} · ${head(coilOneNet)}`)

  // a backwards battery: its GND terminal is no cause; a capacitor it reverses and a relay it starves follow it
  const bwGnd = cz([['BT1', 'Battery', '9V'], ['BT2', 'Battery', '5V'], ['R5', 'R', '1k'], ['R1', 'R', '10'], ['D1', 'LED', 'RED']],
    [['VBAT', 'BT1.1', 'R1.1'], ['GND', 'BT1.2', 'BT2.1', 'D1.2'], ['+5V', 'BT2.2', 'R5.1'], ['N5', 'R5.2'], ['LA', 'R1.2', 'D1.1']])
  const bwCap = cz([['BT1', 'Battery', '5V'], ['C1', 'CP', '10uF'], ['R1', 'R', '1k']], [['GND', 'BT1.1', 'C1.2', 'R1.2'], ['+5V', 'BT1.2', 'C1.1', 'R1.1']])
  const bwRelay = cz([['BT1', 'Battery', '5V'], ['J1', 'Conn_01x02', 'SIG'], ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148']],
    [['GND', 'BT1.1', 'J1.2', 'Q1.3'], ['+5V', 'BT1.2', 'K1.1', 'D1.2'], ['SIG', 'J1.1', 'RB.1'], ['B', 'RB.2', 'Q1.1'], ['COIL', 'Q1.2', 'K1.2', 'D1.1']])
  add('backwards battery: other rail faults own, reversed cap and starved relay follow it',
    head(bwGnd) === '동작 안 됨 2' && !pick(bwGnd, 'op_led', 'D1')?.cause && head(bwCap) === '동작 안 됨 1' && head(bwRelay) === '동작 안 됨 1' && !/거꾸로 단 다이오드/.test(pick(bwRelay, 'op_relay', 'K1')?.summary ?? ''),
    `${head(bwGnd)} | ${head(bwCap)} | ${head(bwRelay)} ${show(bwRelay, 'op_relay')}`)

  // 555: a RESET tied to GND is its own fault next to a loose battery
  const t555bad = run(variant(variant(timer, movePin('BT1.2', 'BN')), c => {
    c.components.push({ ref: 'J1', name: 'Conn_01x02', value: 'G' }); c.nets.find(n => n.name === 'GND')!.nodes.push({ ref: 'J1', pin: '1' })
    movePin('U1.4', 'GND')(c)
  }))
  add('555 RESET on GND next to a loose battery: two faults', head(t555bad) === '동작 안 됨 2', `${show(t555bad, 'op_555')} · ${head(t555bad)}`)

  // switch limits: a heavy motor beside a bare LED; an unknown motor current beside a starved coil
  const motorBare = cz([PWR, ['RG', 'R', '100'], ['RP', 'R', '100k'], ['Q1', 'Q_NMOS', '2N7000'], ['J2', 'Conn_01x02', 'MOTOR 0.25A'], ['D2', 'D', '1N4148'], ['D1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'RG.1', 'J2.1', 'D2.2', 'D1.1'], ['G', 'RG.2', 'RP.1', 'Q1.1'], ['GND', 'J1.2', 'RP.2', 'Q1.3'], ['D', 'Q1.2', 'J2.2', 'D2.1', 'D1.2']])
  const motorUnk = cz([PWR, ['BT2', 'Battery', '12V'], ['RG', 'R', '100'], ['RP', 'R', '100k'], ['Q1', 'Q_NMOS', '2N7000'], ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['J2', 'Conn_01x02', 'MOTOR'], ['D2', 'D', '1N4148']],
    [['+5V', 'J1.1', 'RG.1', 'J2.1', 'D2.2'], ['+12V', 'BT2.1', 'K1.1', 'D1.2'], ['BN', 'BT2.2'], ['G', 'RG.2', 'RP.1', 'Q1.1'], ['GND', 'J1.2', 'RP.2', 'Q1.3'], ['D', 'Q1.2', 'K1.2', 'D1.1', 'J2.2', 'D2.1']])
  add('switch limits: heavy motor beside a bare LED counts; unknown motor beside a starved coil stays unknown',
    head(motorBare) === '동작 안 됨 2' && /판단 불가 1/.test(head(motorUnk)), `${head(motorBare)} | ${head(motorUnk)}`)

  // loose battery past a closed switch; a series LED string split by a dead contact
  const loosePast = cz([['BT1', 'Battery', '5V'], ['J1', 'Conn_01x02', 'G'], ['SW1', 'SW', 'S'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+5V', 'BT1.1', 'SW1.1', 'K1.3'], ['BN', 'BT1.2'], ['GND', 'J1.1', 'K1.2', 'D1.1', 'L1.2'], ['KH', 'SW1.2', 'K1.1', 'D1.2'], ['NO', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const split = cz([PWR, ['K1', 'Relay', '12V'], ['D9', 'D', '1N4148'], ['R1', 'R', '100'], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.1', 'D9.2', 'R1.1'], ['GND', 'J1.2', 'K1.2', 'D9.1', 'D2.2'], ['A', 'R1.2', 'D1.1'], ['COM', 'D1.2', 'K1.3'], ['NO', 'K1.4', 'D2.1']])
  add('loose battery past a switch, and an LED string split by a dead contact: one fault each', head(loosePast) === '동작 안 됨 1' && head(split) === '동작 안 됨 1',
    `${head(loosePast)} | ${head(split)}`)

  // a relay under a transistor that cannot be judged follows it
  const multiBase = cz([['J1', 'Conn_01x03', 'PWR'], ['RB', 'R', '1k'], ['RB2', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['K1', 'Relay', '5V'], ['D9', 'D', '1N4148'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'RB.1', 'K1.1', 'D9.2', 'K1.3'], ['SIG', 'J1.2', 'RB2.1'], ['B', 'RB.2', 'RB2.2', 'Q1.1'], ['COL', 'Q1.2', 'K1.2', 'D9.1'], ['GND', 'J1.3', 'Q1.3', 'L1.2'], ['NO', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  add('relay under an undecided transistor: one unknown', head(multiBase) === '판단 불가 1', head(multiBase))

  // an LED whose top is unknown does not follow a broken transistor below it; a named rail behind a dead
  // contact has no supply; a dim LED behind a dead relay's base drive is not a pass
  const topUnk = cz([['J1', 'Conn_01x03', 'PWR'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904'], ['RB', 'R', '1k']],
    [['+5V', 'J1.1'], ['GND', 'J1.2', 'Q1.3'], ['SIG', 'J1.3', 'R1.1'], ['A', 'R1.2', 'D1.1'], ['COL', 'D1.2', 'Q1.2'], ['B', 'RB.2', 'Q1.1'], ['NOWHERE', 'RB.1']])
  const namedNo = cz([['BT1', 'Battery', '5V'], ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['VBAT', 'BT1.1', 'K1.1', 'D1.2', 'K1.3'], ['GND', 'BT1.2', 'K1.2', 'D1.1', 'L1.2'], ['+5V', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const dimBase = cz([PWR, ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['RL', 'R', '47k'], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2', 'K1.3', 'RL.1'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'Q1.3'], ['NO', 'K1.4', 'RB.1'], ['B', 'RB.2', 'Q1.1'], ['LA', 'RL.2', 'L1.1'], ['COL', 'L1.2', 'Q1.2']])
  add('unknown top is not the transistor\'s fault; named rail behind a dead contact; dim LED behind a dead drive',
    !pick(topUnk, 'op_led', 'D1')?.cause && notPass(namedNo, 'op_led', 'L1') && notPass(dimBase, 'op_led', 'L1'),
    `${show(topUnk, 'op_led')} cause=${pick(topUnk, 'op_led', 'D1')?.cause} | ${show(namedNo, 'op_led', 'L1')} | ${show(dimBase, 'op_led', 'L1')}`)

  // a dead regulator hides no fault behind it; an input through a contact to nothing is no relay's fault
  const deadReg10 = cz([['BT1', 'Battery', '6V'], ['U1', 'REG', 'L7805'], ['C1', 'CP', '10uF'], ['R1', 'R', '10'], ['L1', 'LED', 'RED']],
    [['VIN', 'BT1.1', 'U1.3'], ['GND', 'BT1.2', 'U1.1', 'C1.2', 'L1.2'], ['VOUT', 'U1.2', 'C1.1', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const toNothing = cz([PWR, ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148'], ['U1', 'REG', 'L7805'], ['C1', 'CP', '22uF'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2'], ['GND', 'J1.2', 'K1.2', 'D1.1', 'U1.1', 'C1.2', 'L1.2'], ['VIN', 'K1.3', 'U1.3'], ['X', 'K1.4'], ['VOUT', 'U1.2', 'C1.1', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  add('dead regulator: a 10 Ω LED behind it still counts; an input to nothing is not the relay\'s fault',
    head(deadReg10) === '동작 안 됨 2' && pick(toNothing, 'op_led', 'L1')?.cause !== 'K1', `${head(deadReg10)} | ${show(toNothing, 'op_led', 'L1')} cause=${pick(toNothing, 'op_led', 'L1')?.cause}`)

  // the cause named is the coil, the transistor behind it, or nothing: never an unrelated result of the part
  const coilNotDiode = cz([['J1', 'Conn_01x03', 'PWR'], ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['K1', 'Relay', '12V'], ['U1', 'REG', 'L7805'], ['C1', 'CP', '10uF'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+9V', 'J1.1', 'K1.3'], ['GND', 'J1.2', 'Q1.3', 'U1.1', 'C1.2', 'L1.2'], ['+5V', 'J1.3', 'RB.1', 'K1.1'], ['B', 'RB.2', 'Q1.1'], ['C', 'Q1.2', 'K1.2'], ['VIN', 'K1.4', 'U1.3'],
      ['VOUT', 'U1.2', 'C1.1', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const offTransistor = cz([['J1', 'Conn_01x03', 'PWR'], ['RB', 'R', '1k'], ['Q1', 'Q_NPN', '2N3904'], ['K1', 'Relay', '5V'], ['D1', 'D', '1N4148'], ['R1', 'R', '330'], ['L1', 'LED', 'RED']],
    [['+12V', 'J1.1', 'K1.1', 'D1.2'], ['GND', 'J1.2', 'Q1.3', 'L1.2'], ['+5V', 'J1.3', 'K1.3'], ['NOWHERE', 'RB.1'], ['B', 'RB.2', 'Q1.1'], ['C', 'Q1.2', 'K1.2', 'D1.1'], ['NO', 'K1.4', 'R1.1'], ['LA', 'R1.2', 'L1.1']])
  const ruleOnly = cz([['J1', 'Conn_01x02', 'PWR'], ['J2', 'Conn_01x02', 'P5'], ['K1', 'Relay', '12V'], ['D1', 'D', '1N4148']],
    [['+12V', 'J1.1', 'K1.1', 'D1.1', 'K1.3'], ['GND', 'J1.2', 'J2.2', 'K1.2', 'D1.2'], ['+5V', 'J2.1', 'K1.4']])
  add('cause names the coil, the transistor behind it, and never an unrelated result',
    !!pick(coilNotDiode, 'op_led', 'L1')?.detail.some(d => /K1 릴레이 코일 전압 문제에서 이어진/.test(d)) &&
    !!pick(offTransistor, 'op_led', 'L1')?.detail.some(d => /Q1 트랜지스터 켜짐 문제에서 이어진/.test(d)) && head(ruleOnly) === '동작 안 됨 2',
    `${pick(coilNotDiode, 'op_led', 'L1')?.detail[0]} | ${pick(offTransistor, 'op_led', 'L1')?.detail[0]} | ${head(ruleOnly)}`)

  for (const [name, ok, info] of F) check(`O19 ${name}`, ok, info)
}

// O20. review round 6: series diodes, rated values, 555 outputs, motors, diodes across supplies ──
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  const head = (rs: OpResult[]) => operatingHeadline(rs).text
  const notPass = (rs: OpResult[], rule: OpRule, ref: string) => !!pick(rs, rule, ref) && pick(rs, rule, ref)!.state !== 'pass'
  const cz = (refs: Comp[], nets: [string, ...string[]][], style: 'smd' | 'tht' | null = null) => run(circuit(refs, nets), style)
  const PWR3: Comp = ['J1', 'Conn_01x03', 'PWR']
  const drop = (pin: string) => (c: NetGraph) => { const [ref, p] = pin.split('.'); for (const n of c.nets) n.nodes = n.nodes.filter(nd => !(nd.ref === ref && String(nd.pin) === p)) }
  const rename = (from: string, to: string) => (c: NetGraph) => { c.nets.find(n => n.name === from)!.name = to }

  // [0] an LED the 555 output sinks: (9 − 0 − 1.9) / 680 = 10.4 mA at most; a 10 Ω one is its own fault
  const sinkLed = (r4: string) => cz([['BT1', 'Battery', '9V'], ['U1', 'NE555', 'NE555'], ['RA', 'R', '10k'], ['RB', 'R', '68k'], ['CT', 'CP', '10uF'], ['C2', 'C', '10nF'],
    ['R3', 'R', '680'], ['D1', 'LED', 'RED'], ['R4', 'R', r4], ['D2', 'LED', 'RED']],
  [['+9V', 'BT1.1', 'U1.8', 'U1.4', 'RA.1', 'R4.1'], ['GND', 'BT1.2', 'U1.1', 'CT.2', 'C2.2', 'D1.2'], ['DISCH', 'RA.2', 'U1.7', 'RB.1'], ['THRES', 'RB.2', 'U1.6', 'U1.2', 'CT.1'],
    ['CTRL', 'U1.5', 'C2.1'], ['OUT', 'U1.3', 'R3.1', 'D2.2'], ['LA', 'R3.2', 'D1.1'], ['LB', 'R4.2', 'D2.1']])
  const sink = sinkLed('680'), sink10 = sinkLed('10')
  add('[0] LED sunk by a 555 output: passes at 10.4 mA without naming a transistor; 10 Ω is an error',
    is(sink, 'op_led', 'pass', 'D2', /10\.4 mA/) && !/트랜지스터/.test(pick(sink, 'op_led', 'D2')?.summary ?? '트랜지스터') && head(sink) === '동작 검사 통과' &&
    is(sink10, 'op_led', 'error', 'D2') && notPass(sink10, 'op_rpower', 'R4'),
    `${show(sink, 'op_led', 'D2')} | ${head(sink)} | ${show(sink10, 'op_led', 'D2')} | ${show(sink10, 'op_rpower', 'R4')}`)

  // [1] RA 1k at 12 V carries VCC only while discharging: 144 mW × 10/21 = 68.6 mW on average
  const ra1k = cz([['J1', 'Conn_01x02', 'PWR'], ['U1', 'NE555', 'NE555'], ['RA', 'R', '1k'], ['RB', 'R', '10k'], ['CT', 'C', '100nF'], ['C2', 'C', '10nF'], ['R3', 'R', '1k'], ['D1', 'LED', 'RED']],
    [['+12V', 'J1.1', 'U1.8', 'U1.4', 'RA.1'], ['GND', 'J1.2', 'U1.1', 'CT.2', 'C2.2', 'D1.2'], ['DISCH', 'RA.2', 'U1.7', 'RB.1'], ['THRES', 'RB.2', 'U1.6', 'U1.2', 'CT.1'],
      ['CTRL', 'U1.5', 'C2.1'], ['OUT', 'U1.3', 'R3.1'], ['LA', 'R3.2', 'D1.1']])
  add('[1] 555 RA heat averaged over the discharge share', is(ra1k, 'op_rpower', 'pass', 'RA', /68\.6 mW/) && head(ra1k) === '동작 검사 통과', `${show(ra1k, 'op_rpower', 'RA')} | ${head(ra1k)}`)

  // [2] a MOSFET gate on an NPN collector draws no current: the NPN's load is RPU alone (1.2 mA)
  const shifter = cz([['J1', 'Conn_01x03', 'PWR'], ['RB', 'R', '10k'], ['Q1', 'Q_NPN', '2N3904'], ['RPU', 'R', '10k'], ['Q2', 'Q_NMOS', '2N7000'], ['M1', 'Conn_01x02', 'MOTOR 150mA'], ['D1', 'D', '1N4148']],
    [['+12V', 'J1.1', 'RPU.1', 'M1.1', 'D1.2'], ['IN', 'J1.2', 'RB.1'], ['GND', 'J1.3', 'Q1.3', 'Q2.3'], ['B', 'RB.2', 'Q1.1'], ['G', 'RPU.2', 'Q1.2', 'Q2.1'], ['MOT', 'M1.2', 'Q2.2', 'D1.1']])
  add('[2] MOSFET gate is not a load', is(shifter, 'op_drive', 'pass', 'Q1') && is(shifter, 'op_switch', 'pass', 'Q1', /1\.2 mA/), `${show(shifter, 'op_drive', 'Q1')} | ${show(shifter, 'op_switch', 'Q1')}`)

  // [3] a series diode passes its supply on, less up to its forward drop (1N4007 1.1 V, 1N5819 0.6 V)
  const diodeReg = cz([['J1', 'Conn_01x02', 'PWR'], ['D1', 'D', '1N4007'], ['U1', 'REG', 'LM7805'], ['C1', 'CP', '100uF'], ['C2', 'CP', '10uF'], ['R1', 'R', '330'], ['D2', 'LED', 'RED']],
    [['+12V', 'J1.1', 'D1.1'], ['GND', 'J1.2', 'U1.1', 'C1.2', 'C2.2', 'D2.2'], ['VIN', 'D1.2', 'U1.3', 'C1.1'], ['+5V', 'U1.2', 'C2.1', 'R1.1'], ['LA', 'R1.2', 'D2.1']])
  const diodeLed = cz([['BT1', 'Battery', '9V'], ['D1', 'D', '1N5819'], ['R1', 'R', '680'], ['D2', 'LED', 'RED']],
    [['VBAT', 'BT1.1', 'D1.1'], ['VCC', 'D1.2', 'R1.1'], ['LA', 'R1.2', 'D2.1'], ['GND', 'BT1.2', 'D2.2']])
  const diode555 = cz([['BT1', 'Battery', '9V'], ['D1', 'D', '1N4007'], ['U1', 'NE555', 'NE555'], ['R1', 'R', '10k'], ['R2', 'R', '68k'], ['C1', 'CP', '10uF'], ['C2', 'C', '10nF'],
    ['C3', 'C', '100nF'], ['R3', 'R', '680'], ['D2', 'LED', 'RED']],
  [['VBAT', 'BT1.1', 'D1.1'], ['VCC', 'D1.2', 'U1.8', 'U1.4', 'R1.1', 'C3.1'], ['GND', 'BT1.2', 'U1.1', 'C1.2', 'C2.2', 'C3.2', 'D2.2'], ['DISCH', 'R1.2', 'U1.7', 'R2.1'],
    ['THRES', 'R2.2', 'U1.6', 'U1.2', 'C1.1'], ['CTRL', 'U1.5', 'C2.1'], ['OUT', 'U1.3', 'R3.1'], ['LED_A', 'R3.2', 'D2.1']])
  // 8 V through a 1N4007 into a 7805: as low as 8 − 1.1 = 6.9 V, 1.9 V over the output, under the 2.5 V dropout
  const lowReg = cz([['BT1', 'Battery', '8V'], ['D1', 'D', '1N4007'], ['U1', 'REG', 'LM7805'], ['C2', 'CP', '10uF']],
    [['VBAT', 'BT1.1', 'D1.1'], ['GND', 'BT1.2', 'U1.1', 'C2.2'], ['VIN', 'D1.2', 'U1.3'], ['+5V', 'U1.2', 'C2.1']])
  add('[3] series diode: regulator, LED and 555 behind it are judged (with its drop)',
    is(diodeReg, 'op_reg', 'pass', 'U1') && !!pick(diodeReg, 'op_cap', 'C1') && is(diodeLed, 'op_led', 'pass', 'D2', /8\.97~10\.4 mA/) &&
    is(diode555, 'op_555', 'pass', 'U1', /0\.986 Hz/) && is(diode555, 'op_led', 'pass', 'D2') && is(lowReg, 'op_reg', 'error', 'U1'),
    `${show(diodeReg, 'op_reg')} | ${show(diodeLed, 'op_led', 'D2')} | ${show(diode555, 'op_555')} | ${show(lowReg, 'op_reg')}`)

  // [4] values with a rating after them
  const ams = cz([['J1', 'Conn_01x02', 'USB'], ['U1', 'REG', 'AMS1117-3.3'], ['C1', 'CP', '10uF 16V'], ['C2', 'CP', '22uF 16V']],
    [['+5V', 'J1.1', 'U1.3', 'C1.1'], ['GND', 'J1.2', 'U1.1', 'C1.2', 'C2.2'], ['+3V3', 'U1.2', 'C2.1']])
  const ct25 = run(variant(timer, setValue('C1', '10uF 25V'))), r14 = run(variant(led, setValue('R1', '680 1/4W')))
  const parsed = near(parseFarads('22uF 16V'), 22e-6) && near(parseFarads('100uF/25V'), 100e-6) && near(parseFarads('10uF,25V'), 10e-6) && near(parseFarads('22µF 10V'), 22e-6) &&
    parseOhms('680 1/4W') === 680 && parseOhms('470 ohm 1/4W') === 470 && parseOhms('330R 0.25W') === 330 && parseOhms('1k 1%') === 1000 &&
    parseFarads('104') === null && parseOhms('1/4W') === null && parseOhms('4k7') === 4700
  add('[4] "22uF 16V", "680 1/4W", "1k 1%" are read', parsed && is(ams, 'op_reg', 'pass', 'U1') && is(ct25, 'op_555', 'pass', 'U1', /0\.986 Hz/) && is(r14, 'op_led', 'pass', 'D1', /10\.4 mA/),
    `parsed=${parsed} | ${show(ams, 'op_reg')} | ${show(ct25, 'op_555')} | ${show(r14, 'op_led')}`)

  // [5] a battery terminal in no net at all is as loose as one alone on its net
  const noMinus = run(variant(timer, drop('BT1.2')))
  add('[5] battery − terminal in no net: error, the 555 and its LED are not passed',
    is(noMinus, 'op_power', 'error', 'BT1', /어디에도/) && notPass(noMinus, 'op_555', 'U1') && notPass(noMinus, 'op_led', 'D1'),
    `${show(noMinus, 'op_power')} | ${show(noMinus, 'op_555')} | ${show(noMinus, 'op_led')}`)

  // [6] a battery value with no voltage in it: its rails are not taken from their names
  const unread = ['2xAA', 'CR2032', '18650'].map(v => run(variant(timer, c => { rename('VCC', '+5V')(c); setValue('BT1', v)(c) })))
  add('[6] battery value not read: op_power unknown, 555 not passed',
    unread.every(rs => is(rs, 'op_power', 'unknown', 'BT1') && notPass(rs, 'op_555', 'U1') && head(rs) !== '동작 검사 통과'),
    unread.map(rs => `${show(rs, 'op_power')} · ${show(rs, 'op_555')}`).join(' | '))

  // [7] a battery whose + is on GND makes the motor supply −9 V: the MOSFET conducts backwards
  const negSupply = cz([['BT1', 'Battery', '9V'], ['J1', 'Conn_01x02', 'P5'], ['J2', 'Conn_01x02', 'MOTOR 0.1A'], ['D1', 'D', '1N4148'], ['Q1', 'Q_NMOS', '2N7000'], ['R1', 'R', '100'], ['R2', 'R', '10k']],
    [['GND', 'BT1.1', 'J1.2', 'Q1.3', 'R2.2'], ['VBAT', 'BT1.2', 'J2.1', 'D1.2'], ['MOT', 'J2.2', 'D1.1', 'Q1.2'], ['+5V', 'J1.1', 'R1.1'], ['G', 'R1.2', 'R2.1', 'Q1.1']])
  add('[7] load supply below 0 V: switch error', is(negSupply, 'op_switch', 'error', 'Q1', /0 V보다 낮아/) && head(negSupply) !== '동작 검사 통과', `${show(negSupply, 'op_switch')} | ${head(negSupply)}`)

  // [8] a flyback diode to +5V while the coil sits on +12V keeps conducting
  const lowK = cz([PWR3, ['J2', 'Conn_01x02', 'SIG'], ['K1', 'Relay', '12V'], ['Q1', 'Q_NPN', '2N3904'], ['R1', 'R', '1k'], ['D1', 'D', '1N4148']],
    [['+12V', 'J1.1', 'K1.1'], ['+5V', 'J1.2', 'D1.2'], ['GND', 'J1.3', 'Q1.3', 'J2.2'], ['COIL_LOW', 'K1.2', 'Q1.2', 'D1.1'], ['B', 'R1.2', 'Q1.1'], ['SIG', 'J2.1', 'R1.1']])
  const lowM = cz([PWR3, ['J2', 'Conn_01x02', 'MOTOR 0.1A'], ['Q1', 'Q_NMOS', '2N7000'], ['RG', 'R', '100'], ['D1', 'D', '1N4148']],
    [['+12V', 'J1.1', 'J2.1'], ['+5V', 'J1.2', 'RG.1', 'D1.2'], ['GND', 'J1.3', 'Q1.3'], ['MOT', 'J2.2', 'Q1.2', 'D1.1'], ['G', 'RG.2', 'Q1.1']])
  add('[8] flyback diode to a lower rail: error', is(lowK, 'op_flyback', 'error', 'K1', /낮은/) && is(lowM, 'op_flyback', 'error', 'J2', /낮은/),
    `${show(lowK, 'op_flyback')} | ${show(lowM, 'op_flyback')}`)

  // [9] a diode forward across the supply; put the right way round it is not a short
  const fwdM = cz([['J1', 'Conn_01x02', 'PWR'], ['J2', 'Conn_01x02', 'MOTOR 0.2A'], ['D1', 'D', '1N4148']], [['+12V', 'J1.1', 'J2.1', 'D1.1'], ['GND', 'J1.2', 'J2.2', 'D1.2']])
  const shunt = (a: string, k: string) => cz([['BT1', 'Battery', '9V'], ['D1', 'D', '1N4007'], ['R1', 'R', '680'], ['D2', 'LED', 'RED']],
    [['+9V', 'BT1.1', `D1.${a}`, 'R1.1'], ['GND', 'BT1.2', `D1.${k}`, 'D2.2'], ['LA', 'R1.2', 'D2.1']])
  const fwdS = shunt('1', '2'), okS = shunt('2', '1')
  add('[9] diode forward across a supply: op_short error; reverse shunt passes',
    is(fwdM, 'op_short', 'error', 'D1') && is(fwdS, 'op_short', 'error', 'D1') && !pick(okS, 'op_short') && head(okS) === '동작 검사 통과',
    `${show(fwdM, 'op_short')} | ${show(fwdS, 'op_short')} | ${head(okS)}`)

  // [10] a series diode put in backwards leaves the named rail behind it without a supply
  const backD = cz([['BT1', 'Battery', '9V'], ['D1', 'D', '1N4007'], ['R1', 'R', '680'], ['D2', 'LED', 'RED']],
    [['VBAT', 'BT1.1', 'D1.2'], ['+9V', 'D1.1', 'R1.1'], ['GND', 'BT1.2', 'D2.2'], ['LA', 'R1.2', 'D2.1']])
  const fwdD = cz([['BT1', 'Battery', '9V'], ['D1', 'D', '1N4007'], ['R1', 'R', '680'], ['D2', 'LED', 'RED']],
    [['VBAT', 'BT1.1', 'D1.1'], ['+9V', 'D1.2', 'R1.1'], ['GND', 'BT1.2', 'D2.2'], ['LA', 'R1.2', 'D2.1']])
  add('[10] reversed series diode: LED not passed, caused by D1; the right way round passes',
    notPass(backD, 'op_led', 'D2') && pick(backD, 'op_led', 'D2')?.cause === 'D1' && is(fwdD, 'op_led', 'pass', 'D2', /8\.24~10\.4 mA/),
    `${show(backD, 'op_led')} cause=${pick(backD, 'op_led', 'D2')?.cause} | ${show(fwdD, 'op_led')}`)

  // [11] a motor between GND and the drain has no supply side
  const gndMotor = cz([PWR3, ['J2', 'Conn_01x02', 'MOTOR 0.1A'], ['D1', 'D', '1N4148'], ['Q1', 'Q_NMOS', '2N7000'], ['RG', 'R', '100']],
    [['+12V', 'J1.1'], ['+5V', 'J1.2', 'RG.1'], ['GND', 'J1.3', 'J2.1', 'D1.2', 'Q1.3'], ['MOT', 'J2.2', 'D1.1', 'Q1.2'], ['G', 'RG.2', 'Q1.1']])
  add('[11] motor with no supply side: error', is(gndMotor, 'op_switch', 'error', 'Q1', /전원 쪽이 없습니다/), show(gndMotor, 'op_switch'))

  // [12] the rated voltage written on a motor: 3 V on 12 V is an error; 5 V 100 mA on 12 V draws about 240 mA
  const rated = (v: string) => cz([PWR3, ['J2', 'Conn_01x02', v], ['D1', 'D', '1N4148'], ['Q1', 'Q_NMOS', '2N7000'], ['RG', 'R', '100']],
    [['+12V', 'J1.1', 'J2.1', 'D1.2'], ['+5V', 'J1.2', 'RG.1'], ['GND', 'J1.3', 'Q1.3'], ['MOT', 'J2.2', 'D1.1', 'Q1.2'], ['G', 'RG.2', 'Q1.1']])
  const m3 = rated('MOTOR 3V 0.1A'), m5 = rated('MOTOR 5V 100mA'), m12 = rated('MOTOR 12V 0.1A')
  add('[12] motor over its rated voltage: error (and the switch current scaled); at its rating it passes',
    is(m3, 'op_switch', 'error', 'Q1', /정격 3 V/) && is(m5, 'op_switch', 'error', 'Q1', /정격 5 V/) && !!pick(m5, 'op_switch', 'Q1')?.detail.some(d => /240 mA/.test(d)) &&
    is(m12, 'op_switch', 'pass', 'Q1'),
    `${show(m3, 'op_switch')} | ${pick(m5, 'op_switch', 'Q1')?.detail.join(' / ')} | ${show(m12, 'op_switch')}`)

  // [13] the 555 output tied to GND or VCC
  const outGnd = run(variant(timer, movePin('U1.3', 'GND'))), outVcc = run(variant(timer, movePin('U1.3', 'VCC')))
  add('[13] 555 OUT on a rail: error', is(outGnd, 'op_555', 'error', 'U1', /OUT/) && is(outVcc, 'op_555', 'error', 'U1', /OUT/), `${show(outGnd, 'op_555')} | ${show(outVcc, 'op_555')}`)

  // [14] 470 Ω from the 555 output to GND: 9² / 470 = 172 mW; 10 Ω in series with a 0.2 A motor: 0.4 W
  const outR = run(variant(timer, c => { setValue('R3', '470')(c); movePin('R3.2', 'GND')(c) }))
  const motorR = cz([PWR3, ['RS', 'R', '10'], ['J2', 'Conn_01x02', 'MOTOR 0.2A'], ['D1', 'D', '1N4148'], ['Q1', 'Q_NMOS', 'NDS7002A'], ['RG', 'R', '100']],
    [['+12V', 'J1.1', 'RS.1'], ['+5V', 'J1.2', 'RG.1'], ['GND', 'J1.3', 'Q1.3'], ['MT', 'RS.2', 'J2.1', 'D1.2'], ['MOT', 'J2.2', 'D1.1', 'Q1.2'], ['G', 'RG.2', 'Q1.1']])
  add('[14] resistor heat at a 555 output and in series with a motor', is(outR, 'op_rpower', 'error', 'R3', /172 mW/) && is(motorR, 'op_rpower', 'error', 'RS', /400 mW/),
    `${show(outR, 'op_rpower', 'R3')} | ${show(motorR, 'op_rpower', 'RS')}`)

  // [15] three red LEDs (2.0 V each, smd) on exactly 6 V with no resistor: no NaN, same verdict as 6.1 V
  const bare = (v: string) => cz([['BT1', 'Battery', v], ['D1', 'LED', 'RED'], ['D2', 'LED', 'RED'], ['D3', 'LED', 'RED'], ['Q1', 'Q_NPN', '2N3904'], ['R1', 'R', '1k']],
    [['VBAT', 'BT1.1', 'D1.1', 'R1.1'], ['N1', 'D1.2', 'D2.1'], ['N2', 'D2.2', 'D3.1'], ['C', 'D3.2', 'Q1.2'], ['B', 'R1.2', 'Q1.1'], ['GND', 'BT1.2', 'Q1.3']], 'smd')
  const exact = bare('4x1.5V'), over = bare('6.1V')
  add('[15] LED string exactly at the supply: no NaN, same drive verdict as just above it',
    verdictProblems(exact).length === 0 && pick(exact, 'op_drive', 'Q1')?.state === pick(over, 'op_drive', 'Q1')?.state && pick(exact, 'op_drive', 'Q1')?.cause === 'D1',
    `${show(exact, 'op_drive')} cause=${pick(exact, 'op_drive', 'Q1')?.cause} | ${show(over, 'op_drive')} | ${verdictProblems(exact).slice(0, 2).join(' / ')}`)

  // the two diodes added to the parts table
  add('1N4007 and 1N5819 in the parts table', SPECS.diode['1N4007']?.vf_max.v === 1.1 && SPECS.diode['1N4007']?.vrrm.v === 1000 && SPECS.diode['1N5819']?.vf_max.v === 0.6 && SPECS.diode['1N5819']?.vrrm.v === 40,
    `${SPECS.diode['1N4007']?.vf_max.src} | ${SPECS.diode['1N5819']?.vf_max.src}`)

  // every verdict since O14 reads as text too
  const problems = verdictProblems(ALL)
  add('every verdict from O15 on: basis, no NaN, distinct numbers', problems.length === 0, `${ALL.length} results${problems.length ? ' · ' + [...new Set(problems)].slice(0, 4).join(' | ') : ''}`)

  for (const [name, ok, info] of F) check(`O20 ${name}`, ok, info)
}

// O21. sweep of 2026-11-06: a second ground cut off from the supply's ground is no ground (the battery's − on GND, the
// LEDs' cathodes on an AGND joined to nothing read '동작 검사 통과') ──
{
  const onGround = (ground: string) => circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED'], ['C1', 'C', '100nF']],
    [['VCC', 'BT1.1', 'R1.1', 'C1.1'], ['GND', 'BT1.2', 'C1.2'], ['LED_A', 'R1.2', 'D1.1'], [ground, 'D1.2']])
  const cut = (rs: OpResult[]) => is(rs, 'op_power', 'error', 'BT1', /이어져 있지 않습니다/) && pick(rs, 'op_led', 'D1')?.state === 'unknown' && pick(rs, 'op_led', 'D1')?.cause === 'BT1'
    && operatingHeadline(rs).state === 'error'
  const allPass = (rs: OpResult[]) => rs.every(r => r.state === 'pass') && is(rs, 'op_led', 'pass', 'D1')
  const names = ['AGND', 'PGND', 'GND2', 'VSS'].filter(n => !cut(run(onGround(n))))
  check('O21 AGND, PGND, GND2 and VSS joined to nothing: op_power error, the LED on them not judged, not passed', !names.length,
    `not caught: [${names}] · ${show(run(onGround('AGND')), 'op_power')} | ${show(run(onGround('AGND')), 'op_led')}`)

  // a regulator whose ground pin is only on AGND: nothing it feeds has a voltage
  const regCut = (g: string) => circuit([['BT1', 'Battery', '9V'], ['U1', 'REG', 'AMS1117-3.3'], ['C1', 'CP', '22uF'], ['C2', 'C', '100nF'], ['R1', 'R', '100'], ['D1', 'LED', 'RED']],
    [['VIN', 'BT1.1', 'U1.3', 'C2.1'], ['GND', 'BT1.2', 'C2.2'], [g, 'U1.1', 'C1.2', 'D1.2'], ['V3', 'U1.2', 'C1.1', 'R1.1'], ['LED_A', 'R1.2', 'D1.1']])
  const rc = run(regCut('AGND'))
  check('O21b a regulator\'s ground pin only on AGND: op_reg and the LED it feeds are not passed',
    is(rc, 'op_power', 'error', 'BT1', /AGND/) && pick(rc, 'op_reg', 'U1')?.state !== 'pass' && pick(rc, 'op_led', 'D1')?.state !== 'pass' && operatingHeadline(rc).state === 'error',
    `${show(rc, 'op_power')} | ${show(rc, 'op_reg')} | ${show(rc, 'op_led')}`)

  // joined to the supply's ground it is that ground: a net tie, a small shunt, an inductor, a switch or a low-side
  // transistor, a tie through a net of no name; a resistor of more than 1 Ω is no tie
  const tie = (comps: Comp[], ...nets: [string, ...string[]][]) => circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED'], ...comps],
    [['VCC', 'BT1.1', 'R1.1'], ['LED_A', 'R1.2', 'D1.1'], ...nets])
  const zero = tie([['R2', 'R', '0']], ['GND', 'BT1.2', 'R2.1'], ['AGND', 'D1.2', 'R2.2'])
  const fine = {
    netTie: allPass(run(zero)), shunt: allPass(run(variant(zero, setValue('R2', '0.1')))), oneOhm: !run(variant(zero, setValue('R2', '1'))).some(r => r.rule === 'op_power'),
    noValue: !run(variant(zero, setValue('R2', ''))).some(r => r.rule === 'op_power'),
    inductor: !run(tie([['L1', 'L', '10uH']], ['GND', 'BT1.2', 'L1.1'], ['AGND', 'D1.2', 'L1.2'])).some(r => r.rule === 'op_power'),
    twoSteps: !run(tie([['R2', 'R', '0'], ['L1', 'L', '10uH']], ['GND', 'BT1.2', 'R2.1'], ['MID', 'R2.2', 'L1.1'], ['AGND', 'D1.2', 'L1.2'])).some(r => r.rule === 'op_power'),
    lowSide: !run(tie([['Q1', 'Q_NMOS', '2N7000'], ['R2', 'R', '1k'], ['J1', 'Conn_01x01', 'IN']], ['GND', 'BT1.2', 'Q1.3'], ['GND_SW', 'D1.2', 'Q1.2'], ['GATE', 'Q1.1', 'R2.2'], ['IN', 'R2.1', 'J1.1'])).some(r => r.rule === 'op_power'),
    connector: !run(variant(onGround('AGND'), c => { c.components.push({ ref: 'J1', name: 'Conn_01x01', value: 'AUX' }); movePin('J1.1', 'AGND')(c) })).some(r => r.rule === 'op_power'),
    // a switch beside a connector's ground (no battery walks across it), and a relay in the return: judged released first
    switched: !run(circuit([['J1', 'Conn_01x02', 'PWR_IN'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['SW1', 'SW', '']],
      [['+5V', 'J1.1', 'R1.1'], ['GND', 'J1.2', 'SW1.1'], ['AGND', 'SW1.2', 'D1.2'], ['LED_A', 'R1.2', 'D1.1']])).some(r => r.rule === 'op_power'),
    relay: !run(circuit([['BT1', 'Battery', '5V'], ['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['K1', 'Relay', '5V'], ['D2', 'D', '1N4148']],
      [['VCC', 'BT1.1', 'R1.1', 'K1.1', 'D2.2'], ['GND', 'BT1.2', 'K1.2', 'K1.3', 'D2.1'], ['GND_LOAD', 'K1.4', 'D1.2'], ['LED_A', 'R1.2', 'D1.1']])).some(r => r.rule === 'op_power'),
    tenOhms: cut(run(variant(zero, setValue('R2', '10')))),
  }
  check('O21c joined by a net tie, a small resistor, an inductor or a low-side switch, or with a connector on it: no fault; 10 Ω is no tie', Object.values(fine).every(Boolean), JSON.stringify(fine))

  // the two sides of the same question: batteries with their own grounds, a connector supply, a battery with no GND
  // joined by a shunt to one, and no source on any ground (names stand, as they did)
  const twoBatteries = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED'], ['BT2', 'Battery', '5V'], ['R2', 'R', '330'], ['D2', 'LED', 'RED']],
    [['VCC', 'BT1.1', 'R1.1'], ['LED_A', 'R1.2', 'D1.1'], ['GND', 'BT1.2', 'D1.2'], ['V2', 'BT2.1', 'R2.1'], ['LED_B', 'R2.2', 'D2.1'], ['GND2', 'BT2.2', 'D2.2']])
  const viaConn = circuit([['J1', 'Conn_01x02', 'PWR_IN'], ['R1', 'R', '680'], ['D1', 'LED', 'RED']], [['+5V', 'J1.1', 'R1.1'], ['GND', 'J1.2'], ['LED_A', 'R1.2', 'D1.1'], ['AGND', 'D1.2']])
  const namesOnly = circuit([['R1', 'R', '330'], ['D1', 'LED', 'RED'], ['C1', 'C', '100nF']], [['+5V', 'R1.1', 'C1.1'], ['LED_A', 'R1.2', 'D1.1'], ['AGND', 'D1.2'], ['GND', 'C1.2']])
  const shuntBack = circuit([['BT1', 'Battery', '9V'], ['R1', 'R', '680'], ['D1', 'LED', 'RED'], ['R2', 'R', '0.1']],
    [['VCC', 'BT1.1', 'R1.1'], ['LED_A', 'R1.2', 'D1.1'], ['GND', 'D1.2', 'R2.1'], ['BAT_N', 'BT1.2', 'R2.2']])
  const vc = run(viaConn)
  const other = {
    twoBatteries: allPass(run(twoBatteries)) && is(run(twoBatteries), 'op_led', 'pass', 'D2'),
    viaConn: is(vc, 'op_power', 'error', 'J1', /AGND.*전원 쪽 GND와/) && pick(vc, 'op_led', 'D1')?.state === 'unknown',
    namesOnly: allPass(run(namesOnly)),
    shuntBack: !run(shuntBack).some(r => r.rule === 'op_power') && is(run(shuntBack), 'op_led', 'pass', 'D1'),
    anyOrder: full(run(onGround('AGND'))) === full(run(reversed(onGround('AGND')))),
  }
  check('O21d separate batteries each with a ground pass; a connector supply\'s AGND is cut too; no source on any ground: the names stand; the order of the listing changes nothing',
    Object.values(other).every(Boolean), `${JSON.stringify(other)} · ${show(vc, 'op_power')}`)
}

// O22. CIR101 (the PCB is refused for an LED with no resistor) against what is known by construction (2026-11-07: R -
// protection diode - LED and R - switch - LED with a capacitor on the switch's output were refused). Random chains from the
// supply to GND of resistors, diodes (with and without a value), switches, LEDs and relay contacts (COM to NO or NC, the
// coil across the supply or behind a switch), with capacitors to GND hanging off. An LED in a chain with a resistor is
// never refused; one in a chain with none is always refused. In some circuits a resistor to GND, or another LED with its
// own resistor, hangs off a chain too: a resistor that is not in the chain, which the rule may take for one (allowed, so
// it is counted, not failed: blocking a good circuit is worse than missing a bad one, the operating check still judges
// it). Whatever CIR101 refuses, op_led does not pass
{
  let seed = 20261107
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const choose = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]
  const tally = { good: 0, bad: 0, loose: 0, refusedGood: 0, passedBad: 0, passedLoose: 0, refusedButPass: 0, circuits: 0 }
  const examples: string[] = []
  for (let i = 0; i < 1500; i++) {
    const comps: Comp[] = [], pins = new Map<string, string[]>(), count: Record<string, number> = {}
    const put = (net: string, pin: string) => pins.set(net, [...(pins.get(net) || []), pin])
    const add = (prefix: string, name: string, value: string) => { const ref = `${prefix}${(count[prefix] = (count[prefix] || 0) + 1)}`; comps.push([ref, name, value]); return ref }
    let nets = 0
    const fresh = () => `N${++nets}`
    const truth = new Map<string, 'good' | 'bad' | 'loose'>()
    const bt = add('BT', 'Battery', choose(['5V', '9V', '12V']))
    put('VCC', `${bt}.1`); put('GND', `${bt}.2`)
    const decoys = rnd() < 0.3
    for (let chain = 1 + Math.floor(rnd() * 2); chain > 0; chain--) {
      const len = 1 + Math.floor(rnd() * 5)
      const kinds = Array.from({ length: len }, () => choose(['R', 'D', 'D?', 'SW', 'LED', 'LED', 'K'] as const))
      if (!kinds.includes('LED')) kinds[Math.floor(rnd() * len)] = 'LED'
      const leds: string[] = []
      let upper = 'VCC'
      kinds.forEach((k, at) => {
        const lower = at === len - 1 ? 'GND' : fresh()
        const two = (ref: string, swap: boolean) => { put(upper, `${ref}.${swap ? 2 : 1}`); put(lower, `${ref}.${swap ? 1 : 2}`) }
        if (k === 'R') two(add('R', 'R', choose(['330', '1k', '4k7'])), rnd() < 0.5)
        if (k === 'D' || k === 'D?') two(add('D', 'D', k === 'D' ? '1N4148' : ''), false)
        if (k === 'LED') { const d = add('D', 'LED', choose(['RED', 'GREEN', ''])); two(d, false); leds.push(d) }
        if (k === 'SW') two(add('SW', 'SW', ''), rnd() < 0.5)
        if (k === 'K') {
          const kr = add('K', 'Relay', '5V')
          if (rnd() < 0.5) { put('VCC', `${kr}.1`); put('GND', `${kr}.2`) }
          else { const sw = add('SW', 'SW', ''), low = fresh(); put('VCC', `${kr}.1`); put(low, `${kr}.2`); put(low, `${sw}.1`); put('GND', `${sw}.2`) }
          const [a, z] = choose([[3, 4], [4, 3], [3, 5], [5, 3]] as const)
          put(upper, `${kr}.${a}`); put(lower, `${kr}.${z}`)
        }
        if (lower !== 'GND') {
          if (rnd() < 0.35) { const c = add('C', 'C', '100nF'); put(lower, `${c}.1`); put('GND', `${c}.2`) }
          if (decoys && rnd() < 0.3) {
            if (rnd() < 0.5) { const r = add('R', 'R', '10k'); put(lower, `${r}.1`); put('GND', `${r}.2`) }
            else { const d = add('D', 'LED', 'RED'), r = add('R', 'R', '1k'), m = fresh(); put(lower, `${d}.1`); put(m, `${d}.2`); put(m, `${r}.1`); put('GND', `${r}.2`); truth.set(d, 'good') }
          }
        }
        upper = lower
      })
      for (const d of leds) truth.set(d, kinds.includes('R') ? 'good' : decoys ? 'loose' : 'bad')
    }
    const g = circuit(comps, [...pins].map(([name, list]) => [name, ...list] as [string, ...string[]]))
    const refused = new Set(validateCircuit(g).filter(x => x.code === 'CIR101').flatMap(x => x.refs))
    const op = operatingChecks(fromGraph(g))
    tally.circuits++
    for (const [ref, t] of truth) {
      tally[t]++
      const wrong = t === 'good' ? refused.has(ref) : t === 'bad' && !refused.has(ref)
      if (t === 'good' && refused.has(ref)) tally.refusedGood++
      if (t === 'bad' && !refused.has(ref)) tally.passedBad++
      if (t === 'loose' && !refused.has(ref)) tally.passedLoose++
      if (refused.has(ref) && pick(op, 'op_led', ref)?.state === 'pass') { tally.refusedButPass++; examples.push(`${ref} refused, op_led pass: ${JSON.stringify(g)}`) }
      if (wrong && examples.length < 2) examples.push(`${ref} ${t}: ${JSON.stringify(g)}`)
    }
  }
  check('O22 CIR101 on random chains: none with a resistor refused, every one with none refused, nothing refused passes op_led',
    tally.refusedGood === 0 && tally.passedBad === 0 && tally.refusedButPass === 0 && tally.good > 1000 && tally.bad > 1000,
    `${JSON.stringify(tally)}${examples.length ? ' · ' + examples.slice(0, 2).join(' || ') : ''}`)
}

// O23. an MCU pin on a MOSFET gate (2026-11-08). MCUs reach the board through a header, so the header's value is what
// says the pin's level: a board or chip name ("ESP32", "Arduino Uno") or a written level ("3V3") gives that one voltage,
// a value naming none keeps 3.3 V and 5 V, a power header (PWR) is no signal. IRFZ44N (RDS(on) only at VGS 10 V) and
// IRLZ44N (down to 4 V) come from their datasheets and are matched by name without mixing the two up
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  type Wire = [string, ...string[]]
  // a 12 V 0.5 A motor (1N4007 across it) under Q1; the gate on J1 pin 1, through RG 100 Ω or straight, RP 10 kΩ to GND
  const gate = (header: string, mos: string, rg = true) => run(circuit(
    [['J1', 'Conn_01x02', header], ['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', 'MOTOR 12V 0.5A'], ['D1', 'D', '1N4007'],
      ['Q1', 'Q_NMOS', mos], ['RP', 'R', '10k'], ...(rg ? [['RG', 'R', '100'] as Comp] : [])],
    [...(rg ? [['IO', 'J1.1', 'RG.1'], ['G', 'RG.2', 'Q1.1', 'RP.1']] as Wire[] : [['G', 'J1.1', 'Q1.1', 'RP.1']] as Wire[]),
      ['+12V', 'J2.1', 'M1.1', 'D1.2'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'], ['GND', 'J1.2', 'J2.2', 'Q1.3', 'RP.2']]))
  // the same motor with the gate from the +5V rail through RG (no pull-down needed: VGS is the whole 5 V, as in O5c)
  const rail = (mos: string) => run(circuit(
    [['J2', 'Conn_01x03', 'PWR'], ['M1', 'Conn_01x02', 'MOTOR 12V 0.5A'], ['D1', 'D', '1N4007'], ['Q1', 'Q_NMOS', mos], ['RG', 'R', '100']],
    [['+12V', 'J2.1', 'M1.1', 'D1.2'], ['+5V', 'J2.2', 'RG.1'], ['G', 'RG.2', 'Q1.1'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'], ['GND', 'J2.3', 'Q1.3']]))
  const drive = (rs: OpResult[], ref = 'Q1') => pick(rs, 'op_drive', ref)
  const has = (rs: OpResult[], re: RegExp) => !!drive(rs)?.detail.some(d => re.test(d))
  const fix = (rs: OpResult[]) => drive(rs)?.fix ?? ''
  const both = (rs: OpResult[]) => has(rs, /^3\.3 V: VGS/) && has(rs, /^5 V: VGS/)
  const said = (rs: OpResult[], ref = 'Q1') => {
    const r = drive(rs, ref)
    return r ? `${r.state}: ${r.summary} [${r.detail.filter(d => /^(구동 전압|3\.3 V|5 V)|자료가 없어/.test(d)).join(' / ')}]${r.fix ? ` fix: ${r.fix}` : ''}` : '(no op_drive)'
  }

  const espIrf = gate('ESP32', 'IRFZ44N')
  add('ESP32 header through RG on an IRFZ44N: 3.3 V only, under VGS(th) max 4 V, may not turn on; the fix says no part in the table is rated at 3.3 V',
    is(espIrf, 'op_drive', 'error', 'Q1', /3\.27 V < 문턱 최대 4 V: 켜지지 않을 수 있습니다/) && has(espIrf, /^구동 전압: J1 값 ESP32 → 3\.3 V 신호로 계산$/) && !has(espIrf, /^5 V: VGS/)
    && /3\.3 V 신호로는 앱 부품표의 어느 MOSFET도/.test(fix(espIrf)) && /논리 레벨/.test(fix(espIrf)) && /게이트 드라이버/.test(fix(espIrf)) && /NPN 트랜지스터로 12 V 전원을/.test(fix(espIrf)),
    said(espIrf))
  const unoIrl = gate('Arduino Uno', 'IRLZ44N', false)
  add('Arduino Uno header straight on an IRLZ44N with a 10 kΩ pull-down: 5 V ≥ its 4 V guarantee, passes, the switch too',
    is(unoIrl, 'op_drive', 'pass', 'Q1', /완전히 켜짐 \(VGS 5 V ≥ 4 V\)/) && has(unoIrl, /^구동 전압: J1 값 Arduino Uno → 5 V 신호로 계산$/) && !has(unoIrl, /^3\.3 V: VGS/)
    && is(unoIrl, 'op_switch', 'pass', 'Q1'),
    `${said(unoIrl)} | ${show(unoIrl, 'op_switch')}`)
  const espIrl = gate('ESP32', 'IRLZ44N', false)
  add('ESP32 header straight on an IRLZ44N: 3.3 V is over its 2 V threshold but under its 4 V guarantee, a warning; IRLZ44N is not offered to itself',
    is(espIrl, 'op_drive', 'warn', 'Q1', /게이트 3\.3 V: 문턱은 넘지만 켜짐 저항 보장 전압 4 V 미만/) && has(espIrl, /^구동 전압: J1 값 ESP32 → 3\.3 V 신호로 계산$/)
    && /3\.3 V 신호로는 앱 부품표의 어느 MOSFET도/.test(fix(espIrl)) && !/IRLZ44N으로 바꾸/.test(fix(espIrl)),
    said(espIrl))
  const sigIrf = gate('SIG', 'IRFZ44N')
  add('IRFZ44N from a header naming nothing: 3.3 V and 5 V lines both, not passed; 3.3 V may not turn on, 5 V is not "완전히 켜짐"; 5 V is offered IRLZ44N',
    both(sigIrf) && !!drive(sigIrf) && drive(sigIrf)!.state !== 'pass' && has(sigIrf, /^3\.3 V: VGS 3\.27 V .*켜지지 않을 수 있음$/) && has(sigIrf, /^5 V: VGS 4\.95 V .*켜짐 저항 보장 전압 미만$/)
    && !/완전히 켜짐/.test(`${drive(sigIrf)!.summary} ${drive(sigIrf)!.detail.join(' ')}`) && /3\.3 V 신호는 .*켜지지 않을 수 있고/.test(drive(sigIrf)!.summary)
    && /5 V 신호라면 .*IRLZ44N으로 바꾸면/.test(fix(sigIrf)) && /3\.3 V 신호로는/.test(fix(sigIrf)),
    said(sigIrf))
  const irf5 = rail('IRFZ44N'), irl5 = rail('IRLZ44N')
  add('a 5 V rail on an IRFZ44N gate no longer reads "완전히 켜짐" (RDS(on) only at 10 V) and IRLZ44N is offered; the same rail on an IRLZ44N passes',
    is(irf5, 'op_drive', 'warn', 'Q1', /켜짐 저항 보장 전압 10 V 미만/) && !/완전히 켜짐/.test(drive(irf5)?.summary ?? '') && /IRLZ44N으로 바꾸면/.test(fix(irf5))
    && is(irl5, 'op_drive', 'pass', 'Q1', /완전히 켜짐/),
    `${said(irf5)} | ${said(irl5)}`)
  const detail = (v: string) => drive(gate('SIG', v))?.detail ?? []
  const irlPbf = detail('IRLZ44NPBF'), irfPbf = detail('IRFZ44NPBF'), irlNoN = detail('IRLZ44')
  const t = SPECS.mos
  add('IRLZ44NPBF reads as IRLZ44N, IRFZ44NPBF as IRFZ44N, neither as the other; IRLZ44 (no N) is neither; the table holds the datasheet numbers',
    irlPbf.some(d => /^게이트 문턱 최대 2 V: .*IRLZ44NPbF/.test(d)) && !irlPbf.some(d => /자료가 없어|IRFZ44N/.test(d))
    && irfPbf.some(d => /^게이트 문턱 최대 4 V: .*IRFZ44NPbF/.test(d)) && !irfPbf.some(d => /자료가 없어|IRLZ44N/.test(d))
    && irlNoN.some(d => /값 IRLZ44의 자료가 없어 2N7002 기준/.test(d))
    && t.IRFZ44N?.vgs_th_max.v === 4 && t.IRFZ44N?.vgs_rated.v === 10 && t.IRFZ44N?.rds_on.v === 0.0175 && t.IRFZ44N?.id_max.v === 49 && t.IRFZ44N?.vgs_max.v === 20 && t.IRFZ44N?.vds_max.v === 55
    && t.IRLZ44N?.vgs_th_max.v === 2 && t.IRLZ44N?.vgs_rated.v === 4 && t.IRLZ44N?.rds_on.v === 0.035 && t.IRLZ44N?.id_max.v === 47 && t.IRLZ44N?.vgs_max.v === 16 && t.IRLZ44N?.vds_max.v === 55,
    `${irlPbf[0]} | ${irfPbf[0]} | ${irlNoN[0]}`)
  // which header values name a level; a board's own chip wins over its family name (Nano ESP32, Nano 33, Jetson Nano are 3.3 V)
  const levels: [string, 3.3 | 5 | null][] = [['ESP32', 3.3], ['ESP32-S3 DevKit', 3.3], ['ESP8266 NodeMCU', 3.3], ['STM32 Blue Pill', 3.3], ['RP2040', 3.3],
    ['Raspberry Pi Pico', 3.3], ['3V3 GPIO', 3.3], ['3.3V', 3.3], ['Arduino Uno', 5], ['Arduino Nano', 5], ['Arduino Mega 2560', 5], ['5V', 5], ['ATmega328P', null],
    ['Arduino Nano ESP32', 3.3], ['Arduino Nano 33 IoT', 3.3], ['Jetson Nano', 3.3], ['ESP32 5V', 3.3],
    ['SIG', null], ['PWR', null], ['PWR 5V', null], ['PWR_IN', null], ['Arduino', null], ['3.3V/5V', null], ['15V', null]]
  const misread = levels.filter(([v, lv]) => {
    const rs = gate(v, 'IRLZ44N')
    if (lv == null) return !both(rs) || has(rs, /신호로 계산/)
    return !drive(rs)?.detail.includes(`구동 전압: J1 값 ${v} → ${lv} V 신호로 계산`) || has(rs, lv === 5 ? /^3\.3 V: VGS/ : /^5 V: VGS/)
  })
  add('header values: MCU boards, chips and written levels give one level, power headers and values naming none or both keep 3.3 V and 5 V',
    misread.length === 0, misread.map(([v, lv]) => `${v} (${lv ?? 'none'}): ${said(gate(v, 'IRLZ44N'))}`).join(' || '))
  // an NPN base from the same header: the relay of O4 with 1.5 kΩ, where only a 5 V signal is enough
  const relayAt = (header: string) => run(variant(variant(relay, setValue('R1', '1.5k')), setValue('J1', header)))
  const npnEsp = relayAt('ESP32'), npnUno = relayAt('Arduino Uno'), npnNone = relayAt('PWR_IN')
  add('an NPN base from a named header takes the same one level: 1.5 kΩ from an Arduino Uno passes, from an ESP32 does not; PWR_IN still says only 5 V',
    is(npnUno, 'op_drive', 'pass', 'Q1') && !!drive(npnEsp) && drive(npnEsp)!.state !== 'pass' && has(npnEsp, /^구동 전압: J1 값 ESP32 → 3\.3 V 신호로 계산$/)
    && !drive(npnEsp)!.detail.some(d => /^5 V: IB/.test(d)) && is(npnNone, 'op_drive', 'warn', 'Q1', /5 V 신호에서만/),
    `${said(npnUno)} | ${said(npnEsp)} | ${said(npnNone)}`)

  const problems = verdictProblems(ALL)
  add('every verdict up to here: basis, no NaN, distinct numbers', problems.length === 0, `${ALL.length} results${problems.length ? ' · ' + [...new Set(problems)].slice(0, 4).join(' | ') : ''}`)
  for (const [name, ok, info] of F) check(`O23 ${name}`, ok, info)
}

// O24. review of O23 (2026-11-08): what the 47 A parts and the header values got wrong. A sense resistor under an unknown
// load reckoned at 47 A, a power pin's voltage read as the signal's, 3.3 V boards whose names hold UNO/NANO, fixes that
// skip the divider or the sense resistor or say nothing, IRLZ44N offered where the board's own part would do, 47 A taken
// for what a TO-220 stands with no heatsink, "3.27~4.95 V < 4 V", and an NPN stage lifting the gate to 94 % of its rating
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  type Wire = [string, ...string[]]
  const head = (rs: OpResult[]) => operatingHeadline(rs).text
  const drive = (rs: OpResult[]) => pick(rs, 'op_drive', 'Q1')
  const fix = (rs: OpResult[]) => drive(rs)?.fix ?? ''
  const said = (rs: OpResult[]) => { const r = drive(rs); return r ? `${r.state}: ${r.summary}${r.fix ? ` fix: ${r.fix}` : ''}` : '(no op_drive)' }
  const named = (rs: OpResult[]) => !!drive(rs)?.detail.some(d => /신호로 계산/.test(d))
  // the motor demo (O5) with another MOSFET, header value or motor value
  const demo = (q: string, j1 = 'PWR_IN', j2 = 'MOTOR') => run(variant(variant(variant(motor, setValue('Q1', q)), setValue('J1', j1)), setValue('J2', j2)))
  // a two-pin signal header J1 (signal, GND) on the gate through RG with RP to GND, a 12 V motor, optionally RS under the source
  const gate = (j1: string, q: string, mot = 'MOTOR 12V 0.5A', rg = '100', rp = '10k', rs: string | null = null, style: 'smd' | 'tht' | null = null) => run(circuit(
    [['J1', 'Conn_01x02', j1], ['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', mot], ['D1', 'D', '1N4007'], ['Q1', 'Q_NMOS', q], ['RP', 'R', rp], ['RG', 'R', rg],
      ...(rs ? [['RS', 'R', rs] as Comp] : [])],
    [['IO', 'J1.1', 'RG.1'], ['G', 'RG.2', 'Q1.1', 'RP.1'], ['+12V', 'J2.1', 'M1.1', 'D1.2'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'],
      ...(rs ? [['SRC', 'Q1.3', 'RS.1'], ['GND', 'J1.2', 'J2.2', 'RS.2', 'RP.2']] as Wire[] : [['GND', 'J1.2', 'J2.2', 'Q1.3', 'RP.2']] as Wire[])]), style)

  // 1. the sense drop under an unknown motor current lies between none and ID max: a verdict that differs between them is
  //    판단 불가 (one, with the switch's), not "켜지지 않을 수 있습니다" and 221 W at an assumed 47 A
  const irlDemo = demo('IRLZ44N'), irlUno = demo('IRLZ44N', 'Arduino Uno'), irfUno = demo('IRFZ44N', 'Arduino Uno'), irl2A = demo('IRLZ44N', 'PWR_IN', 'MOTOR 12V 2A')
  const negative = (rs: OpResult[]) => /(?<![\d.])[-−]\d/.test(`${drive(rs)?.summary} ${fix(rs)}`)
  add('unknown motor current over a sense resistor with IRLZ44N/IRFZ44N: drive and sense heat 판단 불가 (one in the headline), no negative volts, the fix asks for the current and says up to 9.5 A works; with 2 A written it is judged',
    [irlDemo, irlUno, irfUno].every(rs => is(rs, 'op_drive', 'unknown', 'Q1', /부하 전류를 몰라/) && is(rs, 'op_rpower', 'unknown', 'R2') && head(rs) === '판단 불가 1'
      && !negative(rs) && /MOTOR 0\.1A/.test(fix(rs)))
    && /9500 mA 이하면 5 V 신호에서 완전히 켜집니다/.test(fix(irlUno)) && is(irl2A, 'op_drive', 'warn', 'Q1') && is(irl2A, 'op_rpower', 'error', 'R2', /400 mW/),
    [irlDemo, irlUno, irfUno, irl2A].map(rs => `${head(rs)} · ${said(rs)} · ${show(rs, 'op_rpower', 'R2')}`).join(' || '))

  // 2. a written level on a header that also carries a supply is that supply's voltage, not the signal's: the relay of O4f
  //    (J1: +5V, IN, GND) and a 5 V motor keep both levels; a header carrying only the signal still reads its level
  const relayJ = (v: string) => run(variant(variant(relay, setValue('R1', '1.5k')), setValue('J1', v)))
  const motor5 = (v: string) => run(circuit(
    [['J1', 'Conn_01x03', v], ['J2', 'Conn_01x02', 'MOTOR 5V 0.5A'], ['R1', 'R', '100'], ['R3', 'R', '10k'], ['Q1', 'Q_NMOS', 'IRLZ44N'], ['D1', 'D', '1N4007']],
    [['+5V', 'J1.1', 'J2.1', 'D1.2'], ['PWM', 'J1.2', 'R1.1'], ['GND', 'J1.3', 'R3.2', 'Q1.3'], ['GATE', 'R1.2', 'R3.1', 'Q1.1'], ['MOT_LOW', 'J2.2', 'Q1.2', 'D1.1']]))
  const powered = ['5V_IN', '5V', '+5V', 'USB 5V', 'VIN 5V'].filter(v => !is(relayJ(v), 'op_drive', 'warn', 'Q1', /5 V 신호에서만/) || named(relayJ(v)))
  const sigOnly = gate('5V_IN', 'IRLZ44N'), usbOnly = gate('USB 5V', 'IRLZ44N')
  add('a header that carries a supply (or says VIN/USB) names no signal level: 5V_IN, 5V, +5V, USB 5V, VIN 5V on the relay and 5V_IN on a 5 V motor stay "5 V 신호에서만"; 5V_IN on a signal-only header is 5 V',
    powered.length === 0 && is(motor5('5V_IN'), 'op_drive', 'warn', 'Q1', /5 V 신호에서만/) && !named(motor5('5V_IN'))
    && !!drive(sigOnly)?.detail.includes('구동 전압: J1 값 5V_IN → 5 V 신호로 계산') && !named(usbOnly),
    `${powered.map(v => `${v}: ${said(relayJ(v))}`).join(' / ')} | ${said(motor5('5V_IN'))} | ${said(sigOnly)} | ${said(usbOnly)}`)

  // 3. UNO/NANO/MEGA give 5 V only as the board itself (a revision or a pin name after it); UNO Q, Nano Matter, Orin Nano
  //    may be 3.3 V boards and keep both levels
  const not5 = ['Arduino UNO Q', 'Arduino Nano Matter', 'Orin Nano'].filter(v => !is(relayJ(v), 'op_drive', 'warn', 'Q1', /5 V 신호에서만/) || named(relayJ(v)))
  const still5 = ['Arduino Uno R3', 'Arduino Mega 2560', 'Arduino Uno D9', 'Arduino Nano', 'Uno'].filter(v => !drive(relayJ(v))?.detail.includes(`구동 전압: J1 값 ${v} → 5 V 신호로 계산`))
  const orin = gate('Orin Nano', 'IRLZ44N')
  add('UNO Q, Nano Matter and Orin Nano are not read as 5 V (an IRLZ44N from Orin Nano is not passed); Uno R3, Mega 2560, Uno D9, Nano still are',
    not5.length === 0 && still5.length === 0 && !!drive(orin) && drive(orin)!.state !== 'pass',
    `${not5.map(v => `${v}: ${said(relayJ(v))}`).join(' / ')} | still5 misses: ${still5.join(', ')} | ${said(orin)}`)

  // 4. a signal under every guarantee, cut further by a divider or a sense resistor: the fix names those and asks for a part
  //    rated at what the gate gets once they are fixed (3.27 V), not at the cut voltage (1.65 V, 2.77 V)
  const espDiv = gate('ESP32', 'IRLZ44N', 'MOTOR 12V 0.5A', '10k', '10k'), sigDiv = gate('SIG', '2N7002', 'MOTOR 12V 0.05A', '10k', '10k')
  const espRs = gate('ESP32', 'IRLZ44N', 'MOTOR 12V 0.5A', '100', '10k', '1')
  add('ESP32 through 10k/10k: the fix names the RG/RP divider and asks for VGS 2.5~3.27 V, not 1.65 V; the same with SIG on 2N7002; a 1 Ω sense resistor is named, 2.77 V is not asked for',
    /RG\/RP 분압/.test(fix(espDiv)) && /1\/100/.test(fix(espDiv)) && /VGS 2\.5~3\.27 V/.test(fix(espDiv)) && !/1\.65 V 이하/.test(fix(espDiv))
    && /1\/100/.test(fix(sigDiv)) && !/1\.65 V 이하/.test(fix(sigDiv)) && /VGS 2\.5~3\.27 V/.test(fix(sigDiv)) && /감지 저항 RS/.test(fix(espRs)) && /VGS 2\.5~3\.27 V/.test(fix(espRs)) && !/2\.77 V의/.test(fix(espRs)),
    [said(espDiv), said(sigDiv), said(espRs)].join(' || '))

  // 5. a divider already at 100 Ω : 10 kΩ is not the thing to change; the sense resistor is, by how much, and IRFZ44N
  //    still needs a part rated at 5 V after it
  const c1 = gate('Arduino Uno', 'IRLZ44N', 'MOTOR 12V 15A', '100', '10k', '0.1'), c11 = gate('Arduino Uno', 'IRFZ44N', 'MOTOR 12V 3A', '100', '10k', '0.5')
  add('Uno, 100 Ω/10 kΩ, sense RS: the fix does not ask for 100 Ω and 10 kΩ again; IRLZ44N at 15 A wants RS ≤ 0.0633 Ω, IRFZ44N at 3 A wants IRLZ44N and RS ≤ 0.316 Ω',
    !/1\/100|100 Ω과 10 kΩ|분압/.test(fix(c1)) && /감지 저항 RS를 0\.0633 Ω 이하로/.test(fix(c1))
    && !/1\/100|100 Ω과 10 kΩ|분압/.test(fix(c11)) && /감지 저항 RS를 0\.316 Ω 이하로 줄이고, 켜짐 저항이 4 V에서 보장되는 IRLZ44N으로 바꾸면/.test(fix(c11)),
    [said(c1), said(c11)].join(' || '))

  // 6. a gate short of the guarantee with the load's current unknown still says what to change
  const a2 = gate('Arduino Uno', '2N7002', 'MOTOR', '100', '10k', '0.1'), demoUno = demo('2N7002', 'Arduino Uno'), demoAny = run(motor)
  add('2N7002 at 4.94 V with an unknown motor current: the fix lists 2N7000 and IRLZ44N and asks for the current (A2, the motor demo from Uno and from PWR_IN)',
    [a2, demoUno, demoAny].every(rs => is(rs, 'op_drive', 'warn', 'Q1') && /2N7000/.test(fix(rs)) && /IRLZ44N/.test(fix(rs)) && /MOTOR 0\.1A/.test(fix(rs))),
    [said(a2), said(demoUno), said(demoAny)].join(' || '))

  // 7. a part of the table that the board's own seat takes comes before a TO-220
  const coil = (q: string, style: 'smd' | 'tht') => run(circuit(
    [['J1', 'Conn_01x03', 'Arduino Uno'], ['RG', 'R', '100'], ['RP', 'R', '10k'], ['Q1', 'Q_NMOS', q], ['D1', 'D', '1N4148'], ['K1', 'Relay', 'SRD-05VDC-SL-C']],
    [['+5V', 'J1.1', 'K1.1', 'D1.2'], ['IN', 'J1.2', 'RG.1'], ['GND', 'J1.3', 'Q1.3', 'RP.2'], ['G', 'RG.2', 'RP.1', 'Q1.1'], ['COIL_LOW', 'Q1.2', 'K1.2', 'D1.1']]), style)
  const tht = coil('2N7002', 'tht'), smd = coil('2N7002', 'smd')
  add('2N7002 at 4.95 V under a relay coil: on a THT board the fix offers 2N7000 (its TO-92 seat), not IRLZ44N, and 2N7000 passes there; on SMD it says 2N7000 does not fit SOT-23',
    /2N7000으로 바꾸면/.test(fix(tht)) && !/IRLZ44N/.test(fix(tht)) && is(coil('2N7000', 'tht'), 'op_drive', 'pass', 'Q1') && /2N7000은 TO-92 부품이라 기판의 SOT-23/.test(fix(smd)),
    [said(tht), said(smd)].join(' || '))

  // 8. 47 A and 49 A hold with the case at 25 °C: in free air (RθJA 62 °C/W, TJ 175 °C) the conduction heat with RDS(on) as hot
  //    as 175 °C makes it (175 − 25) ÷ 62 = 2.42 W. IRLZ44N at 4 V: 0.035 Ω × 2.25 = 78.8 mΩ, so 5 A (1.97 W) passes, 7 A
  //    (3.86 W) needs a heatsink, 40 A (126 W) is over PD 110 W even with the case at 25 °C. Not offered where it would not
  //    stand. The rise at 175 °C is the upper end of two readings of the datasheet's curve (2.25, IRFZ44N 2.45)
  const amp = (q: string, a: string) => gate('Arduino Uno', q, `MOTOR 12V ${a}A`)
  const free = SPECS.mos.IRLZ44N.free_air, freeF = SPECS.mos.IRFZ44N.free_air
  add('IRLZ44N with no heatsink: 0.5 A and 5 A pass, 7 A warns (방열판), 40 A fails; 2N7002 at 40 A is not offered IRLZ44N; an unknown load says what it stands without a heatsink; the table holds RθJA, TJ, PD and the hot RDS(on)',
    is(amp('IRLZ44N', '0.5'), 'op_switch', 'pass', 'Q1') && is(amp('IRLZ44N', '5'), 'op_switch', 'pass', 'Q1') && is(amp('IRLZ44N', '7'), 'op_switch', 'warn', 'Q1', /방열판/)
    && is(amp('IRLZ44N', '40'), 'op_switch', 'error', 'Q1') && !/IRLZ44N으로 바꾸면/.test(fix(amp('2N7002', '40')))
    && /방열판 없이 대략/.test(pick(gate('Arduino Uno', 'IRLZ44N', 'MOTOR'), 'op_switch', 'Q1')?.fix ?? '')
    && free?.rth_ja.v === 62 && free?.tj_max.v === 175 && free?.pd_case.v === 110 && free?.rds_hot.v === 2.25
    && freeF?.rth_ja.v === 62 && freeF?.tj_max.v === 175 && freeF?.pd_case.v === 94 && freeF?.rds_hot.v === 2.45,
    ['0.5', '5', '7', '40'].map(a => show(amp('IRLZ44N', a), 'op_switch')).join(' / ') + ` | ${said(amp('2N7002', '40'))}`)

  // 9. a gate range across the threshold is not written as one "<": the lowest end is what falls short
  const t555 = run(circuit(
    [['J1', 'Conn_01x02', 'PWR'], ['U1', 'NE555', 'NE555'], ['R1', 'R', '10k'], ['R2', 'R', '68k'], ['C1', 'CP', '10uF'], ['C2', 'C', '10nF'],
      ['RG', 'R', '100'], ['RP', 'R', '10k'], ['Q1', 'Q_NMOS', 'IRFZ44N'], ['M1', 'Conn_01x02', 'MOTOR 5V 0.5A'], ['D1', 'D', '1N4007']],
    [['+5V', 'J1.1', 'U1.8', 'U1.4', 'R1.1', 'M1.1', 'D1.2'], ['GND', 'J1.2', 'U1.1', 'C1.2', 'C2.2', 'RP.2', 'Q1.3'], ['DISCH', 'R1.2', 'U1.7', 'R2.1'],
      ['THRES', 'R2.2', 'U1.6', 'U1.2', 'C1.1'], ['CTRL', 'U1.5', 'C2.1'], ['OUT', 'U1.3', 'RG.1'], ['G', 'RG.2', 'RP.1', 'Q1.1'], ['MOT', 'M1.2', 'Q1.2', 'D1.1']]))
  add('NE555 at 5 V on an IRFZ44N: "최저 3.27 V < 문턱 최대 4 V", never "3.27~4.95 V < 4 V"',
    is(t555, 'op_drive', 'error', 'Q1', /게이트 최저 3\.27 V < 문턱 최대 4 V/) && !/~[\d.]+ V < 문턱/.test(drive(t555)?.summary ?? ''), said(t555))

  // 10. the NPN stage puts the load's supply on the gate only under 90 % of the gate's maximum (README: 90 % warns)
  const lifted = (q: string, sup: string, mot: string) => run(circuit(
    [['J1', 'Conn_01x02', 'ESP32'], ['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', mot], ['D1', 'D', '1N4007'], ['Q1', 'Q_NMOS', q], ['RP', 'R', '10k'], ['RG', 'R', '100']],
    [['IO', 'J1.1', 'RG.1'], ['G', 'RG.2', 'Q1.1', 'RP.1'], [sup, 'J2.1', 'M1.1', 'D1.2'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'], ['GND', 'J1.2', 'J2.2', 'Q1.3', 'RP.2']]))
  const l15 = lifted('IRLZ44N', '+15V', 'MOTOR 15V 0.5A'), l19 = lifted('2N7002', '+19V', 'MOTOR 19V 0.05A'), l12 = lifted('IRLZ44N', '+12V', 'MOTOR 12V 0.5A')
  add('NPN stage: 15 V on IRLZ44N (±16 V) and 19 V on 2N7002 (±20 V) are not put on the gate (4~14.4 V, 5~18 V instead); 12 V on IRLZ44N is',
    !/15 V 전원을/.test(fix(l15)) && /4 V 이상 14\.4 V 미만의 전원/.test(fix(l15)) && !/19 V 전원을/.test(fix(l19)) && /5 V 이상 18 V 미만의 전원/.test(fix(l19)) && /12 V 전원을 게이트에/.test(fix(l12)),
    [said(l15), said(l19), said(l12)].join(' || '))

  const problems = verdictProblems(ALL)
  add('every verdict up to here: basis, no NaN, distinct numbers', problems.length === 0, `${ALL.length} results${problems.length ? ' · ' + [...new Set(problems)].slice(0, 4).join(' | ') : ''}`)
  for (const [name, ok, info] of F) check(`O24 ${name}`, ok, info)
}

// O25. second review of O23/O24 (2026-11-08): a motor supply on the header read by its name only, heat reckoned with an
// RDS(on) row the gate does not reach, fixes that size the sense resistor up or ask for a change that is not needed, an
// unknown load whose verdict grew surer as the sense resistor shrank, "Q1는", a part list with no word on the board's seat,
// and a negative gate voltage in the basis
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  type Wire = [string, ...string[]]
  const head = (rs: OpResult[]) => operatingHeadline(rs).text
  const drive = (rs: OpResult[], ref = 'Q1') => pick(rs, 'op_drive', ref)
  const fix = (rs: OpResult[]) => drive(rs)?.fix ?? ''
  const said = (rs: OpResult[]) => { const r = drive(rs); return r ? `${r.state}: ${r.summary}${r.fix ? ` fix: ${r.fix}` : ''}` : '(no op_drive)' }
  const named = (rs: OpResult[], ref = 'Q1') => !!drive(rs, ref)?.detail.some(d => /신호로 계산/.test(d))
  // the signal header J1 (signal, GND) on the gate through RG with RP to GND, a 12 V motor, optionally RS under the source
  const gate = (j1: string, q: string, mot = 'MOTOR 12V 0.5A', rs: string | null = null, style: 'smd' | 'tht' | null = null) => run(circuit(
    [['J1', 'Conn_01x02', j1], ['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', mot], ['D1', 'D', '1N4007'], ['Q1', 'Q_NMOS', q], ['RP', 'R', '10k'], ['RG', 'R', '100'],
      ...(rs ? [['RS', 'R', rs] as Comp] : [])],
    [['IO', 'J1.1', 'RG.1'], ['G', 'RG.2', 'Q1.1', 'RP.1'], ['+12V', 'J2.1', 'M1.1', 'D1.2'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'],
      ...(rs ? [['SRC', 'Q1.3', 'RS.1'], ['GND', 'J1.2', 'J2.2', 'RS.2', 'RP.2']] as Wire[] : [['GND', 'J1.2', 'J2.2', 'Q1.3', 'RP.2']] as Wire[])]), style)

  // 1. a header's written level is its supply's when another pin feeds a load or another supply pin, whatever that net is
  //    called (VM, V+, VMOT...); a header whose other pins only reach gates still names the signal's level
  const motorPin = (net: string, q: string, mot: string) => run(circuit(
    [['J1', 'Conn_01x03', '5V'], ['Q1', 'Q_NMOS', q], ['RG', 'R', '100'], ['RP', 'R', '10k'], ['M1', 'Conn_01x02', mot], ['D1', 'D', '1N4148']],
    [[net, 'J1.1', 'M1.1', 'D1.2'], ['PWM', 'J1.2', 'RG.1'], ['G', 'RG.2', 'Q1.1', 'RP.1'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'], ['GND', 'J1.3', 'Q1.3', 'RP.2']]))
  const supplyNames = ['VM', 'V+', '+V', 'VMOT', 'MOTOR_PWR', 'P5V']
  const misread = supplyNames.flatMap(n => ([['2N7000', 'MOTOR 5V 0.1A'], ['IRLZ44N', 'MOTOR 5V 0.5A']] as const).map(([q, m]) => [n, q, motorPin(n, q, m)] as const))
    .filter(([, , rs]) => !is(rs, 'op_drive', 'warn', 'Q1', /5 V 신호에서만/) || named(rs))
  const twoGates = run(circuit(
    [['J1', 'Conn_01x03', '5V'], ['RG1', 'R', '100'], ['RG2', 'R', '100'], ['RP1', 'R', '10k'], ['RP2', 'R', '10k'], ['Q1', 'Q_NMOS', '2N7000'], ['Q2', 'Q_NMOS', '2N7000'],
      ['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', 'MOTOR 12V 0.1A'], ['M2', 'Conn_01x02', 'MOTOR 12V 0.1A'], ['D1', 'D', '1N4148'], ['D2', 'D', '1N4148']],
    [['A', 'J1.1', 'RG1.1'], ['B', 'J1.2', 'RG2.1'], ['G1', 'RG1.2', 'Q1.1', 'RP1.1'], ['G2', 'RG2.2', 'Q2.1', 'RP2.1'], ['+12V', 'J2.1', 'M1.1', 'M2.1', 'D1.2', 'D2.2'],
      ['M1L', 'M1.2', 'D1.1', 'Q1.2'], ['M2L', 'M2.2', 'D2.1', 'Q2.2'], ['GND', 'J1.3', 'J2.2', 'Q1.3', 'Q2.3', 'RP1.2', 'RP2.2']]))
  add('a "5V" header whose other pin feeds the motor (VM, V+, +V, VMOT, MOTOR_PWR, P5V) keeps 3.3 V and 5 V on 2N7000 and IRLZ44N; one whose pins only reach two gates is 5 V for both',
    misread.length === 0 && named(twoGates, 'Q1') && named(twoGates, 'Q2') && is(twoGates, 'op_drive', 'pass', 'Q1') && is(twoGates, 'op_drive', 'pass', 'Q2'),
    `${misread.map(([n, q, rs]) => `${n}/${q}: ${said(rs)}`).slice(0, 3).join(' || ')} | two gates: ${show(twoGates, 'op_drive', 'Q1')} / ${show(twoGates, 'op_drive', 'Q2')}`)

  // 2. a gate under every RDS(on) row of a TO-220 part: the heat is not known (판단 불가, following the gate's verdict and
  //    counted there), never a pass with the 10 V or 4 V row; a gate on a row still passes
  const sw = (rs: OpResult[]) => pick(rs, 'op_switch', 'Q1')
  const follows = (rs: OpResult[]) => sw(rs)?.state === 'unknown' && sw(rs)?.cause === 'Q1' && sw(rs)?.causeRule === 'op_drive' && /켜짐 저항을 몰라 발열을 판단할 수 없습니다/.test(sw(rs)!.summary)
  const unoIrf = gate('Arduino Uno', 'IRFZ44N', 'MOTOR 12V 7A'), espIrl = gate('ESP32', 'IRLZ44N', 'MOTOR 12V 5A'), espIrf = gate('ESP32', 'IRFZ44N', 'MOTOR 12V 5A')
  const espIrlSmall = gate('ESP32', 'IRLZ44N', 'MOTOR 12V 0.5A'), unoIrl = gate('Arduino Uno', 'IRLZ44N', 'MOTOR 12V 5A')
  add('Uno → IRFZ44N 7 A, ESP32 → IRLZ44N 5 A and ESP32 → IRFZ44N: heat 판단 불가 following op_drive (no "방열판 없이 대략" pass); ESP32 → IRLZ44N 0.5 A heads "동작 경고 1"; Uno → IRLZ44N 5 A (4.95 V on the 4 V row) passes',
    [unoIrf, espIrl, espIrf, espIrlSmall].every(follows) && head(espIrlSmall) === '동작 경고 1' && is(unoIrl, 'op_switch', 'pass', 'Q1')
    && /게이트에 10 V 이상이 걸리게 하면/.test(sw(unoIrf)?.fix ?? ''),
    [unoIrf, espIrl, espIrf, espIrlSmall, unoIrl].map(rs => `${head(rs)} · ${show(rs, 'op_switch', 'Q1')}`).join(' || '))

  // 3. every fix that names a sense resistor value or another part, from an Arduino Uno through 100 Ω/10 kΩ: the value is
  //    below the sense resistor's, the circuit with the change passes, and a sense resistor change it asks for is needed
  //    (the part alone does not pass)
  const asked: string[] = []
  let sized = 0
  for (const q of ['IRFZ44N', '2N7002', 'IRLZ44N', '2N7000']) for (const r of ['0.02', '0.05', '0.1', '0.3', '0.5', '1']) for (const a of ['0.05', '0.1', '1', '3', '15']) {
    const rs = gate('Arduino Uno', q, `MOTOR 12V ${a}A`, r), f = fix(rs)
    const part = /켜짐 저항이 [\d.]+ V에서 보장되는 ([A-Z0-9]+?)(?:으로|로) 바꾸면/.exec(f)?.[1]
    const m = /감지 저항 RS를 ([\d.]+) (mΩ|Ω) 이하로/.exec(f)
    const to = m ? Number(m[1]) * (m[2] === 'mΩ' ? 1e-3 : 1) : null
    if (!part && to == null) continue
    sized++
    const at = (qq: string, rr: number) => drive(gate('Arduino Uno', qq, `MOTOR 12V ${a}A`, String(rr)))?.state
    const bad = [to != null && !(to < Number(r)) ? `RS ${to} ≥ ${r}` : '', at(part ?? q, to ?? Number(r)) !== 'pass' ? 'the change does not pass' : '',
      part && to != null && at(part, Number(r)) === 'pass' ? `${part} passes with RS ${r} as it is` : ''].filter(Boolean)
    if (bad.length) asked.push(`${q} RS ${r} Ω ${a} A: ${bad.join(', ')} (${f})`)
  }
  const rs05 = gate('Arduino Uno', 'IRFZ44N', 'MOTOR 12V 3A', '0.05')
  add('fixes from an Uno with a sense resistor: no value at or above the resistor\'s, no change that is not needed, and each one passes (IRFZ44N, RS 0.05 Ω, 3 A: IRLZ44N with RS as it is)',
    sized >= 10 && asked.length === 0 && /IRLZ44N으로 바꾸면/.test(fix(rs05)) && !/감지 저항/.test(fix(rs05)),
    `${sized} fixes · ${asked.slice(0, 2).join(' || ')} | ${said(rs05)}`)

  // 4. an unknown motor current over a shrinking sense resistor: judged only once every signal's verdict is the same at
  //    both ends, then as with no sense resistor at all; never sure at a larger resistor and unsure at a smaller one
  const demoR = (q: string, j1: string, r: string | null) => run(variant(variant(variant(motor, setValue('Q1', q)), setValue('J1', j1)), c => {
    if (r != null) { c.components.find(x => x.ref === 'R2')!.value = r; return }
    c.components = c.components.filter(x => x.ref !== 'R2')
    c.nets = c.nets.filter(n => n.name !== 'SENSE')
    c.nets.find(n => n.name === 'GND')!.nodes = [...c.nets.find(n => n.name === 'GND')!.nodes.filter(nd => nd.ref !== 'R2'), { ref: 'Q1', pin: '3' }]
  }))
  const words = (rs: OpResult[]) => (drive(rs)?.detail ?? []).filter(d => /^(3\.3 V|5 V): /.test(d)).map(d => `${d.split(':')[0]} ${d.split(' → ')[1]}`).join(' / ')
  const ladder: string[] = []
  for (const [q, j1] of [['IRLZ44N', 'PWR_IN'], ['IRLZ44N', 'Arduino Uno'], ['IRFZ44N', 'PWR_IN'], ['2N7002', 'PWR_IN']] as const) {
    const none = demoR(q, j1, null)
    let sure = false
    for (const r of ['0.2', '0.1', '0.05', '0.02', '0.01', '0.005', '0.001']) {
      const rs = demoR(q, j1, r), d = drive(rs)
      if (d?.state === 'unknown') { if (sure) ladder.push(`${q}/${j1} R2 ${r}: unsure after a sure larger one`); continue }
      sure = true
      if (d?.state !== drive(none)?.state || words(rs) !== words(none)) ladder.push(`${q}/${j1} R2 ${r}: ${d?.state} [${words(rs)}] vs no sense ${drive(none)?.state} [${words(none)}]`)
    }
  }
  const r05 = demoR('IRLZ44N', 'PWR_IN', '0.05')
  add('the motor demo with IRLZ44N/IRFZ44N/2N7002 and R2 from 0.2 Ω down to 1 mΩ: 판단 불가 until every signal agrees at both ends, then the verdict with no sense resistor; R2 0.05 Ω says up to 19 A for 5 V',
    ladder.length === 0 && is(r05, 'op_drive', 'unknown', 'Q1') && head(r05) === '판단 불가 1' && /19000 mA 이하면 5 V 신호에서 완전히 켜집니다/.test(fix(r05)) && /MOTOR 0\.1A/.test(fix(r05)),
    `${ladder.slice(0, 3).join(' || ')} | ${head(r05)} · ${said(r05)}`)

  // 5. IRLZ44N's heat with the RDS(on) row its gate reaches: 22 mΩ from 10 V, 25 mΩ from 5 V, 35 mΩ from 4 V (× 2.25 hot).
  //    6 A: 12 V gate 1.78 W and 5 V gate 2.03 W pass, 4.95 V from an Uno 2.84 W needs a heatsink; 40 A on 12 V is 79.2 W, under
  //    PD 110 W: a heatsink, not "견디지 못합니다"
  const railGate = (sup: string, mot: string) => run(circuit(
    [['J2', 'Conn_01x03', 'PWR'], ['M1', 'Conn_01x02', mot], ['D1', 'D', '1N4007'], ['Q1', 'Q_NMOS', 'IRLZ44N'], ['RG', 'R', '100']],
    [['+12V', 'J2.1', 'M1.1', 'D1.2', ...(sup === '+12V' ? ['RG.1'] : [])], ...(sup === '+5V' ? [['+5V', 'J2.2', 'RG.1'] as Wire] : []), ['G', 'RG.2', 'Q1.1'],
      ['MOT', 'M1.2', 'D1.1', 'Q1.2'], ['GND', 'J2.3', 'Q1.3']]))
  const g12 = railGate('+12V', 'MOTOR 12V 6A'), g5 = railGate('+5V', 'MOTOR 12V 6A'), g12big = railGate('+12V', 'MOTOR 12V 40A'), g495 = gate('Arduino Uno', 'IRLZ44N', 'MOTOR 12V 6A')
  const rowOf = (rs: OpResult[]) => sw(rs)?.detail.find(d => /^뜨거울 때의 켜짐 저항/.test(d)) ?? ''
  const rows = SPECS.mos.IRLZ44N.rds_rows ?? []
  add('IRLZ44N heat by its gate: 12 V and 5 V gates at 6 A pass on the 10 V and 5 V rows, 4.95 V at 6 A warns on the 4 V row, 40 A at 12 V warns (heatsink) instead of failing; the table holds the 5 V and 10 V rows',
    is(g12, 'op_switch', 'pass', 'Q1') && /VGS 10 V의 RDS\(on\) 0\.022 Ω/.test(rowOf(g12)) && is(g5, 'op_switch', 'pass', 'Q1') && /VGS 5 V의 RDS\(on\) 0\.025 Ω/.test(rowOf(g5))
    && is(g495, 'op_switch', 'warn', 'Q1', /방열판이 필요합니다/) && /VGS 4 V의 RDS\(on\) 0\.035 Ω/.test(rowOf(g495)) && is(g12big, 'op_switch', 'warn', 'Q1', /79\.2 W/)
    && rows.some(r => r.vgs === 5 && r.rds.v === 0.025 && /0\.025 Ω @ VGS 5\.0 V/.test(r.rds.src)) && rows.some(r => r.vgs === 10 && r.rds.v === 0.022 && /0\.022 Ω @ VGS 10 V/.test(r.rds.src))
    && [SPECS.mos.IRLZ44N.free_air, SPECS.mos.IRFZ44N.free_air].every(a => !!a && /두 번 읽어/.test(a.rds_hot.src) && /위쪽 끝/.test(a.rds_hot.src) && !/큰 쪽/.test(a.rds_hot.src)
      && [a.rth_ja, a.tj_max, a.pd_case].every(n => /두 번 읽어 같은 값/.test(n.src))),
    [g12, g5, g495, g12big].map(rs => show(rs, 'op_switch', 'Q1')).join(' / '))

  // 6. a particle after a part's reference agrees with how it is read ("Q1은", "Q2는"), in every result so far
  const FINAL = '0136789'     // 영 일 삼 육 칠 팔 end in a consonant
  const particles = (t: string) => [...t.matchAll(/(?<![A-Za-z0-9])([A-Z]{1,3}\d{1,3})(은|는|이|가|을|를)(?=[\s,.)])/g)]
    .filter(m => FINAL.includes(m[1].slice(-1)) !== ['은', '이', '을'].includes(m[2])).map(m => m[0])
  const unknownMotor = gate('Arduino Uno', 'IRLZ44N', 'MOTOR')
  const wrong = [...new Set(ALL.flatMap(r => particles([r.summary, r.fix ?? '', ...r.detail].join(' '))))]
  add('no "Q1는" in any result: an unknown motor on IRLZ44N and on the demo\'s 2N7002 say "Q1은"',
    wrong.length === 0 && /Q1은 방열판 없이/.test(sw(unknownMotor)?.fix ?? '') && /Q1은 115 mA까지/.test(pick(run(motor), 'op_switch', 'Q1')?.fix ?? ''),
    `${wrong.slice(0, 5).join(', ')} | ${sw(unknownMotor)?.fix}`)

  // 7. the parts listed for an unknown load say which do not fit the board's transistor seat
  const smd = run(motor, 'smd'), tht = run(motor, 'tht')
  add('the motor demo\'s list for an unknown load: on SMD it says 2N7000 (TO-92) and IRLZ44N (TO-220) do not fit SOT-23; on THT only IRLZ44N',
    /2N7000은 TO-92, IRLZ44N은 큰 TO-220 부품이라 기판의 SOT-23 트랜지스터 자리에는 그대로 맞지 않습니다/.test(fix(smd))
    && /IRLZ44N은 큰 TO-220 부품이라 기판의 TO-92 트랜지스터 자리에는/.test(fix(tht)) && !/2N7000은 TO-92/.test(fix(tht)),
    `${said(smd)} || ${said(tht)}`)

  // 8. no negative gate voltage anywhere in a gate's verdict, its basis included: a sense drop larger than the drive is
  //    "0 V 이하" (at ID max with the load unknown, and at a known load)
  const neg = (rs: OpResult[]) => { const r = drive(rs); return !!r && /(?<![\w.])[-−]\d+(?:\.\d+)?\s*V(?![A-Za-z])/.test([r.summary, r.fix ?? '', ...r.detail].join(' ')) }
  const espRs = gate('ESP32', 'IRLZ44N', 'MOTOR', '0.1'), unoRs = gate('Arduino Uno', 'IRLZ44N', 'MOTOR 12V 6A', '1')
  const negs = [espRs, unoRs, demoR('IRLZ44N', 'PWR_IN', '0.1'), demoR('IRFZ44N', 'Arduino Uno', '0.1')].filter(neg)
  add('a sense drop over the drive is written "0 V 이하", never a negative VGS, in the summary, fix and basis (ESP32 → IRLZ44N with RS 0.1 Ω and no current; Uno with RS 1 Ω at 6 A)',
    negs.length === 0 && !!drive(espRs)?.detail.some(d => /^ID 최대면 3\.3 V: VGS 0 V 이하/.test(d)) && is(unoRs, 'op_drive', 'error', 'Q1', /게이트 0 V 이하 < 문턱 최대 2 V/),
    `${negs.map(said).slice(0, 2).join(' || ')} | ${drive(espRs)?.detail.filter(d => /^ID 최대면/.test(d)).join(' / ')} | ${said(unoRs)}`)

  const problems = verdictProblems(ALL)
  add('every verdict up to here: basis, no NaN, distinct numbers', problems.length === 0, `${ALL.length} results${problems.length ? ' · ' + [...new Set(problems)].slice(0, 4).join(' | ') : ''}`)
  for (const [name, ok, info] of F) check(`O25 ${name}`, ok, info)
}

// O26. third review of O23–O25 (2026-11-09): advice no resistor value can carry out, a signal net's own name and a bare
// chip's supply read under the board's name, "부하가 0 mA 이하면", an NPN's base current alone over the rating, 47 A drops on
// a 12 V supply, the heat taking the 4 V row under a 9.65 V gate, a missing pull-down hidden by an unknown load, and "이하면"
// at a limit that warns
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  type Wire = [string, ...string[]]
  const head = (rs: OpResult[]) => operatingHeadline(rs).text
  const drive = (rs: OpResult[]) => pick(rs, 'op_drive', 'Q1')
  const fix = (rs: OpResult[]) => drive(rs)?.fix ?? ''
  const said = (rs: OpResult[]) => { const r = drive(rs); return r ? `${r.state}: ${r.summary}${r.fix ? ` fix: ${r.fix}` : ''}` : '(no op_drive)' }
  const text = (r: OpResult | undefined) => (r ? [r.summary, r.fix ?? '', ...r.detail].join(' ') : '')
  // the signal header J1 (signal, GND) on the gate, through RG or (rg null) straight, RP to GND unless null, a 12 V motor,
  // optionally RS under the source
  const gate = (j1: string, q: string, mot: string, rg: string | null, rp: string | null, rs: string | null, style: 'smd' | 'tht' | null = null) => run(circuit(
    [['J1', 'Conn_01x02', j1], ['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', mot], ['D1', 'D', '1N4007'], ['Q1', 'Q_NMOS', q],
      ...(rp ? [['RP', 'R', rp] as Comp] : []), ...(rg ? [['RG', 'R', rg] as Comp] : []), ...(rs ? [['RS', 'R', rs] as Comp] : [])],
    [...(rg ? [['IO', 'J1.1', 'RG.1'], ['G', 'RG.2', 'Q1.1', ...(rp ? ['RP.1'] : [])]] as Wire[] : [['G', 'J1.1', 'Q1.1', ...(rp ? ['RP.1'] : [])]] as Wire[]),
      ['+12V', 'J2.1', 'M1.1', 'D1.2'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'],
      ...(rs ? [['SRC', 'Q1.3', 'RS.1'], ['GND', 'J1.2', 'J2.2', 'RS.2', ...(rp ? ['RP.2'] : [])]] as Wire[] : [['GND', 'J1.2', 'J2.2', 'Q1.3', ...(rp ? ['RP.2'] : [])]] as Wire[])]), style)

  // 1. a gate equal to a part's guarantee with no sense drop is not brought to it by any resistor value: an Uno straight on
  //    2N7002 (5 V rated) over RS 1 Ω is told 2N7000, which passes with RS as it is, never "RS를 더 작은 값으로" or NDS7002A;
  //    every sized fix from a straight Uno passes and changes only what it has to
  const direct = (q: string, r: string, a: string) => gate('Arduino Uno', q, `MOTOR 12V ${a}A`, null, '10k', r, 'smd')
  const n7002 = direct('2N7002', '1', '0.1'), irf = direct('IRFZ44N', '1', '0.1')
  const wrong: string[] = []
  for (const q of ['2N7002', 'NDS7002A', '2N7000', 'IRLZ44N', 'IRFZ44N']) for (const r of ['1', '0.5', '0.1', '0.01']) for (const a of ['0.05', '0.1', '1', '3']) {
    const f = fix(direct(q, r, a))
    if (/더 작은 값으로 줄이면 됩니다/.test(f)) { wrong.push(`${q} RS ${r} ${a} A: ${f}`); continue }
    const part = /켜짐 저항이 [\d.]+ V에서 보장되는 ([A-Z0-9]+?)(?:으로|로) 바꾸면/.exec(f)?.[1]
    const m = /감지 저항 RS를 ([\d.]+) (mΩ|Ω) 이하로/.exec(f)
    const to = m ? Number(m[1]) * (m[2] === 'mΩ' ? 1e-3 : 1) : null
    if (!part && to == null) continue
    if (drive(direct(part ?? q, String(to ?? r), a))?.state !== 'pass') wrong.push(`${q} RS ${r} ${a} A: the change does not pass (${f})`)
    if (part && to != null && drive(direct(part, r, a))?.state === 'pass') wrong.push(`${q} RS ${r} ${a} A: ${part} passes with RS as it is (${f})`)
  }
  add('an Uno straight on 2N7002 or IRFZ44N over RS 1 Ω at 0.1 A: the fix offers 2N7000 with RS as it is, not "더 작은 값으로" or NDS7002A; every sized fix from a straight Uno passes and is needed',
    /2N7000으로 바꾸면/.test(fix(n7002)) && !/감지 저항|NDS7002A/.test(fix(n7002)) && /2N7000으로 바꾸면/.test(fix(irf)) && !/감지 저항 RS를|NDS7002A/.test(fix(irf))
    && is(direct('2N7000', '1', '0.1'), 'op_drive', 'pass', 'Q1') && wrong.length === 0,
    `${wrong.slice(0, 2).join(' || ')} | ${said(n7002)} || ${said(irf)}`)

  // 2. the signal net's own name, when it writes one level, comes before the board's name: a pin on VCC_3V3, 3V3_OUT or
  //    IOREF_3V3 of an "Arduino Uno" header is 3.3 V, so IRLZ44N (4 V) is not passed
  const unoPin = (net: string) => run(circuit(
    [['J1', 'Conn_01x03', 'Arduino Uno'], ['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', 'MOTOR 12V 0.5A'], ['D1', 'D', '1N4007'], ['Q1', 'Q_NMOS', 'IRLZ44N'], ['RP', 'R', '10k'], ['RG', 'R', '100']],
    [[net, 'J1.1', 'RG.1'], ['G', 'RG.2', 'Q1.1', 'RP.1'], ['+12V', 'J2.1', 'M1.1', 'D1.2'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'], ['GND', 'J1.3', 'J2.2', 'Q1.3', 'RP.2']]))
  const pins = ['VCC_3V3', '3V3_OUT', 'IOREF_3V3'].map(n => [n, unoPin(n)] as const)
  const d9 = unoPin('D9')
  add('a pin on VCC_3V3, 3V3_OUT or IOREF_3V3 of an "Arduino Uno" header: 3.3 V from the net name (IRLZ44N warns at 3.27 V); a pin on D9 is still the Uno\'s 5 V',
    pins.every(([n, rs]) => is(rs, 'op_drive', 'warn', 'Q1', /3\.27 V/) && !!drive(rs)?.detail.some(d => d.includes(`J1 핀의 넷 이름 ${n} → 3.3 V 신호로 계산`)))
    && is(d9, 'op_drive', 'pass', 'Q1') && !!drive(d9)?.detail.includes('구동 전압: J1 값 Arduino Uno → 5 V 신호로 계산'),
    `${pins.map(([n, rs]) => `${n}: ${said(rs)}`).join(' || ')} | D9: ${said(d9)}`)

  // 3. an unknown motor current over a sense resistor with the gate right at the guarantee or the threshold: no limit of
  //    0 mA or "-0 µA", and the verdict is the one any current gives (at the drop the end that decides it, never "3 V < 3 V")
  const noR1 = run(variant(motor, c => {
    c.components = c.components.filter(x => x.ref !== 'R1')
    c.nets = c.nets.filter(n => n.name !== 'PWM')
    c.nets.find(n => n.name === 'GATE')!.nodes.push({ ref: 'J1', pin: '2' })
  }))
  const esp1k = gate('ESP32', '2N7000', 'MOTOR', '1k', '10k', '0.1'), sig10k = gate('SIG', '2N7002', 'MOTOR', '10k', '10k', '0.1')
  const edge = [noR1, esp1k, sig10k]
  const nonPositive = (rs: OpResult[]) => rs.some(r => [...text(r).matchAll(/부하가 ([-\d.]+) (?:mA|µA) (?:이하|미만)면/g)].some(m => !(Number(m[1]) > 0)))
  add('the motor demo with no R1 (5 V right at 2N7002\'s 5 V), ESP32 through 1k/10k on 2N7000 (3 V at its 3 V threshold), SIG through 10k/10k: no "0 mA 이하면", no "-0 µA"; warn, error 2.98 V, error 2.49 V',
    edge.every(rs => !nonPositive(rs)) && is(noR1, 'op_drive', 'warn', 'Q1') && is(esp1k, 'op_drive', 'error', 'Q1', /게이트 2\.98 V < 문턱 최대 3 V/)
    && is(sig10k, 'op_drive', 'error', 'Q1', /2\.49 V < 문턱 최대 2\.5 V/) && /5 V 신호라면 부품표에서 완전히 켜지는 것은 2N7000/.test(fix(noR1)),
    edge.map(said).join(' || '))

  // 4. a bare ATmega328P puts out its supply's level: beside a +3V3 pin that lights an LED it is 3.3 V, beside +5V it is 5 V,
  //    beside both it is either; an Arduino Nano ATmega328 is still the 5 V board
  const chip = (v: string, sup: string[]) => run(circuit(
    [['J1', `Conn_01x0${sup.length + 2}`, v], ...sup.flatMap((_, k) => [[`RL${k + 1}`, 'R', '1k'], [`L${k + 1}`, 'LED', 'RED']] as Comp[]), ['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', 'MOTOR 12V 0.5A'], ['D1', 'D', '1N4007'],
      ['Q1', 'Q_NMOS', 'IRLZ44N'], ['RP', 'R', '10k'], ['RG', 'R', '100']],
    [...sup.flatMap((n, k) => [[n, `J1.${k + 3}`, `RL${k + 1}.1`], [`LA${k + 1}`, `RL${k + 1}.2`, `L${k + 1}.2`]] as Wire[]), ['IO', 'J1.1', 'RG.1'], ['G', 'RG.2', 'Q1.1', 'RP.1'], ['+12V', 'J2.1', 'M1.1', 'D1.2'],
      ['MOT', 'M1.2', 'D1.1', 'Q1.2'], ['GND', 'J1.2', 'J2.2', 'Q1.3', 'RP.2', ...sup.map((_, k) => `L${k + 1}.1`)]]))
  const c33 = chip('ATmega328P', ['+3V3']), c5 = chip('ATmega328P', ['+5V']), cBoth = chip('ATmega328P', ['+5V', '+3V3']), nano = chip('Arduino Nano ATmega328', ['+3V3'])
  add('ATmega328P beside +3V3 is 3.3 V (IRLZ44N warns at 3.27 V), beside +5V is 5 V (passes), beside both keeps 3.3 V and 5 V; Arduino Nano ATmega328 beside +3V3 is 5 V',
    is(c33, 'op_drive', 'warn', 'Q1', /3\.27 V/) && !!drive(c33)?.detail.some(d => /J1 값 ATmega328P, 같은 커넥터의 3\.3 V 전원으로 도는 칩 → 3\.3 V 신호로 계산/.test(d))
    && is(c5, 'op_drive', 'pass', 'Q1') && is(cBoth, 'op_drive', 'warn', 'Q1', /5 V 신호에서만/) && is(nano, 'op_drive', 'pass', 'Q1'),
    [c33, c5, cBoth, nano].map(said).join(' || '))

  // 5. an NPN's emitter resistor that the base current alone heats past the rating fails whatever the load draws:
  //    0.5² × 1 Ω = 250 mW, 0.5² × 0.5 Ω = 125 mW, 1.06² × 1 Ω = 1.13 W against 125 mW
  const npn = (rb: string, re: string) => run(circuit(
    [['J1', 'Conn_01x02', '5V'], ['RB', 'R', rb], ['RE', 'R', re], ['Q1', 'Q_NPN', '2N3904'], ['M1', 'Conn_01x02', 'MOTOR'], ['J2', 'Conn_01x02', 'PWR'], ['D1', 'D', '1N4007']],
    [['IO', 'J1.1', 'RB.1'], ['B', 'RB.2', 'Q1.1'], ['E', 'Q1.3', 'RE.1'], ['+12V', 'J2.1', 'M1.1', 'D1.2'], ['C', 'M1.2', 'Q1.2', 'D1.1'], ['GND', 'J1.2', 'J2.2', 'RE.2']]), 'smd')
  const npns = [['10', '1', '250 mW'], ['10', '0.5', '125 mW'], ['4.7', '1', '1.13 W']].map(([rb, re, p]) => [npn(rb, re), p] as const)
  add('NPN with RB 10 Ω/RE 1 Ω, RB 10 Ω/RE 0.5 Ω, RB 4.7 Ω/RE 1 Ω and an unknown motor: RE fails from the base current alone (250 mW, 125 mW, 1.13 W), never "0 mA 이하면"',
    npns.every(([rs, p]) => is(rs, 'op_rpower', 'error', 'RE', new RegExp(`${p.replace('.', '\\.')} ≥ 정격 125 mW`)) && !nonPositive(rs) && !pick(rs, 'op_rpower', 'RE')?.cause),
    npns.map(([rs]) => show(rs, 'op_rpower', 'RE')).join(' || '))

  // 6. with the current unknown, the most a sense resistor carries is also the load's supply over it: 12 V ÷ 1 Ω = 12 A, a
  //    12 V drop and 144 W, not 47 A, 47 V and 2209 W
  const big = gate('Arduino Uno', 'IRLZ44N', 'MOTOR', '100', '10k', '1', 'smd')
  const rsHeat = pick(big, 'op_rpower', 'RS')
  add('Uno → IRLZ44N over RS 1 Ω on 12 V with no motor current: the drop is 0~12 V at 12000 mA, the RS heat 144 W, never 47 V or 2209 W; still 판단 불가 1',
    is(big, 'op_drive', 'unknown', 'Q1') && !!drive(big)?.detail.some(d => /0~12000 mA\(부하 전원 12 V ÷ RS 1 Ω\) = 0~12 V/.test(d)) && !/47 V|2209 W/.test(`${text(drive(big))} ${text(rsHeat)}`)
    && is(big, 'op_rpower', 'unknown', 'RS', /144 W/) && head(big) === '판단 불가 1',
    `${drive(big)?.detail.find(d => /^소스 감지 저항/.test(d))} | ${show(big, 'op_rpower', 'RS')}`)

  // 7. a gate the drive passes even at the most current (12 V rail, RS 0.05 Ω: 9.65 V) heats with the row it reaches: 5 V's
  //    25 mΩ × 2.25, 6550 mA with no heatsink, not "게이트에 4 V 이상이 걸리면" and 5540 mA
  const rail = run(circuit(
    [['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', 'MOTOR'], ['D1', 'D', '1N4007'], ['Q1', 'Q_NMOS', 'IRLZ44N'], ['RG', 'R', '100'], ['RS', 'R', '0.05']],
    [['+12V', 'J2.1', 'M1.1', 'D1.2', 'RG.1'], ['G', 'RG.2', 'Q1.1'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'], ['SRC', 'Q1.3', 'RS.1'], ['GND', 'J2.2', 'RS.2']]))
  const railSw = pick(rail, 'op_switch', 'Q1')
  add('+12V → RG → IRLZ44N over RS 0.05 Ω, unknown motor: drive passes at 9.65 V and the switch says 6550 mA on the 5 V row, without "게이트에 4 V 이상"',
    is(rail, 'op_drive', 'pass', 'Q1', /9\.65 V/) && is(rail, 'op_switch', 'unknown', 'Q1', /방열판 없이 대략 6550 mA/) && !/게이트에 4 V 이상/.test(text(railSw))
    && !!railSw?.detail.some(d => /VGS 5 V의 RDS\(on\) 0\.025 Ω/.test(d)),
    `${show(rail, 'op_drive', 'Q1')} | ${show(rail, 'op_switch', 'Q1')}`)

  // 8. a gate with no pull-down is said whatever the load: with the motor current unknown over a sense resistor it warns
  //    on its own and tells to fit 10 kΩ; the unknown current is still counted once, with the switch
  const loose = gate('Arduino Uno', 'IRLZ44N', 'MOTOR', '100', null, '0.05'), held = gate('Arduino Uno', 'IRLZ44N', 'MOTOR', '100', '10k', '0.05')
  add('Uno → RG → IRLZ44N with no pull-down over RS 0.05 Ω and no motor current: "풀다운 저항 없음" warns with the 10 kΩ fix (동작 경고 1 · 판단 불가 1); with RP 판단 불가 1 only',
    is(loose, 'op_drive', 'warn', 'Q1', /풀다운 저항 없음/) && /게이트와 GND 사이에 10 kΩ/.test(fix(loose)) && head(loose) === '동작 경고 1 · 판단 불가 1'
    && is(held, 'op_drive', 'unknown', 'Q1') && head(held) === '판단 불가 1',
    `${head(loose)} · ${said(loose)} || ${head(held)}`)

  // 9. the sense resistor's limit for an unknown load is a bound the warning starts at (90 % of the rating): "미만이면".
  //    ESP32 → IRLZ44N over RS 0.05 Ω: 1500 mA, where the heat is 112.5 mW = 90 % and warns; just under it passes
  const esp = (m: string) => gate('ESP32', 'IRLZ44N', m, '100', '10k', '0.05', 'smd')
  const limitLine = pick(esp('MOTOR'), 'op_rpower', 'RS')?.detail.find(d => /^부하가 /.test(d)) ?? ''
  add('ESP32 → IRLZ44N over RS 0.05 Ω: the unknown load\'s RS limit reads "1500 mA 미만이면"; 1.5 A warns and 1.495 A passes',
    /^부하가 1500 mA 미만이면 정격 125 mW의 90% 미만입니다$/.test(limitLine) && is(esp('MOTOR 12V 1.5A'), 'op_rpower', 'warn', 'RS') && is(esp('MOTOR 12V 1.495A'), 'op_rpower', 'pass', 'RS'),
    `${limitLine} | ${show(esp('MOTOR 12V 1.5A'), 'op_rpower', 'RS')} | ${show(esp('MOTOR 12V 1.495A'), 'op_rpower', 'RS')}`)

  const problems = verdictProblems(ALL)
  add('every verdict up to here: basis, no NaN, distinct numbers', problems.length === 0, `${ALL.length} results${problems.length ? ' · ' + [...new Set(problems)].slice(0, 4).join(' | ') : ''}`)
  for (const [name, ok, info] of F) check(`O26 ${name}`, ok, info)
}

// O27. fourth review (2026-11-09): a 5 V in the signal net's name lifting a 3.3 V board, a fix for the part's own gate that
// leaves the load too hot, a heatsink taken for "견디지 못합니다", a bare ATmega328P with no supply pin read as 5 V, and a
// load too hot at any gate left as only "판단합니다"; the peer's three MCU → MOSFET cases kept
{
  const F: [string, boolean, string][] = []
  const add = (name: string, ok: boolean, info: string) => F.push([name, ok, info])
  const drive = (rs: OpResult[]) => pick(rs, 'op_drive', 'Q1')
  const fix = (rs: OpResult[]) => drive(rs)?.fix ?? ''
  const said = (rs: OpResult[]) => { const r = drive(rs); return r ? `${r.state}: ${r.summary}${r.fix ? ` fix: ${r.fix}` : ''}` : '(no op_drive)' }
  // J1 (signal, GND) → RG → gate, RP 10k to GND, a motor on +12V; `net` names the signal's net
  const gate = (j1: string, q: string, mot: string, rg = '100', net = 'IO') => run(circuit(
    [['J1', 'Conn_01x02', j1], ['J2', 'Conn_01x02', 'PWR'], ['M1', 'Conn_01x02', mot], ['D1', 'D', '1N4007'], ['Q1', 'Q_NMOS', q], ['RP', 'R', '10k'], ['RG', 'R', rg]],
    [[net, 'J1.1', 'RG.1'], ['G', 'RG.2', 'Q1.1', 'RP.1'], ['+12V', 'J2.1', 'M1.1', 'D1.2'], ['MOT', 'M1.2', 'D1.1', 'Q1.2'], ['GND', 'J1.2', 'J2.2', 'Q1.3', 'RP.2']]))

  // 1. the peer's cases: ESP32 → IRFZ44N cannot be relied on to turn on, Arduino Uno → IRLZ44N passes, ESP32 → IRLZ44N warns
  const espIrf = gate('ESP32', 'IRFZ44N', 'MOTOR 12V 1A'), unoIrl = gate('Arduino Uno', 'IRLZ44N', 'MOTOR 12V 1A'), espIrl = gate('ESP32', 'IRLZ44N', 'MOTOR 12V 1A')
  add('ESP32 → IRFZ44N errs under the 4 V threshold, Arduino Uno → IRLZ44N passes, ESP32 → IRLZ44N warns under the 4 V guarantee',
    is(espIrf, 'op_drive', 'error', 'Q1', /3\.27 V < 문턱 최대 4 V/) && is(unoIrl, 'op_drive', 'pass', 'Q1') && is(unoIrl, 'op_switch', 'pass', 'Q1')
    && is(espIrl, 'op_drive', 'warn', 'Q1', /3\.27 V.*보장 전압 4 V 미만/),
    [espIrf, unoIrl, espIrl].map(said).join(' || '))

  // 2. a 5 V in the signal net's name is as often the load's: it never lifts an ESP32's pin to 5 V (PWM_5V, FAN_5V_CTRL,
  //    MOTOR_5V_PWM), while a 3V3 in it still lowers an Uno's pin
  const named = ['PWM_5V', 'FAN_5V_CTRL', 'MOTOR_5V_PWM'].map(n => [n, gate('ESP32', 'IRLZ44N', 'MOTOR 12V 1A', '100', n)] as const)
  const uno33 = gate('Arduino Uno', 'IRLZ44N', 'MOTOR 12V 1A', '100', 'VCC_3V3')
  add('an ESP32 pin on PWM_5V, FAN_5V_CTRL or MOTOR_5V_PWM is still 3.3 V (IRLZ44N warns); an Uno pin on VCC_3V3 is 3.3 V',
    named.every(([, rs]) => is(rs, 'op_drive', 'warn', 'Q1', /3\.27 V/) && !!drive(rs)?.detail.includes('구동 전압: J1 값 ESP32 → 3.3 V 신호로 계산'))
    && is(uno33, 'op_drive', 'warn', 'Q1', /3\.27 V/),
    `${named.map(([n, rs]) => `${n}: ${said(rs)}`).join(' || ')} | ${said(uno33)}`)

  // 3. a fix that keeps the part says what the load then does to it: IRLZ44N with RG 10k at 6 A is told the divider and that
  //    2.84 W needs a heatsink; at 45 A (159 W, over PD 110 W) the divider alone is not offered
  const six = gate('Arduino Uno', 'IRLZ44N', 'MOTOR 12V 6A', '10k'), big = gate('Arduino Uno', 'IRLZ44N', 'MOTOR 12V 45A', '10k')
  add('Uno → 10k/10k → IRLZ44N: at 6 A the divider fix adds "2.84 W라 방열판이 필요합니다"; at 45 A the divider alone is not the fix',
    /RG를 풀다운 RP의 1\/100 이하로.*줄이면 됩니다\. 부하 6000 mA에서는 발열이 대략 2\.84 W라 방열판이 필요합니다/.test(fix(six))
    && !/줄이면 됩니다/.test(fix(big)) && /견디지 못합니다/.test(fix(big)),
    `${said(six)} || ${said(big)}`)

  // 4. another part that only needs a heatsink is offered with that said, not struck as "견디지 못합니다": IRFZ44N at 10 A from an Uno
  const irf10 = gate('Arduino Uno', 'IRFZ44N', 'MOTOR 12V 10A')
  add('Uno → IRFZ44N at 10 A: the fix offers IRLZ44N and says 7.88 W needs a heatsink, never "견디지 못합니다"',
    /IRLZ44N으로 바꾸면 됩니다.*7\.88 W라 방열판이 필요합니다/.test(fix(irf10)) && !/견디지 못합니다/.test(fix(irf10)),
    said(irf10))

  // 5. a bare ATmega328P with no supply pin beside it says nothing of its level: 3.3 V and 5 V both
  const bare = gate('ATmega328P', 'IRLZ44N', 'MOTOR 12V 0.5A')
  add('a bare ATmega328P header with no supply pin: both 3.3 V and 5 V (warns "5 V 신호에서만")',
    is(bare, 'op_drive', 'warn', 'Q1', /5 V 신호에서만/) && !drive(bare)?.detail.some(d => /신호로 계산/.test(d)),
    said(bare))

  // 6. a gate under every RDS(on) row leaves the heat unknown, but a load that the smallest row still heats past free air
  //    needs a heatsink whatever the gate: ESP32 → IRLZ44N at 45 A says so; at 1 A it does not
  const hot = gate('ESP32', 'IRLZ44N', 'MOTOR 12V 45A')
  const swFix = (rs: OpResult[]) => pick(rs, 'op_switch', 'Q1')?.fix ?? ''
  add('ESP32 → IRLZ44N at 45 A: the heat is unknown and its fix says a heatsink is needed at any gate (100 W > 2.42 W); at 1 A it does not',
    is(hot, 'op_switch', 'unknown', 'Q1') && /어느 게이트 전압에서도 발열이 대략 100 W 이상이라 방열판 없이 견디는 2\.42 W를 넘으므로, 방열판은 필요합니다/.test(swFix(hot))
    && !/방열판은 필요합니다/.test(swFix(espIrl)),
    `${show(hot, 'op_switch', 'Q1')} fix: ${swFix(hot)}`)

  const problems = verdictProblems(ALL)
  add('every verdict up to here: basis, no NaN, distinct numbers', problems.length === 0, `${ALL.length} results${problems.length ? ' · ' + [...new Set(problems)].slice(0, 4).join(' | ') : ''}`)
  for (const [name, ok, info] of F) check(`O27 ${name}`, ok, info)
}

// O9. schematic and finished board give the same answers (real boards in server/outputs) ──
// the netlists are read with the server's own reader (server/netlist.ts), as /generate and /demo_result read them
{
  const dir = path.join('server', 'outputs')
  const pairs = fs.readdirSync(dir).filter(f => f.endsWith('.board.json')).map(f => f.replace('.board.json', ''))
    .filter(b => fs.existsSync(path.join(dir, `${b}.net`)))
  const diff: string[] = []
  let compared = 0
  for (const b of pairs) {
    const board = JSON.parse(fs.readFileSync(path.join(dir, `${b}.board.json`), 'utf-8')) as BoardModel
    if (!board.parts.some(p => p.pad_pins)) continue
    const graph = parseNetlist(fs.readFileSync(path.join(dir, `${b}.net`), 'utf-8'))
    const key = (rs: OpResult[]) => rs.map(r => `${r.rule}/${r.ref}/${r.state}`).sort().join(' ')
    const a = key(operatingChecks(fromBoard(board))), g = key(operatingChecks(fromGraph(graph, board.style ?? null)))
    compared++
    if (a !== g) diff.push(`${b}: board[${a}] graph[${g}]`)
  }
  check('O9 schematic and board agree', compared > 0 && diff.length === 0, `${compared} boards${diff.length ? ' · ' + diff.slice(0, 2).join(' || ') : ''}`)
}

// O10. every real board: no crash, no NaN, every verdict shows its basis ────────────
{
  const dir = path.join('server', 'outputs')
  const problems: string[] = []
  const FURN = new Set(['MountingHole', 'TestPoint'])
  let n = 0, results = 0
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.board.json'))) {
    const b = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as BoardModel
    let rs: OpResult[] = []
    try { rs = operatingChecks(fromBoard(b)) } catch (e) { problems.push(`${f}: ${(e as Error).message}`); continue }
    n++; results += rs.length
    if (b.parts.some(p => !FURN.has(p.part) && !p.pad_pins) && !(rs.length === 1 && rs[0].rule === 'op_data' && rs[0].state === 'unknown')) {
      problems.push(`${f}: no pin map but ${rs.map(r => `${r.rule}:${r.state}`).join(' ')}`)
    }
    for (const r of rs) {
      if (/정격 1 V|정격 12 V:/.test(r.detail.join(' '))) problems.push(`${f} ${r.ref}: number cut short`)
      if (/NaN|undefined|Infinity/.test(r.summary + r.detail.join(' '))) problems.push(`${f} ${r.ref}: ${r.summary}`)
      if (r.state !== 'unknown' && r.rule !== 'op_555' && r.detail.length === 0) problems.push(`${f} ${r.ref} ${r.rule}: no basis`)
    }
  }
  // the same board with its pin map removed: no verdicts at all, only "판단 불가"
  const withPins = fs.readdirSync(dir).filter(x => x.endsWith('.board.json'))
    .map(x => JSON.parse(fs.readFileSync(path.join(dir, x), 'utf-8')) as BoardModel).find(b => b.parts.some(p => p.pad_pins))
  if (withPins) {
    const stripped = structuredClone(withPins)
    stripped.parts.forEach(p => { delete p.pad_pins })
    const rs = operatingChecks(fromBoard(stripped))
    if (!(rs.length === 1 && rs[0].rule === 'op_data' && rs[0].state === 'unknown')) problems.push(`stripped board: ${rs.map(r => `${r.rule}:${r.state}`).join(' ')}`)
  }
  check('O10 real boards: no crash, no NaN, basis shown', problems.length === 0 && n > 0, `${n} boards, ${results} results${problems.length ? ' · ' + problems.slice(0, 3).join(' | ') : ''}`)
}

// O11. the demo circuit files: each good one passes, each bad twin fails on its one fault ──
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sf_opcheck_'))
  const netOf = (name: string): NetGraph => {
    fs.copyFileSync(path.join('server', 'test_circuits', `${name}.py`), path.join(work, `${name}.py`))
    execFileSync('python', [`${name}.py`], { cwd: work, stdio: 'ignore' })
    return parseNetlist(fs.readFileSync(path.join(work, `${name}.net`), 'utf-8'))
  }
  const pairs: [string, string, OpRule, RegExp][] = [
    ['led_basic', 'led_bad', 'op_led', /최대 30 mA/],
    ['npn_relay', 'relay_bad', 'op_flyback', /거꾸로/],
    ['ne555_blink', 'ne555_bad', 'op_555', /동작 범위/],
  ]
  // the same circuits with every pin saved by name, as an older edit saved them (LED A/K, Q_NPN B/C/E, NE555 TRIG, Relay
  // COIL1, R p1): 2026-11-08 they had no pins here, and 검사할 부품 없음 showed as a pass
  const named = (g: NetGraph): NetGraph => ({ ...g, nets: g.nets.map(n => ({ ...n, nodes: n.nodes.map(nd => {
    const part = g.components.find(c => c.ref === nd.ref)?.name ?? ''
    return { ...nd, pin: PIN_NAMES[part]?.[Number(nd.pin) - 1] ?? `p${nd.pin}` }
  }) })) })
  const byName: string[] = []
  let led: NetGraph | null = null
  for (const [good, bad, rule, why] of pairs) {
    const gg = netOf(good), bb = netOf(bad)
    if (good === 'led_basic') led = gg
    const g = operatingChecks(fromGraph(gg, 'smd')), b = operatingChecks(fromGraph(bb, 'smd'))
    const goodOk = g.length > 0 && g.every(r => r.state === 'pass')
    const badOk = is(b, rule, 'error', undefined, why)
    check(`O11 demo ${good} passes, ${bad} fails on ${rule}`, goodOk && badOk,
      `${operatingHeadline(g).text} / ${operatingHeadline(b).text}: ${show(b, rule)}`)
    for (const [name, net, rs] of [[good, gg, g], [bad, bb, b]] as const) {
      const n = named(net)
      if (n.nets.every(x => x.nodes.every(nd => /^\d+$/.test(nd.pin)))) byName.push(`${name}: no pin renamed`)
      else if (full(operatingChecks(fromGraph(n, 'smd'))) !== full(rs)) byName.push(`${name}: ${operatingHeadline(operatingChecks(fromGraph(n, 'smd'))).text}`)
    }
  }
  // a name the pin-name table does not know is not guessed: 판단 불가 for the circuit, never a pass
  const unknown = led && variant(named(led), c => {
    c.nets.flatMap(x => x.nodes).find(nd => nd.pin === 'A' && c.components.find(p => p.ref === nd.ref)?.name === 'LED')!.pin = 'ANODE'
  })
  const u = unknown ? operatingChecks(fromGraph(unknown, 'smd')) : []
  check('O11b the demos with every pin saved by name give the numbered verdicts; a name the table does not know is 판단 불가',
    !byName.length && u.length === 1 && u[0].rule === 'op_data' && u[0].state === 'unknown' && operatingHeadline(u).state === 'unknown',
    `${byName.join(' | ')}${u.length ? ` · unknown name: ${operatingHeadline(u).text}` : ''}`)
}

console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
