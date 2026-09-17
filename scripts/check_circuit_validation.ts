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

async function demo(name: string): Promise<NetGraph> {
  const response = await fetch(`http://localhost:3000/demo_result/${name}`)
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  return (await response.json()).graph as NetGraph
}

const motor = await demo('motor')
const led = await demo('led')
const checks: [string, boolean][] = [
  ['normal motor passes', validateCircuit(motor).length === 0],
  ['normal LED passes', validateCircuit(led).length === 0],
  ['removed motor R1 is an error', validateCircuit(remove(motor, 'R1')).some(i => i.severity === 'error')],
  ['removed flyback diode warns', validateCircuit(remove(motor, 'D1')).some(i => i.code === 'CIR201')],
  ['removed LED resistor catches limiter', validateCircuit(remove(led, 'R1')).some(i => i.code === 'CIR101')],
]

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
if (checks.some(([, ok]) => !ok)) process.exitCode = 1
