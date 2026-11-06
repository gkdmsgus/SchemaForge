// Browser checks for result versions, with the login and the API faked by page.route (generation answers with
// two demo circuits in turn): V1 ↺ makes a second version and v1/v2 switch the circuit on screen, V2 after v1 is
// applied, the saved result of the same description opens v1 (it opened the v2 just dropped: frame review of the
// tour, 2026-10-30), V3 a circuit opened from the history during a generation stops it and stays, and a PCB request
// is that circuit under its own name (the generation's answer took the screen back: the opened circuit's parts went to
// the PCB under the generation's file name, review of 2026-11-06), V4 with the stop not reaching the stream in time,
// its late answer is only kept for later, V5 the logo during a generation stops it and goes home for good.
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
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
