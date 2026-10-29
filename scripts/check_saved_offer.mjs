// Browser checks for the "이 회로의 저장된 결과가 있어요" offer, with the login and the API faked by page.route:
// O1 asked from the circuit-type panel further down the page, the offer comes into view (it sat at the top of the
// page, out of view, and the make button seemed to do nothing: tour take 4, 2026-10-29), O2 불러오기 opens the
// saved circuit without asking the server for a plan or a circuit again.
// Needs the vite dev server (npm run dev) and the demo route of its API.
// Usage: node scripts/check_saved_offer.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

const demo = await fetch(`${BASE}/demo_result/led`).then(r => r.json())
const asked = []

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
  })
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
  await page.route(/\/(favorites|sessions)$/, r => json(r, { favorites: [], sessions: [] }))
  // the first run only tells which description the panel sends: refused, so nothing is generated
  await page.route(/\/(plan|generate)$/, r => { asked.push(r.request().postDataJSON()?.description); return json(r, { error: 'check' }, 403) })

  const makeFromPanel = async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '회로 종류로 시작하기' }).scrollIntoViewIfNeeded()
    await page.locator('button[role=listitem].sf-type-row', { hasText: 'LED 제어' }).click()
    const panel = page.locator('.sf-spec-panel')
    await panel.getByRole('button', { name: /점멸/ }).first().click()
    await panel.getByRole('button', { name: '3', exact: true }).first().click()
    await panel.getByRole('button', { name: '5V', exact: true }).first().click()
    await page.getByText('필수 항목을 모두 골랐습니다.').waitFor({ timeout: 5000 })
    // the panel is still settling after the chips: a click at once landed on the section around the button
    const make = page.getByRole('button', { name: 'LED 제어 만들기' }).last()
    await page.waitForTimeout(600)
    await make.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await make.click()
  }

  await makeFromPanel()
  await page.waitForTimeout(800)
  const prompt = asked[0]
  if (!prompt) throw new Error('the panel sent no description to /plan or /generate')
  await page.evaluate(([p, result]) => localStorage.setItem('sf_saved_results',
    JSON.stringify([{ id: 1, name: p.slice(0, 40), prompt: p, result, time: Date.now() }])), [prompt, demo])
  asked.length = 0

  // O1
  await makeFromPanel()
  // found by its sentence, so the check also runs against a build from before the fix
  const offer = page.getByText('이 회로의 저장된 결과가 있어요')
  await offer.waitFor({ timeout: 5000 })
  await page.waitForTimeout(900)   // smooth scroll
  const box = await offer.boundingBox()
  check('O1 the saved-result offer is in view after the make button of the circuit-type panel',
    !!box && box.y >= 0 && box.y + box.height <= 720, box ? `offer y ${Math.round(box.y)}..${Math.round(box.y + box.height)}` : 'no box')

  // O2
  await page.getByRole('button', { name: '불러오기', exact: true }).click()
  const opened = await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 10000 }).then(() => true, () => false)
  check('O2 불러오기 opens the saved circuit without a new plan or generation', opened && asked.length === 0, `requests ${asked.length}`)
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
