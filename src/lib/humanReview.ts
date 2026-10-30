import type { BoardModel } from '../types'

// What a person has to confirm on a finished board: the things the automatic checks
// cannot see. DRC proves the copper follows the footprint; it cannot prove the real
// part's pinout or polarity matches that footprint. One item per part that has a
// polarity, a pinout that depends on the exact part, a pin-1 mark, or an external
// connection order.

export type ReviewKind = 'polarity' | 'pinout' | 'orientation' | 'connector'

// written for someone soldering a first board: what to look for on the part, never a pad number
export const KIND_LABEL: Record<ReviewKind, string> = {
  polarity: '+/− 방향', pinout: '다리 순서', orientation: '1번 다리 방향', connector: '1번 핀 위치',
}

/** Pin names of the skidl part templates (server/index.ts SYSTEM_PROMPT), by template pin number. */
export const PIN_NAMES: Record<string, string[]> = {
  CP: ['+', '-'],
  LED: ['A', 'K'],
  D: ['A', 'K'],
  Bridge: ['AC1', 'AC2', '+', '-'],
  Q_NPN: ['B', 'C', 'E'],
  Q_NMOS: ['G', 'D', 'S'],
  REG: ['GND', 'OUT', 'IN'],
  NE555: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THRES', 'DISCH', 'VCC'],
  Relay: ['COIL1', 'COIL2', 'COM', 'NO', 'NC'],
  Buzzer: ['+', '-'],
  Battery: ['+', '-'],
}

/** Real part each footprint's pinout was taken from (server/pcb/footprints_table.py). */
export const ASSUMED: Record<string, { smd: string; tht: string }> = {
  Q_NPN: { smd: 'MMBT3904', tht: '2N3904' },
  Q_NMOS: { smd: '2N7002', tht: '2N7000' },
  REG: { smd: 'AMS1117', tht: 'L78xx' },
  Relay: { smd: 'Sanyou SRD', tht: 'Sanyou SRD' },
  Bridge: { smd: 'MB6S', tht: 'DF06M' },
}

function kindOf(part: string): ReviewKind | null {
  if (['LED', 'D', 'CP', 'Buzzer', 'Battery'].includes(part)) return 'polarity'
  if (['Q_NPN', 'Q_NMOS', 'REG', 'Relay', 'Bridge'].includes(part)) return 'pinout'
  if (part === 'NE555') return 'orientation'
  if (/^Conn_01x\d\d$/.test(part)) return 'connector'
  return null
}

export interface ReviewPin {
  pad: string
  pin: number | null      // template pin number, null when the board has no map for it
  name: string            // template pin name (A, K, G, +, COM...) or the pin number
  net: string | null
}

/** A label drawn on the board at one pad (+, −, 1, B...): the spot the part's mark goes to. */
export interface ReviewMark {
  pad: string
  label: string
}

export interface ReviewItem {
  ref: string
  value: string
  part: string
  kind: ReviewKind
  what: string            // one or two sentences: the mark on the real part and the board label it goes to
  tip?: string            // how to tell when the part's mark is hard to see
  marks: ReviewMark[]     // board labels at the pads; empty when the board has no pin map for the part
  pins: ReviewPin[]
  warning?: string        // the generator assumed a different part's pinout (Korean)
  key: string             // changes when the footprint, the value or the pad wiring changes
}

const MINUS = '−'          // U+2212: the same width as + in the board labels
/** A pin name as the real part prints it: a bridge rectifier marks its AC legs ~ */
const PRINTED: Record<string, string> = { AC1: '~', AC2: '~', '-': MINUS }

/** Board label colours, the same in 2D and 3D: + red, − navy, 1 and pin names violet. */
export const MARK_COLOR = (label: string) => (label === '+' ? '#c62828' : label === MINUS ? '#1f3b73' : '#6a4cb5')

/** A mark placed on the board: a label at a point in board millimetres (KiCad coordinates, y down). */
export interface BoardMark {
  key: string
  x: number
  y: number
  label: string
}

/**
 * One part's marks at its pads in board mm. `pose` is the part's [x, y, rot] (rot counter-clockwise on
 * screen, as KiCad and the 2D drawing's rotate(-rot)); a mark whose pad the part lacks is left out.
 */
export function boardMarks(part: Pick<BoardModel['parts'][number], 'ref' | 'pads'>, pose: [number, number, number],
  items: ReviewItem[]): BoardMark[] {
  const a = (pose[2] * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return items.filter(it => it.ref === part.ref).flatMap(it => it.marks.flatMap(m => {
    const pd = part.pads.find(q => q.num === m.pad)
    if (!pd) return []
    return [{ key: `${part.ref}:${m.pad}`, x: pose[0] + pd.x * c + pd.y * s, y: pose[1] - pd.x * s + pd.y * c, label: m.label }]
  }))
}

const padOrder = (a: string, b: string) => (Number(a) - Number(b)) || a.localeCompare(b)

function pinsOf(p: BoardModel['parts'][number]): ReviewPin[] {
  const seen = new Map<string, ReviewPin>()
  for (const pd of p.pads) {
    if (!pd.num || seen.has(pd.num)) continue        // SOT-223 repeats its tab pad
    const pin = p.pad_pins?.[pd.num] ?? null
    const names = PIN_NAMES[p.part]
    const name = pin == null ? '?' : names?.[pin - 1] ?? `${pin}`
    seen.set(pd.num, { pad: pd.num, pin, name, net: pd.net })
  }
  return [...seen.values()].sort((a, b) => padOrder(a.pad, b.pad))
}

/**
 * The labels drawn on the board for a part: + and − on a part with a polarity, 1 on the first pin
 * of an IC or a connector, every pin's name on a part whose pinout depends on the exact part.
 */
function marksOf(kind: ReviewKind, pins: ReviewPin[]): ReviewMark[] {
  switch (kind) {
    case 'polarity':
      return pins.flatMap(p => (p.name === '+' || p.name === 'A' ? [{ pad: p.pad, label: '+' }]
        : p.name === '-' || p.name === 'K' ? [{ pad: p.pad, label: MINUS }] : []))
    case 'orientation':
      return pins.filter(p => p.pin === 1).map(p => ({ pad: p.pad, label: '1' }))
    case 'connector':
      return pins.filter(p => p.pad === '1').map(p => ({ pad: p.pad, label: '1' }))
    case 'pinout':
      return pins.filter(p => p.pin != null).map(p => ({ pad: p.pad, label: PRINTED[p.name] ?? p.name }))
  }
}

/** Korean particle after a part name: 을/를, 이라고/라고... by whether the word, read aloud, ends in a consonant. */
export function josa(word: string, withFinal: string, without: string): string {
  const c = word.trim().slice(-1)
  const code = c.charCodeAt(0)
  let final: boolean
  if (code >= 0xac00 && code <= 0xd7a3) final = (code - 0xac00) % 28 !== 0
  else if (/[0-9]/.test(c)) final = '013678'.includes(c)          // 영/공 일 삼 육 칠 팔
  else final = /[LMNRlmnr]/.test(c)                                // 엘 엠 엔 알
  return word + (final ? withFinal : without)
}

const METER_TIP = '표시가 헷갈리면 멀티미터를 다이오드 모드로 두고 재 봅니다. 불이 켜질 때 검은 선(COM)이 닿은 쪽이 −입니다.'

/** A part family to buy, not a pattern: 'L78xx' reads 'L7805 같은 L78xx 계열'. */
function buyable(assumed: string): string {
  return /xx$/i.test(assumed) ? `${assumed.replace(/xx$/i, '05')} 같은 ${assumed} 계열` : assumed
}

/** How a three-legged part goes in, from its footprint's silkscreen (KiCad TO-92 and TO-220 outlines). */
function legsWay(footprint: string): string {
  if (/TO-92/.test(footprint)) return '몸통의 평평한 면(글자가 적힌 면)이 기판 그림의 곧은 선 쪽을 보게 꽂습니다.'
  if (/TO-220/.test(footprint)) return '뒤쪽 금속 판(구멍 뚫린 탭)이 기판 그림의 좁은 띠 쪽으로 가게 꽂습니다.'
  // four legs in a rectangle: it also fits turned around, so the printed + decides
  if (/TO-269AA|Diode_Bridge/.test(footprint)) return '몸통에 찍힌 +·−·~ 표시를 기판의 같은 표시 자리에 맞춥니다. 돌려도 들어가는 모양이라 + 자리를 꼭 확인합니다.'
  return '다리 모양대로 한 방향으로만 들어맞습니다.'
}

/** What to look for on the real part and which board label it goes to, in plain words (no pad numbers). */
function describe(part: string, kind: ReviewKind, pins: ReviewPin[], marks: ReviewMark[], assumed: string | null,
  style: 'smd' | 'tht', footprint: string): { what: string; tip?: string } {
  // without a pin map the board labels are missing: point at the silkscreen instead
  const spot = (label: string) => (marks.some(m => m.label === label) ? `기판의 ${label} 자리` : '기판 실크의 표시')
  switch (kind) {
    case 'polarity':
      if (part === 'LED') return style === 'smd'
        ? { what: `칩 LED는 − 쪽(캐소드)에 보통 초록색 줄이나 점이 있습니다(제조사마다 다릅니다). 그쪽을 ${spot(MINUS)}에 맞춥니다.`, tip: METER_TIP }
        : { what: `다리가 짧은 쪽, 몸통 테두리가 평평하게 깎인 쪽이 −(캐소드)입니다. 그 다리를 ${spot(MINUS)}에 꽂습니다.`, tip: METER_TIP }
      if (part === 'D') return { what: `몸통에 띠가 그려진 쪽이 −(캐소드)입니다. 띠가 ${spot(MINUS)} 쪽으로 오게 놓습니다.` }
      if (part === 'CP') return style === 'smd'
        ? { what: `윗면에 검게 칠한 반달 쪽이 −입니다. 그쪽을 ${spot(MINUS)}에 맞춥니다.`, tip: '아래 받침대의 모서리가 깎인 쪽은 +입니다.' }
        : { what: `다리가 긴 쪽이 +, 몸통에 − 표시 띠가 있는 쪽이 −입니다. + 다리를 ${spot('+')}에 꽂습니다.` }
      if (part === 'Battery') return { what: `배터리의 빨간 선(+)을 ${spot('+')}에, 검은 선(−)을 ${spot(MINUS)}에 연결합니다.` }
      return { what: `윗면에 + 표시가 있거나 다리가 긴 쪽이 +입니다. 그쪽을 ${spot('+')}에 맞춥니다.` }
    case 'orientation':
      return style === 'smd'
        ? { what: `몸통 모서리의 작은 점 바로 옆 다리가 1번입니다. 점이 없으면 글자가 바로 읽히게 놓았을 때 왼쪽 아래 다리가 1번입니다. 1번 다리를 ${spot('1')}에 맞춥니다.` }
        : { what: `몸통 끝의 반달 홈을 위로 두었을 때 왼쪽 맨 위 다리가 1번입니다(작은 점이 있으면 그 옆 다리). 1번 다리를 ${spot('1')}에 꽂습니다.` }
    case 'pinout': {
      const order = marks.map(m => m.label).join('·')
      return {
        what: `같은 이름이어도 제조사마다 다리 순서가 다를 수 있는 부품입니다.${assumed ? ` ${josa(buyable(assumed), '을', '를')} 사면 다리 순서가 이 기판과 맞습니다.` : ''} ${legsWay(footprint)}`,
        tip: order ? `다른 부품을 샀다면 판매 페이지의 다리 그림이 기판에 표시한 ${order} 자리와 같은지 봅니다.` : undefined,
      }
    }
    case 'connector': {
      const first = pins.find(p => p.pad === '1')
      return { what: `1번 핀은 네모난 패드(${spot('1')})이고 ${first?.net ? `${first.net} 선` : '아무 선과도 연결되지 않은 핀'}입니다. 전선이나 짝 커넥터의 1번을 여기에 맞춥니다.` }
    }
  }
}

/** Generator warnings like "Q1 (LM7805): wired with the AMS1117 pinout for SMD", by ref. */
export function pinoutWarnings(final: BoardModel): Map<string, { raw: string; value: string; assumed: string }> {
  const out = new Map<string, { raw: string; value: string; assumed: string }>()
  for (const w of final.warnings || []) {
    const m = /^(\S+) \((.*)\): wired with the (\S+) pinout for (\w+)$/.exec(w)
    if (m) out.set(m[1], { raw: w, value: m[2], assumed: m[3] })
  }
  return out
}

export function reviewItems(final: BoardModel): ReviewItem[] {
  const style = final.style === 'tht' ? 'tht' : 'smd'
  const warned = pinoutWarnings(final)
  const items: ReviewItem[] = []
  for (const p of final.parts) {
    const kind = kindOf(p.part)
    if (!kind) continue
    const pins = pinsOf(p)
    const assumed = ASSUMED[p.part]?.[style] ?? null
    // the server's own words decide which value and which assumed part are named
    const w = warned.get(p.ref)
    const warning = w
      ? `회로에는 ${josa(w.value, '이라고', '라고')} 적혀 있지만 기판은 ${w.assumed}의 다리 순서로 만들었습니다. ${josa(w.assumed, '을', '를')} 쓰거나, 다리 순서가 같은 부품인지 꼭 확인합니다.`
      : undefined
    const marks = marksOf(kind, pins)
    items.push({
      ref: p.ref, value: p.value, part: p.part, kind, pins, warning, marks,
      ...describe(p.part, kind, pins, marks, assumed, style, p.footprint),
      key: [p.ref, p.part, p.value, p.footprint, pins.map(x => `${x.pad}:${x.pin ?? ''}:${x.net ?? ''}`).join(',')].join('|'),
    })
  }
  // parts the generator already doubts come first, then by reference
  const refOrder = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })
  return items.sort((a, b) => Number(!!b.warning) - Number(!!a.warning) || refOrder(a.ref, b.ref))
}

// ── what the person has confirmed, kept in this browser only ────────────────────

/** "맞췄어요": every item of this part confirmed now (items confirmed earlier keep their time). */
export function confirmReviews(ref: string, items: Pick<ReviewItem, 'ref' | 'key'>[], reviewed: Record<string, number>,
  now: number): Record<string, number> {
  const next = { ...reviewed }
  for (const it of items) if (it.ref === ref && !next[it.key]) next[it.key] = now
  return next
}

export const REVIEW_STORE = 'sf_human_review_v1'
const MAX_KEPT = 500

/** key -> time it was confirmed. Missing or broken storage reads as "nothing confirmed". */
export function loadReviewed(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Record<string, number> {
  try {
    const raw = storage?.getItem(REVIEW_STORE)
    const data = raw ? JSON.parse(raw) : {}
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'number')) as Record<string, number>
  } catch {
    return {}
  }
}

/** Saves, keeping the newest MAX_KEPT entries. Returns what was kept. */
export function saveReviewed(map: Record<string, number>,
  storage: Pick<Storage, 'setItem'> | null = safeStorage()): Record<string, number> {
  const kept = Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, MAX_KEPT))
  try { storage?.setItem(REVIEW_STORE, JSON.stringify(kept)) } catch { /* private mode or full: keep in memory */ }
  return kept
}

function safeStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}
