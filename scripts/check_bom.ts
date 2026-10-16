/**
 * Checks for the bill of materials (src/lib/bom.ts) and the BOM tab that shows it.
 *
 * Run: npx tsx scripts/check_bom.ts
 * Uses hand-made circuits, every routed *.board.json in server/outputs (in a git worktree
 * without outputs, the main checkout's), the ASSUMED table in src/lib/humanReview.ts and
 * the resistor rating in src/lib/partSpecs.ts as the reference.
 * Exit code 0 only if every check passes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  BOM_COLUMNS, FURNITURE, SEARCH_WORD, bomCsv, bomTsv, buildBom, furnitureSummary, normValue, pkgLabel, priceTotal, safeMouserUrl, searchKeyword,
  type BomBoard, type BomMatch,
} from '../src/lib/bom.ts'
import { ASSUMED } from '../src/lib/humanReview.ts'
import { SPECS } from '../src/lib/partSpecs.ts'
import type { BoardModel, ComponentEntry } from '../src/types.ts'

let failed = 0
function check(name: string, ok: boolean, info = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`)
}
const comp = (ref: string, value: string, name: string): ComponentEntry => ({ ref, value, name })
const fp = (part: string, footprint: string) => ({ part, footprint })

/** RFC 4180 reader: quoted fields, doubled quotes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); out.push(row); row = []; cell = ''; i++ }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); out.push(row) }
  return out
}

// B1. same template and value: one line, qty 3, refs in order
{
  const bom = buildBom([comp('R5', '470', 'R'), comp('R3', '470', 'R'), comp('R4', '470', 'R'), comp('D1', 'LED', 'LED')], null, 'smd')
  const r = bom.lines.find(l => l.part === 'R')
  check('B1 group 470 x3', bom.lines.length === 2 && r?.qty === 3 && r.refs.join(', ') === 'R3, R4, R5', r ? `${r.refs.join(', ')} x${r.qty}` : 'no R line')
}

// B2. value normalisation: spaces and Ω merge; case and ratings do not
{
  const bom = buildBom([comp('R1', '4.7k', 'R'), comp('R2', '4.7 kΩ', 'R'), comp('R3', '1M', 'R'), comp('R4', '1m', 'R'),
    comp('R5', '680 1W', 'R'), comp('R6', '680 1/4W', 'R'), comp('C1', '4.7µF', 'C'), comp('C2', '4.7uF', 'C')], null, 'smd')
  const together = (a: string, b: string) => bom.lines.some(l => l.refs.includes(a) && l.refs.includes(b))
  check('B2 value normalisation',
    together('R1', 'R2') && !together('R3', 'R4') && !together('R5', 'R6') && together('C1', 'C2') && normValue('470 ohms') === '470',
    bom.lines.map(l => l.refs.join('+')).join(' | '))
}

// B3. natural ref order: R2 before R10, lines ordered by their first ref
{
  const bom = buildBom([comp('R10', '1k', 'R'), comp('R2', '1k', 'R'), comp('C1', '10nF', 'C')], null, 'smd')
  check('B3 natural order', bom.lines[0].refs[0] === 'C1' && bom.lines[1].refs.join(',') === 'R2,R10', bom.lines.map(l => l.refs.join(',')).join(' | '))
}

// B4. a value changed after the PCB: that ref has no footprint and is reported as stale
{
  const board: BomBoard = { parts: [
    { ref: 'R3', value: '470', ...fp('R', 'Resistor_SMD:R_0805_2012Metric') },
    { ref: 'R4', value: '470', ...fp('R', 'Resistor_SMD:R_0805_2012Metric') },
    { ref: 'R9', value: '1k', ...fp('R', 'Resistor_SMD:R_0805_2012Metric') },
  ] }
  const bom = buildBom([comp('R3', '1k', 'R'), comp('R4', '470', 'R')], board, 'smd')
  const r3 = bom.lines.find(l => l.refs.includes('R3')), r4 = bom.lines.find(l => l.refs.includes('R4'))
  check('B4 stale footprint', r3?.footprint === null && !!r3.stale && r4?.pkg === '0805' && bom.stale.join(',') === 'R3,R9',
    `R3 ${r3?.footprint} R4 ${r4?.pkg} stale ${bom.stale}`)
}

// B5. unmapped parts are flagged and never blank in the CSV (also the board's placeholder footprint)
{
  const board: BomBoard = {
    parts: [{ ref: 'U1', value: 'LM358', ...fp('OpAmp', 'SchemaForge:UNMAPPED_OpAmp') }, { ref: 'U2', value: 'X1', ...fp('Foo', 'SchemaForge:UNMAPPED_Foo') }],
    unmapped: [{ ref: 'U1', part: 'OpAmp', reason: 'template is a 5-pin single op-amp' }],
  }
  const bom = buildBom([comp('U1', 'LM358', 'OpAmp'), comp('U2', 'X1', 'Foo')], board, 'smd')
  const rows = parseCsv(bomCsv(bom).slice(1))
  const col = BOM_COLUMNS.indexOf('Footprint')
  check('B5 unmapped flagged', bom.lines.every(l => !!l.unmapped && l.footprint === null) && rows.slice(1).every(r => r[col] === 'UNMAPPED'),
    bom.lines.map(l => `${l.refs}: ${l.unmapped}`).join(' | '))
}

// B6. CSV: quotes and commas survive, formulas neutralised, CRLF, exact header, BOM as the first character
{
  const bom = buildBom([comp('J1', '2.2" panel, 5V', 'Conn_01x02'), comp('R1', '=HYPERLINK("x")', 'R'), comp('R2', '@SUM(1)', 'R'), comp('R3', '+5V', 'R')], null, 'smd')
  const csv = bomCsv(bom)
  const rows = parseCsv(csv.slice(1))
  const vals = rows.slice(1).map(r => r[BOM_COLUMNS.indexOf('Value')])
  check('B6 CSV escaping',
    csv.charCodeAt(0) === 0xfeff && !/[^\r]\n/.test(csv) && csv.endsWith('\r\n') &&
    JSON.stringify(rows[0]) === JSON.stringify([...BOM_COLUMNS]) && rows.every(r => r.length === BOM_COLUMNS.length) &&
    vals.includes('2.2" panel, 5V') && vals.includes(`'=HYPERLINK("x")`) && vals.includes(`'@SUM(1)`) && vals.includes('+5V'),
    vals.join(' | '))
  const tsv = bomTsv(bom).replace(/\n$/, '').split('\n')
  check('B6b TSV columns', tsv.every(l => l.split('\t').length === BOM_COLUMNS.length) && tsv.some(l => l.includes(`'=HYPERLINK`)), `${tsv.length} rows`)
}

// B7. Mouser columns only from real matches
{
  const bom = buildBom([comp('R1', '1k', 'R'), comp('C1', '10nF', 'C')], null, 'smd')
  const cols = ['Manufacturer', 'Manufacturer PN', 'Mouser PN'].map(c => BOM_COLUMNS.indexOf(c as typeof BOM_COLUMNS[number]))
  const empty = parseCsv(bomCsv(bom).slice(1)).slice(1).every(r => cols.every(c => r[c] === ''))
  const matches = new Map<string, BomMatch>([[bom.lines[0].key, { mouserPart: '603-RC0805FR-071KL', mfgPart: 'RC0805FR-071KL', manufacturer: 'YAGEO' }]])
  const filled = parseCsv(bomCsv(bom, matches).slice(1)).slice(1)
  check('B7 no shop data without a match', empty && filled[0][cols[2]] === '603-RC0805FR-071KL' && cols.every(c => filled[1][c] === ''))
}

// B8. real boards: every part in exactly one line, test pads and holes listed apart
{
  const newest: BomBoard = { parts: [
    ['BT1', '9V', 'Battery', 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical'], ['C1', '100uF', 'C', 'Capacitor_SMD:C_0805_2012Metric'],
    ['C2', '10nF', 'C', 'Capacitor_SMD:C_0805_2012Metric'], ...['D1', 'D2', 'D3'].map(r => [r, 'LED', 'LED', 'LED_SMD:LED_0805_2012Metric']),
    ['R1', '4.7k', 'R', 'Resistor_SMD:R_0805_2012Metric'], ['R2', '10k', 'R', 'Resistor_SMD:R_0805_2012Metric'],
    ...['R3', 'R4', 'R5'].map(r => [r, '470', 'R', 'Resistor_SMD:R_0805_2012Metric']), ['U1', 'NE555', 'NE555', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm'],
    ['TP1', 'GND', 'TestPoint', 'TestPoint:TestPoint_Pad_D1.5mm'], ['TP2', 'VCC', 'TestPoint', 'TestPoint:TestPoint_Pad_D1.5mm'],
    ...['H1', 'H2', 'H3', 'H4'].map(r => [r, 'M3', 'MountingHole', 'MountingHole:MountingHole_3.2mm_M3']),
  ].map(([ref, value, part, footprint]) => ({ ref, value, part, footprint })) }
  const real = (b: BomBoard) => b.parts.filter(p => !FURNITURE.has(p.part)).map(p => comp(p.ref, p.value, p.part))
  const nb = buildBom(real(newest), newest, 'smd')
  const pcs = nb.lines.reduce((s, l) => s + l.qty, 0)
  check('B8a newest board 8 lines, 12 parts, 6 furniture', nb.lines.length === 8 && pcs === 12 && nb.furniture.length === 6 &&
    nb.lines.map(l => l.pkg).join(',') === 'PinHeader_1x02,0805,0805,0805,0805,0805,0805,SOIC-8' &&
    furnitureSummary(nb.furniture) === 'TP1, TP2 (테스트 패드) · H1–H4 (M3 구멍)',
    `${nb.lines.length} lines, ${pcs} parts, ${nb.furniture.length} furniture: ${furnitureSummary(nb.furniture)}`)

  // outputs are git-ignored: a worktree reads the main checkout's
  const dirs = [path.join('server', 'outputs')]
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf-8' }).trim()
    dirs.push(path.join(path.dirname(common), 'server', 'outputs'))
  } catch { /* not a git checkout */ }
  const dir = dirs.find(d => fs.existsSync(d) && fs.readdirSync(d).some(f => f.endsWith('.board.json')))
  const boards = dir ? fs.readdirSync(dir).filter(f => f.endsWith('.board.json'))
    .map(f => ({ f, b: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as BoardModel }))
    .filter(x => x.b.tracks) : []
  const bad: string[] = []
  let lines = 0
  for (const { f, b } of boards) {
    const board: BomBoard = { parts: b.parts, unmapped: b.unmapped }
    const bom = buildBom(real(board), board, b.style === 'tht' ? 'tht' : 'smd')
    lines += bom.lines.length
    const seen = bom.lines.flatMap(l => l.refs)
    const sum = bom.lines.reduce((s, l) => s + l.qty, 0)
    const realRefs = board.parts.filter(p => !FURNITURE.has(p.part)).map(p => p.ref)
    if (sum + bom.furniture.length !== b.parts.length) bad.push(`${f}: ${sum}+${bom.furniture.length} != ${b.parts.length}`)
    if (new Set(seen).size !== seen.length || realRefs.some(r => !seen.includes(r))) bad.push(`${f}: refs not covered once`)
    if (seen.some(r => /^(TP|H)\d+$/.test(r))) bad.push(`${f}: furniture in lines`)
    if (bom.stale.length) bad.push(`${f}: stale ${bom.stale}`)
    if (bom.lines.some(l => !l.unmapped && (!l.footprint || !l.pkg))) bad.push(`${f}: line without footprint`)
  }
  check('B8b routed boards fully covered', boards.length > 0 && bad.length === 0,
    `${boards.length} boards, ${lines} lines${dir ? '' : ' (no server/outputs found)'}${bad.length ? ' bad ' + bad.slice(0, 3).join(' | ') : ''}`)
}

// B8c. every footprint the PCB can use gets a short package label
{
  const table = fs.readFileSync(path.join('server', 'pcb', 'footprints_table.py'), 'utf-8')
  const all = [...new Set([...table.matchAll(/\('(\w+)', '(?:smd|tht)'\):\s*\('([\w.-]+)', '([^']+)'/g)]
    .filter(m => !FURNITURE.has(m[1])).map(m => `${m[2]}:${m[3]}`))]
  const long = all.map(f => [f, pkgLabel(f)!] as const).filter(([, l]) => !l || l.length > 16)
  check('B8c short package labels', all.length >= 20 && long.length === 0,
    long.length ? long.map(([f, l]) => `${f} -> ${l}`).join(' | ') : `${all.length} footprints`)
}

// B9. notes come from the tables the PCB and the checks use
{
  const parts = Object.keys(ASSUMED)
  const mk = (style: 'smd' | 'tht') => buildBom([...parts.map((p, i) => comp(`U${i + 1}`, 'X', p)), comp('R1', '1k', 'R'), comp('BT1', '9V', 'Battery')], null, style)
  const smd = mk('smd'), tht = mk('tht')
  const bad = parts.filter((p, i) => smd.lines.find(l => l.refs.includes(`U${i + 1}`))?.pinout !== ASSUMED[p].smd ||
    tht.lines.find(l => l.refs.includes(`U${i + 1}`))?.pinout !== ASSUMED[p].tht)
  const q = (b: typeof smd) => b.lines.find(l => l.part === 'Q_NPN')?.pinout
  const r = (b: typeof smd) => b.lines.find(l => l.part === 'R')?.notes.join(' ')
  check('B9 notes from code tables', bad.length === 0 && q(smd) === 'MMBT3904' && q(tht) === '2N3904' &&
    r(smd) === `정격 ${SPECS.res.smd.p_max.v} W 기준` && r(tht) === `정격 ${SPECS.res.tht.p_max.v} W 기준` &&
    smd.lines.find(l => l.part === 'Battery')?.notes.some(n => n.includes('2핀 헤더')) === true,
    bad.length ? `bad ${bad}` : `${q(smd)} / ${q(tht)}, ${r(smd)} / ${r(tht)}`)
}

// B10. search words, links and prices from the shop
{
  const kw = [
    searchKeyword({ part: 'LED', value: 'RED', pkg: '0805' }), searchKeyword({ part: 'R', value: '470', pkg: '0805' }),
    searchKeyword({ part: 'NE555', value: 'NE555', pkg: 'SOIC-8' }), searchKeyword({ part: 'Battery', value: '9V', pkg: 'PinHeader_1x02' }),
    searchKeyword({ part: 'Conn_01x03', value: 'SERVO', pkg: 'PinHeader_1x03' }), searchKeyword({ part: 'R', value: '470', pkg: 'Axial DIN0207' }),
  ]
  check('B10 search keywords', JSON.stringify(kw) === JSON.stringify(['LED RED 0805', 'resistor 470 0805', 'NE555 SOIC-8', 'battery 9V',
    'pin header 1x03 2.54mm', 'resistor 470']), kw.join(' | '))
  check('B10b product links', safeMouserUrl('https://www.mouser.com/ProductDetail/x') !== null && safeMouserUrl('javascript:alert(1)') === null &&
    safeMouserUrl('http://www.mouser.com/x') === null && safeMouserUrl('https://mouser.com.evil.example/x') === null)
  const bom = buildBom([comp('R1', '1k', 'R'), comp('R2', '1k', 'R'), comp('C1', '10nF', 'C')], null, 'smd')
  const [a, b] = bom.lines.map(l => l.key)   // C1 line, then R1+R2
  const same = priceTotal(bom.lines, new Map([[a, { mouserPart: 'x', price: '$0.10' }], [b, { mouserPart: 'y', price: '$1,000.05' }]]))
  const mixed = priceTotal(bom.lines, new Map([[a, { mouserPart: 'x', price: '$0.10' }], [b, { mouserPart: 'y', price: '₩139' }]]))
  const unclear = priceTotal(bom.lines, new Map([[a, { mouserPart: 'x', price: '0,10 €' }]]))
  check('B10c price total', !!same && Math.abs(same.total - 2000.2) < 1e-9 && same.currency === '$' && same.priced === 2 && mixed === null && unclear === null,
    same ? `${same.total} ${same.currency}` : 'no total')
}

// B12. the server never invents shop data and searches with the BOM's own words
{
  const server = fs.readFileSync(path.join('server', 'index.ts'), 'utf-8')
  const route = server.slice(server.indexOf('// ── POST /mouser_search'), server.indexOf('// ── POST /generate_gerber'))
  const words = Object.fromEntries([...(/const MOUSER_WORD[^{]*\{([\s\S]*?)\n\}/.exec(route)?.[1] ?? '').matchAll(/(\w+): '([^']+)'/g)].map(m => [m[1], m[2]]))
  check('B12 server: no invented Mouser data', !/mock/i.test(route) && /available: false/.test(route) && /available: true/.test(route) &&
    /MOUSER_MAX_LINES/.test(route) && !/\bSMD\b/.test(route) && !/cartUrl/.test(route))
  check('B12b server search words = src/lib/bom.ts', JSON.stringify(words) === JSON.stringify(SEARCH_WORD), `${Object.keys(words).length} words`)
  const vite = fs.readFileSync('vite.config.ts', 'utf-8')
  check('B12c no dead /mouser_cart proxy', !vite.includes('/mouser_cart') && vite.includes('/mouser_search'))
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall BOM checks passed')
process.exit(failed ? 1 : 0)
