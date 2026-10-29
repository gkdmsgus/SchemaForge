// Browser checks for drawing wires on the schematic, on the motor demo (no login):
// S1 a click on a pin starts a wire and the schematic stays where it was (the toolbar wrapped to two lines when
// the wire hint appeared, the schematic moved down, the release landed beside the pin and the wire was dropped at
// once: tour take of 2026-10-29), S2 a click on a pin of another net joins the two nets, S3 a click on empty space
// drops a started wire, S4 joining two pins that are already on one net adds no pin twice, S5 with a net picked
// the toolbar keeps its height and its zoom buttons.
// Needs the vite dev server (npm run dev) and the demo route of its API.
// Usage: node scripts/check_schematic_wiring.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.goto(`${BASE}/?demo=motor`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 60000 })

  const hint = page.getByText('연결할 핀을 클릭하세요')
  const toolbar = page.locator('div', { has: page.getByText(/COMPS · \d+ NETS/) }).last()
  const toolbarHeight = async () => Math.round((await toolbar.boundingBox()).height)
  const partY = ref => page.locator(`g[data-comp='${ref}']`).boundingBox().then(b => Math.round(b.y))
  // pins and the net whose drawn wire passes each pin's end (pins carry no ref or net in the page)
  const pinMap = () => page.evaluate(() => {
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
      for (const hit of comp.querySelectorAll("g[style*='crosshair'] circle[r='8']")) {
        const p = scr(hit, +hit.getAttribute('cx'), +hit.getAttribute('cy'))
        if (p.x < view.left + 15 || p.x > view.right - 15 || p.y < view.top + 15 || p.y > view.bottom - 15) continue
        const net = nets.findIndex(pts => pts.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 5))
        pins.push({ ref: comp.getAttribute('data-comp'), x: p.x, y: p.y, net })
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
  await page.waitForTimeout(300)
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
  const a = joined.pins.find(p => Math.hypot(p.x - pair.a.x, p.y - pair.a.y) < 3)
  const b = joined.pins.find(p => Math.hypot(p.x - pair.b.x, p.y - pair.b.y) < 3)
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
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
