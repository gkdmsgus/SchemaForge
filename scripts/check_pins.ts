// Checks P1-P5: what the deploy images install and what the checks run on is fixed, so a build next month runs what was
// tested today. P1 every line of requirements.txt is one exact version, P2 each Python the images run gets each package
// once, with skidl and numpy among them, P3 both Dockerfiles install that file, P4 the root's tsx is the server's, in
// package.json and in the lock (npm test's scripts/ steps ran whatever npx found or fetched: 4.23.15 beside the server's
// 4.23.13, and on a fresh clone with an empty npm cache they did not start), P5 the server declares no package its code
// does not import (@tavily/core and jsonwebtoken sat in the image for months, about 22 MB, with nothing using them).
// No server, no Docker (what the images really hold is read with pip freeze: README, 배포).
// Usage: npx tsx scripts/check_pins.ts   → exit 0 only if all pass
import fs from 'node:fs'
import path from 'node:path'

const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
let failed = 0
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`)
}

// P1
const lines = read('requirements.txt').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean)
const PIN = /^([A-Za-z0-9._-]+)==([0-9][A-Za-z0-9.]*)(?:\s*;\s*python_version\s*(<|>=)\s*"3\.(\d+)")?$/
const pins = lines.map(l => PIN.exec(l))
check('P1 requirements.txt names one exact version on every line', lines.length > 0 && pins.every(Boolean),
  lines.filter(l => !PIN.test(l)).join(', '))

// P2. the images' Pythons: Dockerfile.jetson's Ubuntu 22.04 has 3.10, Dockerfile's KiCad image 3.13
for (const minor of [10, 13]) {
  const names = pins.filter((m): m is RegExpExecArray => !!m)
    .filter(m => !m[3] || (m[3] === '<' ? minor < Number(m[4]) : minor >= Number(m[4])))
    .map(m => m[1].toLowerCase())
  const twice = names.filter((n, i) => names.indexOf(n) !== i)
  check(`P2 Python 3.${minor} gets each package once, skidl and numpy among them`,
    !twice.length && names.includes('skidl') && names.includes('numpy'), `${names.length} packages${twice.length ? `, twice: ${twice.join(', ')}` : ''}`)
}

// P3
for (const f of ['Dockerfile', 'Dockerfile.jetson']) {
  const text = read(f)
  check(`P3 ${f} installs requirements.txt`, /^COPY requirements\.txt /m.test(text) && /pip install [^\n]*-r requirements\.txt/.test(text))
}

// P4
{
  const lockedTsx = (f: string): string | undefined => JSON.parse(read(f)).packages?.['node_modules/tsx']?.version
  const server = lockedTsx('server/package-lock.json')
  const declared = JSON.parse(read('package.json')).devDependencies?.tsx, locked = lockedTsx('package-lock.json')
  check('P4 the root runs the tsx the server has', !!server && declared === server && locked === server,
    `server ${server}, root package.json ${declared}, root lock ${locked}`)
}

// P5. tsx imports nothing: it is what runs the server (the Dockerfiles' CMD)
{
  const dir = path.resolve(import.meta.dirname, '..', 'server')
  const code = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(f => /\.ts$/.test(f) && !f.split(path.sep).includes('node_modules'))
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
  const imported = (d: string) => [`'${d}'`, `"${d}"`, `'${d}/`, `"${d}/`].some(q => new RegExp(`(from |import |import\\(|require\\()${q}`).test(code))
  const unused = Object.keys(JSON.parse(read('server/package.json')).dependencies).filter(d => d !== 'tsx' && !imported(d))
  check('P5 the server imports every package it declares', !unused.length, unused.join(', '))
}

console.log(failed ? `\n${failed} FAILED` : '\nall pin checks passed')
process.exitCode = failed ? 1 : 0
