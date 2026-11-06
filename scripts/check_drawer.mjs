// Browser checks for the history drawer of a logged-in user, with the login and the API faked by page.route:
// R1 the ✎ button opens the name field inside the open drawer and does not open the circuit, R2 Enter sends
// PATCH /sessions/:id with the new name and the list shows it, R3 Escape keeps the old name and sends nothing,
// R4 a click on the item opens the circuit and closes the drawer, R5 a favourite has no ✎, R6-R7 a slow list shows
// '불러오는 중' until it comes, not '저장된 회로가 없습니다'.
// A1-A3 the login form (not the drawer, but no other browser check
// logs in and out): no password left after a login and logout or a close, and a sign-up waiting for its mail keeps it.
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

  // R6-R7: while the list is on its way (1.5 s here, as on the deployed server in the 2026-11-01 tour) the drawer says
  // it is loading, not '저장된 회로가 없습니다'; then the list, or that line when the server has none
  for (const [name, sessions, want] of [['R6', [session], session.name], ['R7', [], '저장된 회로가 없습니다']]) {
    const slow = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
    await slow.addInitScript(() => {
      localStorage.setItem('sf_token', 'fake-token')
      localStorage.setItem('sf_user', JSON.stringify({ id: 'u1', email: 'owner@example.com' }))
    })
    await slow.route(/\/auth\/me$/, r => json(r, { user: { id: 'u1', email: 'owner@example.com' }, canGenerate: true }))
    await slow.route(/\/favorites$/, async r => { await new Promise(ok => setTimeout(ok, 1500)); return json(r, { favorites: [] }) })
    await slow.route(/\/sessions$/, async r => { await new Promise(ok => setTimeout(ok, 1500)); return json(r, { sessions }) })
    await slow.goto(BASE, { waitUntil: 'networkidle' })
    await slow.locator("button[aria-label='메뉴']").click()
    await slow.waitForTimeout(500)
    const during = { empty: await slow.getByText('저장된 회로가 없습니다').isVisible(), loading: await slow.getByText('불러오는 중').first().isVisible() }
    await slow.getByRole('button', { name: '⭐ 즐겨찾기' }).click()
    const favDuring = { empty: await slow.getByText('즐겨찾기한 회로가 없어요').isVisible(), loading: await slow.getByText('불러오는 중').first().isVisible() }
    await slow.getByRole('button', { name: '히스토리' }).click()
    const shown = await slow.getByText(want).first().waitFor({ timeout: 5000 }).then(() => true, () => false)
    const after = await slow.getByText('불러오는 중').count()
    check(`${name} loading ${sessions.length ? 'a list' : 'an empty list'}: '불러오는 중' first (history and favourites), then ${sessions.length ? 'the list' : "'저장된 회로가 없습니다'"}`,
      !during.empty && during.loading && !favDuring.empty && favDuring.loading && shown && after === 0, JSON.stringify({ during, favDuring, shown, after }))
    await slow.context().close()
  }

  // A1-A3: the login form stays mounted, and what was typed in it must not (2026-11-06 sweep: after a logout the next person
  // opened it on the last password, and pressing 로그인 logged in as that account)
  const authPage = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  const signedIn = { user: { id: 'u1', email: 'owner@example.com' }, token: 'fake-token', refresh_token: 'fake-refresh' }
  await authPage.route(/\/auth\/login$/, r => json(r, signedIn))
  await authPage.route(/\/auth\/logout$/, r => json(r, { ok: true }))
  await authPage.route(/\/auth\/register$/, r => json(r, { needsConfirm: true, message: '가입 확인 메일을 보냈습니다.' }))
  await authPage.route(/\/auth\/me$/, r => json(r, { user: signedIn.user, canGenerate: true }))
  await authPage.route(/\/(favorites|sessions)$/, r => json(r, { favorites: [], sessions: [] }))
  const email = authPage.locator("input[aria-label='이메일']"), password = authPage.locator("input[aria-label='비밀번호']"), again = authPage.locator("input[aria-label='비밀번호 확인']")
  const openLogin = async () => { await authPage.getByRole('button', { name: '로그인', exact: true }).first().click(); await email.waitFor({ timeout: 5000 }) }
  const secret = 'typed-password-1'
  await authPage.goto(BASE, { waitUntil: 'networkidle' })

  await openLogin()
  await email.fill(signedIn.user.email)
  await password.fill(secret)
  await authPage.locator('.auth-form button[type=submit]').click()
  await authPage.getByRole('button', { name: '로그아웃' }).waitFor({ timeout: 5000 })
  await authPage.getByRole('button', { name: '로그아웃' }).click()
  await authPage.getByRole('button', { name: '로그인', exact: true }).first().waitFor({ timeout: 5000 })
  await openLogin()
  check('A1 after a login and a logout the login form holds no password, the mail address stays',
    await password.inputValue() === '' && await email.inputValue() === signedIn.user.email, `password ${(await password.inputValue()).length} chars, mail '${await email.inputValue()}'`)

  await password.fill(secret)
  await authPage.keyboard.press('Escape')
  await email.waitFor({ state: 'hidden', timeout: 5000 })
  await openLogin()
  check('A2 a form closed without logging in holds no password either', await password.inputValue() === '', `password ${(await password.inputValue()).length} chars`)

  // the mail's link confirms the address and the person logs in here: the form stays open and keeps the password for that
  await authPage.locator('.auth-tabs').getByRole('button', { name: '회원가입' }).click()
  await email.fill('new@example.com')
  await password.fill(secret)
  await again.fill(secret)
  await authPage.locator('.auth-form button[type=submit]').click()
  await authPage.getByText('가입 확인 메일을 보냈습니다.').waitFor({ timeout: 5000 })
  check('A3 a sign-up waiting for its mail stays on the form with the password kept, for the login after the link',
    await password.inputValue() === secret && !(await again.isVisible()), `password ${(await password.inputValue()).length} chars`)
  await authPage.context().close()
} catch (e) {
  failed++
  console.log('FAIL stopped: ' + String(e?.message || e).split('\n')[0])
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} FAIL` : '\nall ok')
process.exitCode = failed ? 1 : 0
