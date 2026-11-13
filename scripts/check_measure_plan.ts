/**
 * Checks for the measurement plan (src/lib/measurePlan.ts): where the board's test points are and what each should read.
 *
 * Run: npx tsx scripts/check_measure_plan.ts   (reads the check boards npm test makes in server/outputs)
 * MP1 every test point of each check board, once, at its pad's coordinates, inside the outline, on the side its pad is
 * MP2 the expected range is the operating check's own (netLevels) with its basis; the ground test point reads 0 V
 * MP3 a net with a known level and no test point is listed, with its condition (the 555's output: while HIGH)
 * MP4 the table: a BOM for Excel, one row per test point, the corner coordinates and 모름 for an unknown level; the JSON
 * MP5 a board with no test point gives none and no ground; an old board without pin maps gives no number, only the reason
 * MP6 a level behind a switch says so ("SW1이 닫혔을 때")
 */
import fs from 'node:fs'
import path from 'node:path'
import { measurePlan, measurePlanCsv } from '../src/lib/measurePlan.ts'
import { fromBoard, fromGraph, netLevels } from '../src/lib/operatingCheck.ts'
import type { BoardModel, NetGraph } from '../src/types.ts'

let ok = true
const check = (name: string, pass: boolean, info = '') => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

const outDir = path.join(process.cwd(), 'server', 'outputs')
const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(f => /^checkboard_.*\.board\.json$/.test(f)).sort() : []
const boards = files.map(f => ({ name: f.replace('.board.json', ''), b: JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')) as BoardModel }))
type Pad = { x: number; y: number; net: string | null }
const tps = (b: BoardModel) => b.parts.filter(p => p.part === 'TestPoint') as (BoardModel['parts'][number] & { pads_abs?: Pad[] })[]

// MP1
{
  const bad: string[] = []
  for (const { name, b } of boards) {
    const plan = measurePlan(b)
    const [x1, y1, x2, y2] = b.outline
    const refs = tps(b).map(p => p.ref).sort()
    if (plan.points.map(p => p.tp).sort().join() !== refs.join()) bad.push(`${name}: points ${plan.points.map(p => p.tp)} vs ${refs}`)
    for (const p of plan.points) {
      const part = tps(b).find(q => q.ref === p.tp)!
      const pad = part.pads_abs?.[0]
      if (!pad || Math.abs(pad.x - p.x) > 1e-3 || Math.abs(pad.y - p.y) > 1e-3 || pad.net !== p.net) bad.push(`${name} ${p.tp}: ${p.x},${p.y} ${p.net} vs pad ${JSON.stringify(pad)}`)
      if (!(p.fromCorner.x > 0 && p.fromCorner.x < x2 - x1 && p.fromCorner.y > 0 && p.fromCorner.y < y2 - y1)) bad.push(`${name} ${p.tp}: outside the outline ${JSON.stringify(p.fromCorner)}`)
      if (p.side !== (part.pads[0].type === 'smd' ? 'top' : 'both')) bad.push(`${name} ${p.tp}: side ${p.side} for a ${part.pads[0].type} pad`)
    }
  }
  check('MP1 every test point once, at its pad, inside the outline, SMD on top and through-hole on both sides',
    boards.length === 8 && boards.every(({ b }) => tps(b).length >= 2) && !bad.length,
    bad.length ? bad.slice(0, 3).join(' | ') : `${boards.length} boards, ${boards.reduce((n, { b }) => n + tps(b).length, 0)} test points`)
}

// MP2
{
  const bad: string[] = []
  const supply: Record<string, [string, number]> = { led_basic: ['VCC', 9], ne555_blink: ['VCC', 9], nmos_motor: ['+12V', 12], npn_relay: ['+5V', 5] }
  for (const { name, b } of boards) {
    const plan = measurePlan(b)
    const levels = netLevels(fromBoard(b))
    for (const p of plan.points) {
      const lv = levels.get(p.net)
      const want = lv && lv.lo != null ? { lo: Math.round(lv.lo * 100) / 100, hi: Math.round(lv.hi * 100) / 100 } : null
      if (JSON.stringify(p.expect) !== JSON.stringify(want) || p.basis !== lv?.why || !p.basis) bad.push(`${name} ${p.tp}: ${JSON.stringify(p.expect)} "${p.basis}" vs ${JSON.stringify(lv)}`)
    }
    const g = plan.points.find(p => p.tp === plan.ground)
    if (!g || g.net !== 'GND' || g.expect?.hi !== 0) bad.push(`${name}: ground ${plan.ground} ${JSON.stringify(g)}`)
    const [net, v] = supply[name.replace(/^checkboard_|_(smd|tht)$/g, '')] ?? ['', NaN]
    const sp = plan.points.find(p => p.net === net)
    if (!sp || sp.expect?.lo !== v || sp.expect?.hi !== v) bad.push(`${name}: ${net} ${JSON.stringify(sp?.expect)} (want ${v} V)`)
  }
  check('MP2 each expected range is the operating check\'s with its basis; GND reads 0 V; the supplies read 9, 9, 12 and 5 V', !bad.length && boards.length === 8,
    bad.slice(0, 3).join(' | '))
}

// MP3
{
  const timer = boards.filter(({ name }) => name.includes('ne555'))
  const said = timer.map(({ b }) => measurePlan(b).noTestPoint)
  const out = said.map(l => l.find(n => n.net === 'OUT'))
  const probedListed = boards.some(({ b }) => { const p = measurePlan(b); return p.noTestPoint.some(n => p.points.some(q => q.net === n.net)) })
  check('MP3 the 555\'s OUT has a level and no test point: listed with "HIGH일 때"; no net with a test point is listed', timer.length === 2
    && out.every(o => !!o && o.expect.hi > o.expect.lo && o.expect.lo > 0 && /HIGH일 때/.test(o.when ?? '')) && !probedListed,
    JSON.stringify(out))
}

// MP4
{
  const b = boards.find(({ name }) => name === 'checkboard_ne555_blink_smd')?.b
  const plan = b ? measurePlan(b) : null
  const csv = plan ? measurePlanCsv(plan) : ''
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n')
  const rows = lines.slice(1).map(l => l.split(','))
  const unknown = plan ? measurePlanCsv({ ...plan, points: plan.points.map(p => ({ ...p, expect: null })) }) : ''
  const json = plan ? JSON.parse(JSON.stringify(plan)) : null
  check('MP4 the table: BOM, a header and one row per test point with the corner coordinates and volts, 모름 when unknown; the JSON names its format',
    !!plan && csv.startsWith('\uFEFF') && lines[0].startsWith('테스트 포인트,넷,') && rows.length === plan.points.length
    && rows.every((r, i) => r.length === 8 && r[0] === plan.points[i].tp && r[2] === String(plan.points[i].fromCorner.x) && r[3] === String(plan.points[i].fromCorner.y) && /\d V$/.test(r[5]))
    && unknown.split('\r\n').slice(1, -1).every(l => l.split(',')[5] === '모름')
    && json?.format === 'schemaforge-measure-plan' && json?.version === 1 && json?.units === 'mm',
    lines.slice(0, 3).join(' / '))
}

// MP5
{
  const b = boards[0]?.b
  const bare = b ? measurePlan({ ...b, parts: b.parts.filter(p => p.part !== 'TestPoint') }) : null
  const old = b ? measurePlan({ ...b, parts: b.parts.map(p => ({ ...p, pad_pins: undefined })) }) : null
  check('MP5 no test point: no points and no ground; an old board without pin maps: no number, the reason instead',
    !!bare && !bare.points.length && bare.ground === null && !!old && old.points.length >= 2
    && old.points.every(p => p.expect === null && /동작 검사를 하지 않았습니다/.test(p.basis)) && old.ground === null,
    `${JSON.stringify(bare?.points)} | ${old?.points.map(p => `${p.tp} ${p.basis}`).join('; ')}`)
}

// MP6
{
  const g: NetGraph = {
    components: [{ ref: 'BT1', name: 'Battery', value: '9V' }, { ref: 'SW1', name: 'SW', value: 'SW' }, { ref: 'R1', name: 'R', value: '680' }, { ref: 'D1', name: 'LED', value: 'RED' }],
    nets: [
      { name: 'VCC', nodes: [{ ref: 'BT1', pin: '1' }, { ref: 'SW1', pin: '1' }] },
      { name: 'SWOUT', nodes: [{ ref: 'SW1', pin: '2' }, { ref: 'R1', pin: '1' }] },
      { name: 'LED_A', nodes: [{ ref: 'R1', pin: '2' }, { ref: 'D1', pin: '1' }] },
      { name: 'GND', nodes: [{ ref: 'D1', pin: '2' }, { ref: 'BT1', pin: '2' }] },
    ],
  }
  const lv = netLevels(fromGraph(g)).get('SWOUT')
  check('MP6 a level behind a switch says so: SWOUT 9 V "SW1이 닫혔을 때"', !!lv && lv.lo === 9 && lv.when === 'SW1이 닫혔을 때', JSON.stringify(lv))
}

if (!ok) { console.log('SOME CHECKS FAILED'); process.exitCode = 1 } else console.log('ALL PASS')
