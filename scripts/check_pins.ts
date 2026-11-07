// Checks P1-P3: what the deploy images install is fixed, so a build next month runs what was tested today.
// P1 every line of requirements.txt is one exact version, P2 each Python the images run gets each package once, with
// skidl and numpy among them, P3 both Dockerfiles install that file.
// No server, no Docker (what the images really hold is read with pip freeze: README, 배포).
// Usage: npx tsx scripts/check_pins.ts   → exit 0 only if all pass
import fs from 'node:fs'

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

console.log(failed ? `\n${failed} FAILED` : '\nall pin checks passed')
process.exitCode = failed ? 1 : 0
