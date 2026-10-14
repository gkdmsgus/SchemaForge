/**
 * Checks for the person's review list (src/lib/humanReview.ts) and its row in the check list.
 *
 * Run: npx tsx scripts/check_human_review.ts
 * Uses every routed *.board.json in server/outputs, the part templates in server/index.ts
 * and the pin tables in server/pcb/footprints_table.py as the reference.
 * Exit code 0 only if every check passes.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ASSUMED, PIN_NAMES, REVIEW_STORE, loadReviewed, reviewItems, saveReviewed, type ReviewItem,
} from '../src/lib/humanReview.ts'
import { HUMAN_ROW, checkRows, overall, summarize } from '../src/lib/boardChecks.ts'
import type { BoardModel, DrcResult } from '../src/types.ts'

let failed = 0
function check(name: string, ok: boolean, info = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`)
}
const clean: DrcResult = { available: true, violations: [], unconnected: 0, errors: 0, warnings: 0 }
const outDir = path.join('server', 'outputs')
const boards = fs.readdirSync(outDir).filter(f => f.endsWith('.board.json'))
  .map(f => ({ f, b: JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf-8')) as BoardModel }))
  .filter(x => x.b.tracks && x.b.parts.some(p => p.pad_pins))
const pick = (pred: (b: BoardModel) => boolean) => boards.find(x => pred(x.b))?.b
const pins = (it: ReviewItem) => Object.fromEntries(it.pins.map(p => [p.pad, p.name]))

// H1. only parts with a polarity, an exact-part pinout, a pin-1 mark or a connector order
{
  const target = /^(LED|D|CP|Buzzer|Battery|Q_NPN|Q_NMOS|REG|Relay|NE555|Conn_01x\d\d)$/
  const bad: string[] = []
  let n = 0
  for (const { f, b } of boards) {
    const refs = new Set(reviewItems(b).map(i => i.ref))
    n += refs.size
    for (const p of b.parts) if (target.test(p.part) !== refs.has(p.ref)) bad.push(`${f}:${p.ref}(${p.part})`)
  }
  check('H1 review targets', bad.length === 0 && n > 0, `${boards.length} boards, ${n} items${bad.length ? ' bad ' + bad.slice(0, 4) : ''}`)
}

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

// H3. the pad each item names is the pad the generator wired (footprints_table.py)
{
  const table = fs.readFileSync(path.join('server', 'pcb', 'footprints_table.py'), 'utf-8')
  const diodeMap = /DIODE_MAP = \{1: '(\d)', 2: '(\d)'\}/.exec(table)!
  const kPad = diodeMap[2]                                      // template pin 2 = K
  const diodes = boards.flatMap(x => reviewItems(x.b)).filter(i => i.part === 'D' || i.part === 'LED')
  check('H3 diode/LED cathode pad', diodes.length > 0 && diodes.every(i => pins(i)[kPad] === 'K' && i.what.includes(`패드 ${kPad}`)),
    `K on pad ${kPad}, ${diodes.length} items`)
  const caps = boards.flatMap(x => reviewItems(x.b)).filter(i => i.part === 'CP')
  check('H3b electrolytic + pad', caps.length > 0 && caps.every(i => pins(i)['1'] === '+' && i.what.includes('패드 1')), `${caps.length} items`)
  // datasheet pinouts recorded in footprints_table.py's docstring
  const fet = (style: 'smd' | 'tht') => pick(b => b.style === style && b.parts.some(p => p.part === 'Q_NMOS'))
  const want = { smd: { 1: 'G', 2: 'S', 3: 'D' }, tht: { 1: 'S', 2: 'G', 3: 'D' } }   // 2N7002 SOT-23, 2N7000 TO-92
  for (const style of ['smd', 'tht'] as const) {
    const b = fet(style)
    const it = b && reviewItems(b).find(i => i.part === 'Q_NMOS')
    check(`H3c N-MOSFET pinout ${style}`, !!it && JSON.stringify(pins(it)) === JSON.stringify(want[style]),
      it ? JSON.stringify(pins(it)) : 'no board with Q_NMOS')
  }
}

// H4. a confirmation follows the wiring, not the position
{
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
}

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
  const b = pick(x => reviewItems(x).length > 0 && !(x.erc || []).length && !(x.unrouted || []).length && !(x.warnings || []).length)!
  const items = reviewItems(b)
  const none = checkRows(clean, b, { items, reviewed: new Set() })
  const row0 = none.find(r => r.id === HUMAN_ROW)!
  check('H6 nothing confirmed -> review', row0.state === 'review' && row0.count === items.length
    && row0.note === `0/${items.length} 확인` && overall(summarize(none)).text === `확인 ${items.length}`)
  const all = checkRows(clean, b, { items, reviewed: new Set(items.map(i => i.key)) })
  const row1 = all.find(r => r.id === HUMAN_ROW)!
  check('H6b all confirmed -> pass, board passes', row1.state === 'pass' && overall(summarize(all)).tone === 'ok',
    overall(summarize(all)).text)
  const noReview = checkRows(clean, b)
  check('H6c no review info -> no row', !noReview.some(r => r.id === HUMAN_ROW))
}

// H7. a pinout warning moves into its part's item; other warnings stay in their own row
{
  const base = pick(x => x.parts.some(p => p.part === 'Q_NMOS') && x.style === 'smd')!
  const q = base.parts.find(p => p.part === 'Q_NMOS')!
  const b: BoardModel = { ...base, warnings: [
    `${q.ref} (BS170): wired with the 2N7002 pinout for SMD`,
    `${q.ref} pin 4 has no pad in Package_TO_SOT_SMD:SOT-23`,
  ] }
  const items = reviewItems(b)
  const it = items.find(i => i.ref === q.ref)!
  check('H7 warning attached to its item, item first', !!it.warning && it.warning.includes('BS170') && it.warning.includes('2N7002')
    && items[0].ref === q.ref, it.warning)
  const rows = checkRows(clean, b, { items, reviewed: new Set() })
  const left = rows.find(r => r.id === 'pinout_assumed')
  check('H7b only the other warning stays', !!left && left.count === 1 && left.detail[0].includes('has no pad'))
}

console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
