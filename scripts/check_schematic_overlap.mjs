// Browser checks that nothing on the schematic is drawn over something else, measured on the page, on the 555
// demo, the motor demo, an LM1117 3.3 V supply and the tour's 555 blinker (the circuits of the logged-in tour, frame
// reviews of 2026-10-30):
// P1 no two power symbols overlap (NE555's GND and VCC labels landed on each other on both sides of U1, and
// LM1117's VOUT flag on its GND symbol), P2 no power symbol is drawn over a part, W0 every wire starts and ends
// on a pin, W1 no wire runs through a part (the 555's LED net ran through D1 and R3, and in the tour's circuit
// through D1, R1, R2 and R3, so it read as a wire between two other pins), W2 no wire runs along another net's
// wire (in the tour's 555 OUT ran down the column TRIG/THRES ran up, so OUT read as joined to them), W3 no wire runs
// over a power symbol (U1's DISCH wire crossed its VCC label). The wires are checked again after the tour's SW1 is
// dragged beside U1 onto its VCC symbol: OUT's pin was shut in, its wire fell back to a bend halfway, ran through R2
// and U1 and looked like it ended on DISCH (tour take of 2026-10-30).
// Needs the vite dev server (npm run dev) and the demo route of its API (LM1117 and the tour's circuit are served by
// the page).
// Usage: node scripts/check_schematic_overlap.mjs [BASE]   (default http://localhost:3000; SHOTS=dir saves each schematic)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
const SHOTS = process.env.SHOTS
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

// USB 5 V in, LM1117-3.3 (1 GND, 2 VOUT, 3 VIN), its two capacitors and a power LED
const node = s => { const [ref, pin] = s.split('.'); return { ref, pin } }
const LM1117 = {
  components: [['J1', 'USB_5V'], ['C1', '10uF'], ['U1', 'LM1117-3.3'], ['C2', '22uF'], ['R1', '330'], ['D1', 'GREEN']]
    .map(([ref, value]) => ({ ref, value })),
  nets: [
    { name: 'VIN', nodes: ['J1.1', 'C1.1', 'U1.3'].map(node) },
    { name: 'GND', nodes: ['J1.2', 'C1.2', 'U1.1', 'C2.2', 'D1.2'].map(node) },
    { name: 'VOUT', nodes: ['U1.2', 'C2.1', 'R1.1'].map(node) },
    { name: 'LED_A', nodes: ['R1.2', 'D1.1'].map(node) },
  ],
}

// everything drawn, in page pixels: part bodies, pin ends, power symbols (with their labels) and each wired
// net's straight wire pieces
// the tour's 555 blinker as the frames show it (parts in this order give its layout)
const TOUR555 = {
  components: [['BT1', '5V'], ['C1', '10nF'], ['C2', '100uF'], ['C3', '100nF'], ['D1', 'RED'], ['R1', '250'],
    ['R2', '250'], ['R3', '150'], ['SW1', 'SPST'], ['U1', 'NE555']].map(([ref, value]) => ({ ref, value })),
  nets: [
    { name: 'GND', nodes: ['BT1.2', 'C1.2', 'C2.2', 'C3.2', 'D1.2', 'U1.1'].map(node) },
    { name: 'LED_A', nodes: ['D1.1', 'R3.2'].map(node) },
    { name: 'N$1', nodes: ['C1.1', 'U1.5'].map(node) },
    { name: 'N$2', nodes: ['R1.2', 'R2.1', 'U1.7'].map(node) },
    { name: 'N$3', nodes: ['R3.1', 'U1.3'].map(node) },
    { name: 'TRIG_THRES', nodes: ['C2.1', 'R2.2', 'U1.2', 'U1.6'].map(node) },
    { name: 'VCC', nodes: ['BT1.1', 'C3.1', 'R1.1', 'SW1.1', 'SW1.2', 'U1.4', 'U1.8'].map(node) },
  ],
}
const SERVED = { lm1117: LM1117, tour555: TOUR555 }

const measure = page => page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } }
  const scr = (el, x, y) => { const c = el.getScreenCTM(); return { x: x * c.a + y * c.c + c.e, y: x * c.b + y * c.d + c.f } }
  const bodies = [...document.querySelectorAll('g[data-comp]')].map(g => ({ ref: g.getAttribute('data-comp'), ...box(g.querySelector("rect[rx='6']")) }))
  const pins = [...document.querySelectorAll("g[data-comp] circle[r='8']")].map(c => scr(c, +c.getAttribute('cx'), +c.getAttribute('cy')))
  const symbols = [], segs = []
  for (const g of document.querySelectorAll('g[data-net]')) {
    const net = +g.getAttribute('data-net')
    if (!g.querySelector("path[stroke='transparent']")) {   // a power net, drawn as symbols
      for (const s of g.querySelectorAll(':scope > g > g')) {
        const t = s.querySelector('text')
        if (t) symbols.push({ name: t.textContent, box: box(s), label: box(t) })
      }
      continue
    }
    for (const p of g.querySelectorAll(":scope > g > path:not([stroke='transparent'])")) {
      const pts = [...p.getAttribute('d').matchAll(/[ML]\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)/g)].map(m => scr(p, +m[1], +m[2]))
      const wire = segs.length
      pts.slice(1).forEach((b, i) => segs.push({ net, wire, a: pts[i], b, first: i === 0, last: i === pts.length - 2 }))
    }
  }
  const zoom = +/scale\(([\d.]+)\)/.exec(document.querySelector('svg:has(g[data-comp]) > g').getAttribute('transform'))[1]
  return { bodies, pins, symbols, segs, zoom }
})
const area = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
// how much of a straight piece runs inside a box (its edge excluded)
const inside = (s, r, m = 1) => {
  const x0 = Math.min(s.a.x, s.b.x), x1 = Math.max(s.a.x, s.b.x), y0 = Math.min(s.a.y, s.b.y), y1 = Math.max(s.a.y, s.b.y)
  if (y1 - y0 < 0.5) return y0 > r.y0 + m && y0 < r.y1 - m ? Math.max(0, Math.min(x1, r.x1 - m) - Math.max(x0, r.x0 + m)) : 0
  if (x1 - x0 < 0.5) return x0 > r.x0 + m && x0 < r.x1 - m ? Math.max(0, Math.min(y1, r.y1 - m) - Math.max(y0, r.y0 + m)) : 0
  return Math.hypot(x1 - x0, y1 - y0)   // a slanted piece: not drawn by the schematic at all
}
// how far two pieces run on top of each other, or so close beside it (under 6 schematic units) that they look one
const along = (s, t, gap) => {
  const h = p => Math.abs(p.a.y - p.b.y) < 0.5, v = p => Math.abs(p.a.x - p.b.x) < 0.5
  if (h(s) && h(t) && Math.abs(s.a.y - t.a.y) < gap)
    return Math.max(0, Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x)) - Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x)))
  if (v(s) && v(t) && Math.abs(s.a.x - t.a.x) < gap)
    return Math.max(0, Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y)) - Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y)))
  return 0
}
const sum = list => [...list.reduce((m, [k, v]) => m.set(k, (m.get(k) || 0) + v), new Map())].map(([k, v]) => `${k} ${Math.round(v)} px`)
// where a symbol is: the part whose body is nearest to it
const nearest = (m, b) => m.bodies.reduce((best, p) => {
  const d = Math.hypot(Math.max(p.x0 - b.x1, 0, b.x0 - p.x1), Math.max(p.y0 - b.y1, 0, b.y0 - p.y1))
  return !best || d < best.d ? { ref: p.ref, d } : best
}, null)?.ref

// W0–W3 on one drawn schematic
function checkWires(m, graph, label) {
  const name = s => graph.nets[s.net]?.name ?? `net ${s.net}`
  // W0: every wire still starts and ends on a pin
  const loose = m.segs.filter(s => (s.first && !m.pins.some(p => Math.hypot(p.x - s.a.x, p.y - s.a.y) < 1.5))
    || (s.last && !m.pins.some(p => Math.hypot(p.x - s.b.x, p.y - s.b.y) < 1.5))).map(name)
  check(`W0 ${label}: every wire starts and ends on a pin`, m.segs.length > 0 && !loose.length, loose.join(', '))
  // W1
  const through = []
  for (const s of m.segs) for (const p of m.bodies) { const l = inside(s, p); if (l > 1) through.push([`${name(s)} through ${p.ref}`, l]) }
  check(`W1 ${label}: no wire runs through a part`, !through.length, sum(through).join(', '))
  // W2
  const lap = []
  m.segs.forEach((s, i) => m.segs.slice(i + 1).forEach(t => {
    const l = t.net !== s.net ? along(s, t, 6 * m.zoom) : 0
    if (l > 2) lap.push([`${name(s)} on ${name(t)}`, l])
  }))
  check(`W2 ${label}: no wire runs along another net's wire`, !lap.length, sum(lap).join(', '))
  // W3
  const crossed = []
  for (const s of m.segs) for (const y of m.symbols) {
    const l = Math.max(inside(s, y.box, 0.5), inside(s, y.label, 0.5))
    if (l > 1) crossed.push([`${name(s)} over ${y.name} at ${nearest(m, y.box)}`, l])
  }
  check(`W3 ${label}: no wire runs over a power symbol`, !crossed.length, sum(crossed).join(', '))
}

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.route(/\/demo_result\/(lm1117|tour555)$/, (r, req) => {
    const demo = /(\w+)$/.exec(req.url())[1]
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ filename: `${demo}.net`, graph: SERVED[demo], code: '', guide: '' }) })
  })
  for (const demo of ['ne555', 'motor', 'lm1117', 'tour555']) {
    await page.goto(`${BASE}/?demo=${demo}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 60000 })
    await page.waitForTimeout(500)
    // ⌂ first: a circuit that comes at once (the two served here) can open unfitted, at zoom 1 from the origin, with
    // parts below the visible part. What is checked does not depend on the view, but the shots and the drag do
    await page.getByRole('button', { name: '⌂', exact: true }).first().click()
    await page.waitForTimeout(300)
    if (SHOTS) await page.locator('svg:has(g[data-comp])').first().screenshot({ path: `${SHOTS}/schematic_${demo}.png` })
    const m = await measure(page)

    // P1: symbols of two pins (labels included) share no area
    const clash = []
    m.symbols.forEach((a, i) => m.symbols.slice(i + 1).forEach(b => {
      const s = Math.max(area(a.box, b.box), area(a.label, b.label), area(a.label, b.box), area(a.box, b.label))
      if (s > 1) clash.push(`${a.name}/${b.name} at ${nearest(m, a.box)} ${Math.round(s)} px²`)
    }))
    check(`P1 ${demo}: no two power symbols overlap`, m.symbols.length > 0 && !clash.length,
      `${m.symbols.length} symbols${clash.length ? '; ' + clash.join(', ') : ''}`)

    // P2
    const over = []
    for (const s of m.symbols) for (const p of m.bodies) {
      const a = Math.max(area(s.box, p), area(s.label, p))
      if (a > 1) over.push(`${s.name} over ${p.ref} ${Math.round(a)} px²`)
    }
    check(`P2 ${demo}: no power symbol is drawn over a part`, !over.length, over.join(', '))

    const graph = SERVED[demo] ?? (await (await fetch(`${BASE}/demo_result/${demo}`)).json()).graph
    checkWires(m, graph, demo)
    if (demo !== 'tour555') continue

    // the tour's move: SW1 from its own spot to beside U1, its pins on the row of U1's VCC pin (52, 32 to the
    // right and down), so SW1's VCC symbol lands on U1's. M0: it did move (a drag below the visible part moves nothing)
    const sw1 = () => page.locator("g[data-comp='SW1'] rect[rx='6']").boundingBox()
    const { zoom } = m, sw = await sw1()
    const [x, y] = [sw.x + sw.width / 2, sw.y + sw.height / 2]
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 52 * zoom, y + 32 * zoom, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const now = await sw1(), moved = [(now.x - sw.x) / zoom, (now.y - sw.y) / zoom].map(Math.round)
    check(`M0 ${demo}: SW1 is dragged beside U1`, moved[0] === 52 && moved[1] === 32, `moved ${moved.join(', ')}`)
    if (SHOTS) await page.locator('svg:has(g[data-comp])').first().screenshot({ path: `${SHOTS}/schematic_${demo}_moved.png` })
    checkWires(await measure(page), graph, `${demo} with SW1 beside U1`)
  }
} catch (e) {
  failed++
  console.log('FAIL stopped: ' + String(e?.message || e).split('\n')[0])
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} FAIL` : '\nall ok')
process.exitCode = failed ? 1 : 0
