import type { ChatAction, NetGraph } from '../types'
import { typeLabel } from './bom'
import { PIN_NAMES } from './humanReview'

/**
 * The AI editor's actions on the schematic graph. A pin sits on one net only, so connecting it to a net
 * (add_net) moves it there: into the net of that name when one exists (a second "VCC" with just the pin
 * would leave it as cut off as before), off the net it was on, and a net left with no pins goes.
 */
/**
 * A pin as the netlist numbers it: the AI editor sometimes writes the template's pin name (LED "K", battery "-",
 * a resistor's "p2") where the netlist has the number; anything else is kept as written.
 */
export function pinNumber(part: string | undefined, pin: string): string {
  const p = String(pin).trim()
  if (/^\d+$/.test(p)) return p
  const m = /^p(\d+)$/i.exec(p)
  if (m) return m[1]
  const names = part ? PIN_NAMES[part] : undefined
  const at = names ? names.findIndex(n => n.toUpperCase() === p.replace('−', '-').toUpperCase()) : -1
  return at >= 0 ? String(at + 1) : p
}

/**
 * The circuit to open a browser-saved entry with: its own copy when that differs in value from the generated one (an
 * edit, which opening result.graph lost, with its chat chips still shown: review of 2026-11-06), else the generated
 * object itself, since the screen tells an edit by the object (ResultPanel aiEdited) and a chat with no change saves a copy.
 */
export function savedGraph(entry: { graph?: NetGraph | null; result?: { graph?: NetGraph } }): NetGraph | undefined {
  const made = entry.result?.graph
  return entry.graph && JSON.stringify(entry.graph) !== JSON.stringify(made) ? entry.graph : made
}

export function applyActions(graph: NetGraph, actions: ChatAction[]): NetGraph {
  let comps = [...(graph.components || [])]
  let nets = (graph.nets || []).map(n => ({ ...n, nodes: [...n.nodes] }))
  const same = (a: { ref: string; pin: string }, b: { ref: string; pin: string }) => a.ref === b.ref && String(a.pin) === String(b.pin)
  for (const a of actions) {
    if (a.type === 'add_component') {
      // a part needs its reference: one added with ref "" (seen live, 2026-10-29) was saved to the history and
      // stopped the schematic from drawing whenever it was opened. skippedAdds tells the chat about it.
      const ref = (a.ref || '').trim()
      if (ref && !comps.find(c => c.ref === ref)) comps = [...comps, { ref, name: (a.name || '').trim() || ref, value: a.value || '' }]
    } else if (a.type === 'remove_component') {
      comps = comps.filter(c => c.ref !== a.ref)
      nets = nets.map(n => ({ ...n, nodes: n.nodes.filter(nd => nd.ref !== a.ref) })).filter(n => n.nodes.length > 0)
    } else if (a.type === 'modify_component') {
      comps = comps.map(c => (c.ref === a.ref ? { ...c, ...(a.value !== undefined ? { value: a.value } : {}) } : c))
    } else if (a.type === 'add_net') {
      const add = (a.nodes || []).filter(nd => (nd.ref || '').trim())
        .map(nd => ({ ref: nd.ref.trim(), pin: pinNumber(comps.find(c => c.ref === nd.ref.trim())?.name, String(nd.pin)) }))
        .filter((nd, i, all) => all.findIndex(x => same(x, nd)) === i)
      // the model sometimes leaves the name out (seen with gpt-4o-mini on "connect D1 K to GND"): the net its
      // listed pins already share is the one meant; with none, a fresh name (never an empty one)
      let name = (a.name || '').trim()
      if (!name) {
        const shared = nets.map(n => ({ n, k: n.nodes.filter(nd => add.some(x => same(x, nd))).length })).filter(x => x.k > 0).sort((p, q) => q.k - p.k)[0]
        name = shared?.n.name ?? `NET_${nets.length + 1}`
        while (!shared && nets.some(n => n.name === name)) name = `${name}_`
      }
      nets = nets.map(n => (n.name === name ? n : { ...n, nodes: n.nodes.filter(nd => !add.some(x => same(x, nd))) }))
        .filter(n => n.name === name || n.nodes.length > 0)
      const at = nets.findIndex(n => n.name === name)
      if (at >= 0) nets[at] = { ...nets[at], nodes: [...nets[at].nodes, ...add.filter(x => !nets[at].nodes.some(nd => same(nd, x)))] }
      // no pins, no net (2026-11-06 sweep: an empty NEW counted as a changed circuit: an undo step, a stale PCB, no word of it)
      else if (add.length) nets = [...nets, { name, nodes: add }]
    } else if (a.type === 'remove_net') {
      nets = nets.filter(n => n.name !== a.name)
    }
  }
  return { ...graph, components: comps, nets }
}

/**
 * The part types the AI editor is told to use (server/index.ts), and a few words for them, → reference prefix and the
 * template (the name the PCB's footprint table goes by: server/pcb/footprints_table.py). A word that decides no one
 * template (Q, U, conn, SW_SPDT) has none: the part keeps it and is reported unmapped, never put on a guessed footprint.
 */
const PREFIXES: [RegExp, string, string?][] = [
  [/^(R|resistor|저항)$/i, 'R', 'R'], [/^(C|capacitor|커패시터|콘덴서)$/i, 'C', 'C'], [/^CP$/i, 'C', 'CP'], [/^(L|inductor|인덕터)$/i, 'L', 'L'],
  [/^LED$/i, 'D', 'LED'], [/^(D|diode|다이오드)$/i, 'D', 'D'], [/^Q_NPN$/i, 'Q', 'Q_NPN'], [/^Q_NMOS$/i, 'Q', 'Q_NMOS'], [/^Q(_|$)/i, 'Q'],
  [/^NE555$/i, 'U', 'NE555'], [/^REG$/i, 'U', 'REG'], [/^U$/i, 'U'], [/^(SW|switch|스위치)$/i, 'SW', 'SW'], [/^SW/i, 'SW'], [/^(relay|릴레이)$/i, 'K', 'Relay'],
  [/^(buzzer|버저|부저)$/i, 'LS', 'Buzzer'], [/^(battery|배터리|전지)$/i, 'BT', 'Battery'], [/^(crystal|크리스탈)$/i, 'Y', 'Crystal'], [/^conn/i, 'J'],
]
const refPrefix = (ref: string) => ref.replace(/\d+$/, '')

/**
 * the kind a value's unit tells: C, L or R, each its own template and reference prefix. The whole value is a number and a
 * unit: this picks a footprint, and a part number can end like one (LM7805F, 2N3904H) or read like 2n2 in lower case
 * (1n4148, 2n7000), so a letter for the point has one digit after it
 */
function kindOfValue(value?: string): string | null {
  const v = (value || '').trim()
  if (/^\d+(\.\d+)?\s*[pnuµμm]?[fF]$/.test(v) || /^\d+[pnuµμ]\d$/.test(v)) return 'C'
  if (/^\d+(\.\d+)?\s*[nuµμm]?H$/.test(v)) return 'L'
  if (/^\d+(\.\d+)?\s*[mkKM]?\s*(Ω|ohms?)$/i.test(v) || /^\d+(\.\d+)?\s*[kKMR]$/.test(v) || /^\d+[kKMRr]\d+$/.test(v)) return 'R'
  return null
}

function prefixOf(name?: string, value?: string): string | null {
  const n = (name || '').trim()
  for (const [re, p] of PREFIXES) if (re.test(n)) return p
  return kindOfValue(value)
}

/** the name an added part is saved under: its template, by its value's unit when it has no name; a name that decides none as written */
function templateOf(name?: string, value?: string): string | undefined {
  const n = (name || '').trim()
  return n ? PREFIXES.find(([re]) => re.test(n))?.[2] ?? n : kindOfValue(value) ?? undefined
}

/**
 * The edit with a reference on every part it adds. The model sometimes leaves it out (live, 2026-10-30: "출력 쪽에
 * 100nF 커패시터를 하나 추가해줘" gave the capacitor no ref but put C3.1 on VOUT, so the net pointed at a part that
 * was never added). The code names it: the one reference of that kind the edit's nets use and no part has, else
 * the next free number of its kind (C3 after C1 and C2). A part whose kind it cannot tell keeps none (skippedAdds).
 * A net pin with no reference goes to the one part named here, when there is just one.
 * Every part it adds is saved under its template (2026-11-06 sweep: {value: '100nF'} was saved as a part named C2, and
 * 'capacitor', 'relay' and '저항' as written: on the schematic a capacitor, on the board no footprint, to the operating
 * check no part at all, so 22uF added that way read "출력 커패시터 0 µF").
 */
export function withRefs(graph: NetGraph, actions: ChatAction[]): ChatAction[] {
  const taken = new Set((graph.components || []).map(c => c.ref))
  for (const a of actions) if (a.type === 'add_component' && (a.ref || '').trim()) taken.add((a.ref || '').trim())
  const unknown = [...new Set(actions.flatMap(a => (a.type === 'add_net' ? (a.nodes || []).map(nd => (nd.ref || '').trim()) : [])))]
    .filter(r => r && !taken.has(r))
  const given: string[] = []
  const out = actions.map(action => {
    if (action.type !== 'add_component') return action
    const name = templateOf(action.name, action.value)
    const a = name ? { ...action, name } : action
    if ((a.ref || '').trim()) return a
    const p = prefixOf(a.name, a.value)
    let ref = unknown.find(r => !taken.has(r) && (p ? refPrefix(r) === p : unknown.length === 1))
    if (!ref && p) ref = p + (Math.max(0, ...[...taken].filter(r => refPrefix(r) === p).map(r => Number(r.slice(p.length)) || 0)) + 1)
    if (!ref) return a
    taken.add(ref)
    given.push(ref)
    return { ...a, ref }
  })
  if (given.length !== 1) return out
  return out.map(a => (a.type === 'add_net' && (a.nodes || []).some(nd => !(nd.ref || '').trim())
    ? { ...a, nodes: (a.nodes || []).map(nd => ((nd.ref || '').trim() ? nd : { ...nd, ref: given[0] })) } : a))
}

/**
 * the chip under an AI editor reply: +C3, −LED1, ~R1, +VOUT (a saved reply may have a part with no ref: its type).
 * A connection the model gave no name reads "+연결 C4", the parts on it: not "+?" (2026-11-03 tour S23, take 2:
 * "+C4 +? +?", a question mark the reply never had), and not the NET_8 the code names it (beginners: no net names up front)
 */
export function actionLabel(a: ChatAction): string {
  if (a.type === 'add_component') return `+${a.ref || a.name || '?'}`
  if (a.type === 'remove_component') return `−${a.ref || '?'}`
  if (a.type === 'modify_component') return `~${a.ref || '?'}`
  if (a.type === 'add_net') return (a.name || '').trim() ? `+${(a.name || '').trim()}` : `+연결 ${[...new Set((a.nodes || []).map(nd => (nd.ref || '').trim()).filter(Boolean))].join('·')}`.trim()
  if (a.type === 'remove_net') return `−${a.name || '?'}`
  return a.type
}

/** the part additions applyActions left out: no reference (ref), or a reference the circuit already has */
export function skippedAdds(graph: NetGraph, actions: ChatAction[]): string[] {
  const taken = new Set((graph.components || []).map(c => c.ref))
  const out: string[] = []
  for (const a of actions) {
    if (a.type !== 'add_component') continue
    const ref = (a.ref || '').trim()
    const what = [a.name, a.value].filter(Boolean).join(' ') || '부품'
    if (!ref) out.push(`${what} (부품 기호 없음)`)
    else if (taken.has(ref)) out.push(`${ref} (이미 있는 기호)`)
    else taken.add(ref)
  }
  return out
}

/**
 * Pins an edit took off the net they were on (moved to another net, or left on none): a guess by the model can
 * re-wire a pin that was right (seen live: a motor's + pin moved off +12V), so the chat says so under the reply.
 */
export function movedPins(before: NetGraph, after: NetGraph): { pin: string; from: string; to: string | null }[] {
  const netOf = (g: NetGraph) => new Map(g.nets.flatMap(n => n.nodes.map(nd => [`${nd.ref}.${nd.pin}`, n.name] as const)))
  const a = netOf(after), refs = new Set(after.components.map(c => c.ref))
  return [...netOf(before)].filter(([pin, from]) => refs.has(pin.split('.')[0]) && a.get(pin) !== from)
    .map(([pin, from]) => ({ pin, from, to: a.get(pin) ?? null }))
}

/** the circuit's parts the person's message names by reference: "C3", "bt1의" (not "C30", not "AC1") */
export function namedRefs(graph: NetGraph, message: string, edit: ChatAction[] = []): Set<string> {
  const says = (w: string) => new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*')}(?![A-Za-z0-9])`, 'i').test(message)
  const comps = (graph.components || []).map(c => ({ ref: (c.ref || '').trim(), words: kindWords(c.name, c.ref || '') })).filter(c => c.ref)
  // a kind the edit adds names the new part, not the one there ("커패시터를 하나 더 추가해줘")
  const adding = new Set(edit.filter(a => a.type === 'add_component').flatMap(a => kindWords(a.name, (a.ref || '').trim() || prefixOf(a.name, a.value) || '')))
  const one = (w: string) => !adding.has(w) && comps.filter(c => c.words.includes(w)).length === 1 && says(w)
  return new Set(comps.filter(c => says(c.ref) || c.words.some(one)).map(c => c.ref))
}

/** words a person names a part by without its reference, by part type (by reference prefix when the graph has none) */
const KIND_WORDS: Record<string, string[]> = {
  R: ['저항'], C: ['커패시터', '캐패시터', '콘덴서'], CP: ['커패시터', '캐패시터', '콘덴서', '전해 커패시터', '전해 콘덴서'],
  L: ['인덕터'], LED: ['LED'], D: ['다이오드'], Bridge: ['브리지', '정류기'], Q_NPN: ['트랜지스터'],
  Q_NMOS: ['트랜지스터', 'MOSFET', '모스펫'], NE555: ['555', 'NE555', '타이머'], REG: ['레귤레이터'], Relay: ['릴레이'],
  Buzzer: ['버저', '부저'], SW: ['스위치', '버튼'], Battery: ['배터리', '전지'], Crystal: ['크리스탈'],
}
const TYPE_OF_PREFIX: Record<string, string> = { R: 'R', C: 'C', L: 'L', D: 'D', SW: 'SW', K: 'Relay', LS: 'Buzzer', BT: 'Battery', Y: 'Crystal' }
const kindWords = (name: string | undefined, ref: string): string[] =>
  /^Conn/i.test(name || '') ? ['커넥터'] : KIND_WORDS[name || ''] ?? KIND_WORDS[TYPE_OF_PREFIX[refPrefix(ref.trim())] ?? ''] ?? []

/** a pin's move that is its whole net renamed: the old name gone, the new one new, the same pins (of those counted) on it */
function renamedWhole(before: NetGraph, after: NetGraph, m: { from: string; to: string | null }, counted: (ref: string) => boolean): boolean {
  if (m.to === null || (before.nets || []).some(n => n.name === m.to) || (after.nets || []).some(n => n.name === m.from)) return false
  const on = (g: NetGraph, name: string) => JSON.stringify((g.nets || []).find(n => n.name === name)?.nodes
    .filter(nd => counted(nd.ref)).map(nd => `${nd.ref}.${nd.pin}`).sort())
  return on(before, m.from) === on(after, m.to)
}

/**
 * The edit without what the request did not ask for (live, 2026-10-30, the 555 blinker: "전원 입력 쪽에 100nF 커패시터를
 * 하나 추가해줘" took the battery's + pin off VCC, and "VCC와 GND 사이에 ... C4를 하나 추가해줘" moved pins of four other
 * parts onto C4's net). A pin of a part already in the circuit leaves its net only when the message names that part;
 * a net renamed whole moves no connection, and a pin that was on no net leaves none. Held pins come off the edit's
 * add_net (one left with no pins goes) and a remove_net that would leave them on none goes. A part add whose reference
 * the circuit has is not applied, and the edit's pins with that reference meant the new part: they go too, rather
 * than re-wire the part that is there. Removing a part or changing its value goes the same way: only a named part.
 * A part is named by its reference, or by its kind when the circuit has one of that kind ("LED 빼줘") and the edit
 * adds none.
 */
export function guardEdit(graph: NetGraph, actions: ChatAction[], message: string): {
  actions: ChatAction[]; held: { pin: string; from: string; to: string | null }[]; dropped: string[]; kept: string[]; valued: string[]
} {
  const comps = graph.components || []
  const taken = new Set(comps.map(c => c.ref))
  const named = namedRefs(graph, message, actions)
  const guarded = (ref: string) => taken.has(ref) && !named.has(ref)
  const key = (nd: { ref: string; pin: string }) => {
    const ref = (nd.ref || '').trim()
    return `${ref}.${pinNumber(comps.find(c => c.ref === ref)?.name, String(nd.pin))}`
  }
  // the adds applyActions leaves out (skippedAdds tells them) are not shown as done either
  const reused = new Set<string>(), added = new Set<string>(), kept: string[] = [], valued: string[] = []
  let out = actions.filter(a => {
    const ref = (a.ref || '').trim()
    if (a.type === 'remove_component' || a.type === 'modify_component') {
      if (!guarded(ref)) return true
      ;(a.type === 'remove_component' ? kept : valued).push(ref)
      return false
    }
    if (a.type !== 'add_component') return true
    if (ref && taken.has(ref)) reused.add(ref)
    if (!ref || taken.has(ref) || added.has(ref)) return false
    added.add(ref)
    return true
  })
  const without = (drop: (nd: { ref: string; pin: string }) => boolean) => out.flatMap(a => {
    if (a.type !== 'add_net') return [a]
    const nodes = (a.nodes || []).filter(nd => !drop(nd))
    return nodes.some(nd => (nd.ref || '').trim()) ? [{ ...a, nodes }] : []
  })
  const dropped = out.flatMap(a => (a.type === 'add_net' ? (a.nodes || []) : [])).filter(nd => reused.has((nd.ref || '').trim())).map(key)
  out = without(nd => reused.has((nd.ref || '').trim()))
  const held = new Map<string, { pin: string; from: string; to: string | null }>()
  for (let round = 0; round < 20; round++) {
    const after = applyActions(graph, out)
    const bad = movedPins(graph, after).filter(m => guarded(m.pin.split('.')[0]) && !renamedWhole(graph, after, m, guarded))
    if (!bad.length) break
    for (const m of bad) if (!held.has(m.pin)) held.set(m.pin, m)
    const pins = new Set(bad.map(m => m.pin)), cut = new Set(bad.filter(m => m.to === null).map(m => m.from))
    out = without(nd => pins.has(key(nd))).filter(a => !(a.type === 'remove_net' && cut.has(a.name || '')))
  }
  return { actions: out, held: [...held.values()], dropped, kept: [...new Set(kept)], valued: [...new Set(valued)] }
}

/**
 * a reply that asks the person something: a question mark, or a sentence ending like one ("적용할까요.", "켜지나요."). Not the
 * verb 나요 on its own or in 빛나요 (2026-11-06 sweep: "이제 버저에서 소리가 나요." held back the edit it was reporting)
 */
export const asksBack = (reply: string): boolean => /[?？]/.test(reply) || /(까요|(?<=[^\s빛])나요|습니까)[.!]?(\s|$)/.test(reply)

/**
 * The connections an edit changed, compared by their pins and not their names (a net renamed whole moved nothing):
 * new ones, ones that gained or lost a pin (sharing a pin with one before), and ones gone. A net with no pins is none.
 */
export function changedNets(before: NetGraph, after: NetGraph): { added: number; changed: number; removed: number } {
  const pins = (n: { nodes: { ref: string; pin: string }[] }) => n.nodes.map(nd => `${nd.ref}.${nd.pin}`)
  const key = (n: { nodes: { ref: string; pin: string }[] }) => [...new Set(pins(n))].sort().join(',')
  const b = (before.nets || []).filter(n => n.nodes.length), a = (after.nets || []).filter(n => n.nodes.length)
  const bk = new Set(b.map(key)), ak = new Set(a.map(key))
  const newer = a.filter(n => !bk.has(key(n))), gone = b.filter(n => !ak.has(key(n)))
  const meet = (x: (typeof a)[number], y: (typeof a)[number]) => pins(x).some(p => pins(y).includes(p))
  const changed = newer.filter(n => gone.some(g => meet(n, g))).length
  return { added: newer.length - changed, changed, removed: gone.filter(g => !newer.some(n => meet(n, g))).length }
}

/**
 * An AI edit as the chat applies it: references filled in, what the request did not ask for held back (guardEdit),
 * the circuit after, and the note under the reply. The note names parts, not pin numbers or net names (beginners).
 * changed is false when nothing of the edit is left to apply: the circuit, the undo list and the re-check stay, and
 * the note says so first (no edit proposed counts too).
 * A reply that asks something waits for the answer, edit and all (live, 2026-11-01 tour: "확실하지 않으면 바꾸지 말고
 * 물어봐줘" got a new connection with "이 연결을 적용할까요?", and the app had applied it before the answer).
 */
export function chatEdit(graph: NetGraph, proposed: ChatAction[], message: string, reply = ''): { actions: ChatAction[]; graph: NetGraph; changed: boolean; note: string } {
  if (proposed.length && asksBack(reply)) {
    // the answer to give names the parts there whose pins or values the edit touches: a bare "응" would be held by guardEdit
    const there = new Set((graph.components || []).map(c => c.ref))
    const refs = [...new Set(proposed.flatMap(a => (a.type === 'add_net' ? (a.nodes || []).map(nd => (nd.ref || '').trim())
      : a.type === 'remove_component' || a.type === 'modify_component' ? [(a.ref || '').trim()] : [])))].filter(r => there.has(r))
    return { actions: [], graph, changed: false, note: '\n\nAI가 먼저 묻고 있어서 회로는 아직 바꾸지 않았습니다. 그대로 바꾸려면 '
      + `"응, ${refs.length ? `${refs.join(', ')} ` : ''}그렇게 바꿔줘"처럼 답해 주세요.` }
  }
  const filled = withRefs(graph, proposed)
  const skipped = skippedAdds(graph, filled)
  const { actions, held, dropped, kept, valued } = guardEdit(graph, filled, message)
  const after = applyActions(graph, actions)
  const changed = JSON.stringify([after.components, after.nets]) !== JSON.stringify([graph.components || [], graph.nets || []])
  const comps = graph.components || []
  const taken = new Set(comps.map(c => c.ref))
  const parts = (pins: string[]) => [...new Set(pins.map(p => p.split('.')[0]))]
    .map(ref => `${ref}(${typeLabel(comps.find(c => c.ref === ref)?.name || '', ref)})`).join(', ')
  let note = ''
  const untouched = [kept.length ? `요청에 없던 부품은 지우지 않았습니다: ${parts(kept)}.` : '',
    valued.length ? `요청에 없던 부품의 값은 바꾸지 않았습니다: ${parts(valued)}.` : '',
    held.length ? `요청에 없던 부품의 연결은 바꾸지 않았습니다: ${parts(held.map(m => m.pin))}.` : ''].filter(Boolean)
  if (untouched.length) {
    const ask = kept.length ? `${kept[0]} 빼줘` : valued.length ? `${valued[0]} 값을 바꿔줘` : `${held[0].pin.split('.')[0]}의 연결도 바꿔줘`
    note += `\n\n${untouched.join(' ')} 꼭 필요하면 부품 기호를 넣어 다시 요청해 주세요(예: "${ask}").`
  }
  // what did move is a named part's pin: the model may still have guessed, so the person sees it
  const moved = movedPins(graph, after).filter(m => !renamedWhole(graph, after, m, r => taken.has(r)))
  if (moved.length) note += `\n\n연결을 바꾼 부품: ${parts(moved.map(m => m.pin))}. 의도와 다르면 위의 되돌리기를 누르세요.`
  // how many connections the edit touched, counted by code: the request may have asked for one and the model changed more
  // (the "다른 것은 바꾸지 마세요" idea, eSkCAD demo 2026-11-13), so the person sees the size of it in a number
  const nets = changedNets(graph, after), total = nets.added + nets.changed + nets.removed
  if (changed && total) {
    const said = [nets.added ? `새로 생김 ${nets.added}개` : '', nets.changed ? `달라짐 ${nets.changed}개` : '', nets.removed ? `없어짐 ${nets.removed}개` : ''].filter(Boolean)
    note += `\n\n바뀐 연결선(넷: 전기가 함께 흐르는 핀들의 묶음) ${total}개: ${said.join(', ')}. 요청한 것보다 많으면 위의 되돌리기를 누르세요.`
  }
  // a new part on no net, or alone on one, is joined to nothing (2026-11-03 tour S23, take 2: "C4가 VCC와 GND 사이에
  // 추가되었습니다" with each of its pins on a net of its own, and no word of it under the reply). Its name is in after:
  // parts() reads the parts before the edit
  const fresh = (after.components || []).map(c => c.ref).filter(r => !taken.has(r))
  const lone = fresh.filter(r => {
    const on = after.nets.filter(n => n.nodes.some(nd => nd.ref === r))
    return !on.length || on.some(n => n.nodes.every(nd => nd.ref === r))
  })
  if (lone.length) {
    note += `\n\n새로 넣은 ${lone.map(r => `${r}(${typeLabel(after.components.find(c => c.ref === r)?.name || '', r)})`).join(', ')}에 다른 부품과 `
      + '이어지지 않은 핀이 있습니다. 의도와 다르면 위의 되돌리기를 누르세요.'
  }
  if (skipped.length) {
    // a reference the circuit has: the free one of its kind to ask with (C4 after C1-C3)
    const reused = filled.map(a => (a.type === 'add_component' ? (a.ref || '').trim() : '')).find(r => taken.has(r))
    const p = reused ? refPrefix(reused) : ''
    const used = [...taken, ...actions.map(a => (a.type === 'add_component' ? a.ref || '' : ''))].filter(r => refPrefix(r) === p)
    note += `\n\n넣지 못한 부품: ${skipped.join(', ')}.${dropped.length ? ' 그 부품에 이으려던 연결도 넣지 않았습니다.' : ''}`
      + (reused ? ` 새 부품은 비어 있는 기호(예: ${p}${Math.max(0, ...used.map(r => Number(r.slice(p.length)) || 0)) + 1})를 붙여 다시 요청해 주세요.`
        : ' 부품 기호(예: C3)를 붙여 다시 요청해 주세요.')
  }
  // nothing changed, said first whatever the reply says: it may still say it did (2026-11-03 tour: "완료했습니다." with
  // no edit at all), name the parts held back, or end in a question after saying it connected a pin
  if (!changed) note = `\n\n이 답으로 회로는 바뀌지 않았습니다.${note}`
  // and no action chips under that line, none kept with the message (a session holding them reopened as an AI edit)
  return { actions: changed ? actions : [], graph: changed ? after : graph, changed, note }
}
