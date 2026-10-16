// Helpers for the Code tab (components/CodeEditor.tsx): Python highlighting, reading the
// error output of a skidl run, and Tab indentation in the editor. Pure functions, checked
// by scripts/check_code_view.ts.

export type TokKind = 'kw' | 'str' | 'com' | 'num' | 'fn' | 'txt'
export interface Tok { k: TokKind; t: string }

const KW = new Set(('False None True and as assert async await break class continue def del elif else except ' +
  'finally for from global if import in is lambda nonlocal not or pass raise return try while with yield').split(' '))
// comment | string (optional prefix; triple-quoted runs to the end of the text when unterminated,
// single-quoted to the end of the line) | number | name | any other single character
const TOKEN = /(#[^\n]*)|((?:[rRbBuU]|[fF][rR]?|[rR][fFbB]|[bB][rR])?(?:'''[\s\S]*?(?:'''|$)|"""[\s\S]*?(?:"""|$)|'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?))|(\b0[xX][\da-fA-F_]+|\b0[oO][0-7_]+|\b0[bB][01_]+|\b\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?[jJ]?|\.\d+)|([A-Za-z_]\w*)|([\s\S])/gy

/** Python source → tokens per line. Lossless: joining every line's text with '\n' gives the input back. */
export function tokenizePython(code: string): Tok[][] {
  const lines: Tok[][] = [[]]
  const push = (k: TokKind, text: string) => {
    text.split('\n').forEach((seg, i) => {
      if (i > 0) lines.push([])
      if (!seg) return
      const line = lines[lines.length - 1]
      const last = line[line.length - 1]
      if (last && last.k === 'txt' && k === 'txt') last.t += seg
      else line.push({ k, t: seg })
    })
  }
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while (TOKEN.lastIndex < code.length && (m = TOKEN.exec(code))) {
    if (m[1]) push('com', m[1])
    else if (m[2]) push('str', m[2])
    else if (m[3]) push('num', m[3])
    else if (m[4]) push(KW.has(m[4]) ? 'kw' : code[TOKEN.lastIndex] === '(' ? 'fn' : 'txt', m[4])
    else push('txt', m[5])
  }
  return lines
}

/** ANSI colour codes (Python 3.13+ colours tracebacks when FORCE_COLOR is set) */
const ANSI = /\x1b\[[0-9;]*m/g

/** Line in the user's script where Python stopped, from its stderr; null if there is none.
 *  The script is the first `File "..."` in the output (Python prints the outermost frame first);
 *  frames in other files are skipped, which matters because skidl ships its own circuit.py. */
export function errorLine(stderr: string): number | null {
  stderr = stderr.replace(ANSI, '')
  const frames = [...stderr.matchAll(/File "([^"]+)", line (\d+)/g)]
  if (frames.length) {
    const script = frames[0][1]
    const mine = frames.filter(f => f[1] === script)
    return Number(mine[mine.length - 1][2])
  }
  // skidl's own "ERROR: ... @ [<script>:19]" when Python printed no traceback
  const sk = /^ERROR:.*@ \[([^\]]+?\.py):(\d+)\]/m.exec(stderr)
  return sk ? Number(sk[2]) : null
}

/** Messages the server itself sends instead of Python output (server/index.ts runSkidl, /test_code). */
const SERVER_MESSAGES: Record<string, string> = {
  'skidl execution timed out': '실행 시간이 초과되었습니다.',
  'No netlist file was generated.': '넷리스트 파일이 만들어지지 않았습니다. 코드 끝에 generate_netlist()가 있는지 확인하세요.',
  'The netlist has no parts.': '넷리스트에 부품이 없습니다.',
  'No code provided.': '실행할 코드가 없습니다.',
}

/** `C:\...\Temp\<id>\circuit.py` → `circuit.py`; a library file keeps its package: `skidl/circuit.py`. */
function shortPath(p: string): string {
  const lib = /[\\/](?:site|dist)-packages[\\/](.+)$/.exec(p)
  return lib ? lib[1].replace(/\\/g, '/') : p.split(/[\\/]/).pop() || p
}

export interface CodeError { headline: string; detail: string; line: number | null }

/** Short headline plus readable detail: skidl's start-up WARNING lines dropped, temp paths shortened. */
export function summarizeError(stderr: string): CodeError {
  const raw = stderr.replace(ANSI, '').replace(/\r/g, '').trim()
  if (SERVER_MESSAGES[raw]) return { headline: SERVER_MESSAGES[raw], detail: raw, line: null }
  const kept = raw.split('\n').filter(l => !l.startsWith('WARNING: '))
  const detail = kept.join('\n')
    .replace(/File "([^"]+)"/g, (_, p: string) => `File "${shortPath(p)}"`)
    .replace(/ @ \[([^\]]+?):(\d+)\]/g, (_, p: string, n: string) => ` @ ${shortPath(p)}:${n}`)
    .trim()
  const skidlErr = kept.find(l => l.startsWith('ERROR: '))
  const last = [...kept].reverse().find(l => /^\w[\w.]*(Error|Exception|Exit|Interrupt)\b|^\w+Error:/.test(l))
  const headline = skidlErr ? skidlErr.replace(/^ERROR: /, '').replace(/ @ \[.*\]$/, '')
    : last ?? kept.find(l => l.trim())?.trim() ?? '실행이 실패했습니다 (출력 없음).'
  return { headline, detail, line: errorLine(stderr) }
}

/** [start, end) character offsets of a 1-based line; past the end, the last line. */
export function lineRange(code: string, line: number): [number, number] {
  let start = 0
  for (let i = 1; i < line; i++) {
    const nl = code.indexOf('\n', start)
    if (nl < 0) break
    start = nl + 1
  }
  const nl = code.indexOf('\n', start)
  return [start, nl < 0 ? code.length : nl]
}

export const INDENT = 4

/** Replace value[start, end) with text, then select [selStart, selEnd). */
export interface IndentEdit { start: number; end: number; text: string; selStart: number; selEnd: number }

/**
 * Tab / Shift+Tab in the editor. A caret with no selection gets spaces up to the next tab stop;
 * otherwise every line the selection touches is indented by 4 spaces (blank lines left alone) or
 * loses up to 4 leading spaces (or one tab). A selection ending at the start of a line leaves that
 * line alone. Returns null when nothing would change.
 */
export function indentLines(value: string, selStart: number, selEnd: number, outdent: boolean): IndentEdit | null {
  if (selStart > selEnd) [selStart, selEnd] = [selEnd, selStart]
  const lineStart = value.lastIndexOf('\n', selStart - 1) + 1
  if (!outdent && selStart === selEnd) {
    const pad = ' '.repeat(INDENT - ((selStart - lineStart) % INDENT))
    const at = selStart + pad.length
    return { start: selStart, end: selStart, text: pad, selStart: at, selEnd: at }
  }
  const lastPos = selEnd > selStart && value[selEnd - 1] === '\n' ? selEnd - 1 : selEnd
  const nl = value.indexOf('\n', lastPos)
  const blockEnd = nl < 0 ? value.length : nl
  const lines = value.slice(lineStart, blockEnd).split('\n')
  const deltas = lines.map(l => (outdent ? -(/^( {1,4}|\t)/.exec(l)?.[0].length ?? 0) : l.length ? INDENT : 0))
  if (deltas.every(d => d === 0)) return null
  const text = lines.map((l, i) => (deltas[i] < 0 ? l.slice(-deltas[i]) : ' '.repeat(deltas[i]) + l)).join('\n')
  const total = deltas.reduce((a, d) => a + d, 0)
  // where an old offset lands in the new text; keepStart keeps a selection that began at column 0 there
  const map = (pos: number, keepStart: boolean) => {
    if (pos > blockEnd) return pos + total
    let oldOff = lineStart, newOff = lineStart
    for (let i = 0; i < lines.length; i++) {
      if (pos <= oldOff + lines[i].length) {
        const col = pos - oldOff, d = deltas[i]
        return newOff + (d < 0 ? Math.max(0, col + d) : keepStart && col === 0 ? 0 : col + d)
      }
      oldOff += lines[i].length + 1
      newOff += lines[i].length + deltas[i] + 1
    }
    return pos + total
  }
  const multi = selStart !== selEnd
  return { start: lineStart, end: blockEnd, text, selStart: map(selStart, multi), selEnd: map(selEnd, false) }
}

/** A textarea reports its value with '\n' only, so code with '\r\n' (a file read on Windows)
 *  is compared and edited in this form. */
export function toLF(code: string): string {
  return code.replace(/\r\n?/g, '\n')
}

/** The Code tab's draft, kept by ResultPanel so switching drawer tabs does not lose it. */
export interface CodeEdit {
  text: string
  error: CodeError | null
  /** a run of this text is in flight (the textarea is read-only meanwhile) */
  running?: boolean
}
