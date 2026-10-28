// Browser checks for the history drawer of a logged-in user, with the login and the API faked by page.route:
// R1 the ✎ button opens the name field inside the open drawer and does not open the circuit, R2 Enter sends
// PATCH /sessions/:id with the new name and the list shows it, R3 Escape keeps the old name and sends nothing,
// R4 a click on the item opens the circuit and closes the drawer, R5 a favourite has no ✎.
// (Before R1 the name was renamed by double-click, whose first click already opened the circuit and slid the
// drawer out with the name field in it.) Needs the vite dev server (npm run dev) and the demo route of its API.
// Usage: node scripts/check_drawer.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

const demo = await fetch(`${BASE}/demo_result/led`).then(r => r.json())
const session = { id: '11111111-1111-1111-1111-111111111111', prompt: '전원 회로 만들어줘', name: null, graph: demo.graph,
  filename: demo.filename || 'demo.net', code: null, guide: null, created_at: new Date().toISOString() }
const patches = []

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
  })
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
  await page.route(/\/favorites$/, r => json(r, { favorites: [{ id: 'f1', session_id: session.id, created_at: session.created_at,
    sessions: { prompt: session.prompt, graph: session.graph, filename: session.filename } }] }))
  await page.route(/\/sessions\/[^/]+\/messages$/, r => json(r, { messages: [] }))
  await page.route(/\/sessions\/[^/]+$/, r => {
    if (r.request().method() === 'PATCH') { patches.push(r.request().postDataJSON()); session.name = patches.at(-1).name ?? session.name }
    return json(r, { ok: true })
  })
  await page.route(/\/sessions$/, r => json(r, { sessions: [session] }))

  const drawerLeft = () => page.evaluate(() => [...document.querySelectorAll('div')].find(d => d.style.width === '280px')?.getBoundingClientRect().left)
  const circuitOpen = () => page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().isVisible().catch(() => false)
  const openDrawer = async () => { await page.locator("button[aria-label='메뉴']").click(); await page.waitForTimeout(400) }
  const field = page.locator("input[aria-label='기록 이름']")
  const pen = page.getByRole('button', { name: '이름 바꾸기' })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await openDrawer()
  await page.getByText(session.prompt).first().waitFor({ timeout: 10000 })

  // R1
  await page.getByText(session.prompt).first().hover()
  await pen.first().click()
  await page.waitForTimeout(400)
  check('R1 ✎ opens the name field in the open drawer, the circuit stays closed',
    await field.isVisible() && (await drawerLeft()) === 0 && !(await circuitOpen()), `drawer left ${await drawerLeft()}`)

  // R2
  await field.fill('전원 회로 데모')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  check('R2 Enter sends PATCH with the new name and the list shows it',
    patches.length === 1 && patches[0].name === '전원 회로 데모' && await page.getByText('전원 회로 데모').first().isVisible(), JSON.stringify(patches))

  // R3
  await page.getByText('전원 회로 데모').first().hover()
  await pen.first().click()
  await field.fill('바뀌면 안 되는 이름')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check('R3 Escape keeps the old name and sends nothing',
    patches.length === 1 && await page.getByText('전원 회로 데모').first().isVisible() && !(await field.isVisible()))

  // R4
  await page.getByText('전원 회로 데모').first().click()
  await page.waitForTimeout(800)
  check('R4 a click on the item opens the circuit and closes the drawer', await circuitOpen() && (await drawerLeft()) < 0, `drawer left ${await drawerLeft()}`)

  // R5
  await openDrawer()
  await page.getByRole('button', { name: '⭐ 즐겨찾기' }).click()
  await page.waitForTimeout(500)
  check('R5 a favourite has no ✎', await page.getByText(/전원 회로/).first().isVisible() && await pen.count() === 0, `✎ ${await pen.count()}`)
} catch (e) {
  failed++
  console.log('FAIL stopped: ' + String(e?.message || e).split('\n')[0])
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} FAIL` : '\nall ok')
process.exitCode = failed ? 1 : 0
