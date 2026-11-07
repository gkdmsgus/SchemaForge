// Browser checks that the checks list on the board view covers neither the board nor its 3D view, on the 555 demo
// (frame review of 2026-10-30: in 나란히 the open list covered most of the 3D half, so only the board's edge showed,
// and in 2D it covered the right third of a zoomed board): B1 in 나란히 the open list shares no area with the 2D or
// the 3D view, B2 in 2D, zoomed in, it shares none with the board drawing, B3 with the 3D pane narrowed by the list
// no view button or the 3D view's 도형 보기 toggle is under something else, B4 folded, it is one short line in the corner,
// B5 with the AI edit panel open too, the AI rounds box (folded or open) covers no view button, B6 with the Code drawer
// open (a low board pane) in 나란히 the folded header shares no area with the 2D or the 3D view, B8 on that low 3D pane
// the hint is an ⓘ chip, not the line, and with the BOM drawer or none the line is back, B7 in 2D, zoomed in, the
// folded header shares none with the board drawing, B9 the gerber step warns on a board with a net left unrouted, a part
// with no footprint or a break KiCad found, in its colour, title and lines, and still downloads (it was green with
// "그대로 올리면 됩니다" on such a board: review of 2026-11-06), and a clean board stays green, B10 a 3D viewer file that
// cannot be fetched (a tab open across a deploy, answered with the app's page) leaves the result screen up, says so in
// the PCB tab and goes to the 2D drawing in 배치하기 (the error boundary took the whole screen: review of 2026-11-06),
// B10b there 배치하기 and its 3D button ask for a reload (they said the button tries again, which asks for nothing: the
// lazy import keeps its failure, review of 2026-11-07), B10c a 3D model that did not load keeps the retry, which asks again.
// B11 a board stopped because the same board was started in another window says why over the board, with what to do (it
// showed only "오류" and 재시도: review of 2026-11-07). B12 a tab open across a restart, its board's files gone from the
// server: 거버 says why in Korean and builds the board again, and the gerbers follow (its title said "PCB file not found."
// and offered 거버 다시, refused the same way: review of 2026-11-07). B12 removes those files from this checkout's
// server/outputs, as a restart does, so the API must run from this checkout.
// Needs the vite dev server (npm run dev) and its API with KiCad (the board is built, a minute or two).
// Usage: node scripts/check_board_panel.mjs [BASE]   (default http://localhost:3000; SHOTS=dir saves each view)
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
const OUTPUTS = path.resolve(import.meta.dirname, '..', 'server', 'outputs')
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
  let builtBoard = ''   // the real stream, for B9
  await page.route(/\/generate_pcb_stream$/, async route => {
    const res = await route.fetch({ timeout: 300000 })
    const body = (await res.text()).replace(/^event: done$/m, rounds.map(r => `event: ai\ndata: ${JSON.stringify(r)}\n\n`).join('') + 'event: done')
    builtBoard = body
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

  // B8: on that low 3D pane the hint is an ⓘ chip with the words in its title (frame review of 2026-11-03, S19: the
  // one-line hint covered a third of the 3D board); the BOM drawer (80 px shorter than Code's at 720 px) and none keep the line
  const hint3d = () => page.evaluate(() => {
    const model = document.querySelector('[data-testid="kicad-3d"], [data-testid="board-3d"]'), pane = model?.parentElement
    const chip = pane?.querySelector(':scope > [data-testid="hint-3d-chip"]')
    const line = pane ? [...pane.children].some(e => e !== model && e !== chip && /드래그 회전|배치 애니메이션/.test(e.textContent || '')) : false
    return { h: pane?.clientHeight ?? 0, chip: chip?.getAttribute('title') ?? null, line }
  })
  const c8 = await hint3d()
  await page.locator('button.sf-drawer-tab', { hasText: 'BOM' }).first().click()
  await page.waitForTimeout(800)
  const m8 = await hint3d()
  await page.locator('button.sf-drawer-tab', { hasText: 'BOM' }).first().click()
  await page.waitForTimeout(800)
  const o8 = await hint3d()
  check('B8 a low 3D pane (Code drawer) has the hint as an ⓘ chip; with the BOM drawer or none, the line',
    c8.h > 0 && /드래그 회전|배치 애니메이션/.test(c8.chip ?? '') && !c8.line && m8.line && !m8.chip && o8.line && !o8.chip,
    `3D pane ${c8.h} px with Code (${c8.chip ? 'chip' : 'no chip'}${c8.line ? ', line' : ''}), ${m8.h} px with BOM (${m8.line ? 'line' : 'no line'}${m8.chip ? ', chip' : ''}), ${o8.h} px with none (${o8.line ? 'line' : 'no line'}${o8.chip ? ', chip' : ''})`)

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

  // B9: that board's stream with one thing wrong in it each time; the gerber answer faked, so only the screen is tested
  const edited = (event, change) => builtBoard.replace(new RegExp(`^event: ${event}\\ndata: (.*)$`, 'm'), (_, raw) => {
    const data = JSON.parse(raw)
    change(data)
    return `event: ${event}\ndata: ${JSON.stringify(data)}`
  })
  const gerberStep = async stream => {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
    await p.route(/\/generate_pcb_stream$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: stream }))
    await p.route(/\/generate_gerber$/, r => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ gerberDir: 'check', files: ['check-F_Cu.gtl', 'check-PTH.drl'], zip: 'check.zip' }) }))
    await p.goto(`${BASE}/?demo=ne555`, { waitUntil: 'networkidle' })
    await p.getByRole('button', { name: /PCB 생성/ }).first().click({ timeout: 60000 })
    await p.getByRole('button', { name: /^거버$/ }).click({ timeout: 30000 })
    const zip = p.getByTestId('gerber-zip')
    await zip.waitFor({ timeout: 10000 })
    await p.locator('button.sf-drawer-tab', { hasText: 'Netlist' }).first().click()
    await p.getByTestId('gerber-zip-panel').waitFor({ timeout: 5000 })
    const seen = { title: await zip.getAttribute('title'), color: await zip.evaluate(e => getComputedStyle(e).color), href: await zip.getAttribute('href'),
      panel: await p.getByTestId('gerber-zip-panel').locator('xpath=ancestor::div[2]').innerText(), panelHref: await p.getByTestId('gerber-zip-panel').getAttribute('href') }
    await p.context().close()
    return seen
  }
  const clean = await gerberStep(builtBoard)
  const green = /그대로 올립니다/.test(clean.title ?? '') && /제조사 업로드 가능/.test(clean.panel) && /그대로 올리면 됩니다/.test(clean.panel)
  check('B9 a clean board: the gerber step stays green with its upload lines', green && !/확인 필요/.test(clean.panel), `title "${clean.title}"`)
  for (const [what, stream, word] of [
    ['a net left unrouted', edited('done', d => { d.board.unrouted = [{ net: 'OUT', from: 'R1.1', to: 'C1.2' }] }), /이어지지 않은 연결 1개/],
    ['a part with no footprint', edited('done', d => { d.summary.unmapped = [{ ref: 'U1', part: 'LM358', reason: 'check' }] }), /풋프린트 없는 부품 1개/],
    ['a break KiCad found', edited('drc', d => { d.unconnected = 2 }), /KiCad 점검에서 끊긴 곳 2개/],
  ]) {
    const s = await gerberStep(stream)
    const said = [s.title ?? '', s.panel].every(t => word.test(t) && !/그대로 올/.test(t)) && !/제조사 업로드 가능/.test(s.panel) && /제조 전 확인 필요/.test(s.panel)
    check(`B9 ${what}: the gerber step warns, and still downloads`, said && s.color !== clean.color && !!s.href && !!s.panelHref,
      `colour ${clean.color} -> ${s.color}; title "${s.title}"`)
  }

  // B10
  const stale = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  let gone = 0
  // the built file's name, or the module the vite dev server sends for it (it has no assets/ name, so on npm run dev this
  // check asked for nothing and failed, review of 2026-11-07)
  await stale.route(/\/assets\/KiCad3DViewer-[^/]*\.js$|\/src\/components\/KiCad3DViewer\.tsx(\?.*)?$/, r => {
    gone++
    return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title>' })
  })
  await stale.route(/\/generate_pcb_stream$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: builtBoard }))
  await stale.goto(`${BASE}/?demo=ne555`, { waitUntil: 'networkidle' })
  await stale.getByRole('button', { name: /PCB 생성/ }).first().click({ timeout: 60000 })
  const said3d = await stale.locator('[data-testid="kicad-3d"][data-state="error"]').waitFor({ timeout: 30000 }).then(() => true, () => false)
  await stale.getByTestId('view-tab-assembly').click()
  const flat = await stale.getByText('평면 그림으로 보여 줍니다').waitFor({ timeout: 10000 }).then(() => true, () => false)
  const screenError = await stale.getByTestId('screen-error').count(), stillResult = await stale.getByTestId('view-tab-schematic').isVisible()
  check('B10 a 3D viewer file that cannot be fetched leaves the result screen up, says so, and 배치하기 goes to 2D',
    gone > 0 && said3d && flat && screenError === 0 && stillResult, `chunk asked ${gone}x, says so ${said3d}, 2D note ${flat}, error screens ${screenError}`)
  // B10b. 배치하기 asks for a reload there too: it said the 3D button tries again, but the lazy import keeps its failure, so
  // the button asked for nothing and went straight back to 2D (review of 2026-11-07). A model that did not load keeps that
  const panel10 = await stale.getByTestId('assembly-hint').locator('..').innerText().catch(() => '')
  const title10 = await stale.getByTestId('assembly-view-3d').getAttribute('title').catch(() => '')
  check('B10b with the 3D viewer file gone, 배치하기 and its 3D button ask for a reload and promise no retry',
    /새로고침/.test(panel10) && /새로고침/.test(title10 ?? '') && !/다시 시도/.test(panel10 + (title10 ?? '')),
    `panel "${panel10.split('\n').filter(l => /3D/.test(l)).join(' / ').slice(0, 120)}", button "${title10}"`)
  // B10c. a 3D model that did not load (the viewer's file did) still offers the 3D button's retry, and that retry asks again
  const glb = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  let models = 0
  await glb.route(/\/board_model\?/, r => { models++; return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"check"}' }) })
  await glb.route(/\/generate_pcb_stream$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: builtBoard }))
  await glb.goto(`${BASE}/?demo=ne555`, { waitUntil: 'networkidle' })
  await glb.getByRole('button', { name: /PCB 생성/ }).first().click({ timeout: 60000 })
  await glb.getByTestId('view-tab-assembly').click({ timeout: 30000 })
  const flatGlb = await glb.getByText('평면 그림으로 보여 줍니다').waitFor({ timeout: 30000 }).then(() => true, () => false)
  const panelGlb = await glb.getByTestId('assembly-hint').locator('..').innerText().catch(() => '')
  const titleGlb = await glb.getByTestId('assembly-view-3d').getAttribute('title').catch(() => '')
  const before10 = models
  await glb.getByTestId('assembly-view-3d').click().catch(() => {})
  for (let i = 0; i < 50 && models === before10; i++) await glb.waitForTimeout(100)
  check('B10c a 3D model that did not load keeps the retry, and the 3D button asks for it again',
    flatGlb && /다시 시도/.test(panelGlb) && /다시 시도/.test(titleGlb ?? '') && !/새로고침/.test(panelGlb) && models > before10,
    `2D note ${flatGlb}, button "${titleGlb}", model asked ${before10} then ${models}`)

  // B11: the other window is this script, asking for the same netlist once the page's run has started (its answer's
  // headers are out: the server holds the run by then), so the page's run is the one the server stops ('replaced')
  const twice = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  let other = null
  twice.on('response', r => {
    if (other || !/\/generate_pcb_stream$/.test(r.url())) return
    other = fetch(`${BASE}/generate_pcb_stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: r.request().postData() })
      .then(res => res.text(), e => `failed: ${e.message}`)
  })
  await twice.goto(`${BASE}/?demo=led`, { waitUntil: 'networkidle' })
  await twice.getByRole('button', { name: /PCB 생성/ }).first().click({ timeout: 60000 })
  const banner11 = twice.getByTestId('pcb-error')
  const said11 = await banner11.waitFor({ timeout: 60000 }).then(() => banner11.innerText(), () => '')
  const title11 = await twice.getByTestId('pcb-retry').getAttribute('title', { timeout: 5000 }).catch(() => null)
  const otherBoard = other ? await other : '(never asked)'
  if (SHOTS) await twice.screenshot({ path: `${SHOTS}/board_replaced.png` })
  check('B11 a board stopped by the same board in another window says why over the board, with what to do',
    /다른 창/.test(said11) && /재시도/.test(said11) && /다른 창/.test(title11 ?? '') && /event: done/.test(otherBoard),
    `banner "${said11.replace(/\s+/g, ' ')}", 재시도 title ${title11 ? 'says why' : 'none'}, the other window ${/event: done/.test(otherBoard) ? 'got its board' : otherBoard.slice(-120)}`)
  await twice.context().close()

  // B12: the board is built, then its files (netlist, board, the rest of its name) go as a restart takes them
  const old = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  let net12 = ''
  old.on('request', r => { if (/\/generate_pcb_stream$/.test(r.url()) && !net12) net12 = r.postDataJSON()?.filename ?? '' })
  await old.goto(`${BASE}/?demo=led`, { waitUntil: 'networkidle' })
  await old.getByRole('button', { name: /PCB 생성/ }).first().click({ timeout: 60000 })
  const gerber12 = old.getByRole('button', { name: /^거버$/ })
  await gerber12.waitFor({ timeout: 300000 })
  const stem12 = net12.replace(/\.net$/, '')
  const removed12 = stem12 ? fs.readdirSync(OUTPUTS).filter(f => f.startsWith(stem12)) : []
  for (const f of removed12) fs.rmSync(path.join(OUTPUTS, f), { recursive: true, force: true })
  await gerber12.click()
  const gone12 = old.getByTestId('gerber-retry')
  await gone12.waitFor({ timeout: 30000 })
  const button12 = await gone12.innerText(), title12 = await gone12.getAttribute('title') ?? ''
  if (SHOTS) await old.screenshot({ path: `${SHOTS}/board_gone.png` })
  await gone12.click()
  const rebuilt12 = await gerber12.waitFor({ timeout: 300000 }).then(() => true, () => false)
  const zip12 = rebuilt12 && await gerber12.click().then(() => old.getByTestId('gerber-zip').waitFor({ timeout: 200000 })).then(() => true, () => false)
  check('B12 a board file gone from the server: 거버 says why in Korean, builds the board again, then the gerbers',
    removed12.length >= 2 && /PCB 다시 생성/.test(button12) && /남아 있지 않습니다/.test(title12) && !/not found/i.test(title12) && rebuilt12 && zip12,
    `removed ${removed12.length} file(s); button "${button12}", title "${title12.replace(/\n/g, ' / ')}"; board again ${rebuilt12}, gerber zip ${zip12}`)
  await old.context().close()
} catch (e) {
  failed++
  console.log('FAIL stopped: ' + String(e?.message || e).split('\n')[0])
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} FAIL` : '\nall ok')
process.exitCode = failed ? 1 : 0
