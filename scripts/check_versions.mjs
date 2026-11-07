// Browser checks for result versions, with the login and the API faked by page.route (generation answers with
// two demo circuits in turn): V1 ↺ makes a second version and v1/v2 switch the circuit on screen, V2 after v1 is
// applied, the saved result of the same description opens v1 (it opened the v2 just dropped: frame review of the
// tour, 2026-10-30), V3 a circuit opened from the history during a generation stops it and stays, and a PCB request
// is that circuit under its own name (the generation's answer took the screen back: the opened circuit's parts went to
// the PCB under the generation's file name, review of 2026-11-06), V4 with the stop not reaching the stream in time,
// its late answer is only kept for later, V5 the logo during a generation stops it and goes home for good, V6-V8 a
// PCB stream stops when its result screen goes: on ↺ and the logo, after an AI refusal rebuilt it without the AI rounds,
// and a real stream cut in the middle says nothing (it ran on unseen: python, DRC and the paid AI rounds, and a new PCB
// overlapped it on a 4 CPU server: review of 2026-11-06), V9 an AI editor stream that ends with no result says the
// connection was lost, and its half answer does not go to the model with the next request (the cursor blinked on: 2026-11-06),
// V10 the BOM's Mouser lookup goes with the login, and a refusal says it needs one, not that the server has no key,
// V11 the drawer has no Sources tab (web search is gone since 2026-06-12, so it was always grey), V12 an edit of an older
// version stays out of the description's saved result, which holds the newest (opened, it was the newest version's file
// with the older one's parts, and its PCB went by that name), V13 a storage that refuses the record costs a hand edit nothing
// (no thrown error, its toast there), an answer still coming is not kept in the record (opened again, its cursor blinks on), V14 an AI editor request
// stops when its result screen goes, on ↺ and on the logo (its model stream ran on, and its late answer was saved to the
// session left behind: review of 2026-11-07).
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

  // V3-V5: a generation held open, one circuit in the server's history, the PCB request kept
  const session = { id: '22222222-2222-2222-2222-222222222222', prompt: '기록에 있던 모터 회로', name: null, graph: answers[1].graph,
    filename: 'session-b.net', code: null, guide: null, created_at: new Date().toISOString() }
  const lateAnswer = { ...answers[0], filename: 'late-answer.net' }
  const whileGenerating = async ({ abortDoesNothing = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    await ctx.addInitScript(off => {
      localStorage.setItem('sf_token', 'fake-token')
      localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
      localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: false }))
      if (off) AbortController.prototype.abort = function () {}
    }, abortDoesNothing)
    const p = await ctx.newPage()
    const held = { stopped: 0, pcb: null, release: () => {} }
    const released = new Promise(r => { held.release = r })
    p.on('requestfailed', r => { if (/\/generate$/.test(r.url())) held.stopped++ })
    await p.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
    await p.route(/\/favorites$/, r => json(r, { favorites: [] }))
    await p.route(/\/sessions\/[^/]+\/messages$/, r => json(r, { messages: [] }))
    await p.route(/\/sessions$/, r => json(r, r.request().method() === 'POST' ? { id: 's9' } : { sessions: [session] }))
    await p.route(/\/netlist\/restore$/, r => json(r, { ok: true }))
    await p.route(/\/erc_graph$/, r => json(r, { erc: [] }))
    await p.route(/\/generate$/, async r => {
      await released
      await r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(lateAnswer)}\n\n` }).catch(() => {})
    })
    await p.route(/\/generate_pcb_stream$/, r => {
      held.pcb = r.request().postDataJSON()
      return r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: error\ndata: {"error":"check"}\n\n' })
    })
    await p.goto(BASE, { waitUntil: 'networkidle' })
    await p.locator('.sf-home-input textarea').fill('아직 만드는 중인 LED 회로')
    await p.getByRole('button', { name: '회로 만들기', exact: true }).click()
    await p.getByText(/^회로 만드는 중 · /).waitFor({ timeout: 10000 })
    return { p, held }
  }
  const openSession = async p => {
    await p.locator("button[aria-label='메뉴']").click()
    await p.getByText(session.prompt).first().click()
    await p.getByText('session-b.net').first().waitFor({ timeout: 10000 })
  }
  const pcbOf = async ({ p, held }) => {
    await p.getByRole('button', { name: /PCB (다시 )?생성/ }).first().click()
    for (let i = 0; i < 40 && !held.pcb; i++) await p.waitForTimeout(100)
    return held.pcb
  }
  const isSession = pcb => pcb?.baseName === 'session-b'
    && JSON.stringify((pcb.graph?.components ?? []).map(c => c.ref)) === JSON.stringify(session.graph.components.map(c => c.ref))

  const v3 = await whileGenerating()
  await openSession(v3.p)
  await v3.p.waitForTimeout(300)
  v3.held.release()
  await v3.p.waitForTimeout(600)
  const onScreen3 = await v3.p.locator('body').innerText().then(t => /session-b\.net/.test(t) && !/late-answer\.net/.test(t))
  const pcb3 = await pcbOf(v3)
  check('V3 a circuit opened during a generation stops it and stays; its PCB is that circuit under its own name',
    v3.held.stopped === 1 && onScreen3 && isSession(pcb3), `stopped ${v3.held.stopped}, on screen ${onScreen3}, PCB ${pcb3?.baseName ?? pcb3?.filename ?? 'none'}`)

  const v4 = await whileGenerating({ abortDoesNothing: true })
  await openSession(v4.p)
  await v4.p.waitForTimeout(300)
  v4.held.release()
  await v4.p.waitForTimeout(800)
  const onScreen4 = await v4.p.locator('body').innerText().then(t => /session-b\.net/.test(t) && !/late-answer\.net/.test(t))
  const kept = await v4.p.evaluate(() => JSON.parse(localStorage.getItem('sf_saved_results') || '[]').map(s => s.result?.filename))
  const pcb4 = await pcbOf(v4)
  check('V4 a generation\'s late answer leaves the opened circuit on screen and is only kept for later',
    onScreen4 && isSession(pcb4) && kept.includes('late-answer.net'), `on screen ${onScreen4}, PCB ${pcb4?.baseName ?? 'none'}, kept [${kept}]`)

  const v5 = await whileGenerating()
  await v5.p.getByText(/^v0\.4 · /).first().click()
  const home = await v5.p.locator('.sf-home-input textarea').waitFor({ timeout: 5000 }).then(() => true, () => false)
  v5.held.release()
  await v5.p.waitForTimeout(800)
  const stillHome = await v5.p.locator('.sf-home-input textarea').isVisible().catch(() => false)
  const result5 = await v5.p.getByRole('button', { name: /PCB (다시 )?생성/ }).first().isVisible().catch(() => false)
  check('V5 the logo during a generation stops it and goes home for good', v5.held.stopped === 1 && home && stillHome && !result5,
    `stopped ${v5.held.stopped}, home ${home}, still home ${stillHome}, result screen ${result5}`)

  // V6-V7: a generated circuit on screen whose PCB stream never answers
  const onResult = async answerPcb => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    await ctx.addInitScript(() => {
      localStorage.setItem('sf_token', 'fake-token')
      localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
      localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: false }))
    })
    const p = await ctx.newPage()
    const pcb = { sent: [], stopped: 0, complained: 0 }
    p.on('requestfailed', r => { if (/\/generate_pcb_stream$/.test(r.url())) pcb.stopped++ })
    p.on('console', m => { if (/PCB generation failed/.test(m.text())) pcb.complained++ })
    await p.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
    await p.route(/\/(favorites|sessions)(\/.*)?$/, r => json(r, { favorites: [], sessions: [], messages: [], id: 's1' }))
    await p.route(/\/generate$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(answers[0])}\n\n` }))
    await p.route(/\/generate_pcb_stream$/, r => { pcb.sent.push(r.request().postDataJSON()); return answerPcb(r, pcb.sent.length) })
    await p.goto(BASE, { waitUntil: 'networkidle' })
    await p.locator('.sf-home-input textarea').fill('PCB를 기다리는 LED 회로')
    await p.getByRole('button', { name: '회로 만들기', exact: true }).click()
    await p.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 20000 })
    return { p, pcb }
  }
  const sentPcb = async ({ p, pcb }, n) => {
    await p.getByRole('button', { name: /PCB (다시 )?생성/ }).first().click()
    for (let i = 0; i < 40 && pcb.sent.length < n; i++) await p.waitForTimeout(100)
  }
  const never = () => new Promise(() => {})

  const v6a = await onResult(never)
  await sentPcb(v6a, 1)
  await v6a.p.locator("button[title='재생성 (저장된 결과 대신 새로 생성)']").click()
  await v6a.p.getByRole('button', { name: 'v2', exact: true }).waitFor({ timeout: 20000 })
  await v6a.p.waitForTimeout(200)
  const v6b = await onResult(never)
  await sentPcb(v6b, 1)
  await v6b.p.getByText(/^v0\.4 · /).first().click()
  await v6b.p.waitForTimeout(300)
  check('V6 a PCB stream stops when its result screen goes (↺, the logo), and that is no failure', v6a.pcb.stopped === 1 && v6b.pcb.stopped === 1
    && v6a.pcb.complained + v6b.pcb.complained === 0, `↺ stopped ${v6a.pcb.stopped}, logo stopped ${v6b.pcb.stopped}, failures logged ${v6a.pcb.complained + v6b.pcb.complained}`)

  // the AI rounds refused: the board is built without them, by a second request, which stops the same way
  const v7 = await onResult((r, n) => (n === 1 ? r.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"check"}' }) : never()))
  await v7.p.getByRole('button', { name: /AI 다듬기 OFF/ }).click()
  await sentPcb(v7, 2)
  await v7.p.getByText(/^v0\.4 · /).first().click()
  await v7.p.waitForTimeout(300)
  check('V7 the rebuild after an AI refusal stops the same way', v7.pcb.sent.length === 2 && v7.pcb.sent[0].ai === true && v7.pcb.sent[1].ai === false && v7.pcb.stopped === 1,
    `${v7.pcb.sent.length} sent, stopped ${v7.pcb.stopped}`)

  // V8: the real stream, cut once it has answered
  const v8 = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  let cutOff = 0, complained = 0
  v8.on('requestfailed', r => { if (/\/generate_pcb_stream$/.test(r.url())) cutOff++ })
  v8.on('console', m => { if (/PCB generation failed/.test(m.text())) complained++ })
  await v8.goto(`${BASE}/?demo=motor`, { waitUntil: 'networkidle' })
  const streaming = v8.waitForResponse(/\/generate_pcb_stream$/, { timeout: 60000 })
  await v8.getByRole('button', { name: /PCB 생성/ }).first().click({ timeout: 60000 })
  await streaming
  await v8.getByText(/^v0\.4 · /).first().click()
  await v8.waitForTimeout(500)
  check('V8 a real PCB stream cut in the middle says nothing, and the home screen stays', cutOff === 1 && complained === 0 && await v8.locator('.sf-home-input textarea').isVisible(),
    `cut ${cutOff}, failures logged ${complained}`)

  // V9
  const v9 = await onResult(never)
  const edits = []
  await v9.p.route(/\/chat_edit$/, r => {
    edits.push(r.request().postDataJSON())
    return r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: text\ndata: "R1 값을 바꾸는 중인 답"\n\n' })
  })
  const box = v9.p.getByTestId('chat-input')
  await box.fill('R1 값을 470으로 바꿔줘')
  await box.press('Enter')
  const lostSaid = await v9.p.getByText('오류: 연결이 끊겼습니다').waitFor({ timeout: 5000 }).then(() => true, () => false)
  const cursor = await v9.p.evaluate(() => [...document.querySelectorAll('[data-testid="left-panel"] span')].some(s => s.style.animation.includes('pulse')))
  await box.fill('다시 해줘')
  await box.press('Enter')
  for (let i = 0; i < 30 && edits.length < 2; i++) await v9.p.waitForTimeout(100)
  const half = JSON.stringify(edits[1]?.history ?? []).includes('바꾸는 중인 답')
  check('V9 an AI editor stream with no result says the connection was lost, and its half answer is not sent on', lostSaid && !cursor && edits.length === 2 && !half,
    `said ${lostSaid}, cursor ${cursor}, ${edits.length} requests, half answer sent on ${half}`)

  // V10
  const v10 = await onResult(never)
  const lookups = []
  await v10.p.route(/\/mouser_search$/, r => {
    lookups.push(r.request().headers().authorization)
    return json(r, lookups.length === 1 ? { available: false, refused: true, reason: 'check', results: [] } : { available: false, reason: 'MOUSER_API_KEY not set', results: [] })
  })
  await v10.p.locator('button.sf-drawer-tab', { hasText: 'BOM' }).first().click()
  const lookup = v10.p.getByRole('button', { name: 'Mouser 가격 조회' })
  await lookup.click()
  const needsLogin = await v10.p.getByText('허용된 계정으로 로그인해야').waitFor({ timeout: 5000 }).then(() => true, () => false)
  const noKeyLine = await v10.p.getByText('Mouser 키가 서버에 없어').isVisible()
  const links = await v10.p.locator('[data-testid="bom-line"] a').count()
  await lookup.click()
  const noKey = await v10.p.getByText('Mouser 키가 서버에 없어').waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('V10 a refused Mouser lookup says it needs a login, the search links stay, and no key still says no key',
    lookups[0] === 'Bearer fake-token' && needsLogin && !noKeyLine && links > 0 && noKey, `sent ${lookups[0]}, login line ${needsLogin}, ${links} links, no-key line after ${noKey}`)

  // V11
  const tabNames = (await v10.p.locator('button.sf-drawer-tab').allTextContents()).map(t => t.trim()).join()
  check('V11 the drawer has no Sources tab', tabNames === 'Netlist,Guide,BOM,Code', tabNames)

  // V12: v1 and v2 of one description, v1 picked and its value edited, then the description's saved result opened
  const v12 = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await v12.addInitScript(() => {
    localStorage.setItem('sf_token', 'fake-token')
    localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
    localStorage.setItem('sf_settings', JSON.stringify({ clarify: false, plan: false }))
  })
  let turn12 = 0, pcb12 = null
  await v12.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
  await v12.route(/\/(favorites|sessions)(\/.*)?$/, r => json(r, { favorites: [], sessions: [], messages: [], id: 's1' }))
  await v12.route(/\/erc_graph$/, r => json(r, { erc: [] }))
  await v12.route(/\/generate$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(answers[Math.min(turn12++, 1)])}\n\n` }))
  await v12.route(/\/generate_pcb_stream$/, r => { pcb12 = r.request().postDataJSON(); return r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: error\ndata: {"error":"check"}\n\n' }) })
  await v12.goto(BASE, { waitUntil: 'networkidle' })
  await v12.locator('.sf-home-input textarea').fill(PROMPT)
  await v12.getByRole('button', { name: '회로 만들기', exact: true }).click()
  await v12.getByRole('button', { name: /PCB (다시 )?생성/ }).first().waitFor({ timeout: 20000 })
  await v12.locator("button[title='재생성 (저장된 결과 대신 새로 생성)']").click()
  await v12.getByRole('button', { name: 'v2', exact: true }).waitFor({ timeout: 20000 })
  await v12.getByRole('button', { name: 'v1', exact: true }).click()
  await v12.getByText('version-one.net').first().waitFor({ timeout: 5000 })
  await v12.waitForTimeout(500)
  const edit12 = async (p, ref, value) => {
    const b = await p.locator(`g[data-comp='${ref}']`).boundingBox()
    await p.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2)
    await p.locator('svg foreignObject input').first().fill(value)
    await p.keyboard.press('Enter')
    await p.waitForTimeout(500)
  }
  await edit12(v12, 'R1', '4k7')
  await v12.getByText(/^v0\.4 · /).first().click()
  await v12.locator('.sf-home-input textarea').fill(PROMPT)
  await v12.getByRole('button', { name: '회로 만들기', exact: true }).click()
  await v12.getByRole('button', { name: '불러오기', exact: true }).click({ timeout: 5000 })
  await v12.getByRole('button', { name: /PCB (다시 )?생성/ }).first().click({ timeout: 10000 })
  for (let i = 0; i < 30 && !pcb12; i++) await v12.waitForTimeout(100)
  const parts12 = g => (g?.components ?? []).map(c => c.ref).join()
  check('V12 an edit of an older version stays out of the saved result of the newest', pcb12?.baseName === 'version-two' && parts12(pcb12.graph) === parts12(answers[1].graph),
    `PCB under ${pcb12?.baseName}: ${parts12(pcb12?.graph)}`)

  // V13: an entry for this result whose writes then fail, and a stream that stays open
  const v13 = await onResult(never)
  const chat13 = (() => { let go; const until = new Promise(r => { go = r }); return { until, go } })()
  await v13.p.route(/\/erc_graph$/, r => json(r, { erc: [] }))
  await v13.p.route(/\/chat_edit$/, async r => { await chat13.until; await r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: text\ndata: "답하는 중"\n\n' }).catch(() => {}) })
  await v13.p.getByTestId('chat-input').fill('R1 값을 바꿔줘')
  await v13.p.getByTestId('chat-input').press('Enter')
  await v13.p.waitForTimeout(200)
  await edit12(v13.p, 'R1', '4k7')
  const kept13 = await v13.p.evaluate(() => JSON.parse(localStorage.getItem('sf_saved_results') || '[]')[0]?.messages ?? [])
  chat13.go()
  await v13.p.waitForTimeout(300)
  const thrown = []
  v13.p.on('pageerror', e => thrown.push(String(e)))
  await v13.p.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError') } })
  await edit12(v13.p, 'R1', '6k8')
  const value13 = await v13.p.locator("g[data-comp='R1']").textContent()
  const wire13 = await v13.p.evaluate(() => {
    for (const w of document.querySelectorAll("g[data-net] path[stroke='transparent']")) {
      const L = w.getTotalLength()
      if (L < 40) continue
      const m = w.getPointAtLength(L / 2), c = w.getScreenCTM()
      return { x: m.x * c.a + m.y * c.c + c.e, y: m.x * c.b + m.y * c.d + c.f }
    }
    return null
  })
  await v13.p.mouse.click(wire13.x, wire13.y)
  await v13.p.getByRole('button', { name: '✕ 삭제' }).click({ timeout: 3000 })
  await v13.p.waitForTimeout(400)
  const toast13 = await v13.p.getByText('삭제됨').isVisible()
  check('V13 an answer still coming stays out of the record, and a storage that refuses it costs a hand edit nothing',
    kept13.length > 0 && !kept13.some(m => m._streaming) && !thrown.length && /6k8/.test(value13) && toast13,
    `kept ${JSON.stringify(kept13.map(m => m._streaming ? 'streaming' : m.role))}, thrown ${thrown.length}, R1 "${value13}", toast ${toast13}`)

  // V14: an AI editor request on its way when the result screen goes (the logo, and v1 of two versions)
  const v14 = await onResult(never)
  const chat14 = { sent: 0, stopped: 0 }
  v14.p.on('requestfailed', r => { if (/\/chat_edit$/.test(r.url())) chat14.stopped++ })
  await v14.p.route(/\/chat_edit$/, r => { chat14.sent++; return never() })
  const ask14 = async () => {
    await v14.p.getByTestId('chat-input').fill('R1 값을 2k로 바꿔줘')
    await v14.p.getByTestId('chat-input').press('Enter')
    for (let i = 0; i < 30 && chat14.sent === chat14.stopped; i++) await v14.p.waitForTimeout(100)
  }
  await ask14()
  await v14.p.locator("button[title='재생성 (저장된 결과 대신 새로 생성)']").click()
  await v14.p.getByRole('button', { name: 'v2', exact: true }).waitFor({ timeout: 20000 })
  await v14.p.waitForTimeout(300)
  const byVersion = chat14.stopped
  await ask14()
  await v14.p.getByText(/^v0\.4 · /).first().click()
  await v14.p.waitForTimeout(300)
  check('V14 an AI editor request stops when its result screen goes (↺ to a new version, the logo)', chat14.sent === 2 && byVersion === 1 && chat14.stopped === 2,
    `${chat14.sent} sent, stopped by the new version ${byVersion}, in all ${chat14.stopped}`)
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
