// The board an enclosure fixes (기구 조건, step 1): its size and its mounting
// holes, typed as numbers before the PCB is made. The server checks them again (server/index.ts cleanMech) and the
// generator places the parts inside that board, around those holes, or says the circuit does not fit.

export interface Mech { width: number; height: number; holes: [number, number][] }

export const MECH_MIN = 5, MECH_MAX = 500, MECH_HOLES = 12

const num = (t: string) => {
  const s = t.trim().replace(/\s*mm$/i, '')
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN
}

/**
 * The inputs as a board: width and height in mm, holes as "x, y" pairs split by ";" or new lines, in mm from the
 * board's top-left corner. All three empty is no board (the PCB is sized from the parts as before).
 */
export function parseMech(width: string, height: string, holes: string): { mech: Mech | null; error: string } {
  if (!width.trim() && !height.trim() && !holes.trim()) return { mech: null, error: '' }
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
  return { mech: { width: w, height: h, holes: out }, error: '' }
}

/** what the button says once a board is set */
export const mechLabel = (m: Mech) => `${m.width} × ${m.height} mm${m.holes.length ? ` · 구멍 ${m.holes.length}개` : ' · 구멍 없음'}`
