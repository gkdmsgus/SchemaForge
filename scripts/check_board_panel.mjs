// Browser checks that the checks list on the board view covers neither the board nor its 3D view, on the 555 demo
// (frame review of 2026-10-30: in 나란히 the open list covered most of the 3D half, so only the board's edge showed,
// and in 2D it covered the right third of a zoomed board): B1 in 나란히 the open list shares no area with the 2D or
// the 3D view, B2 in 2D, zoomed in, it shares none with the board drawing, B3 with the 3D pane narrowed by the list
// no view button or the 3D view's 도형 보기 toggle is under something else, B4 folded, it is one short line in the corner,
// B5 with the AI edit panel open too, the AI rounds box (folded or open) covers no view button, B6 with the Code drawer
// open (a low board pane) in 나란히 the folded header shares no area with the 2D or the 3D view, B7 in 2D, zoomed in,
// the folded header shares none with the board drawing.
// Needs the vite dev server (npm run dev) and its API with KiCad (the board is built, a minute or two).
// Usage: node scripts/check_board_panel.mjs [BASE]   (default http://localhost:3000; SHOTS=dir saves each view)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
const SHOTS = process.env.SHOTS
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }
const area = (a, b) => !a || !b ? 0 : Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
const pct = (s, of) => `${Math.round(s)} px² (${of ? Math.round(100 * s / (of.width * of.height)) : 0}% of it)`

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  // the demo board has no AI rounds (they need a model and a login): three are added to its stream, as the server sends them
  const m = { drcErrors: 0, unrouted: 0, hpwl: 120, vias: 4, trackLength: 140, overlaps: 0, outside: 0, decap: 6, powerWidth: 0 }
  const rounds = [
    { round: 1, part: 'width', reason: 'GND 선을 넓힙니다', actions: { net_widths: [{ net: 'GND', mm: 0.8 }] }, before: m, after: { ...m, hpwl: 118 }, kept: true },
    { round: 1, part: 'place', reason: 'C3을 U1 가까이 옮깁니다', actions: { moves: [{ ref: 'C3', dx: 2, dy: 0 }] }, before: m, kept: false, note: '배치 사전 검사 불합격: C3 자리가 R2 자리와 겹침' },
    { round: 2, part: 'place', reason: 'R1을 옮깁니다', actions: { moves: [{ ref: 'R1', dx: 1, dy: 0 }] }, before: m, after: { ...m, hpwl: 125 }, kept: false, note: '개선 없음' },
  ]
  await page.route(/\/generate_pcb_stream$/, async route => {
    const res = await route.fetch({ timeout: 300000 })
    const body = (await res.text()).replace(/^event: done$/m, rounds.map(r => `event: ai\ndata: ${JSON.stringify(r)}\n\n`).join('') + 'event: done')
    await route.fulfill({ response: res, body })
  })
  await page.goto(`${BASE}/?demo=ne555`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /PCB 생성/ }).first().click({ timeout: 60000 })
  await page.getByRole('button', { name: /\.kicad_pcb/ }).waitFor({ timeout: 300000 })
  await page.waitForSelector('[data-testid="kicad-3d"]:is([data-state="ready"],[data-state="error"])', { timeout: 200000 })
  await page.waitForTimeout(800)

  const list = page.getByTestId('board-checks')
  const head = list.locator(':scope > button').first()
  const setOpen = async open => {
    if ((await head.getAttribute('aria-expanded')) !== String(open)) { await head.click(); await page.waitForTimeout(600) }
  }
  const box = sel => page.locator(sel).first().boundingBox().catch(() => null)
  const view3d = () => box('[data-testid="kicad-3d"], [data-testid="board-3d"]')
  const view2d = () => box('[data-testid="board-view"]')
  const shot = async name => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/board_${name}.png` }) }

  // B1
  await page.getByTestId('view-both').click()
  await setOpen(true)
  await shot('both_open')
  const l1 = await list.boundingBox(), d3 = await view3d(), d2 = await view2d()
  const rows = await list.locator('[data-check]').count()
  check('B1 나란히: the open list covers neither the 2D nor the 3D view', rows > 0 && !!d3 && area(l1, d3) === 0 && area(l1, d2) === 0,
    `${rows} rows; over 3D ${pct(area(l1, d3), d3)}, over 2D ${pct(area(l1, d2), d2)}`)

  // B2: 2D only, zoomed in on the middle of the board
  await page.getByTestId('view-2d').click()
  await page.waitForTimeout(400)
  const v = await view2d()
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2)
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(100) }
  await page.waitForTimeout(400)
  await shot('2d_open_zoomed')
  const l2 = await list.boundingBox(), v2 = await view2d()
  check('B2 2D, zoomed in: the open list covers none of the board drawing', area(l2, v2) === 0, `over the drawing ${pct(area(l2, v2), v2)}`)

  // B3: in 나란히 with the list open (the narrowest 3D pane), each view button is the thing under its own middle
  await page.getByTestId('view-both').click()
  await page.waitForTimeout(400)
  const covered = await page.evaluate(() => [...document.querySelectorAll('[data-testid="view-2d"]')].flatMap(b => [...b.parentElement.querySelectorAll('button')])
    .concat([...document.querySelectorAll('[data-testid="board-real3d-toggle"]')])
    .filter(b => { const r = b.getBoundingClientRect(); return !b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) })
    .map(b => b.textContent.trim()))
  const toggle = await page.getByTestId('board-real3d-toggle').isVisible().catch(() => false)
  check('B3 the view buttons and the 3D toggle are not under anything', toggle && !covered.length, `covered: [${covered}]`)

  // B4
  await page.getByTestId('view-both').click()
  await setOpen(false)
  await shot('both_folded')
  const l4 = await list.boundingBox(), f3 = await view3d()
  check('B4 folded: one short line in the corner', l4.height <= 40 && l4.width <= 240,
    `${Math.round(l4.width)} × ${Math.round(l4.height)} px, over 3D ${pct(area(l4, f3), f3)}`)

  // B5: the AI edit panel open beside the board and the list open (the narrowest board): the AI rounds box in the
  // top-left corner, folded or open, covers no view button (frame review of 2026-11-01: 'AI 다듬기 · 채택 1/3' sat on
  // 도형 보기 at 1280×720)
  const panel = page.getByTestId('toggle-left-panel')
  if ((await panel.getAttribute('aria-pressed')) !== 'true') { await panel.click(); await page.waitForTimeout(400) }
  await page.getByTestId('view-both').click()
  const aiToggle = page.getByTestId('board-ai-toggle')
  const under = []
  for (const list of [true, false]) {
    await setOpen(list)
    for (const open of [false, true]) {
      if ((await aiToggle.getAttribute('aria-expanded')) !== String(open)) { await aiToggle.click(); await page.waitForTimeout(300) }
      await shot(`ai_${open ? 'open' : 'folded'}_list_${list ? 'open' : 'folded'}`)
      under.push(await page.evaluate(([list, open]) => {
        const ai = document.querySelector('[data-testid="board-ai"]')?.getBoundingClientRect()
        const buttons = [...document.querySelectorAll('[data-testid="view-2d"]')].flatMap(b => [...b.parentElement.querySelectorAll('button')])
        const hit = buttons.filter(b => {
          const r = b.getBoundingClientRect()
          const over = ai && Math.min(r.right, ai.right) > Math.max(r.left, ai.left) && Math.min(r.bottom, ai.bottom) > Math.max(r.top, ai.top)
          return over || !b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
        }).map(b => b.textContent.trim())
        return { state: `list ${list ? 'open' : 'folded'}, box ${open ? 'open' : 'folded'}`, ai: ai ? Math.round(ai.width) : 0, hit }
      }, [list, open]))
    }
  }
  check('B5 narrow board: the AI rounds box, folded or open, covers no view button (list open or folded)',
    under.length === 4 && under.every(u => u.ai > 0 && !u.hit.length), under.map(u => `${u.state}: ${u.ai} px, over [${u.hit}]`).join('; '))

  // B6, B7: the folded list's header shares no area with the drawing (frame review of 2026-11-02: floating in the
  // corner it covered about 40% of the 3D board once the Code drawer made the board pane low, 257-265 s, and the
  // board's top-right mounting hole in 2D zoomed in, 120-126 s). The AI edit panel is closed again first.
  if ((await panel.getAttribute('aria-pressed')) === 'true') { await panel.click(); await page.waitForTimeout(400) }
  await page.locator('button.sf-drawer-tab', { hasText: 'Code' }).first().click()
  await page.waitForTimeout(800)
  await page.getByTestId('view-both').click()
  await setOpen(false)
  await page.waitForTimeout(400)
  await shot('both_folded_drawer')
  const h6 = await list.boundingBox(), b6 = await view3d(), a6 = await view2d()
  check('B6 Code drawer open, 나란히, folded: the header covers neither the 2D nor the 3D view',
    !!b6 && !!a6 && b6.height > 0 && area(h6, b6) === 0 && area(h6, a6) === 0,
    `board pane ${Math.round(b6?.height ?? 0)} px high; over 3D ${pct(area(h6, b6), b6)}, over 2D ${pct(area(h6, a6), a6)}`)
  await page.locator('button.sf-drawer-tab', { hasText: 'Code' }).first().click()
  await page.waitForTimeout(800)

  await page.getByTestId('view-2d').click()
  await page.waitForTimeout(400)
  const v7 = await view2d()
  await page.mouse.move(v7.x + v7.width / 2, v7.y + v7.height / 2)
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(100) }
  await page.waitForTimeout(400)
  await shot('2d_folded_zoomed')
  const h7 = await list.boundingBox(), d7 = await view2d()
  check('B7 2D zoomed in, folded: the header covers none of the board drawing', !!h7 && area(h7, d7) === 0,
    `over the drawing ${pct(area(h7, d7), d7)}`)
} catch (e) {
  failed++
  console.log('FAIL stopped: ' + String(e?.message || e).split('\n')[0])
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} FAIL` : '\nall ok')
process.exitCode = failed ? 1 : 0
