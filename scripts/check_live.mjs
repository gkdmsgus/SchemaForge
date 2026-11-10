// A deployed server (or the deploy image run locally), driven in a browser like a visitor:
// P1 /health reports KiCad, P2 a demo board is built, P3 KiCad's 3D model loads, P4 the gerber zip downloads,
// P5-P6 a visitor without an account is told why AI 다듬기 and the AI editor are refused (P6 after closing the login
// window P5 opened, as a visitor does; the board is still
// built), P7 no page errors, P8 the home page fetches neither the 3D viewer nor the PDF code, and its entry file stays
// small (they were all in one 1,837 kB file, for visitors who never make a board: review of 2026-11-06), P9 the PDF button
// still gives a PDF, P10 no Content-Security-Policy violation while the home page, the demo board, the 3D viewer, the PDF
// and the web fonts load (the site's CSP is set by Caddy in front of it: a source it leaves out blocks that file with
// only a console line, which P7 never saw). Needs the playwright package (in package.json) and its Chromium.
// Usage: node scripts/check_live.mjs [BASE]   (default https://schemaforge-app.duckdns.org, the Jetson; the old Render address works too; DEMO=motor, SHOT=board.png)
import fs from 'node:fs'
import { chromium } from 'playwright'

const BASE = (process.argv[2] || process.env.BASE || 'https://schemaforge-app.duckdns.org').replace(/\/$/, '')
const DEMO = process.env.DEMO || 'motor'
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))
const glb = []
page.on('response', r => { if (r.url().includes('/board_model')) glb.push(r) })
// P10: both the console line and the page's own securitypolicyviolation event, as browsers word the line differently
const csp = []
const watchCsp = async p => {
  p.on('console', m => { if (/Content[- ]Security[- ]Policy/i.test(m.text())) csp.push(`console: ${m.text().slice(0, 200)}`) })
  await p.exposeBinding('__sfCsp', (_source, v) => { csp.push(`event: ${v}`) })
  await p.addInitScript(() => window.addEventListener('securitypolicyviolation', e => window.__sfCsp(
    `${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} in ${(e.sourceFile || location.href).split('/').pop()}:${e.lineNumber}`), true))
}
await watchCsp(page)

try {
  // a free instance may be asleep: the first answer can take a minute or more
  const health = await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(180000) })).json()
  check('P1 health: KiCad on the server', !!health.kicad, JSON.stringify(health))

  // P8: first, so the requests are the home page's alone
  const home = await browser.newPage()
  await watchCsp(home)
  const scripts = []
  home.on('response', r => { if (/\/assets\/.*\.js$/.test(r.url())) scripts.push(r) })
  await home.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  const fetched = scripts.map(r => r.url().split('/').pop())
  const entry = scripts.find(r => /^index-/.test(r.url().split('/').pop()))
  const entryKb = entry ? Math.round((await entry.body()).length / 1024) : 0
  await home.close()
  check('P8 the home page fetches neither the 3D viewer nor the PDF code, its entry stays small',
    !!entry && !fetched.some(n => /KiCad3DViewer|jspdf|html2canvas/i.test(n)) && entryKb < 800, `${fetched.join(', ')}; entry ${entryKb} KiB`)

  await page.goto(`${BASE}/?demo=${DEMO}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /PCB 생성/ }).first().click({ timeout: 60000 })
  const t0 = Date.now()
  await page.getByRole('button', { name: /\.kicad_pcb/ }).waitFor({ timeout: 300000 })
  check('P2 demo board built', true, `${Math.round((Date.now() - t0) / 1000)} s`)

  await page.getByTestId('view-tab-assembly').click()
  await page.waitForSelector('[data-testid="assembly-3d"] [data-testid="kicad-3d"]:is([data-state="ready"],[data-state="error"])', { timeout: 200000 })
  const state = await page.locator('[data-testid="assembly-3d"] [data-testid="kicad-3d"]').getAttribute('data-state')
  const g = glb.at(-1)
  const bytes = g ? (await g.body().catch(() => Buffer.alloc(0))).length : 0
  check('P3 3D model loads', state === 'ready' && g?.status() === 200, `state=${state} glb=${g?.status()} ${bytes} bytes`)

  await page.getByRole('button', { name: /^거버$/ }).click()
  await page.getByTestId('gerber-zip').waitFor({ timeout: 120000 })
  // P4: the zip a PCB maker takes (named in the zip's directory: the copper layer and the split drill files)
  const href = await page.getByTestId('gerber-zip').getAttribute('href', { timeout: 10000 }).catch(() => null)
  const file = href ? await fetch(BASE + href) : null
  const body = file ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0)
  const names = body.toString('latin1')
  check('P4 gerber zip downloads', !!file && file.status === 200 && body.subarray(0, 2).toString('latin1') === 'PK'
    && ['-F_Cu.gtl', '-Edge_Cuts.gm1', '-PTH.drl', '-NPTH.drl'].every(s => names.includes(s)), `${href} ${file?.status} ${body.length} bytes`)

  // P9: before the AI refusals, whose login window covers the button
  const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('button', { name: 'PDF', exact: true }).click()])
  const pdfHead = fs.readFileSync(await pdf.path()).subarray(0, 4).toString('latin1')
  check('P9 the PDF button gives a PDF', pdfHead === '%PDF', `${pdf.suggestedFilename()} starts ${JSON.stringify(pdfHead)}`)
  // the web fonts the page drew with (index.html asks Google Fonts for three families)
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready
    return [...new Set([...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/["']/g, '')))]
  })

  await page.getByRole('button', { name: /AI 다듬기 OFF/ }).click()
  await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().click()
  await page.getByRole('button', { name: /\.kicad_pcb/ }).waitFor({ timeout: 300000 })
  const note = await page.getByTestId('ai-note').getAttribute('title').catch(() => null)
  check('P5 AI 다듬기 refused with a reason, board built anyway', !!note && /허용된 계정/.test(note), note ?? 'no note')

  // the refusal also opens the login window, a modal <dialog> since 2026-11-08: the page behind it is inert, so a message
  // typed there was never sent and P6 failed on all four demos. A visitor closes it first; so does this check
  const login = page.locator('dialog[open]')
  if (await login.count()) { await page.keyboard.press('Escape'); await login.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {}) }
  const box = page.getByTestId('chat-input')
  if (await login.count()) check('P6 AI editor refusal shown', false, 'the login window P5 opened does not close with Escape')
  else if (await box.count()) {
    await box.fill('R1을 470으로 바꿔줘'); await box.press('Enter')
    await page.waitForTimeout(2000)
    const bubble = await page.getByText(/허용된 계정으로 로그인/).first().innerText().catch(() => '')
    check('P6 AI editor refusal shown', /데모/.test(bubble), bubble.slice(0, 120))
  } else check('P6 AI editor refusal shown', false, 'no chat box')

  check('P7 no page errors', errors.length === 0, errors.join(' | ').slice(0, 300))
  check('P10 no CSP violation while the board, the 3D viewer, the PDF and the fonts load', csp.length === 0 && fonts.length > 0,
    `${csp.length} violations${csp.length ? ': ' + [...new Set(csp)].join(' | ').slice(0, 600) : ''}; fonts loaded: ${fonts.join(', ') || 'none'}`)
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
} catch (e) { failed++; console.log('FAIL crashed: ' + e.message) } finally { await browser.close() }
process.exit(failed ? 1 : 0)
