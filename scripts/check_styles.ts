// Checks S1-S4 on the style sheets, with no browser. S1 every partial in src/styles is imported by main.scss, and no
// plain .css file sits in src unimported (three did, 3,600 lines, for months: sweep of 2026-11-07), S2 main.scss compiles,
// S3 every animation named in a style sheet or in the screens' code has its @keyframes: a missing one gives no error and
// the part simply stops moving (the schematic's pop-up fade and the diff pulse lean on names from the sheets).
// S4 the mono font stack sets Hangul with a Korean web font the page loads, not the system's GulimChe.
// Usage: npx tsx scripts/check_styles.ts   → exit 0 only if all pass
import fs from 'node:fs'
import path from 'node:path'
import * as sass from 'sass'

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

console.log(failed ? `\n${failed} FAILED` : '\nall style checks passed')
process.exitCode = failed ? 1 : 0
