import type { BoardModel } from '../types'

// What a person has to confirm on a finished board: the things the automatic checks
// cannot see. DRC proves the copper follows the footprint; it cannot prove the real
// part's pinout or polarity matches that footprint. One item per part that has a
// polarity, a pinout that depends on the exact part, a pin-1 mark, or an external
// connection order.

export type ReviewKind = 'polarity' | 'pinout' | 'orientation' | 'connector'

export const KIND_LABEL: Record<ReviewKind, string> = {
  polarity: '극성', pinout: '핀 배열', orientation: '1번 핀 방향', connector: '커넥터 순서',
}

/** Pin names of the skidl part templates (server/index.ts SYSTEM_PROMPT), by template pin number. */
export const PIN_NAMES: Record<string, string[]> = {
  CP: ['+', '-'],
  LED: ['A', 'K'],
  D: ['A', 'K'],
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
}

function kindOf(part: string): ReviewKind | null {
  if (['LED', 'D', 'CP', 'Buzzer', 'Battery'].includes(part)) return 'polarity'
  if (['Q_NPN', 'Q_NMOS', 'REG', 'Relay'].includes(part)) return 'pinout'
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

export interface ReviewItem {
  ref: string
  value: string
  part: string
  kind: ReviewKind
  what: string            // one line: what to compare against the real part
  pins: ReviewPin[]
  warning?: string        // the generator assumed a different part's pinout (Korean)
  key: string             // changes when the footprint, the value or the pad wiring changes
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

function padNamed(pins: ReviewPin[], name: string): string | null {
  return pins.find(p => p.name === name)?.pad ?? null
}

function describe(part: string, kind: ReviewKind, pins: ReviewPin[], assumed: string | null): string {
  const at = (name: string) => {
    const pad = padNamed(pins, name)
    return pad ? `패드 ${pad}` : '표시된 패드'
  }
  switch (kind) {
    case 'polarity':
      if (part === 'LED') return `캐소드(K, 짧은 다리·평평한 면)를 ${at('K')}에 맞춥니다.`
      if (part === 'D') return `띠가 있는 쪽(캐소드 K)을 ${at('K')}에 맞춥니다.`
      if (part === 'CP') return `+ 다리(긴 다리)를 ${at('+')}에 맞춥니다. 몸통의 띠는 − 쪽입니다.`
      if (part === 'Battery') return `배터리 + 선을 ${at('+')}에 연결합니다.`
      return `+ 표시를 ${at('+')}에 맞춥니다.`
    case 'pinout':
      return `고른 부품 데이터시트의 핀 배열이 아래와 같은지 확인합니다${assumed ? ` (이 기판은 ${assumed} 기준)` : ''}.`
    case 'orientation':
      return '부품의 1번 핀 표시(점·홈)를 실크의 1번 표시 쪽에 맞춥니다.'
    case 'connector': {
      const first = pins.find(p => p.pad === '1')
      return `1번 핀(네모 패드)이 ${first?.net ?? '연결 없음'}입니다. 짝 커넥터와 전선 순서를 맞춥니다.`
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
      ? `값은 ${w.value}인데 ${w.assumed} 핀 배열로 배선됐습니다. 실제 부품의 핀 배열과 다를 수 있습니다.`
      : undefined
    items.push({
      ref: p.ref, value: p.value, part: p.part, kind, pins, warning,
      what: describe(p.part, kind, pins, assumed),
      key: [p.ref, p.part, p.value, p.footprint, pins.map(x => `${x.pad}:${x.pin ?? ''}:${x.net ?? ''}`).join(',')].join('|'),
    })
  }
  // parts the generator already doubts come first, then by reference
  const refOrder = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })
  return items.sort((a, b) => Number(!!b.warning) - Number(!!a.warning) || refOrder(a.ref, b.ref))
}

// ── what the person has confirmed, kept in this browser only ────────────────────

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
