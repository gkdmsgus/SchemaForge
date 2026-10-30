// Browser checks for result versions, with the login and the API faked by page.route (generation answers with
// two demo circuits in turn): V1 ↺ makes a second version and v1/v2 switch the circuit on screen, V2 after v1 is
// applied, the saved result of the same description opens v1 (it opened the v2 just dropped: frame review of the
// tour, 2026-10-30).
// Needs the vite dev server (npm run dev) and the demo route of its API.
// Usage: node scripts/check_versions.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

const answers = [await fetch(`${BASE}/demo_result/led`).then(r => r.json()), await fetch(`${BASE}/demo_result/motor`).then(r => r.json())]
answers[0].filename = 'version-one.net'
answers[1].filename = 'version-two.net'
let made = 0
const PROMPT = '9V로 LED 하나 켜는 회로 만들어줘'

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
    // straight to generation: no questions, no plan
    if (!localStorage.getItem('sf_settings')) localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: false }))
  })
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
  await page.route(/\/(favorites|sessions)(\/.*)?$/, r => json(r, { favorites: [], sessions: [], messages: [], id: 's1' }))
  await page.route(/\/generate$/, r => {
    const d = answers[made++ % 2]
    return r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: status\ndata: 회로를 만들고 있습니다\n\nevent: done\ndata: ${JSON.stringify(d)}\n\n` })
  })
  const shown = () => page.locator('body').innerText().then(t => (t.match(/version-(one|two)\.net/) || [''])[0])

  await page.goto(BASE, { waitUntil: 'networkidle' })
  const input = page.locator('.sf-home-input textarea')
  await input.fill(PROMPT)
  await page.getByRole('button', { name: '회로 만들기', exact: true }).click()
  await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 20000 })

  // V1
  const first = await shown()
  await page.locator("button[title='재생성 (저장된 결과 대신 새로 생성)']").click()
  await page.getByRole('button', { name: 'v2', exact: true }).waitFor({ timeout: 20000 })
  const second = await shown()
  await page.getByRole('button', { name: 'v1', exact: true }).click()
  await page.waitForTimeout(400)
  const back = await shown()
  check('V1 ↺ makes v2, and v1 brings the first circuit back', first === 'version-one.net' && second === 'version-two.net' && back === 'version-one.net', `${first} → ${second} → ${back}`)

  // V2
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await page.waitForTimeout(400)
  await page.getByText(/^v0\.4 · /).first().click()
  await input.waitFor({ timeout: 10000 })
  await input.fill(PROMPT)
  await page.getByRole('button', { name: '회로 만들기', exact: true }).click()
  await page.getByText('이 회로의 저장된 결과가 있어요').waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: '불러오기', exact: true }).click()
  await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 10000 })
  const opened = await shown()
  check('V2 after v1 is applied, the saved result opens v1', opened === 'version-one.net' && made === 2, `opened ${opened}, generations ${made}`)
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
