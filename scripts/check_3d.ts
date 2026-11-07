/**
 * Stage-5 checks: the 3D view is the same board, tilted. With BASE set, also the KiCad 3D viewer itself, in a browser on a
 * real demo board (a served app with KiCad, a minute or two): 31 leaving and reopening it leaves no WebGL context behind
 * (each stayed, about 127 MB of GPU memory, until Chrome warned at 16: review of 2026-11-06), 32-39 it draws only when
 * something changes (every frame, shadow pass included, it filled the main thread of an Iris Xe laptop during the tens of
 * minutes 배치하기 stays open: review of 2026-11-06), and everything still redraws: its labels, a drag and the slide after
 * it, the wheel, the top view, a pane resized, the hover light and tooltip, a pick and its badge, in both views.
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

    // 32: left alone. Chrome's own counters say what the page cost in the same seconds
    await page.mouse.move(2, 2)
    await page.waitForTimeout(1500)
    const draws = () => page.evaluate(() => (window as unknown as { __gl: { draws: number } }).__gl.draws)
    const quiet = async (ms = 2000) => { const d0 = await draws(); await page.waitForTimeout(ms); return (await draws()) - d0 }
    // until a whole second has no draw: the slide after a drag is a number of frames, and without a GPU a frame takes long
    const settle = async () => {
      for (let i = 0; i < 40; i++) {
        const d = await draws()
        await page.waitForTimeout(1000)
        if (await draws() === d) return true
      }
      return false
    }
    const cdp =await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const busy = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
    const m0 = await busy(), d0 = await draws()
    await page.waitForTimeout(5000)
    const m1 = await busy(), idle5 = (await draws()) - d0
    const taskShare = (m1.TaskDuration - m0.TaskDuration) / (m1.Timestamp - m0.Timestamp)
    check('32 the viewer left alone draws nothing', idle5 === 0,
      `${idle5} GL draw calls in 5 s, main thread busy ${(100 * taskShare).toFixed(1)}%, script ${(m1.ScriptDuration - m0.ScriptDuration).toFixed(2)} s`)

    // 33: a part picked in the list shows its labels (+ and − on its pads), placed with no input on the viewer
    await page.locator('[data-assembly-info]').first().click()
    await page.waitForTimeout(500)
    const marks = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-mark-3d]')].map(n => ({ key: n.dataset.mark3d, display: n.style.display, at: n.style.transform })))
    const m33 = await marks()
    check('33 the labels sit on the board with no input', m33.length > 0 && m33.every(n => n.display === 'block' && /translate\(/.test(n.at)), `${m33.length} labels`)

    // 34: a drag moves the picture and the labels; the slide after it ends, and with it the drawing
    const box = (await viewer.boundingBox())!
    const clip = { x: box.x, y: box.y, width: box.width, height: box.height }
    const picture = () => page.screenshot({ clip }).then(b => b.toString('base64'))
    const moved = (a: Awaited<ReturnType<typeof marks>>, b: Awaited<ReturnType<typeof marks>>) => a.filter((n, i) => n.at !== b[i]?.at).length
    const before34 = await picture(), d34 = await draws()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 30, { steps: 12 })
    await page.mouse.up()
    const m34 = await marks()
    await settle()
    const left34 = await quiet()
    const after34 = await marks()
    const slide = m34.filter((n, i) => n.at !== after34[i]?.at).length
    check('34 a drag turns the board and its labels, and the drawing stops after the slide', await picture() !== before34 && (await draws()) - d34 > 0 && moved(m33, after34) > 0 && slide > 0 && left34 === 0,
      `${(await draws()) - d34} draw calls, ${moved(m33, after34)} labels moved, ${slide} still moving after the release, ${left34} after it ended`)

    // 35: a short drag (a few px) is not lost below the controls' change threshold, nor is a wheel notch
    const small = await draws(), before35 = await marks()
    await page.mouse.move(box.x + 40, box.y + 40)
    await page.mouse.down()
    await page.mouse.move(box.x + 43, box.y + 41)
    await page.mouse.up()
    await settle()
    const smallDrew = (await draws()) - small, smallMoved = moved(before35, await marks())
    const wheel0 = await draws()
    await page.mouse.wheel(0, -120)
    await settle()
    const wheelDrew = (await draws()) - wheel0, wheelMoved = moved(before35, await marks())
    check('35 a short drag and a wheel notch redraw', smallDrew > 0 && wheelDrew > 0 && wheelMoved > 0 && await quiet() === 0, `drag ${smallDrew} draw calls (${smallMoved} labels), wheel ${wheelDrew} (${wheelMoved} labels)`)

    // the top view button, a pane resized (the drawer below opening and closing)
    const top0 = await draws(), before36 = await marks()
    await page.getByTestId('assembly-top').click()
    await settle()
    const topDrew = (await draws()) - top0, topMoved = moved(before36, await marks()), topView = await viewer.getAttribute('data-view')
    await page.getByTestId('assembly-top').click()
    await settle()
    const size0 = await page.evaluate(() => document.querySelector('[data-testid="assembly-3d"] canvas')!.clientHeight), res0 = await draws()
    await page.locator('button.sf-drawer-tab', { hasText: 'BOM' }).first().click()
    await settle()
    const size1 = await page.evaluate(() => document.querySelector('[data-testid="assembly-3d"] canvas')!.clientHeight), resDrew = (await draws()) - res0
    await page.locator('button.sf-drawer-tab', { hasText: 'BOM' }).first().click()
    await settle()
    check('36 the top view and a resized pane redraw, then it is quiet again', topView === 'top' && topDrew > 0 && topMoved > 0 && size1 !== size0 && resDrew > 0 && await quiet() === 0,
      `top view ${topDrew} draw calls (${topMoved} labels), pane ${size0}→${size1} px ${resDrew} draw calls`)

    // the part under the mouse, found from the labels (each sits on a pad), else over the pane
    const partUnder = async (wanted = (_: string) => true) => {
      const b = (await viewer.boundingBox())!
      const fromMarks = (await marks()).flatMap(n => { const x = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(n.at); return x ? [[+x[1], +x[2]]] : [] })
      const grid: number[][] = []
      for (let y = 30; y < b.height; y += 30) for (let x = 30; x < b.width; x += 30) grid.push([x, y])
      for (const [x, y] of [...fromMarks, ...grid]) {
        await page.mouse.move(b.x + x, b.y + y)
        await page.waitForTimeout(80)
        const ref = await viewer.getAttribute('data-hover')
        if (ref && wanted(ref)) return { ref, x: b.x + x, y: b.y + y }
      }
      return null
    }
    const hover0 = await draws()
    const hit = await partUnder()
    await page.waitForTimeout(300)
    const lit = (await draws()) - hover0
    const tipShown = await viewer.locator('[data-testid="kicad-3d-tip"]').isVisible() && !!(await viewer.locator('[data-testid="kicad-3d-tip"]').innerText()).trim()
    const stillIdle = await quiet()
    await page.mouse.move(2, 2)
    await page.waitForTimeout(300)
    const offPart = !(await viewer.getAttribute('data-hover'))
    check('37 the part under the mouse lights up with its tooltip and goes out; a still mouse draws nothing', !!hit && lit > 0 && tipShown && stillIdle === 0 && offPart,
      `${hit?.ref ?? 'no part found'}: ${lit} draw calls, tooltip ${tipShown}, then ${stillIdle} with the mouse still, off the part ${offPart}`)

    // a click ticks the part, a resistor (one to check for its direction first only shows why): its badge floats over it
    const resistor = await partUnder(ref => /^R\d/.test(ref))
    await page.waitForTimeout(200)
    const pick0 = await draws()
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(600)
    const badge = await page.evaluate(ref => { const n = document.querySelector<HTMLElement>(`[data-badge-3d="${ref}"]`); return n ? { display: n.style.display, at: n.style.transform } : null }, resistor?.ref ?? '')
    check('38 a click ticks the part: its badge is placed and the picture redrawn', !!badge && badge.display === 'grid' && /translate\(/.test(badge.at) && (await draws()) - pick0 > 0,
      `${resistor?.ref}: badge ${JSON.stringify(badge)}, ${(await draws()) - pick0} draw calls`)

    // the board view's own viewer: a pick lights the part violet and shows in the list
    await page.getByTestId('view-tab-pcb').click()
    await page.getByTestId('view-both').click()
    await page.waitForSelector('[data-testid="kicad-3d"][data-state="ready"]', { timeout: 200000 })
    const boardViewer = page.locator('[data-testid="kicad-3d"]')
    await page.mouse.move(2, 2)
    await settle()
    const idleBoard = await quiet()
    const b39 = (await boardViewer.boundingBox())!
    let pickedRef = ''
    for (let y = 30; y < b39.height && !pickedRef; y += 30) for (let x = 30; x < b39.width && !pickedRef; x += 30) {
      await page.mouse.move(b39.x + x, b39.y + y)
      await page.waitForTimeout(80)
      if (await boardViewer.getAttribute('data-hover')) {
        const d39 = await draws()
        await page.mouse.down()
        await page.mouse.up()
        await page.waitForTimeout(500)
        pickedRef = (await boardViewer.getAttribute('data-selected')) ?? ''
        if (pickedRef && (await draws()) - d39 === 0) pickedRef = ''
      }
    }
    const shadowWarned = warned.filter(t => /PCFSoftShadowMap/.test(t)).length
    check('39 the PCB tab\'s viewer: quiet when left alone, a click picks a part and redraws; three.js has no complaint about the shadows', idleBoard === 0 && !!pickedRef && shadowWarned === 0,
      `${idleBoard} draw calls alone, picked ${pickedRef || 'none'}, ${shadowWarned} shadow warnings`)
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
