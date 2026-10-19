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
      if (!comps.find(c => c.ref === a.ref)) comps = [...comps, { ref: a.ref || '', name: a.name || a.ref || '', value: a.value || '' }]
    } else if (a.type === 'remove_component') {
      comps = comps.filter(c => c.ref !== a.ref)
      nets = nets.map(n => ({ ...n, nodes: n.nodes.filter(nd => nd.ref !== a.ref) })).filter(n => n.nodes.length > 0)
    } else if (a.type === 'modify_component') {
      comps = comps.map(c => (c.ref === a.ref ? { ...c, ...(a.value !== undefined ? { value: a.value } : {}) } : c))
    } else if (a.type === 'add_net') {
      const add = (a.nodes || []).map(nd => ({ ref: nd.ref, pin: pinNumber(comps.find(c => c.ref === nd.ref)?.name, String(nd.pin)) }))
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
