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
// CIR101 blocks the PCB, so a resistor reached across a diode, a switch or a relay contact, past a net with other pins on
// it, is taken as one that can be in the LED's path (2026-11-07: R - protection diode - LED, and R - switch - LED with a
// capacitor on the switch's output, were refused). A supply straight into an LED, with no resistor anywhere, still is
type Part = [string, string, string]
const g = (parts: Part[], ...nets: string[][]): NetGraph => ({
  components: parts.map(([ref, name, value]) => ({ ref, name, value })),
  nets: nets.map(([name, ...pins]) => ({ name, nodes: pins.map(p => ({ ref: p.split('.')[0], pin: p.split('.')[1] })) })),
})
const cir101 = (c: NetGraph) => validateCircuit(c).filter(i => i.code === 'CIR101').map(i => i.refs.join())
const bat = (v: string): Part => ['BT1', 'Battery', v]
const rDiodeLed = g([bat('9V'), ['R1', 'R', '680'], ['D2', 'D', '1N4148'], ['D1', 'LED', 'RED']],
  ['VCC', 'BT1.1', 'R1.1'], ['A', 'R1.2', 'D2.1'], ['B', 'D2.2', 'D1.1'], ['GND', 'D1.2', 'BT1.2'])
const rSwitchCapLed = g([bat('5V'), ['R1', 'R', '330'], ['SW1', 'SW', ''], ['C1', 'C', '100nF'], ['D1', 'LED', 'RED']],
  ['VCC', 'BT1.1', 'R1.1'], ['N1', 'R1.2', 'SW1.1'], ['N2', 'SW1.2', 'D1.1', 'C1.1'], ['GND', 'D1.2', 'C1.2', 'BT1.2'])
// the resistor on the cathode side, two diodes and a switch away
const lowSide = g([bat('9V'), ['D1', 'LED', 'RED'], ['D2', 'D', ''], ['C1', 'C', '10uF'], ['SW1', 'SW', ''], ['R1', 'R', '470']],
  ['VCC', 'BT1.1', 'D1.1'], ['K', 'D1.2', 'D2.1', 'C1.1'], ['M', 'D2.2', 'SW1.1'], ['L', 'SW1.2', 'R1.1'], ['GND', 'R1.2', 'C1.2', 'BT1.2'])
const straight = g([bat('9V'), ['D1', 'LED', 'RED']], ['VCC', 'BT1.1', 'D1.1'], ['GND', 'D1.2', 'BT1.2'])
// no resistor anywhere: through a switch to a net with a capacitor on it, through a diode, through a relay's contact
const switchCap = g([bat('5V'), ['SW1', 'SW', ''], ['C1', 'C', '100nF'], ['D1', 'LED', 'RED']],
  ['VCC', 'BT1.1', 'SW1.1'], ['N', 'SW1.2', 'D1.1', 'C1.1'], ['GND', 'D1.2', 'C1.2', 'BT1.2'])
const diodeCap = g([bat('9V'), ['D2', 'D', '1N4148'], ['C1', 'C', '100nF'], ['D1', 'LED', 'RED'], ['D3', 'D', '1N4148']],
  ['VCC', 'BT1.1', 'D2.1'], ['A', 'D2.2', 'D1.1', 'C1.1'], ['K', 'D1.2', 'D3.1'], ['GND', 'D3.2', 'C1.2', 'BT1.2'])
const contact = g([bat('5V'), ['K1', 'Relay', '5V'], ['C1', 'C', '100nF'], ['D1', 'LED', 'RED']],
  ['VCC', 'BT1.1', 'K1.1', 'K1.3'], ['NO', 'K1.4', 'D1.1', 'C1.1'], ['GND', 'K1.2', 'D1.2', 'C1.2', 'BT1.2'])
// pins an older edit saved by name are read through the pin-name table the AI editor uses (2026-11-07: this graph had its
// resistor and was refused); a name the table does not know is not guessed, so the LED on it is not judged by CIR101
const byName = g([bat('9V'), ['R1', 'R', '680'], ['D1', 'LED', 'RED']], ['VCC', 'BT1.+', 'R1.p1'], ['A', 'R1.p2', 'D1.A'], ['GND', 'D1.K', 'BT1.-'])
const byNameBare = g([bat('9V'), ['D1', 'LED', 'RED']], ['VCC', 'BT1.+', 'D1.A'], ['GND', 'D1.K', 'BT1.−'])
const unknownLedPin = g([bat('9V'), ['D1', 'LED', 'RED']], ['VCC', 'BT1.1', 'D1.ANODE'], ['GND', 'D1.2', 'BT1.2'])
const unknownRPin = g([bat('9V'), ['R1', 'R', '680'], ['D1', 'LED', 'RED']], ['VCC', 'BT1.1', 'R1.a'], ['A', 'R1.b', 'D1.1'], ['GND', 'D1.2', 'BT1.2'])
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
  ['R - protection diode - LED passes', !cir101(rDiodeLed).length],
  ['R - switch - LED with a capacitor on the switch output passes', !cir101(rSwitchCapLed).length],
  ['resistor on the cathode side past a diode and a switch passes', !cir101(lowSide).length],
  ['supply straight into an LED is an error', cir101(straight).join() === 'D1'],
  ['no resistor past a switch, a diode or a relay contact is an error',
    cir101(switchCap).join() === 'D1' && cir101(diodeCap).join() === 'D1' && cir101(contact).join() === 'D1'],
  ['pins saved by name (A, K, +, −, p1) are read: with the resistor passes, without it is an error',
    !cir101(byName).length && cir101(byNameBare).join() === 'D1'],
  ['a pin name the table does not know is not guessed: no CIR101 for that LED, nor past that net',
    !cir101(unknownLedPin).length && !cir101(unknownRPin).length],
]

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
if (checks.some(([, ok]) => !ok)) process.exitCode = 1
