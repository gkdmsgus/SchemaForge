// Checks S1-S4 on the style sheets, with no browser. S1 every partial in src/styles is imported by main.scss, and no
// plain .css file sits in src unimported (three did, 3,600 lines, for months: sweep of 2026-11-07), S2 main.scss compiles,
// S3 every animation named in a style sheet or in the screens' code has its @keyframes: a missing one gives no error and
// the part simply stops moving (the schematic's pop-up fade and the diff pulse lean on names from the sheets).
// S4 the mono font stack sets Hangul with a Korean web font the page loads, not the system's GulimChe. S5 text keeps
// 4.5:1 contrast: the text tokens on every surface, and the shared controls' text on its own colour. S6 the browser
// tab's icon is the header's mark (Logo.tsx) in the token colours, and the drawer shows that mark too. S7 Google Fonts
// is asked once, by index.html, for every web font the stacks name.
// Usage: npx tsx scripts/check_styles.ts   → exit 0 only if all pass
import fs from 'node:fs'
import path from 'node:path'
import * as sass from 'sass'
import { contrast } from '../src/lib/diffColors.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const STYLES = path.join(ROOT, 'src', 'styles')
let failed = 0
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`)
}
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])

const code = walk(path.join(ROOT, 'src')).filter(f => /\.tsx?$/.test(f)).map(f => ({ f, text: fs.readFileSync(f, 'utf8') }))

// S1
const main = fs.readFileSync(path.join(STYLES, 'main.scss'), 'utf8')
const imported = new Set([...main.matchAll(/^@import '([^']+)'/gm)].map(m => m[1]))
const orphans = fs.readdirSync(STYLES).filter(f => /^_.*\.scss$/.test(f) && !imported.has(f.slice(1, -5)))
const allCode = code.map(c => c.text).join('\n')
const looseCss = walk(path.join(ROOT, 'src')).filter(f => f.endsWith('.css') && !allCode.includes(`/${path.basename(f)}'`))
check('S1 every style sheet in src is in use', !orphans.length && !looseCss.length,
  [...orphans, ...looseCss.map(f => path.relative(ROOT, f))].join(', '))

// S2
let css = ''
try {
  css = sass.compile(path.join(STYLES, 'main.scss'), { logger: sass.Logger.silent }).css
  check('S2 main.scss compiles', css.length > 0, `${css.length} characters`)
} catch (e) {
  check('S2 main.scss compiles', false, (e as Error).message.split('\n')[0])
}

// S3. A name is the word before a time, in a declaration's value: "pulse 0.35s", `pulse ${0.9 + i}s`, ".5s" after "spin"
const NOT_NAMES = new Set(['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'infinite', 'alternate', 'forwards', 'backwards', 'both', 'none', 'reverse', 'normal', 'running', 'paused'])
const namesIn = (text: string) => {
  const names = new Set<string>()
  for (const m of text.replace(/\$\{[^}]*\}/g, '1').matchAll(/\banimation(?:-name)?\s*:\s*([^\n]*)/g)) {
    const value = m[1].split(/[;}]|,\s*[a-zA-Z]+\s*:/)[0]   // up to the end of this declaration, in CSS or in a style object
    for (const n of value.matchAll(/([A-Za-z][\w-]*)\s+[\d.]+m?s\b/g)) if (!NOT_NAMES.has(n[1])) names.add(n[1])
  }
  return names
}
const defined = new Set([...`${css}\n${allCode}`.matchAll(/@keyframes\s+([A-Za-z][\w-]*)/g)].map(m => m[1]))
const named = new Map<string, string>()
for (const n of namesIn(css)) named.set(n, 'the style sheets')
for (const { f, text } of code) for (const n of namesIn(text)) named.set(n, path.basename(f))
const missing = [...named].filter(([n]) => !defined.has(n)).map(([n, f]) => `${n} (${f})`)
check('S3 every animation has its @keyframes', named.size > 3 && !missing.length, missing.length ? missing.join(', ') : `${named.size} names, ${defined.size} defined`)

// the families of a font stack, without quotes, and the web fonts index.html asks Google Fonts for
const families = (stack: string) => stack.split(',').map(f => f.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
const tokenOf = (name: string) => new RegExp(`--sf-${name}:\\s*([^;]+);`).exec(css)?.[1].trim() ?? ''
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
const webFonts = new Set([...html.matchAll(/href="https:\/\/fonts\.googleapis\.com\/css2\?([^"]+)"/g)]
  .flatMap(m => [...m[1].matchAll(/family=([^:&]+)/g)].map(f => decodeURIComponent(f[1].replace(/\+/g, ' ')))))

// S4. Hangul in a mono line is set by the first family that has it: with none loaded before the system ones, Windows
// filled it from 'monospace' with GulimChe (설정 '자동 재시도', the 배치하기 tab: CDP font check of 2026-11-08)
{
  const mono = families(tokenOf('font-mono'))
  const firstSystem = mono.findIndex(f => !webFonts.has(f))
  const hangul = mono.slice(0, firstSystem < 0 ? mono.length : firstSystem).filter(f => / KR$/.test(f))
  check('S4 the mono stack sets Hangul with a loaded Korean web font before any system font', hangul.length > 0,
    `${mono.join(', ') || 'no --sf-font-mono'} · loaded: ${[...webFonts].join(', ')}`)
}

// S5. Text keeps 4.5:1 (WCAG AA) on the beige surfaces: the text tokens on every surface, and the text the shared
// controls put on a colour. fg-dim (2.93:1 on bg-1), the filled amber buttons (3.31:1), the teal button's hover (3.20:1)
// and the drawer's history items, left in dark-theme colours (#8090b0, 3.00:1; black on hover), fell short (contrast
// sweep of 2026-11-08). fg-faint, amber and cyan are for lines, fills and marks; text takes fg-dim, amber-deep, cyan-deep.
// --sf-danger is not in the table yet: 4.24:1 on bg-1 and 4.40:1 on bg-4, its colour still to be chosen.
{
  const SURFACES = ['bg', 'bg-1', 'bg-2', 'bg-3', 'bg-4'].map(s => `var(--sf-${s})`)
  const TEXT = ['fg', 'fg-muted', 'fg-dim', 'amber-deep', 'cyan-deep', 'violet']
  /** a colour as code or a token writes it, as #rrggbb; a translucent one is laid over `base` */
  const hexOf = (v: string, base = '#ffffff', depth = 0): string | null => {
    v = v.trim()
    const t = /^var\(--sf-([\w-]+)\)$/.exec(v)
    if (t) return depth < 4 ? hexOf(tokenOf(t[1]), base, depth + 1) : null
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase()
    if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('').toLowerCase()
    const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(v)
    const b = m && hexOf(base)
    if (!m || !b) return null
    const a = Number(m[4])
    return '#' + [1, 2, 3].map(i => Math.round(Number(m[i]) * a + parseInt(b.slice(2 * i - 1, 2 * i + 1), 16) * (1 - a))
      .toString(16).padStart(2, '0')).join('')
  }
  // [what, text colour, its background, the surfaces a translucent background can sit on]
  const pairs: [string, string, string, string[]][] = TEXT.flatMap(t => SURFACES.map(s =>
    ['token', `var(--sf-${t})`, s, ['#ffffff']] as [string, string, string, string[]]))
  const src = (f: string) => fs.readFileSync(path.join(ROOT, 'src', 'components', f), 'utf8')
  const prim = src('primitives.tsx'), header = src('Header.tsx'), item = src('SideDrawer.tsx').split('function SessionItem')[1] ?? ''
  const drawer = src('SideDrawer.tsx')
  const prop = (s: string, p: string) => new RegExp(`\\b${p}:\\s*'([^']+)'`).exec(s)?.[1] ?? ''
  const variant = (table: string, v: string) => new RegExp(`const ${table}[^]*?\\n\\s*${v}:\\s*\\{([^}]*)\\}`).exec(prim)?.[1] ?? ''
  /** the code of the element whose children start with `anchor` */
  const before = (text: string, tag: string, anchor: string) => { const i = text.indexOf(anchor); return i < 0 ? '' : text.slice(text.lastIndexOf(`<${tag}`, i), i) }
  for (const v of ['primary', 'cyan']) {
    const text = prop(variant('BTN_VARIANTS', v), 'color')
    pairs.push([`Button ${v}`, text, prop(variant('BTN_VARIANTS', v), 'background'), ['#ffffff']])
    pairs.push([`Button ${v} hover`, prop(variant('BTN_HOVER', v), 'color') || text, prop(variant('BTN_HOVER', v), 'background'), ['#ffffff']])
  }
  pairs.push(['Chip active', /fg: active \? '([^']+)'/.exec(prim)?.[1] ?? '', /bg: active \? '([^']+)'/.exec(prim)?.[1] ?? '', SURFACES])
  const cyanChip = /\{\s*bg: '([^']+)',\s*fg: '([^']+)'/.exec(prim)
  pairs.push(['Chip cyan', cyanChip?.[2] ?? '', cyanChip?.[1] ?? '', SURFACES])
  const login = before(header, 'button', '>로그인</button>')
  pairs.push(['Header 로그인', prop(login, 'color'), prop(login, 'background'), ['#ffffff']])
  pairs.push(['Header 로그인 hover', prop(login, 'color'), /onMouseEnter=[^\n]*style\.background = '([^']+)'/.exec(login)?.[1] ?? '', ['#ffffff']])
  const avatar = before(header, 'div', '{user.email?.[0]')
  pairs.push(['Header account initial', prop(avatar, 'color'), prop(avatar, 'background'), ['#ffffff']])
  const drawerBg = /width: 280,\s*background: '([^']+)'/.exec(drawer)?.[1] ?? ''
  const hoverBg = /background: hovered \? '([^']+)'/.exec(item)?.[1] ?? ''
  const title = /color: hovered \? '([^']+)' : '([^']+)'/.exec(before(item, 'div', '>{title}</div>'))
  pairs.push(['drawer item name', title?.[2] ?? '', drawerBg, ['#ffffff']])
  pairs.push(['drawer item name, hovered', title?.[1] ?? '', hoverBg, [drawerBg]])
  const time = prop(before(item, 'div', '{time}{msgCount'), 'color')
  pairs.push(['drawer item time', time, drawerBg, ['#ffffff']], ['drawer item time, hovered', time, hoverBg, [drawerBg]])
  const field = before(item, 'input', '/>')
  pairs.push(['drawer item name field', prop(field, 'color'), prop(field, 'background'), [drawerBg]])
  pairs.push(['drawer date group', prop(before(drawer, 'div', '}}>{label}</div>'), 'color'), drawerBg, ['#ffffff']])

  const results = pairs.map(([what, fg, bg, bases]) => {
    const worst = Math.min(...bases.map(base => { const f = hexOf(fg), b = hexOf(bg, base); return f && b ? contrast(f, b) : 0 }))
    return { what, fg, bg, worst }
  })
  const short = results.filter(r => !(r.worst >= 4.5))
  check('S5 text keeps 4.5:1 on its surface (tokens, buttons, chips, header, drawer items)', pairs.length > 40 && !short.length,
    short.length ? short.map(r => `${r.what}: ${r.worst ? `${r.fg} on ${r.bg} ${r.worst.toFixed(2)}:1` : `colour not found (${r.fg || '?'} on ${r.bg || '?'})`}`).join(' · ')
      : `${pairs.length} pairs, lowest ${Math.min(...results.map(r => r.worst)).toFixed(2)}:1`)
}

// S6. The browser tab shows the header's mark: from the first commit it was Vite's purple bolt (#863bff, blurred
// ellipses), beside the amber chip in the header and a violet dot in the drawer (design sweep of 2026-11-08). The icon
// is Logo.tsx's chip in the token colours; it may draw thicker lines and fewer pins, to read at 16 px.
{
  const comp = (f: string) => fs.readFileSync(path.join(ROOT, 'src', 'components', f), 'utf8')
  const logo = comp('Logo.tsx')
  const iconFile = path.join(ROOT, 'public', 'favicon.svg')
  const icon = fs.existsSync(iconFile) ? fs.readFileSync(iconFile, 'utf8') : ''
  const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
  const tags = (svg: string, tag: string) => [...svg.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map(m => attrs(m[0]))
  const shapes = (svg: string) => [
    ...tags(svg, 'rect').map(a => `rect ${['x', 'y', 'width', 'height', 'rx'].map(k => a[k]).join(' ')}`),
    ...tags(svg, 'circle').map(a => `circle ${a.cx} ${a.cy}`),
    ...tags(svg, 'path').filter(a => /cyan/.test(a.stroke ?? '') || a.stroke === tokenOf('cyan')).map(a => `trace ${a.d}`),
    `viewBox ${tags(svg, 'svg')[0]?.viewBox}`,
  ]
  const colours = (svg: string) => new Set(['rect', 'circle', 'path'].flatMap(t => tags(svg, t)).flatMap(a => [a.fill, a.stroke])
    .filter(c => c && c !== 'none').map(c => (/^var\(--sf-([\w-]+)\)$/.exec(c) ? tokenOf(/^var\(--sf-([\w-]+)\)$/.exec(c)![1]) : c).toLowerCase()))
  const iconShapes = new Set(shapes(icon)), iconColours = colours(icon), logoColours = colours(logo)
  const wrong = [
    ...(/#863bff|<filter|feGaussianBlur/i.test(icon) || !icon ? ['the icon is not the mark (Vite bolt, blur or no file)'] : []),
    ...shapes(logo).filter(s => !iconShapes.has(s)).map(s => `icon lacks ${s}`),
    ...(logoColours.size && [...logoColours].every(c => iconColours.has(c)) && iconColours.size === logoColours.size ? []
      : [`icon colours ${[...iconColours].join(' ')} vs the mark's ${[...logoColours].join(' ')}`]),
    ...(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/.test(html) ? [] : ['index.html does not link /favicon.svg']),
    ...['Header.tsx', 'SideDrawer.tsx'].filter(f => !/<Logo\b/.test(comp(f))).map(f => `${f} does not draw <Logo />`),
  ]
  check('S6 the tab icon is the header\'s mark in the token colours, and the drawer shows that mark', !wrong.length,
    wrong.length ? wrong.join(' · ') : `${shapes(logo).length} shapes, colours ${[...iconColours].join(' ')}`)
}

// S7. Google Fonts is asked once, by index.html's <link>: the token sheet @imported the same address too, and the
// build kept that @import at the top of its CSS (design sweep of 2026-11-08). The link loads every web font the stacks
// name before their system fonts.
{
  const imports = (css.match(/fonts\.googleapis\.com/g) ?? []).length
  const links = [...html.matchAll(/<link\b[^>]*fonts\.googleapis\.com\/css2[^>]*>/g)].length
  const named = ['font-sans', 'font-mono'].flatMap(t => { const f = families(tokenOf(t)); const i = f.findIndex(x => /^(ui-|system-ui|-apple-system|sans-serif|monospace)/.test(x)); return f.slice(0, i < 0 ? f.length : i) })
  const unloaded = [...new Set(named)].filter(f => !webFonts.has(f))
  check('S7 Google Fonts is asked once, by index.html, for every web font the stacks name', imports === 0 && links === 1 && named.length > 0 && !unloaded.length,
    `the style sheets ask ${imports} time(s), index.html ${links}${unloaded.length ? ` · not loaded: ${unloaded.join(', ')}` : ` · ${[...new Set(named)].join(', ')}`}`)
}

console.log(failed ? `\n${failed} FAILED` : '\nall style checks passed')
process.exitCode = failed ? 1 : 0
