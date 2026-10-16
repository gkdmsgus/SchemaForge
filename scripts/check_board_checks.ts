/**
 * Checks for the rule list in the board view (src/lib/boardChecks.ts).
 *
 * Run: npx tsx scripts/check_board_checks.ts
 * Uses every *.board.json in server/outputs as real input, plus hand-made cases.
 * Exit code 0 only if every check passes.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ERC_RULES, TONE_COLOR, checkRows, connectionCount, overall, stampText, summarize, type CheckRow,
} from '../src/lib/boardChecks.ts'
import { PIN_NAMES } from '../src/lib/humanReview.ts'
import type { BoardModel, DrcResult } from '../src/types.ts'

let failed = 0
function check(name: string, ok: boolean, info = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`)
}
const byId = (rows: CheckRow[]) => Object.fromEntries(rows.map(r => [r.id, r]))
const clean: DrcResult = { available: true, violations: [], unconnected: 0, errors: 0, warnings: 0 }

const outDir = path.join('server', 'outputs')
const boards = fs.readdirSync(outDir).filter(f => f.endsWith('.board.json'))
  .map(f => ({ f, b: JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf-8')) as BoardModel }))
const routed = boards.filter(x => x.b.tracks && x.b.erc)
const sample = routed.find(x => (x.b.erc || []).length === 0 && !(x.b.unrouted || []).length)!.b

// 1. nothing has arrived yet: every row waits, nothing claims a pass
{
  const rows = checkRows(null, null)
  const s = summarize(rows)
  check('1 all pending before results', rows.every(r => r.state === 'pending') && s.pending && s.passed === 0
    && overall(s).text === '검사 중', rows.map(r => r.state).join(','))
}

// 2. KiCad missing: DRC rows say skipped (never pass), the rest still runs
{
  const rows = checkRows({ available: false, reason: 'kicad-cli를 찾지 못했습니다' }, sample)
  const r = byId(rows)
  const s = summarize(rows)
  check('2 no KiCad -> DRC skipped with reason',
    r.kicad_drc.state === 'skipped' && r.kicad_unconnected.state === 'skipped'
    && r.kicad_drc.detail[0].includes('kicad-cli') && s.skipped === 2 && overall(s).tone === 'warn'
    && stampText(r.kicad_drc) === '건너뜀', overall(s).text)
}

// 3. clean board: every rule passes, the routing note counts connections
{
  const rows = checkRows(clean, sample)
  const s = summarize(rows)
  const total = connectionCount(sample)
  check('3 clean board passes every rule', rows.every(r => r.state === 'pass') && s.passed === s.ran
    && overall(s).text === '검사 통과', `${s.passed}/${s.ran}`)
  check('3b routing note', byId(rows).routing.note === `${total}/${total} 연결`, byId(rows).routing.note)
}

// 4. every ERC rule the server runs has its own row, in the server's order
{
  const ids = checkRows(clean, sample).map(r => r.id)
  const ercIds = ERC_RULES.map(([id]) => id)
  const erc = fs.readFileSync(path.join('server', 'pcb', 'erc.py'), 'utf-8')
  const inServer = [...erc.matchAll(/'rule': '(\w+)'/g)].map(m => m[1])
  check('4 rows cover erc.py rules', JSON.stringify(inServer) === JSON.stringify(ercIds)
    && ercIds.every(id => ids.includes(id)), inServer.join(','))
  check('4b row ids unique', new Set(ids).size === ids.length)
}

// 5. DRC: an error and a warning, counted and linked to their findings
{
  const drc: DrcResult = {
    available: true, unconnected: 2, errors: 1, warnings: 1,
    violations: [
      { type: 'clearance', severity: 'error', description: 'Clearance violation', items: [] },
      { type: 'silk_overlap', severity: 'warning', description: 'Silkscreen overlap', items: [] },
    ],
  }
  const r = byId(checkRows(drc, sample))
  check('5 DRC error counted', r.kicad_drc.state === 'error' && r.kicad_drc.count === 1
    && JSON.stringify(r.kicad_drc.findings) === '["drc0","drc1"]' && stampText(r.kicad_drc) === '오류 1')
  check('5b unconnected counted', r.kicad_unconnected.state === 'error' && r.kicad_unconnected.count === 2)
  const onlyWarn = byId(checkRows({ ...drc, unconnected: 0, violations: [drc.violations![1]] }, sample))
  check('5c warning only -> warn', onlyWarn.kicad_drc.state === 'warn' && stampText(onlyWarn.kicad_drc) === '경고 1')
}

// 6. unrouted connections, unknown rules, unmapped parts, assumed pinouts
{
  const b: BoardModel = {
    ...sample,
    unrouted: [{ net: 'GND', from: 'R1.2', to: 'C1.2' }],
    erc: [{ rule: 'new_rule', severity: 'warning', message: 'x', refs: [], net: null }],
    unmapped: [{ ref: 'U9', part: 'ESP32', reason: 'no footprint' }],
    warnings: ['Q1 (2N7002): wired with the 2N7000 pinout for THT'],
  }
  const rows = checkRows(clean, b)
  const r = byId(rows)
  const s = summarize(rows)
  check('6 unrouted -> routing error', r.routing.state === 'error' && r.routing.count === 1
    && r.routing.findings[0] === 'unr0')
  check('6b unknown ERC rule gets a row', r.new_rule?.state === 'warn' && r.new_rule.findings[0] === 'erc0')
  check('6c unmapped part -> error', r.footprint_map.state === 'error' && r.footprint_map.detail[0].startsWith('U9'))
  check('6d assumed pinout -> review, not pass', r.pinout_assumed.state === 'review'
    && r.pinout_assumed.detail[0].includes('2N7000') && stampText(r.pinout_assumed) === '확인 1')
  check('6e summary counts', s.errors === 2 && s.warnings === 1 && s.reviews === 1
    && overall(s).text === '오류 2 · 경고 1', overall(s).text)
  const noPinout = byId(checkRows(clean, { ...sample, warnings: [] }))
  check('6f no assumed pinout -> no row (no false pass)', !noPinout.pinout_assumed)
}

// 7. real boards: every finding lands in exactly one row, counts match the board
{
  const bad: string[] = []
  for (const { f, b } of routed) {
    const rows = checkRows(clean, b)
    const linked = rows.flatMap(r => r.findings)
    const expect = [...(b.erc || []).map((_, i) => `erc${i}`), ...(b.unrouted || []).map((_, i) => `unr${i}`)]
    if (linked.length !== new Set(linked).size || expect.some(id => !linked.includes(id))) bad.push(f)
    for (const [id] of ERC_RULES) {
      const n = (b.erc || []).filter(e => e.rule === id).length
      if (byId(rows)[id].count !== n) bad.push(`${f}:${id}`)
    }
  }
  check('7 real boards: findings covered once, counts match', bad.length === 0,
    `${routed.length} boards${bad.length ? ' bad ' + bad.slice(0, 5).join(', ') : ''}`)
  const broken = routed.filter(x => (x.b.erc || []).some(e => e.severity === 'error'))
  check('7b a broken board fails', broken.length > 0
    && broken.every(x => overall(summarize(checkRows(clean, x.b))).tone === 'bad'), `${broken.length} broken boards`)
}

// 8. status colours stay readable (>= 4.5:1) on white panels, the board sheet and the beige app
{
  const lum = (h: string) => {
    const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
  }
  const surfaces = ['#ffffff', '#efefe9', '#f1ece0', '#e8e1d1', '#fbf7ec']
  const worst = Object.entries(TONE_COLOR).map(([k, c]) => [k, Math.min(...surfaces.map(s => ratio(c, s)))] as const)
  check('8 tone contrast >= 4.5', worst.every(([, r]) => r >= 4.5),
    worst.map(([k, r]) => `${k} ${r.toFixed(2)}`).join(', '))
}

// 9. a floating pin is named by its symbol pin ("4번(RESET)"): erc.py's table is the same as humanReview's
{
  const src = fs.readFileSync(path.join('server', 'pcb', 'erc.py'), 'utf-8')
  const block = /PIN_NAMES = \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? ''
  const py: Record<string, string[]> = {}
  for (const m of block.matchAll(/'([^']+)':\s*\[([^\]]*)\]/g)) py[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1])
  const same = JSON.stringify(Object.entries(py).sort()) === JSON.stringify(Object.entries(PIN_NAMES).sort())
  check('9 erc.py PIN_NAMES = humanReview PIN_NAMES', Object.keys(py).length > 0 && same, `${Object.keys(py).length} templates in erc.py`)
}

console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
