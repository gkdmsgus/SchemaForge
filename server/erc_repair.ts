// Netlist check (ERC) before any PCB, and the one repair round /generate may run on its errors.
// The model only proposes code. Running it, checking it and keeping or dropping it is decided here.
import { spawn } from 'child_process'
import { join } from 'path'
import { childEnv } from './skidl_run'

/** One finding from server/pcb/erc.py (src/types.ts ErcFinding is the same shape). */
export interface ErcFinding {
  rule: string
  severity: 'error' | 'warning'
  message: string
  /** pin: the footprint pad (floating_pin) or the netlist pin; sym/name: the symbol pin, when known */
  refs: { ref: string; pin: string; sym?: string; name?: string }[]
  net: string | null
}
/** A netlist part as pcb_generator.py --erc-only reports it (without the generator's test points). */
export interface NetPart { ref: string; value: string; part: string }
/** A netlist net (symbol pin numbers), as --erc-only reports it. */
export interface NetNet { name: string; nodes: { ref: string; pin: string }[] }
export type ErcOk = { ok: true; findings: ErcFinding[]; components: NetPart[]; nets: NetNet[] }
/** A check that did not run is ok:false, never an empty list of findings. */
export type ErcRun = ErcOk | { ok: false; reason: string }

/**
 * Error rules the repair round feeds back. unpowered_rail and output_conflict are warnings and stay
 * out: renaming a net would make them disappear without fixing anything.
 */
export const FEEDBACK_RULES = new Set(['floating_pin', 'single_pin_net', 'no_ground'])
export const fixableErrors = (findings: ErcFinding[]) =>
  findings.filter(f => f.severity === 'error' && FEEDBACK_RULES.has(f.rule))

/** The last non-empty line of an error or a traceback, short enough for one status line. */
export function oneLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  const line = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || ''
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

/** Run `pcb_generator.py <net> --erc-only` (cwd holds pcb_generator.py). Never throws. */
export function runErc(netPath: string, cwd: string, timeoutMs = 30000, style: 'smd' | 'tht' = 'smd'): Promise<ErcRun> {
  return new Promise(resolve => {
    const proc = spawn('python', [join(cwd, 'pcb_generator.py'), netPath, '--erc-only', '--style', style],
      { cwd, env: childEnv() })
    const out: Buffer[] = []
    let stderr = ''
    let done = false
    const finish = (r: ErcRun) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    proc.stdout.on('data', (d: Buffer) => { out.push(d) })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => { proc.kill(); finish({ ok: false, reason: `ERC 시간 초과 (${timeoutMs} ms)` }) }, timeoutMs)
    proc.on('error', (e: Error) => finish({ ok: false, reason: `ERC를 시작하지 못했습니다: ${e.message}` }))
    proc.on('close', (code: number | null) => {
      if (code !== 0) return finish({ ok: false, reason: oneLine(stderr) || `ERC가 코드 ${code}로 끝났습니다` })
      try {
        // decode once at the end: a Korean message can straddle two stdout chunks
        const last = Buffer.concat(out).toString('utf8').trim().split('\n').pop() || ''
        const j = JSON.parse(last) as { erc?: unknown; components?: unknown; nets?: unknown }
        if (!Array.isArray(j.erc) || !Array.isArray(j.components) || !Array.isArray(j.nets)) throw new Error('erc/components/nets 없음')
        finish({ ok: true, findings: j.erc as ErcFinding[], components: j.components as NetPart[], nets: j.nets as NetNet[] })
      } catch (e) {
        finish({ ok: false, reason: `ERC 결과를 읽지 못했습니다 (${oneLine(e)})` })
      }
    })
  })
}

/** One key per (rule, ref.pin), or per (rule, net) when a finding names no pin. Errors only. */
export function errorKeys(findings: ErcFinding[]): string[] {
  const keys = new Set<string>()
  for (const f of findings) {
    if (f.severity !== 'error') continue
    // the symbol pin (the code's Pin(num=...)) when known, so notes and status lines match the messages
    if (f.refs.length) for (const r of f.refs) keys.add(`${f.rule} ${r.ref}.${r.sym ?? r.pin}`)
    else keys.add(f.net ? `${f.rule} ${f.net}` : f.rule)
  }
  return [...keys]
}

/** Korean names of the rules, for notes the user reads */
export const RULE_LABEL: Record<string, string> = {
  floating_pin: '연결 안 된 핀', single_pin_net: '한 핀짜리 넷', no_ground: 'GND 없음',
  unpowered_rail: '공급원 없는 전원 넷', output_conflict: '출력 충돌',
}
/** "floating_pin U1.4" → "연결 안 된 핀 U1.4" */
const keyLabel = (k: string) => k.replace(/^(\w+)/, r => RULE_LABEL[r] ?? r)

/**
 * The pins of the original parts that sit on a net, each mapped to the other original pins on the
 * same net (net names may change, so a net is known by who is on it). Pins named in `skip` are left out.
 */
function connections(r: ErcOk, parts: Set<string>, skip: Set<string>): Map<string, string> {
  const groups = new Map<string, string[]>()
  for (const n of r.nets) {
    const pins = n.nodes.map(nd => `${nd.ref}.${nd.pin}`).filter(k => parts.has(k.split('.')[0]) && !skip.has(k)).sort()
    // a pin number can sit on two nets (a template with a repeated pin): keep every group it is in
    for (const k of pins) groups.set(k, [...(groups.get(k) ?? []), pins.join(' ')])
  }
  return new Map([...groups].map(([k, gs]) => [k, gs.sort().join(' | ')]))
}

/** Where the errors are, for a status line: "U1.4, R2.1" (at most four). */
export function errorSites(findings: ErcFinding[]): string {
  const sites = [...new Set(fixableErrors(findings).flatMap(f =>
    f.refs.length ? f.refs.map(r => `${r.ref}.${r.sym ?? r.pin}`) : [f.net || f.rule]))]
  return sites.length > 4 ? `${sites.slice(0, 4).join(', ')} 외 ${sites.length - 4}곳` : sites.join(', ')
}

/**
 * Keep a repair only when (1) it adds no error key, (2) the error keys strictly drop, (3) warnings
 * do not rise, (4) every original part is still there with the same part name and value, and
 * (5) every original pin that was not part of an error is still connected to the same original
 * pins (a fix may wire the broken pins and add parts, not move pins that were already right).
 * Every failed condition is named in `why`.
 */
export function judgeRepair(before: ErcOk, after: ErcOk): { keep: true } | { keep: false; why: string } {
  const why: string[] = []
  const b = new Set(errorKeys(before.findings))
  const a = errorKeys(after.findings)
  const added = a.filter(k => !b.has(k))
  if (added.length) why.push(`새 오류 ${added.map(keyLabel).join(', ')}`)
  if (a.length >= b.size) why.push(`ERC 오류가 줄지 않았습니다 (${b.size} → ${a.length})`)
  const warnings = (r: ErcOk) => r.findings.filter(f => f.severity !== 'error').length
  if (warnings(after) > warnings(before)) why.push(`ERC 경고가 늘었습니다 (${warnings(before)} → ${warnings(after)})`)
  const now = new Map(after.components.map(c => [c.ref, c]))
  const changed = before.components.flatMap(c => {
    const n = now.get(c.ref)
    if (!n) return [`${c.ref} 삭제`]
    return n.part !== c.part || n.value !== c.value ? [`${c.ref} ${c.part} ${c.value} → ${n.part} ${n.value}`] : []
  })
  if (changed.length) why.push(`원래 부품이 바뀌었습니다: ${changed.join(', ')}`)
  // the pins the errors were about may change; a floating pin is named by its symbol pin (sym)
  const sites = new Set(before.findings.filter(f => f.severity === 'error').flatMap(f => f.refs.map(r => `${r.ref}.${r.sym ?? r.pin}`)))
  const parts = new Set(before.components.map(c => c.ref))
  const was = connections(before, parts, sites), is = connections(after, parts, sites)
  // the pin that moved changes its company most (a pin on a net it joined changes by one neighbour)
  const diff = (x: string, y: string | undefined) => {
    const X = new Set(x.split(/ \| | /)), Y = new Set((y ?? '').split(/ \| | /).filter(Boolean))
    return [...X].filter(p => !Y.has(p)).length + [...Y].filter(p => !X.has(p)).length
  }
  const moved = [...was].filter(([k, g]) => is.get(k) !== g)
    .sort((p, q) => diff(q[1], is.get(q[0])) - diff(p[1], is.get(p[0])) || p[0].localeCompare(q[0])).map(([k]) => k)
  if (moved.length) why.push(`맞게 이어져 있던 핀의 연결이 바뀌었습니다: ${moved.slice(0, 6).join(', ')}${moved.length > 6 ? ` 외 ${moved.length - 6}개` : ''}`)
  return why.length ? { keep: false, why: why.join(' / ') } : { keep: true }
}

/** The one message the model gets: the errors, where they are, and what it must not touch. */
export function ercFeedback(errors: ErcFinding[]): string {
  const lines = errors.map(f => {
    const pins = new Map<string, string[]>()
    // the model's code numbers pins by symbol (Pin(num=...)), not by footprint pad
    for (const r of f.refs) pins.set(r.ref, [...(pins.get(r.ref) || []), `${r.sym ?? r.pin}${r.name ? ` (${r.name})` : ''}`])
    const where = [...pins].map(([ref, ps]) => `${ref} pin ${ps.join(', ')}`).join('; ')
    return `- ${f.rule}${where ? ` ${where}` : ''}${f.net ? ` (net '${f.net}')` : ''}: ${f.message}`
  })
  return 'The code above runs, but the netlist check (ERC) found these errors:\n' + lines.join('\n') + '\n' +
    'Fix exactly these connections, following the wiring rules in SECTION 1. Keep every existing Part() ' +
    'with the same ref prefix, name, value and pins=[...] list, in the same order; do not delete parts or ' +
    'pins to make an error go away. If a fix needs a new part, add it after the existing ones. ' +
    'Output corrected code + ---GUIDE--- + Korean guide.'
}

/** Remove a wrapping ```...``` markdown fence, if the model emitted one. */
export function stripFences(text: string): string {
  const t = text.trim()
  if (!t.startsWith('```')) return t
  const lines = t.split('\n')
  lines.shift()
  if (lines[lines.length - 1]?.trim().startsWith('```')) lines.pop()
  return lines.join('\n').trim()
}

/** Split a model answer into code and guide; an answer without ---GUIDE--- keeps fallbackGuide. */
export function splitOutput(raw: string, fallbackGuide: string): { code: string; guide: string } {
  const [code, guide] = raw.includes('---GUIDE---')
    ? raw.split('---GUIDE---', 2).map(s => s.trim())
    : [raw.trim(), '']
  return { code: stripFences(code), guide: guide || fallbackGuide }
}

export interface RepairInput { code: string; guide: string; netPath: string; erc: ErcOk }
export interface RepairDeps {
  ask(feedback: string): Promise<string>
  run(code: string): Promise<string>
  erc(netPath: string): Promise<ErcRun>
}
/** discard is the losing .net (the repaired one when it is dropped); the caller deletes it. */
export interface RepairOutcome extends RepairInput {
  kept: boolean
  note: string
  before: number
  after: number
  discard: string | null
}

/** One repair attempt: exactly one model call, no retries, the original kept unless the judge says so. */
export async function repairErc(cur: RepairInput, deps: RepairDeps): Promise<RepairOutcome> {
  const before = errorKeys(cur.erc.findings).length
  const original = (note: string, discard: string | null = null, after = before): RepairOutcome =>
    ({ ...cur, kept: false, note, before, after, discard })

  let raw: string
  try { raw = await deps.ask(ercFeedback(fixableErrors(cur.erc.findings))) } catch (e) {
    return original(`모델 호출 실패: ${oneLine(e)}`)
  }
  const next = splitOutput(raw, cur.guide)
  if (!next.code.startsWith('from skidl')) return original('모델 답에 skidl 코드가 없습니다')
  let netPath: string
  try { netPath = await deps.run(next.code) } catch (e) {
    return original(`고친 코드가 실행되지 않았습니다: ${oneLine(e)}`)
  }
  let erc: ErcRun
  try { erc = await deps.erc(netPath) } catch (e) { erc = { ok: false, reason: oneLine(e) } }
  if (!erc.ok) return original(`고친 넷리스트를 점검하지 못했습니다: ${erc.reason}`, netPath)
  const after = errorKeys(erc.findings).length
  const verdict = judgeRepair(cur.erc, erc)
  if (!verdict.keep) return original(verdict.why, netPath, after)
  return { code: next.code, guide: next.guide, netPath, erc, kept: true,
           note: `오류 ${before} → ${after}`, before, after, discard: cur.netPath }
}

/** Deterministic stand-in for the model (SF_AI_STUB=1): ties NE555 RESET to VCC. */
export function stubErcFix(code: string): string {
  return code.replace(/^generate_netlist\(\)/m, "u1['RESET'] += vcc\ngenerate_netlist()")
}
