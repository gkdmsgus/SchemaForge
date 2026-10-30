// Browser checks that nothing on the schematic is drawn over something else, measured on the page, on the 555
// demo, the motor demo and an LM1117 3.3 V supply (the circuits of the logged-in tour, frame review of 2026-10-30):
// P1 no two power symbols overlap (NE555's GND and VCC labels landed on each other on both sides of U1, and
// LM1117's VOUT flag on its GND symbol), P2 no power symbol is drawn over a part.
// Needs the vite dev server (npm run dev) and the demo route of its API (the LM1117 circuit is served by the page).
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

// everything drawn, in page pixels: part bodies and power symbols (with their labels)
const measure = page => page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } }
  const bodies = [...document.querySelectorAll('g[data-comp]')].map(g => ({ ref: g.getAttribute('data-comp'), ...box(g.querySelector("rect[rx='6']")) }))
  const symbols = []
  for (const g of document.querySelectorAll('g[data-net]')) {
    if (g.querySelector("path[stroke='transparent']")) continue   // a net drawn as wires
    for (const s of g.querySelectorAll(':scope > g > g')) {
      const t = s.querySelector('text')
      if (t) symbols.push({ name: t.textContent, box: box(s), label: box(t) })
    }
  }
  return { bodies, symbols }
})
const area = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
// where a symbol is: the part whose body is nearest to it
const nearest = (m, b) => m.bodies.reduce((best, p) => {
  const d = Math.hypot(Math.max(p.x0 - b.x1, 0, b.x0 - p.x1), Math.max(p.y0 - b.y1, 0, b.y0 - p.y1))
  return !best || d < best.d ? { ref: p.ref, d } : best
}, null)?.ref

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.route(/\/demo_result\/lm1117$/, r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ filename: 'lm1117.net', graph: LM1117, code: '', guide: '' }) }))
  for (const demo of ['ne555', 'motor', 'lm1117']) {
    await page.goto(`${BASE}/?demo=${demo}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 60000 })
    await page.waitForTimeout(500)
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
  }
} catch (e) {
  failed++
  console.log('FAIL stopped: ' + String(e?.message || e).split('\n')[0])
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} FAIL` : '\nall ok')
process.exitCode = failed ? 1 : 0
