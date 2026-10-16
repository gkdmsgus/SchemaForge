import type { ComponentEntry } from '../types'
import { ASSUMED } from './humanReview'
import { SPECS } from './partSpecs'

// Bill of materials: what to buy for the circuit. One line per (template, value, footprint),
// with the footprint taken from the board only while the board still matches the circuit.
// Nothing here is guessed: notes come from the tables the PCB and the checks use, and
// shop data (Mouser) only from a real API match.

/** Parts the PCB adds itself (test pads, mounting holes): on the board, nothing to buy. */
export const FURNITURE = new Set(['TestPoint', 'MountingHole'])

export interface BomBoard {
  parts: { ref: string; value: string; part: string; footprint: string }[]
  unmapped?: { ref: string; part?: string; reason?: string }[]
}

export interface BomLine {
  key: string               // template | normalised value | footprint (UNMAPPED / STALE without one)
  refs: string[]            // natural order: R2 before R10
  qty: number
  value: string
  part: string              // template name, or the ref prefix when the graph has none
  type: string              // Korean label
  footprint: string | null  // full KiCad lib:name from the board
  pkg: string | null        // short label of the footprint (0805, SOIC-8 ...)
  pinout: string | null     // real part the footprint's pinout was taken from
  notes: string[]           // facts from the PCB tables and the checks
  unmapped?: string         // the generator found no footprint (reason)
  stale?: boolean           // a board exists but no longer matches these parts
}

export interface Bom {
  lines: BomLine[]
  furniture: { ref: string; value: string; part: string }[]
  style: 'smd' | 'tht'
  fromBoard: boolean
  /** refs where the board and the circuit disagree (changed after the PCB was made) */
  stale: string[]
}

export const naturalRef = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
const prefixOf = (ref: string) => ref.replace(/\d+/g, '')

/** "4.7 kΩ" -> "4.7k". Case is kept (1M is not 1m) and ratings stay ("680 1W" is not "680 1/4W"). */
export function normValue(v: string): string {
  return String(v ?? '').trim().replace(/\s+/g, '').replace(/[\u00B5\u03BC]/g, 'u').replace(/[\u03A9\u2126]|ohms?(?![a-z])/gi, '')
}

const TYPE_BY_PART: Record<string, string> = {
  R: '저항', C: '커패시터', CP: '전해 커패시터', L: '인덕터', LED: 'LED', D: '다이오드',
  Q_NPN: 'NPN 트랜지스터', Q_NMOS: 'N-MOSFET', REG: '레귤레이터', NE555: '555 타이머', OpAmp: '연산 증폭기',
  Relay: '릴레이', Buzzer: '버저', SW: '스위치', Battery: '배터리', Crystal: '크리스탈',
}
const TYPE_BY_PREFIX: Record<string, string> = {
  R: '저항', C: '커패시터', L: '인덕터', D: '다이오드', Q: '트랜지스터', U: 'IC', SW: '스위치',
  K: '릴레이', LS: '버저', BT: '배터리', Y: '크리스탈', J: '커넥터',
}

export function typeLabel(part: string, ref = ''): string {
  const conn = /^Conn_01x(\d+)$/.exec(part)
  if (conn) return `커넥터 ${Number(conn[1])}핀`
  return TYPE_BY_PART[part] ?? TYPE_BY_PREFIX[prefixOf(ref)] ?? part
}

/** Short package label from a KiCad footprint id: "Resistor_SMD:R_0805_2012Metric" -> "0805". */
export function pkgLabel(footprint: string | null): string | null {
  if (!footprint) return null
  const name = footprint.includes(':') ? footprint.slice(footprint.indexOf(':') + 1) : footprint
  const metric = /(\d{4})_\d{4}Metric/.exec(name)
  if (metric) return metric[1]
  const pkg = /SOIC-\d+|SOT-223|SOT-23|DIP-\d+|TO-92|TO-220|SOD-123|DO-35|HC49-[A-Z]+|PinHeader_1x\d+/.exec(name)
  if (pkg) return pkg[0]
  const round = /^LED_D(\d+(?:\.\d+)?)mm/.exec(name)
  if (round) return `${Number(round[1])}mm`
  if (/SANYOU_SRD/.test(name)) return 'SRD'
  const tht = /(Axial)_(DIN\d+|L\d+(?:\.\d+)?mm)|(Disc|Radial)_D(\d+(?:\.\d+)?)mm|(Elec|Buzzer)_(\d+(?:\.\d+)?x\d+(?:\.\d+)?)/.exec(name)
  if (tht) return tht[1] ? `${tht[1]} ${tht[2]}` : tht[3] ? `${tht[3]} ${Number(tht[4])}mm` : `${tht[5]} ${tht[6]}`
  return name
}

/** Notes from code facts only: the assumed pinout part, the resistor rating the checks use, the battery header. */
function notesFor(part: string, style: 'smd' | 'tht'): { pinout: string | null; notes: string[] } {
  const pinout = ASSUMED[part]?.[style] ?? null
  const notes: string[] = []
  if (part === 'R') notes.push(`정격 ${SPECS.res[style].p_max.v} W 기준`)
  if (part === 'Battery') notes.push('기판에는 2핀 헤더 (배터리는 기판 밖)')
  return { pinout, notes }
}

export function buildBom(components: ComponentEntry[], board: BomBoard | null, styleIn: 'smd' | 'tht'): Bom {
  const style = styleIn === 'tht' ? 'tht' : 'smd'
  const boardParts = new Map((board?.parts ?? []).map(p => [p.ref, p]))
  const unmapped = new Map((board?.unmapped ?? []).map(u => [u.ref, u.reason || 'no footprint mapping']))
  const groups = new Map<string, BomLine>()
  const stale: string[] = []
  const furniture = new Map<string, { ref: string; value: string; part: string }>()
  const inGraph = new Set<string>()

  for (const c of components || []) {
    const value = String(c.value ?? '').trim()
    const part = c.name || prefixOf(c.ref)
    if (FURNITURE.has(part)) { furniture.set(c.ref, { ref: c.ref, value, part }); continue }
    inGraph.add(c.ref)
    const bp = boardParts.get(c.ref)
    // board.py places an unmapped part with a placeholder footprint "SchemaForge:UNMAPPED_<part>"
    const why = unmapped.get(c.ref) ?? (bp && /:UNMAPPED_/.test(bp.footprint) ? 'no footprint mapping' : undefined)
    let footprint: string | null = null
    let isStale = false
    if (board && !why) {
      if (bp && String(bp.value ?? '').trim() === value && bp.part === (c.name || bp.part) && bp.footprint) footprint = bp.footprint
      else { isStale = true; stale.push(c.ref) }
    }
    const key = `${part}|${normValue(value)}|${footprint ?? (why ? 'UNMAPPED' : isStale ? 'STALE' : '')}`
    const line = groups.get(key)
    if (line) { line.refs.push(c.ref); continue }
    groups.set(key, {
      key, refs: [c.ref], qty: 0, value, part, type: typeLabel(part, c.ref), footprint, pkg: pkgLabel(footprint),
      ...notesFor(part, style),
      ...(why ? { unmapped: why } : {}), ...(isStale ? { stale: true } : {}),
    })
  }

  // parts the board still has but the circuit dropped: the board is out of date too
  for (const p of board?.parts ?? []) {
    if (FURNITURE.has(p.part)) furniture.set(p.ref, { ref: p.ref, value: String(p.value ?? ''), part: p.part })
    else if (!inGraph.has(p.ref)) stale.push(p.ref)
  }

  const lines = [...groups.values()]
  for (const l of lines) { l.refs.sort(naturalRef); l.qty = l.refs.length }
  lines.sort((a, b) => naturalRef(a.refs[0], b.refs[0]))
  return {
    lines, style, fromBoard: !!board, stale: stale.sort(naturalRef),
    furniture: [...furniture.values()].sort((a, b) => naturalRef(a.ref, b.ref)),
  }
}

/** "H1, H2, H3, H4" -> "H1–H4"; runs shorter than three stay a list ("TP1, TP2"). */
export function compactRefs(refs: string[]): string {
  const follows = (a: string, b: string) => {
    const x = /^(\D+)(\d+)$/.exec(a), y = /^(\D+)(\d+)$/.exec(b)
    return !!x && !!y && x[1] === y[1] && Number(y[2]) === Number(x[2]) + 1
  }
  const out: string[] = []
  let run: string[] = []
  const flush = () => { out.push(run.length >= 3 ? `${run[0]}–${run[run.length - 1]}` : run.join(', ')); run = [] }
  for (const r of [...refs].sort(naturalRef)) {
    if (run.length && !follows(run[run.length - 1], r)) flush()
    run.push(r)
  }
  if (run.length) flush()
  return out.join(', ')
}

/** Board-only parts in one line: "TP1, TP2 (테스트 패드) · H1–H4 (M3 구멍)". */
export function furnitureSummary(furniture: Bom['furniture']): string {
  const groups = new Map<string, string[]>()
  for (const f of furniture) groups.set(f.part, [...(groups.get(f.part) ?? []), f.ref])
  const order = (part: string) => (part === 'TestPoint' ? 0 : part === 'MountingHole' ? 1 : 2)
  return [...groups].sort((a, b) => order(a[0]) - order(b[0])).map(([part, refs]) => {
    const values = new Set(furniture.filter(f => f.part === part).map(f => f.value))
    const label = part === 'TestPoint' ? '테스트 패드'
      : part === 'MountingHole' ? (values.size === 1 && [...values][0] ? `${[...values][0]} 구멍` : '고정 구멍') : part
    return `${compactRefs(refs)} (${label})`
  }).join(' · ')
}
