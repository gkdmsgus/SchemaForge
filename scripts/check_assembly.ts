/**
 * Checks for the assembly view (배치하기): ticking off parts placed on the real board.
 *
 * Run: npx tsx scripts/check_assembly.ts
 * Pure helpers (src/lib/assembly.ts) with a fake storage, and BoardView rendered on the server in both
 * modes from a small hand-made board. Exit code 0 only if every check passes.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import BoardView from '../src/components/BoardView.tsx'
import { PLACED_STORE, assemblyRefs, loadPlaced, placedKey, savePlaced } from '../src/lib/assembly.ts'
import type { AiRound, BoardFrame, BoardModel, BoardPart } from '../src/types.ts'

let failed = 0
function check(name: string, ok: boolean, info = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`)
}

/** a Storage stand-in; `broken` throws on every call like a blocked one */
function store(init: Record<string, string> = {}, broken = false) {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k: string) => { if (broken) throw new Error('blocked'); return m.get(k) ?? null },
    setItem: (k: string, v: string) => { if (broken) throw new Error('blocked'); m.set(k, v) },
    raw: m,
  }
}

const pad = (num: string, x: number, net: string | null) =>
  ({ num, type: 'smd', shape: 'rect', x, y: 0, angle: 0, w: 1, h: 1, drill: null, net })
const part = (ref: string, value: string, kind: string, x: number, y: number, pads: ReturnType<typeof pad>[]): BoardPart & { x: number; y: number; rot: number } =>
  ({ ref, value, part: kind, footprint: `X:${kind}`, bbox: [-1.5, -1, 1.5, 1], pads, x, y, rot: 0 })
const parts = [
  part('R10', '1k', 'R', 6, 5, [pad('1', -1, 'VCC'), pad('2', 1, 'A')]),
  part('R2', '1k', 'R', 6, 10, [pad('1', -1, 'VCC'), pad('2', 1, 'B')]),
  part('D1', 'RED', 'LED', 14, 5, [pad('1', -1, 'GND'), pad('2', 1, 'A')]),
  part('TP1', 'GND', 'TestPoint', 14, 10, [pad('1', 0, 'GND')]),
  part('H1', 'M3', 'MountingHole', 2, 2, []),
]
const final: BoardModel = { outline: [0, 0, 20, 14], parts, nets: ['VCC', 'GND', 'A', 'B'], style: 'smd', erc: [], tracks: [], vias: [], unrouted: [] }

// A1. the parts to place: no test pads or holes, R2 before R10
check('A1 parts to place', assemblyRefs(final).join() === 'D1,R2,R10', assemblyRefs(final).join())

// A2. missing, broken or foreign storage reads as nothing placed; refs the board no longer has are dropped
{
  const refs = assemblyRefs(final)
  const stale = store({ [PLACED_STORE]: JSON.stringify({ 'a.kicad_pcb': { at: 1, refs: ['R2', 'Q9', 7] } }) })
  check('A2 load is forgiving', loadPlaced('a.kicad_pcb', refs, null).size === 0 && loadPlaced('a.kicad_pcb', refs, store({}, true)).size === 0
    && loadPlaced('a.kicad_pcb', refs, store({ [PLACED_STORE]: '{bad json' })).size === 0
    && loadPlaced('a.kicad_pcb', refs, store({ [PLACED_STORE]: '[1,2]' })).size === 0
    && [...loadPlaced('a.kicad_pcb', refs, stale)].join() === 'R2' && loadPlaced(undefined, refs, stale).size === 0)
}

// A3. saved per board file and read back; another board is untouched; the 50 most recent boards are kept
{
  const s = store()
  savePlaced('a.kicad_pcb', new Set(['R10', 'D1']), s, 100)
  savePlaced('b.kicad_pcb', new Set(['R2']), s, 200)
  const a = [...loadPlaced('a.kicad_pcb', assemblyRefs(final), s)].join(), b = [...loadPlaced('b.kicad_pcb', assemblyRefs(final), s)].join()
  for (let i = 0; i < 60; i++) savePlaced(`n${i}.kicad_pcb`, new Set(['R2']), s, 1000 + i)
  const kept = Object.keys(JSON.parse(s.raw.get(PLACED_STORE)!))
  let threw = false
  try { savePlaced('a.kicad_pcb', new Set(['R2']), store({}, true)) } catch { threw = true }
  check('A3 save per board, capped, never throws', a === 'D1,R10' && b === 'R2' && kept.length === 50 && !kept.includes('a.kicad_pcb') && !threw,
    `a=${a} b=${b} kept=${kept.length}`)
}

// rendered on the server: the first render is what the user sees before any effect runs
const frames: BoardFrame[] = [{ iter: 0, phase: 'refine', hpwl: 10, parts: Object.fromEntries(parts.map(p => [p.ref, [p.x, p.y, p.rot]])) }]
const ai: AiRound[] = [{ round: 1, part: 'place', reason: 'C1을 U1 가까이로 옮깁니다', actions: { moves: [] }, before: { hpwl: 10, vias: 0, unrouted: 0, drcErrors: 0 } as never, kept: false } as never]
const render = (mode: 'build' | 'assembly') => renderToStaticMarkup(createElement(BoardView, {
  parts, frames, routes: [], target: null, final, drc: null, ai, status: 'done', mode, pcbFilename: undefined,
}))

// A4. the assembly view: the finished board at once, a click target on every part to place (none on pads or holes),
//     the list beside it, no 3D, no checks list, no AI rounds
{
  const html = render('assembly')
  const hits = [...html.matchAll(/data-assembly-hit="([^"]+)"/g)].map(m => m[1])
  const has = (id: string) => html.includes(`data-testid="${id}"`)
  const want = { panel: has('assembly-panel'), count: has('assembly-count'), status: has('board-assembly'), fit: has('board-fit'),
    noChecks: !has('board-checks'), noAi: !has('board-ai'), no3d: !has('view-3d') }
  check('A4 assembly view', hits.join() === 'D1,R2,R10' && Object.values(want).every(Boolean),
    `hits=${hits.join()} ${Object.entries(want).filter(([, v]) => !v).map(([k]) => k).join(',') || 'all present'}`)
  const lines = [...html.matchAll(/data-assembly-line="([^"]+)"/g)].map(m => m[1])
  check('A4b the list groups like the BOM', lines.join(' | ') === 'D1 | R2,R10', lines.join(' | '))
}

// A5. the build view: the AI rounds fold to one line (they no longer cover the board), no assembly parts
{
  const html = render('build')
  check('A5 build view: AI rounds folded, no assembly', html.includes('data-testid="board-ai-toggle"') && html.includes('aria-expanded="false"')
    && !html.includes('C1을 U1 가까이로') && !html.includes('data-assembly-hit') && !html.includes('assembly-panel'))
}

// A6. the storage key names the board: the same netlist made again as THT, or with a part moved, starts empty
{
  const k = placedKey('a.kicad_pcb', final)
  const tht = placedKey('a.kicad_pcb', { ...final, style: 'tht' })
  const moved = placedKey('a.kicad_pcb', { ...final, parts: parts.map(p => (p.ref === 'R2' ? { ...p, x: p.x + 1 } : p)) })
  const again = placedKey('a.kicad_pcb', { ...final, parts: [...parts].reverse() })
  check('A6 key per board, not per file name', !!k && k === again && k !== tht && k !== moved && placedKey(undefined, final) === null,
    `${k} | tht ${tht} | moved ${moved}`)
}

// A7. the assembly view draws board.json itself: a part the AI loop moved after the playback is where the file has it
{
  const movedFinal: BoardModel = { ...final, parts: parts.map(p => (p.ref === 'R2' ? { ...p, x: 16 } : p)) }
  const html = renderToStaticMarkup(createElement(BoardView, {
    parts, frames, routes: [], target: null, final: movedFinal, drc: null, ai: [], status: 'done', mode: 'assembly',
  }))
  const r2 = /data-assembly-hit="R2" x="([\d.-]+)"/.exec(html)?.[1]
  check('A7 assembly uses the final positions', r2 != null && Math.abs(Number(r2) - (16 - 1.5 - 0.4)) < 1e-6, `R2 hit x=${r2}`)
}

// A8. an AI loop that was skipped says so and opens by itself (folded it would read as a round tried and undone)
{
  const skipped: AiRound[] = [{ round: 0, reason: 'AI 다듬기를 건너뜁니다: key missing', actions: {}, before: { hpwl: 10, vias: 0, unrouted: 0, drcErrors: 0 } as never, kept: false } as never]
  const html = renderToStaticMarkup(createElement(BoardView, { parts, frames, routes: [], target: null, final, drc: null, ai: skipped, status: 'done' }))
  check('A8 skipped AI loop is shown open', html.includes('AI 다듬기 건너뜀') && html.includes('aria-expanded="true"') && html.includes('key missing'))
}

// A9. a part with a polarity/pinout review has its own button that shows it without ticking the part
{
  const html = render('assembly')
  check('A9 review button beside the chip', html.includes('data-assembly-info="D1"') && !html.includes('data-assembly-info="R2"'))
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall assembly checks passed')
process.exit(failed ? 1 : 0)
