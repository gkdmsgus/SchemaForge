// Checks S1-S3 on the style sheets, with no browser. S1 every partial in src/styles is imported by main.scss, and no
// plain .css file sits in src unimported (three did, 3,600 lines, for months: sweep of 2026-11-07), S2 main.scss compiles,
// S3 every animation named in a style sheet or in the screens' code has its @keyframes: a missing one gives no error and
// the part simply stops moving (the schematic's pop-up fade and the diff pulse lean on names from the sheets).
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

console.log(failed ? `\n${failed} FAILED` : '\nall style checks passed')
process.exitCode = failed ? 1 : 0
