import type { BoardModel, NetGraph } from '../types'
import { pinNumber } from './graphEdit'
import { SPECS, assumedBjt, assumedMos, ledOf, type BjtSpec, type LedColor, type LedSpec, type MosSpec, type Num } from './partSpecs'

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
  /** what to change, in plain words (src/lib/fixes.ts fills in fixes found by re-running the checks) */
  fix?: string
}

export interface OpPart { ref: string; part: string; value: string }
export interface OpCircuit {
  parts: OpPart[]
  pins: Map<string, string>          // "R1.2" -> net (template pin numbers)
  style: 'smd' | 'tht' | null        // null before the PCB exists
  /** parts whose pins cannot be told apart (boards saved before pad_pins existed) */
  missing?: string[]
  /** pins saved under a name the pin-name table does not know ("D1.ANODE"): which leg they are on is not known */
  unread?: string[]
}

const pinKey = (ref: string, pin: number) => `${ref}.${pin}`
const FURNITURE = new Set(['MountingHole', 'TestPoint'])
/**
 * A part's value as the checks read it. An empty value reaches the netlist, and so the board, as the part's reference
 * (server/index.ts graphToNetlist), and a resistor's reads like a value: R1 is no 0.1 Ω. No value, as on the schematic.
 */
const partValue = (ref: string, value: unknown) => { const v = String(value ?? ''); return v === ref ? '' : v }

/**
 * The schematic graph (before a PCB exists); style = the SMD/THT choice the PCB will use. A pin an older edit saved by its
 * name (D1 'A', Q1 'B', BT1 '+', R1 'p2') is read through the template's pin-name table, as the AI editor and the circuit
 * check read it (2026-11-08: such a circuit had no pins here, and its 검사할 부품 없음 showed as a pass). A name the table
 * does not know is not guessed: it is in `unread`, and the checks say 판단 불가.
 */
export function fromGraph(g: NetGraph, style: 'smd' | 'tht' | null = null): OpCircuit {
  const parts = (g.components || []).filter(c => c.name && !FURNITURE.has(c.name))
    .map(c => ({ ref: c.ref, part: c.name!, value: partValue(c.ref, c.value) }))
  const kind = new Map(parts.map(p => [p.ref, p.part]))
  const pins = new Map<string, string>()
  const unread: string[] = []
  for (const n of g.nets || []) for (const nd of n.nodes || []) {
    if (!kind.has(nd.ref)) continue
    const pin = pinNumber(kind.get(nd.ref), String(nd.pin))
    if (/^\d+$/.test(pin)) pins.set(pinKey(nd.ref, Number(pin)), n.name)
    else unread.push(`${nd.ref}.${nd.pin}`)
  }
  return { parts, pins, style, ...(unread.length ? { unread } : {}) }
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
    parts: real.map(p => ({ ref: p.ref, part: p.part, value: partValue(p.ref, p.value) })), pins, style: b.style ?? null,
    missing: real.filter(p => !p.pad_pins).map(p => p.ref),
  }
}

// ── values ─────────────────────────────────────────────────────────────────────

/** the value part of a part value with a rating after it: "22uF 16V" -> "22uF", "680 1/4W" -> "680", "1k 1%" -> "1k" */
const valuePart = (v: string) => String(v ?? '').trim().replace(/(?:(?<=[A-Za-zµμΩ])\s*[,/]\s*|\s+)(?=\d+(?:\.\d+)?\s*(?:V|W|%)|\d+\s*\/\s*\d+\s*W).*$/i, '')

/** "680", "10k", "4k7", "4.7k", "1M", "100R", "0R1", "R10", "10 Ω", "100m" (milliohm), "100mR", "680 1/4W" -> ohms */
export function parseOhms(v: string): number | null {
  const s = valuePart(v).replace(/Ω|ohms?/gi, '').replace(/\s+/g, '')
  // M is mega and m is milli (a 100 mΩ sense resistor), k/K kilo, r/R the decimal point, with nothing before it too
  // (R10, as server/ai_layout.ts reads it: 2026-11-06 sweep, a sense resistor R10 left its transistor unjudged)
  const mul = (u: string) => (u === 'M' ? 1e6 : u === 'm' ? 1e-3 : u === 'k' || u === 'K' ? 1e3 : 1)
  let m = /^(\d*)[rR](\d+)$/.exec(s)
  if (m) return Number(`${m[1] || '0'}.${m[2]}`)
  m = /^(\d+)([kKmM])(\d+)$/.exec(s)
  if (m) return Number(`${m[1]}.${m[3]}`) * mul(m[2])
  m = /^(\d+(?:\.\d+)?)([kKmM]?)[rR]?$/.exec(s)
  if (m) return Number(m[1]) * mul(m[2])
  return null
}

/** "100nF", "10uF", "0.1µF", "22μF", "22p", "1u", "4u7", "2n2" -> farads */
export function parseFarads(v: string): number | null {
  const s = valuePart(v)
  const point = /^(\d+)([pnuµμm])(\d)f?$/i.exec(s)       // 4u7 is 4.7 uF (2026-11-06 sweep: read as no value, "단위가 필요합니다"); 1n4148 is no value
  const m = point ?? /^(\d+(?:\.\d+)?)\s*([pnuµμm])?(f)?$/i.exec(s)
  if (!m || (!m[2] && !m[3])) return null      // "104" is a code, not 104 F
  if (m[2] === 'M') return null                // "100MF" is an old way to write µF, not 0.1 F: not read at all
  const mul: Record<string, number> = { '': 1, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3 }
  const f = Number(point ? `${m[1]}.${m[3]}` : m[1]) * mul[(m[2] || '').toLowerCase()]
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
  const word = (w: string) => new RegExp(`(^|[^A-Z])${w}([^A-Z]|$)`)
  const colors = ([
    ['red', [word('RED'), /빨강|빨간|적색/]], ['green', [word('GREEN'), /초록|녹색/]],
    ['yellow', [word('YELLOW'), /노랑|노란|황색/]], ['blue', [word('BLUE'), /파랑|파란|청색/]],
  ] as [LedColor, RegExp[]][]).filter(([, res]) => res.some(re => re.test(v))).map(([c]) => c)
  // one colour word only: a two-colour LED (RED/GREEN, YELLOW-GREEN) is no one of these parts
  return colors.length === 1 ? ledOf(colors[0], style) : null
}

function bjtSpec(value: string, style: 'smd' | 'tht' | null): { spec: BjtSpec; note: string | null } {
  const v = value.toUpperCase().replace(/\s+/g, '')
  for (const [name, spec] of Object.entries(SPECS.bjt)) if (v.includes(name)) return { spec, note: null }
  const name = assumedBjt(style)
  return { spec: SPECS.bjt[name], note: `값 ${value || '(없음)'}의 자료가 없어 ${name} 기준으로 계산` }
}

// the part number anywhere in the value (IRLZ44NPBF is an IRLZ44N), longest name first so that a name never stands in for
// a longer one that holds it. IRFZ44N and IRLZ44N differ in a letter, so neither holds the other
const MOS_NAMES = Object.keys(SPECS.mos).sort((a, b) => b.length - a.length)
/** each MOSFET's package; the board's Q_NMOS seat is SOT-23 on SMD and TO-92 on THT (server/pcb/footprints_table.py) */
const MOS_PKG: Record<string, 'SOT-23' | 'TO-92' | 'TO-220'> = { '2N7002': 'SOT-23', NDS7002A: 'SOT-23', '2N7000': 'TO-92', IRFZ44N: 'TO-220', IRLZ44N: 'TO-220' }
const PKG_ORDER = ['SOT-23', 'TO-92', 'TO-220']
/**
 * The RDS(on) a gate of `vgs` is guaranteed: the smallest of the datasheet rows at or below it (IRLZ44N: 35 mΩ from 4 V,
 * 25 mΩ from 5 V, 22 mΩ from 10 V). Null under every row: the datasheet says nothing of RDS(on) there (2026-11-08 review:
 * a 4.95 V gate on IRFZ44N and 3.27 V on IRLZ44N were heated with the 10 V and 4 V rows and passed)
 */
function rdsRow(spec: MosSpec, vgs: number): { vgs: number; rds: Num } | null {
  const rows = [{ vgs: spec.vgs_rated.v, rds: spec.rds_on }, ...(spec.rds_rows ?? [])].filter(r => atLeast(vgs, r.vgs))
  return rows.length ? rows.reduce((a, r) => (r.rds.v < a.rds.v ? r : a)) : null
}
/**
 * A TO-220 part's conduction heat at this current with no heatsink, the gate at `vgs`: I² × the RDS(on) row the gate is
 * guaranteed × its rise at TJ 175 °C, against (TJ max − 25 °C) ÷ RθJA in still air and the case-at-25 °C dissipation; the
 * current it stands in free air. Null for a part whose current rating is already its own (small-signal parts rated in free
 * air) and for a gate under every RDS(on) row (rdsRow)
 */
function mosHeat(spec: MosSpec, i: number, vgs: number) {
  const a = spec.free_air, row = rdsRow(spec, vgs)
  if (!a || !row) return null
  const hot = row.rds.v * a.rds_hot.v, pAir = (a.tj_max.v - 25) / a.rth_ja.v
  return { p: i * i * hot, pAir, pCase: a.pd_case.v, iAir: Math.sqrt(pAir / hot), hot, a, row }
}
/** stands this current with no heatsink with the gate at `vgs`, short of the 90 % that warns (op_switch) */
const standsAlone = (spec: MosSpec, i: number, vgs: number) => {
  const h = mosHeat(spec, i, vgs)
  return !atLeast(i, NEAR * spec.id_max.v) && !(h && atLeast(h.p, NEAR * h.pAir))
}
/** a limit written to three figures without rounding past it ("부하 9500 mA 이하면", never 9505) */
const down = (v: number) => { if (v <= 0) return v; const e = 10 ** (Math.floor(Math.log10(v)) - 2); return Math.floor(v / e + 1e-9) * e }
/**
 * The most a load whose current is not known draws through a switch's sense resistor: the switch's rated current, or the
 * load's supply over the sense resistor alone when that is less (load and switch taken as dropping nothing). 2026-11-09
 * review: 47 A × 1 Ω read as a 47 V drop and 2209 W on a 12 V supply, where 12 A is the most that can flow
 */
function senseBound(sw: Switch): { i: number; why: string; rating: boolean } {
  const lim = sw.bjt ? sw.bjt.ic_max : sw.mos!.id_max
  const tops = sw.loads.map(l => (l.supply ?? l.src)?.hi)
  const top = tops.length && tops.every(v => v != null) ? Math.max(...(tops as number[])) : null
  if (top != null && top > 0 && sw.sense.ohms > 0 && top / sw.sense.ohms < lim.v) {
    return { i: top / sw.sense.ohms, why: `부하 전원 ${V(top)} ÷ ${sw.sense.ref} ${ohm(sw.sense.ohms)}`, rating: false }
  }
  return { i: lim.v, why: `${sw.bjt ? 'IC' : 'ID'} 최대`, rating: true }
}
function mosSpec(value: string, style: 'smd' | 'tht' | null): { spec: MosSpec; note: string | null } {
  const v = value.toUpperCase().replace(/\s+/g, '')
  const known = MOS_NAMES.find(n => v.includes(n))
  if (known) return { spec: SPECS.mos[known], note: null }
  const name = assumedMos(style)
  return { spec: SPECS.mos[name], note: `값 ${value || '(없음)'}의 자료가 없어 ${name} 기준으로 계산` }
}

/**
 * A known regulator by part number: its output voltage, its limits when they are verified, and the least input over
 * the output its output is given at (`gate`, the verified dropout, or a family's when the part's own is not looked up).
 */
function regSpec(value: string) {
  const v = value.toUpperCase().replace(/\s+/g, '')
  // a 1117's voltage: d.d(d) right after its package letters (AMS1117CD-3.3, LM1117MPX-3.3, 'LM1117 3.3V'), or one
  // digit after a dash (LM1117-5). Not two bare digits (ST12 is 12 V, S12 1.2 V by maker), not a package name
  // (AMS1117 SOT-223 read 2.2 V), never an ADJ (review of 2026-11-03). 3V3 is 3.3 here as in parseVolts and net names
  // (2026-11-06 sweep: AMS1117-3V3 read 3 V, and its right +3V3 net read '동작 안 됨'; 1V8 read 1 V, 2V5 2 V)
  const x1117 = /([A-Z]*)1117(?!SOT|TO)[A-Z]{0,4}(?:-?(\d\.\d{1,2})|-(\d))(?![\d.])/.exec(v.replace(/(\d)V(\d)/g, '$1.$2'))
  if (x1117 && !/ADJ/.test(v)) {
    const out = x1117[2] ?? x1117[3]
    // the AMS1117's limits are looked up
    if (x1117[1] === 'AMS') return { name: `AMS1117-${out}`, vout: Number(out), spec: SPECS.reg.AMS1117, gate: SPECS.reg.AMS1117?.dropout_max ?? null }
    // the other fixed 1117s keep their output voltage but get no verdict: with none, an LM1117-3.3's output had no
    // voltage and 0.1 Ω from it to GND went unseen (2026-11-03 tour, the power circuit of S28). Their output is given
    // only with the AMS1117's dropout over it, or the parts it feeds passed on 3.7 V in
    return { name: `${x1117[1]}1117-${out}`, vout: Number(out), spec: null, gate: SPECS.reg.AMS1117?.dropout_max ?? null }
  }
  const s78 = /(?:^|[^0-9])78(05|06|08|09|12|15)/.exec(v)
  // only the 7805's limits were looked up; other 78xx keep their output voltage but no verdict
  if (s78) return { name: `78${s78[1]}`, vout: Number(s78[1]), spec: s78[1] === '05' ? SPECS.reg.L7805 : null, gate: s78[1] === '05' ? SPECS.reg.L7805?.dropout_max ?? null : null }
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

/**
 * The signal level a header's value names. MCUs reach the board only through a header, so its value is the one word on
 * what the pin puts out: a 3.3 V chip or board (ESP32, ESP8266, STM32, RP2040/Pico, a Raspberry Pi or Jetson header),
 * a written level (3.3V, 3V3, 5V), or a 5 V board (Arduino Uno, Nano, Mega, ATmega328). The chip comes before the family
 * name (an Arduino Nano ESP32 or Nano 33 is 3.3 V, a Jetson Nano too) and a written level before a board's usual one.
 * A power header (PWR) or a motor is no signal, and a value naming both levels names none.
 * UNO, NANO and MEGA are a 5 V board only as the board itself: "Arduino" before the name at most, and after it nothing but
 * a revision, a written level or a pin. Any other word keeps both levels (UNO Q, Nano Matter, Orin Nano may be 3.3 V boards).
 * A written level is the signal's only on a header that carries no supply beside it and does not call itself one (VIN,
 * USB): there it is the supply's voltage, which says nothing of the signal's (2026-11-08 review: "5V_IN" on the relay's
 * +5V/IN/GND header passed a 3.3 V MCU's 1.5 kΩ base). A supply beside it is another pin on a net, not a ground, whose
 * voltage is known or whose name says supply, or that feeds anything but a transistor's base or gate (straight or through
 * a resistor): a load, another supply pin. Not by the name alone (second review of 2026-11-08: a motor's VM, V+, VMOT,
 * MOTOR_PWR on the header's other pin read its "5V" as the signal's and passed a 3.3 V MCU)
 */
const BOARD_TAIL = /^(R3|REV3|V3|2560|\d+V\d*|D\d{1,2}|A\d{1,2}|PIN\d*|PWM\d*|IO\d*|GPIO\d*|OUT\d*|SIG|SIGNAL|IN)$/
const SUPPLY_WORD = /^(VIN|VCC|VDD|VBUS|VBAT|USB|BATT?|BATTERY|SUPPLY)$/
/** the levels a text writes: 3.3V, 3V3, 5V, 5.0V */
const writtenLevels = (t: string) => {
  const s = t.toUpperCase()
  return { v33: /(?<![\d.])3(?:\.3\s*V|V3)(?!\d)/.test(s), v5: /(?<![\d.])5(?:\.0)?\s*V(?![\dA-Z])/.test(s) }
}
/** a transistor's base or gate pin */
const controlPin = (x: Ctx, nd: Node) => { const q = x.part(nd.ref); return !!q && (q.part === 'Q_NPN' || q.part === 'Q_NMOS') && nd.pin === 1 }
/** `by`: what the level is read from, for the basis ("J1 값 Arduino Uno") */
function headerLevel(x: Ctx, p: OpPart, signal: string): { v: 3.3 | 5; by: string } | null {
  if (!/^Conn_/.test(p.part) || isMotor(p) || /PWR|POWER|전원/i.test(p.value)) return null
  const s = p.value.toUpperCase()
  const level = (v: 3.3 | 5 | null, more = '') => (v == null ? null : { v, by: `${p.ref} 값 ${p.value}${more}` })
  if (/ESP-?32|ESP-?8266|STM32|RP2040|(?<![A-Z])PICO(?![A-Z])|RASPBERRY|JETSON|NANO\s*33/.test(s)) return level(3.3)
  const words = s.split(/[^A-Z0-9]+/).filter(Boolean)
  const at = words.findIndex(w => /^(UNO|NANO|MEGA|MEGA2560)$/.test(w))
  const board = at >= 0 && words.slice(0, at).every(w => w === 'ARDUINO') && words.slice(at + 1).every(w => BOARD_TAIL.test(w))
  // the chip with no board named around it (an Arduino Nano ATmega328 is still the 5 V board)
  const bare = at < 0 && /ATMEGA328/.test(s)
  const board5 = board || /ATMEGA328/.test(s)
  const { v33, v5 } = writtenLevels(s)
  // what a pin's net feeds, other than this header: only bases and gates (a signal), or anything else (a supply)
  const toControl = (nd: Node) => controlPin(x, nd) || (x.part(nd.ref)?.part === 'R' && x.on(x.other(nd.ref, nd.pin)).some(o => controlPin(x, o)))
  const feeds = (n: string) => x.on(n).some(nd => nd.ref !== p.ref && !toControl(nd))
  const supplyNet = (n: string) => n !== signal && x.on(n).some(nd => nd.ref === p.ref) && !x.isGnd(n) && voltsFromName(n) !== 0
    && (Math.abs(x.voltOf(n)?.v ?? 0) > 0.05 || !!x.blockedWhy(n) || (voltsFromName(n) ?? 0) > 0 || /VCC|VDD|VIN|VBUS|VBAT/i.test(n) || feeds(n))
  if (bare) {
    // a bare chip puts out the level of the supply it runs on, and an ATmega328P runs at 3.3 V as well as 5 V (2026-11-09
    // review: "ATmega328P" beside a +3V3 pin that lights an LED read as 5 V): the one level every supply pin of the header
    // is known at; a supply at another or an unknown voltage, or a written level against it, leaves both
    // with no supply pin beside it there is nothing to say which (third review of 11-09: no pin read as 5 V, an unknown one as either)
    const sup = x.nets().filter(supplyNet)
    if (!sup.length) return v33 !== v5 ? level(v33 ? 3.3 : 5) : null
    const one = ([3.3, 5] as const).find(l => sup.every(n => { const v = x.voltOf(n)?.v; return v != null && Math.abs(v - l) <= 0.05 }))
    return one != null && !(one === 3.3 ? v5 : v33) ? level(one, `, 같은 커넥터의 ${V(one)} 전원으로 도는 칩`) : null
  }
  if (!v33 && !v5) return level(board5 ? 5 : null)
  if (words.some(w => SUPPLY_WORD.test(w)) || /배터리/.test(s) || x.nets().some(supplyNet)) return level(board5 && v5 && !v33 ? 5 : null)
  return level(v33 && v5 ? null : v33 ? 3.3 : 5)
}

// ── circuit index and supplies ─────────────────────────────────────────────────

interface Node { ref: string; pin: number }
interface Volt {
  v: number; why: string; src: 'name' | 'battery' | 'reg'
  /** the lowest it can be, when lower than v (after a series diode's forward drop) */
  lo?: number
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
  const loose: { ref: string; nets: string[]; why: string }[] = []
  for (const bt of b.of('Battery')) {
    const plus = b.net(bt.ref, 1), minus = b.net(bt.ref, 2), v = parseVolts(bt.value)
    if (!plus && !minus) continue
    if (v == null) {
      // a value with no voltage in it: the nets it feeds have no voltage we can trust (not even their names)
      issues.push({ rule: 'op_power', ref: bt.ref, state: 'unknown', summary: `${bt.ref} 값 ${val(bt.value)}에서 전압을 읽지 못했습니다`,
        detail: ['값에 전압을 적어야 합니다 (예: 9V, 3.7V, 2x1.5V)'] })
      loose.push({ ref: bt.ref, nets: [plus, minus].filter((n): n is string => !!n), why: `${bt.ref} 값 ${val(bt.value)}에서 전압을 읽지 못해 이 넷의 전압을 모릅니다` })
      continue
    }
    if (!plus || !minus) {
      const which = !plus ? '+' : '−'
      issue(bt.ref, `${bt.ref} ${which} 단자가 어디에도 연결되어 있지 않아 전류가 흐르지 않습니다`, [`${bt.ref} ${which} 단자(${!plus ? 1 : 2}번 핀)가 어느 넷에도 없습니다`])
      loose.push({ ref: bt.ref, nets: [plus ?? minus!], why: `${bt.ref} 단자가 떠 있어 이 넷에 전원이 없습니다` })
      continue
    }
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
      loose.push({ ref: bt.ref, nets: [plus, minus], why: `${bt.ref} 단자가 떠 있어 이 넷에 전원이 없습니다` })
      continue
    }
    edges.push({ ref: bt.ref, plus, minus, dv: v })
  }
  // the loose battery's nets lose their voltage, unless a connector, a regulator or another battery feeds them
  for (const l of loose) for (const n of l.nets) {
    if (!hasConn(n) && !regOut(n) && !edges.some(e => e.plus === n || e.minus === n)) blocked.set(n, { why: l.why, cause: l.ref })
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

  // A GND-named net that no battery reaches and nothing else feeds (no connector) cannot return current to a battery
  // whose group has no GND of its own, nor to the supply's ground when it is a second ground beside it (2026-11-06 sweep:
  // the battery's − on GND, the LEDs' cathodes on an AGND joined to nothing read '동작 검사 통과'). Joined to that ground by
  // a net tie (a resistor of 1 Ω or less, or one with no value to judge), an inductor, or what the circuit is judged with
  // closed or on (a switch, a relay's contact, a transistor), it is the same ground. With no battery or connector on any
  // ground there is nothing to be cut off from: the names stand.
  const grounds = [...named.keys()].filter(n => named.get(n) === 0)
  const supplyGrounds = grounds.filter(n => volts.has(n) || hasConn(n))
  const returns = new Set([...supplyGrounds, ...edges.filter(e => noGround.includes(e.ref)).map(e => e.minus)])
  const tiePins = (p: OpPart): [number, number][] => {
    if (p.part === 'L' || p.part === 'SW') return [[1, 2]]
    if (p.part === 'R') { const r = parseOhms(p.value); return r == null || r <= 1 ? [[1, 2]] : [] }
    if (p.part === 'Relay') return [[3, 4], [3, 5]]
    return p.part === 'Q_NPN' || p.part === 'Q_NMOS' ? [[2, 3]] : []
  }
  const ties = b.parts().flatMap(p => tiePins(p).map(([a, z]) => [b.net(p.ref, a), b.net(p.ref, z)] as const))
  for (let grew = true; grew;) {
    grew = false
    for (const [a, z] of ties) if (a && z && returns.has(a) !== returns.has(z)) { returns.add(a); returns.add(z); grew = true }
  }
  const deadGround = returns.size ? grounds.filter(n => !returns.has(n) && !blocked.has(n)) : []
  if (deadGround.length && noGround.length) {
    issue(noGround[0], `${noGround.join('·')} 배터리가 ${deadGround.slice(0, 3).join(', ')} 넷과 이어져 있지 않습니다: 이 넷에 연결된 부품은 배터리로 전류가 돌아가지 못합니다`,
      ['배터리 − 단자를 GND 넷에 연결해야 합니다', `${deadGround.join(', ')}의 전압은 이름만 보고 정하지 않습니다`])
    for (const n of deadGround) blocked.set(n, { why: `${ga(n)} 배터리와 이어져 있지 않습니다`, cause: noGround[0] })
  } else if (deadGround.length) {
    const main = supplyGrounds[0]
    const owner = edges[0]?.ref ?? b.on(main).find(nd => { const p = b.part(nd.ref); return !!p && /^Conn_/.test(p.part) && !isMotor(p) })!.ref
    issue(owner, `${deadGround.slice(0, 3).join(', ')} 넷이 전원 쪽 ${wa(main)} 이어져 있지 않습니다: 이 넷에 연결된 부품은 전원으로 전류가 돌아가지 못합니다`,
      [`${deadGround.join(', ')} 넷을 ${main}에 바로 잇거나, 0 Ω 저항이나 인덕터로 이어야 합니다`, `${deadGround.join(', ')}의 전압은 이름만 보고 정하지 않습니다`])
    for (const n of deadGround) blocked.set(n, { why: `${ga(n)} 전원 쪽 ${wa(main)} 이어져 있지 않습니다`, cause: owner })
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
  /** a transistor's collector/drain or a 555 output: pulled down while on, not a supply rail */
  const switchedNet = (n: string) => b.on(n).some(nd => { const p = b.part(nd.ref)?.part; return ((p === 'Q_NPN' || p === 'Q_NMOS') && nd.pin === 2) || (p === 'NE555' && (nd.pin === 3 || nd.pin === 7)) })
  /** a relay coil or a motor between these two nets (a diode across it is a flyback diode, the flyback rule's) */
  const acrossLoad = (n1: string, n2: string) => b.parts().some(p => (p.part === 'Relay' || isMotor(p)) &&
    [b.net(p.ref, 1), b.net(p.ref, 2)].includes(n1) && [b.net(p.ref, 1), b.net(p.ref, 2)].includes(n2))
  /** a diode whose anode net has a voltage and whose cathode net has no source of its own passes it on */
  const diodes = () => {
    let changed = false
    for (const d of b.of('D')) {
      const a = b.net(d.ref, 1), k = b.net(d.ref, 2)
      if (!a || !k || a === k) continue
      const va = known(a)
      if (!va || volts.has(k) || blocked.has(k) || ownRail(k) || hasConn(k) || regOut(k) || batteryNet(k)) continue
      if (va.v <= 0 || switchedNet(k) || acrossLoad(a, k)) continue
      const spec = SPECS.diode[d.value.toUpperCase().replace(/\s+/g, '')]
      if (!spec) { blocked.set(k, { why: `${d.ref}(${d.value || '값 없음'})의 순방향 전압 자료가 없어 ${k} 전압을 모릅니다`, cause: d.ref }); changed = true; continue }
      volts.set(k, { v: va.v, lo: (va.lo ?? va.v) - spec.vf_max.v, src: va.src, why: `${va.why} → ${d.ref} 순방향 (VF 0~${V(spec.vf_max.v)}: ${spec.vf_max.src})`,
        ...(va.viaSwitch ? { viaSwitch: va.viaSwitch } : {}), ...(va.cause ? { cause: va.cause } : {}) })
      changed = true
    }
    return changed
  }
  for (let guard = 0, assume = false; guard < 50; guard++) {
    let changed = carry(known)
    if (diodes()) changed = true
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
      // after a series diode the input can be as low as its forward drop allows
      const vinLo = i ? volts.get(i)?.lo ?? vin : vin
      if (!force && vinLo != null && reg.gate && vinLo - gv - reg.vout < reg.gate.v - 1e-9) {
        blocked.set(o, { why: `${r.ref} 입력이 모자라 출력 ${V(reg.vout)}를 보장하지 못합니다 (레귤레이터 전압 참고${reg.spec ? '' : `, 이 부품의 수치가 없어 같은 1117 계열인 AMS1117의 최소 전압 차 ${V(reg.gate.v)} 기준`})`, cause: r.ref })
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
    const back = hasConn(n) || regOut(n) || batteryNet(n) ? undefined
      : b.of('D').find(d => {
        // its cathode on a net a real source holds at about this net's voltage: the diode was meant to feed it
        const kv = volts.get(b.net(d.ref, 2) ?? ''), want = named.get(n)!
        return b.net(d.ref, 1) === n && want > 0 && !!kv && kv.src !== 'name' && kv.v >= want - 0.05 && kv.v <= want + 2
      })
    if (k) blocked.set(n, { why: `${k} 접점이 열려 있어 ${n}에 전원이 없습니다`, cause: k, open: true })
    else if (back) blocked.set(n, { why: `${ga(back.ref)} 거꾸로라(캐소드가 전원 쪽) ${n}에 전원이 없습니다`, cause: back.ref })
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
      if ((vcc.lo ?? vcc.v) < t.vcc_min.v || vcc.v > t.vcc_max.v) {
        return { ref: p.ref, level: null, why: `${p.ref} 전원 ${V(vcc.v)}가 동작 범위 밖이라 출력 전압을 계산하지 않았습니다 (555 타이머 참고)`, cause: p.ref }
      }
      const d = t.voh_drop.v
      return { ref: p.ref, why: '', level: { lo: (vcc.lo ?? vcc.v) - d, hi: vcc.v, cause: vcc.cause, why: `${p.ref} 출력 높음 ${V(vcc.v - d)}~${V(vcc.v)}: VCC ${V(vcc.v)}에서 강하 0~${V(d)} (${t.voh_drop.src})` } }
    }
    return null
  }

  /** what drives this node high: a supply or a 555 output */
  const source = (n: string | null): Level | null => {
    const v = voltOf(n)
    if (v) return { lo: v.lo ?? v.v, hi: v.v, why: v.why, ...(v.cause ? { cause: v.cause } : {}) }
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

/** `signal`: an assumed level (the signal voltage is not known); `named`: a signal whose level its header names */
interface Cand { label: string; lv: Level; signal: boolean; named?: boolean }
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
  motor?: boolean
  /** a motor's rated voltage from its value ("MOTOR 3V 0.1A") */
  ratedV?: number
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
  /** a MOSFET's lowest gate-source voltage while on, when it is known (the RDS(on) row its heat is reckoned with) */
  vgsLo?: number
}

const loadI = (loads: Load[], d: number) => loads.reduce((s, l) =>
  s + (l.kind === 'fixed' ? l.i! : l.kind === 'res' && l.rLo! > 0 ? Math.max(0, (l.src!.hi - l.vf! - d) / l.rLo!) : 0), 0)
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
  if (src.hi - vf <= 0) return { ...l, kind: 'fixed' as const, i: 0 }
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
    if (p.part === 'C' || p.part === 'CP' || p.part === 'LED' || (p.part === 'Q_NMOS' && nd.pin === 1)) continue     // decoupling; an LED anode here points the wrong way (LED rule)
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
      const i0 = parseAmps(p.value), sup = x.source(x.net(p.ref, nd.pin === 1 ? 2 : 1)), rated = parseVolts(p.value)
      // above its rated voltage a motor draws more: taken as in proportion to the voltage (a rough figure)
      const scale = rated != null && rated > 0 && sup && sup.hi > rated ? sup.hi / rated : 1
      const extra = { motor: true, ...(sup ? { supply: sup } : {}), ...(rated != null && rated > 0 ? { ratedV: rated } : {}) }
      if (i0 != null) loads.push({ label: `${p.ref} 모터`, kind: 'fixed', i: i0 * scale, ...extra,
        note: scale > 1 ? `${p.ref} 값 ${p.value}: 정격 ${V(rated!)}에 ${V(sup!.hi)}가 걸려 전류를 ${mA(i0)} × ${scale.toFixed(2)} = 대략 ${mA(i0 * scale)}로 봄 (전압에 비례한다고 본 어림)` : `${p.ref} 값 ${p.value}에 적힌 전류` })
      else loads.push({ label: `${p.ref} 모터`, kind: 'unknown', ...extra, note: `${p.ref} (${p.value}): 값에 모터 전류를 적으면 판단합니다 (예: MOTOR 0.3A)` })
      continue
    }
    loads.push({ label: p.ref, kind: 'unknown', note: `${p.ref} (${p.value || p.part})` })
  }
  return loads
}

const signalCands = (): Cand[] => SIGNAL_CANDIDATES.map(v => ({ label: V(v), lv: { lo: v, hi: v, why: `신호 전압 모름 → ${V(v)} 가정` }, signal: true }))
/**
 * The signal on these nodes from the parts that drive it: the one level their headers all name, else both candidates
 * (a header naming none, two naming different levels, or a driving part that is not a header).
 */
function signalOn(x: Ctx, net: string, skip: string): Cand[] {
  const parts = [...new Map(x.on(net).filter(n => n.ref !== skip).map(n => [n.ref, x.part(n.ref)] as const)).values()]
    .filter((p): p is OpPart => !!p && isExternal(p))
  if (!parts.length) return signalCands()
  const one = (v: 3.3 | 5, by: string): Cand[] => [{ label: V(v), lv: { lo: v, hi: v, why: `${by} → ${V(v)} 신호로 계산` }, signal: false, named: true }]
  // the signal net's own name, when it writes 3.3 V alone, is that pin's level before any name of the board (2026-11-09
  // review: a pin on VCC_3V3, 3V3_OUT or IOREF_3V3 of an "Arduino Uno" header read as 5 V). Only ever lowering it: a 5 V in
  // the name is as often the load's (PWM_5V, FAN_5V_CTRL) and lifted an ESP32's 3.3 V pin to 5 V (third review of 11-09)
  const own = writtenLevels(net)
  if (own.v33 && !own.v5) return one(3.3, `${parts.map(p => p.ref).join(', ')} 핀의 넷 이름 ${net}`)
  const levels = parts.map(p => headerLevel(x, p, net))
  const v = levels[0]?.v
  if (v == null || levels.some(l => l?.v !== v)) return signalCands()
  return one(v, levels.map(l => l!.by).join(', '))
}

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
    if (far.some(n => { const p = x.part(n.ref); return !!p && isExternal(p) })) { out.fromSignal = true; out.cands = signalOn(x, d.from, d.r.ref); return out }
    return fail('unknown', `${q.ref} ${word} 저항 ${d.r.ref} 반대쪽 ${d.from}의 전압을 알 수 없습니다`)
  }
  if (external) {
    if (kind === 'bjt') return fail('error', `${q.ref} 베이스에 저항 없이 외부 신호가 바로 연결되어 베이스 전류가 제한되지 않습니다`)
    out.fromSignal = true; out.cands = signalOn(x, ctl, q.ref); return out
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
    // the source rises by the sense resistor's drop. With the load's current unknown that drop lies anywhere between none
    // and the part's rated current: judged at both ends, and a verdict that differs between them is not known (2026-11-08
    // review: 0.1 Ω at IRLZ44N's 47 A read as a 4.7 V drop and "켜지지 않을 수 있습니다" for a motor that may draw 1 A)
    const bound = senseBound(sw)
    const iS = known ? loadI(sw.loads, 0) : bound.i
    const vSmax = sw.sense.ohms * iS
    // gate voltages written so that 4.995 V never reads as the 5 V it falls short of. A gate the sense drop takes below 0 V
    // is written as "0 V 이하": no such current flows with the switch on (2026-11-08 second review: "VGS -1.43 V" at ID max)
    const gv = (v: number, ref: number) => (v < 0 ? '0 V 이하' : two(v, ref, V)[0])
    const vgAt = (l: { lo: number; hi: number }, ref: number) => (l.lo < 0 ? (l.hi < 0 ? gv(l.hi, ref) : `${gv(l.lo, ref)}~${gv(l.hi, ref)}`)
      : span(l.lo, l.hi, v => gv(v, ref)))
    const vg = (l: { lo: number; hi: number }) => vgAt(l, rated)
    // `edge`: the end with no sense drop, which a load that draws any current at all only comes near. A gate that meets the
    // guarantee or the threshold there only by being equal to it falls short of it once current flows (2026-11-09 review:
    // "부하가 0 mA 이하면" and "-0 µA 이하면" for a gate right at 5 V or at the threshold)
    const judge = (vS: number, edge = false) => {
      const why = [div < 1 ? `${sw.drive!.r.ref}/${sw.pull!.r.ref} 분압` : '', vS > 0 ? `감지 저항 ${sw.sense.ref}` : ''].filter(Boolean).join('·')
      const meets = (g: number, level: number) => atLeast(g, level) && !(edge && atLeast(level, g))
      const per = sw.cands.map(cd => {
        const vgs = { lo: cd.lv.lo * div - vS, hi: cd.lv.hi * div }
        // shown with the sense drop taken off both ends; the top end without it is only for the maximum rating
        const shown = { lo: vgs.lo, hi: Math.max(vgs.lo, cd.lv.hi * div - vS) }
        const over = atLeast(vgs.hi, spec.vgs_max.v)
        const state: OpState = over ? 'error' : meets(vgs.lo, rated) ? 'pass' : meets(vgs.lo, th) ? 'warn' : 'error'
        const atEdge = !over && (state === 'warn' ? atLeast(vgs.lo, rated) : state === 'error' && atLeast(vgs.lo, th))
        const word = (over ? `최대 정격 ${V(spec.vgs_max.v)} 이상` : state === 'pass' ? '완전히 켜짐'
          : state === 'warn' ? '문턱은 넘지만 켜짐 저항 보장 전압 미만' : '켜지지 않을 수 있음')
          + (atEdge ? ` (게이트가 ${state === 'warn' ? `보장 전압 ${wa(V(rated))}` : `문턱 ${wa(V(th))}`} 같아 전류가 조금이라도 흐르면 그보다 낮아집니다)` : '')
        const lossy = why !== '' && atLeast(cd.lv.lo, rated) && !atLeast(vgs.lo, rated)
        const below = shown.lo < 0 ? `, 강하 ${V(vS)} > ${V(cd.lv.lo * div)}` : ''
        return { cd, vgs, shown, state, lossy, over, atEdge, line: `${cd.label}: VGS ${vg(shown)}${why ? ` (${why}${below})` : ''} → ${word}` }
      })
      const state: OpState = per.some(p => p.over) ? 'error' : per.every(p => p.state === 'pass') ? 'pass'
        : per.some(p => p.state === 'pass') ? 'warn' : per.every(p => p.state === 'error') ? 'error' : 'warn'
      return { vS, why, per, state }
    }
    const worst = judge(vSmax)
    const unsure = !known && !clamp && vSmax > 0 && sw.loads.some(l => l.kind === 'unknown')
    const best = unsure ? judge(0, true) : worst
    // the end with the most current: the part's rating, or what the load's supply drives through the sense resistor alone
    const maxEnd = bound.rating ? 'ID 최대' : `부하 ${mA(iS)}(${bound.why})`
    const head = [
      `게이트 문턱 최대 ${V(th)}: ${cite(spec.vgs_th_max)}`,
      `켜짐 저항 보장: VGS ${V(rated)}에서 RDS(on) 최대 ${ohm(spec.rds_on.v)} (${cite(spec.rds_on)})`,
      `게이트 최대 ${V(spec.vgs_max.v)}: ${cite(spec.vgs_max)}`,
      ...sw.cands.filter(cd => !cd.signal).map(cd => `구동 전압: ${cd.lv.why}`),
    ]
    // compared signal by signal: two ends that differ for any signal are not known, even when the merged verdicts happen
    // to agree (2026-11-08 second review: R2 0.05 Ω read "warn" at ID max for both ends, 0.1 Ω read 판단 불가)
    const differs = (i: number) => best.per[i].state !== worst.per[i].state
    if (best.per.some((_, i) => differs(i))) {
      const R = sw.sense.ohms
      // the largest load current at which each signal that changes still does what it does with no drop
      const upto = best.per.filter((p, i) => p.state !== 'error' && differs(i)).map(p => {
        const i = down((p.cd.lv.lo * div - (p.state === 'pass' ? rated : th)) / R)
        return `부하가 ${mA(i)} 이하면 ${p.cd.label}${p.cd.signal || p.cd.named ? ' 신호' : ' 구동'}에서 ${p.state === 'pass' ? '완전히 켜집니다' : `${eul(`문턱 ${V(th)}`)} 넘습니다`}.`
      })
      // a gate with no pull-down floats whatever the load draws: said here too, as its own fault (2026-11-09 review: it
      // showed only once a current was written)
      const floats = !sw.pull && ctlInfo.fromSignal
      verdict(floats ? 'warn' : 'unknown', `${q.ref} 부하 전류를 몰라 감지 저항 ${sw.sense.ref}의 전압 강하를 알 수 없어 켜짐을 판단할 수 없습니다${floats ? ' · 풀다운 저항 없음' : ''}`, [
        ...head,
        `소스 감지 저항 ${sw.sense.ref} ${ohm(R)} × 부하 0~${bound.rating ? `ID 최대 ${mA(iS)}` : `${mA(iS)}(${bound.why})`} = 0~${V(vSmax)}만큼 구동 전압이 줄어듭니다 (부하 전류를 몰라 0부터 ${bound.rating ? '정격' : '가장 큰 전류'}까지)`,
        ...best.per.map(p => `강하 0이면 ${p.line}`), ...worst.per.map(p => `${maxEnd}면 ${p.line}`), ...upto,
        ...(floats ? ['게이트 풀다운이 없으면 입력이 끊겼을 때 게이트가 떠서 저절로 켜질 수 있습니다'] : []),
      ], floats ? undefined : q.ref)
      if (!floats) sw.result.causeRule = 'op_switch'
      sw.result.fix = `${floats ? '게이트와 GND 사이에 10 kΩ 저항을 답니다. ' : ''}부하 값에 전류를 적으면(예: MOTOR 0.1A) 감지 저항 ${sw.sense.ref}의 전압 강하로 다시 판단합니다.${upto.length ? ` ${upto.join(' ')}` : ''}`
      sw.offWhy = `${q.ref} 부하 전류를 몰라 켜졌을 때의 전압 강하를 계산하지 않았습니다`
      continue
    }
    // the same verdict at both ends: shown at the end that decides it (an unknown drop cannot make "켜지지 않음" truer), but
    // not where that end only fails by being right at the threshold ("3 V < 문턱 최대 3 V"): there the drop is what decides
    const J = unsure && worst.state === 'error' && !best.per.some(p => p.atEdge) ? best : worst
    const { why, per } = J
    // the gate at the end with the most current: with an unknown load the lowest it can be, so the RDS(on) row its heat is
    // reckoned with is one the gate surely reaches (2026-11-09 review: 9.65 V passed, and the heat still took the 4 V row
    // "게이트에 4 V 이상이 걸리면")
    sw.vgsLo = Math.min(...worst.per.map(p => p.vgs.lo))
    const lines = [
      ...head,
      ...(J !== worst ? [`부하 전류를 몰라 소스 감지 저항 ${sw.sense.ref}의 강하(최대 ${V(vSmax)})를 빼고 계산해도 켜지지 않습니다`]
        : senseLine(J.vS, known ? `부하 ${mA(iS)}` : bound.rating ? `ID 최대 ${mA(iS)}(부하 전류를 몰라 정격으로 계산)` : `부하 ${mA(iS)}(부하 전류를 몰라 ${ro(bound.why)} 계산)`)),
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
    let state: OpState, summary: string, fix: string | undefined
    // what to change for a gate short of this part's guarantee, said for the signal it comes from (2026-11-08 review).
    // First what takes the signal down and is worth changing: a divider worse than 100 Ω : 10 kΩ, a sense resistor dropping
    // 1 % of the signal at a known load. Then, for the gate those leave, the part of the table that it turns fully on and
    // whose limits hold (the load with no heatsink), the board's own seat first; with the load unknown, every such part
    // and what it stands. Else a logic-level part from outside the table, a gate driver, or an NPN stage that puts the load's
    // supply on the gate, under 90 % of the gate's maximum. A gate driver IC is not a part the app places
    // (server/pcb/footprints_table.py)
    const lowest = Math.min(...MOS_NAMES.map(n => SPECS.mos[n].vgs_rated.v))
    const lowName = MOS_NAMES.find(n => SPECS.mos[n].vgs_rated.v === lowest)!
    const tops = sw.loads.map(l => (l.supply ?? l.src)?.hi).filter((v): v is number => v != null)
    const top = tops.length ? Math.max(...tops) : null
    const liftMax = NEAR * spec.vgs_max.v
    const lift = top != null && atLeast(top, rated) && !atLeast(top, liftMax) ? `${V(top)} 전원` : `${V(rated)} 이상 ${V(liftMax)} 미만의 전원`
    const loadA = known ? loadI(sw.loads, 0) : null
    const seat = x.style === 'tht' ? 'TO-92' : x.style === 'smd' ? 'SOT-23' : null
    const seats = (n: string) => (seat ? MOS_PKG[n] === seat : MOS_PKG[n] !== 'TO-220')
    // parts of the table the board's own transistor seat does not take, said wherever one is offered (2026-11-08 second
    // review: the list for an unknown load offered TO-92 2N7000 first on an SMD board without a word)
    const misfit = (ns: string[]) => {
      const off = ns.filter(n => !seats(n))
      return off.length ? `${off.map(n => `${eun(n)} ${MOS_PKG[n] === 'TO-220' ? '큰 TO-220' : MOS_PKG[n]}`).join(', ')} 부품이라 기판의 ${seat ? `${seat} ` : '작은 '}트랜지스터 자리에는 그대로 맞지 않습니다` : ''
    }
    const pkgNote = (n: string) => (seats(n) ? '' : ` (${misfit([n])})`)
    /** what a part stands with its gate at `vgs` (the RDS(on) row guaranteed there, for a TO-220 with no heatsink) */
    const stands = (n: string, vgs: number) => { const h = mosHeat(SPECS.mos[n], 0, vgs); return h ? `방열판 없이 대략 ${mA(down(h.iAir))}까지` : `${mA(SPECS.mos[n].id_max.v)}까지` }
    const advise = (p: (typeof per)[number]): string | null => {
      const sig = p.cd.signal || !!p.cd.named
      const what = sig ? `${p.cd.label} 신호` : `게이트를 구동하는 ${p.cd.label}`
      const from = p.cd.lv.lo
      const vS = loadA != null ? sw.sense.ohms * loadA : 0
      const divBad = div < 1 && !atLeast(div, 100 / 101)
      const senseBad = vS > 0 && atLeast(vS, 0.01 * from)
      const divAfter = divBad ? 100 / 101 : div
      // the gate once those are changed (the sense drop taken as gone)
      const reach = from * divAfter - (senseBad ? 0 : vS)
      const divWay = divBad ? `게이트 저항 ${eul(sw.drive!.r.ref)} 풀다운 ${sw.pull!.r.ref}의 1/100 이하로(예: 100 Ω과 10 kΩ)` : ''
      const senseWay = (r: number | null) => `감지 저항 ${eul(sw.sense.ref!)} ${r != null ? `${ohm(r)} 이하로` : '더 작은 값으로'}`
      type Plan = { div: boolean; sense: number | null; gate: number }
      // the fewest of those changes that bring the gate to `at` (the guarantee of the part it ends with): none, the divider,
      // the sense resistor sized for `at` (always below what it is), or both; and the gate they leave. Null when they cannot
      // (2026-11-08 second review: "RS를 0.316 Ω 이하로 줄이고" for an RS of 0.05 Ω that IRLZ44N turns on with as it is)
      // with the load's current unknown a sense resistor takes some drop off the gate: a gate equal to `at` with none falls
      // short of it once current flows (judge's edge)
      const gets = (g: number, at: number) => atLeast(g, at) && !(loadA == null && sw.sense.ohms > 0 && atLeast(at, g))
      const plan = (at: number): Plan | null => {
        if (gets(from * div - vS, at)) return { div: false, sense: null, gate: from * div - vS }
        if (divBad && gets(from * divAfter - vS, at)) return { div: true, sense: null, gate: from * divAfter - vS }
        if (!senseBad) return null
        const alone = down((from * div - at) / loadA!)
        if (alone > 0) return { div: false, sense: alone, gate: at }
        const both = down((from * divAfter - at) / loadA!)
        return divBad && both > 0 ? { div: true, sense: both, gate: at } : null
      }
      const say = (pl: Plan) => [pl.div ? divWay : '', pl.sense != null ? senseWay(pl.sense) : ''].filter(Boolean)
      const leadBy = (d: boolean, s: boolean) => {
        // the gate shown is after the sense drop too: named beside the divider whenever there is one
        const by = [d ? `${sw.drive!.r.ref}/${sw.pull!.r.ref} 분압` : '', s || (d && J.vS > 0) ? `감지 저항 ${sw.sense.ref}` : ''].filter(Boolean).join('·')
        return by ? `${eun(what)} ${ro(by)} 게이트에 ${vg(p.shown)}만 걸립니다. ` : ''
      }
      // not sized (the load's current unknown, or no size that does it): every change worth making, said without a value
      const vagueWays = [divWay, senseBad ? senseWay(null) : ''].filter(Boolean)
      const vagueLead = leadBy(divBad, senseBad)
      // what the changes can do is what plan() sizes: `reach` is only the bound a sense resistor of 0 Ω would give, which no
      // value reaches, so a gate that meets a guarantee only there is not brought to it (2026-11-09 review: a 5 V gate on
      // 2N7002 with RS 1 Ω was told "RS를 더 작은 값으로" and NDS7002A, which no RS turns fully on)
      // what a part makes of the known load with the gate a plan leaves, as op_switch would judge it: 'ok' with no heatsink,
      // 'sink' with one, 'never' even so. Said with the plan, and a part that never stands it is not offered (third review of
      // 11-09: the own part's divider fix left a 45 A load at 159 W, and IRLZ44N, which a heatsink lets carry 10 A, was struck)
      const heatFit = (s: MosSpec, vgs: number): 'ok' | 'sink' | 'never' => {
        if (loadA == null || standsAlone(s, loadA, vgs)) return 'ok'
        const h = mosHeat(s, loadA, vgs)
        return atLeast(loadA, s.id_max.v) || (h && atLeast(h.p, h.pCase)) ? 'never' : 'sink'
      }
      const sinkNote = (s: MosSpec, vgs: number) => {
        if (heatFit(s, vgs) !== 'sink') return ''
        const h = mosHeat(s, loadA!, vgs)
        return h ? ` 부하 ${mA(loadA!)}에서는 발열이 대략 ${W(h.p)}라 방열판이 필요합니다 (스위치 전류 한계 참고).`
          : ` 부하 ${mA(loadA!)}는 정격 ${mA(s.id_max.v)}에 가깝습니다 (스위치 전류 한계 참고).`
      }
      const own = plan(rated)
      if (own && !say(own).length) return null
      if (own && heatFit(spec, own.gate) !== 'never') return `${leadBy(own.div, own.sense != null)}${say(own).join(' 줄이고, ')} 줄이면 됩니다.${sinkNote(spec, own.gate)}`
      const onAt = MOS_NAMES.filter(n => SPECS.mos[n] !== spec && plan(SPECS.mos[n].vgs_rated.v) != null)
      // the gate another part would see: what the changes leave at a known load; else the signal through the divider, or
      // that part's own lowest guarantee when a sense resistor takes an unknown drop off it
      const gateFor = (n: string) => {
        const at = SPECS.mos[n].vgs_rated.v
        return loadA != null ? plan(at)?.gate ?? at : sw.sense.ohms > 0 ? at : reach
      }
      const fails = (n: string) => {
        const s = SPECS.mos[n]
        return [atLeast(p.cd.lv.hi, s.vgs_max.v) ? `게이트 최대 ${V(s.vgs_max.v)}` : '', top != null && atLeast(top, s.vds_max.v) ? `드레인 최대 ${V(s.vds_max.v)}` : '',
          heatFit(s, gateFor(n)) === 'never' ? `부하 ${mA(loadA!)}, 방열판을 달아도 견디지 못함` : ''].filter(Boolean)
      }
      // the board's own seat first, then the part that asks the fewest other changes
      const changes = (n: string) => { const pl = plan(SPECS.mos[n].vgs_rated.v); return pl ? say(pl).length : 0 }
      const fit = onAt.filter(n => !fails(n).length)
        .sort((a, b) => Number(seats(b)) - Number(seats(a)) || Number(heatFit(SPECS.mos[a], gateFor(a)) !== 'ok') - Number(heatFit(SPECS.mos[b], gateFor(b)) !== 'ok')
          || changes(a) - changes(b) || PKG_ORDER.indexOf(MOS_PKG[a]) - PKG_ORDER.indexOf(MOS_PKG[b]))
      if (fit.length && loadA != null) {
        const n = fit[0], at = SPECS.mos[n].vgs_rated.v
        const pl = plan(at)
        const ways = pl ? say(pl) : vagueWays
        return `${pl ? leadBy(pl.div, pl.sense != null) : vagueLead}${ira(what)}면 ${ways.map(w => `${w} 줄이고, `).join('')}켜짐 저항이 ${V(at)}에서 보장되는 ${ro(n)} 바꾸면 됩니다${pkgNote(n)}.${sinkNote(SPECS.mos[n], gateFor(n))}`
      }
      if (fit.length) {
        const off = misfit(fit)
        return `${vagueLead}${ira(what)}면 ${vagueWays.length ? `${vagueWays.join(' 줄이고, ')} 줄인 뒤 ` : ''}부품표에서 완전히 켜지는 것은 `
          + `${fit.map(n => `${n}(${V(SPECS.mos[n].vgs_rated.v)}에서 보장, ${MOS_PKG[n]}, ${stands(n, gateFor(n))})`).join(', ')}입니다. ${off ? `${off}. ` : ''}`
          + '부하 전류를 몰라 어느 것이 견디는지는 판단하지 못했습니다. 부하 값에 전류를 적으면(예: MOTOR 0.1A) 다시 판단합니다.'
      }
      const mid = vagueWays.length ? `${vagueWays.join(' 줄이고, ')} 줄이면 게이트가 ${V(reach)} 가까이 오릅니다. ` : ''
      const none = onAt.length
        ? `부품표에서 ${ro(what)} 완전히 켜지는 ${onAt.join('·')}도 이 회로를 견디지 못합니다 (${onAt.map(n => `${n}: ${fails(n).join(', ')}`).join('; ')})`
        : `${ro(what)}는 앱 부품표의 어느 MOSFET도 켜짐 저항을 보장하지 않습니다 (가장 낮은 보장 전압은 ${lowName}의 ${V(lowest)})`
      const g = V(reach)
      const part = reach > 0 ? `${onAt.length ? '이 회로를 견디고 ' : ''}데이터시트에 VGS ${reach > 2.5 && g !== V(2.5) ? `2.5~${g}` : `${g} 이하`}의 RDS(on)이 적힌 논리 레벨 MOSFET을 고르거나` : ''
      return sig
        ? `${vagueLead}${mid}${none}. ${part ? `${part}, ` : ''}신호와 게이트 사이에 게이트 드라이버를 넣거나, 작은 NPN 트랜지스터로 ${eul(lift)} 게이트에 걸어 줍니다 (이때는 신호가 HIGH일 때 꺼지는 반대 동작이 됩니다).`
        : `${vagueLead}${mid}${none}. ${part ? `${part} ` : ''}${ro(lift)} 게이트를 구동합니다.`
    }
    const advice = (ps: typeof per) => [...new Set(ps.map(advise).filter((s): s is string => !!s))].join(' ')
    // a gate voltage beside the threshold, written so the two never read the same; a range across the threshold is said
    // by its lowest end, the one that falls short ("3.27~4.95 V < 4 V" read as a false inequality, 2026-11-08 review)
    const thV = (p: (typeof per)[number]) => (atLeast(p.shown.hi, th) && !atLeast(p.shown.lo, th) ? `최저 ${gv(p.shown.lo, th)}`
      : vgAt(p.shown, th))
    if (over) {
      const [a, b] = two(over.vgs.hi, spec.vgs_max.v, V)
      state = 'error'; summary = `${q.ref} 게이트 ${a} ≥ 최대 ${b}: 게이트가 파괴될 수 있습니다`
    } else if (passing.length === per.length) { state = 'pass'; summary = `${q.ref} 완전히 켜짐 (VGS ${vgsList} ≥ ${V(rated)})` }
    else if (passing.length) {
      state = 'warn'
      summary = `${q.ref}: ${passing.map(p => p.cd.label).join(', ')} 신호에서만 완전히 켜집니다 (${per.filter(p => p.state !== 'pass').map(p => `${p.cd.label} → VGS ${vg(p.shown)}`).join(', ')})`
      fix = `${passing.map(p => p.cd.label).join(', ')} 신호로 구동하면 됩니다. ${advice(per.filter(p => p.state !== 'pass'))}`.trim()
    } else if (per.every(p => p.state === 'error')) {
      state = 'error'; summary = `${q.ref} 게이트 ${per.map(thV).join(' / ')} < 문턱 최대 ${V(th)}: 켜지지 않을 수 있습니다`
      fix = advice(per) || undefined
    } else {
      state = 'warn'
      // some signals under the threshold, the rest over it but under the guarantee: each said as it is
      const off = per.filter(p => p.state === 'error'), dim = per.filter(p => p.state !== 'error')
      summary = off.length
        ? `${q.ref}: ${off.map(p => p.cd.label).join(', ')} 신호는 게이트 ${off.map(thV).join(', ')} < 문턱 최대 ${ira(V(th))} 켜지지 않을 수 있고, ${dim.map(p => p.cd.label).join(', ')} 신호도 게이트 ${ro(dim.map(p => vg(p.shown)).join(', '))} 켜짐 저항 보장 전압 ${V(rated)} 미만이라 발열·전압 강하가 생길 수 있습니다`
        : `${q.ref} 게이트 ${vgsList}: 문턱은 넘지만 켜짐 저항 보장 전압 ${V(rated)} 미만이라 발열·전압 강하가 생길 수 있습니다`
      const lossy = per.filter(p => p.lossy)
      if (lossy.length) summary += ` · ${lossy.map(p => p.cd.label).join(', ')} 신호는 ${ro(why)} ${lossy.map(p => vg(p.shown)).join(', ')}`
      fix = `게이트 전압이 이 MOSFET의 켜짐 저항 보장 전압 ${V(rated)}에 못 미칩니다. ${advice(per)}`.trim()
    }
    if (!sw.pull && ctlInfo.fromSignal && state === 'pass') {
      state = 'warn'
      summary += ' · 풀다운 저항 없음'
      lines.push('게이트 풀다운이 없으면 입력이 끊겼을 때 게이트가 떠서 저절로 켜질 수 있습니다')
      fix = '게이트와 GND 사이에 10 kΩ 저항을 답니다.'
    }
    verdict(state, summary, lines)
    if (fix) sw.result.fix = fix
    if (state !== 'pass') {
      const vgsOk = (lo: number, vs: number) => atLeast(lo * div - vs, rated) && !atLeast(lo * div, spec.vgs_max.v)
      // the source lifted by an LED over its rating: with correctly sized LEDs the gate would do
      const capped = capLeds(sw.loads)
      if (vSmax > 0 && known && capped.some((l, i) => l !== sw.loads[i]) && sw.cands.every(cd => vgsOk(cd.lv.lo, sw.sense.ohms * loadI(capped, 0)))) sw.loadCaused = true
      const rev = sw.cands.find(cd => cd.lv.cause)?.lv.cause
      if (rev && sw.cands.every(cd => vgsOk(Math.abs(cd.lv.lo), vSmax))) sw.driveCause = rev
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
interface Sink {
  lo: number; hi: number | null; why: string; cause?: string; fromSwitch?: boolean
  /** what pulls it down, when its drop is not known ("트랜지스터", "U1 출력") */
  by?: string
}
/** `label`: where the resistor is, said before its reference in the summary ("Q1 아래 전류 감지 저항 R2") */
interface Heat {
  p: number; why: string; cause?: string; causeRule?: OpRule; label?: string
  /** `p` is only an upper bound, at a current that is not known (a sense resistor at the switch's rated current):
   *  over 90 % of the rating it is not judged; `iOk` is the load current up to which it stays under that */
  bound?: { iOk: number; pMin: number; base: string }
}

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
      res('unknown', `${miss.ref} (${miss.value || '색 없음'}): 이 색의 순방향 전압 자료가 없습니다`, ['순방향 전압과 최대 전류는 빨강·초록·노랑·파랑 LED(Kingbright)만 자료가 있습니다. 흰색, RGB, 두 색 LED는 아직 없습니다'])
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
    // equal is not lit either (a blue LED's 3.3 V on 3.3 V): said as 이하, never "3.3 V가 3.3 V보다 낮습니다"
    if (iHi <= 0) { state = 'error'; summary = `${name} 켜지지 않음: 걸리는 전압 ${V(top.hi - bot.lo)}가 순방향 전압 ${V(vf)} 이하입니다` }
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
      const drop = bot.by ? `${bot.by} 강하` : '스위치 강하'
      state = 'warn'; summary = best <= 0 ? `${ga(name)} 켜지지 않을 수 있습니다: ${drop}가 없어도 걸리는 전압 ${V(top.lo - bot.lo)}가 순방향 전압 최대 ${V(vfMax)}보다 낮습니다`
        : `${name} 전류가 ${drop} 없이도 ${mA(best)}로 너무 어둡습니다 (${rText})`
    } else {
      state = 'pass'
      summary = `${name} ${span(Math.max(0, perLo ?? perHi), perHi, a => mA(a))} (최대 ${mA(ifMax)}, ${rText})${perLo == null ? (bot.by ? ` · ${bot.by} LOW 전압 자료가 없어 가장 작은 전류는 계산하지 않음` : ' · 켜지는지는 트랜지스터 켜짐 참고') : ''}`
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
      : ds.find(d => { const kv = x.voltOf(x.net(d.ref, 2))?.v ?? 0; return x.net(d.ref, 1) === low && kv > 0 && kv >= (x.voltOf(high)?.v ?? 0) - 0.05 })
    // a diode from the switched end to a rail below the coil's supply: it conducts while the switch is off
    const lowRail = good || wide || highSide ? undefined
      : ds.find(d => x.net(d.ref, 1) === low && (x.voltOf(x.net(d.ref, 2))?.v ?? 0) > 0 && (x.voltOf(x.net(d.ref, 2))!.v) < (x.voltOf(high)?.v ?? Infinity) - 0.05)
    if (lowRail) {
      const kn = x.net(lowRail.ref, 2)!, kv = x.voltOf(kn)!.v, hv = x.voltOf(high)!.v
      res('error', `${lowRail.ref} 캐소드가 코일 전원(${V(hv)})보다 낮은 ${kn}(${V(kv)})에 있어, 스위치가 꺼져도 코일 전류가 그쪽으로 계속 흐릅니다`,
        [`${high} → ${l.ref} → ${lowRail.ref} → ${kn} 경로로 ${V(hv - kv)} 정도가 계속 걸립니다`, `캐소드는 ${high}에 연결해야 합니다`])
      continue
    }
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
    // a load supply below 0 V: the switch conducts backwards (body diode, reversed junction) even when off
    const neg = sw.loads.find(l => l.supply && l.supply.hi < -0.05)
    if (neg) {
      res('error', `${sw.q.ref} 부하 ${neg.label}의 전원이 ${V(neg.supply!.hi)}로 0 V보다 낮아 꺼져 있어도 ${sw.kind === 'mos' ? '바디 다이오드' : '컬렉터 접합'}로 전류가 흐릅니다`,
        [...notes, neg.supply!.why], neg.supply!.cause)
      continue
    }
    const deadMotor = sw.loads.find(l => l.motor && l.supply && l.supply.hi <= 0.05)
    if (deadMotor) {
      res('error', `${deadMotor.label}에 전원 쪽이 없습니다: 반대쪽이 ${V(deadMotor.supply!.hi)}라 ${ga(sw.q.ref)} 켜져도 모터에 전압이 걸리지 않습니다`, [...notes, deadMotor.supply!.why], deadMotor.supply!.cause)
      continue
    }
    const overMotor = sw.loads.find(l => l.motor && l.ratedV && l.supply && l.supply.hi > l.ratedV * 1.05)
    if (overMotor) {
      const over = overMotor.i != null && atLeast(loadI(sw.loads, 0), lim.v)
      res('error', `${overMotor.label} 정격 ${V(overMotor.ratedV!)}보다 높은 ${V(overMotor.supply!.hi)}가 걸립니다`,
        [...notes, overMotor.note, `전원: ${overMotor.supply!.why}`,
          ...(over ? [`${sw.q.ref} 부하도 대략 ${mA(loadI(sw.loads, 0))}로 최대 ${mA(lim.v)}를 넘습니다 (${cite(lim)})`] : [])])
      continue
    }
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
    // a TO-220 part's current rating holds with its case at 25 °C; with no heatsink its own conduction heat limits it first.
    // The heat is reckoned with the RDS(on) row its gate is guaranteed (rdsRow); a gate under every row, or one not known,
    // leaves RDS(on) and so the heat unknown, which follows the gate's own verdict (2026-11-08 second review)
    const free = sw.mos?.free_air ? sw.mos : null
    const gate = sw.vgsLo
    const row = free && gate != null ? rdsRow(free, gate) : null
    const rated = free?.vgs_rated.v ?? 0
    /** the heat at the gate it has, or (gate unknown or too low) at the lowest gate that has a row: what it would be then */
    const heatAt = (i: number) => (free ? mosHeat(free, i, row ? gate! : rated) : null)
    const gateLow = !!free && !row
    const ifGate = gateLow ? `게이트에 ${V(rated)} 이상이 걸리면 ` : ''
    const air = heatAt(0)
    const airLines = (h: NonNullable<ReturnType<typeof mosHeat>>) => [
      `방열판 없이 견디는 손실 ${W(h.pAir)} = (TJ 최대 ${h.a.tj_max.v} °C − 주위 25 °C) ÷ RθJA ${h.a.rth_ja.v} °C/W (${cite(h.a.tj_max)}; ${cite(h.a.rth_ja)}). 주위가 더 더우면 더 작습니다`,
      `뜨거울 때의 켜짐 저항: ${gateLow ? '' : `게이트 ${two(gate!, h.row.vgs, V)[0]} ≥ ${V(h.row.vgs)}라 `}VGS ${V(h.row.vgs)}의 RDS(on) ${ohm(h.row.rds.v)} × ${h.a.rds_hot.v} = ${ohm(h.hot)} (${cite(h.row.rds)}; ${cite(h.a.rds_hot)})`,
      `케이스를 25 °C로 유지할 때 최대 손실 ${W(h.pCase)}: ${cite(h.a.pd_case)}`,
    ]
    const unknown = sw.loads.filter(l => l.kind === 'unknown')
    if (unknown.length) {
      const upTo = air ? `${ifGate}방열판 없이 대략 ${mA(down(air.iAir))} 이하여야 합니다 (케이스를 25 °C로 유지하면 최대 ${mA(lim.v)})` : `최대 ${mA(lim.v)} 이하여야 합니다`
      res('unknown', `${sw.q.ref} 부하 전류를 알 수 없습니다 (${unknown.map(l => l.note).join(', ')}). ${upTo}`,
        [...notes, `${sw.bjt ? 'IC' : 'ID'} 최대 ${mA(lim.v)}: ${cite(lim)}`, ...(air ? airLines(air) : [])], unknown.every(l => l.cause) ? unknown[0].cause : undefined)
      out[out.length - 1].fix = `부하 값에 데이터시트의 전류를 적습니다 (예: MOTOR 0.1A). ${eun(sw.q.ref)} ${air ? `${ifGate}방열판 없이 대략 ${mA(down(air.iAir))}까지 견딥니다 (케이스를 25 °C로 유지하면 ${mA(lim.v)})` : `${mA(lim.v)}까지 견딥니다`}. 적은 값으로 다시 판단합니다.`
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
    const heat = heatAt(i)
    const gText = gate == null ? '' : gate < 0 ? '0 V 이하' : two(gate, rated, V)[0]
    if (heat) {
      lines.push(gateLow
        ? `게이트가 ${V(rated)} 이상이면 켜짐 저항 발열 대략 ${W(heat.p)} = (${mA(i)})² × ${ohm(heat.hot)}. ${gate != null ? `지금 게이트 ${gText}에서는` : '지금 게이트 전압은 알 수 없고,'} 데이터시트가 RDS(on)을 보장하지 않습니다 (가장 낮은 보장 조건 VGS ${V(rated)})`
        : `켜짐 저항 발열 대략 ${W(heat.p)} = (${mA(i)})² × ${ohm(heat.hot)}`, ...airLines(heat))
    }
    if (atLeast(i, lim.v)) {
      const [a, b] = two(i, lim.v, mA)
      res('error', `${sw.q.ref} 부하 ${a} ≥ 최대 ${b}`, lines, ledCause)
    } else if (heat && gateLow) {
      // RDS(on) is not guaranteed at this gate: the heat is not known, and the gate's verdict is why (counted there once)
      res('unknown', gate != null
        ? `${sw.q.ref} 부하 ${mA(i)}: 게이트 ${ga(gText)} 켜짐 저항 보장 전압 ${V(rated)}보다 낮아 켜짐 저항을 몰라 발열을 판단할 수 없습니다`
        : `${sw.q.ref} 부하 ${mA(i)}: 게이트 전압을 몰라 켜짐 저항과 발열을 판단할 수 없습니다 (트랜지스터 켜짐 참고)`, lines, sw.q.ref)
      out[out.length - 1].causeRule = 'op_drive'
      // even the smallest RDS(on) the part guarantees at any gate heats it past what it stands with no heatsink: that much
      // is known whatever the gate comes to (third review of 11-09: 45 A on IRLZ44N from an ESP32 said only "판단합니다")
      const best = mosHeat(free!, i, Infinity)
      const sure = best && atLeast(best.p, best.pAir) ? ` 어느 게이트 전압에서도 발열이 대략 ${W(best.p)} 이상이라 방열판 없이 견디는 ${W(best.pAir)}를 넘으므로, 방열판은 필요합니다.` : ''
      out[out.length - 1].fix = `게이트에 ${V(rated)} 이상이 걸리게 하면(트랜지스터 켜짐 참고) 발열을 판단합니다. 그때 ${eun(sw.q.ref)} 방열판 없이 대략 ${mA(down(heat.iAir))}까지 견딥니다.${sure}`
    } else if (heat && atLeast(heat.p, heat.pCase)) {
      const [a, b] = two(heat.p, heat.pCase, W)
      res('error', `${sw.q.ref} 부하 ${mA(i)}: 켜짐 저항 발열 대략 ${a} ≥ 케이스를 25 °C로 유지할 때의 최대 ${b}라 방열판을 달아도 견디지 못합니다`, lines, ledCause)
    } else if (heat && atLeast(heat.p, NEAR * heat.pAir)) {
      const [a, b] = two(heat.p, heat.pAir, W)
      res('warn', `${sw.q.ref} 부하 ${mA(i)}: 켜짐 저항 발열 대략 ${a}로 방열판 없이 견디는 ${b}${atLeast(heat.p, heat.pAir) ? '를 넘어 방열판이 필요합니다' : '에 가깝습니다'} (방열판은 계산하지 않습니다)`, lines, ledCause)
      out[out.length - 1].fix = `${sw.q.ref}에 방열판을 달거나, 켜짐 저항이 더 작은 MOSFET을 씁니다. 방열판 없이는 대략 ${mA(down(heat.iAir))}까지입니다.`
    } else if (atLeast(i, NEAR * lim.v)) res('warn', `${sw.q.ref} 부하 최대 ${two(i, lim.v, mA)[0]}로 한계 ${mA(lim.v)}에 가깝습니다`, lines, ledCause)
    else res('pass', `${sw.q.ref} 부하 최대 ${mA(i)} (최대 ${mA(lim.v)}${heat ? `, 방열판 없이 대략 ${mA(down(heat.iAir))}` : ''})`, lines)
  }
  return out
}

/** resistor heating wherever the current through it is known */
function checkResistorPower(x: Ctx, switches: Switch[], heats: Map<string, { r: OpPart; h: Heat }>, ledFailed: (ref: string) => boolean): OpResult[] {
  const pr = resPower(x.style)
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
    // the current-sense resistor under the emitter/source carries the whole load current (a BJT's base current too):
    // P = I² × R at the largest load current; with the load's current unknown, at the part's rated current (more than
    // that is the switch's own fault), as the gate drive reckons it, so no second 판단 불가 line comes of it
    const sense = sw.sense.ref ? x.part(sw.sense.ref) : undefined
    if (sense && sw.sense.ohms > 0) {
      const lim = sw.bjt ? sw.bjt.ic_max : sw.mos!.id_max
      const known = loadsKnown(sw.loads)
      const most = senseBound(sw)
      const iL = known ? loadI(sw.loads, 0) : most.i
      const iB = sw.kind === 'bjt' && sw.drive && top > 0 && sw.drive.ohms > 0 ? top / sw.drive.ohms : 0
      const i = iL + iB
      const where = `${sw.q.ref} 아래 전류 감지 저항 ${sense.ref}`
      const base = iB > 0 ? ` + 베이스 최대 ${mA(iB)}` : ''
      // an LED string over its rating draws the current that heats it: with that LED at its rating it would not be near
      // the rating, so the heat follows the LED (one fault, counted once), as the switch's overload does
      const capped = capLeds(sw.loads)
      const iCapped = known && loadsKnown(capped) ? loadI(capped, 0) + iB : null
      const cause = iCapped != null && iCapped ** 2 * sw.sense.ohms < NEAR * pr.p_max.v ? overLed(sw.loads, ledFailed) : undefined
      // the rated current only bounds an unknown load: within the rating it proves the pass, over it proves nothing
      // (2026-11-08 review: 0.1 Ω at IRLZ44N's 47 A read as 221 W and "안 됨"), which is the unknown load's 판단 불가
      // `pMin`: the base current alone, with no load current at all, which an unknown load can only add to
      const bound = known ? undefined : { iOk: Math.max(0, Math.sqrt(NEAR * pr.p_max.v / sw.sense.ohms) - iB), pMin: iB * iB * sw.sense.ohms, base: `베이스 최대 ${mA(iB)}` }
      add(sense, { p: i * i * sw.sense.ohms, label: where, ...(cause ? { cause } : {}), ...(bound ? { bound, cause: sw.q.ref, causeRule: 'op_switch' as const } : {}), why: known
        ? `${where}: 부하 최대 ${mA(iL)}${base}가 모두 지나 P = I² × R = (${mA(i)})² × ${ohm(sw.sense.ohms)}`
        : `${where}: 부하 전류를 몰라 ${most.rating ? `${sw.bjt ? 'IC' : 'ID'} 최대 ${mA(iL)}` : `${mA(iL)}(${most.why})`}${base}로 계산 P = I² × R = (${mA(i)})² × ${ohm(sw.sense.ohms)} (${most.rating ? cite(lim) : '부하와 스위치의 전압 강하를 0으로 둔 가장 큰 전류'})` })
    }
  }
  // between two fixed voltages, or a fixed voltage and a 555 output (which swings from 0 V to its high level)
  const ends = (n: string | null): Level | null => { const s = x.source(n); return s && !x.voltOf(n) ? { ...s, lo: 0 } : s }
  for (const r of x.of('R')) {
    const a = ends(x.net(r.ref, 1)), b = ends(x.net(r.ref, 2)), ohms = parseOhms(r.value)
    const dv = a && b ? Math.max(Math.abs(a.hi - b.lo), Math.abs(b.hi - a.lo)) : 0
    if (a && b && ohms != null && ohms > 0 && dv > 0) {
      const fixed = a.lo === a.hi && b.lo === b.hi
      add(r, { p: dv ** 2 / ohms, why: fixed ? `양 끝 ${V(a.hi)}, ${V(b.hi)} 사이 P = V² ÷ R` : `양 끝 ${rangeV(a)}, ${rangeV(b)} 사이 가장 큰 차 ${V(dv)}로 P = V² ÷ R`, cause: a.cause ?? b.cause })
    }
  }
  // a resistor in series with a motor whose current is on its value: the only resistor on a motor pin's net,
  // with nothing else there but diodes and capacitors (no DC path around it)
  for (const m of x.parts().filter(isMotor)) {
    const i = parseAmps(m.value)
    if (i == null) continue
    for (const pin of [1, 2]) {
      const n = x.net(m.ref, pin)
      if (!n || x.voltOf(n)) continue
      const others = x.on(n).filter(nd => nd.ref !== m.ref).map(nd => x.part(nd.ref))
      const rs = others.filter(p => p?.part === 'R')
      if (rs.length !== 1 || others.some(p => !p || !['R', 'D', 'C', 'CP'].includes(p.part))) continue
      const o = parseOhms(rs[0]!.value)
      if (o) add(rs[0]!, { p: i * i * o, why: `${m.ref} 모터 전류 ${mA(i)}가 모두 지나 P = I² × R` })
    }
  }
  // 555 timing resistors: RA sees VCC while DISCH is low, RB at most 2/3 VCC
  for (const u of x.of('NE555')) {
    const vcc = x.voltOf(x.net(u.ref, 8)), vccNet = x.net(u.ref, 8), dis = x.net(u.ref, 7), thr = x.net(u.ref, 6)
    if (!vcc || !dis) continue
    // astable: VCC sits on RA only while discharging, RB/(RA + 2RB) of the time (always under half)
    const rbOhms = thr && thr !== dis ? x.between(dis, thr).map(r => parseOhms(r.value)) : []
    const rb = rbOhms.length && rbOhms.every(o => o != null) ? par(rbOhms as number[]) : null
    if (vccNet) for (const r of x.between(vccNet, dis)) {
      const o = parseOhms(r.value)
      if (!o) continue
      const share = rb != null && rb > 0 ? rb / (o + 2 * rb) : 1
      add(r, { p: vcc.v ** 2 / o * share, why: share < 1
        ? `${u.ref} 방전 중(주기의 ${(share * 100).toFixed(0)}%)에만 VCC ${V(vcc.v)}가 걸려 평균 P = V² ÷ R × ${(share * 100).toFixed(0)}% (순간 ${W(vcc.v ** 2 / o)})`
        : `${u.ref} 방전 중 DISCH가 낮아 VCC ${V(vcc.v)}가 모두 걸림` })
    }
    if (thr) for (const r of x.between(dis, thr)) {
      const o = parseOhms(r.value)
      if (o) add(r, { p: (vcc.v * 2 / 3) ** 2 / o, why: `${u.ref} 방전 중 커패시터 전압 최대 VCC의 2/3` })
    }
  }
  const out: OpResult[] = []
  for (const { r, h } of heats.values()) {
    const [a, b] = two(h.p, pr.p_max.v, W)
    const detail = [h.why, `정격 ${W(pr.p_max.v)}: ${cite(pr.p_max)}${x.style ? '' : ' (PCB 전이라 정격이 작은 SMD 기준)'}`]
    const res = (state: OpState, summary: string, own = false) => out.push({ rule: 'op_rpower', ref: r.ref, state, summary, detail,
      ...(h.cause && state !== 'pass' && !own ? { cause: h.cause, ...(h.causeRule ? { causeRule: h.causeRule } : {}) } : {}) })
    const who = h.label ?? r.ref
    const pMin = h.bound?.pMin ?? 0
    if (h.bound && atLeast(pMin, NEAR * pr.p_max.v)) {
      // the base current alone already heats it past 90 % of the rating: whatever the load draws, its own fault (2026-11-09
      // review: "부하가 0 mA 이하면 정격 125 mW의 90% 미만입니다" with 250 mW from the base alone)
      const [m, n] = two(pMin, pr.p_max.v, W)
      detail.push(`부하 전류를 빼고 ${h.bound.base}만 지나도 ${W(pMin)}이고, 부하 전류가 더해지면 더 커집니다`)
      if (atLeast(pMin, pr.p_max.v)) res('error', `${who} 발열 ${m} ≥ 정격 ${n} (베이스 전류만으로)`, true)
      else res('warn', `${who} 발열이 베이스 전류만으로 ${m}로 정격 ${n}에 가깝고, 부하 전류가 더해지면 넘을 수 있습니다`, true)
    } else if (h.bound && atLeast(h.p, NEAR * pr.p_max.v)) {
      res('unknown', `${who} 발열을 판단할 수 없습니다: 부하 전류를 몰라 가장 큰 전류로 계산하면 ${W(h.p)}입니다`)
      // "미만": at the limit itself the heat is 90 % of the rating, which warns (2026-11-09 review: "1500 mA 이하면" against
      // a warn at 1.5 A)
      detail.push(`부하가 ${mA(down(h.bound.iOk))} 미만이면 정격 ${W(pr.p_max.v)}의 90% 미만입니다`)
      out[out.length - 1].fix = '부하 값에 전류를 적으면(예: MOTOR 0.1A) 다시 판단합니다.'
    } else if (atLeast(h.p, pr.p_max.v)) res('error', `${who} 발열 ${a} ≥ 정격 ${b}`)
    else if (atLeast(h.p, NEAR * pr.p_max.v)) res('warn', `${who} 발열 ${a}로 정격 ${b}에 가깝습니다`)
    else res('pass', `${who} 발열 최대 ${W(h.p)} (정격 ${W(pr.p_max.v)})`)
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
  // a diode forward biased between two fixed voltages carries whatever the supplies give it
  for (const d of x.of('D')) {
    const a = x.net(d.ref, 1), k = x.net(d.ref, 2), va = x.voltOf(a), vk = x.voltOf(k)
    if (!a || !k || a === k || !va || !vk) continue
    const spec = SPECS.diode[d.value.toUpperCase().replace(/\s+/g, '')], vf = spec?.vf_max.v ?? SPECS.diode['1N4148'].vf_max.v
    // across a relay coil the relay rule already reports it (the diode clamps the coil)
    const coil = x.of('Relay').some(r => [x.net(r.ref, 1), x.net(r.ref, 2)].includes(a) && [x.net(r.ref, 1), x.net(r.ref, 2)].includes(k))
    if (va.v - vk.v < vf || coil) continue
    out.push({ rule: 'op_short', ref: d.ref, state: 'error', key: [a, k].sort().join('|'), ...(va.cause ?? vk.cause ? { cause: (va.cause ?? vk.cause)! } : {}),
      summary: `${d.ref} 다이오드가 ${a}(${V(va.v)})에서 ${k}(${V(vk.v)})로 순방향이라 전원이 다이오드를 지나 바로 흐릅니다`,
      detail: [`${a}: ${va.why}`, `${k}: ${vk.why}`, `순방향 전압 ${V(vf)}보다 큰 ${V(va.v - vk.v)}가 걸려 전류가 전원으로만 제한됩니다${spec ? '' : ` (${d.value || '값 없음'} 자료가 없어 ${SPECS.diode['1N4148'].vf_max.src} 기준)`}`] })
  }
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
      if ((vcc.lo ?? vcc.v) < t.vcc_min.v || vcc.v > t.vcc_max.v) errors.push(`전원 ${rangeV({ lo: vcc.lo ?? vcc.v, hi: vcc.v })}가 동작 범위 ${V(t.vcc_min.v)}~${V(t.vcc_max.v)} 밖입니다`)
    }
    // OUT (3) tied to GND or a supply: the output stage drives into it
    const outV = x.voltOf(n(3))
    if (outV) errors.push(`3번 핀(OUT)이 ${outV.v === 0 ? 'GND' : `전원 ${V(outV.v)}`}에 바로 묶여 출력이 바뀔 때마다 단락됩니다`)
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
    if (!spec) { res('unknown', `${r.ref} (${reg.name}): 데이터시트 수치를 아직 확인하지 못해 판단하지 않습니다`, [`데이터시트 수치는 AMS1117-x.x와 7805만 확인했습니다. 출력 ${V(reg.vout)}는 부품 이름에서 읽어 다른 검사에 씁니다${reg.gate ? ` (입력이 출력보다 같은 1117 계열인 AMS1117의 최소 전압 차 ${V(reg.gate.v)} 이상 높을 때만)` : ''}`]); continue }
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
    // after a series diode the input is a range: the least of it decides the headroom
    const inLv = { lo: vin.lo ?? vin.v, hi: vin.v }, head = inLv.lo - reg.vout
    const detail = [`입력 ${rangeV(inLv)} (${vin.why}) − 출력 ${V(reg.vout)} = ${inLv.lo < inLv.hi ? '최소 ' : ''}${V(head)}`,
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
    res('pass', `${r.ref} 입력 ${rangeV(inLv)} → ${V(reg.vout)} (여유 ${inLv.lo < inLv.hi ? '최소 ' : ''}${V(head)})`, detail)
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
  if (c.unread?.length) {
    const refs = [...new Set(c.unread.map(k => k.split('.')[0]))]
    return [{ rule: 'op_data', ref: '', state: 'unknown',
      summary: `어느 다리인지 읽지 못한 연결이 있어 동작 검사를 하지 않았습니다 (부품 ${refs.length}개)`,
      detail: ['연결이 어느 다리에 이어졌는지 모르면 계산이 틀립니다. 회로도에 저장된 다리 이름이 부품의 다리 이름 표에 없습니다',
        `읽지 못한 연결: ${c.unread.slice(0, 12).join(', ')}${c.unread.length > 12 ? ' …' : ''}`] }]
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
  // there is a fault of its own. Also when the regulator is not judged: an LM1117 with no limits of its own,
  // its output held back by the 1117 family's dropout, hid 0.1 Ω across that output (review of 2026-11-03)
  if (base.some(r => r.rule === 'op_reg' && (r.state === 'error' || r.state === 'unknown'))) {
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

/**
 * The LEDs no resistor limits, one list per string (anode end first), whatever their colour: checkLeds stops at a colour
 * it has no data for, and a green LED with no resistor burns as well. validateCircuit blocks the PCB on this (2026-11-06
 * sweep: 9 V - 220 Ω - three LEDs and R - switch - LED were refused for "no resistor"), so it only says what the walk is
 * sure of. The string's own walk stops at a net of three pins, a diode or a relay's NC contact. From each end that has no
 * voltage of its own the search goes on, over any other pins there and across diodes, LEDs, switches and relay contacts,
 * until it meets a resistor or a relay coil, which can be in the LED's path (2026-11-07: R - protection diode - LED, and
 * R - switch - LED with a capacitor on the switch's output, were still refused). It stops at a net with a voltage of its
 * own: a supply or a ground, one a closed switch or a diode carries a supply to, a 555 output, one whose voltage cannot be
 * trusted. So an LED put straight on a supply, with no resistor anywhere before it, stays refused. `unsure`: nets with a
 * pin on them that could not be read (a pin name the table does not know); what is there is not known, so a string that
 * reaches one is not refused. A chain cut by an LED facing the other way is op_led's error.
 */
export function ledsWithoutResistor(c: OpCircuit, unsure: ReadonlySet<string> = new Set()): string[][] {
  let x: Ctx
  try { x = context(c) } catch { return [] }   // not judged: the operating checks say 판단 불가 for the same reason
  /** a net with a voltage of its own; a button input that its resistor pulls up is not one */
  const fixed = (n: string) => { const v = x.voltOf(n); return (!!v && !v.pulled) || !!x.blockedWhy(n) || !!x.timerOut(n) }
  /** the pins current can leave a part by when it comes in at `o`: across a diode or an LED, a switch, a relay's contact */
  const across = (o: Node): number[] => {
    const p = x.part(o.ref)?.part
    if (p === 'D' || p === 'LED') return o.pin === 1 ? [2] : o.pin === 2 ? [1] : []
    if (p === 'SW') return [1, 2, 3].filter(q => q !== o.pin)
    if (p === 'Relay') return o.pin === 3 ? [4, 5] : o.pin === 4 || o.pin === 5 ? [3] : []
    return []
  }
  /** what can limit the current: a resistor, a relay's coil */
  const limits = (o: Node) => { const p = x.part(o.ref)?.part; return p === 'R' || (p === 'Relay' && (o.pin === 1 || o.pin === 2)) }
  const perhaps = (end: string | null) => {
    if (!end) return false
    const seen = new Set([end]), queue = [end]
    while (queue.length) {
      const n = queue.shift()!
      if (fixed(n)) continue
      if (unsure.has(n) || x.on(n).some(limits)) return true
      for (const o of x.on(n)) for (const q of across(o)) {
        const m = x.net(o.ref, q)
        if (m && !seen.has(m)) { seen.add(m); queue.push(m) }
      }
    }
    return false
  }
  return ledStrings(x).filter(s => !s.rs.length && !s.opposed && !perhaps(s.top) && !perhaps(s.bot)).map(s => s.leds.map(l => l.ref))
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
    if (v) return { lo: v.lo ?? v.v, hi: v.v, why: v.why, ...(v.cause ? { cause: v.cause } : {}) }
    const sw = switchAt(n)
    if (!sw) {
      // a 555 output sinks current while low; its low level (VOL) is not in the parts table, so only 0 V is used
      const tm = x.timerOut(n)
      return tm?.level ? { lo: 0, hi: null, by: `${tm.ref} 출력`, why: `${tm.ref} 출력이 LOW일 때 받아 내림: 0 V~VOL (VOL은 자료가 없어 가장 큰 전류에만 0 V로 씀)` } : null
    }
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
  run('op_rpower', () => checkResistorPower(x, switches, heats, ledFailed))
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

/**
 * Worst state and a one-line headline; a fault and the failures it causes count once. With the circuit check
 * failing (circuitErrors) a pass only covers what is still wired, so it reads as not judged instead
 * (2026-11-02 tour: '동작 검사 통과' beside '회로 오류 1' after the LED was taken out).
 */
export function operatingHeadline(results: OpResult[], circuitErrors = 0): { state: OpState; text: string } {
  if (!results.length) return { state: 'pass', text: '검사할 부품 없음' }
  // a result counts unless it follows a fault at least as severe as itself (a knock-on of that fault)
  const counts = (r: OpResult) => { const root = rootOf(r, results); return root === r || RANK[root.state] < RANK[r.state] }
  const n = (s: OpState) => results.filter(r => r.state === s && counts(r)).length
  const any = (s: OpState) => results.some(r => r.state === s)
  const unk = n('unknown') ? ` · 판단 불가 ${n('unknown')}` : ''
  if (any('error')) return { state: 'error', text: `동작 안 됨 ${Math.max(1, n('error'))}${unk}` }
  if (any('warn')) return { state: 'warn', text: `동작 경고 ${n('warn')}${unk}` }
  if (any('unknown')) return { state: 'unknown', text: `판단 불가 ${Math.max(1, n('unknown'))}` }
  if (circuitErrors > 0) return { state: 'unknown', text: '판단 불가 · 회로 오류' }
  return { state: 'pass', text: '동작 검사 통과' }
}
