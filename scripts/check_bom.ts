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
  FURNITURE, buildBom, furnitureSummary, normValue, pkgLabel, type BomBoard,
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

console.log(failed ? `\n${failed} check(s) failed` : '\nall BOM checks passed')
process.exit(failed ? 1 : 0)
