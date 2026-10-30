// Browser checks for the design plan step, with the login and the API faked by page.route: P1 "이 계획으로 회로
// 만들기" sends the approved plan with the generation (it was shown and approved but never sent, so a 12 V LM7812
// plan came out as a 5 V LM7805: frame review of the tour, 2026-10-30), P2 ↺ of the same description sends it again.
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

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
    localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: true }))
  })
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
  await page.route(/\/(favorites|sessions)(\/.*)?$/, r => json(r, { favorites: [], sessions: [], messages: [], id: 's1' }))
  await page.route(/\/plan$/, r => json(r, PLAN))
  await page.route(/\/generate$/, r => {
    sent.push(r.request().postDataJSON())
    return r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(demo)}\n\n` })
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('.sf-home-input textarea').fill('전원 회로 만들어줘 12V로')
  await page.getByRole('button', { name: '회로 만들기', exact: true }).click()
  await page.getByRole('button', { name: '이 계획으로 회로 만들기' }).click({ timeout: 15000 })
  await page.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 20000 })
  const parts = p => (p?.plan?.parts || []).map(x => x.value).join(',')
  check('P1 the approved plan goes with the generation', parts(sent[0]) === 'LM7812,1kΩ' && sent[0]?.plan?.specs?.[0]?.value === '12V',
    `plan sent: ${JSON.stringify(sent[0]?.plan ?? null).slice(0, 120)}`)

  await page.locator("button[title='재생성 (저장된 결과 대신 새로 생성)']").click()
  await page.getByRole('button', { name: 'v2', exact: true }).waitFor({ timeout: 20000 })
  check('P2 ↺ of the same description sends the same plan', sent.length === 2 && parts(sent[1]) === 'LM7812,1kΩ', `${sent.length} generations, ${parts(sent[1])}`)
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
