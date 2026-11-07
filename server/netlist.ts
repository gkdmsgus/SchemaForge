// The circuit graph the screen gets (/generate, /restore and /demo_result answer with it), read from a KiCad netlist.
// Kept out of index.ts so the checks read a netlist exactly as the server does (scripts/check_circuit_validation.ts,
// scripts/check_operating.ts).

export interface NetNode { ref: string; pin: string }
export interface NetEntry { name: string; nodes: NetNode[] }
export interface ComponentEntry { ref: string; value: string; name?: string }
export interface NetGraph { components: ComponentEntry[]; nets: NetEntry[] }

export function parseNetlist(text: string): NetGraph {
  const components: ComponentEntry[] = []
  const nets: NetEntry[] = []

  const compRe = /\(comp\s*\(ref\s+"([^"]+)"\)\s*\(value\s+"([^"]*)"\)/g
  const compStarts: { idx: number; ref: string; value: string }[] = []
  let m: RegExpExecArray | null
  while ((m = compRe.exec(text)) !== null) {
    compStarts.push({ idx: m.index, ref: m[1], value: m[2] })
  }
  // The part template name (libsource part) picks the PCB footprint downstream.
  const netsIdx = text.search(/\(nets\b/)
  compStarts.forEach((c, i) => {
    const end = i + 1 < compStarts.length ? compStarts[i + 1].idx : (netsIdx >= 0 ? netsIdx : text.length)
    const part = /\(part\s+"([^"]+)"\)/.exec(text.slice(c.idx, end))
    components.push(part ? { ref: c.ref, value: c.value, name: part[1] } : { ref: c.ref, value: c.value })
  })

  const netSectionMatch = text.match(/\(nets[\s\S]*$/)
  if (netSectionMatch) {
    const netSection = netSectionMatch[0]
    const netStartRe = /\(net\s*\n?\s*\(code\s+(\d+)\)\s*\n?\s*\(name\s+"([^"]+)"\)/g
    let nm: RegExpExecArray | null
    const netStarts: { idx: number; name: string }[] = []
    while ((nm = netStartRe.exec(netSection)) !== null) {
      netStarts.push({ idx: nm.index, name: nm[2] })
    }
    for (let i = 0; i < netStarts.length; i++) {
      const start = netStarts[i].idx
      const end = i + 1 < netStarts.length ? netStarts[i + 1].idx : netSection.length
      const block = netSection.slice(start, end)
      const nodes: NetNode[] = []
      let nodeM: RegExpExecArray | null
      const nodeRe = /\(node\s*\n?\s*\(ref\s+"([^"]+)"\)\s*\n?\s*\(pin\s+"([^"]+)"\)/g
      while ((nodeM = nodeRe.exec(block)) !== null) {
        nodes.push({ ref: nodeM[1], pin: nodeM[2] })
      }
      if (nodes.length > 0) nets.push({ name: netStarts[i].name, nodes })
    }
  }

  return { components, nets }
}
