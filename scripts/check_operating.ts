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
import { SPECS } from '../src/lib/partSpecs.ts'
import type { BoardModel, NetGraph } from '../src/types.ts'

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
const near = (a: number | null, b: number | null) => (a == null || b == null ? a === b : Math.abs(a - b) <= Math.abs(b) * 1e-9)

// O1. reading values ────────────────────────────────────────────────────────────
{
  const ohms: [string, number | null][] = [['680', 680], ['10k', 1e4], ['4k7', 4700], ['4.7k', 4700], ['1M', 1e6], ['100R', 100], ['0R1', 0.1], ['10 Ω', 10], ['0.1', 0.1], ['abc', null], ['100m', 0.1], ['100mΩ', 0.1]]
  const farads: [string, number | null][] = [['100nF', 1e-7], ['10uF', 1e-5], ['0.1uF', 1e-7], ['22p', 2.2e-11], ['1u', 1e-6], ['104', null], ['22μF', 2.2e-5], ['10', null]]
  const volts: [string, number | null][] = [['9V', 9], ['3.7 V', 3.7], ['3V3', 3.3], ['SRD-05VDC-SL-C', 5], ['12VDC', 12], ['RED', null], ['2x1.5V', 3], ['12V2A', 12]]
  const names: [string, number | null][] = [['GND', 0], ['+5V', 5], ['12V', 12], ['3V3', 3.3], ['+3.3V', 3.3], ['VCC', null], ['PWM', null]]
  const bad = [
    ...ohms.filter(([s, v]) => !near(parseOhms(s), v)).map(([s]) => `ohms ${s}`),
    ...farads.filter(([s, v]) => !near(parseFarads(s), v)).map(([s]) => `farads ${s}`),
    ...volts.filter(([s, v]) => !near(parseVolts(s), v)).map(([s]) => `volts ${s}`),
    ...names.filter(([s, v]) => !near(voltsFromName(s), v)).map(([s]) => `net ${s}`),
  ]
  check('O1 value parsers', bad.length === 0, bad.join(', '))
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
  check('O3g unknown LED colour: 판단 불가, never pass', is(run(variant(led, setValue('D1', 'GREEN'))), 'op_led', 'unknown', 'D1'))
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
  // the regulator output becomes a known supply for what it feeds
  const fed = circuit([['BT1', 'Battery', '9V'], ['U1', 'REG', 'AMS1117-3.3'], ['C1', 'CP', '22uF'], ['R1', 'R', '100'], ['D1', 'LED', 'RED']],
    [['VIN', 'BT1.1', 'U1.3'], ['GND', 'BT1.2', 'U1.1', 'C1.2', 'D1.2'], ['V3', 'U1.2', 'C1.1', 'R1.1'], ['LED_A', 'R1.2', 'D1.1']])
  check('O7f LED fed by the 3.3 V output: (3.3 − 1.9) / 100 = 14 mA', is(run(fed), 'op_led', 'pass', 'D1', /14 mA/), show(run(fed), 'op_led'))
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
    is(ra10, 'op_rpower', 'error', 'R1', /8\.1 W/), `${show(run(coll), 'op_rpower', 'RC')} | ${show(run(across), 'op_rpower')} | ${show(ra10, 'op_rpower', 'R1')}`)

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
  /** the same circuit with its parts, nets and pins listed in reverse */
  const reversed = (g: NetGraph): NetGraph => ({ components: [...g.components].reverse(), nets: [...g.nets].reverse().map(n => ({ ...n, nodes: [...n.nodes].reverse() })) })
  const full = (rs: OpResult[]) => rs.map(r => `${r.rule}/${r.ref}/${r.state}/${r.summary}`).sort().join('\n')

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
  add('regulator on a dead battery / short of input behind a switch: LED not judged, one fault',
    is(deadReg, 'op_led', 'unknown', 'D1') && head(deadReg) === '동작 안 됨 1' && is(swReg, 'op_reg', 'error', 'U1', /유지하지 못합니다/) &&
    is(swReg, 'op_led', 'unknown', 'D1') && head(swReg) === '동작 안 됨 1',
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

  for (const [name, ok, info] of F) check(`O15 ${name}`, ok, info)
}

// O14. every verdict from the circuits above: basis shown, no NaN, no "same < same" ────
{
  const problems: string[] = []
  const strict = /(?<![\d.\-−])([\d.]+ (?:mA|µA|V|mW|W|Ω|kΩ|MΩ)) [<>] (?:최대 |최소 |필요 |허용 |정격 |동작 전압 )?\1(?![\d.])/
  for (const r of ALL) {
    const text = `${r.summary} ${r.detail.join(' ')}`
    if (/NaN|undefined|Infinity/.test(text)) problems.push(`${r.rule}/${r.ref}: ${r.summary}`)
    if (r.state !== 'unknown' && r.detail.length === 0) problems.push(`${r.rule}/${r.ref} no basis: ${r.summary}`)
    if (strict.test(r.summary)) problems.push(`${r.rule}/${r.ref} reads equal: ${r.summary}`)
    if (r.state === 'pass' && r.detail.some(d => /이어진 결과/.test(d))) problems.push(`${r.rule}/${r.ref} pass with a cause line`)
  }
  check('O14 every verdict above: basis, no NaN, distinct numbers', problems.length === 0 && ALL.length > 100, `${ALL.length} results${problems.length ? ' · ' + [...new Set(problems)].slice(0, 4).join(' | ') : ''}`)
}

// O9. schematic and finished board give the same answers (real boards in server/outputs) ──
function parseNetlist(text: string): NetGraph {
  const components: NetGraph['components'] = []
  const starts = [...text.matchAll(/\(comp\s*\(ref\s+"([^"]+)"\)\s*\(value\s+"([^"]*)"\)/g)].map(m => ({ idx: m.index!, ref: m[1], value: m[2] }))
  const netsIdx = text.search(/\(nets\b/)
  starts.forEach((c, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].idx : (netsIdx >= 0 ? netsIdx : text.length)
    const part = /\(part\s+"([^"]+)"\)/.exec(text.slice(c.idx, end))
    components.push({ ref: c.ref, value: c.value, name: part?.[1] })
  })
  const section = text.slice(Math.max(netsIdx, 0))
  const netStarts = [...section.matchAll(/\(net\s*\n?\s*\(code\s+(\d+)\)\s*\n?\s*\(name\s+"([^"]+)"\)/g)].map(m => ({ idx: m.index!, name: m[2] }))
  const nets = netStarts.map((n, i) => ({
    name: n.name,
    nodes: [...section.slice(n.idx, netStarts[i + 1]?.idx ?? section.length).matchAll(/\(node\s*\n?\s*\(ref\s+"([^"]+)"\)\s*\n?\s*\(pin\s+"([^"]+)"\)/g)]
      .map(m => ({ ref: m[1], pin: m[2] })),
  })).filter(n => n.nodes.length)
  return { components, nets }
}
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
  for (const [good, bad, rule, why] of pairs) {
    const g = operatingChecks(fromGraph(netOf(good), 'smd')), b = operatingChecks(fromGraph(netOf(bad), 'smd'))
    const goodOk = g.length > 0 && g.every(r => r.state === 'pass')
    const badOk = is(b, rule, 'error', undefined, why)
    check(`O11 demo ${good} passes, ${bad} fails on ${rule}`, goodOk && badOk,
      `${operatingHeadline(g).text} / ${operatingHeadline(b).text}: ${show(b, rule)}`)
  }
}

console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
