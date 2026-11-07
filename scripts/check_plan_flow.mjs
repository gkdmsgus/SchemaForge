// Browser checks for the design plan step, with the login and the API faked by page.route: P1 "이 계획으로 회로
// 만들기" sends the approved plan with the generation (it was shown and approved but never sent, so a 12 V LM7812
// plan came out as a 5 V LM7805: frame review of the tour, 2026-10-30), P2 ↺ of the same description sends it again,
// P3 the generation screen opens at its top when the plan was approved further down the page (it opened scrolled down,
// "회로 만드는 중" out of view: 2026-11-03 tour takes 1 and 3, S28), P4 a stream cut off inside its done frame says the
// connection was lost (it went back to the home screen with no word, the model already paid for: review of 2026-11-06),
// P5-P7 a cancelled plan request stays cancelled, whether its stop comes in time or not: its late plan does not come back
// over the home screen, its failure does not start a generation (the plan is optional, so a failed one generates), and
// its plan does not replace the steps of a later generation, whose 취소 still stops it (review of 2026-11-06),
// P8 while /clarify is asked the screen says so with a 취소, and a double click asks once (the form stayed as it was, so
// a second click sent the questions and the plan again, four model calls), P9 that 취소 stops the steps and leaves the form
// as typed, P10 two clicks that reach the generation leave one running, which 취소 stops (the first ran on unseen and its
// result came up after the cancel: review of 2026-11-06), P11 an offer of a saved result goes when another description is
// asked about (under the questions step its 불러오기 opened the saved circuit and the steps ran on, and that generation then
// took the screen; its 새로 생성 did nothing), P12 a generation stopped too late for its failure (500, 403, 401) says nothing
// and asks for no login, on the home screen the person went back to, P13 with no questions step (a circuit type picked,
// or the questions off) a double click asks for one plan (the second one aborted the first, whose model call ran on),
// P14-P15 a plan or questions the model did not answer (504) say so in the error box and stop the steps, and 재시도 makes
// that circuit, while any other plan failure still generates without it (the plan's 504 was dropped and the same model
// asked again: about 5.5 minutes of a spinner, then an English error, review of 2026-11-07).
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

  // P8-P10: two clicks in one go, so the second lands before the screen has changed
  const makeTwice = p => p.evaluate(() => {
    const make = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '회로 만들기')
    make.click()
    make.click()
  })
  const settled = (settings, stopped) => async c => {
    const p = await c.newPage()
    await p.addInitScript(s => localStorage.setItem('sf_settings', JSON.stringify(s)), settings)
    const held = { asked: 0, plans: 0, generations: 0, stopped: 0, release: () => {} }
    const released = new Promise(r => { held.release = r })
    p.on('requestfailed', r => { if (stopped.test(r.url())) held.stopped++ })
    await fake(p, async r => { held.generations++; await released; await done(r).catch(() => {}) })
    await p.route(/\/plan$/, r => { held.plans++; return json(r, PLAN) })
    await p.route(/\/clarify$/, async r => { held.asked++; await released; await json(r, { clear: true }).catch(() => {}) })
    await p.goto(BASE, { waitUntil: 'networkidle' })
    return { p, held }
  }
  const asking = settled({ clarify: true, plan: true }, /\/clarify$/)
  const p8 = await asking(ctx)
  await home(p8.p).fill('질문을 기다리는 전원 회로')
  await makeTwice(p8.p)
  const says = await p8.p.getByText('확인 중').first().waitFor({ timeout: 5000 }).then(() => true, () => false)
  const cancelShown = await shows(p8.p.getByRole('button', { name: '취소', exact: true }))
  await p8.p.waitForTimeout(300)
  p8.held.release()
  const planCame = await approve(p8.p).waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('P8 while the questions are asked the screen says so with a 취소, and a double click asks once',
    says && cancelShown && planCame && p8.held.asked === 1 && p8.held.plans === 1, `says ${says}, 취소 ${cancelShown}, /clarify ${p8.held.asked}, /plan ${p8.held.plans}`)

  for (const [c, how] of [[ctx, 'stopped'], [lateCtx, 'stop too late']]) {
    const p9 = await asking(c)
    await home(p9.p).fill('질문을 취소하는 전원 회로')
    await p9.p.getByRole('button', { name: '회로 만들기', exact: true }).click()
    await p9.p.getByText('확인 중').first().waitFor({ timeout: 5000 }).catch(() => {})
    await p9.p.getByRole('button', { name: '취소', exact: true }).click({ timeout: 2000 }).catch(() => {})
    await p9.p.waitForTimeout(300)
    const typed = await home(p9.p).inputValue().catch(() => '')
    p9.held.release()
    await p9.p.waitForTimeout(500)
    const noSteps = p9.held.plans === 0 && !(await shows(approve(p9.p))) && await shows(home(p9.p))
    await p9.p.getByRole('button', { name: '회로 만들기', exact: true }).click({ timeout: 2000 }).catch(() => {})
    const again = await approve(p9.p).waitFor({ timeout: 5000 }).then(() => true, () => false)
    check(`P9 취소 while the questions are asked stops the steps and leaves the form as typed (${how})`,
      noSteps && typed === '질문을 취소하는 전원 회로' && again && p9.held.stopped === (c === ctx ? 1 : 0),
      `form "${typed}", no steps ${noSteps}, can ask again ${again}, ${p9.held.stopped} requests stopped`)

    const p10 = await settled({ clarify: false, plan: false }, /\/generate$/)(c)
    await home(p10.p).fill('두 번 눌린 전원 회로')
    await makeTwice(p10.p)
    await p10.p.getByText(/^회로 만드는 중 · /).waitFor({ timeout: 5000 })
    await p10.p.waitForTimeout(300)
    await p10.p.getByRole('button', { name: '취소', exact: true }).click()
    p10.held.release()
    await p10.p.waitForTimeout(600)
    const backHome = await shows(home(p10.p)), popped = await shows(p10.p.getByRole('button', { name: /PCB (다시 )?생성/ }).first())
    check(`P10 of two generations one stays, and 취소 leaves none to come up later (${how})`,
      backHome && !popped && p10.held.stopped === (c === ctx ? 2 : 0), `${p10.held.generations} sent, ${p10.held.stopped} stopped, home ${backHome}, result came up ${popped}`)
  }

  // P11: the first description has a saved result, so its offer is up; the second one is being asked about
  const p11 = await settled({ clarify: true, plan: false }, /\/clarify$/)(ctx)
  await p11.p.evaluate(result => localStorage.setItem('sf_saved_results', JSON.stringify([{ id: 1, name: 'a', prompt: '저장된 전원 회로', result, time: Date.now() }])), demo)
  await home(p11.p).fill('저장된 전원 회로')
  await p11.p.getByRole('button', { name: '회로 만들기', exact: true }).click()
  const open11 = p11.p.getByRole('button', { name: '불러오기', exact: true })
  await open11.waitFor({ timeout: 5000 })
  await home(p11.p).fill('다른 설명의 전원 회로')
  await p11.p.getByRole('button', { name: '회로 만들기', exact: true }).click()
  await p11.p.getByTestId('preparing').waitFor({ timeout: 5000 })
  const offerStays = await shows(open11)
  check('P11 an offer of a saved result goes when another description is asked about', !offerStays, `offer under the questions step ${offerStays}`)
  p11.held.release()

  // P12: the stop does nothing, as when it comes while the refused answer's body is being read
  for (const [status, body] of [[500, { error: 'check' }], [403, { error: 'check' }], [401, { error: 'check', code: 'login_required' }]]) {
    let answer12
    const answered12 = new Promise(r => { answer12 = r })
    const p12 = await holding(lateCtx, r => json(r, PLAN), async r => {
      await answered12
      await r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {})
    })
    await p12.p.addInitScript(() => localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: false })))
    await p12.p.goto(BASE, { waitUntil: 'networkidle' })
    await submit(p12.p, '늦게 거절되는 전원 회로')
    await p12.p.getByText(/^회로 만드는 중 · /).waitFor({ timeout: 10000 })
    await p12.p.getByRole('button', { name: '취소', exact: true }).click()
    await home(p12.p).waitFor({ timeout: 5000 })
    answer12()
    await p12.p.waitForTimeout(500)
    const box = await shows(p12.p.getByText(/check|서버 오류/).first()), login = await shows(p12.p.locator('input[type=password]').first())
    check(`P12 a generation stopped too late for its ${status} says nothing on the home screen`, !box && !login && await shows(home(p12.p)), `error box ${box}, login ${login}`)
  }

  // P13
  const p13 = await settled({ clarify: false, plan: true }, /\/plan$/)(ctx)
  await home(p13.p).fill('두 번 눌린 계획의 전원 회로')
  await makeTwice(p13.p)
  const came13 = await approve(p13.p).waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('P13 with no questions step a double click asks for one plan', came13 && p13.held.plans === 1 && p13.held.stopped === 0, `/plan ${p13.held.plans}, stopped ${p13.held.stopped}, plan shown ${came13}`)

  // P14-P15: the model fails on the plan or on the questions, as the server says it (model.ts modelFailure)
  const SILENT = 'AI 모델이 응답하지 않습니다. 잠시 뒤에 다시 시도해 주세요.'
  const failing = async (settings, route, status) => {
    const p = await ctx.newPage()
    await p.addInitScript(s => localStorage.setItem('sf_settings', JSON.stringify(s)), settings)
    const held = { generations: [], plans: 0 }
    await fake(p, r => { held.generations.push(r.request().postDataJSON()?.description); return done(r) })
    await p.route(/\/plan$/, r => { held.plans++; return route === 'plan' ? r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: status === 500 ? 'plan parse failed' : SILENT }) }) : json(r, PLAN) })
    await p.route(/\/clarify$/, r => (route === 'clarify' ? r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: SILENT }) }) : json(r, { clear: true })))
    await p.goto(BASE, { waitUntil: 'networkidle' })
    return { p, held }
  }
  const p14 = await failing({ clarify: false, plan: true }, 'plan', 504)
  await submit(p14.p, '모델이 멈춘 계획의 전원 회로')
  const said14 = await p14.p.getByText(SILENT).waitFor({ timeout: 10000 }).then(() => true, () => false)
  await p14.p.waitForTimeout(500)
  const sentBefore = p14.held.generations.length
  await p14.p.getByRole('button', { name: '재시도', exact: true }).click({ timeout: 3000 }).catch(() => {})
  await p14.p.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 10000 }).catch(() => {})
  check('P14 a plan the model did not answer (504) is said in the error box and starts no generation; 재시도 makes that circuit',
    said14 && sentBefore === 0 && p14.held.generations[0] === '모델이 멈춘 계획의 전원 회로',
    `said ${said14}, generations before 재시도 ${sentBefore}, after: ${JSON.stringify(p14.held.generations)}`)
  const p14b = await failing({ clarify: false, plan: true }, 'plan', 500)
  await submit(p14b.p, '계획을 읽지 못한 전원 회로')
  const went14 = await p14b.p.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 10000 }).then(() => true, () => false)
  check('P14b any other plan failure (500) still generates without the plan', went14 && p14b.held.generations.length === 1, `${p14b.held.generations.length} generations`)

  const p15 = await failing({ clarify: true, plan: true }, 'clarify', 504)
  await submit(p15.p, '모델이 멈춘 질문의 전원 회로')
  const said15 = await p15.p.getByText(SILENT).waitFor({ timeout: 10000 }).then(() => true, () => false)
  await p15.p.waitForTimeout(500)
  check('P15 questions the model did not answer (504) are said in the error box, with no plan or generation after them',
    said15 && p15.held.plans === 0 && p15.held.generations.length === 0, `said ${said15}, /plan ${p15.held.plans}, generations ${p15.held.generations.length}`)
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
