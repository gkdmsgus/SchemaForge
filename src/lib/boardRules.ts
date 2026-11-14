// The rules a board is drawn and checked with, and where each number comes from, for the board's check list.
// The app's values are the router's and the copper pour's (server/pcb/router.py RULES, server/pcb/board.py
// POUR_CLEARANCE); scripts/check_board_checks.ts reads those files and fails when a number here differs.
// The maker's minimums were read on the date below (docs/fabrication-guide.md, section 2).

export const FAB_SOURCE = { name: 'JLCPCB PCB 제조 능력표', url: 'https://jlcpcb.com/capabilities/pcb-capabilities', read: '2026-10-29' }

export interface BoardRule {
  /** what it limits, in plain words */
  what: string
  /** the app's value(s) in mm, named */
  app: { name: string; mm: number }[]
  /** the maker's minimum in mm for the same thing */
  fabMin: number
}

export const BOARD_RULES: BoardRule[] = [
  { what: '선 폭', app: [{ name: '신호', mm: 0.25 }, { name: '전원', mm: 0.5 }], fabMin: 0.1 },
  { what: '다른 구리와의 간격', app: [{ name: '선', mm: 0.25 }, { name: '동박(넓게 채운 구리)', mm: 0.5 }], fabMin: 0.1 },
  { what: '구리와 기판 가장자리', app: [{ name: '', mm: 0.5 }], fabMin: 0.2 },
  { what: '비아(위아래 구리를 잇는 구멍)의 구멍', app: [{ name: '', mm: 0.4 }], fabMin: 0.15 },
]

const mm = (v: number) => `${v} mm`

/** The lines under the KiCad design-rule row: what checks the board, with what numbers, from where. */
export function ruleLines(): string[] {
  return [
    'KiCad 설계 규칙 검사는 KiCad 기본 규칙으로 돌립니다. 이 앱은 따로 규칙 파일을 만들지 않습니다.',
    `선은 아래 앱 규칙으로 긋습니다. 괄호 안은 ${FAB_SOURCE.name}의 최소값입니다 (${FAB_SOURCE.read}에 읽음, ${FAB_SOURCE.url}).`,
    ...BOARD_RULES.map(r => `${r.what}: ${r.app.map(a => (a.name ? `${a.name} ${mm(a.mm)}` : mm(a.mm))).join(', ')} (최소 ${mm(r.fabMin)})`),
  ]
}
