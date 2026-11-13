import type { BoardModel } from '../types'
import { fromBoard, netLevels, type NetLevel } from './operatingCheck'

// The measurement plan: where the board's test points are and what each should read once it runs, for a person with a
// multimeter or a prober that finds pads by their coordinates (src-yt-capstone2026-snu-probe-it in the vault: a prober
// reads KiCad pad positions). The test points are the ones the generator adds on the supply nets (server/pcb/board.py
// add_test_points); the expected ranges are the operating check's own (netLevels), with its datasheet basis, never a
// tolerance made up here. check_measure_plan.ts

export interface MeasurePoint {
  /** the test point's reference on the board (TP1) */
  tp: string
  net: string
  /** KiCad coordinates in mm (y grows downwards), as in the .kicad_pcb */
  x: number
  y: number
  /** from the board outline's top-left corner, mm */
  fromCorner: { x: number; y: number }
  /** an SMD pad is on the top copper only; a through-hole one can be probed from either side */
  side: 'top' | 'both'
  /** volts against the ground test point; null when the checks do not know the level (basis says why) */
  expect: { lo: number; hi: number } | null
  basis: string
  /** the condition the level holds under (a switch closed, a 555 output HIGH) */
  when?: string
}

export interface MeasurePlan {
  format: 'schemaforge-measure-plan'
  version: 1
  units: 'mm'
  outline: { x1: number; y1: number; x2: number; y2: number }
  /** the test point to hold the black lead or the prober's ground on, when the board has one on a 0 V net */
  ground: string | null
  points: MeasurePoint[]
  /** nets with a known level above 0 V and no test point on them */
  noTestPoint: { net: string; expect: { lo: number; hi: number }; when?: string }[]
  caution: string
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

export function measurePlan(b: BoardModel): MeasurePlan {
  const circuit = fromBoard(b)
  const levels = netLevels(circuit)
  const [x1, y1, x2, y2] = b.outline
  // a board saved before its pins were mapped has none of its nets in the circuit: said as the reason, not as a net with no part
  const none = circuit.missing?.length ? '핀 대응 정보가 없는 예전 보드라 동작 검사를 하지 않았습니다. PCB를 다시 생성하면 기대 전압이 나옵니다'
    : '이 넷에 이어진 부품이 동작 검사에 없습니다'
  const level = (net: string): NetLevel => levels.get(net) ?? { why: none }
  const points: MeasurePoint[] = (b.parts || []).filter(p => p.part === 'TestPoint').map(p => {
    const abs = (p as { pads_abs?: { x: number; y: number; net: string | null }[] }).pads_abs?.[0]
    const x = abs?.x ?? p.x, y = abs?.y ?? p.y
    const net = abs?.net ?? p.pads?.[0]?.net ?? p.value
    const lv = level(net)
    return {
      tp: p.ref, net, x: round(x), y: round(y), fromCorner: { x: round(x - x1), y: round(y - y1) },
      side: (p.pads?.[0]?.type === 'smd' ? 'top' : 'both') as MeasurePoint['side'],
      expect: lv.lo != null ? { lo: round(lv.lo, 2), hi: round(lv.hi, 2) } : null,
      basis: lv.why,
      ...('when' in lv && lv.when ? { when: lv.when } : {}),
    }
  }).sort((a, z) => a.tp.localeCompare(z.tp, 'en', { numeric: true }))
  const probed = new Set(points.map(p => p.net))
  const noTestPoint = [...levels].flatMap(([net, lv]) => (!probed.has(net) && lv.lo != null && lv.hi > 0.05
    ? [{ net, expect: { lo: round(lv.lo, 2), hi: round(lv.hi, 2) }, ...(lv.when ? { when: lv.when } : {}) }] : []))
  return {
    format: 'schemaforge-measure-plan', version: 1, units: 'mm',
    outline: { x1, y1, x2, y2 },
    ground: points.find(p => p.expect && p.expect.hi === 0)?.tp ?? null,
    points, noTestPoint,
    caution: '전원을 켠 채 잴 때는 탐침이 옆 패드나 부품 다리에 닿지 않게 합니다. 기대 전압은 동작 검사가 데이터시트로 계산한 범위이고, 실제 부품 값의 오차는 더하지 않았습니다. 전지 전압은 공칭값이라 실제로는 남은 양에 따라 다릅니다.',
  }
}

const volts = (e: { lo: number; hi: number }) => (e.lo === e.hi ? `${e.hi} V` : `${e.lo}~${e.hi} V`)
const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

/** the same plan as a table a person reads beside the board (Excel opens it: UTF-8 with a BOM) */
export function measurePlanCsv(plan: MeasurePlan): string {
  const head = ['테스트 포인트', '넷', '기판 왼쪽 위에서 X (mm)', '기판 왼쪽 위에서 Y (mm)', '찍는 면', '기대 전압 (GND 기준)', '조건', '근거']
  const rows = plan.points.map(p => [p.tp, p.net, String(p.fromCorner.x), String(p.fromCorner.y), p.side === 'top' ? '윗면' : '양면',
    p.expect ? volts(p.expect) : '모름', p.when ?? '', p.basis])
  return '\uFEFF' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n'
}
