// Checks M1-M7 on the sign-in and sign-up dialog (src/components/AuthModal.tsx), with no browser. Since 2026-09-17 the other
// screens take their look from the tokens; the dialog kept the dark gradient panel, a blur over the page, '다시 만나요 👋',
// 'Welcome back.', '설계하는 가장 빠른 방법', 24 px corners and fonts named by hand, which left its Korean to Malgun Gothic
// (sweep of 2026-11-08). M1 no emoji, M2 no gradient or blur, M3 corners from the tokens or 8 px at most, M4 fonts only
// through var(--sf-font-sans/mono), M5 no English headline or unsupported superlative, M6 drawn open it is a <dialog> named
// by its title, with a named close button and the error said in an alert, M7 the sign-up form links the terms and the
// privacy policy in a new tab. scripts/check_auth_dialog.mjs checks the same in a browser, with the focus and the fonts.
// Usage: npx tsx scripts/check_auth_modal.ts   → exit 0 only if all pass
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AuthModal from '../src/components/AuthModal.tsx'

const ROOT = path.resolve(import.meta.dirname, '..')
const FILE = path.join(ROOT, 'src', 'components', 'AuthModal.tsx')
let failed = 0
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`)
}
const source = fs.readFileSync(FILE, 'utf8')
// what the code says, not its comments (a comment may name what is gone)
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const lineOf = (i: number) => code.slice(0, i).split('\n').length

// M1
const emoji = [...code.matchAll(/\p{Extended_Pictographic}/gu)].map(m => `${m[0]} (line ${lineOf(m.index)})`)
check('M1 no emoji', !emoji.length, emoji.join(', '))

// M2
const flashy = [...code.matchAll(/gradient\(|backdrop-?filter|backdropFilter|blur\(/gi)].map(m => `${m[0]} (line ${lineOf(m.index)})`)
check('M2 no gradient or blur', !flashy.length, flashy.join(', '))

// M3: a radius is a token, 50% (a dot), 0, or a number of px up to the tokens' largest card corner (--sf-r-lg 8 px)
const radii = [...code.matchAll(/border-?radius\s*:\s*([^;\n}]+)/gi), ...code.matchAll(/borderRadius\s*:\s*([^,\n}]+)/g)]
  .map(m => ({ value: m[1].trim().replace(/^['"]|['"]$/g, ''), line: lineOf(m.index) }))
const bigRadius = radii.filter(({ value }) => value.split(/\s+/).some(v =>
  !/^var\(--sf-r-(xs|sm|md|lg|pill)\)$/.test(v) && v !== '50%' && v !== '0' && !(/^\d+(\.\d+)?(px)?$/.test(v) && parseFloat(v) <= 8)))
check('M3 corners from the tokens or 8 px at most', radii.length > 0 && !bigRadius.length,
  bigRadius.length ? bigRadius.map(r => `${r.value} (line ${r.line})`).join(', ') : `${radii.length} radii`)

// M4: every font through the tokens; a family named by hand drops IBM Plex Sans KR and the Korean falls to a system font
const fonts = [...code.matchAll(/font-family\s*:\s*([^;\n}]+)/gi), ...code.matchAll(/fontFamily\s*:\s*([^,\n}]+)/g), ...code.matchAll(/\bfont\s*:\s*([^;\n}]+)/g)]
  .map(m => ({ value: m[1].trim(), line: lineOf(m.index) }))
const byHand = fonts.filter(({ value }) => /['"][A-Z][^'"]*['"]|\b(sans-serif|monospace|serif)\b/.test(value.replace(/^['"]var\(--sf-font-(sans|mono)\)['"]$/, ''))
  && !/var\(--sf-font-(sans|mono)\)/.test(value))
check('M4 fonts only through var(--sf-font-sans) and var(--sf-font-mono)', !byHand.length, byHand.map(f => `${f.value} (line ${f.line})`).join(', '))

// M5
const words = [...code.matchAll(/Welcome|Start\s*\\?n?building|가장|최고의|최초의/g)].map(m => `${m[0]} (line ${lineOf(m.index)})`)
check('M5 no English headline or unsupported superlative', !words.length, words.join(', '))

// M6: drawn open (no effects run here: what the markup itself says)
// (the error box shows only after a failure, which needs the effects: its role is read in the source)
const html = renderToStaticMarkup(createElement(AuthModal, { open: true, onClose: () => {}, onSuccess: () => {} }))
const dialog = /<dialog\b([^>]*)>/.exec(html)
const labelId = dialog && /aria-labelledby="([^"]+)"/.exec(dialog[1])?.[1]
const escaped = labelId?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const title = escaped ? new RegExp(`<h2[^>]*\\bid="${escaped}"[^>]*>([^<]*)</h2>`).exec(html)?.[1] : null
const closeNamed = /<button[^>]*aria-label="닫기"/.test(html)
const alertBox = /<div\s(?=[^>]*className="auth-error")(?=[^>]*role="alert")[^>]*>/.test(code)
check('M6 drawn open: one <dialog> named by its title 로그인, a close button named 닫기; the error box is role="alert"',
  (html.match(/<dialog\b/g) || []).length === 1 && title === '로그인' && closeNamed && alertBox,
  JSON.stringify({ dialog: !!dialog, labelId, title, closeNamed, alertBox }))

// M7: the sign-up form's line, in the source (drawn here the dialog opens on the login form)
const signUp = /!isLogin\s*&&\s*\(?\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(code)?.[1] ?? ''
const link = (href: string, text: string) => new RegExp(`<a\\s[^>]*href="${href}"[^>]*target="_blank"[^>]*rel="[^"]*noopener[^"]*"[^>]*>${text}</a>`).test(signUp)
check('M7 the sign-up form links 이용약관 (/terms) and 개인정보 처리방침 (/privacy) in a new tab',
  link('/terms', '이용약관') && link('/privacy', '개인정보 처리방침'), signUp ? signUp.replace(/\s+/g, ' ').slice(0, 160) : 'no line shown only on sign-up')

console.log(failed ? `\n${failed} FAILED` : '\nall dialog checks passed')
process.exitCode = failed ? 1 : 0
