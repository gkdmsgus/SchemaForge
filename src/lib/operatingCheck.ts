import type { BoardModel, NetGraph } from '../types'
import { SPECS, assumedBjt, assumedMos, redLed, type BjtSpec, type LedSpec, type MosSpec, type Num } from './partSpecs'

// "Does this circuit actually work?" — numeric checks on the part values, on top of the
// structural checks (connected, grounded) the circuit already gets. Each check states
// what it computed, from which values, against which datasheet limit. When a needed value
// is missing (a supply that arrives through a connector, a motor's current) the answer is
// "판단 불가", never a pass.
//
// Direction of every estimate: a question where more current is worse ("does the LED burn",
// "is the transistor over its limit") uses the smallest drops and the highest supply; a
// question where less is worse ("does the relay pull in", "does the LED light") uses the
// largest drop the datasheet guarantees and the lowest supply.

export type OpState = 'pass' | 'warn' | 'error' | 'unknown'
export type OpRule =
  | 'op_data' | 'op_power' | 'op_short' | 'op_led' | 'op_flyback' | 'op_relay'
  | 'op_drive' | 'op_switch' | 'op_rpower' | 'op_cap' | 'op_555' | 'op_reg'

/** Rules in display order, with their Korean names. */
export const OP_RULES: [OpRule, string][] = [
  ['op_data', '검사 자료'],
  ['op_power', '전원 전압'],
  ['op_short', '전원 단락'],
  ['op_led', 'LED 전류'],
  ['op_flyback', '보호 다이오드'],
  ['op_relay', '릴레이 코일 전압'],
  ['op_drive', '트랜지스터 켜짐'],
  ['op_switch', '스위치 전류 한계'],
  ['op_rpower', '저항 발열'],
  ['op_cap', '극성 커패시터 방향'],
  ['op_555', '555 타이머'],
  ['op_reg', '레귤레이터 전압'],
]

export interface OpResult {
  rule: OpRule
  ref: string
  state: OpState
  summary: string        // one line with the deciding number
  detail: string[]       // the calculation and where each limit comes from
  /** another result's part whose fault causes this one; the headline counts the cause once */
  cause?: string
  /** the cause part's rule, when the part has more than one result (a relay's coil, not its contact) */
  causeRule?: OpRule
  /** the same physical problem seen from different parts (the two nets a short joins) */
  key?: string
}

export interface OpPart { ref: string; part: string; value: string }
export interface OpCircuit {
  parts: OpPart[]
  pins: Map<string, string>          // "R1.2" -> net (template pin numbers)
  style: 'smd' | 'tht' | null        // null before the PCB exists
  /** parts whose pins cannot be told apart (boards saved before pad_pins existed) */
  missing?: string[]
}

const pinKey = (ref: string, pin: number) => `${ref}.${pin}`
const FURNITURE = new Set(['MountingHole', 'TestPoint'])

/** The schematic graph (before a PCB exists); style = the SMD/THT choice the PCB will use. */
export function fromGraph(g: NetGraph, style: 'smd' | 'tht' | null = null): OpCircuit {
  const parts = (g.components || []).filter(c => c.name && !FURNITURE.has(c.name))
    .map(c => ({ ref: c.ref, part: c.name!, value: String(c.value ?? '') }))
  const known = new Set(parts.map(p => p.ref))
  const pins = new Map<string, string>()
  for (const n of g.nets || []) for (const nd of n.nodes || []) {
    if (known.has(nd.ref) && /^\d+$/.test(String(nd.pin))) pins.set(pinKey(nd.ref, Number(nd.pin)), n.name)
  }
  return { parts, pins, style }
}

/** The finished board (pads mapped back to template pins). */
export function fromBoard(b: BoardModel): OpCircuit {
  const real = (b.parts || []).filter(p => !FURNITURE.has(p.part))
  const pins = new Map<string, string>()
  for (const p of real) for (const pd of p.pads || []) {
    const pin = p.pad_pins?.[pd.num]
    if (pin != null && pd.net) pins.set(pinKey(p.ref, pin), pd.net)
  }
  return {
    parts: real.map(p => ({ ref: p.ref, part: p.part, value: String(p.value ?? '') })), pins, style: b.style ?? null,
    missing: real.filter(p => !p.pad_pins).map(p => p.ref),
  }
}

// ── values ─────────────────────────────────────────────────────────────────────

/** "680", "10k", "4k7", "4.7k", "1M", "100R", "0R1", "10 Ω", "100m" (milliohm) -> ohms */
export function parseOhms(v: string): number | null {
  const s = String(v ?? '').trim().replace(/Ω|ohms?/gi, '').replace(/\s+/g, '')
  // M is mega and m is milli (a 100 mΩ sense resistor), k/K kilo, r/R the decimal point
  const mul = (u: string) => (u === 'M' ? 1e6 : u === 'm' ? 1e-3 : u === 'k' || u === 'K' ? 1e3 : 1)
  let m = /^(\d+)([rRkKmM])(\d+)$/.exec(s)
  if (m) return Number(`${m[1]}.${m[3]}`) * mul(m[2])
  m = /^(\d+(?:\.\d+)?)([rRkKmM]?)$/.exec(s)
  if (m) return Number(m[1]) * mul(m[2])
  return null
}

/** "100nF", "10uF", "0.1µF", "22μF", "22p", "1u" -> farads */
export function parseFarads(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([pnuµμm])?(f)?$/i.exec(String(v ?? '').trim())
  if (!m || (!m[2] && !m[3])) return null      // "104" is a code, not 104 F
  const mul: Record<string, number> = { '': 1, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3 }
  const f = Number(m[1]) * mul[(m[2] || '').toLowerCase()]
  return Number.isFinite(f) ? f : null
}

/** "9V", "3.7 V", "3V3", "SRD-05VDC-SL-C", "12VDC", "2x1.5V", "1.5V x4" -> volts */
export function parseVolts(v: string): number | null {
  const s = String(v ?? '').toUpperCase()
  let m = /(\d+)\s*[X×*]\s*(\d+(?:\.\d+)?)\s*V/.exec(s)      // cells in series
  if (m) return Number(m[1]) * Number(m[2])
  m = /(\d+(?:\.\d+)?)\s*V\s*[X×*]\s*(\d+)(?![\d.]|\s*M?A(?![A-Z]))/.exec(s)  // the same written "1.5V x4 AA", but not "12V x 2A"
  if (m) return Number(m[1]) * Number(m[2])
  m = /(\d+)V(\d+)(?![\d.]*[A-Z])/.exec(s)                     // "3V3", but not "12V2A"
  if (m) return Number(`${m[1]}.${m[2]}`)
  m = /(\d+(?:\.\d+)?)\s*V/.exec(s)
  return m ? Number(m[1]) : null
}

/** "MOTOR 0.3A", "MOTOR 12V 500mA" -> amps */
export function parseAmps(v: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(m?A)(?![A-Za-z])/i.exec(String(v ?? ''))
  return m ? Number(m[1]) * (m[2].length === 2 ? 1e-3 : 1) : null
}

/** Supply voltage from a net name: GND (GNDD, GNDA, AGND, VSS…), +5V, 12V, 3V3, +3.3V. */
export function voltsFromName(net: string): number | null {
  const n = net.toUpperCase().replace(/^\+/, '')
  if (/^(GND[A-Z0-9_]*|[ADP]GND|VSS[A-Z0-9_]*|0V)$/.test(n)) return 0
  let m = /^(\d+)V(\d+)$/.exec(n)
  if (m) return Number(`${m[1]}.${m[2]}`)
  m = /^(\d+(?:\.\d+)?)V$/.exec(n)
  return m ? Number(m[1]) : null
}

// ── numbers in text, and comparisons ───────────────────────────────────────────

const trim = (t: string) => (t.includes('.') ? t.replace(/\.?0+$/, '') : t)
/** x with `digits` significant digits (never fewer than its integer part) */
function sig(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return String(x)
  if (x === 0) return '0'
  const d = Math.max(0, Math.min(7, digits - 1 - Math.floor(Math.log10(Math.abs(x)))))
  return trim(x.toFixed(d))
}
const mA = (a: number, digits = 3) => (a !== 0 && Math.abs(a) < 1e-5 ? `${sig(a * 1e6, digits)} µA` : `${sig(a * 1e3, digits)} mA`)
const V = (v: number, digits = 3) => `${sig(v, digits)} V`
const W = (p: number, digits = 3) => (Math.abs(p) < 1 ? `${sig(p * 1e3, digits)} mW` : `${sig(p, digits)} W`)
const ohm = (r: number, digits = 3) => (r >= 1e6 ? `${sig(r / 1e6, digits)} MΩ` : r >= 1e3 ? `${sig(r / 1e3, digits)} kΩ` : `${sig(r, digits)} Ω`)
const uF = (f: number) => `${sig(f * 1e6)} µF`
const cite = (n: Num) => n.src

// Korean particles after part and net names: "K1이", "D2가", "+5V는", "R1을"
// how the last character is read aloud: no final consonant, a final ㄹ, or another final
const DIGIT_FINAL = ['other', 'rieul', 'none', 'other', 'none', 'none', 'other', 'rieul', 'rieul', 'none'] as const   // 영 일 이 삼 사 오 육 칠 팔 구
function finalOf(word: string): 'none' | 'rieul' | 'other' {
  // the word before a closing "(...)", or the words inside it when nothing comes before: "(값 없음)을"
  const bare = word.replace(/['"’\]]+$/, '').trim()
  const ch = (bare.replace(/\([^)]*\)$/, '').replace(/['"’\]]+$/, '').trim() || bare.replace(/[()]/g, '').trim()).slice(-1)
  const code = ch.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) { const f = (code - 0xac00) % 28; return f === 0 ? 'none' : f === 8 ? 'rieul' : 'other' }
  if (/\d/.test(ch)) return DIGIT_FINAL[Number(ch)]
  if (/[LR]/i.test(ch)) return 'rieul'                 // 엘, 알
  return /[MNΩ]/i.test(ch) ? 'other' : 'none'         // 엠, 엔, 옴
}
const hasFinal = (w: string) => finalOf(w) !== 'none'
const ga = (w: string) => `${w}${hasFinal(w) ? '이' : '가'}`
const eul = (w: string) => `${w}${hasFinal(w) ? '을' : '를'}`
const eun = (w: string) => `${w}${hasFinal(w) ? '은' : '는'}`
const wa = (w: string) => `${w}${hasFinal(w) ? '과' : '와'}`
const ira = (w: string) => `${w}${hasFinal(w) ? '이라' : '라'}`
const ro = (w: string) => `${w}${finalOf(w) === 'other' ? '으로' : '로'}`
/** a part value for text: quoted, or "값 없음" */
const val = (v: string) => (v ? `'${v}'` : '(값 없음)')
/** a and b written with enough digits that two different numbers never read the same */
function two(a: number, b: number, f: (x: number, d: number) => string): [string, string] {
  for (let d = 3; d < 8; d++) { const x = f(a, d), y = f(b, d); if (x !== y) return [x, y] }
  return [f(a, 8), f(b, 8)]
}
/** "7.94~10.4 mA", or one number when the two ends agree */
function span(lo: number, hi: number, f: (x: number) => string): string {
  const a = f(lo), b = f(hi)
  if (a === b) return b
  const [na, ua] = a.split(' '), [, ub] = b.split(' ')
  return ua === ub ? `${na}~${b}` : `${a}~${b}`
}

const EPS = 1e-9
/** a >= b, ignoring floating-point noise (0.030000000000000002 is 30 mA) */
const atLeast = (a: number, b: number) => a >= b - Math.max(Math.abs(b), 1e-12) * EPS
/** within this fraction of an absolute maximum rating: warn */
const NEAR = 0.9
const SIGNAL_CANDIDATES = [3.3, 5]

const RANK: Record<OpState, number> = { pass: 0, unknown: 1, warn: 2, error: 3 }
export const worse = (a: OpState, b: OpState): OpState => (RANK[a] >= RANK[b] ? a : b)

// ── part data lookups ──────────────────────────────────────────────────────────

function ledSpec(value: string, style: 'smd' | 'tht' | null): LedSpec | null {
  const v = value.toUpperCase()
  if (/INFRA|(^|[^A-Z])IR([^A-Z]|$)/.test(v)) return null       // infrared: different part
  if (/(^|[^A-Z])RED([^A-Z]|$)|빨강|빨간/.test(v)) return redLed(style)
  return null
}

function bjtSpec(value: string, style: 'smd' | 'tht' | null): { spec: BjtSpec; note: string | null } {
  const v = value.toUpperCase().replace(/\s+/g, '')
  for (const [name, spec] of Object.entries(SPECS.bjt)) if (v.includes(name)) return { spec, note: null }
  const name = assumedBjt(style)
  return { spec: SPECS.bjt[name], note: `값 ${value || '(없음)'}의 자료가 없어 ${name} 기준으로 계산` }
}

function mosSpec(value: string, style: 'smd' | 'tht' | null): { spec: MosSpec; note: string | null } {
  const v = value.toUpperCase().replace(/\s+/g, '')
  for (const [name, spec] of Object.entries(SPECS.mos)) if (v.includes(name)) return { spec, note: null }
  const name = assumedMos(style)
  return { spec: SPECS.mos[name], note: `값 ${value || '(없음)'}의 자료가 없어 ${name} 기준으로 계산` }
}

/** A known regulator by part number: its output voltage, and its limits when they are verified. */
function regSpec(value: string) {
  const v = value.toUpperCase().replace(/\s+/g, '')
  const ams = /AMS1117-?(\d)\.?(\d)/.exec(v)
  if (ams) return { name: `AMS1117-${ams[1]}.${ams[2]}`, vout: Number(`${ams[1]}.${ams[2]}`), spec: SPECS.reg.AMS1117 }
  const s78 = /(?:^|[^0-9])78(05|06|08|09|12|15)/.exec(v)
  // only the 7805's limits were looked up; other 78xx keep their output voltage but no verdict
  if (s78) return { name: `78${s78[1]}`, vout: Number(s78[1]), spec: s78[1] === '05' ? SPECS.reg.L7805 : null }
  return null
}

/**
 * Coil voltage from a relay value: a plain voltage ("5V", "12 VDC") or a Sanyou SRD part
 * number ("SRD-05VDC-SL-C"). Other part numbers ("G5V-1 DC12") are not read: the series name
 * can hold a voltage that is not the coil's, and the Sanyou figures would not apply anyway.
 */
function relaySpec(value: string) {
  const s = value.toUpperCase().replace(/\s+/g, '')
  const m = /^(\d+(?:\.\d+)?)V(?:DC)?$/.exec(s) ?? /^SRD-(\d+)VDC/.exec(s)
  const rated = m ? Number(m[1]) : null
  return rated != null && SPECS.relay[rated] ? { rated, spec: SPECS.relay[rated], srd: s.startsWith('SRD') } : null
}

const resPower = (style: 'smd' | 'tht' | null) => (style === 'tht' ? SPECS.res.tht : SPECS.res.smd)

/**
 * Guaranteed minimum gain at this collector current: the lower of the two datasheet rows
 * around it (the curve between them is not guaranteed). Outside the listed currents the
 * datasheet promises nothing, so there is no answer.
 */
function hfeAt(spec: BjtSpec, ic: number) {
  const rows = [...spec.hfe_min].sort((a, b) => a.ic - b.ic)
  if (ic < rows[0].ic * (1 - EPS) || ic > rows[rows.length - 1].ic * (1 + EPS)) return null
  const above = rows.find(r => r.ic >= ic * (1 - EPS))!
  const below = [...rows].reverse().find(r => r.ic <= ic * (1 + EPS))
  return below && below.hfe < above.hfe ? below : above
}

// Parts that drive a signal of their own (a connector pin, an IC); everything else is passive.
const PASSIVE = new Set(['R', 'C', 'CP', 'L', 'D', 'LED', 'Q_NPN', 'Q_NMOS', 'SW', 'Battery', 'Relay', 'Buzzer', 'Crystal', 'REG'])
const isExternal = (p: OpPart) => /^Conn_/.test(p.part) || !PASSIVE.has(p.part)
/** a motor wired through a connector: a load, never a supply */
const isMotor = (p: OpPart) => /^Conn_/.test(p.part) && /MOTOR|모터/i.test(p.value)

// ── circuit index and supplies ─────────────────────────────────────────────────

interface Node { ref: string; pin: number }
interface Volt {
  v: number; why: string; src: 'name' | 'battery' | 'reg'
  /** the switch that has to be closed for this net to get its voltage */
  viaSwitch?: string
  /** an input a switch ties to GND (no part's ground on it): low only while the switch is closed */
  input?: boolean
  /** a button input: the switch ties it to GND, this resistor pulls it up while the switch is open */
  pulled?: { ref: string; v: number }
  /** a fault this voltage comes from (a battery put in backwards) */
  cause?: string
}
/** a node's voltage while the circuit runs, as a range */
interface Level { lo: number; hi: number; why: string; cause?: string }

const natural = (a: string, z: string) => a.localeCompare(z, 'en', { numeric: true })

/** `open`: relays whose COM–NO contact is taken as open (a coil is judged before its own contact closes) */
function baseIndex(c: OpCircuit, open: ReadonlySet<string> = new Set()) {
  // sorted, so that no answer depends on the order the parts and pins happen to be listed in
  const parts = [...c.parts].sort((a, z) => natural(a.ref, z.ref))
  const byNet = new Map<string, Node[]>()
  for (const [k, n] of [...c.pins].sort(([a], [z]) => natural(a, z))) {
    const i = k.lastIndexOf('.')
    const list = byNet.get(n) || []
    list.push({ ref: k.slice(0, i), pin: Number(k.slice(i + 1)) })
    byNet.set(n, list)
  }
  const byRef = new Map(parts.map(p => [p.ref, p]))
  const net = (ref: string, pin: number) => c.pins.get(pinKey(ref, pin)) ?? null
  const nets = [...byNet.keys()].sort(natural)
  return {
    style: c.style,
    /** a relay's COM–NO contact taken as closed (the circuit judged switched on, the relay pulled in);
     *  a coil with a pin left open or both pins on one net never pulls in */
    closedRelay: (ref: string) => { const a = net(ref, 1), z = net(ref, 2); return !open.has(ref) && !!a && !!z && a !== z },
    /** a relay not pulled in: its COM–NC contact is closed */
    releasedRelay: (ref: string) => { const a = net(ref, 1), z = net(ref, 2); return !(!open.has(ref) && !!a && !!z && a !== z) },
    parts: () => parts,
    nets: () => nets,
    net,
    on: (n: string | null): Node[] => (n ? byNet.get(n) || [] : []),
    part: (ref: string) => byRef.get(ref),
    of: (kind: string) => parts.filter(p => p.part === kind),
    /** the net on a two-pin part's other pin */
    other: (ref: string, pin: number) => net(ref, pin === 1 ? 2 : 1),
    /** a closed contact in text: "SW1", or "K1 접점" for a relay's COM–NO */
    contact: (ref: string) => (byRef.get(ref)?.part === 'Relay' ? `${ref} 접점` : ref),
    contactNoun: (ref: string) => (byRef.get(ref)?.part === 'Relay' ? '접점' : '스위치'),
    /** the time a contact pulls its net low: "SW1을 누르는 동안", "K1 접점이 닫혀 있는 동안" */
    whileClosed: (ref: string) => (byRef.get(ref)?.part === 'Relay' ? `${ref} 접점이 닫혀 있는 동안` : `${eul(ref)} 누르는 동안`),
  }
}
type Base = ReturnType<typeof baseIndex>

/**
 * Supply voltages. Physical sources come first: batteries (their voltages added along any
 * chain, whatever order the parts are listed in, switches and relay COM–NO contacts taken as
 * closed: the circuit is judged switched on, with each relay pulled in) and regulator
 * outputs. Net names fill in the rest. Where a name and a physical source disagree, the
 * physical value is used and the disagreement is reported. Nets whose voltage cannot be
 * trusted (a battery with a loose terminal, a regulator short of input) are `blocked`.
 */
function analyzePower(b: Base, force = false) {
  const issues: OpResult[] = []
  const issue = (ref: string, summary: string, detail: string[]) => issues.push({ rule: 'op_power', ref, state: 'error', summary, detail })
  const named = new Map<string, number>()
  for (const n of b.nets()) { const v = voltsFromName(n); if (v != null) named.set(n, v) }
  const volts = new Map<string, Volt>()
  /** `open`: no supply because a relay contact is open (a load there draws nothing, not an unknown current) */
  const blocked = new Map<string, { why: string; cause: string; open?: boolean }>()
  const hasConn = (n: string) => b.on(n).some(nd => { const p = b.part(nd.ref); return !!p && /^Conn_/.test(p.part) && !isMotor(p) })
  const regOut = (n: string) => b.of('REG').some(r => b.net(r.ref, 2) === n)
  /** a named rail fed from outside (a connector) or by a regulator, or the output of a regulator whose
   *  voltage is known: a closed switch does not change it (two sources meeting is a short, op_short) */
  const ownRail = (n: string) => (named.has(n) && (hasConn(n) || regOut(n))) ||
    b.of('REG').some(r => b.net(r.ref, 2) === n && regSpec(r.value) != null)

  interface Edge { ref: string; plus: string; minus: string; dv: number }
  const edges: Edge[] = []
  const loose: { ref: string; nets: string[] }[] = []
  for (const bt of b.of('Battery')) {
    const plus = b.net(bt.ref, 1), minus = b.net(bt.ref, 2), v = parseVolts(bt.value)
    if (!plus || !minus || v == null) continue
    if (plus === minus) {
      issue(bt.ref, `${bt.ref} 두 단자가 같은 넷 ${plus}에 있어 배터리가 단락됩니다`, [`${bt.ref} + 단자(1번 핀)와 − 단자(2번 핀)가 모두 ${plus}에 연결되어 있습니다`])
      continue
    }
    // a terminal whose net holds nothing else: no current can flow, nothing it feeds has a voltage
    const open = ([[plus, '+'], [minus, '−']] as const).filter(([n]) => b.on(n).length <= 1)
    if (open.length) {
      for (const [n, which] of open) {
        issue(bt.ref, `${bt.ref} ${which} 단자(${n})가 아무 데도 연결되어 있지 않아 전류가 흐르지 않습니다`,
          [`넷 ${n}에는 ${bt.ref} ${which} 단자 하나뿐입니다`, '배터리 − 단자는 GND 넷에, + 단자는 전원 넷에 연결해야 합니다'])
      }
      loose.push({ ref: bt.ref, nets: [plus, minus] })
      continue
    }
    edges.push({ ref: bt.ref, plus, minus, dv: v })
  }
  // the loose battery's nets lose their voltage, unless a connector, a regulator or another battery feeds them
  for (const l of loose) for (const n of l.nets) {
    if (!hasConn(n) && !regOut(n) && !edges.some(e => e.plus === n || e.minus === n)) blocked.set(n, { why: `${l.ref} 단자가 떠 있어 이 넷에 전원이 없습니다`, cause: l.ref })
  }
  interface Step { to: string; dv: number; label: string; sw?: string; bat?: string }
  const adj = new Map<string, Step[]>()
  const link = (from: string, step: Step) => adj.set(from, [...(adj.get(from) || []), step])
  for (const e of edges) {
    link(e.minus, { to: e.plus, dv: e.dv, label: `${e.ref} ${V(e.dv)}`, bat: e.ref })
    link(e.plus, { to: e.minus, dv: -e.dv, label: `−${e.ref} ${V(e.dv)}`, bat: e.ref })
  }
  const switches: { ref: string; a: string; z: string; label: string }[] = []
  for (const sw of b.parts().filter(p => p.part === 'SW' || p.part === 'Relay')) {
    const [pa, pz, label] = sw.part === 'SW' ? [1, 2, `${sw.ref} 닫힘`]
      : b.closedRelay(sw.ref) ? [3, 4, `${b.contact(sw.ref)} 닫힘`] : [3, 5, `${sw.ref} NC 접점 닫힘`]
    const a = b.net(sw.ref, pa), z = b.net(sw.ref, pz)
    if (!a || !z || a === z) continue
    switches.push({ ref: sw.ref, a, z, label })
    link(a, { to: z, dv: 0, label, sw: sw.ref })
    link(z, { to: a, dv: 0, label, sw: sw.ref })
  }
  /** a relay contact that is open in this state (COM–NO while released, COM–NC while pulled in): its two nets */
  const openPair = (ref: string): [number, number] => (b.closedRelay(ref) ? [3, 5] : [3, 4])
  /**
   * The relay whose open contact is the only way to a supply: a contact pin on the net (or on a net joined
   * to it by closed switches) whose other side has a voltage. `have` says which nets have one.
   */
  const openFeed = (n: string, have: (m: string) => boolean): string | undefined => {
    const seen = new Set([n]), queue = [n]
    while (queue.length) {
      const m = queue.shift()!
      for (const nd of b.on(m)) {
        const q = b.part(nd.ref)
        if (q?.part !== 'Relay' || b.net(q.ref, 1) === m || b.net(q.ref, 2) === m) continue
        const pair = openPair(q.ref)
        if (!pair.includes(nd.pin)) continue
        const far = b.net(q.ref, nd.pin === pair[0] ? pair[1] : pair[0])
        if (far && far !== m && have(far)) return q.ref
      }
      for (const sw of switches) for (const [a, z] of [[sw.a, sw.z], [sw.z, sw.a]]) if (a === m && !seen.has(z) && !have(z)) { seen.add(z); queue.push(z) }
    }
    return undefined
  }
  const batteryNet = (n: string) => edges.some(e => e.plus === n || e.minus === n)
  /**
   * voltages relative to `from` and the parts crossed to get there. Batteries first; a closed
   * switch only carries a voltage on into a net nothing else has fixed, and never to or from a
   * rail fed from outside (the same in both directions, so every walk over a group reaches all of it).
   */
  const walk = (from: string) => {
    const rel = new Map<string, { v: number; path: string[]; sw?: string; bats: string[] }>([[from, { v: 0, path: [], bats: [] }]])
    const queue = [from]
    const pending: { from: string; step: Step }[] = []
    for (;;) {
      while (queue.length) {
        const n = queue.shift()!, here = rel.get(n)!
        for (const st of adj.get(n) || []) {
          if (st.sw) { pending.push({ from: n, step: st }); continue }
          if (!rel.has(st.to)) { rel.set(st.to, { v: here.v + st.dv, path: [...here.path, st.label], sw: here.sw, bats: [...here.bats, st.bat!] }); queue.push(st.to) }
        }
      }
      const next = pending.find(p => !rel.has(p.step.to) && !ownRail(p.step.to) && !ownRail(p.from))
      if (!next) break
      const here = rel.get(next.from)!
      rel.set(next.step.to, { v: here.v, path: [...here.path, next.step.label], sw: here.sw ?? next.step.sw, bats: here.bats })
      queue.push(next.step.to)
    }
    return rel
  }
  const done = new Set<string>()
  const noGround: string[] = []         // batteries whose group holds no GND-named net
  for (const e0 of edges) {
    if (done.has(e0.minus)) continue
    const first = walk(e0.minus)
    const members = [...first.keys()]
    members.forEach(n => done.add(n))
    const group = edges.filter(e => first.has(e.minus))
    const zero = members.find(n => named.get(n) === 0)
    const anchorByName = zero ?? members.find(n => named.has(n))
    let anchor: string, base: number, basis: string
    if (anchorByName) { anchor = anchorByName; base = named.get(anchor)!; basis = `넷 이름 ${anchor} 기준` }
    else {
      anchor = members.reduce((a, n) => (first.get(n)!.v < first.get(a)!.v ? n : a))
      base = 0; basis = `${eul(anchor)} 0 V로 봄`
    }
    if (zero == null) noGround.push(...group.map(e => e.ref))
    const rel = walk(anchor)
    // a battery put in backwards between two named nets: what it feeds (its terminals, and nets whose
    // voltage is reached through it) follows from that fault; nets other batteries fix do not
    const backwards = group.filter(e => {
      const np = named.get(e.plus), nm = named.get(e.minus)
      return np != null && nm != null && Math.abs(np - nm + e.dv) <= 0.05
    })
    for (const n of members) {
      const r = rel.get(n)
      if (!r) continue
      volts.set(n, {
        v: base + r.v, src: 'battery', why: r.path.length ? `${r.path.join(' + ')} (${basis})` : named.has(n) ? `넷 이름 ${n}` : basis,
        ...(r.sw ? { viaSwitch: r.sw } : {}),
        ...((bw => (bw ? { cause: bw.ref } : {}))(backwards.find(e => r.bats.includes(e.ref)))),
      })
    }
    // two batteries of different voltage across the same nets
    for (const e of group) {
      const rp = rel.get(e.plus), rm = rel.get(e.minus)
      if (!rp || !rm) continue
      const got = rp.v - rm.v
      if (Math.abs(got - e.dv) > 0.01) {
        issue(e.ref, `${e.ref} ${V(e.dv)}가 이미 ${V(got)} 차이로 정해진 두 넷(${e.plus}, ${e.minus}) 사이에 연결되어 있습니다: 전압이 다른 전원이 맞물려 큰 전류가 흐릅니다`,
          [`${e.plus}: ${volts.get(e.plus)!.why}`, `${e.minus}: ${volts.get(e.minus)!.why}`])
      }
    }
    for (const e of backwards) {
      issue(e.ref, `${e.ref} 방향이 거꾸로입니다: + 단자가 ${e.plus}(${V(named.get(e.plus)!)}), − 단자가 ${e.minus}(${V(named.get(e.minus)!)})에 있습니다`,
        ['배터리 템플릿은 1번 핀이 +, 2번 핀이 −입니다', '거꾸로 걸린 전압은 부품을 망가뜨릴 수 있습니다'])
    }
    // a net named for one voltage that the batteries put at another
    for (const n of members) {
      const want = named.get(n), got = volts.get(n)?.v
      if (want == null || got == null || Math.abs(want - got) <= 0.05 || backwards.some(e => e.plus === n || e.minus === n)) continue
      const near = group.find(e => e.plus === n || e.minus === n) ?? group[0]
      issue(near.ref, `넷 이름 ${eun(n)} ${V(want)}인데 실제로는 ${V(got)}입니다`, [`${n}: ${volts.get(n)!.why}`, '계산에는 배터리로 정해지는 실제 전압을 씁니다'])
    }
  }

  // A battery group with no GND of its own was put at 0 V from its lowest net. Joined to a known rail by a
  // closed switch or contact it sits on that rail; meeting the rest of the circuit only at an open relay
  // contact it is not connected at all.
  const groupsOf = new Map<string, Set<string>>()
  for (const e of edges) {
    if (groupsOf.has(e.minus)) continue
    const g = new Set(walk(e.minus).keys())
    for (const n of g) groupsOf.set(n, g)
  }
  for (const g of new Set(groupsOf.values())) {
    if ([...g].some(n => named.get(n) === 0) || [...g].some(n => named.has(n))) continue
    const lift = switches.flatMap(sw => [[sw.a, sw.z, sw], [sw.z, sw.a, sw]] as const)
      .find(([a, z]) => g.has(a) && !g.has(z) && (volts.has(z) && !g.has(z) || named.has(z)))
    if (lift) {
      const [a, z, sw] = lift
      const target = volts.get(z)?.v ?? named.get(z)!, delta = target - volts.get(a)!.v
      for (const n of g) { const v = volts.get(n)!; volts.set(n, { ...v, v: v.v + delta, why: `${v.why} + ${sw.label}로 ${z}(${V(target)})에 이어짐`, viaSwitch: v.viaSwitch ?? sw.ref }) }
      continue
    }
    for (const n of g) for (const nd of b.on(n)) {
      const q = b.part(nd.ref)
      if (q?.part !== 'Relay') continue
      const pair = openPair(q.ref)
      if (!pair.includes(nd.pin)) continue
      const far = b.net(q.ref, nd.pin === pair[0] ? pair[1] : pair[0])
      if (!far || g.has(far)) continue
      for (const m of g) { volts.delete(m); blocked.set(m, { why: `${q.ref} 접점이 열려 있어 이 배터리 묶음이 회로와 이어지지 않습니다`, cause: q.ref, open: true }) }
      break
    }
  }

  // A GND-named net that no battery reaches and nothing else feeds (no connector) cannot return
  // current to a battery whose group has no GND of its own.
  const deadGround = noGround.length ? [...named.keys()].filter(n => named.get(n) === 0 && !volts.has(n) && !blocked.has(n) && !hasConn(n)) : []
  if (deadGround.length) {
    issue(noGround[0], `${noGround.join('·')} 배터리가 ${deadGround.slice(0, 3).join(', ')} 넷과 이어져 있지 않습니다: 이 넷에 연결된 부품은 배터리로 전류가 돌아가지 못합니다`,
      ['배터리 − 단자를 GND 넷에 연결해야 합니다', `${deadGround.join(', ')}의 전압은 이름만 보고 정하지 않습니다`])
    for (const n of deadGround) blocked.set(n, { why: `${ga(n)} 배터리와 이어져 있지 않습니다`, cause: noGround[0] })
  }

  // Regulator outputs and closed switches, until nothing changes: one regulator can feed another,
  // and a switch can carry a named rail to a regulator's input. A regulator whose input is not
  // known yet waits until nothing else can give it one, and only then is assumed to have enough.
  const nameOf = (n: string) => (blocked.has(n) ? undefined : named.get(n))
  /** a net's voltage so far, or its name (not a regulator output's name: the regulator decides that one) */
  const known = (n: string): Volt | undefined => {
    const nv = nameOf(n)
    return volts.get(n) ?? (nv != null && !regOut(n) ? { v: nv, why: `넷 이름 ${n}`, src: 'name' } : undefined)
  }
  /** no power here: a loose battery terminal, a ground no battery reaches, a regulator short of input */
  const dead = (n: string | null) => (n && !volts.has(n) ? blocked.get(n) : undefined)
  const carry = (from: (n: string) => Volt | undefined) => {
    let changed = false
    for (const sw of switches) for (const [a, z] of [[sw.a, sw.z], [sw.z, sw.a]]) {
      const v = from(a)
      if (!v || volts.has(z) || blocked.has(z) || named.has(z) || ownRail(z)) continue
      volts.set(z, { ...v, why: `${v.why} → ${sw.label}`, viaSwitch: v.viaSwitch ?? sw.ref })
      changed = true
    }
    return changed
  }
  for (let guard = 0, assume = false; guard < 50; guard++) {
    let changed = carry(known)
    for (const r of b.of('REG')) {
      const reg = regSpec(r.value)
      const g = b.net(r.ref, 1), o = b.net(r.ref, 2), i = b.net(r.ref, 3)
      if (!reg || !o || o === g || o === i || volts.has(o) || blocked.has(o) || hasConn(o)) continue
      if (!g) { if (assume) { blocked.set(o, { why: `${r.ref} GND 핀(1번)이 연결되지 않아 출력이 정해지지 않습니다`, cause: r.ref }); changed = true } continue }
      const off = dead(g) ?? dead(i)
      if (off) { blocked.set(o, { why: `${r.ref} ${dead(g) ? 'GND' : '입력'} 쪽: ${off.why}`, cause: off.cause }); changed = true; continue }
      const gv = volts.get(g)?.v ?? nameOf(g)
      if (gv == null) {
        if (assume) { blocked.set(o, { why: `${r.ref} GND 핀 넷 ${g}에 GND가 없어 출력이 정해지지 않습니다`, cause: r.ref }); changed = true }
        continue
      }
      const vin = i ? volts.get(i)?.v ?? nameOf(i) : undefined
      if (vin == null && !assume) continue
      if (vin == null && i) {
        const k = openFeed(i, m => volts.has(m) || nameOf(m) != null)
        if (k) { blocked.set(o, { why: `${k} 접점이 열려 있어 ${r.ref} 입력에 전원이 없습니다`, cause: k, open: true }); changed = true; continue }
      }
      changed = true
      if (!force && vin != null && reg.spec && vin - gv - reg.vout < reg.spec.dropout_max.v - 1e-9) {
        blocked.set(o, { why: `${r.ref} 입력이 모자라 출력 ${V(reg.vout)}를 보장하지 못합니다 (레귤레이터 전압 참고)`, cause: r.ref })
        continue
      }
      const v = gv + reg.vout
      volts.set(o, { v, why: `${r.ref} ${reg.name} 출력${vin == null ? ' (입력 전압을 몰라 입력이 충분하다고 가정)' : ''}`, src: 'reg' })
      const want = named.get(o)
      if (want != null && Math.abs(want - v) > 0.05) {
        issue(r.ref, `넷 이름 ${eun(o)} ${V(want)}인데 ${r.ref}(${reg.name}) 출력은 ${V(v)}입니다`, ['계산에는 레귤레이터 출력 전압을 씁니다'])
      }
    }
    if (changed) assume = false
    else if (assume) break
    else assume = true
  }

  // names for everything else, and closed switches next to them. A named net with no source of its own
  // (connector, regulator, battery) that is reached only through an open relay contact has no supply.
  const have = (m: string) => volts.has(m) || (named.has(m) && !blocked.has(m))
  for (const n of named.keys()) {
    if (volts.has(n) || blocked.has(n)) continue
    const k = hasConn(n) || regOut(n) || batteryNet(n) ? undefined : openFeed(n, m => m !== n && have(m))
    if (k) blocked.set(n, { why: `${k} 접점이 열려 있어 ${n}에 전원이 없습니다`, cause: k, open: true })
    else volts.set(n, { v: named.get(n)!, why: `넷 이름 ${n}`, src: 'name' })
  }
  for (let guard = 0; guard < 50 && carry(n => volts.get(n)); guard++) { /* until nothing changes */ }
  for (const n of volts.keys()) blocked.delete(n)
  // no supply spreads across closed switches to nets nothing else feeds; a net reached only through an open
  // relay contact has none either
  for (let changed = true, guard = 0; changed && guard < 50; guard++) {
    changed = false
    for (const sw of switches) for (const [a, z] of [[sw.a, sw.z], [sw.z, sw.a]]) {
      const bl = blocked.get(a)
      if (!bl || volts.has(z) || blocked.has(z) || ownRail(z)) continue
      blocked.set(z, { ...bl }); changed = true
    }
  }
  for (const n of b.nets()) {
    if (volts.has(n) || blocked.has(n)) continue
    const k = openFeed(n, m => volts.has(m))
    if (k) blocked.set(n, { why: `${k} 접점이 열려 있어 ${n}에 전원이 없습니다`, cause: k, open: true })
  }

  // A net a closed switch ties to GND while a resistor pulls it up is a button input: low only
  // while the button is pressed. A switched ground rail (part grounds on it) is not one.
  const groundPin = (nd: Node) => { const p = b.part(nd.ref)?.part; return p === 'Battery' || (nd.pin === 1 && (p === 'NE555' || p === 'REG')) || (nd.pin === 3 && (p === 'Q_NPN' || p === 'Q_NMOS')) }
  for (const [n, v] of volts) {
    if (!v.viaSwitch || v.v !== 0 || b.on(n).some(groundPin)) continue
    v.input = true
    for (const nd of b.on(n)) {
      const p = b.part(nd.ref), far = b.net(nd.ref, nd.pin === 1 ? 2 : 1), fv = far ? volts.get(far) : undefined
      if (p?.part === 'R' && fv && fv.v > 0.05 && fv.viaSwitch !== v.viaSwitch) { v.pulled = { ref: p.ref, v: fv.v }; break }
    }
  }
  return { volts, issues, blocked }
}

function context(c: OpCircuit, open?: ReadonlySet<string>, force = false) {
  const b = baseIndex(c, open)
  const power = analyzePower(b, force)
  const voltOf = (n: string | null): Volt | null => (n ? power.volts.get(n) ?? null : null)
  const isGnd = (n: string | null) => voltOf(n)?.v === 0
  /** why a net has no voltage when the circuit knows it cannot have a trustworthy one */
  const blockedWhy = (n: string | null) => (n ? power.blocked.get(n) ?? null : null)
  /** is a GND pin on ground: yes, no, or cannot tell (a ground-named net whose voltage is not trusted) */
  const gndState = (n: string | null): 'gnd' | 'not' | 'unknown' => {
    if (!n) return 'not'
    const v = voltOf(n)
    if (v) return v.v === 0 ? 'gnd' : 'not'
    return voltsFromName(n) === 0 || power.blocked.has(n) ? 'unknown' : 'not'
  }

  /** emitter/source to ground: 0 directly, the resistance of a small sense resistor (<= 1 Ω), or null */
  const groundPath = (n: string | null): { ohms: number; ref: string | null } | null => {
    if (!n) return null
    if (isGnd(n)) return { ohms: 0, ref: null }
    for (const nd of b.on(n)) {
      const p = b.part(nd.ref)
      if (p?.part !== 'R') continue
      const r = parseOhms(p.value)
      if (r != null && r <= 1 && isGnd(b.other(p.ref, nd.pin))) return { ohms: r, ref: p.ref }
    }
    return null
  }
  const grounded = (n: string | null) => groundPath(n) != null

  /** the 555 output on this net: its high level, or why it has none */
  const timerOut = (n: string | null): { ref: string; level: Level | null; why: string; cause?: string } | null => {
    const t = SPECS.timer.NE555
    for (const nd of b.on(n)) {
      const p = b.part(nd.ref)
      if (p?.part !== 'NE555' || nd.pin !== 3) continue
      const vccNet = b.net(p.ref, 8), vcc = voltOf(vccNet), bl = blockedWhy(vccNet)
      if (!vcc) return { ref: p.ref, level: null, why: bl ? `${p.ref} 전원: ${bl.why}` : `${p.ref} 전원 전압을 몰라 출력 전압을 계산하지 않았습니다`, cause: bl?.cause }
      if (vcc.v < t.vcc_min.v || vcc.v > t.vcc_max.v) {
        return { ref: p.ref, level: null, why: `${p.ref} 전원 ${V(vcc.v)}가 동작 범위 밖이라 출력 전압을 계산하지 않았습니다 (555 타이머 참고)`, cause: p.ref }
      }
      const d = t.voh_drop.v
      return { ref: p.ref, why: '', level: { lo: vcc.v - d, hi: vcc.v, cause: vcc.cause, why: `${p.ref} 출력 높음 ${V(vcc.v - d)}~${V(vcc.v)}: VCC ${V(vcc.v)}에서 강하 0~${V(d)} (${t.voh_drop.src})` } }
    }
    return null
  }

  /** what drives this node high: a supply or a 555 output */
  const source = (n: string | null): Level | null => {
    const v = voltOf(n)
    if (v) return { lo: v.v, hi: v.v, why: v.why, ...(v.cause ? { cause: v.cause } : {}) }
    return timerOut(n)?.level ?? null
  }
  /** why a node has no known source voltage, and the fault behind that if there is one */
  const noSource = (n: string | null): { why: string; cause?: string } | null => {
    const bl = blockedWhy(n)
    if (bl) return bl
    const tm = timerOut(n)
    return tm && !tm.level ? { why: tm.why, cause: tm.cause } : null
  }

  /** resistors with one pin on a and the other on b */
  const between = (a: string, z: string) => b.parts().filter(p => p.part === 'R' &&
    ((b.net(p.ref, 1) === a && b.net(p.ref, 2) === z) || (b.net(p.ref, 1) === z && b.net(p.ref, 2) === a)))

  return { ...b, power, voltOf, isGnd, gndState, blockedWhy, groundPath, grounded, timerOut, source, noSource, between }
}
type Ctx = ReturnType<typeof context>

const rangeV = (l: { lo: number; hi: number }) => span(l.lo, l.hi, x => V(x))

// ── LED strings ────────────────────────────────────────────────────────────────

interface LedString {
  leds: OpPart[]           // anode end first; for a group, the LEDs side by side
  k: number                // LEDs side by side sharing one resistor (1 for a series string)
  kMin: number             // the fewest of them lit at once: the ones behind a switch can be off
  rs: OpPart[]             // resistors in series with the string
  sws: OpPart[]            // closed switches in series with the string
  top: string | null       // the net feeding the anode end
  bot: string | null       // the net at the cathode end
  botNodes: Node[]         // the string's own pins on `bot`
  opposed: string | null   // an LED in the chain facing the other way
}

/** the pin across a two-pin switch or a relay's COM–NO contact taken as closed (as the power analysis does), or null */
function contactFar(x: Ctx, o: Node): number | null {
  const p = x.part(o.ref)
  if (p?.part === 'SW' && (o.pin === 1 || o.pin === 2) && x.net(p.ref, 3) == null) return o.pin === 1 ? 2 : 1
  if (p?.part === 'Relay' && (o.pin === 3 || o.pin === 4) && x.closedRelay(p.ref)) return o.pin === 3 ? 4 : 3
  return null
}

/** follow a chain of two-node nets (resistors, same-direction LEDs, closed switches) away from one LED pin */
function walkSeries(x: Ctx, ref: string, pin: number, dir: 'up' | 'down', seen: Set<string>) {
  const leds: OpPart[] = [], rs: OpPart[] = [], sws: OpPart[] = []
  let at: Node = { ref, pin }
  let n = x.net(ref, pin)
  let opposed: string | null = null
  for (let step = 0; n && step < 40; step++) {
    // a supply, GND or a driven output ends the chain even when only two pins sit on it. A button
    // input is followed up through its pull-up: the LED lights that way while the button is open
    const v = x.voltOf(n)
    const button = !!v?.pulled && dir === 'up'
    const others = x.on(n).filter(o => !(o.ref === at.ref && o.pin === at.pin) && !(button && x.part(o.ref)?.part === 'SW'))
    // a net whose voltage only came through the closed switch beside it: the chain goes on through the switch
    const carried = !!v?.viaSwitch && !button && others.length === 1 && contactFar(x, others[0]) != null
    if (!carried && ((v && !(button && others.length === 1 && others[0].ref === v.pulled!.ref)) || x.blockedWhy(n) || x.timerOut(n))) break
    if (others.length !== 1) break
    const o = others[0], p = x.part(o.ref)
    if (!p || seen.has(p.ref)) break
    if (p.part === 'R') {
      rs.push(p); seen.add(p.ref); at = { ref: p.ref, pin: o.pin === 1 ? 2 : 1 }; n = x.net(p.ref, at.pin); continue
    }
    if (p.part === 'LED') {
      if ((dir === 'up') !== (o.pin === 2)) { opposed = p.ref; break }
      leds.push(p); seen.add(p.ref); at = { ref: p.ref, pin: dir === 'up' ? 1 : 2 }; n = x.net(p.ref, at.pin); continue
    }
    const far = contactFar(x, o)
    if (far != null) {
      if (!x.net(p.ref, far)) break
      sws.push(p); seen.add(p.ref); at = { ref: p.ref, pin: far }; n = x.net(p.ref, far); continue
    }
    break
  }
  return { leds, rs, sws, end: n, at, opposed }
}

function ledStrings(x: Ctx): LedString[] {
  const all: LedString[] = []
  const taken = new Set<string>()
  /** each string by the pin it reaches its top / bottom net with */
  const ends = { top: new Map<string, LedString>(), bot: new Map<string, LedString>() }
  for (const led of x.of('LED')) {
    if (taken.has(led.ref)) continue
    const seen = new Set([led.ref])
    const up = walkSeries(x, led.ref, 1, 'up', seen), down = walkSeries(x, led.ref, 2, 'down', seen)
    const s: LedString = {
      leds: [...up.leds.reverse(), led, ...down.leds], k: 1, kMin: 1, rs: [...up.rs, ...down.rs], sws: [...up.sws, ...down.sws],
      top: up.end, bot: down.end, botNodes: [down.at], opposed: up.opposed ?? down.opposed,
    }
    s.leds.forEach(l => taken.add(l.ref))
    if (s.opposed) taken.add(s.opposed)
    all.push(s)
    ends.top.set(pinKey(up.at.ref, up.at.pin), s)
    ends.bot.set(pinKey(down.at.ref, down.at.pin), s)
  }
  // LEDs side by side that share one resistor (on the anode or the cathode side). One behind a
  // switch joins them, but can be off: then the others take its share
  const single = (s?: LedString) => !!s && s.leds.length === 1 && s.rs.length === 0 && !s.opposed
  const merged = new Set<LedString>()
  const groups: LedString[] = []
  for (const s of all) {
    if (merged.has(s) || !single(s)) continue
    for (const side of ['top', 'bot'] as const) {
      const end = side === 'top' ? s.top : s.bot, far = side === 'top' ? s.bot : s.top
      if (!end || !far) continue
      // every other pin on the shared net: one resistor, and the near ends of other single LEDs
      const others = x.on(end).filter(o => ends[side].get(pinKey(o.ref, o.pin)) !== s)
      const rNodes = others.filter(o => x.part(o.ref)?.part === 'R')
      const mates = others.filter(o => !rNodes.includes(o)).map(o => ends[side].get(pinKey(o.ref, o.pin)))
      if (rNodes.length !== 1 || !mates.length) continue
      if (!mates.every(m => single(m) && m !== s && !merged.has(m!) && (side === 'top' ? m!.bot : m!.top) === far)) continue
      const r = x.part(rNodes[0].ref)!, rFar = x.other(r.ref, rNodes[0].pin)
      const members = [s, ...mates.map(m => m!)]
      members.forEach(m => merged.add(m))
      groups.push({
        leds: members.map(m => m.leds[0]), k: members.length, kMin: Math.max(1, members.filter(m => !m.sws.length).length),
        rs: [r], sws: members.flatMap(m => m.sws),
        top: side === 'top' ? rFar : s.top, bot: side === 'bot' ? rFar : s.bot,
        botNodes: side === 'bot' ? [{ ref: r.ref, pin: rNodes[0].pin === 1 ? 2 : 1 }] : members.map(m => m.botNodes[0]),
        opposed: null,
      })
      break
    }
  }
  return [...all.filter(s => !merged.has(s)), ...groups]
}

const stringName = (s: LedString) => (s.k > 1 ? s.leds.map(l => l.ref).join('·')
  : s.leds.length > 1 ? `${s.leds.map(l => l.ref).join('·')}(직렬 ${s.leds.length}개)` : s.leds[0].ref)

function stringR(s: LedString): { ohms: number; bad: OpPart | null } {
  let ohms = 0
  for (const r of s.rs) { const v = parseOhms(r.value); if (v == null) return { ohms: NaN, bad: r }; ohms += v }
  return { ohms, bad: null }
}
const stringVf = (s: LedString, specs: LedSpec[]) => (s.k > 1 ? specs[0].vf_typ.v : specs.reduce((a, sp) => a + sp.vf_typ.v, 0))

// ── low-side switches (NPN, N-MOSFET) ──────────────────────────────────────────

const stringVfMax = (s: LedString, specs: LedSpec[]) =>
  (s.k > 1 ? Math.max(...specs.map(sp => sp.vf_max.v)) : specs.reduce((a, sp) => a + sp.vf_max.v, 0))

interface Cand { label: string; lv: Level; signal: boolean }
interface Load {
  label: string
  kind: 'res' | 'fixed' | 'clamp' | 'unknown'
  src?: Level; vf?: number; rLo?: number; rHi?: number   // res: (src − vf − drop) / r
  i?: number                                            // fixed current
  /** the supply on the far side of the load, when known (also for loads whose current is not) */
  supply?: Level
  note: string
  cause?: string
  res?: OpPart                                          // a plain resistor load
  led?: string                                          // an LED string load: its first LED
  /** an LED string: the most it may carry within its LEDs' rating */
  iCap?: number
}
interface Regime { state: OpState; drop: number | null; line: string; need?: number }
interface Switch {
  q: OpPart; kind: 'bjt' | 'mos'; ctl: string; c: string; e: string
  grounded: boolean
  /** emitter/source to ground: 0 Ω directly, or a small sense resistor */
  sense: { ohms: number; ref: string | null }
  bjt: BjtSpec | null; mos: MosSpec | null; note: string | null
  loads: Load[]
  drive: { r: OpPart; ohms: number; from: string | null } | null
  pull: { r: OpPart; ohms: number; toE: boolean } | null
  cands: Cand[]
  /** largest guaranteed on-state voltage over the signals that turn it on; null when none does */
  dropMax: number | null
  offWhy: string
  result: OpResult         // the op_drive verdict
  /** a failing verdict that comes from an LED string over its rating, not from the drive itself */
  loadCaused?: boolean
  /** a failing verdict that comes from loads whose supply has a fault (all unknown loads share it) */
  unknownCause?: string
  /** a failing verdict that comes from a drive supply put in backwards (it would pass the right way round) */
  driveCause?: string
}

const loadI = (loads: Load[], d: number) => loads.reduce((s, l) =>
  s + (l.kind === 'fixed' ? l.i! : l.kind === 'res' ? Math.max(0, (l.src!.hi - l.vf! - d) / l.rLo!) : 0), 0)
const loadsKnown = (loads: Load[]) => loads.length > 0 && loads.every(l => l.kind === 'res' || l.kind === 'fixed')

/** on-state VDS of a MOSFET with RDS(on) in series with every load (highest currents) */
function mosDrop(rds: number, loads: Load[]) {
  let a = 0, g = 0
  for (const l of loads) {
    if (l.kind === 'fixed') a += l.i!
    else if (l.kind === 'res') { a += Math.max(0, l.src!.hi - l.vf!) / l.rLo!; g += 1 / l.rLo! }
  }
  return rds * a / (1 + rds * g)
}

/** a net fed straight from something that drives it: a connector pin, a battery, a regulator output, a 555 output */
const drivenNet = (x: Ctx, n: string | null) => x.on(n).some(nd => {
  const p = x.part(nd.ref)
  return !!p && (/^Conn_/.test(p.part) || p.part === 'Battery' || (p.part === 'REG' && nd.pin === 2) || (p.part === 'NE555' && nd.pin === 3))
})

function stringLoad(x: Ctx, s: LedString): Load {
  const label = stringName(s), led = s.leds[0].ref
  const specs = s.leds.map(l => ledSpec(l.value, x.style))
  const src = x.source(s.top), R = stringR(s)
  const base = { label, led, ...(src ? { supply: src } : {}) }
  if (specs.some(sp => !sp)) return { ...base, kind: 'unknown', note: `${label} (색 자료 없음)` }
  if (s.opposed) return { ...base, kind: 'fixed', i: 0, note: `${label} (방향이 맞지 않아 전류 없음)` }
  if (R.bad) return { ...base, kind: 'unknown', note: `${label} (저항 ${R.bad.ref} 값을 읽지 못함)` }
  const iCap = Math.min(...(specs as LedSpec[]).map(sp => sp.if_max.v)) * s.kMin
  if (R.ohms === 0 && (src || drivenNet(x, s.top))) {
    return { ...base, iCap, ...(src ? { src } : {}), vf: stringVf(s, specs as LedSpec[]), kind: 'clamp', cause: led, note: `${label}에 직렬 저항이 없어 전류가 제한되지 않습니다` }
  }
  if (!src) {
    const ns = x.noSource(s.top)
    if (x.blockedWhy(s.top)?.open) return { ...base, kind: 'fixed', i: 0, note: `${label} (${ns!.cause} 접점이 열려 있어 전류 없음)` }
    return { ...base, kind: 'unknown', ...(ns?.cause ? { cause: ns.cause } : {}), note: `${label} (${s.top ? `위쪽 ${s.top} 전압 모름` : '위쪽 핀 연결 없음'})` }
  }
  return { ...base, iCap, label: `${label}+${s.rs.map(r => r.ref).join('+')}`, kind: 'res', src, vf: stringVf(s, specs as LedSpec[]), rLo: R.ohms, rHi: R.ohms, note: '' }
}

/**
 * The loads with every LED string over its rating given the smallest resistor that keeps it within
 * the rating: what a correctly sized LED would draw, still falling with the switch's voltage.
 */
const capLeds = (loads: Load[]): Load[] => loads.map(l => {
  if (!l.led || l.iCap == null || (l.kind !== 'res' && l.kind !== 'clamp')) return l
  if (l.kind === 'res' && loadI([l], 0) <= l.iCap) return l
  const src = l.src ?? l.supply, vf = l.vf ?? 0
  if (!src) return { ...l, kind: 'fixed' as const, i: l.iCap }
  const r = Math.max(l.rLo ?? 0, (src.hi - vf) / l.iCap)
  return { ...l, kind: 'res' as const, src, vf, rLo: r, rHi: Math.max(l.rHi ?? r, r) }
})
/** the LED string load that is over its rating and failed its own check: the one a switch's trouble follows */
const overLed = (loads: Load[], ledFailed: (ref: string) => boolean) =>
  loads.find(l => l.led && ledFailed(l.led) && l.iCap != null && (l.kind === 'clamp' || (l.kind === 'res' && loadI([l], 0) > l.iCap)))?.led
    ?? loads.find(l => l.led && ledFailed(l.led))?.led

/** what hangs on a collector/drain, as currents the switch has to carry */
function loadsOn(x: Ctx, c: string, self: string, strings: Map<string, LedString>): Load[] {
  const loads: Load[] = []
  const counted = new Set<LedString>()
  for (const nd of x.on(c)) {
    if (nd.ref === self) continue
    const p = x.part(nd.ref)
    if (!p) continue
    const s = strings.get(pinKey(nd.ref, nd.pin))
    if (s) { if (!counted.has(s)) { counted.add(s); loads.push(stringLoad(x, s)) } continue }
    if (p.part === 'C' || p.part === 'CP' || p.part === 'LED') continue     // decoupling; an LED anode here points the wrong way (LED rule)
    if (p.part === 'D') {
      if (nd.pin === 1) continue        // anode on the switch: the flyback diode, reverse biased while the switch conducts
      const a = x.net(p.ref, 1), lv = x.source(a)
      // a diode across a coil or motor, put in backwards
      const across = x.parts().filter(k => k.part === 'Relay' || isMotor(k))
        .find(k => [x.net(k.ref, 1), x.net(k.ref, 2)].includes(a) && [x.net(k.ref, 1), x.net(k.ref, 2)].includes(c))
      if (lv && lv.hi > 0) {
        loads.push({ label: p.ref, kind: 'clamp', supply: lv, cause: across?.ref,
          note: `${p.ref} 다이오드가 ${a}(${V(lv.hi)})에서 이쪽으로 순방향이라, 켜지면 전원이 다이오드를 지나 바로 흐릅니다 (전류가 베이스·게이트 구동으로만 제한됨)` })
      } else loads.push({ label: p.ref, kind: 'unknown', note: `${p.ref} (${p.value || 'D'})` })
      continue
    }
    if (p.part === 'Relay' && (nd.pin === 1 || nd.pin === 2)) {
      const other = x.other(p.ref, nd.pin), src = x.source(other), r = relaySpec(p.value)
      if (src && r) {
        const rc = r.spec.r_coil.v
        loads.push({ label: `${p.ref} 코일`, kind: 'res', src, supply: src, vf: 0, rLo: rc * (1 - r.spec.r_tol), rHi: rc * (1 + r.spec.r_tol), note: '' })
      } else if (!src && x.blockedWhy(other)?.open) {
        loads.push({ label: `${p.ref} 코일`, kind: 'fixed', i: 0, note: `${p.ref} 코일 (${x.blockedWhy(other)!.cause} 접점이 열려 있어 전류 없음)` })
      } else {
        // no coil data: the relay's own result says so; a supply with a fault behind it follows that fault
        const ns = src ? null : x.noSource(other)
        const cause = !r ? p.ref : ns?.cause
        loads.push({ label: `${p.ref} 코일`, kind: 'unknown', ...(src ? { supply: src } : {}), ...(cause ? { cause } : {}),
          note: !r ? `${p.ref} 코일 (정격 자료 없음: ${p.value || '값 없음'})` : !other ? `${p.ref} 코일 (전원 쪽 핀 연결 없음)` : `${p.ref} 코일 (전원 ${other} 전압 모름${ns ? `: ${ns.why}` : ''})` })
      }
      continue
    }
    if (p.part === 'R') {
      const other = x.other(p.ref, nd.pin), src = x.source(other), r = parseOhms(p.value)
      const sup = src ? { supply: src } : {}
      if (src && r != null && r > 0) loads.push({ label: p.ref, kind: 'res', src, ...sup, vf: 0, rLo: r, rHi: r, note: '', res: p })
      else if (src && src.hi > 0 && r === 0) loads.push({ label: p.ref, kind: 'clamp', ...sup, note: `${p.ref}(0 Ω)을 지나 ${other}에 바로 연결되어 전류가 제한되지 않습니다` })
      else if (!src && x.blockedWhy(other)?.open) loads.push({ label: p.ref, kind: 'fixed', i: 0, note: `${p.ref} (${x.blockedWhy(other)!.cause} 접점이 열려 있어 전류 없음)` })
      else { const ns = src ? null : x.noSource(other); loads.push({ label: p.ref, kind: 'unknown', ...sup, ...(ns?.cause ? { cause: ns.cause } : {}), note: `${p.ref} (${p.value || '값 없음'})` }) }
      continue
    }
    if (isMotor(p)) {
      const i = parseAmps(p.value), sup = x.source(x.net(p.ref, nd.pin === 1 ? 2 : 1))
      const extra = sup ? { supply: sup } : {}
      if (i != null) loads.push({ label: `${p.ref} 모터`, kind: 'fixed', i, ...extra, note: `${p.ref} 값 ${p.value}에 적힌 전류` })
      else loads.push({ label: `${p.ref} 모터`, kind: 'unknown', ...extra, note: `${p.ref} (${p.value}): 값에 모터 전류를 적으면 판단합니다 (예: MOTOR 0.3A)` })
      continue
    }
    loads.push({ label: p.ref, kind: 'unknown', note: `${p.ref} (${p.value || p.part})` })
  }
  return loads
}

const signalCands = (): Cand[] => SIGNAL_CANDIDATES.map(v => ({ label: V(v), lv: { lo: v, hi: v, why: `신호 전압 모름 → ${V(v)} 가정` }, signal: true }))

/** what drives the base/gate: a supply, a 555 output, a resistor from a signal, or nothing */
function controlOf(x: Ctx, q: OpPart, kind: 'bjt' | 'mos', ctl: string, e: string) {
  const word = kind === 'bjt' ? '베이스' : '게이트'
  const out = {
    drive: null as Switch['drive'], pull: null as Switch['pull'], cands: [] as Cand[], fromSignal: false, note: null as string | null,
    problem: null as null | { state: OpState; summary: string; detail: string[]; cause?: string },
  }
  const attached = () => `${word} 넷 ${ctl}에 연결된 것: ${x.on(ctl).filter(n => n.ref !== q.ref).map(n => `${n.ref}.${n.pin}`).join(', ') || '없음'}`
  const fail = (state: OpState, summary: string, detail: string[] = [], cause?: string) => {
    out.problem = { state, summary, detail: [...detail, attached()], ...(cause ? { cause } : {}) }
    return out
  }
  if (ctl === e) return fail('error', `${q.ref} ${word}가 ${kind === 'bjt' ? '이미터' : '소스'}와 같은 넷(${ctl})에 있어 켜지지 않습니다`, [`${word}와 ${kind === 'bjt' ? '이미터' : '소스'} 사이에 전압이 생기지 않습니다`])
  // a button that pulls the base/gate to GND turns it off while pressed; worked out with the button open
  const button = x.voltOf(ctl)?.pulled ? x.voltOf(ctl) : null
  if (button) out.note = `${x.whileClosed(button.viaSwitch!)} ${word}가 GND로 내려가 꺼집니다. 아래는 ${ga(x.contactNoun(button.viaSwitch!))} 열렸을 때입니다`
  if (x.isGnd(ctl) && !button) return fail('error', `${q.ref} ${word}가 GND에 묶여 있어 켜지지 않습니다`, [`${ctl}: ${x.voltOf(ctl)!.why}`])
  const direct = button ? null : x.source(ctl)
  if (direct) {
    if (kind === 'bjt') return fail('error', `${q.ref} 베이스에 저항 없이 ${rangeV(direct)}가 바로 걸립니다: 베이스 전류가 제한되지 않습니다`, [direct.why])
    out.cands = [{ label: rangeV(direct), lv: direct, signal: false }]
    return out
  }
  const tm = x.timerOut(ctl)
  if (tm) {
    if (kind === 'bjt') return fail('error', `${q.ref} 베이스에 저항 없이 ${tm.ref} 출력이 바로 연결되어 베이스 전류가 제한되지 않습니다`, [tm.why || `${tm.ref} 3번 핀(OUT)`])
    return fail('unknown', `${q.ref} 게이트: ${tm.why}`, [], tm.cause)
  }
  const bl = x.blockedWhy(ctl)
  if (bl) return fail('unknown', `${q.ref} ${word}: ${bl.why}`, [], bl.cause)
  const drives: NonNullable<Switch['drive']>[] = [], pulls: NonNullable<Switch['pull']>[] = []
  let external = false
  for (const nd of x.on(ctl)) {
    if (nd.ref === q.ref) continue
    const p = x.part(nd.ref)
    if (!p) continue
    if (p.part === 'R') {
      const from = x.other(p.ref, nd.pin), ohms = parseOhms(p.value)
      if (ohms == null) return fail('unknown', `${q.ref} ${word} 저항 ${p.ref} 값 ${eul(val(p.value))} 읽지 못했습니다`)
      const fb = x.voltOf(from)
      if (fb?.pulled) {
        return fail('unknown', `${q.ref} ${word} 저항 ${p.ref} 반대쪽 ${eun(from!)} ${ga(x.contact(fb.viaSwitch!))} 닫히면 GND, 열리면 ${ro(fb.pulled.ref)} 올라가는 ${x.contactNoun(fb.viaSwitch!) === '접점' ? '릴레이 접점' : '버튼'} 입력이라 켜짐을 계산하지 않았습니다`,
          [`${wa(p.ref)} ${ga(fb.pulled.ref)} 이어진 구동은 계산하지 않습니다`])
      }
      if (x.isGnd(from) || from === e) pulls.push({ r: p, ohms, toE: from === e })
      else drives.push({ r: p, ohms, from })
    } else if (isExternal(p)) external = true
  }
  if (pulls.length > 1 || drives.length > 1) return fail('unknown', `${q.ref} ${word}에 저항이 여러 개 연결되어 계산하지 않았습니다`)
  out.pull = pulls[0] ?? null
  if (out.pull?.ohms === 0) return fail('error', `${q.ref} ${word} 저항 ${ga(out.pull.r.ref)} 0 Ω이라 ${word}가 GND에 묶여 켜지지 않습니다`)
  const d = drives[0]
  if (d) {
    out.drive = d
    if (d.ohms === 0 && kind === 'bjt') return fail('error', `${q.ref} 베이스 저항 ${ga(d.r.ref)} 0 Ω이라 베이스 전류가 제한되지 않습니다`)
    const lv = x.source(d.from)
    if (lv) { out.cands = [{ label: rangeV(lv), lv, signal: false }]; return out }
    const ns = x.noSource(d.from)
    if (ns) return fail('unknown', `${q.ref} ${word}를 구동하는 쪽: ${ns.why}`, [], ns.cause)
    const far = x.on(d.from).filter(n => n.ref !== d.r.ref)
    if (!d.from || !far.length) {
      return fail('error', `${q.ref} ${word} 저항 ${d.r.ref}의 반대쪽이 아무 데도 연결되지 않아 켜지지 않습니다`, [`${d.from ?? '(연결 없음)'}에는 ${d.r.ref} 하나뿐입니다`])
    }
    if (far.some(n => { const p = x.part(n.ref); return !!p && isExternal(p) })) { out.fromSignal = true; out.cands = signalCands(); return out }
    return fail('unknown', `${q.ref} ${word} 저항 ${d.r.ref} 반대쪽 ${d.from}의 전압을 알 수 없습니다`)
  }
  if (external) {
    if (kind === 'bjt') return fail('error', `${q.ref} 베이스에 저항 없이 외부 신호가 바로 연결되어 베이스 전류가 제한되지 않습니다`)
    out.fromSignal = true; out.cands = signalCands(); return out
  }
  if (out.pull) return fail('error', `${q.ref} ${word}에 ${out.pull.r.ref}(GND 쪽)만 연결되어 있어 켜지지 않습니다`)
  if (x.on(ctl).length <= 1) return fail('error', `${q.ref} ${word}에 아무것도 연결되지 않아 켜지지 않습니다`)
  return fail('unknown', `${q.ref} ${word}를 구동하는 경로를 찾지 못했습니다`)
}

/**
 * How far a BJT with this base current is guaranteed to turn on, given the load current at
 * each collector voltage (`at`). Saturation is only guaranteed at the VCE(sat) rows' IC/IB;
 * otherwise the minimum gain row gives VCE <= its test voltage; otherwise nothing.
 */
function bjtRegime(spec: BjtSpec, ib: number, at: (d: number) => number): Regime {
  if (ib <= 0) return { state: 'error', drop: null, line: '베이스 전류가 흐르지 않습니다' }
  for (const row of [...spec.vce_sat].sort((a, b) => a.ic - b.ic)) {
    const ic = at(row.v), need = ic * row.ib / row.ic
    if (ic <= row.ic * (1 + EPS) && atLeast(ib, need)) {
      return { state: 'pass', drop: row.v, need, line: `IC ${mA(ic)} ≤ ${mA(row.ic)}이고 IB ≥ ${mA(need)}라 포화, VCE ≤ ${V(row.v)} (${row.src})` }
    }
  }
  const rows = [...spec.hfe_min].sort((a, b) => a.ic - b.ic)
  const vce = Math.max(...rows.map(r => r.vce))
  if (vce > 1) {
    return { state: 'unknown', drop: null, line: `포화 조건을 만족하지 않고, 최소 증폭률은 VCE ${V(vce)} 조건이라 스위치로 켜짐을 보장하지 못합니다 (${rows[0].src})` }
  }
  const ic = at(vce), h = hfeAt(spec, ic)
  if (!h) {
    return { state: 'unknown', drop: null, line: `IC ${mA(ic)}는 최소 증폭률 표의 범위(${mA(rows[0].ic)}~${mA(rows[rows.length - 1].ic)}) 밖이라 보장값이 없습니다` }
  }
  const need = ic / h.hfe
  if (atLeast(ib, need)) {
    return { state: 'pass', drop: h.vce, need, line: `IC ${mA(ic)}(VCE ${V(h.vce)}일 때) ÷ hFE 최소 ${h.hfe} = 필요 IB ${mA(need)} → VCE ≤ ${V(h.vce)}, 포화는 보장되지 않음 (${h.src})` }
  }
  return { state: 'error', drop: null, need, line: `필요 IB ${mA(need)} = IC ${mA(ic)} ÷ hFE 최소 ${h.hfe} (${h.src})` }
}

function analyzeSwitches(x: Ctx, strings: LedString[]): Switch[] {
  const atBottom = new Map<string, LedString>()
  for (const s of strings) for (const n of s.botNodes) atBottom.set(pinKey(n.ref, n.pin), s)
  const out: Switch[] = []
  for (const q of [...x.of('Q_NPN'), ...x.of('Q_NMOS')]) {
    const kind = q.part === 'Q_NPN' ? 'bjt' as const : 'mos' as const
    const ctl = x.net(q.ref, 1), c = x.net(q.ref, 2), e = x.net(q.ref, 3)
    if (!ctl || !c || !e) continue
    const bjt = kind === 'bjt' ? bjtSpec(q.value, x.style) : null
    const mos = kind === 'mos' ? mosSpec(q.value, x.style) : null
    const note = (bjt ?? mos)!.note
    const notes = note ? [note] : []
    const gp = x.groundPath(e)
    const sw: Switch = {
      q, kind, ctl, c, e, grounded: gp != null, sense: gp ?? { ohms: 0, ref: null }, bjt: bjt?.spec ?? null, mos: mos?.spec ?? null, note,
      loads: [], drive: null, pull: null, cands: [], dropMax: null, offWhy: '',
      result: { rule: 'op_drive', ref: q.ref, state: 'unknown', summary: '', detail: [] },
    }
    out.push(sw)
    const verdict = (state: OpState, summary: string, detail: string[] = [], cause?: string) => {
      sw.result = { rule: 'op_drive', ref: q.ref, state, summary, detail: [...notes, ...detail], ...(cause ? { cause } : {}) }
    }
    if (!sw.grounded) {
      const why = x.blockedWhy(e)
      verdict('unknown', `${q.ref}: ${kind === 'bjt' ? '이미터' : '소스'}가 GND가 아닌 구성은 판단하지 않습니다`,
        [`${kind === 'bjt' ? '이미터' : '소스'} 넷 ${e}: ${x.voltOf(e)?.why ?? why?.why ?? '전압이 정해지지 않습니다'}`], why?.cause)
      sw.offWhy = sw.result.summary
      continue
    }
    sw.loads = loadsOn(x, c, q.ref, atBottom)
    const ctlInfo = controlOf(x, q, kind, ctl, e)
    if (ctlInfo.note) notes.push(ctlInfo.note)
    sw.drive = ctlInfo.drive; sw.pull = ctlInfo.pull; sw.cands = ctlInfo.cands
    if (ctlInfo.problem) {
      verdict(ctlInfo.problem.state, ctlInfo.problem.summary, ctlInfo.problem.detail, ctlInfo.problem.cause)
      sw.offWhy = ctlInfo.problem.summary
      continue
    }
    const known = loadsKnown(sw.loads)
    const clamp = sw.loads.find(l => l.kind === 'clamp')
    const senseLine = (v: number, basis: string) => (sw.sense.ref ? [`${kind === 'bjt' ? '이미터' : '소스'} 감지 저항 ${sw.sense.ref} ${ohm(sw.sense.ohms)} × ${basis} = ${V(v)}만큼 구동 전압이 줄어듭니다`] : [])

    if (kind === 'bjt') {
      const spec = sw.bjt!, vbe = spec.vbe_sat.v
      // an LED string with no series resistor draws whatever the transistor lets through; the drive is
      // judged as if that LED had its rated current (the LED rule reports the missing resistor)
      const ledClamp = !!clamp && clamp.iCap != null
      const loadsJ = ledClamp ? capLeds(sw.loads) : sw.loads
      const knownJ = loadsKnown(loadsJ)
      const ibWith = (ls: Load[]) => {
        const vE = sw.sense.ohms * (loadsKnown(ls) ? loadI(ls, 0) : 0)
        return { vE, ib: (lo: number) => (lo - vbe - vE) / sw.drive!.ohms - (sw.pull ? (vbe + (sw.pull.toE ? 0 : vE)) / sw.pull.ohms : 0) }
      }
      const { vE, ib: ibAt } = ibWith(loadsJ)
      const ib = (cd: Cand) => ibAt(cd.lv.lo)
      const iTop = knownJ ? loadI(loadsJ, 0) : 0
      const head = [
        `IB = (구동 전압 − VBE ${V(vbe)}${vE ? ` − 감지 저항 ${V(vE)}` : ''}) ÷ ${sw.drive!.r.ref} ${ohm(sw.drive!.ohms)}${sw.pull ? ` − VBE ÷ ${sw.pull.r.ref} ${ohm(sw.pull.ohms)}` : ''} · VBE: ${cite(spec.vbe_sat)}`,
        ...sw.cands.filter(cd => !cd.signal).map(cd => `구동 전압: ${cd.lv.why}`),
        ...(knownJ ? senseLine(vE, `부하 ${mA(iTop)}`) : []),
        ...(ledClamp ? [`${clamp!.label}에 직렬 저항이 없어 실제 전류는 제한되지 않습니다. 아래는 그 LED에 정격 ${mA(clamp!.iCap!)}만 흐른다고 보고 계산했습니다`] : []),
      ]
      if (clamp && !ledClamp) { verdict('unknown', `${q.ref} 부하가 단락되어 켜짐을 계산하지 않았습니다 (스위치 전류 한계 참고)`, head, clamp.cause ?? q.ref); sw.offWhy = sw.result.summary; continue }
      if (!knownJ) {
        const lines = sw.cands.map(cd => `${cd.label}: IB ${mA(Math.max(0, ib(cd)))}`)
        verdict('unknown', `${q.ref} 부하 전류를 몰라 켜짐을 판단할 수 없습니다`, [...head, ...lines, `부하: ${sw.loads.map(l => l.note || l.label).join(', ') || '없음'}`])
        sw.offWhy = `${q.ref} 부하 전류를 몰라 켜짐을 판단할 수 없습니다`
        // unknown because every load whose current is missing has a supply fault behind it: follow that fault
        const unk = loadsJ.filter(l => l.kind === 'unknown')
        if (unk.length && unk.every(l => l.cause)) sw.unknownCause = unk[0].cause
        continue
      }
      const per = sw.cands.map(cd => ({ cd, ib: ib(cd), rg: bjtRegime(spec, ib(cd), d => loadI(loadsJ, d)) }))
      const lines = per.map(p => `${p.cd.label}: IB ${mA(Math.max(0, p.ib))} → ${p.rg.line}`)
      const ok = per.filter(p => p.rg.state === 'pass')
      const drops = ok.map(p => p.rg.drop!)
      sw.dropMax = drops.length ? Math.max(...drops) : null
      if (ok.length === per.length) {
        verdict('pass', `${q.ref} 충분히 켜짐 (${per.map(p => `${p.cd.label} IB ${mA(p.ib)}`).join(' / ')} → VCE ≤ ${V(sw.dropMax!)})`, [...head, ...lines])
      } else if (ok.length) {
        verdict('warn', `${q.ref}: ${ok.map(p => p.cd.label).join(', ')} 신호에서만 충분히 켜집니다`, [...head, ...lines])
      } else if (per.every(p => p.rg.state === 'error')) {
        const best = per.reduce((a, p) => (p.ib > a.ib ? p : a))
        if (best.ib <= 0) {
          verdict('error', `${q.ref} 베이스 전류가 흐르지 않습니다: 구동 ${best.cd.label}가 VBE ${V(vbe)}${vE ? '와 감지 저항 전압의 합' : ''}보다 높지 않습니다`, [...head, ...lines])
        } else {
          const [a, b] = two(best.ib, best.rg.need ?? 0, mA)
          verdict('error', `${q.ref} 베이스 전류 부족: IB ${a} < 필요 ${b}`, [...head, ...lines])
        }
      } else {
        verdict('unknown', `${q.ref} 켜짐을 보장할 수 없습니다: ${per.find(p => p.rg.state === 'unknown')!.rg.line}`, [...head, ...lines])
      }
      sw.offWhy = sw.dropMax == null ? `${ga(q.ref)} 켜지는지 보장되지 않아 계산하지 않았습니다 (트랜지스터 켜짐 참고)` : ''
      if (ledClamp) {
        // the real current is unlimited, so nothing is guaranteed; a drive that falls short even for a
        // correctly limited LED stays its own fault
        sw.dropMax = null
        if (sw.result.state === 'pass' || sw.result.state === 'warn') {
          verdict('unknown', `${q.ref} 부하 LED에 직렬 저항이 없어 켜짐을 계산하지 않았습니다 (LED가 정격 전류라면 ${sw.result.state === 'pass' ? '충분히 켜짐' : '일부 신호에서만 켜짐'})`, [...head, ...lines], clamp!.cause)
        }
        sw.offWhy = `${q.ref} 부하 LED에 직렬 저항이 없어 켜졌을 때의 전압을 보장할 수 없습니다`
        continue
      }
      if (ok.length < per.length) {
        // short of drive only because an LED string draws more than its rating? Then the LED is the fault;
        // short even with correctly sized LEDs: the drive's own fault, said as such
        const capped = capLeds(loadsJ)
        if (capped.some((l, i) => l !== loadsJ[i]) && loadsKnown(capped)) {
          const c2 = ibWith(capped)
          const rc = sw.cands.map(cd => ({ cd, ib: c2.ib(cd.lv.lo), rg: bjtRegime(spec, c2.ib(cd.lv.lo), d => loadI(capped, d)) }))
          if (rc.every(p => p.rg.state === 'pass')) sw.loadCaused = true
          else if (sw.result.state === 'unknown' && rc.every(p => p.rg.state === 'error')) {
            const best = rc.reduce((a, p) => (p.ib > a.ib ? p : a))
            const [a, b] = two(Math.max(0, best.ib), best.rg.need ?? 0, mA)
            verdict('error', `${q.ref} 베이스 전류 부족: LED를 정격 전류로 줄여도 IB ${a} < 필요 ${b}`,
              [...head, ...lines, ...rc.map(p => `LED를 정격 전류로 줄였을 때 ${p.cd.label}: IB ${mA(Math.max(0, p.ib))} → ${p.rg.line}`)])
          }
        }
        // a drive from a supply put in backwards: its fault, if the drive would do the right way round
        const rev = sw.cands.find(cd => cd.lv.cause)?.lv.cause
        if (rev && sw.cands.every(cd => bjtRegime(spec, ibAt(Math.abs(cd.lv.lo)), d => loadI(loadsJ, d)).state === 'pass')) sw.driveCause = rev
      }
      continue
    }

    // N-MOSFET
    const spec = sw.mos!
    const th = spec.vgs_th_max.v, rated = spec.vgs_rated.v
    const div = sw.pull && sw.drive ? sw.pull.ohms / (sw.drive.ohms + sw.pull.ohms) : 1
    // the source rises by the sense resistor's drop; with an unknown load, at most the part's rated current flows
    const iS = known ? loadI(sw.loads, 0) : spec.id_max.v
    const vS = sw.sense.ohms * iS
    // gate voltages written so that 4.995 V never reads as the 5 V it falls short of
    const vg = (l: { lo: number; hi: number }) => span(l.lo, l.hi, v => two(v, rated, V)[0])
    const why = [div < 1 ? `${sw.drive!.r.ref}/${sw.pull!.r.ref} 분압` : '', vS > 0 ? `감지 저항 ${sw.sense.ref}` : ''].filter(Boolean).join('·')
    const per = sw.cands.map(cd => {
      const vgs = { lo: cd.lv.lo * div - vS, hi: cd.lv.hi * div }
      // shown with the sense drop taken off both ends; the top end without it is only for the maximum rating
      const shown = { lo: vgs.lo, hi: Math.max(vgs.lo, cd.lv.hi * div - vS) }
      const over = atLeast(vgs.hi, spec.vgs_max.v)
      const state: OpState = over ? 'error' : atLeast(vgs.lo, rated) ? 'pass' : atLeast(vgs.lo, th) ? 'warn' : 'error'
      const word = over ? `최대 정격 ${V(spec.vgs_max.v)} 이상` : state === 'pass' ? '완전히 켜짐'
        : state === 'warn' ? '문턱은 넘지만 켜짐 저항 보장 전압 미만' : '켜지지 않을 수 있음'
      const lossy = why !== '' && atLeast(cd.lv.lo, rated) && !atLeast(vgs.lo, rated)
      return { cd, vgs, shown, state, lossy, over, line: `${cd.label}: VGS ${vg(shown)}${why ? ` (${why})` : ''} → ${word}` }
    })
    const lines = [
      `게이트 문턱 최대 ${V(th)}: ${cite(spec.vgs_th_max)}`,
      `켜짐 저항 보장: VGS ${V(rated)}에서 RDS(on) 최대 ${ohm(spec.rds_on.v)} (${cite(spec.rds_on)})`,
      `게이트 최대 ${V(spec.vgs_max.v)}: ${cite(spec.vgs_max)}`,
      ...sw.cands.filter(cd => !cd.signal).map(cd => `구동 전압: ${cd.lv.why}`),
      ...senseLine(vS, known ? `부하 ${mA(iS)}` : `ID 최대 ${mA(iS)}(부하 전류를 몰라 정격으로 계산)`),
      ...per.map(p => p.line),
    ]
    const over = per.find(p => p.over)
    const passing = per.filter(p => p.state === 'pass')
    if (passing.length && known) {
      const d = mosDrop(spec.rds_on.v, sw.loads)
      sw.dropMax = d
      lines.push(`켜졌을 때 VDS ≤ RDS(on) ${ohm(spec.rds_on.v)} × 부하 전류 = ${V(d)}`)
    }
    const vgsList = per.map(p => vg(p.shown)).join(' / ')
    let state: OpState, summary: string
    if (over) {
      const [a, b] = two(over.vgs.hi, spec.vgs_max.v, V)
      state = 'error'; summary = `${q.ref} 게이트 ${a} ≥ 최대 ${b}: 게이트가 파괴될 수 있습니다`
    } else if (passing.length === per.length) { state = 'pass'; summary = `${q.ref} 완전히 켜짐 (VGS ${vgsList} ≥ ${V(rated)})` }
    else if (passing.length) {
      state = 'warn'
      summary = `${q.ref}: ${passing.map(p => p.cd.label).join(', ')} 신호에서만 완전히 켜집니다 (${per.filter(p => p.state !== 'pass').map(p => `${p.cd.label} → VGS ${vg(p.shown)}`).join(', ')})`
    } else if (per.every(p => p.state === 'error')) {
      state = 'error'; summary = `${q.ref} 게이트 ${per.map(p => span(p.shown.lo, p.shown.hi, v => two(v, th, V)[0])).join(' / ')} < 문턱 최대 ${V(th)}: 켜지지 않을 수 있습니다`
    } else {
      state = 'warn'
      summary = `${q.ref} 게이트 ${vgsList}: 문턱은 넘지만 켜짐 저항 보장 전압 ${V(rated)} 미만이라 발열·전압 강하가 생길 수 있습니다`
      const lossy = per.filter(p => p.lossy)
      if (lossy.length) summary += ` · ${lossy.map(p => p.cd.label).join(', ')} 신호는 ${ro(why)} ${lossy.map(p => vg(p.shown)).join(', ')}`
    }
    if (!sw.pull && ctlInfo.fromSignal && state === 'pass') {
      state = 'warn'
      summary += ' · 풀다운 저항 없음'
      lines.push('게이트 풀다운이 없으면 입력이 끊겼을 때 게이트가 떠서 저절로 켜질 수 있습니다')
    }
    verdict(state, summary, lines)
    if (state !== 'pass') {
      const vgsOk = (lo: number, vs: number) => atLeast(lo * div - vs, rated) && !atLeast(lo * div, spec.vgs_max.v)
      // the source lifted by an LED over its rating: with correctly sized LEDs the gate would do
      const capped = capLeds(sw.loads)
      if (vS > 0 && known && capped.some((l, i) => l !== sw.loads[i]) && sw.cands.every(cd => vgsOk(cd.lv.lo, sw.sense.ohms * loadI(capped, 0)))) sw.loadCaused = true
      const rev = sw.cands.find(cd => cd.lv.cause)?.lv.cause
      if (rev && sw.cands.every(cd => vgsOk(Math.abs(cd.lv.lo), vS))) sw.driveCause = rev
    }
    sw.offWhy = sw.dropMax != null ? ''
      : clamp ? `${q.ref} 부하가 단락되어 계산하지 않았습니다`
        : !known && passing.length ? `${q.ref} 부하 전류를 몰라 켜졌을 때의 전압 강하를 계산하지 않았습니다`
          : `${q.ref} 게이트 전압이 켜짐 저항 보장 전압 ${V(rated)}보다 낮아 켜졌을 때의 전압 강하를 보장할 수 없습니다 (트랜지스터 켜짐 참고)`
  }
  return out
}

// ── rules ──────────────────────────────────────────────────────────────────────

/** `fromSwitch`: the cause is a switch that may not turn on, which can only lower a current */
interface Sink { lo: number; hi: number | null; why: string; cause?: string; fromSwitch?: boolean }
interface Heat { p: number; why: string; cause?: string }

function checkLeds(x: Ctx, strings: LedString[], sinkOf: (n: string | null) => Sink | null, heat: (r: OpPart, h: Heat) => void): OpResult[] {
  const out: OpResult[] = []
  // a chain broken by an LED facing the other way: one result for that LED
  const opposedBy = new Map<string, LedString[]>()
  for (const s of strings) if (s.opposed) opposedBy.set(s.opposed, [...(opposedBy.get(s.opposed) || []), s])
  for (const [bad, ss] of opposedBy) {
    const names = ss.map(stringName)
    const detail = ['직렬로 이어진 LED는 모두 같은 방향(애노드 → 캐소드)이어야 전류가 흐릅니다',
      `${bad}: 애노드 ${x.net(bad, 1) ?? '(연결 없음)'}, 캐소드 ${x.net(bad, 2) ?? '(연결 없음)'}`]
    if (ss.length > 1) out.push({ rule: 'op_led', ref: bad, state: 'error', summary: `${ga(bad)} 앞뒤 LED(${names.join(', ')})와 반대 방향으로 연결되어 전류가 흐르지 않습니다`, detail })
    else out.push({ rule: 'op_led', ref: ss[0].leds[0].ref, state: 'error', summary: `${wa(names[0])} ${ga(bad)} 서로 반대 방향으로 직렬 연결되어 전류가 흐르지 않습니다`, detail })
  }
  for (const s of strings) {
    if (s.opposed || !s.top || !s.bot) continue          // an unconnected pin: the connection checks report it
    const head = s.leds[0], name = stringName(s)
    const swNames = s.sws.map(p => x.contact(p.ref)).join('·')
    const closed = !s.sws.length ? []
      : s.k > 1 ? [`${ga(swNames)} 열리면 그 LED가 꺼지고 나머지가 ${s.rs[0].ref} 전류를 나눠 받습니다: 가장 큰 전류는 LED ${s.kMin}개만 켜졌을 때, 가장 작은 전류는 ${s.k}개 모두 켜졌을 때로 계산합니다`]
        : [`${eun(swNames)} 닫힌 것으로 계산합니다 (열리면 ${ga(name)} 꺼짐)`]
    const res = (state: OpState, summary: string, detail: string[], cause?: string) =>
      out.push({ rule: 'op_led', ref: head.ref, state, summary, detail: [...detail, ...closed], ...(cause && state !== 'pass' ? { cause } : {}) })
    const specs = s.leds.map(l => ledSpec(l.value, x.style))
    const miss = s.leds.find((_, i) => !specs[i])
    if (miss) {
      res('unknown', `${miss.ref} (${miss.value || '색 없음'}): 이 색의 순방향 전압 자료가 없습니다`, ['순방향 전압과 최대 전류는 빨강 LED(Kingbright)만 자료가 있습니다'])
      continue
    }
    const top = x.source(s.top)
    const bot = sinkOf(s.bot)
    // a switch that may not turn on only lowers the current, so it is never the cause of these verdicts
    const cause = top?.cause ?? (bot?.fromSwitch ? undefined : bot?.cause)
    // reversed: the anode side sits lower than the cathode side
    if (top && bot && top.hi < bot.lo - 0.05) {
      res('error', `${name} 방향이 거꾸로입니다 (애노드 쪽 ${rangeV(top)}, 캐소드 쪽 ${V(bot.lo)})`, [`애노드 쪽: ${top.why}`, `캐소드 쪽: ${bot.why}`], cause)
      continue
    }
    const topSink = top ? null : sinkOf(s.top), botSrc = x.source(s.bot)
    if (!top && topSink && botSrc && botSrc.lo > (topSink.hi ?? 0) + 0.05) {
      res('error', `${name} 방향이 거꾸로입니다 (애노드 쪽은 스위치로 내려가는 ${s.top}, 캐소드 쪽은 ${rangeV(botSrc)})`,
        [`애노드 쪽: ${topSink.why}`, `캐소드 쪽: ${botSrc.why}`], botSrc.cause)
      continue
    }
    const R = stringR(s)
    if (R.bad) { res('unknown', `${name}: 저항 ${R.bad.ref} 값 ${eul(val(R.bad.value))} 읽지 못했습니다`, [`단위가 있는 값이어야 합니다 (예: 680, 4.7k)`]); continue }
    if (R.ohms === 0) {
      // nothing limits the current, whatever the supply voltage turns out to be
      if (top || drivenNet(x, s.top)) {
        res('error', `${name}에 직렬 저항이 없어 전류가 제한되지 않습니다`,
          [top ? `${rangeV(top)}가 저항 없이 LED에 걸립니다 (${top.why})` : `${s.top}에서 LED까지 전류를 제한하는 저항이 없습니다 (전원 전압과 상관없음)`], cause)
      } else res('unknown', `${name}의 전류 경로를 찾지 못했습니다`, [`위쪽 ${s.top}, 아래쪽 ${s.bot}의 전압이 정해지지 않습니다`])
      continue
    }
    const vf = stringVf(s, specs as LedSpec[]), vfMax = stringVfMax(s, specs as LedSpec[])
    const ifMax = Math.min(...(specs as LedSpec[]).map(sp => sp.if_max.v))
    const spec = specs[0]!
    if (!bot) {
      const ns = x.noSource(s.bot)
      res('unknown', `${name}의 캐소드 쪽(${s.bot}) 전압을 알 수 없습니다${ns ? `: ${ns.why}` : ''}`, [`아래쪽 ${s.bot}에 전원·GND·트랜지스터 스위치가 없습니다`], ns?.cause)
      continue
    }
    if (!top) {
      const ns = x.noSource(s.top)
      if (ns) { res('unknown', `${name}: ${ns.why}`, [`위쪽 넷 ${s.top}`], ns.cause); continue }
      const cands = SIGNAL_CANDIDATES.map(v => `${V(v)}면 ${mA(Math.max(0, (v - bot.lo - vf) / R.ohms / s.kMin))}`)
      res('unknown', `${name}: 걸리는 전압을 몰라 판단할 수 없습니다 (${cands.join(', ')})`,
        [`넷 ${s.top}의 전압이 이름·배터리·레귤레이터로 정해지지 않습니다`], bot.fromSwitch ? undefined : bot.cause)
      continue
    }
    const rText = s.rs.map(r => `${r.ref} ${ohm(parseOhms(r.value)!)}`).join(' + ')
    const many = s.leds.length > 1 && s.k === 1 ? ` × ${s.leds.length}개` : ''
    const iHi = (top.hi - bot.lo - vf) / R.ohms
    // "does it light" uses the largest forward voltage the datasheet allows
    const iLo = bot.hi == null ? null : (top.lo - bot.hi - vfMax) / R.ohms
    // the most per LED with the fewest lit (switched ones open), the least with all of them lit
    const perHi = iHi / s.kMin, perLo = iLo == null ? null : iLo / s.k
    const share = span(Math.max(0, iHi / s.k), Math.max(0, perHi), a => mA(a))
    const detail = [
      `가장 큰 전류 I = (${V(top.hi)} − ${V(bot.lo)} − Vf ${V(vf)}) ÷ ${ohm(R.ohms)} = ${mA(Math.max(0, iHi))}`,
      ...(iLo != null ? [`가장 작은 전류 I = (${V(top.lo)} − ${V(bot.hi!)} − Vf 최대 ${V(vfMax)}) ÷ ${ohm(R.ohms)} = ${mA(Math.max(0, iLo))}`] : []),
      ...(s.k > 1 ? [`LED ${s.k}개가 ${s.rs[0].ref} 하나를 나눠 써 LED당 평균 ${share}입니다. LED마다 Vf가 달라 한쪽으로 몰릴 수 있습니다`] : []),
      `위쪽: ${top.why}`, `아래쪽: ${bot.why}`,
      `Vf 일반 ${V(spec.vf_typ.v)}${many}: ${cite(spec.vf_typ)} (최소값은 자료에 없어 가장 큰 전류에도 일반값 사용)`,
      `Vf 최대 ${V(spec.vf_max.v)}${many}: ${cite(spec.vf_max)}`,
      `최대 연속 전류 ${mA(ifMax)}: ${cite(spec.if_max)}`,
    ]
    let state: OpState, summary: string
    if (iHi <= 0) { state = 'error'; summary = `${name} 켜지지 않음: 걸리는 전압 ${V(top.hi - bot.lo)}가 순방향 전압 ${V(vf)}보다 낮습니다` }
    else if (atLeast(perHi, ifMax)) {
      const [a, b] = two(perHi, ifMax, mA)
      state = 'error'; summary = `${name} 전류 ${a} ≥ 최대 ${b} (${rText})`
    } else if (perLo != null && perLo <= 0) {
      state = 'warn'; summary = `${ga(name)} 켜지지 않을 수 있습니다: 가장 낮은 경우 걸리는 전압 ${V(top.lo - bot.hi!)}가 순방향 전압 최대 ${V(vfMax)}보다 낮습니다`
    } else if (atLeast(perHi, NEAR * ifMax)) {
      state = 'warn'; summary = `${name} 전류 최대 ${two(perHi, ifMax, mA)[0]}로 한계 ${mA(ifMax)}에 가깝습니다 (${rText})`
    } else if (s.k > 1) {
      state = 'warn'; summary = `${ga(name)} ${s.rs[0].ref} 하나를 나눠 씁니다: 합계 ${mA(iHi)}, LED당 평균 ${share} (전류가 고르지 않을 수 있음)`
    } else if (perLo != null && perLo < 0.001) {
      state = 'warn'; summary = `${name} 전류가 가장 작은 경우 ${mA(perLo)}로 너무 어둡습니다 (${rText})`
    } else if (perLo == null && (top.lo - bot.lo - vfMax) / R.ohms / s.k < 0.001) {
      // the switch's drop is not known, but even with none the LED would be too dim or dark
      const best = (top.lo - bot.lo - vfMax) / R.ohms / s.k
      state = 'warn'; summary = best <= 0 ? `${ga(name)} 켜지지 않을 수 있습니다: 스위치 강하가 없어도 걸리는 전압 ${V(top.lo - bot.lo)}가 순방향 전압 최대 ${V(vfMax)}보다 낮습니다`
        : `${name} 전류가 스위치 강하 없이도 ${mA(best)}로 너무 어둡습니다 (${rText})`
    } else {
      state = 'pass'
      summary = `${name} ${span(Math.max(0, perLo ?? perHi), perHi, a => mA(a))} (최대 ${mA(ifMax)}, ${rText})${perLo == null ? ' · 켜지는지는 트랜지스터 켜짐 참고' : ''}`
    }
    res(state, summary, detail, cause)
    for (const r of s.rs) {
      const ohms = parseOhms(r.value)!
      // the LED is the cause when a different resistor value alone fixes both: at the dimmest current still
      // counted as lit (1 mA per LED) the LED is within its rating and the resistor within its own
      const lit = Math.max(0, top.hi - bot.lo - vf) * 0.001 * s.kMin * (ohms / R.ohms)
      const ledCause = state === 'error' && lit < resPower(x.style).p_max.v
      if (ohms > 0 && iHi > 0) heat(r, { p: iHi * iHi * ohms, why: `${name} 전류 ${mA(iHi)}로 P = I² × R`, cause: ledCause ? head.ref : cause })
    }
  }
  return out
}

/** relay coils and motor connectors, with which side is the supply and which the switch */
function inductiveLoads(x: Ctx) {
  const loads: { ref: string; kind: '릴레이 코일' | '모터'; n1: string; n2: string; amps: number | null; coilR: number | null }[] = []
  for (const k of x.of('Relay')) {
    const n1 = x.net(k.ref, 1), n2 = x.net(k.ref, 2), r = relaySpec(k.value)
    if (n1 && n2) loads.push({ ref: k.ref, kind: '릴레이 코일', n1, n2, amps: null, coilR: r ? r.spec.r_coil.v * (1 - r.spec.r_tol) : null })
  }
  for (const p of x.parts().filter(isMotor)) {
    const n1 = x.net(p.ref, 1), n2 = x.net(p.ref, 2)
    if (n1 && n2) loads.push({ ref: p.ref, kind: '모터', n1, n2, amps: parseAmps(p.value), coilR: null })
  }
  return loads
}

function checkFlyback(x: Ctx, switchAt: (n: string | null) => Switch | null): OpResult[] {
  const out: OpResult[] = []
  for (const l of inductiveLoads(x)) {
    const res = (state: OpState, summary: string, detail: string[], cause?: string) =>
      out.push({ rule: 'op_flyback', ref: l.ref, state, summary, detail, ...(cause && state !== 'pass' ? { cause } : {}) })
    if (l.n1 === l.n2) continue
    const v1 = x.voltOf(l.n1), v2 = x.voltOf(l.n2)
    let high: string, low: string
    // a 555 output against a fixed rail drives the coil: it feeds it from GND, and sinks it from a rail above GND
    const t1 = x.timerOut(l.n1), t2 = x.timerOut(l.n2)
    const timer = t1?.level && v2 && !v1 ? { out: l.n1, rail: l.n2, v: v2, ref: t1.ref } : t2?.level && v1 && !v2 ? { out: l.n2, rail: l.n1, v: v1, ref: t2.ref } : null
    /** a mechanical switch on the supply side: it cuts the high end, and the low end stays put */
    let highSide = false
    if (v1 && v2) {
      // fixed voltages on both ends: only a mechanical switch in the loop turns it off. The
      // current flows from the higher end, whichever side the switch is on
      if (v1.viaSwitch === v2.viaSwitch || Math.abs(v1.v - v2.v) <= 0.05) continue
      const first = v1.v > v2.v
      high = first ? l.n1 : l.n2; low = first ? l.n2 : l.n1
      highSide = !!(first ? v1 : v2).viaSwitch && !(first ? v2 : v1).viaSwitch
    } else if (timer) {
      if (timer.v.v > 0) { high = timer.rail; low = timer.out } else { high = timer.out; low = timer.rail }
    } else if (v1 && v1.v > 0) { high = l.n1; low = l.n2 }
    else if (v2 && v2.v > 0) { high = l.n2; low = l.n1 }
    else if (switchAt(l.n2)) { high = l.n1; low = l.n2 }
    else if (switchAt(l.n1)) { high = l.n2; low = l.n1 }
    else {
      const ns = x.noSource(l.n1) ?? x.noSource(l.n2)
      res('unknown', `${l.ref} ${l.kind}의 어느 쪽이 전원인지 알 수 없습니다${ns ? `: ${ns.why}` : ''}`, [`${l.n1}, ${l.n2} 모두 전압이 정해지지 않고 트랜지스터 스위치도 없습니다`], ns?.cause)
      continue
    }
    const transistor = switchAt(low)
    const ds = x.of('D')
    const good = ds.find(d => x.net(d.ref, 1) === low && x.net(d.ref, 2) === high)
    const bad = ds.find(d => x.net(d.ref, 1) === high && x.net(d.ref, 2) === low)
    // a diode from the switched end to a net past the far end also clamps the switch (around a series resistor and the coil)
    const lowV = x.voltOf(low)?.v ?? 0
    const wide = good ? undefined : highSide
      ? ds.find(d => x.net(d.ref, 2) === high && (x.voltOf(x.net(d.ref, 1))?.v ?? Infinity) <= lowV + 0.05)
      : ds.find(d => x.net(d.ref, 1) === low && (x.voltOf(x.net(d.ref, 2))?.v ?? 0) > 0)
    const swNet = highSide ? high : low
    const mech = v1?.viaSwitch !== v2?.viaSwitch ? v1?.viaSwitch ?? v2?.viaSwitch : undefined
    const mechName = mech ? `${mech} ${x.contactNoun(mech)}` : ''
    if (bad) {
      res('error', `${bad.ref} 방향이 거꾸로입니다: 스위치가 켜지면 전원이 이 다이오드를 지나 바로 GND로 흐릅니다`,
        [`${l.ref} 양단 ${high}(전원 쪽) · ${low}, 스위치 쪽 ${swNet}, ${bad.ref} 캐소드가 ${low}에 있음 → 캐소드는 ${high} 쪽이어야 합니다`])
      continue
    }
    const guard = good ?? wide
    if (!guard) {
      if (transistor) {
        res('error', `${l.ref} ${l.kind} 양단에 보호 다이오드가 없습니다: 스위치가 꺼질 때 역전압이 ${eul(transistor.q.ref)} 망가뜨릴 수 있습니다`,
          [`${wa(high)} ${low} 사이에 캐소드를 ${high} 쪽으로 한 다이오드가 필요합니다`])
      } else {
        res('warn', `${l.ref} ${l.kind} 양단에 보호 다이오드가 없습니다: 스위치 쪽이 트랜지스터는 아니지만 끊길 때 역전압으로 접점에 불꽃이 생기거나 구동하는 쪽이 상할 수 있습니다`,
          [`스위치 쪽 넷 ${swNet}${mech ? ` (${mechName})` : ''}`, `${wa(high)} ${low} 사이에 캐소드를 ${high} 쪽으로 한 다이오드를 권합니다`])
      }
      continue
    }
    const gnet = x.net(guard.ref, 2)!, anode = x.net(guard.ref, 1)!
    const d = SPECS.diode[guard.value.toUpperCase().replace(/\s+/g, '')] as (typeof SPECS.diode)[string] | undefined
    const vs = x.voltOf(gnet)
    const detail = [`${guard.ref} 캐소드 ${gnet}${vs ? `(${V(vs.v)})` : ''} · 애노드 ${anode}: 스위치가 꺼질 때 코일 전류를 돌려보냅니다`,
      ...(wide ? [`${l.ref} 바로 양단이 아니라 ${anode}–${gnet} 사이 경로 전체를 감쌉니다`] : [])]
    if (!d) { res('pass', `${guard.ref} 방향 맞음 (캐소드 ${gnet} 쪽) · ${guard.value || '값 없음'}의 정격 자료가 없어 전압·전류는 보지 않았습니다`, detail); continue }
    detail.push(`역전압 정격 ${V(d.vrrm.v)}: ${cite(d.vrrm)}`)
    // the diode carries the load current for a moment when the switch opens
    const vh = x.voltOf(high)?.v ?? vs?.v
    const iLoad = l.amps ?? (vh && l.coilR ? vh / l.coilR : null)
    if (iLoad != null) detail.push(`꺼지는 순간 흐르는 전류 최대 ${mA(iLoad)}, 연속 정격 ${mA(d.if_max.v)}: ${cite(d.if_max)}`)
    if (vs && atLeast(vs.v, d.vrrm.v)) {
      const [a, b] = two(d.vrrm.v, vs.v, V)
      res('error', `${guard.ref} 역전압 정격 ${a} ≤ 전원 ${b}`, detail)
    } else if (iLoad != null && atLeast(iLoad, d.if_max.v)) {
      const [a, b] = two(iLoad, d.if_max.v, mA)
      res('error', `${guard.ref} 전류 ${a} ≥ 정격 ${b}`, detail)
    } else if (vs && atLeast(vs.v, NEAR * d.vrrm.v)) res('warn', `${guard.ref} 전원 ${V(vs.v)}가 역전압 정격 ${V(d.vrrm.v)}에 가깝습니다`, detail)
    else res('pass', `${guard.ref} 방향 맞음 (캐소드 ${gnet} 쪽)`, vs ? detail : [...detail, `${gnet} 전압을 몰라 역전압 정격은 비교하지 않았습니다`])
  }
  return out
}

function checkRelays(x: Ctx, sinkOf: (n: string | null) => Sink | null, pulled: Set<string>, noPull: Map<string, string | undefined>,
  flybackFailed: (ref: string) => boolean): OpResult[] {
  const out: OpResult[] = []
  for (const k of x.of('Relay')) {
    const res = (state: OpState, summary: string, detail: string[], cause?: string) =>
      out.push({ rule: 'op_relay', ref: k.ref, state, summary, detail, ...(cause && state !== 'pass' ? { cause } : {}) })
    const n1 = x.net(k.ref, 1), n2 = x.net(k.ref, 2)
    if (!n1 || !n2) continue
    if (n1 === n2) {
      res('error', `${k.ref} 코일 양쪽이 같은 넷 ${ira(n1)} 코일에 전압이 걸리지 않습니다`, [`코일 1번·2번 핀이 모두 ${n1}에 있습니다`])
      noPull.set(k.ref, undefined)
      continue
    }
    const r = relaySpec(k.value)
    if (!r) {
      res('unknown', `${k.ref} (${k.value || '값 없음'}): 코일 정격 전압을 읽지 못했습니다`, ['값이 5V, 12V 같은 전압이나 Sanyou SRD 부품 번호(SRD-05VDC-…)여야 합니다. 다른 부품 번호는 코일 수치를 알 수 없습니다'])
      continue
    }
    // the supply side: the higher known end; a 0 V end means the other end feeds the coil
    const s1 = x.source(n1), s2 = x.source(n2)
    let high: string | null = null, low: string | null = null
    const f1 = x.voltOf(n1), f2 = x.voltOf(n2)
    // a fixed rail against a 555 output: the output drives the coil from GND, and sinks it from any rail above GND
    if (s1 && s2 && !f1 !== !f2) {
      const fixed = f1 ? n1 : n2, out = f1 ? n2 : n1
      if ((f1 ?? f2)!.v > 0) { high = fixed; low = out } else { high = out; low = fixed }
    } else if (s1 && s2) { if (s1.hi >= s2.hi) { high = n1; low = n2 } else { high = n2; low = n1 } }
    else if (s1 && s1.hi > 0) { high = n1; low = n2 }
    else if (s2 && s2.hi > 0) { high = n2; low = n1 }
    else if (s1) { low = n1; high = n2 }
    else if (s2) { low = n2; high = n1 }
    if (!high || !low) {
      const ns = x.noSource(n1) ?? x.noSource(n2)
      res('unknown', `${k.ref} 코일에 걸리는 전압을 알 수 없습니다 (${n1}, ${n2})${ns ? `: ${ns.why}` : ''}`, [`코일 양쪽 ${n1}, ${n2}의 전압이 정해지지 않습니다`], ns?.cause)
      continue
    }
    const { rated, spec } = r
    const pick = spec.pickup_pct.v / 100 * rated
    // a coil end below 0 V from a battery put in backwards: that fault, not the wiring of the coil
    const rev = [s1, s2].find(sx => sx && sx.hi < 0 && sx.cause)
    if (rev) {
      res('error', `${k.ref} 코일 전원 쪽이 ${V(rev.hi)}라 붙지 않습니다`, [rev.why, '거꾸로 된 전원에서 이어진 결과입니다'], rev.cause)
      noPull.set(k.ref, rev.cause)
      continue
    }
    // one end on 0 V and the other pulled down by a transistor: nothing feeds the coil at all
    const zero = x.voltOf(low)?.v === 0 ? low : null
    if (zero && !x.source(high) && !x.voltOf(high) && sinkOf(high)) {
      res('error', `${k.ref} 코일에 전원 쪽이 없습니다: ${eun(zero)} GND이고 ${eun(high)} 트랜지스터가 내리는 쪽입니다`,
        [`코일 1번 핀 ${n1}, 2번 핀 ${n2}`, '코일 한쪽은 전원에, 다른 쪽은 트랜지스터 컬렉터(드레인)에 연결해야 합니다'])
      continue
    }
    const clamp = x.of('D').find(d => x.net(d.ref, 1) === high && x.net(d.ref, 2) === low)
    if (clamp) {
      // the same backwards diode is the flyback check's error; counted there when that check sees it
      out.push({ rule: 'op_relay', ref: k.ref, state: 'error', ...(flybackFailed(k.ref) ? { cause: k.ref, causeRule: 'op_flyback' as OpRule } : {}),
        summary: `${k.ref} 코일이 ${clamp.ref}(거꾸로 단 다이오드)로 묶여 순방향 전압 정도만 걸리므로 붙지 않습니다`,
        detail: [`${clamp.ref} 애노드 ${high}, 캐소드 ${low}: 스위치가 켜지면 다이오드가 코일과 나란히 켜집니다`,
          `순방향 전압 약 ${V(SPECS.diode['1N4148'].vf_max.v)} (${cite(SPECS.diode['1N4148'].vf_max)}) < 동작 전압 ${V(pick)}`] })
      continue
    }
    const vs = x.source(high)
    if (!vs) {
      const ns = x.noSource(high)
      res('unknown', `${k.ref} 코일 전원 쪽(${high}) 전압을 알 수 없습니다${ns ? `: ${ns.why}` : ''}`, [`코일 반대쪽 ${low}`], ns?.cause)
      continue
    }
    const sink = sinkOf(low)
    if (!sink) { res('unknown', `${k.ref} 코일의 스위치 쪽(${low}) 전압을 알 수 없습니다`, [`전원 쪽: ${vs.why}`]); continue }
    const vHi = vs.hi - sink.lo, vLo = sink.hi == null ? null : vs.lo - sink.hi
    const rc = spec.r_coil.v
    const detail = [
      `코일 전압 = 전원 ${rangeV(vs)} − 스위치 쪽 ${sink.hi == null ? V(sink.lo) : rangeV({ lo: sink.lo, hi: sink.hi })} = ${vLo == null ? `최대 ${V(vHi)}` : rangeV({ lo: vLo, hi: vHi })}`,
      `전원: ${vs.why}`, `스위치 쪽: ${sink.why}`,
      `동작 전압 정격의 ${spec.pickup_pct.v}% = ${V(pick)}: ${cite(spec.pickup_pct)}`,
      `코일 저항 ${ohm(rc)} ±${spec.r_tol * 100}%: ${cite(spec.r_coil)}`,
      ...(r.srd ? [] : [`값 ${k.value}에 부품 번호가 없어 Sanyou SRD ${V(rated)} 코일 수치로 계산`]),
    ]
    const max = spec.max_pct ? spec.max_pct.v / 100 * rated : null
    const cause = vs.cause ?? sink.cause
    if (vLo != null && vLo >= pick - 1e-9) pulled.add(k.ref)
    // why it does not pull in: the switch that does not turn on, or the supply's fault
    else noPull.set(k.ref, vLo == null ? sink.cause : cause)
    if (max != null && vHi > max + 1e-9) {
      const [a, b] = two(vHi, max, V)
      res('error', `${k.ref} 코일 최대 ${a} > 허용 ${b}: 코일 과전압`, [...detail, cite(spec.max_pct!)], vs.cause)
    } else if (vLo == null) res('unknown', `${k.ref} 코일 전압을 보장할 수 없습니다: ${sink.why}`, detail, sink.cause)
    else if (vLo < pick - 1e-9) {
      const [a, b] = two(vLo, pick, V)
      res('error', `${k.ref} 코일 ${a} < 동작 전압 ${b}: 릴레이가 붙지 않습니다`, detail, cause)
    } else res('pass', `${k.ref} 코일 ${rangeV({ lo: vLo, hi: vHi })} (정격 ${V(rated)}, 동작 최소 ${V(pick)})`, detail)
  }
  return out
}

function checkSwitchLimits(switches: Switch[], ledFailed: (ref: string) => boolean): OpResult[] {
  const out: OpResult[] = []
  for (const sw of switches) {
    if (!sw.grounded || !sw.loads.length) continue
    const res = (state: OpState, summary: string, detail: string[], cause?: string) =>
      out.push({ rule: 'op_switch', ref: sw.q.ref, state, summary, detail, ...(cause ? { cause } : {}) })
    const lim = sw.bjt ? sw.bjt.ic_max : sw.mos!.id_max
    const notes = sw.note ? [sw.note] : []
    // the collector/drain must stand the supply once the switch turns off, whatever the load current
    const supplies = sw.loads.filter(l => l.supply).map(l => l.supply!.hi)
    const vmax = supplies.length ? Math.max(...supplies) : 0
    const vlim = sw.bjt ? sw.bjt.vceo : sw.mos!.vds_max
    if (atLeast(vmax, vlim.v)) {
      const [a, b] = two(vmax, vlim.v, V)
      res('error', `${sw.q.ref} 전원 ${a} ≥ ${sw.bjt ? 'VCEO' : 'VDSS'} ${b}: 꺼졌을 때 ${sw.bjt ? '컬렉터' : '드레인'} 전압을 견디지 못합니다`,
        [...notes, `부하 쪽 전원 최대 ${V(vmax)}`, cite(vlim)])
      continue
    }
    const clamp = sw.loads.find(l => l.kind === 'clamp')
    if (clamp) {
      // a bare LED: its fault, unless the switch is overloaded even with that LED at its rated current
      const capped = capLeds(sw.loads)
      const over = clamp.iCap != null && loadsKnown(capped) && atLeast(loadI(capped, 0), lim.v)
      if (over) {
        const [a, b] = two(loadI(capped, 0), lim.v, mA)
        res('error', `${sw.q.ref} 부하 ${a} ≥ 최대 ${b} (직렬 저항 없는 LED를 정격 전류로 줄여도)`, [...notes, clamp.note, `${sw.bjt ? 'IC' : 'ID'} 최대: ${cite(lim)}`])
      } else res('error', `${sw.q.ref}: ${clamp.note}`, [...notes, `${sw.bjt ? 'IC' : 'ID'} 최대 ${mA(lim.v)}: ${cite(lim)}`], clamp.cause)
      continue
    }
    const unknown = sw.loads.filter(l => l.kind === 'unknown')
    if (unknown.length) {
      res('unknown', `${sw.q.ref} 부하 전류를 알 수 없습니다 (${unknown.map(l => l.note).join(', ')}). 최대 ${mA(lim.v)} 이하여야 합니다`,
        [...notes, `${sw.bjt ? 'IC' : 'ID'} 최대 ${mA(lim.v)}: ${cite(lim)}`], unknown.every(l => l.cause) ? unknown[0].cause : undefined)
      continue
    }
    const i = loadI(sw.loads, 0)
    if (i <= 0) continue
    const lines = [
      ...notes,
      ...sw.loads.map(l => l.kind === 'fixed' ? `${l.label} ${mA(l.i!)} (${l.note})`
        : `${l.label} 최대 ${mA(loadI([l], 0))} = (${V(l.src!.hi)}${l.vf ? ` − Vf ${V(l.vf)}` : ''}) ÷ ${ohm(l.rLo!)}`),
      `스위치 전압 강하는 0으로 둔 가장 큰 경우 · ${sw.bjt ? 'IC' : 'ID'} 최대: ${cite(lim)}`,
    ]
    // an LED string without enough resistance is the LED rule's fault; the switch overload follows from it
    const ledCause = loadI(capLeds(sw.loads), 0) < NEAR * lim.v ? overLed(sw.loads, ledFailed) : undefined
    if (atLeast(i, lim.v)) {
      const [a, b] = two(i, lim.v, mA)
      res('error', `${sw.q.ref} 부하 ${a} ≥ 최대 ${b}`, lines, ledCause)
    } else if (atLeast(i, NEAR * lim.v)) res('warn', `${sw.q.ref} 부하 최대 ${two(i, lim.v, mA)[0]}로 한계 ${mA(lim.v)}에 가깝습니다`, lines, ledCause)
    else res('pass', `${sw.q.ref} 부하 최대 ${mA(i)} (최대 ${mA(lim.v)})`, lines)
  }
  return out
}

/** resistor heating wherever the current through it is known */
function checkResistorPower(x: Ctx, switches: Switch[], heats: Map<string, { r: OpPart; h: Heat }>): OpResult[] {
  const add = (r: OpPart, h: Heat) => { const cur = heats.get(r.ref); if (!cur || h.p > cur.h.p) heats.set(r.ref, { r, h }) }
  for (const sw of switches) {
    if (!sw.grounded) continue
    for (const l of sw.loads) if (l.res && l.kind === 'res') add(l.res, { p: l.src!.hi ** 2 / l.rLo!, why: `${ga(sw.q.ref)} 켜졌을 때 ${V(l.src!.hi)}가 모두 걸린다고 보면 P = V² ÷ R` })
    const top = Math.max(0, ...sw.cands.map(cd => cd.lv.hi))
    const assumed = sw.cands.some(cd => cd.signal) ? '(신호 전압을 몰라 가정한 값 중 큰 쪽)' : ''
    if (sw.drive && top > 0 && sw.drive.ohms > 0) {
      if (sw.kind === 'bjt') add(sw.drive.r, { p: top ** 2 / sw.drive.ohms, why: `구동 ${V(top)}${assumed}, VBE를 0으로 둔 가장 큰 경우 P = V² ÷ R` })
      else if (sw.pull) {
        const i = top / (sw.drive.ohms + sw.pull.ohms)
        add(sw.drive.r, { p: i * i * sw.drive.ohms, why: `구동 ${V(top)}${assumed}가 ${sw.drive.r.ref}+${sw.pull.r.ref}에 걸려 ${mA(i)}` })
        add(sw.pull.r, { p: i * i * sw.pull.ohms, why: `구동 ${V(top)}${assumed}가 ${sw.drive.r.ref}+${sw.pull.r.ref}에 걸려 ${mA(i)}` })
      }
    }
  }
  // between two fixed voltages
  for (const r of x.of('R')) {
    const a = x.voltOf(x.net(r.ref, 1)), b = x.voltOf(x.net(r.ref, 2)), ohms = parseOhms(r.value)
    if (a && b && ohms != null && ohms > 0 && Math.abs(a.v - b.v) > 0) {
      add(r, { p: (a.v - b.v) ** 2 / ohms, why: `양 끝 ${V(a.v)}, ${V(b.v)} 사이 P = V² ÷ R`, cause: a.cause ?? b.cause })
    }
  }
  // 555 timing resistors: RA sees VCC while DISCH is low, RB at most 2/3 VCC
  for (const u of x.of('NE555')) {
    const vcc = x.voltOf(x.net(u.ref, 8)), vccNet = x.net(u.ref, 8), dis = x.net(u.ref, 7), thr = x.net(u.ref, 6)
    if (!vcc || !dis) continue
    if (vccNet) for (const r of x.between(vccNet, dis)) {
      const o = parseOhms(r.value)
      if (o) add(r, { p: vcc.v ** 2 / o, why: `${u.ref} 방전 중 DISCH가 낮아 VCC ${V(vcc.v)}가 모두 걸림` })
    }
    if (thr) for (const r of x.between(dis, thr)) {
      const o = parseOhms(r.value)
      if (o) add(r, { p: (vcc.v * 2 / 3) ** 2 / o, why: `${u.ref} 방전 중 커패시터 전압 최대 VCC의 2/3` })
    }
  }
  const pr = resPower(x.style)
  const out: OpResult[] = []
  for (const { r, h } of heats.values()) {
    const [a, b] = two(h.p, pr.p_max.v, W)
    const detail = [h.why, `정격 ${W(pr.p_max.v)}: ${cite(pr.p_max)}${x.style ? '' : ' (PCB 전이라 정격이 작은 SMD 기준)'}`]
    const res = (state: OpState, summary: string) => out.push({ rule: 'op_rpower', ref: r.ref, state, summary, detail, ...(h.cause && state !== 'pass' ? { cause: h.cause } : {}) })
    if (atLeast(h.p, pr.p_max.v)) res('error', `${r.ref} 발열 ${a} ≥ 정격 ${b}`)
    else if (atLeast(h.p, NEAR * pr.p_max.v)) res('warn', `${r.ref} 발열 ${a}로 정격 ${b}에 가깝습니다`)
    else res('pass', `${r.ref} 발열 최대 ${W(h.p)} (정격 ${W(pr.p_max.v)})`)
  }
  return out
}

function checkShorts(x: Ctx): OpResult[] {
  const out: OpResult[] = []
  const pair = (ref: string, a: string | null, b: string | null, when: (w: string) => string) => {
    const va = x.voltOf(a), vb = x.voltOf(b)
    if (!a || !b || !va || !vb || a === b || Math.abs(va.v - vb.v) <= 0.05) return
    out.push({ rule: 'op_short', ref, state: 'error', key: [a, b].sort().join('|'), summary: `${when(ref)} ${a}(${V(va.v)})와 ${b}(${V(vb.v)})가 바로 연결되어 전원이 단락됩니다`,
      detail: [`${a}: ${va.why}`, `${b}: ${vb.why}`] })
  }
  for (const s of x.of('SW')) pair(s.ref, x.net(s.ref, 1), x.net(s.ref, 2), w => `${eul(w)} 누르면`)
  for (const k of x.of('Relay')) {
    if (x.closedRelay(k.ref)) pair(k.ref, x.net(k.ref, 3), x.net(k.ref, 4), w => `${ga(w)} 붙으면 COM과 NO로`)
    if (!x.closedRelay(k.ref)) pair(k.ref, x.net(k.ref, 5), x.net(k.ref, 3), w => `${ga(w)} 떨어져 있으면 COM과 NC로`)
  }
  return out
}

/** electrolytic capacitors: + must sit at or above − */
function checkCaps(x: Ctx, reversed: Set<string>): OpResult[] {
  const out: OpResult[] = []
  const level = (n: string | null): Level | null => {
    const v = x.voltOf(n)
    if (v) return { lo: v.v, hi: v.v, why: v.why, ...(v.cause ? { cause: v.cause } : {}) }
    for (const nd of x.on(n)) {
      const p = x.part(nd.ref)
      if (p?.part !== 'NE555' || (nd.pin !== 2 && nd.pin !== 6)) continue
      const vcc = x.voltOf(x.net(p.ref, 8))
      if (vcc) return { lo: vcc.v / 3, hi: vcc.v * 2 / 3, why: `${p.ref} 타이밍 전압: VCC ${V(vcc.v)}의 1/3~2/3` }
    }
    return null
  }
  for (const cp of x.of('CP')) {
    const p = x.net(cp.ref, 1), m = x.net(cp.ref, 2)
    if (!p || !m || p === m) continue
    const lp = level(p), lm = level(m)
    if (!lp || !lm) continue
    const detail = [`+ 단자 ${p}: ${lp.why}`, `− 단자 ${m}: ${lm.why}`, 'CP 템플릿은 1번 핀이 +, 2번 핀이 −입니다']
    if (lp.hi < lm.lo - 0.05) {
      reversed.add(cp.ref)
      const cause = lp.cause ?? lm.cause
      out.push({ rule: 'op_cap', ref: cp.ref, state: 'error', ...(cause ? { cause } : {}), summary: `${cp.ref} 극성이 거꾸로입니다: + 단자 ${p}(${rangeV(lp)}), − 단자 ${m}(${rangeV(lm)})`,
        detail: [...detail, '전해 커패시터에 역전압이 걸리면 손상되거나 터질 수 있습니다'] })
    } else if (lp.lo >= lm.hi - 0.05) {
      out.push({ rule: 'op_cap', ref: cp.ref, state: 'pass', summary: `${cp.ref} 방향 맞음 (+ ${p} ${rangeV(lp)}, − ${m} ${rangeV(lm)})`, detail })
    }
  }
  return out
}

/** parallel resistance */
const par = (rs: number[]) => (rs.some(r => r === 0) ? 0 : 1 / rs.reduce((s, r) => s + 1 / r, 0))

function check555(x: Ctx, reversedCaps: Set<string>): OpResult[] {
  const out: OpResult[] = []
  const t = SPECS.timer.NE555
  for (const u of x.of('NE555')) {
    const n = (p: number) => x.net(u.ref, p)
    const errors: string[] = [], warns: string[] = [], unknowns: string[] = []
    const detail: string[] = [`핀 넷: 1 GND ${n(1) ?? '-'}, 4 RESET ${n(4) ?? '-'}, 5 CTRL ${n(5) ?? '-'}, 7 DISCH ${n(7) ?? '-'}, 8 VCC ${n(8) ?? '-'}`]
    const vccNet = n(8), vcc = x.voltOf(vccNet)
    const gs = x.gndState(n(1))
    if (gs === 'not') errors.push(n(1) ? `1번 핀(GND)이 GND가 아닌 ${n(1)}에 연결되어 있습니다` : '1번 핀(GND)이 연결되지 않았습니다')
    else if (gs === 'unknown') unknowns.push(`1번 핀(GND) 넷 ${n(1)}의 전압을 알 수 없습니다${x.blockedWhy(n(1)) ? `: ${x.blockedWhy(n(1))!.why}` : ''}`)
    if (vcc) {
      detail.push(`VCC ${V(vcc.v)} (${vcc.why}), 동작 범위 ${V(t.vcc_min.v)}~${V(t.vcc_max.v)}: ${cite(t.vcc_min)}`)
      if (vcc.v < t.vcc_min.v || vcc.v > t.vcc_max.v) errors.push(`전원 ${V(vcc.v)}가 동작 범위 ${V(t.vcc_min.v)}~${V(t.vcc_max.v)} 밖입니다`)
    }
    // RESET (4) has to sit high
    const rst = n(4)
    const tiedTo = rst ? ([[2, 'TRIG'], [3, 'OUT'], [6, 'THRES'], [7, 'DISCH']] as const).filter(([p]) => n(p) === rst).map(([, w]) => w) : []
    const viaR = (m: string, test: (other: string | null) => boolean) => x.on(m).some(nd => {
      const p = x.part(nd.ref)
      return p?.part === 'R' && test(x.other(p.ref, nd.pin))
    })
    const pulledUp = (m: string) => viaR(m, o => o === vccNet || (x.voltOf(o)?.v ?? 0) > 0)
    const pulledDown = (m: string) => viaR(m, o => x.isGnd(o))
    const driven = (m: string) => x.on(m).some(nd => { const p = x.part(nd.ref); return !!p && p.ref !== u.ref && isExternal(p) })
    const rv = x.voltOf(rst)
    if (tiedTo.length) errors.push(`4번 핀(RESET)이 ${tiedTo.join('·')} 핀과 묶여 있어 그 핀이 낮아지는 순간 멈춥니다 (VCC에 연결)`)
    else if (rst && x.isGnd(rst) && !rv?.input) errors.push('4번 핀(RESET)이 GND에 묶여 있어 동작하지 않습니다')
    else if (rst && (rst === vccNet || pulledUp(rst) || driven(rst))) {
      // held high; a reset button stops it only while pressed
      if (rv?.pulled) detail.push(`4번 핀(RESET)은 ${x.whileClosed(rv.viaSwitch!)} GND로 내려가 멈추고, 평소에는 ${ro(rv.pulled.ref)} 높게 유지됩니다`)
    }
    else if (rst && rv && rv.v > 0) {
      if (rv.viaSwitch && rv.viaSwitch !== vcc?.viaSwitch) {
        const what = x.contactNoun(rv.viaSwitch)
        warns.push(`4번 핀(RESET)은 ${rv.viaSwitch} ${ga(what)} 닫혀야 높아져, ${ga(what)} 열리면 멈춥니다`)
      }
    } else if (rst && pulledDown(rst)) warns.push('4번 핀(RESET)이 GND 쪽 저항으로 낮게 잡혀 있어 평소에는 멈춰 있습니다 (VCC에 연결)')
    else if (rv?.input) {
      // a reset button with nothing holding the pin high once it is released
      const open = x.contactNoun(rv.viaSwitch!) === '접점' ? '접점이 열리면' : '스위치를 놓으면'
      warns.push(`4번 핀(RESET)은 ${x.whileClosed(rv.viaSwitch!)} GND로 내려가지만, ${open} 떠 있어 잡음에 멈출 수 있습니다 (VCC 쪽에 풀업 저항 필요)`)
    } else warns.push('4번 핀(RESET)이 떠 있어 잡음에 멈출 수 있습니다 (VCC에 연결)')
    // CTRL (5): a capacitor or nothing; tied to a rail it moves the thresholds to that rail
    const ctl = n(5), cv = x.voltOf(ctl)
    let shifted = false
    if (ctl && x.isGnd(ctl)) errors.push('5번 핀(CTRL)이 GND에 묶여 비교 기준이 0 V가 되어 동작하지 않습니다')
    else if (ctl && (ctl === vccNet || (cv && vcc && cv.v >= vcc.v - 0.05))) errors.push('5번 핀(CTRL)이 VCC 이상에 묶여 비교 기준이 VCC가 되어 발진하지 않습니다')
    else if (ctl && cv && cv.v > 0) {
      shifted = true
      warns.push(`5번 핀(CTRL)이 ${V(cv.v)} 레일에 묶여 비교 기준이 ${V(cv.v)}·${V(cv.v / 2)}로 바뀌므로 주파수가 아래 식과 다릅니다`)
    }
    // astable: TRIG = THRES, timing capacitor(s) to GND, RB from DISCH to THRES, RA from VCC to DISCH
    let freq: string | null = null
    const thr = n(6), dis = n(7)
    if (thr && thr === n(2) && dis) {
      const ras = vccNet ? x.between(vccNet, dis) : [], rbs = x.between(dis, thr)
      const raOhms = ras.map(r => parseOhms(r.value))
      if (x.isGnd(dis) || x.voltOf(dis)) errors.push(`7번 핀(DISCH)이 ${x.isGnd(dis) ? 'GND' : '전원'}에 바로 묶여 있어 발진하지 않습니다`)
      else if (ras.length && raOhms.every(o => o != null) && par(raOhms as number[]) === 0) {
        errors.push('7번 핀(DISCH)이 0 Ω RA로 VCC에 바로 묶여 방전 때마다 VCC가 방전 트랜지스터에 그대로 걸립니다')
      } else {
        const caps = [...x.of('C'), ...x.of('CP')].filter(c => {
          const a = x.net(c.ref, 1), b = x.net(c.ref, 2)
          return (a === thr && x.isGnd(b)) || (b === thr && x.isGnd(a))
        })
        const usable = caps.filter(c => !reversedCaps.has(c.ref))
        const unread = [...usable, ...ras, ...rbs].filter(p => (p.part === 'R' ? parseOhms(p.value) : parseFarads(p.value)) == null)
        const missing = [!usable.length && `타이밍 커패시터${caps.length ? '(극성이 거꾸로라 제외)' : ''}`, !ras.length && 'RA(VCC–DISCH)', !rbs.length && 'RB(DISCH–THRES)'].filter(Boolean) as string[]
        if (missing.length) unknowns.push(`비안정(점멸) 배선에서 ${eul(missing.join(', '))} 찾지 못해 주파수를 계산하지 않았습니다`)
        else if (unread.length) unknowns.push(`${eul(unread.map(p => `${p.ref} 값 ${val(p.value)}`).join(', '))} 읽지 못해 주파수를 계산하지 않았습니다 (단위가 필요합니다, 예: 10uF, 68k)`)
        else {
          const C = usable.reduce((s, c) => s + parseFarads(c.value)!, 0)
          const RA = par(ras.map(r => parseOhms(r.value)!)), RB = par(rbs.map(r => parseOhms(r.value)!))
          if (C <= 0) unknowns.push(`타이밍 커패시터 용량이 0이라 주파수를 계산하지 않았습니다 (${usable.map(c => `${c.ref} ${val(c.value)}`).join(', ')})`)
          else {
            const f = 1.44 / ((RA + 2 * RB) * C), duty = (RA + RB) / (RA + 2 * RB)
            freq = `${f >= 1000 ? `${sig(f / 1000)} kHz` : `${sig(f)} Hz`}, 켜짐 비율 ${(duty * 100).toFixed(0)}%`
            const name = (rs: OpPart[]) => (rs.length > 1 ? `(${rs.map(r => r.ref).join('∥')})` : rs[0].ref)
            detail.push(`비안정(점멸) 구성: f = 1.44 ÷ ((${name(ras)} ${ohm(RA)} + 2 × ${name(rbs)} ${ohm(RB)}) × ${usable.map(c => c.ref).join('+')} ${uF(C)}) = ${freq}`,
              `식: ${t.formula_src}`)
            if (vcc) {
              // the threshold current flows through RA + RB from VCC to 2/3 VCC, so the limit grows with VCC
              const a = t.rsum_max_5v.v, b = t.rsum_max_15v.v, v = vcc.v
              const rmax = v <= 5 ? a * v / 5 : v >= 15 ? b * v / 15 : a + (b - a) * (v - 5) / 10
              const how = v <= 5 ? `5 V 값 ${ohm(a)}을 VCC에 비례해 줄임` : v >= 15 ? `15 V 값 ${ohm(b)}을 VCC에 비례` : `5 V ${wa(ohm(a))} 15 V ${ohm(b)} 사이 직선 보간`
              detail.push(`RA + RB 최대 ${ohm(rmax)} @ VCC ${V(v)} (${how}; ${cite(t.rsum_max_5v)})`)
              if (RA + RB > rmax) {
                const [sa, sb] = two(RA + RB, rmax, ohm)
                warns.push(`타이밍 저항 합 ${sa} > 최대 ${sb} (VCC ${V(v)}): 발진하지 않을 수 있습니다`)
              }
            }
          }
        }
      }
    }
    const state: OpState = errors.length ? 'error' : warns.length ? 'warn' : !vcc || unknowns.length ? 'unknown' : freq && !shifted ? 'pass' : 'unknown'
    const lead = errors[0] ?? warns[0] ?? (!vcc ? `전원 전압을 몰라 판단할 수 없습니다${x.blockedWhy(vccNet) ? `: ${x.blockedWhy(vccNet)!.why}` : ''}` : unknowns[0] ?? (freq ? `동작 ${freq}` : '점멸(비안정) 구성이 아니라 동작을 계산하지 않았습니다'))
    const rest = [...errors, ...warns, ...unknowns].filter(m => m !== lead)
    const vccOnly = errors.every(e => /^전원 /.test(e)) && !warns.length
    const cause = vccOnly ? (!vcc ? x.blockedWhy(vccNet)?.cause : vcc.cause) : undefined
    out.push({ rule: 'op_555', ref: u.ref, state, summary: `${u.ref} ${lead}`, detail: [...rest, ...detail], ...(cause && state !== 'pass' ? { cause } : {}) })
  }
  return out
}

function checkRegs(x: Ctx, reversedCaps: Set<string>): OpResult[] {
  const out: OpResult[] = []
  for (const r of x.of('REG')) {
    const res = (state: OpState, summary: string, detail: string[], cause?: string) => out.push({ rule: 'op_reg', ref: r.ref, state, summary, detail, ...(cause && state !== 'pass' ? { cause } : {}) })
    const reg = regSpec(r.value)
    if (!reg) { res('unknown', `${r.ref} (${r.value || '값 없음'}): 이 레귤레이터의 자료가 없습니다`, ['AMS1117-x.x와 7805만 데이터시트 수치가 있습니다']); continue }
    const spec = reg.spec
    if (!spec) { res('unknown', `${r.ref} (${reg.name}): 데이터시트 수치를 아직 확인하지 못해 판단하지 않습니다`, ['78xx 중에는 7805만 데이터시트 수치를 확인했습니다']); continue }
    const g = x.net(r.ref, 1), o = x.net(r.ref, 2), i = x.net(r.ref, 3)
    const pins = `핀 넷: 1 GND ${g ?? '-'}, 2 OUT ${o ?? '-'}, 3 IN ${i ?? '-'}`
    const gs = x.gndState(g)
    if (gs === 'not') { res('error', `${r.ref} GND 핀(1번)이 GND에 연결되지 않았습니다`, [pins, g ? `${g}: ${x.voltOf(g)?.why ?? '전압이 정해지지 않은 GND가 아닌 넷'}` : '1번 핀이 어디에도 연결되지 않았습니다']); continue }
    if (gs === 'unknown') { const bl = x.blockedWhy(g); res('unknown', `${r.ref} GND 핀 넷 ${g}의 전압을 알 수 없습니다`, [pins, bl?.why ?? `${g}의 전압이 정해지지 않습니다`], bl?.cause); continue }
    if (o && (o === g || x.isGnd(o))) { res('error', `${r.ref} 출력(2번 핀)이 GND에 바로 연결되어 단락됩니다`, [pins]); continue }
    if (o && o === i) { res('error', `${r.ref} 입력과 출력이 같은 넷 ${ira(o)} 레귤레이터가 우회됩니다: 출력 쪽에 입력 전압이 그대로 걸립니다`, [pins]); continue }
    const vin = x.voltOf(i), vout = x.voltOf(o)
    // swapped: a supply sits on the output pin while the input pin has less, or nothing
    if (vout && vout.src !== 'reg' && vout.v > reg.vout + 0.05 && (!vin || vin.v <= reg.vout + 0.05)) {
      res('error', `${r.ref} 입력(3번 핀)과 출력(2번 핀)이 바뀐 것 같습니다: 출력 쪽 ${o}에 ${V(vout.v)}가 있고 입력 쪽에는 ${vin ? `${V(vin.v)}뿐입니다` : '전원이 없습니다'}`,
        [pins, `${o}: ${vout.why}`, vin ? `${i}: ${vin.why}` : `${i ?? '입력 핀'}에는 전원이 없습니다`])
      continue
    }
    if (!vin) { const ns = x.noSource(i); res('unknown', `${r.ref} 입력 전압을 몰라 판단할 수 없습니다${ns ? `: ${ns.why}` : ''}`, [pins], ns?.cause); continue }
    const head = vin.v - reg.vout
    const detail = [`입력 ${V(vin.v)} (${vin.why}) − 출력 ${V(reg.vout)} = ${V(head)}`,
      `최소 전압 차 ${V(spec.dropout_max.v)}: ${cite(spec.dropout_max)}`, `최대 입력 ${V(spec.vin_max.v)}: ${cite(spec.vin_max)}`]
    if (atLeast(vin.v, spec.vin_max.v)) {
      const [a, b] = two(vin.v, spec.vin_max.v, V)
      res('error', `${r.ref} 입력 ${a} ≥ 최대 ${b}`, detail, vin.cause); continue
    }
    if (head < spec.dropout_max.v - 1e-9) {
      const [a, b] = two(head, spec.dropout_max.v, V)
      res('error', `${r.ref} 입력−출력 ${a} < 최소 ${b}: 출력이 ${V(reg.vout)}를 유지하지 못합니다`, detail, vin.cause); continue
    }
    const caps = [...x.of('C'), ...x.of('CP')].filter(c => {
      const a = x.net(c.ref, 1), b = x.net(c.ref, 2)
      return (a === o && x.isGnd(b)) || (b === o && x.isGnd(a))
    }).filter(c => !reversedCaps.has(c.ref))
    const unread = caps.filter(c => parseFarads(c.value) == null)
    if (spec.cout_min && unread.length) {
      res('unknown', `${r.ref} 출력 커패시터 ${eul(unread.map(c => `${c.ref} 값 ${val(c.value)}`).join(', '))} 읽지 못했습니다`, [...detail, cite(spec.cout_min)]); continue
    }
    const total = caps.reduce((s, c) => s + parseFarads(c.value)!, 0)
    if (spec.cout_min && !atLeast(total, spec.cout_min.v)) {
      res('warn', `${r.ref} 출력 커패시터 ${uF(total)} < 권장 ${uF(spec.cout_min.v)} (발진 위험)`, [...detail, cite(spec.cout_min)]); continue
    }
    if (atLeast(vin.v, NEAR * spec.vin_max.v)) { res('warn', `${r.ref} 입력 ${V(vin.v)}가 최대 ${V(spec.vin_max.v)}에 가깝습니다`, detail); continue }
    res('pass', `${r.ref} 입력 ${V(vin.v)} → ${V(reg.vout)} (여유 ${V(head)})`, detail)
  }
  return out
}

// ── entry points ───────────────────────────────────────────────────────────────

/** Every operating check on one circuit. */
export function operatingChecks(c: OpCircuit): OpResult[] {
  if (c.missing?.length) {
    return [{ rule: 'op_data', ref: '', state: 'unknown',
      summary: `핀 대응 정보가 없는 예전 보드라 동작 검사를 하지 않았습니다 (부품 ${c.missing.length}개)`,
      detail: ['게이트와 드레인처럼 핀을 구분할 수 없으면 계산이 틀립니다. PCB를 다시 생성하면 검사합니다',
        `핀 대응이 없는 부품: ${c.missing.slice(0, 12).join(', ')}${c.missing.length > 12 ? ' …' : ''}`] }]
  }
  // Which relays pull in: every relay starts released (COM–NC closed, COM–NO open), and the relays whose
  // coils pull in switch over, until nothing changes. A coil fed only through its own contact, or two relays
  // holding each other, never start; a relay is reported as it was when it pulled in.
  const relays = c.parts.filter(p => p.part === 'Relay').map(p => p.ref).sort(natural)
  const own = (k: string) => (r: OpResult) => r.ref === k && (r.rule === 'op_relay' || r.rule === 'op_flyback')
  const closed = new Set<string>()
  const entered = new Map<string, OpResult[]>()
  let run = collect(c, new Set(relays))
  for (let guard = 0; guard <= relays.length; guard++) {
    const newly = relays.filter(k => !closed.has(k) && run.pulled.has(k))
    if (!newly.length) break
    for (const k of newly) { entered.set(k, run.out.filter(own(k))); closed.add(k) }
    run = collect(c, new Set(relays.filter(k => !closed.has(k))))
  }
  const openSet = relays.filter(k => !closed.has(k))
  const base: OpResult[] = [...run.out]
  for (const [k, rs] of entered) {
    const now = base.filter(own(k))
    const note = `${k} 코일은 자기 접점이 바뀌기 전 상태로 계산합니다`
    const at = Math.max(base.findIndex(own(k)), 0)
    const keep = resultsSig(now) === resultsSig(rs) ? rs : rs.map(r => ({ ...r, detail: [note, ...r.detail] }))
    base.splice(0, base.length, ...base.slice(0, at).filter(r => !own(k)(r)), ...keep, ...base.slice(at).filter(r => !own(k)(r)))
  }
  const out = base.map(r => ({ ...r }))
  const idx = new Map(base.map((r, i) => [r, i]))
  const replace = (r: OpResult, next: OpResult) => { const i = idx.get(r); if (i != null) out[i] = next }
  const added: OpResult[] = []
  const addOnce = (r: OpResult, note: string) => {
    if ([...out, ...added].some(o => o.rule === r.rule && o.ref === r.ref && (o.summary === r.summary || (!!r.key && o.key === r.key)))) return
    if (r.key && [...out, ...added].some(o => o.key === r.key)) return
    added.push({ ...r, detail: [note, ...r.detail] })
  }
  /** the same check in another state of the circuit: changed (or gone) there, and what it says there */
  const compare = (pool: OpResult[], r: OpResult) => {
    const a = matchResult(pool, base, r)
    const gone = !a && !pool.some(o => o.rule === r.rule && o.ref === r.ref)
    return { a, changed: gone || (!!a && (a.state !== r.state || a.summary !== r.summary)) }
  }
  const fault = (s?: OpState) => s === 'error' || s === 'warn'

  // A relay that pulls in releases sometimes (at power-up, when switched off): what hangs on its COM–NC is
  // judged released, and so is a short through it
  for (const k of [...closed].sort(natural)) {
    const rel = collect(c, new Set([...openSet, k])).out
    for (const r of base) {
      if (own(k)(r) || r.state !== 'unknown') continue
      const { a, changed } = compare(rel, r)
      if (changed && a && a.state !== 'unknown') replace(r, { ...a, detail: [`${ga(k)} 놓여 있을 때(COM–NC 닫힘)입니다`, ...a.detail] })
    }
    for (const a of rel) if (fault(a.state) && !own(k)(a) && !base.some(o => o.rule === a.rule && o.ref === a.ref)) addOnce(a, `${ga(k)} 놓여 있을 때 생기는 문제입니다`)
  }

  // A verdict that changes when an open relay's contact switches over rests on that relay: it follows that
  // relay (or what keeps the relay from pulling in) as its cause. A failure that stays, or only shows, with
  // the contact switched is a fault of its own: it shows the moment the relay is fixed. Every relay is
  // compared with the same starting state, so neither order nor names change the answer.
  const alts = openSet.map(k => ({ k, out: collect(c, new Set(openSet.filter(j => j !== k))).out }))
  const allClosed = openSet.length > 1 ? collect(c, new Set()).out : null
  const blame = (k: string) => run.noPull.get(k) ?? k
  for (const r of base) {
    const ownOf = openSet.find(k => own(k)(r))
    if (ownOf) {
      // a relay that does not pull in, judged before its own contact switches: say so when that matters
      const alt = alts.find(x => x.k === ownOf)!
      const { a, changed } = compare(alt.out, r)
      if (changed && a) replace(r, { ...out[idx.get(r)!], detail: [`${ownOf} 코일은 자기 접점이 바뀌기 전 상태로 계산합니다. 접점이 바뀌었다고 보면: ${a.summary}`, ...r.detail] })
    }
    if (r.state === 'pass') continue
    let hit: { k: string; a?: OpResult } | null = null
    for (const { k, out: pool } of alts) { if (k === ownOf) continue; const { a, changed } = compare(pool, r); if (changed) { hit = { k, a }; break } }
    if (!hit && allClosed && !ownOf) { const { a, changed } = compare(allClosed, r); if (changed) hit = { k: openSet[0], a } }
    if (!hit) continue
    const { k, a } = hit
    const cur = out[idx.get(r)!]
    if (fault(a?.state) && !ownOf) {
      // still failing with the contact switched: its own fault, as it is then
      if (!fault(r.state)) replace(r, { ...a!, detail: [`${k} 접점이 바뀌기 전인 지금은: ${r.summary}`, ...a!.detail] })
      continue
    }
    if (fault(a?.state)) continue
    if (cur.cause && cur.cause !== r.ref) continue
    const kRes = base.find(o => o.ref === k && o.rule === 'op_relay')
    const why = `${ga(k)} ${kRes?.state === 'error' ? '붙지 않아' : '붙는지 알 수 없어'} ${k} 접점이 바뀌기 전 상태로 계산했습니다`
    const cause = blame(k)
    replace(r, { ...cur, cause, ...(cause === k ? { causeRule: 'op_relay' as OpRule } : {}),
      detail: [`${why}. 바뀌었다면: ${a ? a.summary : '이 결과는 다른 결과에 합쳐집니다'}`, ...cur.detail] })
  }
  for (const { k, out: pool } of alts) for (const a of pool) {
    if (fault(a.state) && !own(k)(a) && !base.some(o => o.rule === a.rule && o.ref === a.ref)) addOnce(a, `${k} 접점이 바뀌면 생기는 문제입니다`)
  }
  if (allClosed) for (const a of allClosed) {
    if (fault(a.state) && !relays.some(k => own(k)(a)) && !base.some(o => o.rule === a.rule && o.ref === a.ref)) addOnce(a, '붙지 않는 릴레이들의 접점이 바뀌면 생기는 문제입니다')
  }

  // A regulator short of input hides what its output feeds: with the input enough, a failure that shows
  // there is a fault of its own
  if (base.some(r => r.rule === 'op_reg' && r.state === 'error')) {
    const forced = collect(c, new Set(openSet), true).out
    for (const r of base) {
      const cur = out[idx.get(r)!]
      if (r.state === 'pass' || r.rule === 'op_reg' || fault(cur.state)) continue
      const { a, changed } = compare(forced, r)
      if (changed && fault(a?.state)) replace(r, { ...a!, detail: ['레귤레이터 입력이 충분하다고 보면 생기는 문제입니다', ...a!.detail] })
    }
    for (const a of forced) if (fault(a.state) && a.rule !== 'op_reg' && !base.some(o => o.rule === a.rule && o.ref === a.ref)) addOnce(a, '레귤레이터 입력이 충분하다고 보면 생기는 문제입니다')
  }
  out.push(...added)

  // say where a knock-on failure comes from, since the headline counts it under its cause
  const label = Object.fromEntries(OP_RULES) as Record<OpRule, string>
  const isRelay = (ref: string) => c.parts.some(p => p.ref === ref && p.part === 'Relay')
  for (const r of out) {
    if (r.state === 'pass') { delete r.cause; delete r.causeRule; continue }
    // an open relay named as cause hands it on to what keeps that relay from pulling in (a transistor that
    // does not turn on), when that is something else
    const why = r.cause && openSet.includes(r.cause) ? run.noPull.get(r.cause) : undefined
    if (why && why !== r.cause && why !== r.ref) { r.cause = why; delete r.causeRule }
    // a relay named as cause is its coil not pulling in, not its contacts
    if (r.cause && !r.causeRule && isRelay(r.cause) && r.cause !== r.ref) r.causeRule = 'op_relay'
  }
  for (const r of out) {
    const root = rootOf(r, out)
    if (root !== r && RANK[root.state] >= RANK[r.state]) r.detail = [`${root.ref} ${label[root.rule]} 문제에서 이어진 결과라 머리글 개수에는 한 번만 셉니다`, ...r.detail]
  }
  return out
}

const resultsSig = (rs: OpResult[]) => rs.map(r => `${r.rule}/${r.state}/${r.summary}`).join('\n')

/** the result in `pool` that is the same check as `r` (same rule and part; by text when there are several) */
function matchResult(pool: OpResult[], all: OpResult[], r: OpResult): OpResult | undefined {
  const same = pool.filter(o => o.rule === r.rule && o.ref === r.ref)
  if (!same.length) return undefined
  const exact = same.find(o => o.summary === r.summary)
  if (exact) return exact
  return same.length === 1 && all.filter(o => o.rule === r.rule && o.ref === r.ref).length === 1 ? same[0] : undefined
}

/**
 * The checks with the relays in `open` released (not pulled in), the relays whose coils pull in, and why the
 * others do not (the switch that does not turn on, a supply's fault). `force` takes every regulator as
 * having enough input.
 */
function collect(c: OpCircuit, open: ReadonlySet<string>, force = false): { out: OpResult[]; pulled: Set<string>; noPull: Map<string, string | undefined> } {
  const out: OpResult[] = []
  const pulled = new Set<string>(), noPull = new Map<string, string | undefined>()
  let x: Ctx, strings: LedString[], switches: Switch[]
  try {
    x = context(c, open, force)
    strings = ledStrings(x)
    switches = analyzeSwitches(x, strings)
  } catch (e) {
    return { out: [{ rule: 'op_data', ref: '', state: 'unknown', summary: '회로를 분석하다 오류가 나 동작 검사를 하지 못했습니다', detail: [String((e as Error)?.message ?? e)] }], pulled, noPull }
  }
  const switchAt = (n: string | null) => (n ? switches.find(s => s.grounded && s.c === n) ?? null : null)
  const sinkOf = (n: string | null): Sink | null => {
    const v = x.voltOf(n)
    if (v) return { lo: v.v, hi: v.v, why: v.why, ...(v.cause ? { cause: v.cause } : {}) }
    const sw = switchAt(n)
    if (!sw) return null
    if (sw.dropMax != null) {
      // a sense resistor under the emitter/source lifts the collector/drain by its drop too (at the largest current)
      const vs = sw.sense.ohms * loadI(sw.loads, 0)
      return { lo: 0, hi: sw.dropMax + vs,
        why: `${sw.q.ref} 켜짐: ${sw.kind === 'bjt' ? 'VCE' : 'VDS'} 0~${V(sw.dropMax)}${vs > 0 ? ` + 감지 저항 ${sw.sense.ref} 최대 ${V(vs)}` : ''} (트랜지스터 켜짐 참고)` }
    }
    // the switch's own verdict (or what it follows) is why its drop is not known
    const cause = sw.result.state === 'pass' ? undefined : (sw.result.cause ?? sw.q.ref)
    return { lo: 0, hi: null, why: sw.offWhy, ...(cause ? { cause, fromSwitch: true } : {}) }
  }
  const run = (rule: OpRule, f: () => OpResult[]) => {
    try { out.push(...f()) } catch (e) {
      out.push({ rule, ref: '', state: 'unknown', summary: '이 검사를 하다 오류가 나 판단하지 못했습니다', detail: [String((e as Error)?.message ?? e)] })
    }
  }
  const reversedCaps = new Set<string>()
  const heats = new Map<string, { r: OpPart; h: Heat }>()
  out.push(...x.power.issues)
  run('op_cap', () => checkCaps(x, reversedCaps))
  run('op_short', () => checkShorts(x))
  run('op_led', () => checkLeds(x, strings, sinkOf, (r, h) => { const cur = heats.get(r.ref); if (!cur || h.p > cur.h.p) heats.set(r.ref, { r, h }) }))
  const ledFailed = (ref: string) => out.some(o => o.rule === 'op_led' && o.ref === ref && o.state === 'error')
  // a drive verdict follows the fault it comes from: a drive supply put in backwards, an LED string over
  // its rating, or loads whose supply has a fault; a wrong drive of its own stays its own fault
  for (const sw of switches) {
    if (sw.result.state === 'pass' || sw.result.cause) continue
    const from = sw.driveCause ?? (sw.loadCaused ? overLed(sw.loads, ledFailed) : undefined) ?? sw.unknownCause
    if (from) sw.result = { ...sw.result, cause: from }
  }
  run('op_flyback', () => checkFlyback(x, switchAt))
  const flybackFailed = (ref: string) => out.some(o => o.rule === 'op_flyback' && o.ref === ref && o.state === 'error')
  run('op_relay', () => checkRelays(x, sinkOf, pulled, noPull, flybackFailed))
  run('op_drive', () => switches.map(s => s.result))
  run('op_switch', () => checkSwitchLimits(switches, ledFailed))
  run('op_rpower', () => checkResistorPower(x, switches, heats))
  run('op_555', () => check555(x, reversedCaps))
  run('op_reg', () => checkRegs(x, reversedCaps))
  return { out, pulled, noPull }
}

/**
 * The fault a result traces back to: its cause part's result (the named rule when given, else an error,
 * else any result that is not a pass), that one's cause, and so on, through results that could not be judged
 * as well. A cause whose named rule has no failing result there is no cause. Results that name each other
 * are one fault, counted at the first in the list.
 */
function rootOf(r: OpResult, results: OpResult[]): OpResult {
  const chain = [r]
  for (let cur = r; cur.cause;) {
    const of = results.filter(o => o !== cur && o.ref === cur.cause && o.state !== 'pass' && (!cur.causeRule || o.rule === cur.causeRule))
    const next = of.find(o => o.state === 'error' && !o.cause) ?? of.find(o => o.state === 'error') ?? of.find(o => o.cause) ?? of[0]
    if (!next) return cur
    if (chain.includes(next)) return chain.slice(chain.indexOf(next)).reduce((a, o) => (results.indexOf(o) < results.indexOf(a) ? o : a))
    chain.push(next); cur = next
  }
  return chain[chain.length - 1]
}

/** Worst state and a one-line headline; a fault and the failures it causes count once. */
export function operatingHeadline(results: OpResult[]): { state: OpState; text: string } {
  if (!results.length) return { state: 'pass', text: '검사할 부품 없음' }
  // a result counts unless it follows a fault at least as severe as itself (a knock-on of that fault)
  const counts = (r: OpResult) => { const root = rootOf(r, results); return root === r || RANK[root.state] < RANK[r.state] }
  const n = (s: OpState) => results.filter(r => r.state === s && counts(r)).length
  const any = (s: OpState) => results.some(r => r.state === s)
  const unk = n('unknown') ? ` · 판단 불가 ${n('unknown')}` : ''
  if (any('error')) return { state: 'error', text: `동작 안 됨 ${Math.max(1, n('error'))}${unk}` }
  if (any('warn')) return { state: 'warn', text: `동작 경고 ${n('warn')}${unk}` }
  if (any('unknown')) return { state: 'unknown', text: `판단 불가 ${Math.max(1, n('unknown'))}` }
  return { state: 'pass', text: '동작 검사 통과' }
}
