// Browser checks for the "이 회로의 저장된 결과가 있어요" offer, with the login and the API faked by page.route:
// O1 asked from the circuit-type panel further down the page, the offer comes into view (it sat at the top of the
// page, out of view, and the make button seemed to do nothing: tour take 4, 2026-10-29), O2 불러오기 opens the
// saved circuit without asking the server for a plan or a circuit again. O3-O5 what that panel sends: a field that takes
// several sends its chips and what was typed, in either order; a single choice one or the other.
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

  // O3-O5: what the panel sends. A field that takes several sends its chips and what was typed, in either order (2026-11-06
  // sweep: 'LM386 사용' typed and the '전원 LED' chip lit sent only the typing; typing after a chip turned the chip off);
  // a single choice is one or the other, as it was
  const fromAmpPanel = async steps => {
    asked.length = 0
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '회로 종류로 시작하기' }).scrollIntoViewIfNeeded()
    await page.locator('button[role=listitem].sf-type-row', { hasText: '오디오 앰프' }).click()
    const panel = page.locator('.sf-spec-panel')
    await panel.getByRole('button', { name: '헤드폰 앰프', exact: true }).click()
    await panel.getByRole('button', { name: '9V 배터리', exact: true }).click()
    await steps(panel, panel.getByPlaceholder('직접 입력 (선택)'))
    const make = page.getByRole('button', { name: '오디오 앰프 만들기' }).last()
    await page.waitForTimeout(600)
    await make.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await make.click()
    await page.waitForTimeout(800)
    return String(asked[0] ?? '')
  }
  const chip = (panel, name) => panel.getByRole('button', { name, exact: true }).click()
  const typedFirst = await fromAmpPanel(async (panel, typed) => { await typed.last().fill('LM386 사용'); await chip(panel, '전원 LED') })
  check('O3 several-choice field, typed then a chip: both are sent', typedFirst.includes('- 부가 기능: 전원 LED, LM386 사용'), JSON.stringify(typedFirst))
  const chipsFirst = await fromAmpPanel(async (panel, typed) => { await chip(panel, '전원 LED'); await chip(panel, '볼륨 조절'); await typed.last().fill('LM386 사용') })
  check('O4 several-choice field, chips then typed: the chips stay and all are sent', chipsFirst.includes('- 부가 기능: 전원 LED, 볼륨 조절, LM386 사용'), JSON.stringify(chipsFirst))
  const typedSingle = await fromAmpPanel(async (_, typed) => { await typed.first().fill('OPA2134 앰프') })
  const pickedAfter = await fromAmpPanel(async (panel, typed) => { await typed.first().fill('OPA2134 앰프'); await chip(panel, '파워앰프') })
  check('O5 single choice stays one or the other: typing replaces the chip, a chip replaces the typing',
    typedSingle.includes('- 앰프 종류: OPA2134 앰프') && !typedSingle.includes('헤드폰') && pickedAfter.includes('- 앰프 종류: 파워앰프') && !pickedAfter.includes('OPA2134'),
    JSON.stringify({ typedSingle, pickedAfter }))
} finally {
  await browser.close()
}
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
