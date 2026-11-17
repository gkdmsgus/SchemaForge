// Checks K1-K4 on the enclosure input (src/lib/mech.ts, 2026-11-17): what the "기판 크기" box reads from what is typed.
// K1 empty is no board; K2 a size and holes read as numbers in mm ("40", "30 mm", "4, 5; 36, 5" or one a line); K3 what it
// refuses says why in Korean (one side only, a word, out of 5-500 mm, a hole off the board, 13 holes, a hole it cannot read);
// K4 the button's label. The server checks the same bounds again (server/check_inputs.ts) and the generator the rest
// (server/pcb/check_mech.py).
// Usage: npx tsx scripts/check_mech.ts   → exit 0 only if all pass
import { mechLabel, parseMech } from '../src/lib/mech.ts'

let failed = 0
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`)
}

const empty = parseMech('', ' ', '')
check('K1 nothing typed is no board and no error', empty.mech === null && empty.error === '', JSON.stringify(empty))

const four = parseMech('40', '30 mm', '4, 5; 36,5\n36, 26 ; 4,26')
const bare = parseMech('25.5', '20', '')
check('K2 a size and four holes read in mm, by ";" or a new line; a size alone has no holes',
  JSON.stringify(four.mech) === JSON.stringify({ width: 40, height: 30, holes: [[4, 5], [36, 5], [36, 26], [4, 26]] }) && !four.error
  && JSON.stringify(bare.mech) === JSON.stringify({ width: 25.5, height: 20, holes: [] }),
  `${JSON.stringify(four)} | ${JSON.stringify(bare)}`)

const refusals: [string, string, string, RegExp][] = [
  ['40', '', '', /둘 다/], ['마흔', '30', '', /숫자로/], ['4', '30', '', /5~500 mm/], ['40', '600', '', /5~500 mm/],
  ['40', '30', '50, 5', /기판 밖/], ['40', '30', '4; 5', /읽지 못했습니다/], ['40', '30', Array.from({ length: 13 }, () => '5, 5').join(';'), /12개까지/],
  ['40', '30', '-4, 5', /읽지 못했습니다/],
]
const wrong = refusals.map(([w, h, holes, re]) => ({ w, h, holes, r: parseMech(w, h, holes), re }))
  .filter(({ r, re }) => r.mech !== null || !re.test(r.error))
check('K3 what it cannot use is refused with the reason in Korean, never half-read',
  wrong.length === 0, wrong.map(x => `${x.w}/${x.h}/${x.holes} -> ${JSON.stringify(x.r)}`).join(' | ') || `${refusals.length} refusals`)

check('K4 the button says the board and its holes',
  mechLabel(four.mech!) === '40 × 30 mm · 구멍 4개' && mechLabel(bare.mech!) === '25.5 × 20 mm · 구멍 없음',
  `${mechLabel(four.mech!)} | ${mechLabel(bare.mech!)}`)

console.log(failed ? `\n${failed} check(s) failed` : '\nALL PASS')
process.exit(failed ? 1 : 0)
