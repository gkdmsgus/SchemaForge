// Stage-4 checks 25-29: what the model is told and how a proposal is judged, without a model or server.
// Uses the NE555 board from test_circuits (generated into a temp dir).
// Usage (from server/): npx tsx check_ai_layout.ts   — exit 0 only if all pass
import { execFileSync } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { better, decouplingPairs, describeBoard, metricsOf, precheck, type Overrides } from './ai_layout'

const work = mkdtempSync(join(tmpdir(), 'sf_ailayout_'))
copyFileSync(join('test_circuits', 'ne555_blink.py'), join(work, 'ne555_blink.py'))
execFileSync('python', ['ne555_blink.py'], { cwd: work })
execFileSync('python', [join(process.cwd(), 'pcb_generator.py'), join(work, 'ne555_blink.net'), join(work, 'b.kicad_pcb'), '--style', 'smd'],
  { cwd: process.cwd() })
const board = JSON.parse(readFileSync(join(work, 'b.board.json'), 'utf8'))
const base = (): Overrides => ({
  parts: Object.fromEntries(board.parts.map((p: { ref: string; x: number; y: number; rot: number }) => [p.ref, [p.x, p.y, p.rot]])),
  net_width: {},
})
const part = (ref: string) => board.parts.find((p: { ref: string }) => p.ref === ref)

let ok = true
const check = (name: string, pass: boolean, info: string) => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

// 25. decoupling capacitors are found: a two-pad C between a supply net and GND, measured to an IC pin on that supply
const pairs = decouplingPairs(board)
check('25 decoupling found', pairs.length >= 1 && pairs.every(d => d.ic.startsWith('U') && d.dist > 0),
  pairs.map(d => `${d.cap}/${d.net}->${d.ic}.${d.pin} ${d.dist} mm`).join(', '))

// 26. the prompt carries courtyards, nearest-neighbour gaps and the decoupling distance
const prompt = describeBoard(board, metricsOf({}, 0, board), [])
check('26 prompt has geometry', /keep-out .* mm\), nearest \w+ gap/.test(prompt) && /Decoupling capacitors \(/.test(prompt)
  && /decoupling distance total/.test(prompt), `${prompt.split('\n').length} lines`)

// 27. precheck rejects a move onto another part and a move off the board, and accepts no-op
const cap = pairs[0].cap
const victim = board.parts.find((p: { ref: string; keepout?: number[] }) => p.ref !== cap && p.keepout)
const onTop = base(); onTop.parts[cap] = [victim.x, victim.y, part(cap).rot]
const offBoard = base(); offBoard.parts[cap] = [part(cap).x + 60, part(cap).y, part(cap).rot]
const p1 = precheck(board, onTop), p2 = precheck(board, offBoard), p3 = precheck(board, base())
check('27 precheck', p1.some(s => s.includes('overlap')) && p2.some(s => s.includes('outline')) && p3.length === 0,
  `onTop=[${p1.join('; ')}] offBoard=[${p2.join('; ')}] none=${p3.length}`)

// 27b. the move gpt-5.4-mini actually proposed on 2026-09-15 (C3 +5.5, -2.5 mm), which broke routing, is caught
const real = base(); const c3 = part('C3')
if (c3) real.parts.C3 = [c3.x + 5.5, c3.y - 2.5, c3.rot]
const p5 = c3 ? precheck(board, real) : []
check('27b real rolled-back move caught', !!c3 && p5.some(s => s.startsWith('C3 would overlap')), `[${p5.join('; ')}]`)

// 28. a 90-degree rotation is checked with the turned courtyard (a square-ish part may pass, a long part near a neighbour may not)
const turned = base(); const u = board.parts.find((p: { ref: string }) => p.ref.startsWith('U'))
turned.parts[u.ref] = [u.x, u.y, (u.rot + 90) % 360]
const p4 = precheck(board, turned)
check('28 rotation precheck runs', Array.isArray(p4), `U rotate 90: [${p4.join('; ') || 'no collision'}]`)

// 29. with everything else equal, a shorter decoupling distance wins; a DRC error still outranks it
const m = metricsOf({ hpwl: 80, vias: 5, track_length: 90 }, 0, board)
const closer = { ...m, decap: Math.max(0, m.decap - 2), hpwl: m.hpwl + 3 }
const closerButDrc = { ...closer, drcErrors: 1 }
check('29 score order', better(closer, m) && !better(closerButDrc, m) && !better(m, m),
  `decap ${m.decap} -> ${closer.decap} with HPWL +3 kept; with a DRC error rejected`)

// 29b. the trade gpt-5.4-mini got kept on 2026-09-15 (decap -0.68 mm for HPWL +6.1 mm and one more via)
//      is no longer an improvement; a sub-step decap change falls through to wire length.
const tiny = { ...m, decap: m.decap - 0.68, hpwl: m.hpwl + 6.1, vias: m.vias + 1 }
const tinyShorter = { ...m, decap: m.decap - 0.03, hpwl: m.hpwl - 0.12 }
check('29b small decap gain cannot buy wire length', !better(tiny, m) && better(tinyShorter, m),
  'decap -0.68/HPWL +6.1 rejected, decap -0.03/HPWL -0.12 kept on HPWL')

// 30. precheck agrees with the generator's own overlap check (pcb/board.py, fixed placement, no routing)
//     on a grid of C3 moves, including the two the model proposed that precheck used to let through.
const moves: [number, number][] = [[2, -0.5], [2, 0.5], [2.5, -2.5], [5.5, -2.5], [-1, 0], [0, 1.5], [1, -1], [0, -3]]
const py = `
import json, sys
sys.path.insert(0, 'pcb')
from board import generate
net, work, c3, moves = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4])
base = json.load(open(work + '/b.board.json', encoding='utf-8'))
out = []
for dx, dy in moves:
    ov = {'parts': {p['ref']: [p['x'], p['y'], p['rot']] for p in base['parts']}, 'net_width': {}}
    ov['parts']['C3'] = [c3[0] + dx, c3[1] + dy, c3[2]]
    s = generate(net, work + '/m.kicad_pcb', 'smd', placer='fixed', overrides=ov, route=False)
    out.append([pair for pair in s['overlaps'] if 'C3' in pair])
print(json.dumps(out))
`
if (c3) {
  const gen = JSON.parse(execFileSync('python', ['-c', py, join(work, 'ne555_blink.net'), work,
    JSON.stringify([c3.x, c3.y, c3.rot]), JSON.stringify(moves)], { cwd: process.cwd() }).toString().trim().split('\n').pop()!)
  const rows = moves.map(([dx, dy], i) => {
    const ov = base(); ov.parts.C3 = [c3.x + dx, c3.y + dy, c3.rot]
    const pre = precheck(board, ov).filter(s => s.includes('overlap')).length > 0
    return { move: `${dx},${dy}`, generator: gen[i].length > 0, precheck: pre }
  })
  const agree = rows.every(r => r.generator === r.precheck)
  check('30 precheck = generator overlaps', agree,
    rows.map(r => `${r.move}:${r.generator ? 'G' : '-'}${r.precheck ? 'P' : '-'}`).join(' '))
}

console.log(ok ? 'ALL PASS' : 'SOME CHECKS FAILED')
process.exit(ok ? 0 : 1)
