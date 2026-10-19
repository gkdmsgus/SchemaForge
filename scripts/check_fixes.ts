/**
 * Checks for the fixes shown next to warnings (src/lib/fixes.ts).
 *
 * Run: npx tsx scripts/check_fixes.ts
 * Hand-made circuits for the netlist-check fixes, the LED resistor value (re-checked by the operating checks
 * themselves) and the pinout rebuild; the motor demo board from server/outputs when one is saved (SKIP otherwise,
 * never counted as passed). The skidl lines were run through skidl, the ERC and the repair judge by hand
 * (scratchpad round9 valueline.mts): RESET line 1 -> 0 errors and kept, value line R1 10 -> 470 with the wiring unchanged.
 */
import fs from 'node:fs'
import path from 'node:path'
import { draftWith, ercFixes, graphFromBoard, ohmsText, opFixes, pinoutStyleFix, ro, withFixes } from '../src/lib/fixes.ts'
import { fromBoard, fromGraph, operatingChecks } from '../src/lib/operatingCheck.ts'
import { applyActions } from '../src/lib/graphEdit.ts'
import type { BoardModel, ErcFinding, NetGraph } from '../src/types.ts'

let failed = 0, skipped = 0
function check(name: string, ok: boolean, info = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`)
}

const net = (name: string, ...nodes: string[]) => ({ name, nodes: nodes.map(n => { const [ref, pin] = n.split('.'); return { ref, pin } }) })

// F1. the lines go right before generate_netlist(), with a comment, keeping its indent; no such line, no draft
{
  const code = "from skidl import *\nr1 = Part()\n\ngenerate_netlist()\n"
  const out = draftWith(code, ["Part.get('R1').value = '470'"], 'R1 값')
  const nested = draftWith("def main():\n    x = 1\n    generate_netlist()\n", ['a = 1'], 'n')
  check('F1 draft before generate_netlist()', out === "from skidl import *\nr1 = Part()\n\n# 고침: R1 값\nPart.get('R1').value = '470'\ngenerate_netlist()\n"
    && nested === "def main():\n    x = 1\n    # 고침: n\n    a = 1\n    generate_netlist()\n" && draftWith('x = 1\n', ['a'], 'n') === null, JSON.stringify(out))
}

// F2. a 555 RESET left open goes with its VCC pin: exact, one line by ref and symbol pin
{
  const g: NetGraph = { components: [{ ref: 'U1', value: 'NE555', name: 'NE555' }, { ref: 'BT1', value: '9V', name: 'Battery' }],
    nets: [net('VCC', 'U1.8', 'BT1.1'), net('GND', 'U1.1', 'BT1.2')] }
  const f: ErcFinding[] = [{ rule: 'floating_pin', severity: 'error', message: 'U1의 RESET 핀(4번)이 어느 넷에도 연결되지 않았습니다', refs: [{ ref: 'U1', pin: '4', sym: '4', name: 'RESET' }], net: null }]
  const [fix] = ercFixes(f, g)
  check('F2 555 RESET -> its VCC net, exact', fix?.sure === 'exact' && fix.lines?.join() === "Part.get('U1')[4] += Net.fetch('VCC')" && /RESET/.test(fix.text), fix?.text)
}

// F3. the LED cathode left open and GND cut to one pin (the case the model produced 9 times): one fix for both,
//     on the symbol pin (K = 2), not the board pad (1) the board names
{
  const g: NetGraph = { components: [{ ref: 'BT1', value: '9V', name: 'Battery' }, { ref: 'R1', value: '470', name: 'R' }, { ref: 'D1', value: 'RED', name: 'LED' }],
    nets: [net('VCC', 'BT1.1', 'R1.1'), net('LED_A', 'R1.2', 'D1.1'), net('GND', 'BT1.2')] }
  const f: ErcFinding[] = [
    { rule: 'floating_pin', severity: 'error', message: 'D1의 K 핀(2번, 기판 패드 1)이 어느 넷에도 연결되지 않았습니다', refs: [{ ref: 'D1', pin: '1', sym: '2', name: 'K' }], net: null },
    { rule: 'single_pin_net', severity: 'error', message: "넷 'GND'에 핀이 BT1.2 하나뿐입니다 (연결이 끊긴 선)", refs: [{ ref: 'BT1', pin: '2', sym: '2', name: '-' }], net: 'GND' },
  ]
  const [a, b] = ercFixes(f, g)
  check('F3 open LED K + one-pin GND: one shared fix on the symbol pin', !!a && a === b && a.sure === 'likely' && a.lines?.join() === "Part.get('D1')[2] += Net.fetch('GND')", a?.text)
  // the same part at both ends would be a short: no pair
  const same: ErcFinding[] = [
    { rule: 'floating_pin', severity: 'error', message: '', refs: [{ ref: 'R1', pin: '2', sym: '2' }], net: null },
    { rule: 'single_pin_net', severity: 'error', message: '', refs: [{ ref: 'R1', pin: '1', sym: '1' }], net: 'TEST' },
  ]
  const [c, d] = ercFixes(same, { components: [{ ref: 'R1', value: '1k', name: 'R' }], nets: [net('TEST', 'R1.1')] })
  check('F3b one part at both ends: words only, no line', !!c && !c.lines && !!d && !d.lines && c !== d)
  check('F3c no circuit, no fixes', ercFixes(f, null).every(x => x === null))
}

// F4. the LED demo's 10 Ω: the nearest standard value with which the LED and the resistor's heat both pass
//     (470 Ω on SMD, 270 Ω on THT), found by re-running the checks; a value picked for current alone (330 Ω) overheats on SMD
{
  const g: NetGraph = { components: [{ ref: 'BT1', value: '9V', name: 'Battery' }, { ref: 'R1', value: '10', name: 'R' }, { ref: 'D1', value: 'RED', name: 'LED' }],
    nets: [net('VCC', 'BT1.1', 'R1.1'), net('LED_A', 'R1.2', 'D1.1'), net('GND', 'D1.2', 'BT1.2')] }
  const got = (style: 'smd' | 'tht') => {
    const c = fromGraph(g, style), rs = operatingChecks(c)
    return opFixes(c, rs).get('op_led|D1')
  }
  const smd = got('smd'), tht = got('tht')
  const at330 = operatingChecks(fromGraph({ ...g, components: g.components.map(x => (x.ref === 'R1' ? { ...x, value: '330' } : x)) }, 'smd'))
  check('F4 LED resistor: SMD 470, THT 270, lines by ref', smd?.lines?.join() === "Part.get('R1').value = '470'" && tht?.lines?.join() === "Part.get('R1').value = '270'"
    && /470으로/.test(smd!.text) && at330.some(r => r.rule === 'op_rpower' && r.state === 'error'), `${smd?.text} | ${tht?.text}`)
  const c = fromGraph(g, 'smd'), rs = operatingChecks(c), filled = withFixes(rs, opFixes(c, rs))
  const heat = filled.find(r => r.rule === 'op_rpower' && r.ref === 'R1')
  check('F4b the heat result caused by the LED points at the LED', !!heat && heat.state !== 'pass' && !!heat.fix && heat.fix.includes('D1'), heat?.fix)
}

// F5. pinout: rebuild in the other style when its assumed part is the one the circuit names
{
  const got = [pinoutStyleFix('Q_NPN', '2N3904', 'smd'), pinoutStyleFix('Q_NPN', 'BC547', 'smd'), pinoutStyleFix('REG', 'L7805', 'smd'),
    pinoutStyleFix('REG', 'AMS1117-3.3', 'tht'), pinoutStyleFix('Q_NMOS', '2N7002', 'tht'), pinoutStyleFix('R', '1k', 'smd')]
  check('F5 pinout rebuild style', JSON.stringify(got) === JSON.stringify(['tht', null, 'tht', 'smd', 'smd', null]), JSON.stringify(got))
}

// F6. particles and values as written in the fix text
{
  const got = ['470', '1k', '68', '4.7k', '1.2M', '10'].map(ro).join(' ')
  check('F6 으로/로 after values', got === '470으로 1k로 68로 4.7k로 1.2M으로 10으로', got)
  check('F6b value text', [470, 4700, 1200000, 10, 2.2].map(ohmsText).join() === '470,4.7k,1.2M,10,2.2')
}

// F7. a board's pads map back to template pins: the SMD LED's pad 1 is its K (pin 2)
{
  const pad = (num: string, n: string | null) => ({ num, type: 'smd', shape: 'rect', x: 0, y: 0, angle: 0, w: 1, h: 1, drill: null, net: n })
  const g = graphFromBoard({ parts: [{ ref: 'D1', value: 'RED', part: 'LED', footprint: 'x', bbox: [0, 0, 1, 1], x: 0, y: 0, rot: 0, pad_pins: { 1: 2, 2: 1 },
    pads: [pad('1', 'GND'), pad('2', 'LED_A')] }] })
  check('F7 board pads -> template pins', JSON.stringify(g.nets) === JSON.stringify([net('GND', 'D1.2'), net('LED_A', 'D1.1')]), JSON.stringify(g.nets))
}

// F8. the motor demo's two warnings (66 of 220 saved boards) come with a fix in words
{
  const dir = path.join('server', 'outputs')
  const motor = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => f.endsWith('.board.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as BoardModel)
    .find(b => b.parts?.some(p => p.part === 'Q_NMOS') && b.parts.some(p => /MOTOR/i.test(p.value)) && b.parts.every(p => p.part === 'MountingHole' || p.part === 'TestPoint' || p.pad_pins))
  if (!motor) { skipped++; console.log('SKIP F8 motor demo fixes  no saved motor board in server/outputs') }
  else {
    const rs = operatingChecks(fromBoard(motor))
    const gate = rs.find(r => r.rule === 'op_drive' && r.state === 'warn'), load = rs.find(r => r.rule === 'op_switch' && r.state === 'unknown')
    check('F8 motor demo: gate and load warnings carry a fix', !!gate?.fix && /논리 레벨/.test(gate.fix) && !!load?.fix && /MOTOR 0\.1A/.test(load.fix), `${gate?.fix?.slice(0, 40)} | ${load?.fix?.slice(0, 40)}`)
  }
}

// G1. the AI editor connecting a pin to a net joins the net of that name (it used to add a second "GND" holding
//     only that pin, as cut off as before) and moves the pin off the net it was on
{
  const g: NetGraph = { components: [{ ref: 'BT1', value: '9V', name: 'Battery' }, { ref: 'D1', value: 'RED', name: 'LED' }],
    nets: [net('GND', 'BT1.2'), net('OLD', 'D1.2'), net('VCC', 'BT1.1', 'D1.1')] }
  const out = applyActions(g, [{ type: 'add_net', name: 'GND', nodes: [{ ref: 'D1', pin: '2' }] }])
  check('G1 add_net joins the existing net, the pin moves', JSON.stringify(out.nets) === JSON.stringify([net('GND', 'BT1.2', 'D1.2'), net('VCC', 'BT1.1', 'D1.1')]), JSON.stringify(out.nets))
  const fresh = applyActions(g, [{ type: 'add_net', name: 'NEW', nodes: [{ ref: 'D1', pin: '2' }, { ref: 'D1', pin: '2' }] }])
  check('G1b a new name makes one net, the pin listed once', JSON.stringify(fresh.nets.find(n => n.name === 'NEW')) === JSON.stringify(net('NEW', 'D1.2')) && !fresh.nets.some(n => n.name === 'OLD'))
  const edits = applyActions(g, [{ type: 'modify_component', ref: 'BT1', value: '5V' }, { type: 'remove_component', ref: 'D1' }])
  check('G1c value change and part removal', edits.components.map(c => `${c.ref}=${c.value}`).join() === 'BT1=5V' && !JSON.stringify(edits.nets).includes('D1') && !edits.nets.some(n => n.name === 'OLD'))
  check('G1d the input graph is not changed', JSON.stringify(g.nets) === JSON.stringify([net('GND', 'BT1.2'), net('OLD', 'D1.2'), net('VCC', 'BT1.1', 'D1.1')]))
}

console.log(failed ? `${failed} CHECK(S) FAILED` : `ALL PASS${skipped ? ` (${skipped} skipped: not counted as passed)` : ''}`)
process.exit(failed ? 1 : 0)
