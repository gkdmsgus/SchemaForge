// Browser checks for 의견 남기기 (src/components/FeedbackDialog.tsx, POST /feedback), on a phone (375×812, touch) with no
// login. K1 the header's 의견 button is reachable (all of it on the screen, nothing over its centre) on the first screen and
// on the motor demo, and nothing sticks out past the right edge. K2 it opens a modal dialog named 의견 남기기 that takes
// the focus, fits the screen width, and has 보던 회로 already filled with the demo ("Demo: motor") at once. K3 five
// rating choices, each with a name and a checked state; 보내기 cannot be pressed before one is chosen. K4 the opinion
// stops at 500 letters and says "500 / 500자". K5 sending posts exactly {rating, comment, circuit} as chosen and shows
// the thanks. K6 a refusal shows the server's Korean sentence as it is, and a server not reached says so in Korean,
// with what was typed kept. K7 Esc closes it and the focus goes back to the 의견 button. K8 the real server (through
// the dev proxy) answers in JSON with a Korean sentence or ok, and the dialog shows thanks or that sentence, never
// "HTTP" or English. K5-K6 answer from the page (page.route) so they do not depend on where the server keeps opinions.
// Needs the vite dev server and its API: npm run test:browser starts both with no keys. On a dev server whose
// server/.env names Supabase, K8 leaves one row in its feedback table ("browser check K8").
// Usage: node scripts/check_feedback.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
const VW = 375, VH = 812
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

/** all of the box on the screen, and the element itself under its centre */
const reach = loc => loc.first().evaluate((el, [vw, vh]) => {
  const b = el.getBoundingClientRect()
  const box = `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}×${Math.round(b.height)}`
  if (!b.width || !b.height) return { ok: false, box: 'no size' }
  const inside = b.left >= -0.5 && b.top >= -0.5 && b.right <= vw + 0.5 && b.bottom <= vh + 0.5
  const hit = inside ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null
  return { ok: inside && !!hit && (hit === el || el.contains(hit)), box }
}, [VW, VH]).catch(() => ({ ok: false, box: 'not found' }))
const wide = page => page.evaluate(() => document.documentElement.scrollWidth)

const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.setDefaultTimeout(8000)
  const opener = page.getByRole('button', { name: '의견 남기기', exact: true })
  const dialog = page.getByRole('dialog', { name: '의견 남기기', exact: true })
  const send = dialog.getByRole('button', { name: '보내기', exact: true })
  const comment = dialog.getByLabel('하고 싶은 말 (선택)')
  const circuit = dialog.getByLabel('보던 회로 (선택)')
  const alertText = () => dialog.getByRole('alert').innerText().catch(() => '')

  // K1
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const home = { reach: await reach(opener), width: await wide(page) }
  await page.goto(`${BASE}/?demo=motor`, { waitUntil: 'networkidle' })
  await page.getByText('Demo: motor').first().waitFor({ timeout: 60000 }).catch(() => {})
  const demo = { reach: await reach(opener), width: await wide(page) }
  check('K1 the 의견 button is reachable on a phone, first screen and demo, and nothing sticks out to the right',
    home.reach.ok && demo.reach.ok && home.width <= VW && demo.width <= VW,
    `first screen ${home.reach.box} (page ${home.width} px), demo ${demo.reach.box} (page ${demo.width} px)`)

  // K2: read right after the tap, before any later render could fill the field
  await opener.first().tap()
  const at = await dialog.evaluate(d => {
    const b = d.getBoundingClientRect()
    const input = [...d.querySelectorAll('input')].find(i => i.labels?.[0]?.textContent?.includes('보던 회로'))
    return { modal: d.getAttribute('aria-modal'), focus: d.contains(document.activeElement), left: b.left, right: b.right, circuit: input?.value ?? null }
  }).catch(e => ({ error: e.message }))
  check('K2 a modal dialog named 의견 남기기 takes the focus, fits the width, 보던 회로 is the demo at once',
    at.modal === 'true' && at.focus && at.left >= 0 && at.right <= VW && at.circuit === 'Demo: motor', JSON.stringify(at))

  // K3
  const radios = dialog.getByRole('radio')
  const n = await radios.count()
  const names = await radios.evaluateAll(rs => rs.map(r => `${r.getAttribute('aria-label')}:${r.getAttribute('aria-checked')}`))
  const before = await send.isDisabled()
  if (n === 5) await radios.nth(3).tap()
  const after = await send.isDisabled()
  const checked = await radios.evaluateAll(rs => rs.map(r => r.getAttribute('aria-checked')).join(','))
  check('K3 five ratings with a name and a state; 보내기 waits for one', n === 5 && names.every(x => /^\d점, .+:false$/.test(x)) && before && !after
    && checked === 'false,false,false,true,false', `${n} radios ${names.join(' ')}; disabled before ${before}, after ${after}; ${checked}`)

  // K4
  await comment.fill('가'.repeat(520))
  const len = [...await comment.inputValue()].length
  const counter = await dialog.getByText(/\d+ \/ 500자/).innerText().catch(() => '')
  check('K4 the opinion stops at 500 letters and says so', len === 500 && counter.includes('500 / 500자'), `${len} letters, "${counter}"`)

  // K5
  let posted = null
  await page.route('**/feedback', async route => { posted = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }) })
  await comment.fill('데모가 빨라서 좋았어요')
  await circuit.fill('Demo: motor')
  await send.tap()
  const thanks = await dialog.getByRole('status').innerText().catch(() => '')
  check('K5 sending posts rating, comment and circuit only, and thanks the visitor',
    !!posted && Object.keys(posted).sort().join(',') === 'circuit,comment,rating' && posted.rating === 4
    && posted.comment === '데모가 빨라서 좋았어요' && posted.circuit === 'Demo: motor' && /고마워요/.test(thanks),
    `${JSON.stringify(posted)} → "${thanks}"`)
  await page.unroute('**/feedback')

  // K6
  const said = '의견은 10분에 5번까지 보낼 수 있습니다. 잠시 뒤 다시 보내 주세요.'
  await dialog.getByRole('button', { name: '닫기', exact: true }).first().tap()
  await opener.first().tap()
  await radios.nth(1).tap()
  await comment.fill('두 번째 의견')
  await page.route('**/feedback', route => route.fulfill({ status: 429, json: { error: said } }))
  await send.tap()
  const refusal = await alertText()
  await page.unroute('**/feedback')
  await page.route('**/feedback', route => route.abort('connectionrefused'))
  await send.tap()
  const offline = await alertText()
  const kept = await comment.inputValue()
  await page.unroute('**/feedback')
  check('K6 a refusal shows the server\'s sentence, an unreachable server is said in Korean, the text stays',
    refusal === said && /서버에 연결하지 못했습니다/.test(offline) && kept === '두 번째 의견', `"${refusal}" | "${offline}" | kept "${kept}"`)

  // K7
  await page.keyboard.press('Escape')
  const closed = await dialog.count() === 0
  const focusBack = await opener.first().evaluate(b => b === document.activeElement).catch(() => false)
  check('K7 Esc closes it and the focus goes back to the 의견 button', closed && focusBack, `closed ${closed}, focus back ${focusBack}`)

  // K8 the real route, through the dev proxy
  await opener.first().tap()
  await radios.nth(4).tap()
  await comment.fill('browser check K8')
  const answer = page.waitForResponse(r => r.url().endsWith('/feedback') && r.request().method() === 'POST')
  await send.tap()
  const res = await answer
  const body = await res.json().catch(() => null)
  await page.waitForTimeout(300)
  const shown = (await dialog.getByRole('status').innerText().catch(() => '')) || await alertText()
  const fine = res.status() === 200 ? body?.ok === true && /고마워요/.test(shown)
    : typeof body?.error === 'string' && /[가-힣]/.test(body.error) && shown === body.error
  check('K8 the real server answers ok or a Korean sentence, and the dialog shows thanks or that sentence',
    fine && !/HTTP|Error|error/.test(shown), `${res.status()} ${JSON.stringify(body)} → "${shown}"`)
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} FAILED` : '\nall feedback checks passed')
process.exit(failed ? 1 : 0)
