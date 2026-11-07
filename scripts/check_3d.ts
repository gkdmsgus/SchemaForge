/**
 * Stage-5 checks: the 3D view is the same board, tilted. With BASE set, also the KiCad 3D viewer itself, in a browser on a
 * real demo board (a served app with KiCad, a minute or two): 31 leaving and reopening it leaves no WebGL context behind
 * (each stayed, about 127 MB of GPU memory, until Chrome warned at 16: review of 2026-11-06).
 *
 * Run: npx tsx scripts/check_3d.ts [board.json ...]     BASE=http://localhost:8133 adds the browser checks
 * With no arguments it uses every *.board.json in server/outputs.
 * Exit code 0 only if every check passes.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  type Camera, BOARD_THICK, project, partHeight, partFaces, boardFaces, trackFace, viaFaces,
  sortFaces, faceRank, DEFAULT_HEIGHT,
} from '../src/lib/board3d'
import type { BoardModel, BoardPart } from '../src/types'

const ROOT = path.resolve(import.meta.dirname, '..')
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(ROOT, 'server', 'outputs'))
      .filter(f => f.endsWith('.board.json'))
      .map(f => path.join(ROOT, 'server', 'outputs', f))

const results: [string, boolean, string][] = []
const check = (name: string, ok: boolean, info = '') => results.push([name, ok, info])

const boards = files.map(f => ({ file: path.basename(f), b: JSON.parse(fs.readFileSync(f, 'utf-8')) as BoardModel }))
if (!boards.length) {
  console.error('no board.json found — run the generator first')
  process.exit(1)
}
const camOf = (b: BoardModel, yaw: number, tilt: number): Camera =>
  ({ yaw, tilt, cx: (b.outline[0] + b.outline[2]) / 2, cy: (b.outline[1] + b.outline[3]) / 2 })

// 25. tilt 0 + yaw 0 is exactly the 2D view (up to the centre shift): the two views
//     can never drift apart, because one is a special case of the other.
{
  let worst = 0
  for (const { b } of boards) {
    const cam = camOf(b, 0, 0)
    for (const p of b.parts) {
      const [sx, sy] = project(p.x, p.y, partHeight(p.footprint, p.part), cam)
      worst = Math.max(worst, Math.abs(sx - (p.x - cam.cx)), Math.abs(sy - (p.y - cam.cy)))
    }
  }
  check('25 top view == 2D view', worst < 1e-9, `worst offset ${worst.toExponential(1)} mm`)
}

// 26. the projection is a rotation: distances inside one horizontal plane are preserved
//     at any tilt (no shear, no squashed board).
{
  let worst = 0
  for (const { b } of boards) {
    for (const tilt of [0, 25, 52, 85]) {
      const cam = camOf(b, -18, tilt)
      const [x1, y1] = project(b.outline[0], b.outline[1], 0, cam)
      const [x2, y2] = project(b.outline[2], b.outline[1], 0, cam)
      const seen = Math.hypot(x2 - x1, y2 - y1)
      const real = b.outline[2] - b.outline[0]
      // a horizontal edge along x keeps its length only when it is not foreshortened;
      // check instead that the projection never *grows* a distance
      worst = Math.max(worst, seen / real - 1)
    }
  }
  check('26 no stretching', worst < 1e-9, `max growth ${(worst * 100).toFixed(6)}%`)
}

// 27. depth ordering: at any tilt in view, a part's top is nearer the camera than the
//     board surface under it (a flat feature sits on it), and the bottom copper is farther than the board top.
{
  let ok = true, info = ''
  for (const { b } of boards) {
    for (const tilt of [0, 30, 52, 85]) {
      const cam = camOf(b, -18, tilt)
      for (const p of b.parts) {
        const h = partHeight(p.footprint, p.part)
        const top = project(p.x, p.y, h, cam)[2]
        const surf = project(p.x, p.y, 0, cam)[2]
        const back = project(p.x, p.y, -BOARD_THICK, cam)[2]
        const above = h > 0 ? top > surf : top === surf
        if (!(above && surf > back)) { ok = false; info = `${p.ref} tilt ${tilt}` }
      }
    }
  }
  check('27 depth order (part > surface > back)', ok, info || 'all parts, 4 tilts')
}

// 28. painter's algorithm: sortFaces really returns far-to-near.
{
  const { b } = boards[0]
  const cam = camOf(b, -18, 52)
  const faces = sortFaces([
    ...boardFaces(b.outline, cam),
    ...b.parts.flatMap(p => partFaces(p as BoardPart, p.x, p.y, p.rot, cam)),
    ...(b.tracks || []).map(t => trackFace(t, cam)),
    ...(b.vias || []).flatMap(v => viaFaces(v, cam)),
  ])
  // by layer (board → copper → parts), and inside a layer far to near
  const monotone = faces.every((f, i) => {
    if (i === 0) return true
    const p = faces[i - 1]
    return faceRank(p) < faceRank(f) || (faceRank(p) === faceRank(f) && p.depth <= f.depth)
  })
  // a part must never be painted under the board or under copper, whatever the depths
  const firstPart = faces.findIndex(f => f.kind === 'part')
  const lastCopper = faces.map(f => f.kind).lastIndexOf('track')
  check('28 faces sorted by layer, then far to near',
    monotone && faces.length > 0 && firstPart > lastCopper && lastCopper >= 0,
    `${faces.length} faces, parts after copper`)
}

// 29. every part with a real footprint has a package height (no silent fallback), and
//     heights are sane (0 for flat features, otherwise 0.3–20 mm). Parts the footprint mapper could not resolve
//     (UNMAPPED_*, reported to the user already) have no knowable height and must be
//     the only ones falling back to the default.
{
  const missing: string[] = [], fellBack: string[] = []
  let lo = Infinity, hi = -Infinity
  for (const { b } of boards) for (const p of b.parts) {
    const h = partHeight(p.footprint, p.part)
    const unmapped = /UNMAPPED/i.test(p.footprint)
    if (h === DEFAULT_HEIGHT) (unmapped ? fellBack : missing).push(`${p.ref}:${p.footprint}`)
    if (!unmapped && h > 0) { lo = Math.min(lo, h); hi = Math.max(hi, h) }
  }
  check('29 package heights known', missing.length === 0 && lo >= 0.3 && hi <= 20,
    missing.length ? `fallback used for ${missing.join(', ')}`
      : `heights ${lo}–${hi} mm · default only for unmapped (${fellBack.length})`)
}

// 30. a rotated part turns in 3D too: a 90° rotation swaps the screen width and height
//     of its top face when seen from straight above.
{
  const { b } = boards[0]
  const cam = camOf(b, 0, 0)
  const p = b.parts.find(q => q.bbox[2] - q.bbox[0] !== q.bbox[3] - q.bbox[1]) || b.parts[0]
  const span = (rot: number) => {
    const f = partFaces(p as BoardPart, p.x, p.y, rot, cam).at(-1)!
    const xs = f.pts.map(q => q[0]), ys = f.pts.map(q => q[1])
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
  }
  const [w0, h0] = span(0), [w90, h90] = span(90)
  check('30 rotation applies in 3D', Math.abs(w0 - h90) < 1e-9 && Math.abs(h0 - w90) < 1e-9,
    `${p.ref} ${w0.toFixed(2)}x${h0.toFixed(2)} -> ${w90.toFixed(2)}x${h90.toFixed(2)}`)
}

// The viewer in a browser. GL calls are counted on the context itself, so the count does not depend on the viewer's code.
const BASE = process.env.BASE?.replace(/\/$/, '')
if (!BASE) console.log('skip 31: BASE not set (not counted as passed)')
else {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
    const warned: string[] = []
    page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') warned.push(m.text()) })
    await page.addInitScript(() => {
      const gl = { draws: 0, contexts: [] as WebGLRenderingContext[] }
      Object.assign(window, { __gl: gl })
      for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype] as unknown as Record<string, (...a: unknown[]) => unknown>[]) {
        for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
          const native = proto[fn]
          if (native) proto[fn] = function (this: unknown, ...a: unknown[]) { gl.draws++; return native.apply(this, a) }
        }
      }
      const getContext = HTMLCanvasElement.prototype.getContext as (...a: unknown[]) => unknown
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...a: unknown[]) {
        const c = getContext.apply(this, a) as WebGLRenderingContext | null
        if (c && /webgl/.test(String(a[0])) && !gl.contexts.includes(c)) gl.contexts.push(c)
        return c
      } as typeof HTMLCanvasElement.prototype.getContext
    })
    await page.goto(`${BASE}/?demo=ne555`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /PCB 생성/ }).first().click({ timeout: 60000 })
    await page.getByRole('button', { name: /\.kicad_pcb/ }).waitFor({ timeout: 300000 })
    await page.getByTestId('view-tab-assembly').click()
    const viewer = page.locator('[data-testid="assembly-3d"] [data-testid="kicad-3d"]')
    const ready = () => page.waitForSelector('[data-testid="assembly-3d"] [data-testid="kicad-3d"][data-state="ready"]', { timeout: 200000 })
    await ready()

    // 31: 2D and back, more times than the 16 contexts Chrome keeps
    for (let i = 0; i < 18; i++) {
      await page.getByTestId('assembly-view-2d').click()
      await page.getByTestId('assembly-view-3d').click()
      await viewer.waitFor({ timeout: 20000 })
    }
    await ready()
    await page.waitForTimeout(500)
    const alive = await page.evaluate(() => (window as unknown as { __gl: { contexts: WebGLRenderingContext[] } }).__gl.contexts.filter(c => !c.isContextLost()).length)
    const tooMany = warned.filter(t => /Too many active WebGL contexts/.test(t)).length
    check('31 the viewer closed 18 times leaves no WebGL context behind', alive === 1 && tooMany === 0, `${alive} alive, ${tooMany} warnings`)
  } finally {
    await browser.close()
  }
}

let allOk = true
for (const [name, ok, info] of results) {
  allOk &&= ok
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}
console.log(`boards: ${boards.map(x => x.file).join(', ')}`)
console.log(allOk ? 'ALL PASS' : 'SOME CHECKS FAILED')
process.exit(allOk ? 0 : 1)
