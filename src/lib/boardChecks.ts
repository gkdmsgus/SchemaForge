import type { BoardModel, DrcResult } from '../types'
import { pinoutWarnings, type ReviewItem } from './humanReview'
import { OP_RULES, type OpResult, type OpState } from './operatingCheck'

// Every check the board went through, one row per rule, so a passed rule is visible
// too (not only the failures). Rows reference findings by the same ids BoardView uses
// for its markers: drc<i> (KiCad DRC violations), erc<i> (netlist checks), unr<i>
// (connections the router could not finish).

export type CheckState = 'pass' | 'error' | 'warn' | 'review' | 'pending' | 'skipped' | 'unknown'
export type Tone = 'ok' | 'bad' | 'warn' | 'accent' | 'idle'

export interface CheckRow {
  id: string            // rule code, shown in mono next to the label
  label: string         // Korean name of the rule
  state: CheckState
  count: number         // problems this rule found (0 when it passed)
  note?: string         // one short fact shown under the label, e.g. "14/14 연결"
  detail: string[]      // lines shown when the row is opened: reason, unmapped parts, pinouts
  findings: string[]    // ids of the findings that belong to this rule
  group?: string        // heading the row sits under in the list
  items?: CheckItem[]   // per-part results (operating checks), shown when the row is opened
}

/** One part's result inside a rule row. */
export interface CheckItem { ref: string; state: CheckState; summary: string; detail: string[]; fix?: string }

/** Groups in display order. */
export const GROUP = { board: '기판 검사', circuit: '회로 연결', operating: '동작 검사', parts: '부품 확인' } as const

/**
 * ERC errors counted per pin (a floating_pin finding can name several pins of one part), or per net
 * when a finding names no pin: the same count as the server's status line and repair note (errorKeys).
 */
export function ercErrorCount(findings: { rule: string; severity: string; refs: { ref: string; pin: string }[]; net: string | null }[]): number {
  const keys = new Set<string>()
  for (const f of findings) {
    if (f.severity !== 'error') continue
    if (f.refs.length) for (const r of f.refs) keys.add(`${f.rule} ${r.ref}.${r.pin}`)
    else keys.add(`${f.rule} ${f.net ?? ''}`)
  }
  return keys.size
}

/** Netlist checks run by server/pcb/erc.py on every board, in its order. */
export const ERC_RULES: [string, string][] = [
  ['floating_pin', '연결 안 된 핀'],
  ['single_pin_net', '핀 하나뿐인 넷'],
  ['no_ground', 'GND 넷 있음'],
  ['unpowered_rail', '전원 넷 공급원'],
  ['output_conflict', '출력끼리 충돌'],
]

/**
 * Text colours for status, chosen to keep at least 4.5:1 contrast on every surface they
 * sit on: the white board panels, the board sheet and the beige app (bg, bg-1, bg-2).
 */
export const TONE_COLOR: Record<Tone, string> = {
  ok: '#176b5d',
  bad: '#a63c1e',
  warn: '#7f5300',
  accent: '#6a4cb5',
  idle: '#5c5444',
}

export const STATE_TONE: Record<CheckState, Tone> = {
  pass: 'ok', error: 'bad', warn: 'warn', review: 'warn', pending: 'idle', skipped: 'idle', unknown: 'idle',
}

export function stampText(r: Pick<CheckRow, 'state' | 'count'>): string {
  switch (r.state) {
    case 'pass': return '통과'
    case 'error': return `오류 ${r.count}`
    case 'warn': return `경고 ${r.count}`
    case 'review': return `확인 ${r.count}`
    case 'pending': return '대기'
    case 'skipped': return '건너뜀'
    case 'unknown': return '판단 불가'
  }
}

/** The state word alone, for one part inside a row. */
export function stateWord(s: CheckState): string {
  return ({ pass: '통과', error: '안 됨', warn: '경고', review: '확인', pending: '대기', skipped: '건너뜀', unknown: '판단 불가' } as const)[s]
}

/** One row per operating rule that applies to this circuit; worst part decides the row. */
export function operatingRows(results: OpResult[]): CheckRow[] {
  const rank: Record<OpState, number> = { pass: 0, unknown: 1, warn: 2, error: 3 }
  const rows: CheckRow[] = []
  for (const [rule, label] of OP_RULES) {
    const rs = results.filter(r => r.rule === rule)
    if (!rs.length) continue
    const state = rs.reduce<OpState>((a, r) => (rank[r.state] > rank[a] ? r.state : a), 'pass')
    const hits = rs.filter(r => r.state === state)
    rows.push({
      id: rule, label, state, group: GROUP.operating,
      count: state === 'pass' ? 0 : hits.length,
      note: rs.length === 1 ? (rs[0].ref && rs[0].summary.startsWith(rs[0].ref) ? rs[0].summary.slice(rs[0].ref.length).replace(/^[\s:]+/, '') : rs[0].summary) : `${rs.length}개 항목`,
      detail: [], findings: [],
      items: rs.map(r => ({ ref: r.ref, state: r.state, summary: r.summary, detail: r.detail, ...(r.fix ? { fix: r.fix } : {}) })),
    })
  }
  return rows
}

/** Connections a board needs: for each net, pads on it minus one. */
export function connectionCount(final: BoardModel): number {
  const perNet: Record<string, number> = {}
  for (const p of final.parts) for (const pd of p.pads) if (pd.net) perNet[pd.net] = (perNet[pd.net] || 0) + 1
  return Object.values(perNet).reduce((s, n) => s + Math.max(n - 1, 0), 0)
}

export function drcCounts(drc: DrcResult | null): { errors: number; warnings: number; unconnected: number } | null {
  if (!drc || !drc.available) return null
  const v = drc.violations || []
  const errors = v.filter(x => x.severity === 'error').length
  return { errors, warnings: v.length - errors, unconnected: drc.unconnected ?? 0 }
}

/** Row id of the person's own checks; BoardView draws its body (checkboxes) itself. */
export const HUMAN_ROW = 'human_review'

export function checkRows(
  drc: DrcResult | null, final: BoardModel | null,
  review?: { items: ReviewItem[]; reviewed: Set<string> },   // reviewed = item keys a person ticked
  operating?: OpResult[],                                     // numeric "does it work" checks
): CheckRow[] {
  const rows = checkRowsBase(drc, final, review, operating)
  // headings: board checks, circuit connections, operating checks, parts
  for (const r of rows) {
    if (r.group) continue
    r.group = r.id.startsWith('kicad_') || r.id === 'routing' ? GROUP.board
      : r.id === 'footprint_map' || r.id === HUMAN_ROW || r.id === 'pinout_assumed' ? GROUP.parts
      : GROUP.circuit
  }
  return rows
}

function checkRowsBase(
  drc: DrcResult | null, final: BoardModel | null,
  review?: { items: ReviewItem[]; reviewed: Set<string> },
  operating?: OpResult[],
): CheckRow[] {
  const rows: CheckRow[] = []

  // KiCad DRC: violations, then what is still unconnected
  const counts = drcCounts(drc)
  const drcState = (bad: number, warn: number): CheckState =>
    !drc ? 'pending' : !drc.available ? 'skipped' : bad ? 'error' : warn ? 'warn' : 'pass'
  const why = drc && !drc.available ? [drc.reason || 'KiCad를 찾지 못했습니다'] : []
  rows.push({
    id: 'kicad_drc', label: 'KiCad 설계 규칙',
    state: drcState(counts?.errors ?? 0, counts?.warnings ?? 0),
    count: counts ? (counts.errors || counts.warnings) : 0,
    detail: why,
    findings: (drc?.violations || []).map((_, i) => `drc${i}`),
  })
  rows.push({
    id: 'kicad_unconnected', label: 'KiCad 미연결',
    state: drcState(counts?.unconnected ?? 0, 0),
    count: counts?.unconnected ?? 0,
    detail: why,
    findings: [],
  })

  // routing: every connection has copper
  if (!final) {
    rows.push({ id: 'routing', label: '배선 완료', state: 'pending', count: 0, detail: [], findings: [] })
  } else if (!final.tracks) {
    rows.push({ id: 'routing', label: '배선 완료', state: 'skipped', count: 0, detail: ['이 기판은 배선 단계를 거치지 않았습니다'], findings: [] })
  } else {
    const unrouted = final.unrouted || []
    const total = connectionCount(final)
    rows.push({
      id: 'routing', label: '배선 완료',
      state: unrouted.length ? 'error' : 'pass', count: unrouted.length,
      note: `${total - unrouted.length}/${total} 연결`, detail: [],
      findings: unrouted.map((_, i) => `unr${i}`),
    })
  }

  // netlist checks
  const erc = final?.erc
  const known = new Set(ERC_RULES.map(([id]) => id))
  const extra = [...new Set((erc || []).map(f => f.rule).filter(r => !known.has(r)))]
  for (const [id, label] of [...ERC_RULES, ...extra.map(r => [r, r] as [string, string])]) {
    if (!final) { rows.push({ id, label, state: 'pending', count: 0, detail: [], findings: [] }); continue }
    if (!erc) { rows.push({ id, label, state: 'skipped', count: 0, detail: ['이 기판에는 회로 점검 결과가 없습니다'], findings: [] }); continue }
    const hits = erc.map((f, i) => ({ f, i })).filter(x => x.f.rule === id)
    const state: CheckState = hits.some(x => x.f.severity === 'error') ? 'error' : hits.length ? 'warn' : 'pass'
    // errors per pin (one floating_pin finding can name several pins of a part), warnings per finding
    const count = state === 'error' ? ercErrorCount(hits.map(x => x.f)) : hits.length
    rows.push({ id, label, state, count, detail: [], findings: hits.map(x => `erc${x.i}`) })
  }

  // does it work: numeric checks on the part values
  if (final && operating) rows.push(...operatingRows(operating))

  // parts: every part got a real footprint
  if (final?.unmapped) {
    rows.push({
      id: 'footprint_map', label: '풋프린트 매핑',
      state: final.unmapped.length ? 'error' : 'pass', count: final.unmapped.length,
      detail: final.unmapped.map(u => `${u.ref} (${u.part || '?'}): ${u.reason}`),
      findings: [],
    })
  }

  // what a person confirmed against the real parts; a part's pinout warning moves into
  // its review item, so the same doubt is not counted twice
  const covered = new Set<string>()
  if (final && review && review.items.length) {
    const done = review.items.filter(i => review.reviewed.has(i.key)).length
    const total = review.items.length
    const raw = pinoutWarnings(final)
    for (const i of review.items) if (i.warning && raw.has(i.ref)) covered.add(raw.get(i.ref)!.raw)
    rows.push({
      id: HUMAN_ROW, label: '방향 확인',
      state: done < total ? 'review' : 'pass', count: total - done,
      note: `${done}/${total} 확인`, detail: [], findings: [],
    })
  }

  // pinouts the generator had to assume: only a person with the datasheet can confirm these
  const left = (final?.warnings || []).filter(w => !covered.has(w))
  if (left.length) {
    rows.push({
      id: 'pinout_assumed', label: '핀 배열 가정',
      state: 'review', count: left.length,
      detail: [...left, '실제 부품 데이터시트와 패드 번호를 대조하세요. DRC는 실물 핀 배열을 보증하지 않습니다.'],
      findings: [],
    })
  }

  return rows
}

export interface CheckSummary {
  ran: number        // rows that actually ran (not pending, not skipped)
  passed: number
  errors: number     // problems in error rows
  warnings: number   // problems in warn rows
  reviews: number    // items a person has to confirm
  skipped: number
  unknown: number    // rules that could not decide (a value they need is missing)
  pending: boolean
}

export function summarize(rows: CheckRow[]): CheckSummary {
  const ran = rows.filter(r => r.state !== 'pending' && r.state !== 'skipped' && r.state !== 'unknown')
  const sum = (s: CheckState) => rows.filter(r => r.state === s).reduce((n, r) => n + r.count, 0)
  return {
    ran: ran.length,
    passed: rows.filter(r => r.state === 'pass').length,
    errors: sum('error'),
    warnings: sum('warn'),
    reviews: sum('review'),
    skipped: rows.filter(r => r.state === 'skipped').length,
    unknown: rows.filter(r => r.state === 'unknown').length,
    pending: rows.some(r => r.state === 'pending'),
  }
}

/** One line and one tone for the whole list (panel header). */
export function overall(s: CheckSummary): { tone: Tone; text: string } {
  if (s.pending) return { tone: 'idle', text: '검사 중' }
  if (s.errors) return { tone: 'bad', text: `오류 ${s.errors}` + (s.warnings ? ` · 경고 ${s.warnings}` : '') }
  if (s.warnings || s.reviews) {
    return { tone: 'warn', text: [s.warnings && `경고 ${s.warnings}`, s.reviews && `확인 ${s.reviews}`].filter(Boolean).join(' · ') }
  }
  if (s.skipped || s.unknown) {
    return { tone: 'warn', text: ['통과', s.skipped && `건너뜀 ${s.skipped}`, s.unknown && `판단 불가 ${s.unknown}`].filter(Boolean).join(' · ') }
  }
  return { tone: 'ok', text: '검사 통과' }
}
