// Browser checks for the PCB tab's sketch (간이 보기), shown before a PCB is made, on the LED demo: it only shows the
// circuit, it does not change it. It let a trace be deleted into its own copy and marked the sketch "● 수정됨", while
// the BOM, the checks and the next PCB kept the trace (the defect fixed in the schematic: review of 2026-11-07).
// K1 the PCB tab shows the sketch, its note and its traces, K2 a trace pressed opens its panel, and nothing in the
// sketch is named 삭제 (if something is, it is pressed, as a person would), K3 after that the sketch has as many traces
// as before, no "● 수정됨" and no 되돌리기.
// Needs the vite dev server (npm run dev) and the demo route of its API; no PCB is built.
// Usage: node scripts/check_pcb_sketch.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${BASE}/?demo=led`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 60000 })
  await page.getByTestId('view-tab-pcb').click()
  const note = page.getByText('간이 보기예요').first()
  await note.waitFor({ timeout: 10000 })
  await page.locator('g[data-trace]').first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(400)
  const traces = () => page.locator('g[data-trace]').count()
  const before = await traces()
  check('K1 the PCB tab before a PCB shows the sketch, its note and its traces', before > 0 && await note.isVisible(), `${before} traces`)

  // K2: the middle of the first trace's first wire, in the page's pixels
  const at = await page.evaluate(() => {
    const p = document.querySelector('g[data-trace] path[stroke="transparent"]')
    if (!p) return null
    const pt = p.getPointAtLength(p.getTotalLength() / 2), m = p.getScreenCTM()
    return { x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f }
  })
  if (at) await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(400)
  const sketch = page.locator('div:has(> svg g[data-trace])').first()
  const panelOpen = await page.getByText('NODES', { exact: true }).isVisible().catch(() => false)
  const deleters = sketch.locator('button', { hasText: '삭제' })
  const named = await deleters.count()
  check('K2 a trace pressed opens its panel, and nothing in the sketch deletes a trace', !!at && panelOpen && named === 0,
    `panel ${panelOpen}, buttons named 삭제 ${named}`)
  if (named) { await deleters.first().click(); await page.waitForTimeout(400) }

  // K3
  const after = await traces()
  const marked = await page.getByText('● 수정됨').count()
  const undo = await sketch.locator('button', { hasText: '되돌리기' }).count()
  check('K3 after that the sketch keeps every trace, with no "● 수정됨" and no 되돌리기', after === before && marked === 0 && undo === 0,
    `traces ${before}→${after}, 수정됨 ${marked}, 되돌리기 ${undo}`)
  check('page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAILED` : 'all ok')
process.exit(failed ? 1 : 0)
