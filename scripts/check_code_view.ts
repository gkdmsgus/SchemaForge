/**
 * Checks for the Code tab helpers (src/lib/pythonCode.ts) and the code view colours.
 *
 * Run: npx tsx scripts/check_code_view.ts
 * (a) the highlighter is lossless on every server/test_circuits/*.py, (b) token classes,
 * (c) error lines from recorded stderr (anonymised), (d) error summaries, (e) line ranges and
 * Tab indentation, (f) a live fault injected into led_basic.py and run through the installed
 * python + skidl (a missing python or skidl is a FAIL), (g) WCAG AA contrast of every text
 * colour in src/styles/_code.scss on its surface. Exit code 0 only if every check passes.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { errorLine, indentLines, lineRange, summarizeError, tokenizePython, type Tok } from '../src/lib/pythonCode.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
let failed = 0
function check(name: string, ok: boolean, info = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`)
}
const join = (ls: Tok[][]) => ls.map(l => l.map(t => t.t).join('')).join('\n')

// ── (a) lossless on the demo circuits ──
const dir = path.join(ROOT, 'server', 'test_circuits')
const pyFiles = fs.readdirSync(dir).filter(f => f.endsWith('.py'))
check('a: test circuits found', pyFiles.length >= 8, `${pyFiles.length} files`)
for (const f of pyFiles) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8')
  const toks = tokenizePython(src)
  check(`a: lossless ${f}`, join(toks) === src && toks.length === src.split('\n').length, `${toks.length} lines`)
}
for (const odd of ['', '\n', 'x = """open\nstill open', "s = 'a\\\nb'", 'a\r\nb\r\n']) {
  check(`a: lossless ${JSON.stringify(odd)}`, join(tokenizePython(odd)) === odd)
}

// ── (b) token classes ──
const t = tokenizePython(`from skidl import *\n# a '#' comment\nx = Part(name='R#1', value="1k")  # tail\ns = """a\nb # not comment\n"""\nn = 3.3e-3 + 0x1F\nif True: pass\nr1['p1'] += vcc\nbad = 'unterminated\nok = 1`)
check('b: keyword from', t[0][0].k === 'kw' && t[0][0].t === 'from')
check('b: comment line', t[1].length === 1 && t[1][0].k === 'com')
check("b: '#' inside a string is not a comment", t[2].some(x => x.k === 'str' && x.t === "'R#1'") && t[2].filter(x => x.k === 'com').length === 1)
check('b: Part( is fn', t[2].some(x => x.k === 'fn' && x.t === 'Part'))
check('b: triple string spans lines', t[3].some(x => x.k === 'str') && t[4][0].k === 'str' && t[4][0].t === 'b # not comment' && t[5][0].k === 'str')
check('b: numbers', t[6].some(x => x.k === 'num' && x.t === '3.3e-3') && t[6].some(x => x.k === 'num' && x.t === '0x1F'))
check('b: True is kw', t[7].some(x => x.k === 'kw' && x.t === 'True'))
check('b: r1 is a name, not an r-string', t[8][0].k === 'txt' && t[8][0].t.startsWith('r1') && t[8].some(x => x.k === 'str' && x.t === "'p1'"))
check('b: unterminated string stops at the line end', t[9].some(x => x.k === 'str') && t[10].some(x => x.k === 'num' && x.t === '1'))
check('b: prefixed strings', tokenizePython(`f"{a}" rb'x' u'y'`)[0].filter(x => x.k === 'str').map(x => x.t).join(' ') === `f"{a}" rb'x' u'y'`)

// ── (c) error lines from recorded stderr (Python 3.14 + skidl 2.2.1, paths anonymised) ──
const P = 'C:\\Users\\u\\AppData\\Local\\Temp\\0f1e\\circuit.py'
const W = 'WARNING: KICAD_SYMBOL_DIR environment variable is missing, so the default KiCad symbol libraries won\'t be searched. @ [C:\\x\\<frozen importlib._bootstrap_external>:759=>C:\\x\\<frozen importlib._bootstrap>:491]\nWARNING: fp-lib-table file was not found. Component footprints are not available.\n'
const tbA = `${W}ERROR: No pins found using R:R1[('p3',)] @ [${P}:19]\nTraceback (most recent call last):\n  File "${P}", line 19, in <module>\n    r1['p3'] += led_a\nTypeError: unsupported operand type(s) for +=: 'NoneType' and 'Net'\n`
const tbB = `${W}Traceback (most recent call last):\n  File "${P}", line 14, in <module>\n    d1.value = RED\n               ^^^\nNameError: name 'RED' is not defined\n`
const tbC = `  File "${P}", line 2\n    x = Net('A'\n           ^\nSyntaxError: '(' was never closed\n`
const tbD = `${W}Traceback (most recent call last):\n  File "${P}", line 23, in <module>\n    generate_netlist(tool='nonexistent_tool')\n  File "C:\\Users\\u\\AppData\\Roaming\\Python\\Python314\\site-packages\\skidl\\circuit.py", line 793, in generate_netlist\n    netlist = tool_modules[tool].gen_netlist(self, **kwargs)\nKeyError: 'nonexistent_tool'\n`
check('c: skidl ERROR + TypeError → 19', errorLine(tbA) === 19, String(errorLine(tbA)))
check('c: NameError → 14', errorLine(tbB) === 14, String(errorLine(tbB)))
check('c: SyntaxError without a Traceback header → 2', errorLine(tbC) === 2, String(errorLine(tbC)))
check("c: skips skidl's own circuit.py:793 → 23", errorLine(tbD) === 23, String(errorLine(tbD)))
check('c: timeout has no line', errorLine('skidl execution timed out') === null)
check('c: skidl ERROR alone → 19', errorLine(`ERROR: No pins found using R:R1[('p3',)] @ [${P}:19]`) === 19)

// ── (d) summaries ──
const sA = summarizeError(tbA), sB = summarizeError(tbB), sC = summarizeError(tbC), sD = summarizeError(tbD)
check('d: A headline is the skidl error', sA.headline === "No pins found using R:R1[('p3',)]", sA.headline)
check('d: B headline', sB.headline === "NameError: name 'RED' is not defined", sB.headline)
check('d: C headline', sC.headline === "SyntaxError: '(' was never closed", sC.headline)
check('d: D headline', sD.headline === "KeyError: 'nonexistent_tool'", sD.headline)
check('d: line carried', sA.line === 19 && sB.line === 14 && sD.line === 23)
for (const [n, s] of [['A', sA], ['B', sB], ['D', sD]] as const) {
  check(`d: ${n} detail has no WARNING / temp path`, !s.detail.includes('WARNING') && !s.detail.includes('AppData') && !s.detail.includes('0f1e'), s.detail.split('\n')[0])
}
check('d: user frame reads circuit.py', sB.detail.includes('File "circuit.py", line 14'))
check('d: library frame keeps its package', sD.detail.includes('File "skidl/circuit.py", line 793') && sD.detail.includes('File "circuit.py", line 23'))
check('d: skidl location shortened', sA.detail.includes(' @ circuit.py:19'), sA.detail.split('\n')[0])
const sT = summarizeError('skidl execution timed out')
check('d: server timeout message in Korean, original kept', sT.headline === '실행 시간이 초과되었습니다.' && sT.detail === 'skidl execution timed out' && sT.line === null)
check('d: no parts message', summarizeError('The netlist has no parts.').headline === '넷리스트에 부품이 없습니다.')
check('d: empty output still has a headline', summarizeError('').headline.length > 0)

// ── (e) line ranges and indentation ──
const code = 'a = 1\n    b = 2\n\nc = 3'
const [s2, e2] = lineRange(code, 2)
check('e: lineRange line 2', code.slice(s2, e2) === '    b = 2')
check('e: lineRange first and blank lines', code.slice(...lineRange(code, 1)) === 'a = 1' && code.slice(...lineRange(code, 3)) === '')
check('e: lineRange past the end → last line', code.slice(...lineRange(code, 99)) === 'c = 3')
const apply = (v: string, ed: NonNullable<ReturnType<typeof indentLines>>) => v.slice(0, ed.start) + ed.text + v.slice(ed.end)
const lineOf = (v: string, pos: number) => v.slice(0, pos).split('\n').length
{
  const caret = indentLines(code, 2, 2, false)!
  check('e: caret Tab pads to the next tab stop', apply(code, caret).startsWith('a   = 1') && caret.text === '  ' && caret.selStart === 4)
  // select from inside line 1 to inside line 4 (all four lines)
  const sel: [number, number] = [2, code.length - 2]
  const ind = indentLines(code, sel[0], sel[1], false)!
  const indented = apply(code, ind)
  check('e: indent block', indented === '    a = 1\n        b = 2\n\n    c = 3', JSON.stringify(indented))
  check('e: selection stays on the same lines', lineOf(indented, ind.selStart) === 1 && lineOf(indented, ind.selEnd) === 4)
  const out = indentLines(indented, ind.selStart, ind.selEnd, true)!
  check('e: indent then outdent restores the text', apply(indented, out) === code)
  check('e: outdent selection stays on the same lines', lineOf(code, out.selStart) === 1 && lineOf(code, out.selEnd) === 4)
  check('e: outdent where nothing is indented → no change', indentLines('x\ny', 0, 3, true) === null)
  const caretOut = indentLines(code, 12, 12, true)!
  check('e: Shift+Tab on a caret dedents its line', apply(code, caretOut) === 'a = 1\nb = 2\n\nc = 3' && caretOut.selStart === 8)
  const toLineStart = indentLines(code, 0, 6, false)!
  check('e: selection ending at a line start leaves that line alone', apply(code, toLineStart) === '    a = 1\n    b = 2\n\nc = 3' && toLineStart.selStart === 0 && toLineStart.selEnd === 10)
  const tabbed = indentLines('\tx', 0, 2, true)!
  check('e: outdent removes one tab', apply('\tx', tabbed) === 'x')
}

// ── (f) live: inject a fault into a demo circuit and run it through python + skidl ──
function runPython(source: string): { ok: boolean; stderr: string; why: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-code-view-'))
  try {
    fs.writeFileSync(path.join(tmp, 'circuit.py'), source, 'utf8')
    const r = spawnSync('python', [path.join(tmp, 'circuit.py')], { cwd: tmp, encoding: 'utf8', timeout: 90_000 })
    if (r.error) return { ok: false, stderr: '', why: `python did not start: ${r.error.message}` }
    if (r.status === 0) return { ok: false, stderr: r.stderr, why: 'the faulty script exited 0' }
    return { ok: true, stderr: r.stderr, why: '' }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
{
  const led = fs.readFileSync(path.join(dir, 'led_basic.py'), 'utf8')
  const target = "d1.value = 'RED'"
  const at = led.split('\n').findIndex(l => l.trim() === target) + 1
  check('f: fault target found in led_basic.py', at > 0, `line ${at}`)
  const faulty = led.replace(target, 'd1.value = RED')
  const r = runPython(faulty)
  const skidlOk = !/ModuleNotFoundError: No module named 'skidl'/.test(r.stderr)
  check('f: python + skidl ran the script', r.ok && skidlOk, r.why || (skidlOk ? '' : 'skidl is not installed'))
  check('f: errorLine = line of the faulty statement', errorLine(r.stderr) === at, `${errorLine(r.stderr)} vs ${at}`)
  check('f: headline is the NameError', summarizeError(r.stderr).headline === "NameError: name 'RED' is not defined", summarizeError(r.stderr).headline)
  const shifted = runPython('\n' + faulty)
  check('f: a blank first line shifts the reported line by one', errorLine(shifted.stderr) === at + 1, String(errorLine(shifted.stderr)))
  const open = led.replace("Net('VCC')", "Net('VCC'")
  const openAt = led.split('\n').findIndex(l => l.includes("Net('VCC')")) + 1
  const syn = runPython(open)
  check('f: SyntaxError line from the installed python', errorLine(syn.stderr) === openAt && /SyntaxError/.test(summarizeError(syn.stderr).headline),
    `${errorLine(syn.stderr)} vs ${openAt}: ${summarizeError(syn.stderr).headline}`)
}

// ── (g) contrast of the code view colours (WCAG AA: 4.5:1 for normal text) ──
{
  const read = (f: string) => { const p = path.join(ROOT, 'src', 'styles', f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' }
  const tokens = read('_sf-tokens.scss'), scss = read('_code.scss')
  check('g: styles found', !!tokens && !!scss)
  /** a --sf-* token as [r, g, b, alpha] */
  const colorOf = (name: string | null): number[] | null => {
    const v = name && new RegExp(`--sf-${name}:\\s*([^;]+);`).exec(tokens)?.[1].trim()
    if (!v) return null
    const sass = /^#\{\$(sf-[\w-]+)\}$/.exec(v)
    const hex = sass ? new RegExp(`\\$${sass[1]}:\\s*(#[0-9a-f]{6})`, 'i').exec(tokens)?.[1] : v
    if (hex && /^#[0-9a-f]{6}$/i.test(hex)) return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(1)
    const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(v)
    return rgba ? rgba.slice(1).map(Number) : null
  }
  /** the var(--sf-x) a property takes inside the first block whose selector matches (flat blocks) */
  const varIn = (selector: RegExp, prop: string): string | null => {
    const block = new RegExp(selector.source + '[^{]*\\{([^}]*)\\}').exec(scss)?.[1] ?? ''
    return new RegExp(`(?:^|[;\\s])${prop}:\\s*var\\(--sf-([\\w-]+)\\)`).exec(block)?.[1] ?? null
  }
  const over = (c: number[], base: number[]) => c.slice(0, 3).map((v, i) => v * c[3] + base[i] * (1 - c[3]))
  const lum = (c: number[]) => {
    const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const codeBg = varIn(/\.sf-code-pane\s/, 'background')
  const headBg = varIn(/\.sf-code-head/, 'background')
  const gutterBg = varIn(/\.sf-code-gutter\s/, 'background')
  // [what, text colour, background, surface a translucent background sits on]
  const pairs: [string, string | null, string | null, string | null][] = [
    ['plain code', varIn(/\.sf-code-view/, 'color'), codeBg, null],
    ...(['kw', 'str', 'com', 'num', 'fn'] as const).map(k => [`.tk-${k}`, varIn(new RegExp(`\\.tk-${k}`), 'color'), codeBg, null] as [string, string | null, string | null, null]),
    ['line numbers', varIn(/\.sf-code-gutter\s/, 'color'), gutterBg, null],
    ['error line number', varIn(/\.sf-code-gutter > \.is-error/, 'color'), varIn(/\.sf-code-gutter > \.is-error/, 'background'), gutterBg],
    ['header title', varIn(/\.sf-code-title/, 'color'), headBg, null],
    ['header meta', varIn(/\.sf-code-meta\s/, 'color'), headBg, null],
    ['header changed mark', varIn(/\.sf-code-meta\.is-dirty/, 'color'), headBg, null],
    ['button', varIn(/\.sf-code-btn\s/, 'color'), headBg, null],
    ['button ok', varIn(/\.sf-code-btn\.is-ok/, 'color'), headBg, null],
    ['button failed', varIn(/\.sf-code-btn\.is-bad/, 'color'), headBg, null],
    ['primary button', varIn(/\.sf-code-btn\.is-primary/, 'color'), varIn(/\.sf-code-btn\.is-primary/, 'background'), null],
    ...(['warn', 'ok', 'info'] as const).map(k => [`note ${k}`, varIn(new RegExp(`\\.sf-code-note\\.is-${k}`), 'color'), varIn(new RegExp(`\\.sf-code-note\\.is-${k}`), 'background'), codeBg] as [string, string | null, string | null, string | null]),
    ['error headline', varIn(/\.sf-code-error\s/, 'color'), varIn(/\.sf-code-error\s/, 'background'), codeBg],
    ['error output', varIn(/\.sf-code-error-detail/, 'color'), varIn(/\.sf-code-error\s/, 'background'), codeBg],
    ['empty state', varIn(/\.sf-code-empty/, 'color'), codeBg, null],
    // the guide sits in the drawer, whose background is var(--sf-bg-1) (ResultPanel inline style)
    ['KiCad guide', varIn(/\.sf-kicad-guide\s/, 'color'), 'bg-1', null],
  ]
  for (const [name, fg, bg, base] of pairs) {
    const f = colorOf(fg), b = colorOf(bg), s = base ? colorOf(base) : [255, 255, 255, 1]
    const r = f && b && s ? ratio(f, over(b, s)) : 0
    check(`g: contrast ${name}`, r >= 4.5, f && b && s ? `${fg} on ${bg}${base ? ` over ${base}` : ''} = ${r.toFixed(2)}:1` : `colour not found (${fg} on ${bg})`)
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall code view checks passed')
process.exit(failed ? 1 : 0)
