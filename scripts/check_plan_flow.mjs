// Browser checks for the design plan step, with the login and the API faked by page.route: P1 "이 계획으로 회로
// 만들기" sends the approved plan with the generation (it was shown and approved but never sent, so a 12 V LM7812
// plan came out as a 5 V LM7805: frame review of the tour, 2026-10-30), P2 ↺ of the same description sends it again,
// P3 the generation screen opens at its top when the plan was approved further down the page (it opened scrolled down,
// "회로 만드는 중" out of view: 2026-11-03 tour takes 1 and 3, S28).
// Needs the vite dev server (npm run dev) and the demo route of its API.
// Usage: node scripts/check_plan_flow.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

const demo = await fetch(`${BASE}/demo_result/led`).then(r => r.json())
const PLAN = {
  title: '12V 전원', summary: 'AC 입력을 12V로 만드는 선형 전원', topology: '선형',
  specs: [{ label: '출력 전압', value: '12V' }, { label: '출력 전류', value: '1A' }],
  parts: [{ ref: 'U1', type: '전압 조정기', value: 'LM7812', role: '12V 출력' }, { ref: 'R1', type: '저항', value: '1kΩ', role: 'LED 전류 제한' }],
  risks: ['조정기 발열'],
}
const sent = []
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
const done = route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(demo)}\n\n` })
/** the login, the history and the plan faked; the generation answered by onGenerate */
async function fake(page, onGenerate) {
  await page.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
  await page.route(/\/(favorites|sessions)(\/.*)?$/, r => json(r, { favorites: [], sessions: [], messages: [], id: 's1' }))
  await page.route(/\/plan$/, r => json(r, PLAN))
  await page.route(/\/generate$/, onGenerate)
}
async function toPlan(page, description) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('.sf-home-input textarea').fill(description)
  await page.getByRole('button', { name: '회로 만들기', exact: true }).click()
  await page.getByRole('button', { name: '이 계획으로 회로 만들기' }).waitFor({ timeout: 15000 })
}

const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await ctx.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
    localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: true }))
  })
  const page = await ctx.newPage()
  await fake(page, r => { sent.push(r.request().postDataJSON()); return done(r) })

  await toPlan(page, '전원 회로 만들어줘 12V로')
  await page.getByRole('button', { name: '이 계획으로 회로 만들기' }).click()
  await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 20000 })
  const parts = p => (p?.plan?.parts || []).map(x => x.value).join(',')
  check('P1 the approved plan goes with the generation', parts(sent[0]) === 'LM7812,1kΩ' && sent[0]?.plan?.specs?.[0]?.value === '12V',
    `plan sent: ${JSON.stringify(sent[0]?.plan ?? null).slice(0, 120)}`)

  await page.locator("button[title='재생성 (저장된 결과 대신 새로 생성)']").click()
  await page.getByRole('button', { name: 'v2', exact: true }).waitFor({ timeout: 20000 })
  check('P2 ↺ of the same description sends the same plan', sent.length === 2 && parts(sent[1]) === 'LM7812,1kΩ', `${sent.length} generations, ${parts(sent[1])}`)

  // P3: a short window, so the plan page scrolls; the generation held open while the steps screen is measured.
  // Another description: the one above is saved now, and would be offered instead of a plan
  const held = await ctx.newPage()
  await held.setViewportSize({ width: 1280, height: 420 })
  let answer
  const answered = new Promise(r => { answer = r })
  await fake(held, async r => { await answered; return done(r) })
  await toPlan(held, '전원 회로 만들어줘 5V로')
  await held.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const before = await held.evaluate(() => Math.round(window.scrollY))
  await held.getByRole('button', { name: '이 계획으로 회로 만들기' }).click()
  await held.getByText(/^회로 만드는 중 · /).waitFor({ timeout: 10000 })
  await held.waitForTimeout(300)
  const after = await held.evaluate(() => Math.round(window.scrollY))
  // the steps screen must be long enough to keep a scroll, or a stale one would be clamped to 0 and pass unseen
  const room = await held.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
  check('P3 the generation screen opens at its top after a plan approved further down', before > 0 && after === 0 && room > 0,
    `plan page at ${before} px, generation screen at ${after} px (it scrolls ${room} px)`)
  answer()
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
