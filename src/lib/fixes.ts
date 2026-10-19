import type { BoardModel, ErcFinding, NetGraph } from '../types'
import { operatingChecks, parseOhms, type OpCircuit, type OpResult, type OpState } from './operatingCheck'
import { ASSUMED, PIN_NAMES, josa } from './humanReview'

// A fix next to a warning: what to change, in plain words, and where the code can do it the skidl lines
// that make the change (the Code tab runs them and the checks judge the result; nothing is applied here).
// The AI only ever proposes; these fixes come from rules and from re-running the checks on a changed copy.

export interface Fix {
  text: string
  /** skidl lines that make the change, put before generate_netlist() in the Code tab; none = words only */
  lines?: string[]
  /** exact: the rule or a re-run check says so; likely: the structure points at it; hint: where to look */
  sure: 'exact' | 'likely' | 'hint'
}

// ── shared ─────────────────────────────────────────────────────────────────────

/** the netlist check's ground names (server/pcb/erc.py rule 3) */
const GROUND = /^(GND|AGND|DGND|PGND)$/i

/** python string literal for a ref or a net name */
const py = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** "으로/로" after a word read aloud: 로 after a vowel or ㄹ (470으로, 1k로, 68로) */
export function ro(word: string): string {
  const c = word.trim().slice(-1)
  const code = c.charCodeAt(0)
  const rieul = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 === 8 : /[178LlRr]/.test(c)
  return rieul ? `${word}로` : josa(word, '으로', '로')
}

/** The netlist graph of a finished board: pads mapped back to template pins (what the code and checks use). */
export function graphFromBoard(final: Pick<BoardModel, 'parts'>): NetGraph {
  const nets = new Map<string, { ref: string; pin: string }[]>()
  for (const p of final.parts) for (const pd of p.pads) {
    const pin = p.pad_pins?.[pd.num]
    if (!pd.net || pin == null) continue
    const list = nets.get(pd.net) ?? []
    if (!list.some(n => n.ref === p.ref && n.pin === String(pin))) list.push({ ref: p.ref, pin: String(pin) })
    nets.set(pd.net, list)
  }
  return {
    components: final.parts.map(p => ({ ref: p.ref, value: p.value, name: p.part })),
    nets: [...nets].map(([name, nodes]) => ({ name, nodes })),
  }
}

/**
 * The code with fix lines put right before the last generate_netlist() call, under a comment that says why.
 * null when the code has no generate_netlist() line (nowhere safe to put them).
 */
export function draftWith(code: string, lines: string[], note: string): string | null {
  const text = code.replace(/\r\n/g, '\n')
  const at = [...text.matchAll(/^([ \t]*)generate_netlist\s*\(/gm)].pop()
  if (!at || at.index == null || !lines.length) return null
  const indent = at[1]
  const block = [`# 고침: ${note}`, ...lines].map(l => indent + l).join('\n')
  return `${text.slice(0, at.index)}${block}\n${text.slice(at.index)}`
}

// ── netlist check (ERC) ────────────────────────────────────────────────────────

const pinName = (part: string | undefined, sym: string) => {
  const n = part ? PIN_NAMES[part]?.[Number(sym) - 1] : undefined
  return n ? `${n} 핀(${sym}번)` : `${sym}번 핀`
}

/**
 * One fix per netlist-check finding (null where there is nothing to say). A floating pin and a one-pin net
 * that are the same break share one fix object.
 * - exact: the part template fixes the answer (a 555's RESET goes with its VCC pin, a GND pin goes to GND)
 * - likely: one floating pin and one cut net on different parts: joining them clears both
 * - hint: where such a pin usually goes
 */
export function ercFixes(findings: ErcFinding[], g: NetGraph | null | undefined): (Fix | null)[] {
  if (!g) return findings.map(() => null)
  const tpl = new Map(g.components.map(c => [c.ref, c.name]))
  const netOf = (ref: string, pin: string | number) => g.nets.find(n => n.nodes.some(nd => nd.ref === ref && String(nd.pin) === String(pin)))?.name ?? null
  const ground = g.nets.find(n => n.name.toUpperCase() === 'GND')?.name ?? g.nets.find(n => GROUND.test(n.name))?.name ?? null
  const join = (ref: string, sym: string, net: string) => `Part.get(${py(ref)})[${sym}] += Net.fetch(${py(net)})`

  const floating = findings.map((f, i) => ({ f, i })).filter(x => x.f.rule === 'floating_pin' && x.f.severity === 'error')
  const cut = findings.map((f, i) => ({ f, i })).filter(x => x.f.rule === 'single_pin_net' && x.f.refs.length === 1 && x.f.net)
  const out: (Fix | null)[] = findings.map(() => null)

  // the template decides where a pin goes
  const ruled = (ref: string, sym: string): { net: string; why: string } | null => {
    const part = tpl.get(ref)
    if (part === 'NE555') {
      const vcc = netOf(ref, 8)
      if (sym === '4' && vcc) return { net: vcc, why: `RESET은 쓰지 않으면 8번(VCC) 핀과 같은 선에 묶어 둡니다. 리셋 버튼을 달 거라면 10 kΩ 저항을 거쳐 잇습니다.` }
      if (sym === '1' && ground) return { net: ground, why: '555의 1번 핀은 GND입니다.' }
    }
    if (part === 'REG' && sym === '1' && ground) return { net: ground, why: '레귤레이터의 GND 핀은 GND 선에 잇습니다.' }
    if (part === 'Battery' && sym === '2' && ground) return { net: ground, why: '배터리 − 단자는 GND 선입니다.' }
    return null
  }
  const hint = (ref: string, sym: string): string => {
    const part = tpl.get(ref)
    if (part === 'LED') return sym === '2' ? 'LED의 K(−)는 보통 GND 쪽이나 트랜지스터 컬렉터에 잇습니다.' : 'LED의 A(+)는 보통 저항을 거쳐 전원 쪽에 잇습니다.'
    if (part === 'NE555' && sym === '5') return '555의 CTRL(5번)은 10 nF 커패시터를 거쳐 GND에 잇습니다.'
    if (part === 'NE555' && (sym === '2' || sym === '6')) {
      const other = netOf(ref, sym === '2' ? 6 : 2)
      return `깜빡이(비안정) 회로라면 555의 2번(TRIG)과 6번(THRES)은 같은 선${other ? `(${other})` : ''}에 잇습니다.`
    }
    return '회로에서 이 핀이 이어져야 할 선을 찾아 잇습니다.'
  }

  // one floating pin and one cut net, on different parts: the same break seen from both ends
  const pairable = floating.length === 1 && floating[0].f.refs.length === 1 && cut.length === 1
    && cut[0].f.refs[0].ref !== floating[0].f.refs[0].ref
  for (const { f, i } of floating) {
    if (f.refs.length !== 1) {
      // several open pins on one part: each gets its own line where the template knows the answer
      const lines: string[] = [], why: string[] = []
      for (const r of f.refs) {
        const sym = r.sym ?? r.pin, at = ruled(r.ref, sym)
        if (at) { lines.push(join(r.ref, sym, at.net)); why.push(`${pinName(tpl.get(r.ref), sym)} → ${at.net}`) }
      }
      out[i] = lines.length
        ? { text: `정해진 자리가 있는 핀부터 잇습니다: ${why.join(', ')}. 나머지 핀은 회로에서 이어져야 할 선을 찾아 잇습니다.`, lines, sure: 'exact' }
        : { text: '이 핀들이 이어져야 할 선을 회로에서 찾아 잇습니다.', sure: 'hint' }
      continue
    }
    const r = f.refs[0], sym = r.sym ?? r.pin, name = pinName(tpl.get(r.ref), sym)
    const at = ruled(r.ref, sym)
    if (at) { out[i] = { text: `${r.ref}의 ${name}을 ${at.net} 선에 잇습니다. ${at.why}`, lines: [join(r.ref, sym, at.net)], sure: 'exact' }; continue }
    if (pairable) {
      const c = cut[0], cr = c.f.refs[0], csym = cr.sym ?? cr.pin
      const fix: Fix = {
        text: `${c.f.net} 선에는 ${cr.ref}의 ${pinName(tpl.get(cr.ref), csym)} 하나만 붙어 끊겨 있습니다. ${r.ref}의 ${name}을 ${c.f.net} 선에 이으면 둘 다 풀릴 가능성이 큽니다. ${hint(r.ref, sym)}`,
        lines: [join(r.ref, sym, c.f.net!)], sure: 'likely',
      }
      out[i] = fix
      out[c.i] = fix
      continue
    }
    out[i] = { text: `${r.ref}의 ${name}이 어디에도 이어져 있지 않습니다. ${hint(r.ref, sym)}`, sure: 'hint' }
  }
  for (const { f, i } of cut) {
    if (out[i]) continue
    const r = f.refs[0], sym = r.sym ?? r.pin
    out[i] = { text: `${f.net} 선에 ${r.ref}의 ${pinName(tpl.get(r.ref), sym)} 하나만 붙어 있습니다. 이 선에 이어야 할 핀을 연결하거나, 필요 없는 선이면 지웁니다.`, sure: 'hint' }
  }
  findings.forEach((f, i) => {
    if (out[i] || f.rule !== 'no_ground') return
    // the net a battery minus, a regulator GND or a 555 GND pin is on: the circuit's ground under another name
    const grounds = g.components.flatMap(c => (c.name === 'Battery' ? [netOf(c.ref, 2)] : c.name === 'REG' || c.name === 'NE555' ? [netOf(c.ref, 1)] : []))
      .filter((n): n is string => !!n)
    const named = [...new Set(grounds)]
    out[i] = named.length === 1
      ? { text: `GND 선이 없습니다. 배터리 − 단자 등이 붙은 '${named[0]}' 선의 이름을 GND로 바꿉니다 (코드의 Net('${named[0]}')를 Net('GND')로).`, sure: 'likely' }
      : { text: 'GND 선이 없습니다. 배터리나 전원 커넥터의 − 단자를 GND라는 이름의 선에 잇습니다.', sure: 'hint' }
  })
  return out
}

// ── operating checks ───────────────────────────────────────────────────────────

const RANK: Record<OpState, number> = { pass: 0, unknown: 1, warn: 2, error: 3 }
const keyOf = (r: Pick<OpResult, 'rule' | 'ref'>) => `${r.rule}|${r.ref}`
const E12 = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2]
/** standard resistor values 1 Ω .. 8.2 MΩ */
const LADDER = [0, 1, 2, 3, 4, 5, 6].flatMap(d => E12.map(m => Math.round(m * 10 ** d * 10) / 10))

/** 470 -> "470", 4700 -> "4.7k", 1.2e6 -> "1.2M": how the generated code writes resistor values */
export function ohmsText(v: number): string {
  const t = (x: number) => String(Number(x.toPrecision(2)))
  return v >= 1e6 ? `${t(v / 1e6)}M` : v >= 1e3 ? `${t(v / 1e3)}k` : t(v)
}

/** the one resistor in series with a part (sharing a net with its pin 1 or 2), or null when none or several */
function seriesResistor(c: OpCircuit, ref: string): string | null {
  const nets = [c.pins.get(`${ref}.1`), c.pins.get(`${ref}.2`)].filter(Boolean)
  const rs = c.parts.filter(p => p.part === 'R' && [1, 2].some(n => nets.includes(c.pins.get(`${p.ref}.${n}`))))
  return rs.length === 1 ? rs[0].ref : null
}

/**
 * Fixes the checks themselves confirm: for an LED whose current is wrong, the standard resistor value nearest
 * the present one with which the LED check passes, the resistor's own heat check passes and no other result
 * gets worse (a value picked for 20 mA alone can overheat a 125 mW SMD resistor, so every candidate is re-checked).
 * Keyed rule|ref.
 */
export function opFixes(c: OpCircuit, results: OpResult[]): Map<string, Fix> {
  const out = new Map<string, Fix>()
  const before = new Map(results.map(r => [keyOf(r), RANK[r.state]]))
  for (const r of results) {
    if (r.rule !== 'op_led' || (r.state !== 'error' && r.state !== 'warn') || r.cause) continue
    const rRef = seriesResistor(c, r.ref)
    const rPart = rRef ? c.parts.find(p => p.ref === rRef) : undefined
    const now = rPart ? parseOhms(rPart.value) : null
    if (!rRef || !rPart || now == null || now <= 0) continue
    // nearest first: a smaller change is easier to trust and to buy
    const tries = LADDER.filter(v => Math.abs(v - now) > now * 0.01).sort((a, b) => Math.abs(Math.log(a / now)) - Math.abs(Math.log(b / now)))
    for (const v of tries) {
      const text = ohmsText(v)
      const rs = operatingChecks({ ...c, parts: c.parts.map(p => (p.ref === rRef ? { ...p, value: text } : p)) })
      const led = rs.find(x => x.rule === 'op_led' && x.ref === r.ref)
      const heat = rs.find(x => x.rule === 'op_rpower' && x.ref === rRef)
      if (!led || led.state !== 'pass' || (heat && heat.state !== 'pass')) continue
      if (rs.some(x => RANK[x.state] > (before.get(keyOf(x)) ?? 0))) continue
      const style = c.style ? `${c.style.toUpperCase()} 부품 기준` : '부품 기준'
      out.set(keyOf(r), {
        text: `${rRef} 값을 ${ro(text)} 바꾸면 동작 검사를 통과합니다 (지금 ${rPart.value}, ${style}). 저항 발열도 함께 다시 확인한 값입니다.`,
        lines: [`Part.get(${py(rRef)}).value = ${py(text)}`], sure: 'exact',
      })
      break
    }
  }
  return out
}

/** The results with a fix text filled in: the computed fix, else for a result caused by another part, where to look. */
export function withFixes(results: OpResult[], fixes: Map<string, Fix>): OpResult[] {
  return results.map(r => {
    if (r.state === 'pass' || r.fix) return r
    const f = fixes.get(keyOf(r))
    if (f) return { ...r, fix: f.text }
    if (r.cause && r.cause !== r.ref) return { ...r, fix: `${r.cause}의 문제를 먼저 고치면 이 항목도 다시 판단합니다.` }
    return r
  })
}

// ── generator warnings ─────────────────────────────────────────────────────────

/**
 * A transistor or regulator wired with another part's pinout ("Q1 (2N3904): wired with the MMBT3904 pinout for SMD"):
 * when the other style's assumed part is the one the circuit names, building in that style matches it.
 */
export function pinoutStyleFix(part: string, value: string, style: 'smd' | 'tht'): 'smd' | 'tht' | null {
  const other = style === 'smd' ? 'tht' : 'smd'
  const assumed = ASSUMED[part]?.[other]
  if (!assumed) return null
  const family = /xx$/i.test(assumed) ? new RegExp(`${assumed.slice(0, -2).replace(/^[A-Z]+/i, '')}\\d\\d`, 'i') : null
  return (family ? family.test(value) : value.toUpperCase().includes(assumed.toUpperCase())) ? other : null
}
