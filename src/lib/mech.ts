// The board an enclosure fixes (기구 조건, steps 1 and 2): its size, its mounting
// holes and the parts pinned to its edges, typed before the PCB is made. The server checks them again (server/index.ts cleanMech) and the
// generator places the parts inside that board, around those holes, or says the circuit does not fit.

export type MechSide = 'left' | 'right' | 'top' | 'bottom'
/** a part pinned to an edge: its body's middle `at` mm along that side (from the top on the left and right, from the left on top and bottom) */
export interface MechPin { ref: string; side: MechSide; at: number; rot?: number }
export interface Mech { width: number; height: number; holes: [number, number][]; fixed?: MechPin[] }

export const MECH_MIN = 5, MECH_MAX = 500, MECH_HOLES = 12, MECH_FIXED = 8
export const SIDE_WORDS: Record<MechSide, string> = { left: '왼쪽', right: '오른쪽', top: '위', bottom: '아래' }
const SIDES: Record<string, MechSide> = { 왼쪽: 'left', 오른쪽: 'right', 위: 'top', 위쪽: 'top', 아래: 'bottom', 아래쪽: 'bottom',
  left: 'left', right: 'right', top: 'top', bottom: 'bottom' }

const num = (t: string) => {
  const s = t.trim().replace(/\s*mm$/i, '')
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN
}

/**
 * The inputs as a board: width and height in mm, holes as "x, y" pairs split by ";" or new lines, in mm from the
 * board's top-left corner, and pinned parts as "J1, 왼쪽, 15" or "J1, 왼쪽, 15, 90" one a line (part, side, mm along it,
 * turn). All empty is no board (the PCB is sized from the parts as before).
 */
export function parseMech(width: string, height: string, holes: string, fixed = ''): { mech: Mech | null; error: string } {
  if (!width.trim() && !height.trim() && !holes.trim() && !fixed.trim()) return { mech: null, error: '' }
  if (!width.trim() || !height.trim()) return { mech: null, error: '가로와 세로를 둘 다 적어 주세요.' }
  const w = num(width), h = num(height)
  if (Number.isNaN(w) || Number.isNaN(h)) return { mech: null, error: '가로와 세로는 mm 단위 숫자로 적어 주세요 (예: 40).' }
  if (w < MECH_MIN || w > MECH_MAX || h < MECH_MIN || h > MECH_MAX) {
    return { mech: null, error: `가로와 세로는 ${MECH_MIN}~${MECH_MAX} mm 사이로 적어 주세요.` }
  }
  const pairs = holes.split(/[;\n]/).map(s => s.trim()).filter(Boolean)
  if (pairs.length > MECH_HOLES) return { mech: null, error: `고정 구멍은 ${MECH_HOLES}개까지 적을 수 있습니다.` }
  const out: [number, number][] = []
  for (const [i, p] of pairs.entries()) {
    const xy = p.split(',').map(num)
    if (xy.length !== 2 || xy.some(Number.isNaN)) return { mech: null, error: `구멍 ${i + 1}번 "${p}"을 읽지 못했습니다. "x, y"처럼 적어 주세요 (예: 4, 5).` }
    const [x, y] = xy
    if (x > w || y > h) return { mech: null, error: `구멍 ${i + 1}번 (${x}, ${y})이 ${w} × ${h} mm 기판 밖에 있습니다.` }
    out.push([x, y])
  }
  const lines = fixed.split(/[;\n]/).map(s => s.trim()).filter(Boolean)
  if (lines.length > MECH_FIXED) return { mech: null, error: `고정 부품은 ${MECH_FIXED}개까지 적을 수 있습니다.` }
  const pins: MechPin[] = []
  for (const [i, line] of lines.entries()) {
    const f = line.split(/\s*,\s*|\s+/).filter(Boolean)
    const side = SIDES[(f[1] || '').toLowerCase()]
    const at = num(f[2] || ''), rot = f[3] === undefined ? undefined : num(f[3].replace(/°$/, ''))
    if (f.length < 3 || f.length > 4 || !/^[A-Za-z]{1,4}\d{1,4}$/.test(f[0]) || !side || Number.isNaN(at)) {
      return { mech: null, error: `고정 부품 ${i + 1}번째 줄("${line}")을 읽지 못했습니다. "J1, 왼쪽, 15"처럼 부품 번호, 변(왼쪽·오른쪽·위·아래), 자리(mm)로 적어 주세요.` }
    }
    if (rot !== undefined && ![0, 90, 180, 270].includes(rot)) return { mech: null, error: `고정 부품 ${i + 1}번째 줄("${line}")의 회전은 0, 90, 180, 270 중 하나로 적어 주세요.` }
    const length = side === 'left' || side === 'right' ? h : w
    if (at > length) return { mech: null, error: `고정 부품 ${i + 1}번째 줄("${line}")의 자리 ${at} mm가 ${SIDE_WORDS[side]} 변(길이 ${length} mm)을 벗어납니다.` }
    if (pins.some(p => p.ref.toUpperCase() === f[0].toUpperCase())) return { mech: null, error: `고정 부품 ${f[0]}의 자리가 두 번 적혀 있습니다.` }
    pins.push({ ref: f[0].toUpperCase(), side, at, ...(rot !== undefined ? { rot } : {}) })
  }
  return { mech: { width: w, height: h, holes: out, ...(pins.length ? { fixed: pins } : {}) }, error: '' }
}

/** a pinned part as the box shows it again: "J1, 왼쪽, 15" */
export const pinText = (p: MechPin) => `${p.ref}, ${SIDE_WORDS[p.side]}, ${p.at}${p.rot !== undefined ? `, ${p.rot}` : ''}`

/** what the button says once a board is set */
export const mechLabel = (m: Mech) => `${m.width} × ${m.height} mm${m.holes.length ? ` · 구멍 ${m.holes.length}개` : ' · 구멍 없음'}`
  + (m.fixed?.length ? ` · 고정 ${m.fixed.length}개` : '')
