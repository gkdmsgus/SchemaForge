import { validateCircuit } from '../src/lib/circuitValidation.ts'
import type { NetGraph } from '../src/types.ts'

function remove(graph: NetGraph, ref: string): NetGraph {
  return {
    ...graph,
    components: graph.components.filter(c => c.ref !== ref),
    nets: graph.nets
      .map(n => ({ ...n, nodes: n.nodes.filter(node => node.ref !== ref) }))
      .filter(n => n.nodes.length > 0),
  }
}

// Usage: npx tsx scripts/check_circuit_validation.ts [BASE]   (default http://localhost:3000)
const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')

async function demo(name: string): Promise<NetGraph> {
  const response = await fetch(`${BASE}/demo_result/${name}`)
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  return (await response.json()).graph as NetGraph
}

const motor = await demo('motor')
const led = await demo('led')
const ne555 = await demo('ne555')
const relay = await demo('relay')
// the resistor gone, the LED left beside its two cut nets: the string has no resistor, and says which LED
const noLimiter = validateCircuit(remove(led, 'R1')).filter(i => i.code === 'CIR101')
const checks: [string, boolean][] = [
  ['normal motor passes', validateCircuit(motor).length === 0],
  ['normal LED passes', validateCircuit(led).length === 0],
  ['normal 555 blinker passes', validateCircuit(ne555).length === 0],
  ['normal relay passes', validateCircuit(relay).length === 0],
  ['removed motor R1 is an error', validateCircuit(remove(motor, 'R1')).some(i => i.severity === 'error')],
  ['removed flyback diode warns', validateCircuit(remove(motor, 'D1')).some(i => i.code === 'CIR201')],
  ['removed LED resistor catches limiter', noLimiter.length === 1 && noLimiter[0].severity === 'error' && noLimiter[0].refs.join() === 'D1'],
  // a resistor elsewhere in the circuit does not stand in for the missing one (555 output resistor R3)
  ['removed 555 LED resistor catches limiter', validateCircuit(remove(ne555, 'R3')).some(i => i.code === 'CIR101')],
]

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
if (checks.some(([, ok]) => !ok)) process.exitCode = 1
