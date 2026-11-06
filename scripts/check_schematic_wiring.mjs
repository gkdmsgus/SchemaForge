// Browser checks for drawing wires on the schematic, on the motor demo (no login):
// S1 a click on a pin starts a wire and the schematic stays where it was (the toolbar wrapped to two lines when
// the wire hint appeared, the schematic moved down, the release landed beside the pin and the wire was dropped at
// once: tour take of 2026-10-29), S2 a click on a pin of another net joins the two nets, S3 a click on empty space
// drops a started wire, S4 joining two pins that are already on one net adds no pin twice, S5 with a net picked
// the toolbar keeps its height and its zoom buttons, S6 dragging a picked net's end handle onto another pin moves
// that end (the parts were drawn over the handles, so the press started a new wire instead: tour take of
// 2026-10-29), S7 every part is in view when the circuit opens and after ⌂ (zoom 1 at the origin left parts below),
// S8 a click on a part shows its properties and a double-click opens its value field (the pointer was captured on
// the press, so neither reached the part: frame review of 2026-10-30), S9 the view fits again when the drawer
// below opens and closes (a circuit fitted with the Code drawer open stayed a tiny cluster after it closed), S10 the
// circuit opens fitted when the schematic changes size before its parts are placed (it opened at zoom 1 from the
// origin, parts below the visible part, in 3 of 30 openings of the tour's 555: 2026-10-31), S13 the check above the
// schematic follows the SMD/THT choice: it runs again with that style on THT and after an AI edit, so its pad numbers
// are the board's (the check always used the SMD table: a floating Q_NPN base read pad 1 on a THT board, where it is
// pad 2: review of 2026-11-06). /erc_graph is faked, by the style it is sent, S14 hand edits are the circuit's, not just
// the drawing's: a joined wire and a value reach the checks, the saved session, undo and the next PCB, and outlive a tab
// switch (they stayed in the schematic, under a "● 수정됨": review of 2026-11-06), and are not called AI edits.
// Needs the vite dev server (npm run dev) and the demo route of its API.
// Usage: node scripts/check_schematic_wiring.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  // an edit brings the check's notice above the schematic, which moves it: answered at once, the wait below outlasts both
  await page.route(/\/erc_graph$/, r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"erc":[]}' }))
  await page.goto(`${BASE}/?demo=motor`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 60000 })

  const hint = page.getByText('연결할 핀을 클릭하세요')
  const svg = page.locator('svg:has(g[data-comp])').first()
  // parts whose box is not wholly inside the schematic's visible part
  const outside = (p = page) => p.evaluate(() => {
    const v = document.querySelector('svg:has(g[data-comp])').getBoundingClientRect()
    return [...document.querySelectorAll('g[data-comp]')].filter(g => {
      const b = g.getBoundingClientRect()
      return b.left < v.left || b.right > v.right || b.top < v.top || b.bottom > v.bottom
    }).map(g => g.getAttribute('data-comp'))
  })
  const outAtOpen = await outside()
  const toolbar = page.locator('div', { has: page.getByText(/COMPS · \d+ NETS/) }).last()
  const toolbarHeight = async () => Math.round((await toolbar.boundingBox()).height)
  const partY = ref => page.locator(`g[data-comp='${ref}']`).boundingBox().then(b => Math.round(b.y))
  // pins and the net whose drawn wire passes each pin's end (pins carry no ref or net in the page)
  const pinMap = (on = page) => on.evaluate(() => {
    const scr = (el, x, y) => { const c = el.getScreenCTM(); return { x: x * c.a + y * c.c + c.e, y: x * c.b + y * c.d + c.f } }
    const nets = [...document.querySelectorAll('g[data-net]')].map(g => {
      const pts = []
      for (const p of g.querySelectorAll('path')) {
        const L = p.getTotalLength()
        for (let s = 0; s <= L; s += 3) { const m = p.getPointAtLength(s); pts.push(scr(p, m.x, m.y)) }
      }
      return pts
    })
    const pins = []
    // only pins in the part of the schematic on screen (some parts sit below it)
    const view = document.querySelector('svg:has(g[data-comp])').getBoundingClientRect()
    for (const comp of document.querySelectorAll('g[data-comp]')) {
      let num = 0
      for (const hit of comp.querySelectorAll("g[style*='crosshair'] circle[r='8']")) {
        num++
        const p = scr(hit, +hit.getAttribute('cx'), +hit.getAttribute('cy'))
        if (p.x < view.left + 15 || p.x > view.right - 15 || p.y < view.top + 15 || p.y > view.bottom - 15) continue
        const net = nets.findIndex(pts => pts.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 5))
        pins.push({ ref: comp.getAttribute('data-comp'), pin: String(num), x: p.x, y: p.y, net })
      }
    }
    return { pins, nets: nets.length }
  })
  const handles = () => page.evaluate(() => [...document.querySelectorAll("svg g[style*='crosshair'] > circle[r='6']")]
    .filter(c => !c.closest('g[data-comp]')).map(c => `${c.getAttribute('cx')},${c.getAttribute('cy')}`))

  const h0 = await toolbarHeight()
  const before = await pinMap()
  let pair = null
  for (const a of before.pins) for (const b of before.pins) {
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    if (a.ref !== b.ref && a.net >= 0 && b.net >= 0 && a.net !== b.net && (!pair || d < pair.d)) pair = { a, b, d }
  }
  if (!pair) throw new Error('no two pins of different nets on the demo schematic')
  const y0 = await partY(pair.b.ref)

  // S1
  await page.mouse.click(pair.a.x, pair.a.y)
  await page.waitForTimeout(300)
  const started = await hint.isVisible()
  const h1 = await toolbarHeight(), y1 = await partY(pair.b.ref)
  check('S1 a click on a pin starts a wire and the schematic does not move', started && h1 === h0 && y1 === y0,
    `wire ${started ? 'started' : 'dropped'}, toolbar ${h0}→${h1} px, ${pair.b.ref} y ${y0}→${y1}`)

  // S2
  if (!started) await page.mouse.click(pair.a.x, pair.a.y)   // so the next checks still run on the old build
  await page.mouse.click(pair.b.x, pair.b.y)
  await page.waitForTimeout(900)
  const joined = await pinMap()
  check('S2 a click on a pin of another net joins the two nets', !(await hint.isVisible()) && joined.nets === before.nets - 1
    && await page.getByText('● 수정됨').isVisible(), `nets ${before.nets}→${joined.nets}`)

  // S3
  const other = joined.pins.find(p => p.net >= 0 && p.ref !== pair.a.ref && p.ref !== pair.b.ref)
  const sb = await page.locator('svg:has(g[data-comp])').first().boundingBox()
  await page.mouse.click(other.x, other.y)
  await page.waitForTimeout(200)
  const shown = await hint.isVisible()
  await page.mouse.click(sb.x + 30, sb.y + 30)
  await page.waitForTimeout(300)
  check('S3 a click on empty space drops a started wire', shown && !(await hint.isVisible()) && (await pinMap()).nets === joined.nets)

  // S4: a and b are on one net now
  const samePin = q => p => p.ref === q.ref && p.pin === q.pin
  const a = joined.pins.find(samePin(pair.a))
  const b = joined.pins.find(samePin(pair.b))
  await page.mouse.click(a.x, a.y)
  await page.waitForTimeout(200)
  await page.mouse.click(b.x, b.y)
  await page.waitForTimeout(300)
  // pick that net by a point of its wire and count its end handles: one per pin
  const wirePt = await page.evaluate(i => {
    const p = document.querySelectorAll('g[data-net]')[i].querySelector("path[stroke='transparent']")
    const L = p.getTotalLength(), m = p.getPointAtLength(L / 2), c = p.getScreenCTM()
    return { x: m.x * c.a + m.y * c.c + c.e, y: m.x * c.b + m.y * c.d + c.f }
  }, a.net)
  await page.mouse.click(wirePt.x, wirePt.y)
  await page.waitForTimeout(400)
  const hs = await handles()
  check('S4 joining two pins already on one net adds no pin twice', hs.length > 0 && new Set(hs).size === hs.length,
    `${hs.length} handles, ${new Set(hs).size} places`)

  // S5
  const h5 = await toolbarHeight()
  const tb = await toolbar.boundingBox(), home = await page.getByRole('button', { name: '⌂', exact: true }).first().boundingBox()
  check('S5 with a net picked the toolbar keeps its height and its zoom buttons', h5 === h0 && home.x + home.width <= tb.x + tb.width,
    `toolbar ${h0}→${h5} px, ⌂ right ${Math.round(home.x + home.width)} / toolbar right ${Math.round(tb.x + tb.width)}`)

  // S6: pick a net by its wire, then drag one end handle onto a pin of another part off that net
  await page.mouse.click(sb.x + 30, sb.y + 30)
  await page.waitForTimeout(200)
  const m6 = await pinMap()
  const pick = await page.evaluate(() => {
    for (const p of document.querySelectorAll("g[data-net] path[stroke='transparent']")) {
      const L = p.getTotalLength()
      if (L < 40) continue
      const m = p.getPointAtLength(L / 2), c = p.getScreenCTM()
      return { x: m.x * c.a + m.y * c.c + c.e, y: m.x * c.b + m.y * c.d + c.f }
    }
    return null
  })
  await page.mouse.click(pick.x, pick.y)
  await page.waitForTimeout(400)
  const ends = await page.evaluate(() => [...document.querySelectorAll("svg g[style*='crosshair'] > circle[r='6']")]
    .filter(c => !c.closest('g[data-comp]')).map(c => { const m = c.getScreenCTM(), x = +c.getAttribute('cx'), y = +c.getAttribute('cy')
      return { x: x * m.a + y * m.c + m.e, y: x * m.b + y * m.d + m.f } }))
  const at = q => m6.pins.find(p => Math.hypot(p.x - q.x, p.y - q.y) < 4)
  let move = null
  for (const h of ends) {
    const own = at(h), keep = ends.map(at).find(p => p && p !== own)
    const target = own && keep && m6.pins.filter(t => t.ref !== own.ref && t.net !== own.net)
      .sort((a, b) => Math.hypot(a.x - h.x, a.y - h.y) - Math.hypot(b.x - h.x, b.y - h.y))[0]
    if (target) { move = { h, own, keep, target }; break }
  }
  let moved = false, wireStarted = false
  if (move) {
    await page.mouse.move(move.h.x, move.h.y)
    await page.mouse.down()
    await page.mouse.move(move.target.x, move.target.y, { steps: 12 })
    wireStarted = await hint.isVisible()
    await page.mouse.up()
    await page.waitForTimeout(900)
    const m = await pinMap(), now = q => m.pins.find(samePin(q))
    const t = now(move.target), k = now(move.keep), o = now(move.own)
    moved = !!t && !!k && t.net >= 0 && t.net === k.net && (!o || o.net !== k.net)
  }
  if (await hint.isVisible()) await page.mouse.click(sb.x + 30, sb.y + 30)
  check('S6 dragging an end handle onto another pin moves that end of the net', !!move && moved && !wireStarted,
    move ? `${move.own.ref} end → ${move.target.ref}; ${wireStarted ? 'a new wire started instead' : moved ? 'moved' : 'not moved'}` : 'no handle to drag')

  // S7
  const box = await svg.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -240)
  await page.keyboard.up('Control')
  await page.waitForTimeout(300)
  const outZoomed = await outside()
  await page.getByRole('button', { name: '⌂', exact: true }).first().click()
  await page.waitForTimeout(300)
  const outAfterHome = await outside()
  check('S7 every part is in view when the circuit opens and after ⌂', outAtOpen.length === 0 && outZoomed.length > 0 && outAfterHome.length === 0,
    `outside at open [${outAtOpen}], zoomed in [${outZoomed}], after ⌂ [${outAfterHome}]`)

  // S8
  await page.mouse.click(sb.x + 30, sb.y + 30)
  await page.waitForTimeout(200)
  const part = await page.locator("g[data-comp='D1']").boundingBox()
  await page.mouse.click(part.x + part.width / 2, part.y + part.height / 2)
  await page.waitForTimeout(400)
  const props = await page.getByText('PROPERTIES', { exact: true }).isVisible().catch(() => false)
  await page.mouse.click(sb.x + 30, sb.y + 30)
  await page.waitForTimeout(200)
  await page.mouse.dblclick(part.x + part.width / 2, part.y + part.height / 2)
  await page.waitForTimeout(400)
  const field = await page.locator('svg foreignObject input, svg input').first().isVisible().catch(() => false)
  await page.keyboard.press('Escape')
  check('S8 a click on a part shows its properties, a double-click opens its value field', props && field, `properties ${props}, value field ${field}`)

  // S9: open and close the drawer below the schematic (the Netlist tab)
  await page.getByRole('button', { name: '⌂', exact: true }).first().click()
  await page.waitForTimeout(300)
  const z0 = await page.evaluate(() => document.querySelector('svg:has(g[data-comp]) > g')?.getAttribute('transform'))
  await page.locator('button.sf-drawer-tab', { hasText: 'Netlist' }).first().click()
  await page.waitForTimeout(600)
  const outOpen = await outside()
  await page.locator('button.sf-drawer-tab').first().locator('xpath=..').getByRole('button', { name: '×' }).click()
  await page.waitForTimeout(600)
  const outClosed = await outside()
  const z1 = await page.evaluate(() => document.querySelector('svg:has(g[data-comp]) > g')?.getAttribute('transform'))
  check('S9 the view fits again as the drawer below opens and closes', outOpen.length === 0 && outClosed.length === 0 && z1 === z0,
    `outside with the drawer open [${outOpen}], after it closes [${outClosed}], view ${z0 === z1 ? 'back as before' : `${z0} → ${z1}`}`)

  // S10: the size change came between the render that shows the circuit and the one that places its parts, and the
  // refit it set off ran on no parts. A real change is told at the next frame, which only sometimes comes in between,
  // so on a second page the schematic is told at once: its box is made 2 px shorter in the microtask after the
  // schematic starts watching it
  const forced = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await forced.addInitScript(() => {
    const Native = window.ResizeObserver
    window.ResizeObserver = class extends Native {
      constructor(cb) { super(cb); this.cb = cb; this.on = true }
      observe(el, opts) {
        super.observe(el, opts)
        if (!el.querySelector(':scope > svg')) return   // the schematic's box (its parts may not be drawn yet)
        queueMicrotask(() => {
          if (!this.on) return   // let go at once (development mode watches twice)
          el.style.maxHeight = `${el.clientHeight - 2}px`
          window.__shrunk = el.clientHeight
          this.cb([], this)
        })
      }
      disconnect() { this.on = false; super.disconnect() }
    }
  })
  const p10 = await forced.newPage()
  await p10.goto(`${BASE}/?demo=motor`, { waitUntil: 'networkidle' })
  await p10.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 60000 })
  await p10.waitForTimeout(300)
  const view = () => p10.evaluate(() => document.querySelector('svg:has(g[data-comp]) > g')?.getAttribute('transform'))
  const shrunk = await p10.evaluate(() => window.__shrunk ?? null)
  const atOpen = await view(), outAtOpen10 = await outside(p10)
  await p10.getByRole('button', { name: '⌂', exact: true }).first().click()
  await p10.waitForTimeout(300)
  const homed = await view()
  check('S10 the circuit opens fitted when the schematic changes size before its parts are placed',
    shrunk !== null && atOpen === homed && outAtOpen10.length === 0,
    `${shrunk === null ? 'the schematic was never made shorter' : `made ${shrunk} px tall`}, outside at open [${outAtOpen10}], view at open ${atOpen === homed ? 'as ⌂ gives' : `${atOpen}, after ⌂ ${homed}`}`)

  // S11: an AI edit that adds a part leaves the parts already there where they were in the drawing, so on screen they
  // keep their arrangement (one zoom for all: the check notice the edit brings above the schematic makes it lower), and
  // the new part goes on a free spot in view; undo takes it away and moves nothing (2026-11-02 tour, 325-329 s: adding
  // C4 to the 555's nine parts laid every part out again, three columns became four, and undo laid them back).
  // On the 555 demo, with the login and the AI editor's answer faked
  const ctx11 = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await ctx11.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
  })
  const p11 = await ctx11.newPage()
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await p11.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
  await p11.route(/\/(favorites|sessions)(\/.*)?$/, r => json(r, { favorites: [], sessions: [], messages: [], id: 's1' }))
  await p11.route(/\/erc_graph$/, r => json(r, { erc: [] }))
  const answer = { reply: 'VCC와 GND 사이에 100nF 커패시터 C4를 추가했습니다.', actions: [
    { type: 'add_component', ref: 'C4', name: 'C', value: '100nF' },
    { type: 'add_net', name: 'VCC', nodes: [{ ref: 'C4', pin: '1' }] },
    { type: 'add_net', name: 'GND', nodes: [{ ref: 'C4', pin: '2' }] }] }
  await p11.route(/\/chat_edit$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(answer)}\n\n` }))
  await p11.goto(`${BASE}/?demo=ne555`, { waitUntil: 'networkidle' })
  await p11.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 60000 })
  const editor = p11.getByTestId('toggle-left-panel')
  if ((await editor.getAttribute('aria-pressed')) !== 'true') await editor.click()
  await p11.waitForTimeout(600)
  // each part's place in the drawing (its translate) and where that point is on screen; boxes for the new part's room
  const spots = () => p11.evaluate(() => {
    const v = document.querySelector('svg:has(g[data-comp])').getBoundingClientRect()
    return Object.fromEntries([...document.querySelectorAll('g[data-comp]')].map(g => {
      const m = g.getScreenCTM(), b = g.getBoundingClientRect()
      return [g.getAttribute('data-comp'), { at: g.getAttribute('transform'), x: m.e, y: m.f,
        box: [b.left, b.top, b.right, b.bottom], inView: b.left >= v.left && b.right <= v.right && b.top >= v.top && b.bottom <= v.bottom }]
    }))
  })
  const leftPlace = (a, b, onScreen) => Object.keys(a).filter(r => !b[r] || a[r].at !== b[r].at || (onScreen && Math.hypot(a[r].x - b[r].x, a[r].y - b[r].y) > 0.5))
  // the parts' screen points against the ones before, as one zoom k and shift: the worst miss in px
  const arranged = (a, b) => {
    const [p, q] = Object.keys(a), k = Math.hypot(b[p].x - b[q].x, b[p].y - b[q].y) / Math.hypot(a[p].x - a[q].x, a[p].y - a[q].y)
    const miss = Math.max(...Object.keys(a).map(r => Math.hypot(b[r].x - (b[p].x + k * (a[r].x - a[p].x)), b[r].y - (b[p].y + k * (a[r].y - a[p].y)))))
    return { k, miss }
  }
  const s0 = await spots()
  await p11.getByTestId('chat-input').fill('VCC와 GND 사이에 100nF 커패시터 C4를 하나 추가해줘')
  await p11.getByTestId('chat-input').press('Enter')
  await p11.locator("g[data-comp='C4']").waitFor({ timeout: 10000 })
  await p11.waitForTimeout(800)
  const s1 = await spots()
  const c4 = s1.C4, clear = !!c4 && Object.entries(s1).every(([r, o]) => r === 'C4'
    || Math.min(c4.box[2], o.box[2]) <= Math.max(c4.box[0], o.box[0]) || Math.min(c4.box[3], o.box[3]) <= Math.max(c4.box[1], o.box[1]))
  await p11.getByRole('button', { name: /되돌리기/ }).first().click()
  await p11.locator("g[data-comp='C4']").waitFor({ state: 'detached', timeout: 10000 })
  await p11.waitForTimeout(800)
  const s2 = await spots()
  const add = leftPlace(s0, s1, false), undo = leftPlace(s0, s2, true), look = arranged(s0, s1)
  check('S11 adding a part moves none of the parts there (one zoom for all on screen), the new one sits in view on its own; undo moves nothing',
    Object.keys(s0).length >= 9 && !!c4 && !add.length && look.miss <= 1 && c4.inView && clear && !undo.length && !s2.C4,
    `${Object.keys(s0).length} parts; moved in the drawing by the add [${add}], on screen zoom ×${look.k.toFixed(3)} (off by ${look.miss.toFixed(1)} px); `
    + `moved by undo [${undo}]; C4 ${c4 ? `at ${c4.at}, ${c4.inView ? 'in view' : 'out of view'}, ${clear ? 'clear of the others' : 'over another part'}` : 'not drawn'}`)

  // S12: the layout outlives the PCB tab, and a part taken out comes back to its spot on undo (2026-11-03 tour: back
  // from the PCB tab after adding C4 every part had moved, 328 s; undoing "LED D1 빼줘" put D1 under U1, not beside R1
  // where it was, 350-360 s). On S11's page, with the PCB tab in between the removal and the undo
  const tabs = async () => {
    await p11.getByTestId('view-tab-pcb').click()
    await p11.waitForTimeout(600)
    await p11.getByTestId('view-tab-schematic').click()
    await p11.locator('g[data-comp]').first().waitFor({ timeout: 10000 })
    await p11.waitForTimeout(600)
  }
  const say = async (msg, body) => {
    await p11.unroute(/\/chat_edit$/)
    await p11.route(/\/chat_edit$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(body)}\n\n` }))
    await p11.getByTestId('chat-input').fill(msg)
    await p11.getByTestId('chat-input').press('Enter')
  }
  const undoEdit = () => p11.getByRole('button', { name: /되돌리기/ }).first().click()
  // with C4 added (ten parts, a layout of its own) the PCB tab and back
  await say('VCC와 GND 사이에 100nF 커패시터 C4를 하나 추가해줘', answer)
  await p11.locator("g[data-comp='C4']").waitFor({ timeout: 10000 })
  await p11.waitForTimeout(800)
  const s3a = await spots()
  await tabs()
  const s3 = await spots()
  await undoEdit()
  await p11.locator("g[data-comp='C4']").waitFor({ state: 'detached', timeout: 10000 })
  await p11.waitForTimeout(800)
  const s3b = await spots()
  // D1 out, the PCB tab, undo
  await say('LED D1 빼줘', { reply: 'LED D1을 뺐습니다.', actions: [{ type: 'remove_component', ref: 'D1' }] })
  await p11.locator("g[data-comp='D1']").waitFor({ state: 'detached', timeout: 10000 })
  await tabs()
  await undoEdit()
  await p11.locator("g[data-comp='D1']").waitFor({ timeout: 10000 })
  await p11.waitForTimeout(800)
  const s4 = await spots()
  const tabMoved = leftPlace(s3a, s3, false), undoMoved = leftPlace(s3b, s4, false)
  check('S12 the PCB tab and back moves no part (C4 added); a part taken out comes back to its spot on undo, the PCB tab in between',
    Object.keys(s3).length >= 10 && !!s3.C4 && !tabMoved.length && !undoMoved.length && !leftPlace(s2, s3b, false).length,
    `moved by the tabs [${tabMoved}]; moved after removing D1 and undoing [${undoMoved}]${s3b.D1 && s4.D1 ? `; D1 ${s3b.D1.at} -> ${s4.D1.at}` : ''}`)

  // S13: a generation whose answer carries one error, as /generate checks it (with the SMD table)
  const ctx13 = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await ctx13.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
    localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: false }))
  })
  const p13 = await ctx13.newPage()
  const floatingBase = pad => ({ rule: 'floating_pin', severity: 'error', message: `Q1의 B 핀(${pad === '1' ? '1번' : `1번, 기판 패드 ${pad}`})이 떠 있습니다`,
    refs: [{ ref: 'Q1', pin: pad, sym: '1', name: 'B' }], net: null })
  const demo13 = await fetch(`${BASE}/demo_result/motor`).then(r => r.json())
  const checked = []
  await p13.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
  await p13.route(/\/(favorites|sessions)(\/.*)?$/, r => json(r, { favorites: [], sessions: [], messages: [], id: 's1' }))
  await p13.route(/\/generate$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream',
    body: `event: done\ndata: ${JSON.stringify({ ...demo13, erc: { findings: [floatingBase('1')], repair: null } })}\n\n` }))
  await p13.route(/\/erc_graph$/, r => {
    const sent = r.request().postDataJSON()
    checked.push(sent)
    return json(r, { erc: [floatingBase(sent.style === 'tht' ? '2' : '1')] })
  })
  await p13.route(/\/chat_edit$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify({ reply: 'R1 값을 바꿨습니다.', actions: [{ type: 'modify_component', ref: 'R1', value: '2k2' }] })}\n\n` }))
  await p13.goto(BASE, { waitUntil: 'networkidle' })
  await p13.locator('.sf-home-input textarea').fill('베이스가 뜬 모터 회로')
  await p13.getByRole('button', { name: '회로 만들기', exact: true }).click()
  const notice = p13.getByTestId('erc-notice')
  await notice.waitFor({ timeout: 20000 })
  const atSmd = await notice.innerText(), sentAtSmd = checked.length
  await p13.getByRole('button', { name: 'THT', exact: true }).click()
  const thtPad = await notice.getByText('기판 패드 2').waitFor({ timeout: 5000 }).then(() => true, () => false)
  const onResult = checked.at(-1)
  await p13.getByRole('button', { name: 'SMD', exact: true }).click()
  await p13.waitForTimeout(600)
  const backSmd = await notice.innerText()
  await p13.getByRole('button', { name: 'THT', exact: true }).click()
  await notice.getByText('기판 패드 2').waitFor({ timeout: 5000 }).catch(() => {})
  await p13.getByTestId('chat-input').fill('R1 값을 2k2로 바꿔줘')
  await p13.getByTestId('chat-input').press('Enter')
  await p13.waitForFunction(() => /AI 편집 뒤/.test(document.querySelector("[data-testid='erc-notice']")?.innerText || ''), null, { timeout: 5000 }).catch(() => {})
  const editedTht = await notice.innerText(), sentEdited = checked.at(-1)
  await p13.getByRole('button', { name: 'SMD', exact: true }).click()
  await p13.waitForFunction(() => /AI 편집 뒤/.test(document.querySelector("[data-testid='erc-notice']")?.innerText || '')
    && !/기판 패드/.test(document.querySelector("[data-testid='erc-notice']")?.innerText || ''), null, { timeout: 5000 }).catch(() => {})
  const editedSmd = await notice.innerText(), sentSmd = checked.at(-1)
  const r1 = g => g?.components?.find(c => c.ref === 'R1')?.value
  check('S13 the check above the schematic has the pad numbers of the SMD/THT choice, before and after an AI edit',
    /\(1번\)/.test(atSmd) && sentAtSmd === 0 && thtPad && onResult?.style === 'tht' && r1(onResult?.graph) === r1(demo13.graph) && /\(1번\)/.test(backSmd)
    && /기판 패드 2/.test(editedTht) && sentEdited?.style === 'tht' && r1(sentEdited?.graph) === '2k2' && !/기판 패드/.test(editedSmd) && sentSmd?.style === 'smd',
    `SMD ${sentAtSmd} calls; THT pad 2 ${thtPad} (${onResult?.style}); back on SMD ${/\(1번\)/.test(backSmd)}; edited ${sentEdited?.style} ${/기판 패드 2/.test(editedTht)}, then ${sentSmd?.style} ${!/기판 패드/.test(editedSmd)}`)

  // S14-S16: a generated circuit in a saved session, every request kept
  const ctx14 = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await ctx14.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
    localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: false }))
  })
  const p14 = await ctx14.newPage()
  const rechecked = [], saved = [], pcbs = []
  const final14 = { outline: [0, 0, 20, 14], parts: [], nets: [], style: 'smd', erc: [], tracks: [], vias: [], unrouted: [] }
  await p14.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
  await p14.route(/\/favorites$/, r => json(r, { favorites: [] }))
  await p14.route(/\/sessions$/, r => json(r, { id: 's14', sessions: [] }))
  await p14.route(/\/sessions\/s14$/, r => { saved.push(r.request().postDataJSON()); return json(r, { ok: true }) })
  await p14.route(/\/generate$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(demo13)}\n\n` }))
  await p14.route(/\/erc_graph$/, r => { rechecked.push(r.request().postDataJSON().graph); return json(r, { erc: [] }) })
  await p14.route(/\/generate_pcb_stream$/, r => {
    pcbs.push(r.request().postDataJSON())
    return r.fulfill({ status: 200, contentType: 'text/event-stream',
      body: `event: done\ndata: ${JSON.stringify({ board: final14, pcbFilename: 'check.kicad_pcb', summary: { unmapped: [], warnings: [] } })}\n\n` })
  })
  await p14.route(/\/board_model/, r => r.fulfill({ status: 404, body: '' }))
  await p14.goto(BASE, { waitUntil: 'networkidle' })
  await p14.locator('.sf-home-input textarea').fill('손으로 고칠 모터 회로')
  await p14.getByRole('button', { name: '회로 만들기', exact: true }).click()
  await p14.locator('g[data-comp]').first().waitFor({ timeout: 20000 })
  await p14.waitForTimeout(600)
  const settle = () => p14.waitForTimeout(900)
  const netGroups = () => p14.locator('g[data-net]').count()
  const notice14 = () => p14.getByTestId('erc-notice').innerText().catch(() => '')
  const undo14 = p14.getByTestId('schematic-undo')
  const modifiedMark = p14.getByText('● 수정됨')
  const onOneNet = (g, x, y) => (g?.nets ?? []).some(n => n.nodes.some(nd => nd.ref === x.ref && nd.pin === x.pin) && n.nodes.some(nd => nd.ref === y.ref && nd.pin === y.pin))
  const valueOf = (g, ref) => g?.components?.find(c => c.ref === ref)?.value
  const wiredPair = pins => {
    let best = null
    for (const a of pins) for (const b of pins) {
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (a.ref !== b.ref && a.net >= 0 && b.net >= 0 && a.net !== b.net && (!best || d < best.d)) best = { a, b, d }
    }
    return best
  }
  const join = async () => {
    const { pins } = await pinMap(p14)
    const { a, b } = wiredPair(pins)
    await p14.mouse.click(a.x, a.y)
    await p14.waitForTimeout(200)
    await p14.mouse.click(b.x, b.y)
    await settle()
    return { a, b }
  }

  const nets0 = await netGroups()
  const { a: a14, b: b14 } = await join()
  const joinedNets = await netGroups(), said14 = await notice14()
  const undoWords = await p14.locator('[data-testid="left-panel"] button', { hasText: '되돌리기' }).getAttribute('title').catch(() => null)
  const reachedCheck = onOneNet(rechecked.at(-1), a14, b14), reachedSave = onOneNet(saved.at(-1)?.graph, a14, b14)
  const inBrowser = await p14.evaluate(() => JSON.parse(localStorage.getItem('sf_saved_results') || '[]')[0]?.graph)
  check('S14a a joined wire reaches the check, the saved session and this browser\'s record, and is not called an AI edit',
    joinedNets === nets0 - 1 && reachedCheck && reachedSave && onOneNet(inBrowser, a14, b14) && /^편집 뒤/.test(said14) && !/AI 편집/.test(said14) && undoWords === '마지막 수정 취소',
    `nets ${nets0}→${joinedNets}, check ${reachedCheck}, session ${reachedSave}, notice "${said14.split('\n')[0]}", undo "${undoWords}"`)

  await p14.getByTestId('view-tab-pcb').click()
  await p14.waitForTimeout(500)
  await p14.getByTestId('view-tab-schematic').click()
  await p14.locator('g[data-comp]').first().waitFor({ timeout: 10000 })
  await settle()
  check('S14b it outlives the PCB tab', await netGroups() === nets0 - 1 && await modifiedMark.isVisible())

  await undo14.click()
  await settle()
  const undone = await netGroups() === nets0 && !(await modifiedMark.isVisible()) && !onOneNet(saved.at(-1)?.graph, a14, b14)
  check('S14c undo takes it back, on screen and in the saved session', undone, `nets ${await netGroups()}, marked ${await modifiedMark.isVisible()}`)

  const { a: a14d, b: b14d } = await join()
  await p14.getByRole('button', { name: /PCB (다시 )?생성/ }).first().click()
  await p14.getByRole('button', { name: /\.kicad_pcb/ }).waitFor({ timeout: 10000 })
  check('S14d the next PCB is made from the edited circuit', onOneNet(pcbs.at(-1)?.graph, a14d, b14d) && !pcbs.at(-1)?.filename && !!pcbs.at(-1)?.baseName, JSON.stringify(Object.keys(pcbs.at(-1) ?? {})))
  await p14.getByTestId('view-tab-schematic').click()
  await p14.locator('g[data-comp]').first().waitFor({ timeout: 10000 })
  await settle()
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
