// Browser checks for the design plan step, with the login and the API faked by page.route: P1 "이 계획으로 회로
// 만들기" sends the approved plan with the generation (it was shown and approved but never sent, so a 12 V LM7812
// plan came out as a 5 V LM7805: frame review of the tour, 2026-10-30), P2 ↺ of the same description sends it again,
// P3 the generation screen opens at its top when the plan was approved further down the page (it opened scrolled down,
// "회로 만드는 중" out of view: 2026-11-03 tour takes 1 and 3, S28), P4 a stream cut off inside its done frame says the
// connection was lost (it went back to the home screen with no word, the model already paid for: review of 2026-11-06),
// P5-P7 a cancelled plan request stays cancelled, whether its stop comes in time or not: its late plan does not come back
// over the home screen, its failure does not start a generation (the plan is optional, so a failed one generates), and
// its plan does not replace the steps of a later generation, whose 취소 still stops it (review of 2026-11-06).
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

  // P4
  const cut = await ctx.newPage()
  await fake(cut, r => r.fulfill({ status: 200, contentType: 'text/event-stream',
    body: 'event: status\ndata: 회로를 만들고 있습니다\n\nevent: done\ndata: {"code":"from skidl imp' }))
  await toPlan(cut, '전원 회로 만들어줘 9V로')
  await cut.getByRole('button', { name: '이 계획으로 회로 만들기' }).click()
  const lost = await cut.getByText('회로 생성 중 연결이 끊겼습니다').waitFor({ timeout: 10000 }).then(() => true, () => false)
  check('P4 a stream cut off inside its done frame says the connection was lost', lost, lost ? '' : 'no word on screen')

  // P5-P7: the first description's plan waits; with abort doing nothing too, so the sequence number is tested on its own
  const lateCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await lateCtx.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
    localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: true }))
    AbortController.prototype.abort = function () {}
  })
  const home = p => p.locator('.sf-home-input textarea')
  const approve = p => p.getByRole('button', { name: '이 계획으로 회로 만들기' })
  const shows = l => l.isVisible().catch(() => false)
  const submit = async (p, description) => {
    await home(p).fill(description)
    await p.getByRole('button', { name: '회로 만들기', exact: true }).click()
  }
  const holding = async (c, late, onGenerate = done) => {
    const p = await c.newPage()
    const held = { generations: 0, stopped: 0, release: () => {} }
    const released = new Promise(r => { held.release = r })
    p.on('requestfailed', r => { if (/\/(plan|generate)$/.test(r.url())) held.stopped++ })
    await fake(p, r => { held.generations++; return onGenerate(r) })
    await p.route(/\/plan$/, async r => {
      if (!/늦는/.test(r.request().postDataJSON()?.description)) return json(r, PLAN)
      await released
      await late(r).catch(() => {})
    })
    await p.goto(BASE, { waitUntil: 'networkidle' })
    return { p, held }
  }
  const cancelPlan = async p => {
    await p.getByText('부품과 회로 구성을 정리하고 있습니다').waitFor({ timeout: 10000 })
    await p.getByRole('button', { name: '취소', exact: true }).click()
    await home(p).waitFor({ timeout: 5000 })
  }
  for (const [c, how] of [[ctx, 'stopped'], [lateCtx, 'stop too late']]) {
    const p5 = await holding(c, r => json(r, PLAN))
    await submit(p5.p, '늦는 계획의 전원 회로 5')
    await cancelPlan(p5.p)
    p5.held.release()
    await p5.p.waitForTimeout(500)
    check(`P5 a cancelled plan does not come back over the home screen (${how})`, await shows(home(p5.p)) && !(await shows(approve(p5.p)))
      && p5.held.stopped === (c === ctx ? 1 : 0), `${p5.held.stopped} requests stopped`)

    const p6 = await holding(c, r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"check"}' }))
    await submit(p6.p, '늦는 계획의 전원 회로 6')
    await cancelPlan(p6.p)
    p6.held.release()
    await p6.p.waitForTimeout(500)
    check(`P6 a cancelled plan's failure starts no generation (${how})`, await shows(home(p6.p)) && p6.held.generations === 0, `${p6.held.generations} generations`)

    let answer7
    const answered7 = new Promise(r => { answer7 = r })
    const p7 = await holding(c, r => json(r, PLAN), async r => { await answered7; await done(r).catch(() => {}) })
    await submit(p7.p, '늦는 계획의 전원 회로 7')
    await cancelPlan(p7.p)
    await submit(p7.p, '다른 설명의 전원 회로')
    await approve(p7.p).click({ timeout: 10000 })
    await p7.p.getByText(/^회로 만드는 중 · /).waitFor({ timeout: 10000 })
    p7.held.release()
    await p7.p.waitForTimeout(500)
    const steps = await shows(p7.p.getByText(/^회로 만드는 중 · /)), over = await shows(approve(p7.p))
    if (steps) await p7.p.getByRole('button', { name: '취소', exact: true }).click()
    answer7()
    await p7.p.waitForTimeout(500)
    check(`P7 an old plan leaves a later generation's steps alone, and 취소 stops that generation (${how})`,
      steps && !over && await shows(home(p7.p)) && !(await shows(p7.p.getByRole('button', { name: /PCB (다시 )?생성/ }).first())),
      `steps ${steps}, plan over them ${over}`)
  }
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
