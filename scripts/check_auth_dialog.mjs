// Browser checks for the sign-in and sign-up dialog, with the login API faked by page.route.
// D1-D2 the look, as the other screens since 2026-09-17: no gradient, blur or emoji, no English headline, corners from the
// tokens (8 px at most, circles aside), every glyph from the app's fonts (Space Grotesk, IBM Plex Sans KR) and none from a
// system font, text at 4.5:1 or more on what is behind it (3:1 when large). Before, the dialog kept the dark gradient
// panel, '다시 만나요 👋' half in Malgun Gothic and Segoe UI Emoji, and 24 px corners (sweep of 2026-11-08).
// Needs the vite dev server (npm run dev) with the fonts reachable (fonts.googleapis.com): a glyph from a system font fails.
// Usage: node scripts/check_auth_dialog.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }
const APP_FONTS = ['Space Grotesk', 'IBM Plex Sans KR', 'IBM Plex Mono']

/** in the page: the dialog's box, the open <dialog> or what says role=dialog; else the old card, so the look checks still read it */
const findDialog = () => { window.authDialog = () => document.querySelector('dialog[open], [role=dialog]') ?? document.querySelector('.auth-card') }

/** what the dialog draws: gradients, blurs, emoji, corners and the contrast of every text, measured in the page */
const lookOf = page => page.evaluate(() => {
  const d = window.authDialog()
  if (!d) return null
  const els = [d, ...d.querySelectorAll('*')]
  const px = v => parseFloat(v) || 0
  const gradients = [], blurs = [], corners = []
  for (const el of els) {
    for (const pseudo of [null, '::before', '::after']) {
      const s = getComputedStyle(el, pseudo)
      if (/gradient/.test(s.backgroundImage)) gradients.push(`${el.className || el.tagName}${pseudo || ''}`)
    }
    const s = getComputedStyle(el)
    if (s.backdropFilter && s.backdropFilter !== 'none') blurs.push(el.className || el.tagName)
    const r = el.getBoundingClientRect(), radius = Math.max(px(s.borderTopLeftRadius), px(s.borderTopRightRadius), px(s.borderBottomLeftRadius), px(s.borderBottomRightRadius))
    // a dot or a pill is round on purpose: its corner is half its short side
    if (radius > 8 && r.width && Math.min(r.width, r.height) > 2 * radius + 1) corners.push(`${el.className || el.tagName} ${radius}px`)
  }
  // what covers the page behind it: the overlay, or the dialog's ::backdrop
  for (const el of [d.parentElement, ...document.querySelectorAll('.auth-overlay')].filter(Boolean)) {
    const s = getComputedStyle(el)
    if (s.backdropFilter && s.backdropFilter !== 'none' && s.position === 'fixed') blurs.push(el.className || el.tagName)
  }
  if (d.tagName === 'DIALOG') {
    const b = getComputedStyle(d, '::backdrop')
    if (b.backdropFilter && b.backdropFilter !== 'none') blurs.push('::backdrop')
    if (/gradient/.test(b.backgroundImage)) gradients.push('::backdrop')
  }
  const text = d.innerText
  const emoji = [...text.matchAll(/\p{Extended_Pictographic}/gu)].map(m => m[0])
  const english = /\b(Welcome|Start\s+building|back\.)/i.test(text) ? text.match(/\b(Welcome|Start\s+building)[^\n]*/i)?.[0] : ''

  // contrast: each element with its own text, against the colours behind it composited up to an opaque one
  const rgba = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r, g, b, a } }
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 })
  const behind = el => {
    const layers = []
    for (let e = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor)
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break }
    }
    return layers.reverse().reduce((acc, c) => over(c, acc), { r: 255, g: 255, b: 255, a: 1 })
  }
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }
  const low = []
  let texts = 0
  for (const el of els) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || !el.getClientRects().length) continue
    texts++
    const bg = behind(el), fg0 = rgba(s.color), fg = fg0.a < 1 ? over(fg0, bg) : fg0
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
    const ratio = (hi + 0.05) / (lo + 0.05)
    const size = px(s.fontSize), large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
    if (ratio < (large ? 3 : 4.5) - 0.005) low.push(`'${el.textContent.trim().slice(0, 16)}' ${ratio.toFixed(2)}`)
  }
  return { gradients, blurs, corners, emoji, english, low, texts }
})

/** the fonts that drew the dialog's text (Chrome's own answer, glyph by glyph) */
async function fontsOf(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: false })
  await page.evaluate(() => {
    const d = window.authDialog()
    for (const el of d ? [d, ...d.querySelectorAll('*')] : []) if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) el.setAttribute('data-font-probe', '')
  })
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-font-probe]' })
  const used = new Map()
  for (const nodeId of nodeIds) {
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    for (const f of fonts) used.set(f.familyName, (used.get(f.familyName) || 0) + f.glyphCount)
  }
  await page.evaluate(() => document.querySelectorAll('[data-font-probe]').forEach(e => e.removeAttribute('data-font-probe')))
  await cdp.detach()
  return used
}

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.addInitScript(findDialog)
  await page.route(/\/auth\/login$/, r => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: '메일 주소나 비밀번호가 맞지 않습니다.' }) }))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const opener = page.getByRole('button', { name: '로그인', exact: true }).first()
  const email = page.locator("input[aria-label='이메일']")
  const open = async () => { await opener.click(); await email.waitFor({ timeout: 5000 }); await page.waitForTimeout(400) }
  const signUp = page.locator('.auth-tabs').getByRole('button', { name: '회원가입' })
  const settle = async () => { await page.waitForLoadState('networkidle'); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300) }

  // D1-D2, in both forms
  await open()
  for (const form of ['login', 'sign-up']) {
    if (form === 'sign-up') { await signUp.click(); await page.locator("input[aria-label='비밀번호 확인']").waitFor({ timeout: 5000 }) }
    await settle()
    const look = await lookOf(page)
    check(`D1 ${form}: no gradient, blur, emoji or English headline, corners 8 px at most`,
      !!look && !look.gradients.length && !look.blurs.length && !look.emoji.length && !look.english && !look.corners.length,
      look ? JSON.stringify({ gradients: look.gradients, blurs: look.blurs, emoji: look.emoji, english: look.english, corners: look.corners }) : 'no dialog')
    const fonts = await fontsOf(page)
    // Chrome names a face with its style ('Space Grotesk Light'): the family is the start of the name
    const other = [...fonts].filter(([f]) => !APP_FONTS.some(app => f === app || f.startsWith(`${app} `)))
    check(`D2 ${form}: every glyph from the app's fonts, text at 4.5:1 or more`, fonts.size > 0 && !other.length && !!look && look.texts > 3 && !look.low.length,
      `${[...fonts].map(([f, n]) => `${f} ${n}`).join(', ')}${look?.low.length ? ` · low contrast: ${look.low.join(', ')}` : ''}`)
  }
  await page.keyboard.press('Escape')
  await email.waitFor({ state: 'hidden', timeout: 5000 })
} catch (e) {
  failed++
  console.log('FAIL stopped: ' + String(e?.message || e).split('\n')[0])
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} FAIL` : '\nall ok')
process.exitCode = failed ? 1 : 0
