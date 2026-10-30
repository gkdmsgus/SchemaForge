/**
 * Checks for the direction review list (src/lib/humanReview.ts) and its row in the check list.
 *
 * Run: npx tsx scripts/check_human_review.ts
 * Hand-made parts for the wording, the board labels and their positions; every routed *.board.json in
 * server/outputs (when there are any), the part templates in server/index.ts and the pin tables in
 * server/pcb/footprints_table.py as the reference for real boards. Checks that need saved boards say
 * SKIP when there are none; a skipped check is never counted as passed. Exit code 0 only if nothing failed.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ASSUMED, PIN_NAMES, REVIEW_STORE, boardMarks, josa, loadReviewed, reviewItems, saveReviewed, type ReviewItem,
} from '../src/lib/humanReview.ts'
import { HUMAN_ROW, checkRows, overall, summarize } from '../src/lib/boardChecks.ts'
import type { BoardModel, BoardPart, DrcResult } from '../src/types.ts'

let failed = 0, skipped = 0
function check(name: string, ok: boolean, info = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`)
}
/** `checks` is how many checks the skipped block holds: each one is counted as skipped, none as passed */
function skip(name: string, why: string, checks = 1) {
  skipped += checks
  console.log(`SKIP ${name}  ${why}${checks > 1 ? ` (${checks} checks)` : ''}`)
}
const clean: DrcResult = { available: true, violations: [], unconnected: 0, errors: 0, warnings: 0 }
const outDir = path.join('server', 'outputs')
const boards = (fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).filter(f => f.endsWith('.board.json'))
  .map(f => ({ f, b: JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf-8')) as BoardModel }))
  .filter(x => x.b.tracks && x.b.parts.some(p => p.pad_pins))
const pick = (pred: (b: BoardModel) => boolean) => boards.find(x => pred(x.b))?.b
const pins = (it: ReviewItem) => Object.fromEntries(it.pins.map(p => [p.pad, p.name]))
const marksOf = (it: ReviewItem) => Object.fromEntries(it.marks.map(m => [m.pad, m.label]))
const NO_BOARDS = 'no routed boards in server/outputs'

// hand-made parts: two pads 2 mm apart, the generator's pin maps (diode K on pad 1, electrolytic + on pad 1)
const two = (ref: string, part: string, padPins: Record<string, number> | undefined, footprint = `X:${part}`): BoardPart & { x: number; y: number; rot: number } => ({
  ref, value: 'V', part, footprint, bbox: [-1.5, -1, 1.5, 1], x: 10, y: 10, rot: 0, pad_pins: padPins,
  pads: [
    { num: '1', type: 'smd', shape: 'rect', x: -1, y: 0, angle: 0, w: 1, h: 1, drill: null, net: 'N1' },
    { num: '2', type: 'smd', shape: 'rect', x: 1, y: 0, angle: 0, w: 1, h: 1, drill: null, net: 'GND' },
  ],
})
/** n pads in a row with the generator's pad -> template pin map */
const legs = (ref: string, part: string, footprint: string, padPins: Record<string, number>): BoardPart & { x: number; y: number; rot: number } => ({
  ref, value: part === 'REG' ? 'L7805' : 'V', part, footprint, bbox: [-2, -2, 2, 2], x: 10, y: 20, rot: 0, pad_pins: padPins,
  pads: Object.keys(padPins).map((num, i) => ({ num, type: 'thru_hole', shape: 'oval', x: i * 2.54, y: 0, angle: 0, w: 1.5, h: 1.5, drill: 0.8, net: `N${num}` })),
})
// every kind, with the footprints and pin maps of server/pcb/footprints_table.py
const handBoard = (style: 'smd' | 'tht', extra: BoardModel['parts'] = []): BoardModel => ({
  outline: [0, 0, 30, 30], nets: ['N1', 'GND'], style, erc: [], tracks: [], vias: [], unrouted: [],
  parts: [two('D1', 'LED', { 1: 2, 2: 1 }), two('C1', 'CP', { 1: 1, 2: 2 }), two('D2', 'D', { 1: 2, 2: 1 }),
    legs('U1', 'NE555', style === 'smd' ? 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm' : 'Package_DIP:DIP-8_W7.62mm',
      { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8 }),
    style === 'smd' ? legs('Q1', 'Q_NPN', 'Package_TO_SOT_SMD:SOT-23', { 1: 1, 2: 3, 3: 2 })
      : legs('Q1', 'Q_NPN', 'Package_TO_SOT_THT:TO-92_Inline', { 1: 3, 2: 1, 3: 2 }),
    style === 'smd' ? legs('U2', 'REG', 'Package_TO_SOT_SMD:SOT-223-3_TabPin2', { 1: 1, 2: 2, 3: 3 })
      : legs('U2', 'REG', 'Package_TO_SOT_THT:TO-220-3_Vertical', { 1: 3, 2: 1, 3: 2 }),
    legs('J1', 'Conn_01x02', 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical', { 1: 1, 2: 2 }),
    style === 'smd' ? legs('D3', 'Bridge', 'Package_TO_SOT_SMD:TO-269AA', { 1: 1, 2: 2, 3: 3, 4: 4 })
      : legs('D3', 'Bridge', 'Diode_THT:Diode_Bridge_DIP-4_W7.62mm_P5.08mm', { 1: 3, 2: 4, 3: 1, 4: 2 }),
    ...extra],
})
const item = (b: BoardModel, ref: string) => reviewItems(b).find(i => i.ref === ref)!

// H1. only parts with a polarity, an exact-part pinout, a pin-1 mark or a connector order
if (boards.length) {
  const target = /^(LED|D|CP|Buzzer|Battery|Q_NPN|Q_NMOS|REG|Relay|Bridge|NE555|Conn_01x\d\d)$/
  const bad: string[] = []
  let n = 0
  for (const { f, b } of boards) {
    const refs = new Set(reviewItems(b).map(i => i.ref))
    n += refs.size
    for (const p of b.parts) if (target.test(p.part) !== refs.has(p.ref)) bad.push(`${f}:${p.ref}(${p.part})`)
  }
  check('H1 review targets', bad.length === 0 && n > 0, `${boards.length} boards, ${n} items${bad.length ? ' bad ' + bad.slice(0, 4) : ''}`)
} else skip('H1 review targets', NO_BOARDS)

// H2. pin names are the server's own part templates
{
  const prompt = fs.readFileSync(path.join('server', 'index.ts'), 'utf-8')
  const bad: string[] = []
  for (const [part, names] of Object.entries(PIN_NAMES)) {
    const line = prompt.split('\n').find(l => l.includes(`name='${part}', ref_prefix=`))
    const got = line ? [...line.matchAll(/Pin\(num=\d+,name='([^']+)'/g)].map(m => m[1]) : null
    if (JSON.stringify(got) !== JSON.stringify(names)) bad.push(`${part}: ${got} vs ${names}`)
  }
  check('H2 pin names = server templates', bad.length === 0, bad.join(' | ') || `${Object.keys(PIN_NAMES).length} parts`)
}

// H2b. "this board follows part X" names the same part as the server's ASSUMED_PART
{
  const table = fs.readFileSync(path.join('server', 'pcb', 'footprints_table.py'), 'utf-8')
  const block = /ASSUMED_PART = \{([\s\S]*?)\n\}/.exec(table)![1]
  const server = [...block.matchAll(/\('(\w+)', '(smd|tht)'\): '([^']+)'/g)].map(m => [m[1], m[2], m[3]] as const)
  const bad = server.filter(([part, style, name]) => ASSUMED[part]?.[style] !== name)
  check('H2b assumed parts = footprints_table.py', server.length > 0 && bad.length === 0,
    `${server.length} entries${bad.length ? ' bad ' + JSON.stringify(bad) : ''}`)
}

// H3. the board label sits on the pad the generator wired (footprints_table.py): − on the cathode, + on the electrolytic's +
if (boards.length) {
  const table = fs.readFileSync(path.join('server', 'pcb', 'footprints_table.py'), 'utf-8')
  const diodeMap = /DIODE_MAP = \{1: '(\d)', 2: '(\d)'\}/.exec(table)!
  const kPad = diodeMap[2]                                      // template pin 2 = K
  const aPad = diodeMap[1]
  // an open pin has no pin map (board.py maps netted pins only): such items show the one label they can, see H10
  const mapped = (i: ReviewItem) => i.pins.every(p => p.pin != null)
  const diodes = boards.flatMap(x => reviewItems(x.b)).filter(i => (i.part === 'D' || i.part === 'LED') && mapped(i))
  check('H3 diode/LED: − on the cathode pad, + on the anode', diodes.length > 0
    && diodes.every(i => pins(i)[kPad] === 'K' && marksOf(i)[kPad] === '−' && marksOf(i)[aPad] === '+'),
    `K on pad ${kPad}, ${diodes.length} items`)
  const caps = boards.flatMap(x => reviewItems(x.b)).filter(i => i.part === 'CP' && mapped(i))
  check('H3b electrolytic: + on pad 1, − on pad 2', caps.length > 0 && caps.every(i => pins(i)['1'] === '+' && marksOf(i)['1'] === '+' && marksOf(i)['2'] === '−'),
    `${caps.length} items`)
  // datasheet pinouts recorded in footprints_table.py's docstring; the board labels say the same
  const fet = (style: 'smd' | 'tht') => pick(b => b.style === style && b.parts.some(p => p.part === 'Q_NMOS'))
  const want = { smd: { 1: 'G', 2: 'S', 3: 'D' }, tht: { 1: 'S', 2: 'G', 3: 'D' } }   // 2N7002 SOT-23, 2N7000 TO-92
  for (const style of ['smd', 'tht'] as const) {
    const b = fet(style)
    const it = b && reviewItems(b).find(i => i.part === 'Q_NMOS')
    check(`H3c N-MOSFET pinout ${style}`, !!it && JSON.stringify(pins(it)) === JSON.stringify(want[style])
      && JSON.stringify(marksOf(it)) === JSON.stringify(want[style]), it ? JSON.stringify(marksOf(it)) : 'no board with Q_NMOS')
  }
} else skip('H3 board labels on real boards', NO_BOARDS, 4)

// H4. a confirmation follows the wiring, not the position
if (boards.length) {
  const b = pick(x => reviewItems(x).length >= 3)!
  const keys = (m: BoardModel) => Object.fromEntries(reviewItems(m).map(i => [i.ref, i.key]))
  const k0 = keys(b)
  const moved: BoardModel = { ...b, parts: b.parts.map(p => ({ ...p, x: p.x + 5, y: p.y - 3, rot: (p.rot + 90) % 360 })) }
  check('H4 move/rotate keeps confirmations', JSON.stringify(keys(moved)) === JSON.stringify(k0))
  const target = reviewItems(b)[0].ref
  const rewired: BoardModel = { ...b, parts: b.parts.map(p => p.ref !== target ? p : {
    ...p, pads: p.pads.map((pd, i) => (i === 0 ? { ...pd, net: 'OTHER_NET' } : pd)) }) }
  const k1 = keys(rewired)
  check('H4b rewired pad drops only that part', k1[target] !== k0[target]
    && Object.keys(k0).filter(r => r !== target).every(r => k1[r] === k0[r]))
  const revalued: BoardModel = { ...b, parts: b.parts.map(p => (p.ref !== target ? p : { ...p, value: p.value + 'X' })) }
  const refoot: BoardModel = { ...b, parts: b.parts.map(p => (p.ref !== target ? p : { ...p, footprint: p.footprint + '_THT' })) }
  check('H4c new value or footprint drops it', keys(revalued)[target] !== k0[target] && keys(refoot)[target] !== k0[target])
} else skip('H4 confirmations follow the wiring', NO_BOARDS, 3)

// H5. storage: round trip, broken data, a storage that throws, the size cap
{
  const mem: Record<string, string> = {}
  const store = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v } }
  saveReviewed({ a: 2, b: 1 }, store)
  check('H5 round trip', JSON.stringify(loadReviewed(store)) === JSON.stringify({ a: 2, b: 1 }))
  mem[REVIEW_STORE] = '{not json'
  const broken = loadReviewed(store)
  mem[REVIEW_STORE] = '[1,2]'
  const arr = loadReviewed(store)
  mem[REVIEW_STORE] = '{"a":"x","b":3}'
  const mixed = loadReviewed(store)
  check('H5b broken data reads as nothing confirmed', JSON.stringify(broken) === '{}' && JSON.stringify(arr) === '{}'
    && JSON.stringify(mixed) === '{"b":3}')
  const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
  let threw = false
  let kept: Record<string, number> = {}
  try { kept = saveReviewed({ a: 1 }, throwing); loadReviewed(throwing) } catch { threw = true }
  check('H5c storage that throws does not break the page', !threw && kept.a === 1)
  const many = Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`k${i}`, i]))
  const capped = saveReviewed(many, store)
  check('H5d keeps the newest 500', Object.keys(capped).length === 500 && !('k0' in capped) && 'k519' in capped)
}

// H6. the check-list row: count, note, pass, overall tone
{
  const b = handBoard('smd')
  const items = reviewItems(b)
  const none = checkRows(clean, b, { items, reviewed: new Set() })
  const row0 = none.find(r => r.id === HUMAN_ROW)!
  check('H6 nothing confirmed -> review', row0.state === 'review' && row0.count === items.length && row0.label === '방향 확인'
    && row0.note === `0/${items.length} 확인` && overall(summarize(none)).text === `확인 ${items.length}`, `${row0.label} ${row0.note}`)
  const all = checkRows(clean, b, { items, reviewed: new Set(items.map(i => i.key)) })
  const row1 = all.find(r => r.id === HUMAN_ROW)!
  check('H6b all confirmed -> pass, board passes', row1.state === 'pass' && overall(summarize(all)).tone === 'ok',
    overall(summarize(all)).text)
  const noReview = checkRows(clean, b)
  check('H6c no review info -> no row', !noReview.some(r => r.id === HUMAN_ROW))
}

// H7. a pinout warning moves into its part's item; other warnings stay in their own row
if (boards.some(x => x.b.style === 'smd' && x.b.parts.some(p => p.part === 'Q_NMOS'))) {
  const base = pick(x => x.parts.some(p => p.part === 'Q_NMOS') && x.style === 'smd')!
  const q = base.parts.find(p => p.part === 'Q_NMOS')!
  const b: BoardModel = { ...base, warnings: [
    `${q.ref} (BS170): wired with the 2N7002 pinout for SMD`,
    `${q.ref} pin 4 has no pad in Package_TO_SOT_SMD:SOT-23`,
  ] }
  const items = reviewItems(b)
  const it = items.find(i => i.ref === q.ref)!
  check('H7 warning attached to its item, item first', !!it.warning && it.warning.includes('BS170이라고') && it.warning.includes('2N7002를')
    && items[0].ref === q.ref, it.warning)
  const rows = checkRows(clean, b, { items, reviewed: new Set() })
  const left = rows.find(r => r.id === 'pinout_assumed')
  check('H7b only the other warning stays', !!left && left.count === 1 && left.detail[0].includes('has no pad'))
} else skip('H7 pinout warning in its item', 'no SMD board with an N-MOSFET in server/outputs', 2)

// H8. the words follow the board: a chip LED or an SMD electrolytic has no legs to talk about
{
  const smd = handBoard('smd'), tht = handBoard('tht')
  const led = { smd: item(smd, 'D1').what, tht: item(tht, 'D1').what }
  const cap = { smd: item(smd, 'C1').what, tht: item(tht, 'C1').what }
  check('H8 SMD and THT wording', led.smd.includes('칩 LED') && !led.smd.includes('다리') && led.tht.includes('짧은')
    && cap.smd.includes('반달') && !cap.smd.includes('다리') && cap.tht.includes('긴'),
    `${led.smd.slice(0, 24)}… | ${cap.smd.slice(0, 24)}…`)
  check('H8b the words point at the board label', led.smd.includes('기판의 − 자리') && cap.tht.includes('기판의 + 자리')
    && item(smd, 'D2').what.includes('기판의 − 자리'))
  // pin 1 of an IC: a dot, else the text read upright (SOIC); the notch up (DIP)
  const ic = { smd: item(smd, 'U1').what, tht: item(tht, 'U1').what }
  check('H8c IC pin 1 wording', ic.smd.includes('작은 점') && ic.smd.includes('왼쪽 아래') && ic.tht.includes('반달 홈') && ic.tht.includes('기판의 1 자리'),
    `${ic.smd.slice(0, 30)}… | ${ic.tht.slice(0, 30)}…`)
  // three legs: which way it goes in, from the footprint's silkscreen (TO-92 flat face, TO-220 tab); SMD fits one way
  const q = { smd: item(smd, 'Q1').what, tht: item(tht, 'Q1').what }, reg = { smd: item(smd, 'U2').what, tht: item(tht, 'U2').what }
  check('H8d transistor and regulator: which way they go in', q.tht.includes('평평한 면') && q.tht.includes('곧은 선') && reg.tht.includes('금속 판')
    && q.smd.includes('한 방향') && reg.smd.includes('한 방향') && q.smd.includes('MMBT3904를') && reg.tht.includes('L7805 같은 L78xx 계열을'),
    `${q.tht.slice(-40)} | ${reg.tht.slice(0, 60)}`)
}

// H9. no pad numbers or net names in what a beginner reads first (they are under 자세히)
{
  const all = [...reviewItems(handBoard('smd')), ...reviewItems(handBoard('tht')), ...boards.flatMap(x => reviewItems(x.b))]
  const bad = all.filter(i => /패드 ?\d/.test(`${i.what} ${i.tip ?? ''} ${i.warning ?? ''}`))
  check('H9 no pad numbers in the words', all.length > 0 && bad.length === 0,
    `${all.length} items${bad.length ? ' e.g. ' + bad[0].ref + ': ' + bad[0].what : ''}`)
}

// H10. every item with a pin map has its labels: + and − on two pads, 1 on pin 1, a name on every mapped pin
{
  const all = [...reviewItems(handBoard('smd')), ...boards.flatMap(x => reviewItems(x.b))]
  const bad = all.filter(i => {
    if (i.pins.every(p => p.pin == null)) return i.marks.length !== 0
    const labels = i.marks.map(m => m.label)
    const pads = new Set(i.marks.map(m => m.pad))
    if (pads.size !== i.marks.length || i.marks.some(m => !i.pins.some(p => p.pad === m.pad))) return true
    switch (i.kind) {
      case 'polarity': {
        const want = i.pins.filter(p => p.pin != null && ['+', 'A', '-', 'K'].includes(p.name))
          .map(p => `${p.pad}:${p.name === '+' || p.name === 'A' ? '+' : '−'}`).sort().join()
        return i.marks.map(m => `${m.pad}:${m.label}`).sort().join() !== want || (i.pins.every(p => p.pin != null) && !(labels.includes('+') && labels.includes('−')))
      }
      case 'orientation': return !(i.marks.length === 1 && labels[0] === '1' && i.pins.find(p => p.pad === i.marks[0].pad)?.pin === 1)
      case 'connector': return !(i.marks.length === 1 && i.marks[0].pad === '1')
      case 'pinout': return i.marks.length !== i.pins.filter(p => p.pin != null).length
    }
  })
  check('H10 board labels for every item', bad.length === 0, `${all.length} items${bad.length ? ' bad ' + bad.slice(0, 3).map(i => `${i.ref}:${JSON.stringify(i.marks)}`).join(' ') : ''}`)
}

// H11. without a pin map there is no label to point at: the words say to look at the silkscreen
{
  const b: BoardModel = { ...handBoard('smd'), parts: [two('D9', 'LED', undefined)] }
  const it = item(b, 'D9')
  check('H11 no pin map -> no labels, silkscreen named', it.marks.length === 0 && it.what.includes('기판 실크의 표시'), it.what)
}

// H12. a particle after a part name reads right (AMS1117을, 2N7002를, BS170이라고)
{
  const got = ['AMS1117', '2N7000', 'MMBT3904', '2N7002', 'L78xx', 'Sanyou SRD', '2N3904', '저항'].map(w => josa(w, '을', '를'))
  const want = ['AMS1117을', '2N7000을', 'MMBT3904를', '2N7002를', 'L78xx를', 'Sanyou SRD를', '2N3904를', '저항을']
  check('H12 particles after part names', JSON.stringify(got) === JSON.stringify(want) && josa('BS170', '이라고', '라고') === 'BS170이라고',
    got.join(' '))
}

// H13. a label lands on its pad at every rotation (KiCad: y down, rot counter-clockwise; the 2D drawing's rotate(-rot))
{
  const led = two('D1', 'LED', { 1: 2, 2: 1 })
  const items = reviewItems({ ...handBoard('smd'), parts: [led] })
  const at = (rot: number) => {
    const m = boardMarks(led, [103, 101.5, rot], items).find(q => q.label === '−')!
    return [Number(m.x.toFixed(4)), Number(m.y.toFixed(4))]
  }
  // pad 1 (K) is 1 mm to the left of the part at rot 0: up at 270 (y smaller), down at 90, right at 180
  const got = [0, 90, 180, 270].map(at)
  const want = [[102, 101.5], [103, 102.5], [104, 101.5], [103, 100.5]]
  check('H13 labels follow the part rotation', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
  check('H13b a label for a pad the part lacks is left out',
    boardMarks({ ref: 'D1', pads: led.pads.slice(1) }, [0, 0, 0], items).map(m => m.label).join() === '+')
}

// H14. a bridge rectifier: + and − on the pads server/pcb/footprints_table.py wires template pins 3 (+) and 4 (−),
// ~ on the two AC pads; the words name the part the pinout follows and say the + decides which way round
{
  const table = fs.readFileSync(path.join('server', 'pcb', 'footprints_table.py'), 'utf-8')
  const bad: string[] = []
  for (const style of ['smd', 'tht'] as const) {
    const m = new RegExp(`\\('Bridge', '${style}'\\): \\([^{]*\\{1: '(\\d)', 2: '(\\d)', 3: '(\\d)', 4: '(\\d)'\\}`).exec(table)
    const it = item(handBoard(style), 'D3')
    const want = m ? { [m[1]]: '~', [m[2]]: '~', [m[3]]: '+', [m[4]]: '−' } : null
    if (!want || JSON.stringify(marksOf(it)) !== JSON.stringify(Object.fromEntries(Object.entries(want).sort()))) bad.push(`${style} ${JSON.stringify(marksOf(it))}`)
    if (it.kind !== 'pinout' || !it.what.includes(style === 'smd' ? 'MB6S를' : 'DF06M을') || !it.what.includes('+ 자리를 꼭 확인')) bad.push(`${style}: ${it.what}`)
  }
  check('H14 bridge rectifier labels and words', bad.length === 0, bad.join(' | ') || item(handBoard('smd'), 'D3').what)
}

console.log(failed ? `${failed} CHECK(S) FAILED` : `ALL PASS${skipped ? ` (${skipped} skipped: not counted as passed)` : ''}`)
process.exit(failed ? 1 : 0)
