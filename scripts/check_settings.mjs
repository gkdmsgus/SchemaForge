// Browser checks for the settings dialog (no login, no API of its own): G1 the header's settings button is named 설정
// and opens a modal dialog named by its heading that takes the focus, G2 its three switches each have a name and an
// on/off state (role=switch, aria-checked), G3 a click flips the state and the saved setting and a second click puts
// both back, G4 Space on a focused switch flips it too, G5 the Korean labels are not letter-spaced, capitalised mono, G6 the
// page behind is not blurred and no 'SETTINGS', 'GPT' or 'plan' is left in it, G7 Esc closes the dialog, gives the
// focus back to the settings button and the page takes clicks again. (Before them the switches were bare buttons
// with no name or state, Esc left the overlay up taking clicks, and 자동 재시도 read '자 동 재 시 도' in GulimChe:
// design sweep of 2026-11-08.) Needs the vite dev server (npm run dev).
// Usage: node scripts/check_settings.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }
const LABELS = ['자동 재시도', '모호한 프롬프트 되묻기', '설계 계획 미리보기']

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  page.setDefaultTimeout(5000)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const opener = page.getByRole('button', { name: '설정', exact: true })
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  const isOpen = async () => await page.getByText(LABELS[0], { exact: true }).count() > 0
  /** the open settings panel: the dialog, or the fixed layer around its first label where there is no dialog */
  const panelEval = (fn, arg) => page.evaluate(([src, label, a]) => {
    const el = [...document.querySelectorAll('body *')].find(e => e.textContent?.trim() === label && !e.children.length)
    let p = el?.closest('[role=dialog]') ?? el
    while (p && p.parentElement && getComputedStyle(p).position !== 'fixed') p = p.parentElement
    return p ? new Function('panel', 'arg', src)(p, a) : null
  }, [fn, LABELS[0], arg])
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('sf_settings') || '{}'))
  const state = label => dialog.getByRole('switch', { name: label, exact: true }).getAttribute('aria-checked').catch(() => null)

  // G1
  const openers = await opener.count()
  // the old English name too, so a run on the old screen still opens it and reports what is wrong inside
  await (openers ? opener.first() : page.locator("button[aria-label='Settings']")).click()
  await page.waitForTimeout(400)
  const modal = await dialog.count() ? await dialog.getAttribute('aria-modal') : null
  const focusIn = await dialog.count() ? await dialog.evaluate(d => d.contains(document.activeElement)) : false
  check('G1 the settings button is named 설정 and opens a modal dialog named 설정 that takes the focus',
    openers === 1 && modal === 'true' && focusIn, `button named 설정 ${openers}, dialog ${await dialog.count()}, aria-modal ${modal}, focus inside ${focusIn}`)

  // G2
  const states = await Promise.all(LABELS.map(state))
  const switches = await dialog.getByRole('switch').count().catch(() => 0)
  check('G2 three switches, each named by its label, each on or off', switches === 3 && states.every(s => s === 'true' || s === 'false'),
    `${switches} switch(es): ${LABELS.map((l, i) => `${l} ${states[i]}`).join(', ')}`)

  // G3
  const first = dialog.getByRole('switch', { name: LABELS[0], exact: true })
  const s0 = await state(LABELS[0])
  if (switches) await first.click()
  const s1 = await state(LABELS[0]), saved1 = (await saved()).autoRetry
  if (switches) await first.click()
  const s2 = await state(LABELS[0]), saved2 = (await saved()).autoRetry
  check('G3 a click flips the switch and the saved setting, a second click puts both back',
    s0 === 'true' && s1 === 'false' && saved1 === false && s2 === 'true' && saved2 === true,
    `aria-checked ${s0} → ${s1} → ${s2}, saved autoRetry ${saved1} → ${saved2}`)

  // G4
  const second = dialog.getByRole('switch', { name: LABELS[1], exact: true })
  const k0 = await state(LABELS[1])
  if (switches) { await second.focus(); await page.keyboard.press('Space') }
  const k1 = await state(LABELS[1])
  if (switches) await page.keyboard.press('Space')
  const k2 = await state(LABELS[1])
  check('G4 Space on a focused switch flips it, and again puts it back', !!k0 && k1 !== k0 && k2 === k0, `${k0} → ${k1} → ${k2}`)

  // G5 (the dialog still open)
  const tracked = await panelEval(`return [...panel.querySelectorAll('*')].filter(e => [...e.childNodes].some(n => n.nodeType === 3 && /[가-힣]/.test(n.textContent)))
    .map(e => { const s = getComputedStyle(e); return { text: e.textContent.trim().slice(0, 14), em: (parseFloat(s.letterSpacing) || 0) / parseFloat(s.fontSize), upper: s.textTransform === 'uppercase', mono: /Plex Mono/.test(s.fontFamily.split(',')[0]) } })
    .filter(x => x.em > 0.05 || x.upper || x.mono)`)
  check('G5 no Korean text in the dialog is letter-spaced, capitalised or set in mono', Array.isArray(tracked) && !tracked.length,
    tracked ? tracked.map(x => `'${x.text}' ${x.em.toFixed(2)}em${x.upper ? ' uppercase' : ''}${x.mono ? ' mono' : ''}`).join(' · ') : 'the dialog was not found')

  // G6
  const look = await panelEval(`return { blur: getComputedStyle(panel).backdropFilter, words: (panel.innerText.match(/SETTINGS|GPT|\\bplan\\b/g) || []) }`)
  check('G6 the page behind is not blurred, and no SETTINGS, GPT or plan is left in the dialog', !!look && look.blur === 'none' && !look.words.length,
    look ? `backdrop-filter ${look.blur}, words ${look.words.join(' ') || 'none'}` : 'the dialog was not found')

  // G7
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const closed = !(await isOpen())
  const focusBack = openers ? await opener.first().evaluate(b => b === document.activeElement) : false
  let reopened = false
  if (closed && openers) {
    await opener.first().click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(300)
    reopened = await isOpen()
    await page.keyboard.press('Escape')
  }
  check('G7 Esc closes the dialog, the focus goes back to the settings button, and the page takes clicks again',
    closed && focusBack && reopened, `closed ${closed}, focus back ${focusBack}, opens again ${reopened}`)
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} FAILED` : '\nall settings checks passed')
process.exit(failed ? 1 : 0)
