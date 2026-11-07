// Browser checks for the "이 회로의 저장된 결과가 있어요" offer, with the login and the API faked by page.route:
// O1 asked from the circuit-type panel further down the page, the offer comes into view (it sat at the top of the
// page, out of view, and the make button seemed to do nothing: tour take 4, 2026-10-29), O2 불러오기 opens the
// saved circuit without asking the server for a plan or a circuit again, O3 an entry saved with an AI edit opens with
// the edit (the chat said "+C9" over a circuit without it, and the next PCB left it out: review of 2026-11-06), O4 a saved
// copy equal in value is no edit, O5 an edit made, then undone or reset, opens as it was left, O6 from the side drawer's
// list of this browser's records too (what it shows when the server's list does not come).
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

  // O3-O5: the description typed, so its entry is found by it
  const TYPED = '저장된 편집을 다시 여는 LED 회로'
  let rechecks = 0
  await page.route(/\/erc_graph$/, r => { rechecks++; return json(r, { erc: [] }) })
  const c9 = { reply: 'C9를 더했습니다.', actions: [{ type: 'add_component', ref: 'C9', name: 'C', value: '100nF' },
    { type: 'add_net', name: demo.graph.nets[0].name, nodes: [{ ref: 'C9', pin: '1' }] }, { type: 'add_net', name: demo.graph.nets[1].name, nodes: [{ ref: 'C9', pin: '2' }] }] }
  await page.route(/\/chat_edit$/, r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(c9)}\n\n` }))
  const entry = extra => page.evaluate(([p, result, more]) => localStorage.setItem('sf_saved_results',
    JSON.stringify([{ id: 2, name: p.slice(0, 40), prompt: p, result, time: Date.now(), ...more }])), [TYPED, demo, extra])
  const openSaved = async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.locator('.sf-home-input textarea').fill(TYPED)
    await page.getByRole('button', { name: '회로 만들기', exact: true }).click()
    await page.getByRole('button', { name: '불러오기', exact: true }).click({ timeout: 5000 })
    await page.locator('g[data-comp]').first().waitFor({ timeout: 10000 })
    await page.waitForTimeout(600)
  }
  const hasC9 = () => page.locator("g[data-comp='C9']").count().then(n => n > 0)
  const reset = page.getByRole('button', { name: '초기화', exact: true })
  const edited = { ...demo.graph, components: [...demo.graph.components, { ref: 'C9', name: 'C', value: '100nF' }] }

  await entry({ graph: edited, messages: [{ role: 'user', content: 'C9 더해줘' }, { role: 'assistant', content: 'C9를 더했습니다.', actions: c9.actions }] })
  await openSaved()
  check('O3 an entry saved with an AI edit opens with the edit', await hasC9() && await page.getByText('+C9', { exact: true }).isVisible(),
    `C9 on the schematic: ${await hasC9()}`)

  await entry({ graph: JSON.parse(JSON.stringify(demo.graph)), messages: [{ role: 'user', content: '이 회로가 뭐야?' }, { role: 'assistant', content: 'LED 회로입니다.', actions: [] }] })
  rechecks = 0
  await openSaved()
  // an edit is checked again on its own (ResultPanel's /erc_graph effect), the generated circuit is not
  await page.waitForTimeout(500)
  check('O4 a saved copy equal in value is no edit', !(await hasC9()) && rechecks === 0, `re-checks ${rechecks}`)

  const makeC9 = async () => {
    await page.getByTestId('chat-input').fill('C9 커패시터를 하나 추가해줘')
    await page.getByTestId('chat-input').press('Enter')
    await page.locator("g[data-comp='C9']").waitFor({ timeout: 5000 })
    await page.waitForTimeout(300)
  }
  await entry({})
  await openSaved()
  await makeC9()
  await openSaved()
  const reopened = await hasC9()
  await reset.click()
  await page.locator("g[data-comp='C9']").waitFor({ state: 'detached', timeout: 5000 })
  await openSaved()
  const afterReset = await hasC9()
  await makeC9()
  await page.getByRole('button', { name: /되돌리기/ }).first().click()
  await page.locator("g[data-comp='C9']").waitFor({ state: 'detached', timeout: 5000 })
  await openSaved()
  const afterUndo = await hasC9()
  check('O5 an edit opens again; undone or reset, it does not', reopened && !afterReset && !afterUndo, `made ${reopened}, after 초기화 ${afterReset}, after 되돌리기 ${afterUndo}`)

  // O6
  await page.unroute(/\/(favorites|sessions)$/)
  await page.route(/\/favorites$/, r => json(r, { favorites: [] }))
  await page.route(/\/sessions$/, r => json(r, { error: 'check' }, 500))
  const fromDrawer = async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.locator("button[aria-label='메뉴']").click()
    await page.getByText(TYPED.slice(0, 20)).first().click({ timeout: 5000 })
    await page.locator('g[data-comp]').first().waitFor({ timeout: 10000 })
    await page.waitForTimeout(600)
  }
  await entry({ graph: edited, messages: [{ role: 'user', content: 'C9 더해줘' }, { role: 'assistant', content: 'C9를 더했습니다.', actions: c9.actions }] })
  await fromDrawer()
  const drawerEdit = await hasC9()
  await entry({ graph: JSON.parse(JSON.stringify(demo.graph)), messages: [] })
  rechecks = 0
  await fromDrawer()
  await page.waitForTimeout(500)
  check('O6 the side drawer opens an edit with the edit, and an equal copy as no edit', drawerEdit && !(await hasC9()) && rechecks === 0, `edit ${drawerEdit}, re-checks ${rechecks}`)
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
