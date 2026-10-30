import type { ChatAction, NetGraph } from '../types'
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

export function applyActions(graph: NetGraph, actions: ChatAction[]): NetGraph {
  let comps = [...(graph.components || [])]
  let nets = (graph.nets || []).map(n => ({ ...n, nodes: [...n.nodes] }))
  const same = (a: { ref: string; pin: string }, b: { ref: string; pin: string }) => a.ref === b.ref && String(a.pin) === String(b.pin)
  for (const a of actions) {
    if (a.type === 'add_component') {
      // a part needs its reference: one added with ref "" (seen live, 2026-10-29) was saved to the history and
      // stopped the schematic from drawing whenever it was opened. skippedAdds tells the chat about it.
      const ref = (a.ref || '').trim()
      if (ref && !comps.find(c => c.ref === ref)) comps = [...comps, { ref, name: a.name || ref, value: a.value || '' }]
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
      else nets = [...nets, { name, nodes: add }]
    } else if (a.type === 'remove_net') {
      nets = nets.filter(n => n.name !== a.name)
    }
  }
  return { ...graph, components: comps, nets }
}

/** the part types the AI editor is told to use (server/index.ts), and a few words for them, → reference prefix */
const PREFIXES: [RegExp, string][] = [
  [/^(R|resistor|저항)$/i, 'R'], [/^(C|CP|capacitor|커패시터|콘덴서)$/i, 'C'], [/^(L|inductor|인덕터)$/i, 'L'],
  [/^(LED|D|diode|다이오드)$/i, 'D'], [/^Q(_|$)/i, 'Q'], [/^(NE555|REG|U)$/i, 'U'], [/^SW/i, 'SW'], [/^relay$/i, 'K'],
  [/^buzzer$/i, 'LS'], [/^battery$/i, 'BT'], [/^crystal$/i, 'Y'], [/^conn/i, 'J'],
]
const refPrefix = (ref: string) => ref.replace(/\d+$/, '')

function prefixOf(name?: string, value?: string): string | null {
  const n = (name || '').trim(), v = (value || '').trim()
  for (const [re, p] of PREFIXES) if (re.test(n)) return p
  if (/\d\s*[pnuµm]?F$/.test(v)) return 'C'
  if (/\d\s*[nuµm]?H$/.test(v)) return 'L'
  if (/\d\s*[kKM]?\s*(Ω|ohm)$/i.test(v) || /^\d+(\.\d+)?\s*[kKM]$/.test(v)) return 'R'
  return null
}

/**
 * The edit with a reference on every part it adds. The model sometimes leaves it out (live, 2026-10-30: "출력 쪽에
 * 100nF 커패시터를 하나 추가해줘" gave the capacitor no ref but put C3.1 on VOUT, so the net pointed at a part that
 * was never added). The code names it: the one reference of that kind the edit's nets use and no part has, else
 * the next free number of its kind (C3 after C1 and C2). A part whose kind it cannot tell keeps none (skippedAdds).
 * A net pin with no reference goes to the one part named here, when there is just one.
 */
export function withRefs(graph: NetGraph, actions: ChatAction[]): ChatAction[] {
  const taken = new Set((graph.components || []).map(c => c.ref))
  for (const a of actions) if (a.type === 'add_component' && (a.ref || '').trim()) taken.add((a.ref || '').trim())
  const unknown = [...new Set(actions.flatMap(a => (a.type === 'add_net' ? (a.nodes || []).map(nd => (nd.ref || '').trim()) : [])))]
    .filter(r => r && !taken.has(r))
  const given: string[] = []
  const out = actions.map(a => {
    if (a.type !== 'add_component' || (a.ref || '').trim()) return a
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

/** the chip under an AI editor reply: +C3, −LED1, ~R1, +VOUT (a saved reply may have a part with no ref: its type) */
export function actionLabel(a: ChatAction): string {
  if (a.type === 'add_component') return `+${a.ref || a.name || '?'}`
  if (a.type === 'remove_component') return `−${a.ref || '?'}`
  if (a.type === 'modify_component') return `~${a.ref || '?'}`
  if (a.type === 'add_net') return `+${a.name || '?'}`
  if (a.type === 'remove_net') return `−${a.name || '?'}`
  return a.type
}

/**
 * Pins an edit took off the net they were on (moved to another net, or left on none): a guess by the model can
 * re-wire a pin that was right (seen live: a motor's + pin moved off +12V), so the chat says so under the reply.
 */
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

export function movedPins(before: NetGraph, after: NetGraph): { pin: string; from: string; to: string | null }[] {
  const netOf = (g: NetGraph) => new Map(g.nets.flatMap(n => n.nodes.map(nd => [`${nd.ref}.${nd.pin}`, n.name] as const)))
  const a = netOf(after), refs = new Set(after.components.map(c => c.ref))
  return [...netOf(before)].filter(([pin, from]) => refs.has(pin.split('.')[0]) && a.get(pin) !== from)
    .map(([pin, from]) => ({ pin, from, to: a.get(pin) ?? null }))
}
