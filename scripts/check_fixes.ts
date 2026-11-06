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
import { draftWith, ercFixes, graphFromBoard, ohmsText, opFixes, pinoutStyleFix, ro, splitWarnings, withFixes } from '../src/lib/fixes.ts'
import { fromBoard, fromGraph, operatingChecks, operatingHeadline } from '../src/lib/operatingCheck.ts'
import { validateCircuit } from '../src/lib/circuitValidation.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { actionLabel, applyActions, chatEdit, movedPins, pinNumber, skippedAdds, withRefs } from '../src/lib/graphEdit.ts'
import { carryOver, GAP_X, GAP_Y, placeAdded } from '../src/lib/schematicPlace.ts'
import { boardNetlist, guideNote, netlistNote } from '../src/lib/drawerNotes.ts'
import CircuitCanvas from '../src/components/CircuitCanvas.tsx'
import OperatingPanel from '../src/components/OperatingPanel.tsx'
import PCBLayout from '../src/components/PCBLayout.tsx'
import type { BoardModel, ChatAction, ErcFinding, NetGraph } from '../src/types.ts'

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
  check('F5b a bridge named for the SMD part rebuilds in SMD', pinoutStyleFix('Bridge', 'MB6S', 'tht') === 'smd'
    && pinoutStyleFix('Bridge', 'DF06M', 'smd') === 'tht' && pinoutStyleFix('Bridge', 'DB107', 'tht') === null)
}

// F5c. legs with no pad (board.py: "D1 pin 3 has no pad in ..."): one banner item per part, the count of legs in words,
// no pad number, pin number, footprint or net up front; the generator's lines kept whole for 자세히; other warnings untouched.
// The diode case is the AC supply seen live: a bridge rectifier written as a 'D' with four pins.
{
  const warnings = ['D1 pin 3 has no pad in Diode_SMD:D_SOD-123', 'Q1 (BS170): wired with the 2N7002 pinout for SMD',
    'D1 pin 4 has no pad in Diode_SMD:D_SOD-123', 'U9 pin 5 has no pad in Package_TO_SOT_SMD:SOT-223-3_TabPin2']
  const parts = [{ ref: 'D1', part: 'D' }, { ref: 'Q1', part: 'Q_NMOS' }, { ref: 'U9', part: 'REG' }]
  const { legs, rest } = splitWarnings(warnings, parts)
  const d1 = legs.find(m => m.ref === 'D1'), u9 = legs.find(m => m.ref === 'U9')
  check('F5c one item per part, other warnings kept', legs.length === 2 && JSON.stringify(rest) === JSON.stringify([warnings[1]])
    && JSON.stringify(d1?.raw) === JSON.stringify([warnings[0], warnings[2]]) && JSON.stringify(d1?.pins) === '[3,4]', JSON.stringify(legs.map(m => m.ref)))
  check('F5d words: the part, how many legs, what it means', !!d1 && d1.text.startsWith('D1(다이오드)의 다리 2개가') && d1.text.includes('연결이 기판에서 빠졌습니다')
    && !!u9 && u9.text.startsWith('U9(레귤레이터)의 다리 1개가'), d1?.text)
  const words = legs.flatMap(m => [m.text, m.fix])
  check('F5e nothing a beginner cannot read first', !words.some(s => /pin|pad|has no|SOD|SOT|패드|\d번|AC\d|GND/i.test(s)), words.join(' | '))
  check('F5f a four-legged diode points at the bridge rectifier; another part does not', !!d1?.fix.includes('브리지 정류기')
    && !!u9 && !u9.fix.includes('브리지') && u9.fix.includes('부품 종류를 확인'), `${d1?.fix} | ${u9?.fix}`)
  check('F5g no board parts: the kind comes from the reference', splitWarnings([warnings[0]]).legs[0]?.text.startsWith('D1(다이오드)'))
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

// G2. a pin the AI editor wrote by name ("K", "-", "p2") becomes the netlist's pin number; unknown names stay
{
  const got = [pinNumber('LED', 'K'), pinNumber('Battery', '-'), pinNumber('Battery', '−'), pinNumber('R', 'p2'), pinNumber('Q_NMOS', 's'),
    pinNumber('NE555', 'RESET'), pinNumber('LED', '2'), pinNumber('X', 'foo'), pinNumber(undefined, 'A')]
  check('G2 pin names -> numbers', got.join() === '2,2,2,2,3,4,2,foo,A', got.join())
  const g: NetGraph = { components: [{ ref: 'BT1', value: '9V', name: 'Battery' }, { ref: 'D1', value: 'RED', name: 'LED' }], nets: [net('GND', 'BT1.2')] }
  const out = applyActions(g, [{ type: 'add_net', name: 'GND', nodes: [{ ref: 'BT1', pin: '-' }, { ref: 'D1', pin: 'K' }] }])
  check('G2b connecting "D1 K" joins D1.2 to GND once', JSON.stringify(out.nets) === JSON.stringify([net('GND', 'BT1.2', 'D1.2')]), JSON.stringify(out.nets))
}

// G3. the model sometimes leaves add_net's name out (gpt-4o-mini, live run): the net its listed pins already share
//     is the one meant; pins on no net get a fresh name, never an empty one that would drop them
{
  const g: NetGraph = { components: [{ ref: 'BT1', value: '9V', name: 'Battery' }, { ref: 'D1', value: 'RED', name: 'LED' }, { ref: 'J2', value: 'M', name: 'Conn_01x02' }, { ref: 'Q1', value: 'Q', name: 'Q_NMOS' }],
    nets: [net('GND', 'BT1.2'), net('VCC', 'BT1.1', 'D1.1')] }
  const a = applyActions(g, [{ type: 'add_net', nodes: [{ ref: 'D1', pin: '2' }, { ref: 'BT1', pin: '2' }] }])
  const b = applyActions(g, [{ type: 'add_net', nodes: [{ ref: 'Q1', pin: '2' }, { ref: 'J2', pin: '2' }] }])
  check('G3 add_net without a name joins the net its pins share, else a fresh name', JSON.stringify(a.nets) === JSON.stringify([net('GND', 'BT1.2', 'D1.2'), net('VCC', 'BT1.1', 'D1.1')])
    && b.nets.some(n => n.name === 'NET_3' && n.nodes.length === 2) && b.nets.every(n => n.name), `${JSON.stringify(a.nets)} | ${b.nets.map(n => n.name).join(',')}`)
}

// G4. pins an edit takes off their net are reported (live run: a motor's + pin moved off +12V); added pins are not
{
  const g: NetGraph = { components: [{ ref: 'J2', value: 'M', name: 'Conn_01x02' }, { ref: 'Q1', value: 'Q', name: 'Q_NMOS' }, { ref: 'BT1', value: '12V', name: 'Battery' }],
    nets: [net('+12V', 'BT1.1', 'J2.1'), net('GND', 'BT1.2')] }
  const after = applyActions(g, [{ type: 'add_net', name: 'MOTOR', nodes: [{ ref: 'Q1', pin: '2' }, { ref: 'J2', pin: '1' }] }])
  const gone = applyActions(g, [{ type: 'remove_net', name: '+12V' }])
  check('G4 moved pins are reported', JSON.stringify(movedPins(g, after)) === JSON.stringify([{ pin: 'J2.1', from: '+12V', to: 'MOTOR' }])
    && JSON.stringify(movedPins(g, gone)) === JSON.stringify([{ pin: 'BT1.1', from: '+12V', to: null }, { pin: 'J2.1', from: '+12V', to: null }])
    && movedPins(g, applyActions(g, [{ type: 'add_net', name: 'GND', nodes: [{ ref: 'Q1', pin: '3' }] }])).length === 0, JSON.stringify(movedPins(g, after)))
}

// G5. an add with no reference (live, 2026-10-29: "출력 쪽에 100nF 커패시터를 하나 추가해줘" saved a part with ref "",
// and the schematic stopped drawing whenever that history entry was opened) is never applied as such: the code
// names the part when it can tell its kind; otherwise it is left out and told. A net takes no pin with no reference;
// a taken reference is told too
{
  const g: NetGraph = { components: [{ ref: 'C1', value: '10uF', name: 'C' }, { ref: 'U1', value: 'LM7805', name: 'REG' }], nets: [net('VOUT', 'U1.3')] }
  const acts = [{ type: 'add_component' as const, name: 'Widget', value: '?' }, { type: 'add_component' as const, ref: ' ', value: '1' },
    { type: 'add_component' as const, ref: 'C1', name: 'C', value: '1uF' },
    { type: 'add_net' as const, name: 'VOUT', nodes: [{ ref: '', pin: '1' }, { ref: 'C1', pin: '1' }] }]
  const filled = withRefs(g, acts)
  const out = applyActions(g, filled)
  check('G5 no part without a reference, no net pin without one, and the chat is told',
    out.components.map(c => c.ref).join() === 'C1,U1' && JSON.stringify(out.nets) === JSON.stringify([net('VOUT', 'U1.3', 'C1.1')])
    && skippedAdds(g, filled).join(' | ') === 'Widget ? (부품 기호 없음) | 1 (부품 기호 없음) | C1 (이미 있는 기호)', skippedAdds(g, filled).join(' | '))
}

// G7. the code names a part the model added without a reference (live, 2026-10-30: the 100nF capacitor came with no
// ref while the edit put C3.1 on VOUT, so the net pointed at a part that was never added: ERC "삭제된 부품을 가리키는
// 연결 C3", and the chat chip read "+undefined")
{
  const g: NetGraph = { components: [{ ref: 'C1', value: '1000uF', name: 'C' }, { ref: 'C2', value: '100nF', name: 'C' }, { ref: 'U1', value: 'LM7805', name: 'REG' }],
    nets: [net('VOUT', 'U1.3'), net('GND', 'U1.2')] }
  const live = [{ type: 'add_component' as const, name: 'C', value: '100nF' },
    { type: 'add_net' as const, name: 'VOUT', nodes: [{ ref: 'U1', pin: '3' }, { ref: 'C3', pin: '1' }] },
    { type: 'add_net' as const, name: 'GND', nodes: [{ ref: 'U1', pin: '2' }, { ref: 'C3', pin: '2' }] }]
  const f1 = withRefs(g, live), o1 = applyActions(g, f1)
  const named = f1[0].ref === 'C3' && o1.components.some(c => c.ref === 'C3' && c.value === '100nF')
    && JSON.stringify(o1.nets) === JSON.stringify([net('VOUT', 'U1.3', 'C3.1'), net('GND', 'U1.2', 'C3.2')]) && skippedAdds(g, f1).length === 0
  // no net names it: the next free number of its kind, and a net pin with no reference is that part's
  const f2 = withRefs(g, [{ type: 'add_component', name: 'LED', value: 'RED' }, { type: 'add_component', value: '4.7k' },
    { type: 'add_net', name: 'VOUT', nodes: [{ ref: '', pin: '1' }] }])
  const next = f2[0].ref === 'D1' && f2[1].ref === 'R1' && JSON.stringify(f2[2].nodes) === JSON.stringify([{ ref: '', pin: '1' }])
  const f3 = withRefs(g, [{ type: 'add_component', name: 'C', value: '1uF' }, { type: 'add_net', name: 'VOUT', nodes: [{ ref: '', pin: '1' }] }])
  const onePin = f3[0].ref === 'C3' && f3[1].nodes?.[0].ref === 'C3'
  // and a connection with no name: the parts on it, not "+?" (2026-11-03 tour S23, take 2: "+C4 +? +?")
  const chip = actionLabel({ type: 'add_component', name: 'C', value: '100nF' }) === '+C' && actionLabel(f1[0]) === '+C3'
    && actionLabel({ type: 'add_net', nodes: [{ ref: 'C4', pin: '1' }] }) === '+연결 C4' && actionLabel({ type: 'add_net', nodes: [] }) === '+연결'
    // a name of spaces is no name: applyActions makes it a NET_x of its own (review of 2026-11-03: it read "+  ")
    && actionLabel({ type: 'add_net', name: '  ', nodes: [{ ref: 'C4', pin: '1' }] }) === '+연결 C4'
  check('G7 a part added without a reference is named by the code (the net\'s C3, else the next number), chips never "+undefined" or "+?"',
    named && next && onePin && chip, JSON.stringify({ named, next, onePin, chip, f1: f1[0], o1: o1.nets }))
}

// G8-G10. an AI edit does not move a pin of a part the request does not name (live, 2026-10-30 tour, the 555 LED
// blinker): the move is held back and the chat says which parts kept their connections, in words with no pin
// number or net name. The 555 circuit as it was then:
const blinker: NetGraph = {
  components: [{ ref: 'BT1', value: '9V', name: 'Battery' }, { ref: 'U1', value: 'NE555', name: 'NE555' }, { ref: 'R1', value: '1k', name: 'R' },
    { ref: 'R2', value: '10k', name: 'R' }, { ref: 'R3', value: '470', name: 'R' }, { ref: 'C1', value: '10nF', name: 'C' },
    { ref: 'C2', value: '10uF', name: 'C' }, { ref: 'C3', value: '100nF', name: 'C' }, { ref: 'D1', value: 'RED', name: 'LED' }],
  nets: [net('VCC', 'BT1.1', 'U1.8', 'U1.4', 'R1.1', 'C3.1'), net('GND', 'BT1.2', 'U1.1', 'C1.2', 'C2.2', 'C3.2', 'D1.2'),
    net('N$1', 'U1.5', 'C1.1'), net('DISCH', 'U1.7', 'R1.2', 'R2.1'), net('TRIG_THRES', 'U1.2', 'U1.6', 'R2.2', 'C2.1'),
    net('OUT', 'U1.3', 'R3.1'), net('LED_A', 'R3.2', 'D1.1')],
}
const plain = (s: string) => !/[A-Z]+\d+\.\d|N\$|VCC|GND|TRIG|\d번/.test(s)

// G8. "전원 입력 쪽에 100nF 커패시터를 하나 추가해줘": the model added C3, which exists (skipped), and put BT1.1 and C3.1 on
// a new net N$4, cutting the battery off VCC while the chat said the re-check passed. Now nothing moves: the battery is
// not named, and the pins of a part whose add was skipped meant the new part, not the C3 that is there
{
  const e = chatEdit(blinker, [{ type: 'add_component', ref: 'C3', name: 'C', value: '100nF' },
    { type: 'add_net', name: 'N$4', nodes: [{ ref: 'BT1', pin: '1' }, { ref: 'C3', pin: '1' }] }], '전원 입력 쪽에 100nF 커패시터를 하나 추가해줘')
  check('G8 a skipped add and an unnamed battery pin: nothing moves, nothing is applied, the chat says why',
    JSON.stringify(e.graph) === JSON.stringify(blinker) && e.changed === false && e.actions.length === 0
    && /BT1\(배터리\)/.test(e.note) && /C3/.test(e.note) && /C4/.test(e.note) && plain(e.note), `${JSON.stringify(e.graph.nets.slice(0, 1))} | ${e.note}`)
}

// G9. "VCC와 GND 사이에 100nF 커패시터 C4를 하나 추가해줘": C4 went on a new net N$4 and C1.1, U1.5 (N$1), C2.1 (TRIG_THRES)
// and C3.1 (VCC) were all moved onto it. Now C4 goes in with its own pins; the four keep their nets and are named
{
  const e = chatEdit(blinker, [{ type: 'add_component', ref: 'C4', name: 'C', value: '100nF' },
    { type: 'add_net', name: 'N$4', nodes: [{ ref: 'C4', pin: '1' }, { ref: 'C1', pin: '1' }, { ref: 'U1', pin: '5' }, { ref: 'C2', pin: '1' }, { ref: 'C3', pin: '1' }] },
    { type: 'add_net', name: 'GND', nodes: [{ ref: 'C4', pin: '2' }] }], 'VCC와 GND 사이에 100nF 커패시터 C4를 하나 추가해줘')
  const want = [...blinker.nets.map(n => (n.name === 'GND' ? { ...n, nodes: [...n.nodes, { ref: 'C4', pin: '2' }] } : n)), net('N$4', 'C4.1')]
  check('G9 the new part goes in, the four pins it would have moved stay, and the chat names their parts',
    JSON.stringify(e.graph.nets) === JSON.stringify(want) && e.graph.components.some(c => c.ref === 'C4') && e.changed
    && ['C1(커패시터)', 'U1(555 타이머)', 'C2(커패시터)', 'C3(커패시터)'].every(w => e.note.includes(w)) && plain(e.note),
    `${JSON.stringify(e.graph.nets.filter(n => n.name === 'N$4' || n.name === 'N$1'))} | ${e.note}`)
}

// G9b. the same request with each of C4's pins on a connection of its own, no name given (2026-11-03 tour S23, take 2:
// the reply said C4 went in between VCC and GND, the chips read "+C4 +? +?", and nothing said C4 was joined to no
// other part). The chat says so and the chips name the part; wired to VCC and GND, no such note
{
  const ask = 'VCC와 GND 사이에 100nF 커패시터 C4를 하나 추가해줘'
  const c4: ChatAction = { type: 'add_component', ref: 'C4', name: 'C', value: '100nF' }
  const e = chatEdit(blinker, [c4, { type: 'add_net', nodes: [{ ref: 'C4', pin: '1' }] }, { type: 'add_net', nodes: [{ ref: 'C4', pin: '2' }] }], ask)
  const chips = e.actions.filter(a => a.type === 'add_net').map(actionLabel)
  const lone = e.changed && e.note.includes('C4(커패시터)') && e.note.includes('이어지지 않은 핀') && plain(e.note)
    && chips.length === 2 && chips.every(c => c === '+연결 C4')
  const ok = chatEdit(blinker, [c4, { type: 'add_net', name: 'VCC', nodes: [{ ref: 'C4', pin: '1' }] }, { type: 'add_net', name: 'GND', nodes: [{ ref: 'C4', pin: '2' }] }], ask)
  const wired = ok.changed && !ok.note.includes('이어지지 않은')
  check('G9b a new part joined to no other part: the chat says so, the unnamed connections\' chips name the part; wired right, no note',
    lone && wired, JSON.stringify({ lone, wired, chips, note: e.note, ok: ok.note }))
}

// G10. what the request names, or what moves no connection, still goes in: a named part's pin (any case, "c3을"),
// a net renamed whole, a pin that was on no net. A net merged into another by a guess is held (and the net it would
// have removed stays), and U10 does not name U1
{
  const r1 = chatEdit(blinker, [{ type: 'add_net', name: 'GND', nodes: [{ ref: 'R1', pin: '1' }] }], 'R1을 VCC에서 떼서 GND에 연결해줘')
  const moved = r1.graph.nets.find(n => n.name === 'GND')!.nodes.some(nd => nd.ref === 'R1' && nd.pin === '1') && /R1\(저항\)/.test(r1.note) && plain(r1.note)
  const ren = chatEdit(blinker, [{ type: 'remove_net', name: 'N$1' }, { type: 'add_net', name: 'CTRL', nodes: [{ ref: 'U1', pin: '5' }, { ref: 'C1', pin: '1' }] }],
    'N$1 선 이름을 CTRL로 바꿔줘')
  const renamed = JSON.stringify(ren.graph.nets.find(n => n.name === 'CTRL')) === JSON.stringify(net('CTRL', 'U1.5', 'C1.1')) && !ren.graph.nets.some(n => n.name === 'N$1')
    && !/그대로/.test(ren.note)
  const open: NetGraph = { ...blinker, nets: blinker.nets.map(n => (n.name === 'GND' ? { ...n, nodes: n.nodes.filter(nd => nd.ref !== 'D1') } : n)) }
  const fl = chatEdit(open, [{ type: 'add_net', name: 'GND', nodes: [{ ref: 'D1', pin: '2' }] }], '끊긴 다리를 이어줘')
  const floating = JSON.stringify(fl.graph.nets) === JSON.stringify(blinker.nets) && fl.note === ''
  const mg = chatEdit(blinker, [{ type: 'remove_net', name: 'N$1' }, { type: 'add_net', name: 'GND', nodes: [{ ref: 'U1', pin: '5' }, { ref: 'C1', pin: '1' }] }], 'GND를 정리해줘')
  const merge = JSON.stringify(mg.graph) === JSON.stringify(blinker) && mg.changed === false && /U1\(555 타이머\)/.test(mg.note) && /C1\(커패시터\)/.test(mg.note)
  const cs = chatEdit(blinker, [{ type: 'add_net', name: 'GND', nodes: [{ ref: 'C3', pin: '1' }, { ref: 'U1', pin: '5' }] }], 'c3을 GND로 옮기고 U10은 그대로 둬')
  const cased = cs.graph.nets.find(n => n.name === 'GND')!.nodes.some(nd => nd.ref === 'C3' && nd.pin === '1')
    && cs.graph.nets.find(n => n.name === 'N$1')!.nodes.some(nd => nd.ref === 'U1' && nd.pin === '5') && /U1\(555 타이머\)/.test(cs.note)
  check('G10 named moves, renames and open pins go in; a guessed merge is held; U10 is not U1',
    moved && renamed && floating && merge && cased, JSON.stringify({ moved, renamed, floating, merge, cased, r1: r1.note, ren: ren.note, mg: mg.note, cs: cs.note }))
}

// G11. removing a part or changing its value goes the same way: only a part the message names, by reference or by a
// kind the circuit has one of ("LED 빼줘", the chat's own example) unless the edit adds one of that kind
{
  const val = chatEdit(blinker, [{ type: 'modify_component', ref: 'R3', value: '1k' }, { type: 'modify_component', ref: 'R2', value: '22k' }], '저항 R3 값을 1k로 바꿔줘')
  const values = val.graph.components.map(c => `${c.ref}=${c.value}`).filter(s => /^R[23]=/.test(s)).join() === 'R2=10k,R3=1k'
    && JSON.stringify(val.actions) === JSON.stringify([{ type: 'modify_component', ref: 'R3', value: '1k' }]) && /값은 바꾸지 않았습니다: R2\(저항\)/.test(val.note) && plain(val.note)
  const rm = chatEdit(blinker, [{ type: 'remove_component', ref: 'R3' }, { type: 'remove_component', ref: 'D1' }], 'R3을 지워줘')
  const removed = !rm.graph.components.some(c => c.ref === 'R3') && rm.graph.components.some(c => c.ref === 'D1')
    && JSON.stringify(rm.graph.nets.find(n => n.name === 'GND')) === JSON.stringify(blinker.nets.find(n => n.name === 'GND')) && /지우지 않았습니다: D1\(LED\)/.test(rm.note) && plain(rm.note)
  const hint = chatEdit(blinker, [{ type: 'remove_component', ref: 'D1' }], 'LED 빼줘')
  const byKind = !hint.graph.components.some(c => c.ref === 'D1') && hint.note === ''
  const many = chatEdit(blinker, [{ type: 'modify_component', ref: 'C2', value: '1uF' }], '커패시터 값을 1uF로 바꿔줘')
  const notUnique = many.changed === false && /C2\(커패시터\)/.test(many.note)
  const one: NetGraph = { components: [{ ref: 'BT1', value: '9V', name: 'Battery' }, { ref: 'R1', value: '1k', name: 'R' }, { ref: 'C1', value: '10uF', name: 'C' }],
    nets: [net('VCC', 'BT1.1', 'R1.1', 'C1.1'), net('GND', 'BT1.2', 'C1.2'), net('OUT', 'R1.2')] }
  const add = chatEdit(one, [{ type: 'add_component', ref: 'C2', name: 'C', value: '100nF' }, { type: 'modify_component', ref: 'C1', value: '1uF' },
    { type: 'add_net', name: 'OUT', nodes: [{ ref: 'C2', pin: '1' }, { ref: 'C1', pin: '1' }] }], '커패시터를 하나 더 추가해줘')
  const adding = add.graph.components.find(c => c.ref === 'C1')?.value === '10uF' && add.graph.components.some(c => c.ref === 'C2')
    && add.graph.nets.find(n => n.name === 'VCC')!.nodes.some(nd => nd.ref === 'C1' && nd.pin === '1') && /C1\(커패시터\)/.test(add.note)
  const mv = chatEdit(blinker, [{ type: 'add_net', name: 'OUT', nodes: [{ ref: 'D1', pin: '1' }] }], 'LED 다리를 출력에 바로 이어줘')
  const moveByKind = mv.graph.nets.find(n => n.name === 'OUT')!.nodes.some(nd => nd.ref === 'D1' && nd.pin === '1') && !/그대로|바꾸지 않았/.test(mv.note)
  check('G11 removals and value changes of parts the request does not name are held; a kind the circuit has one of names it, unless the edit adds that kind',
    values && removed && byKind && notUnique && adding && moveByKind,
    JSON.stringify({ values, removed, byKind, notUnique, adding, moveByKind, val: val.note, rm: rm.note, many: many.note, add: add.note, mv: mv.note }))
}

// G12. a reply that asks first changes nothing yet (2026-11-01 tour: "확실하지 않으면 바꾸지 말고 물어봐줘" got a new
// connection and "이 연결을 적용할까요?", and the app applied it before the answer); a reply that says what it did still applies
{
  const open: NetGraph = { ...blinker, nets: blinker.nets.map(n => (n.name === 'TRIG_THRES' ? { ...n, nodes: n.nodes.filter(nd => nd.ref !== 'C2') } : n)) }
  const join: ChatAction[] = [{ type: 'add_net', name: 'TRIG_THRES', nodes: [{ ref: 'C2', pin: '1' }] }]
  const msg = 'C2의 1번 핀이 어디에도 연결되어 있지 않아. 회로에 맞게 이어줘. 어느 넷인지 확실하지 않으면 바꾸지 말고, 후보 넷을 알려 주고 물어봐줘.'
  const ask = chatEdit(open, join, msg, 'C2의 1번 핀은 TRIG_THRES에 연결하는 것이 맞아 보입니다. 이 연결을 적용할까요?')
  const held = ask.changed === false && JSON.stringify(ask.graph) === JSON.stringify(open) && ask.actions.length === 0
    && /아직 바꾸지 않았습니다/.test(ask.note) && plain(ask.note)
  const noMark = chatEdit(open, join, msg, '이 연결을 적용할까요.').changed === false
  const did = chatEdit(open, join, msg, 'C2의 1번 핀을 TRIG_THRES에 연결했습니다.')
  const applied = did.changed && JSON.stringify(did.graph.nets) === JSON.stringify(blinker.nets) && !/아직/.test(did.note)
  const wired = /chatEdit\(snapshot, proposed \?\? \[\], msg, reply\)/.test(fs.readFileSync(path.join('src', 'components', 'ResultPanel.tsx'), 'utf8'))
  // the answer the note suggests names the part, so it goes through guardEdit when the pin moves off another net
  const move = [{ type: 'add_net', name: 'TRIG_THRES', nodes: [{ ref: 'C1', pin: '1' }] }] as ChatAction[]
  const asked = chatEdit(blinker, move, 'C1 연결을 확인해줘', '이렇게 바꿀까요?')
  const answer = /"(응, C1 그렇게 바꿔줘)"/.exec(asked.note)?.[1] ?? ''
  const answered = !!answer && chatEdit(blinker, move, answer, 'C1의 연결을 바꿨습니다.').graph.nets.find(n => n.name === 'TRIG_THRES')!.nodes.some(nd => nd.ref === 'C1')
  check('G12 a reply that asks first leaves the circuit as it is and says so; one that says what it did applies; the chat passes the reply',
    held && noMark && applied && wired && answered, JSON.stringify({ held, noMark, applied, wired, answered, ask: ask.note, asked: asked.note, did: did.note }))

  // G12b. a reply that changed nothing says so first, whatever its words (2026-11-03 tour, 52 s: "완료했습니다." with no
  // edit, C1's pin still on its own): with parts held back, and after a question too (review of 2026-11-03: "연결했습니다.
  // 다른 수정이 필요하신가요?" with no edit, and a wrong part held, kept only the held note); not under an applied edit
  // no action chips either (recheck of 2026-11-03: "+TRIG_THRES" stayed under the line, and was kept with the message)
  const none = (r: { changed: boolean; note: string; actions: ChatAction[] }) => !r.changed && !r.actions.length
    && /^\n\n이 답으로 회로는 바뀌지 않았습니다\./.test(r.note) && plain(r.note)
  const empty = chatEdit(open, [], msg, '완료했습니다.'), same = chatEdit(blinker, join, msg, 'C2의 1번 핀을 TRIG_THRES에 연결했습니다.')
  const question = chatEdit(open, [], msg, '어느 넷에 연결할까요?'), claimAsk = chatEdit(open, [], msg, 'C2의 1번 핀을 연결했습니다. 다른 수정이 필요하신가요?')
  const wrong = chatEdit(open, [{ type: 'add_net', name: 'TRIG_THRES', nodes: [{ ref: 'C1', pin: '1' }] }], 'C2의 1번 핀을 TRIG_THRES에 이어줘', 'C2의 1번 핀을 TRIG_THRES에 연결했습니다.')
  const server = fs.readFileSync(path.join('server', 'index.ts'), 'utf8')
  const serverSays = /else if \(!reply\) reply = actions\.length \? '완료했습니다\.' : '바꿀 내용을 정하지 못했습니다/.test(server)
    && /if \(!read\) \{/.test(server)
  check('G12b a reply that changed nothing says so first (held parts, questions too); an applied edit does not; the server says "완료" only with an edit',
    none(empty) && none(same) && none(question) && none(claimAsk) && none(wrong) && /요청에 없던 부품의 연결은 바꾸지 않았습니다/.test(wrong.note)
    && !/바뀌지 않았습니다/.test(did.note) && serverSays,
    JSON.stringify({ empty: empty.note, same: same.note, question: question.note, claimAsk: claimAsk.note, wrong: wrong.note, serverSays }))
}

// F10. with the circuit check failing, the operating chip does not say it passed (2026-11-02 tour, 348-352 s: "LED 빼줘"
// left the resistor on one pin and the tab bar read '● 동작 검사 통과' beside '회로 오류 1'): what is still wired passes,
// but nothing can be said of the whole circuit. Found faults and warnings still show
{
  const noLed = chatEdit(blinker, [{ type: 'remove_component', ref: 'D1' }], 'LED 빼줘').graph
  const errors = validateCircuit(noLed).filter(i => i.severity === 'error').length
  const rs = operatingChecks(fromGraph(noLed, 'smd')), head = operatingHeadline(rs, errors)
  const blocked = errors > 0 && rs.every(r => r.state === 'pass') && head.state === 'unknown' && !/통과/.test(head.text) && /회로 오류/.test(head.text)
  const clean = operatingHeadline(operatingChecks(fromGraph(blinker, 'smd')), 0).text === '동작 검사 통과'
  const fault = operatingHeadline([{ rule: 'op_led', ref: 'D1', state: 'error', summary: '', detail: [] }], 1).text === '동작 안 됨 1'
  const panel = renderToStaticMarkup(createElement(OperatingPanel, { results: rs, style: 'smd', circuitErrors: errors, onClose: () => {} }))
  const shown = panel.includes(head.text) && !panel.includes('동작 검사 통과') && /회로 오류가 있어/.test(panel)
  const src = fs.readFileSync(path.join('src', 'components', 'ResultPanel.tsx'), 'utf8')
  const wired = /operatingHeadline\(opResults, circuitErrors\.length\)/.test(src) && /circuitErrors=\{circuitErrors\.length\}/.test(src)
  check('F10 circuit errors: the operating chip and panel say it cannot be judged, not passed; faults still show',
    blocked && clean && fault && shown && wired, JSON.stringify({ errors, head, blocked, clean, fault, shown, wired }))
}

// G13. a part an edit adds goes on a free spot and the parts there keep theirs (2026-11-02 tour, 325-329 s: C4 added to
// the 555's nine parts laid them all out again, three columns became four). Nine parts in the auto layout's grid, C4 on
// the nets of all of them: with room in view it goes there, in a row of the others; with none, the side that makes the
// view zoom out least (a column in a wide view, a row in a tall one); always clear of every part by the layout's gaps
{
  const refs = ['BT1', 'C1', 'C2', 'C3', 'D1', 'R1', 'R2', 'R3', 'U1']
  const kept = Object.fromEntries(refs.map((r, i) => [r, { x: 125 + (i % 3) * 190, y: 182 + Math.floor(i / 3) * 144 }]))
  const size = Object.fromEntries([...refs, 'C4'].map(r => [r, { w: 80, h: 44 }]))
  const nets = [{ nodes: [...refs, 'C4'].map(ref => ({ ref })) }]
  const rows = new Set(refs.map(r => kept[r].y))
  const at = (view: { x0: number; y0: number; x1: number; y1: number } | null) => {
    const p = placeAdded(kept, ['C4'], size, nets, view), c = p.C4
    const stay = refs.every(r => p[r].x === kept[r].x && p[r].y === kept[r].y)
    const clear = refs.every(r => Math.abs(c.x - kept[r].x) >= 80 + GAP_X || Math.abs(c.y - kept[r].y) >= 44 + GAP_Y)
    return { c, ok: stay && clear }
  }
  const room = at({ x0: 0, y0: 100, x1: 900, y1: 560 }), wide = at({ x0: 45, y0: 120, x1: 585, y1: 532 })
  const tall = at({ x0: 45, y0: 0, x1: 585, y1: 900 }), any = at(null)
  const inView = room.ok && room.c.x + 40 <= 900 && room.c.x > 545 && rows.has(room.c.y)
  const column = wide.ok && (wide.c.x < 85 || wide.c.x > 545) && rows.has(wide.c.y)
  const row = tall.ok && (tall.c.y < 182 || tall.c.y > 470)
  const wired = /placeAdded\(kept, /.test(fs.readFileSync(path.join('src', 'lib', 'schematicPlace.ts'), 'utf8'))
    && /carryOver\(/.test(fs.readFileSync(path.join('src', 'components', 'CircuitCanvas.tsx'), 'utf8'))
  check('G13 an added part takes a free spot (in view when there is room, else a column or row by the view), the others stay',
    inView && column && row && any.ok && wired, JSON.stringify({ room: room.c, wide: wide.c, tall: tall.c, any: any.c, wired }))

  // G13b. a part coming back takes its last spot (2026-11-03 tour, 350-360 s: undoing "LED D1 빼줘" put D1 under U1,
  // not beside R1 where it was), before a new part can take it, and when only its body clears the parts there (R1
  // dragged closer since); a spot another part sits on now is not taken. Coming back is the same kind on the same nets:
  // a new capacitor that gets the ref C4 again after an undo goes by its own nets (review of 2026-11-03). The spots
  // live in the result panel, so the layout outlives the PCB tab as it was (328 s: laid out again, every part moved)
  const others = Object.fromEntries(refs.filter(r => r !== 'D1').map(r => [r, kept[r]]))
  const same = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y
  const home = placeAdded(others, ['C4', 'D1'], size, nets, null, { D1: kept.D1 })
  const first = same(home.D1, kept.D1) && !same(home.C4, kept.D1)
  const pulled = placeAdded({ ...others, R1: { x: kept.R1.x - 65, y: kept.R1.y } }, ['D1'], size, nets, null, { D1: kept.D1 })
  const taken = placeAdded({ ...others, C4: kept.D1 }, ['D1'], size, nets, null, { D1: kept.D1 })
  const moved = !same(taken.D1, kept.D1)
    && Object.values({ ...others, C4: kept.D1 }).every(p => Math.abs(taken.D1.x - p.x) >= 80 + GAP_X || Math.abs(taken.D1.y - p.y) >= 44 + GAP_Y)
  // the edits and tab switches as carryOver sees them (CircuitCanvas calls it with the last layout and graph)
  const add = (g: NetGraph, ref: string, name: string, a: string, b: string): NetGraph => ({ components: [...g.components, { ref, name, value: '' }],
    nets: g.nets.map(n => (n.name === a ? { ...n, nodes: [...n.nodes, { ref, pin: '1' }] } : n.name === b ? { ...n, nodes: [...n.nodes, { ref, pin: '2' }] } : n)) })
  const drop = (g: NetGraph, ref: string): NetGraph => ({ components: g.components.filter(c => c.ref !== ref), nets: g.nets.map(n => ({ ...n, nodes: n.nodes.filter(nd => nd.ref !== ref) })) })
  const sizes = { ...size, D1: { w: 80, h: 44 } }
  // shown again after another tab: as it was, two parts dragged over each other too
  const overlap = { ...kept, R1: { x: kept.R2.x + 10, y: kept.R2.y + 5 } }
  const again = carryOver(blinker, overlap, blinker, {}, sizes, null)
  const asWas = !!again && refs.every(r => same(again[r], overlap[r]))
  // C4 on VCC and GND, undone, then a C4 by the LED (LED_A, OUT): it goes by its own nets, as with nothing remembered
  const gone: Record<string, { x: number; y: number }> = {}
  const c4a = add(blinker, 'C4', 'C', 'VCC', 'GND'), c4b = add(blinker, 'C4', 'C', 'LED_A', 'OUT')
  const p1 = carryOver(blinker, kept, c4a, gone, sizes, null)!, p2 = carryOver(c4a, p1, blinker, gone, sizes, null)!
  const p3 = carryOver(blinker, p2, c4b, gone, sizes, null)!, fresh = carryOver(blinker, p2, c4b, {}, sizes, null)!
  const ownNets = same(p3.C4, fresh.C4) && !same(fresh.C4, p1.C4)
  // the LED D1 dragged aside and taken out, a diode given the ref D1 and undone, then the LED undone back: it returns
  // to where it was dragged (recheck of 2026-11-03: by ref alone the diode wrote over the LED's spot)
  const g2: Record<string, { x: number; y: number }> = {}, aside = { ...kept, D1: { x: 900, y: 700 } }
  const noLed = drop(blinker, 'D1'), diode = add(noLed, 'D1', 'D', 'VCC', 'OUT')
  const q1 = carryOver(blinker, aside, noLed, g2, sizes, null)!, q2 = carryOver(noLed, q1, diode, g2, sizes, null)!
  const q3 = carryOver(diode, q2, noLed, g2, sizes, null)!, q4 = carryOver(noLed, q3, blinker, g2, sizes, null)!
  const ledBack = same(q4.D1, aside.D1) && !same(q2.D1, aside.D1)
  const canvas = fs.readFileSync(path.join('src', 'components', 'CircuitCanvas.tsx'), 'utf8')
  const kept13 = /carryOver\(from, was, graph, spots\?\.gone \?\? \{\}, layouts, visible\(\)\)/.test(canvas) && /spots\.at = positions/.test(canvas)
    && /<CircuitCanvas [^\n]*spots=\{schematicSpots\.current\}/.test(fs.readFileSync(path.join('src', 'components', 'ResultPanel.tsx'), 'utf8'))
  check('G13b a part coming back (same kind, same nets) takes its last spot first, unless a part sits there; shown again the layout is as it was',
    first && same(pulled.D1, kept.D1) && moved && asWas && ownNets && ledBack && kept13,
    JSON.stringify({ D1: home.D1, C4: home.C4, pulled: pulled.D1, taken: taken.D1, asWas, c4: [p1.C4, p3.C4, fresh.C4], led: [q2.D1, q4.D1], kept13 }))
}

// G6. a part already saved with an empty reference still draws on the schematic and the PCB sketch (it threw in
// render and blanked the whole result screen)
{
  const bad: NetGraph = { components: [{ ref: 'C1', value: '10uF', name: 'C' }, { ref: '', value: '100nF', name: 'C' }], nets: [net('VOUT', 'C1.1', '.1')] }
  const draws = (el: Parameters<typeof createElement>[0]) => { try { return renderToStaticMarkup(createElement(el, { graph: bad })).length > 0 } catch (e) { return String(e) } }
  const schem = draws(CircuitCanvas), pcb = draws(PCBLayout)
  check('G6 a part with an empty reference draws instead of blanking the screen', schem === true && pcb === true, `schematic ${schem}, pcb ${pcb}`)
}

// F9b. where the target is not known the instruction asks the AI editor to ask, not guess
{
  const [h] = ercFixes([{ rule: 'floating_pin', severity: 'error', message: '', refs: [{ ref: 'Q1', pin: '3', sym: '2', name: 'D' }], net: null }],
    { components: [{ ref: 'Q1', value: 'Q', name: 'Q_NMOS' }], nets: [] })
  check('F9b unknown target: ask, do not guess', !!h?.chat && /확실하지 않으면 바꾸지 말고/.test(h.chat), h?.chat)
}

// F9. every netlist fix carries an instruction for the AI editor naming the pins and the net
{
  const g: NetGraph = { components: [{ ref: 'Q1', value: '2N7002', name: 'Q_NMOS' }, { ref: 'U1', value: 'NE555', name: 'NE555' }],
    nets: [net('VCC', 'U1.8'), net('GND', 'U1.1')] }
  const f: ErcFinding[] = [
    { rule: 'floating_pin', severity: 'error', message: '', refs: [{ ref: 'Q1', pin: '2', sym: '3', name: 'S' }, { ref: 'Q1', pin: '3', sym: '2', name: 'D' }], net: null },
    { rule: 'floating_pin', severity: 'error', message: '', refs: [{ ref: 'U1', pin: '4', sym: '4', name: 'RESET' }], net: null },
  ]
  const [q, u] = ercFixes(f, g)
  check('F9 AI-editor instructions with pins, nets and where such pins go', !!q?.chat && /Q1의 S 핀\(3번\), D 핀\(2번\)/.test(q.chat) && /GND나 감지 저항/.test(q.chat) && /부하/.test(q.chat)
    && u?.chat === 'U1의 RESET 핀(4번)을 VCC 넷에 연결해줘. 다른 연결은 그대로 둬.', `${q?.chat} | ${u?.chat}`)
}

// D1. after an AI edit, the board built from it gives its own .net in the Netlist tab and the top bar's .net button:
// the generated .net went with the edited .kicad_pcb, two files of two circuits downloaded together (2026-11-03 tour
// takes 1 and 3, S17). No edit, no finished board, or a board of another circuit: the generated one, notes as before.
// The name is the server's: the edited circuit's .net and its board share one stem (/generate_pcb_stream)
{
  const pcb = 'blinky_1a2b3c4d.kicad_pcb'
  const own = boardNetlist(true, 'done', null, pcb), style = boardNetlist(true, 'done', 'style', pcb)
  const generated = [boardNetlist(false, 'done', null, pcb), boardNetlist(true, 'loading', null, pcb), boardNetlist(true, 'done', 'circuit', pcb),
    boardNetlist(true, 'done', null, null)]
  const notes = /\.kicad_pcb와 같은 회로입니다/.test(netlistNote(true, own) ?? '') && /이 넷리스트 파일에 없습니다/.test(netlistNote(true, null) ?? '')
    && netlistNote(false, null) === null
  const src = fs.readFileSync(path.join('src', 'components', 'ResultPanel.tsx'), 'utf8')
  const wired = /const boardNet = boardNetlist\(aiEdited, pcbStatus, pcbStale, pcbFilename\)/.test(src) && /const netFile = boardNet \?\? result\?\.filename/.test(src)
    && /download\/\$\{netFile\}`/.test(src) && !/download\/\$\{result\.filename\}/.test(src)
    && /\(boardNet \? null : result\.netlist\) \|\| \(netText && netText\.file === netFile/.test(src)
    && /netText\.file === netFile && \(boardNet \|\| !result\.netlist\)/.test(src)
  const server = fs.readFileSync(path.join('server', 'index.ts'), 'utf8')
  const sameStem = /if \(graph\) \{\s*const netFilename = `\$\{fileStem\(baseName\)\}_[^`]*\.net`[\s\S]{0,200}?pcbFilename = netFilename\.replace\('\.net', '\.kicad_pcb'\)/.test(server)
  check('D1 after an AI edit the board\'s own .net is shown and downloaded; otherwise the generated one',
    own === 'blinky_1a2b3c4d.net' && style === own && generated.every(x => x === null) && notes && wired && sameStem,
    JSON.stringify({ own, style, generated, notes, wired, sameStem }))
}

// D2. after an AI edit the Guide tab says it is the generated circuit's guide, as the Code and Netlist tabs say they are
// not the edit: it said nothing, and its wiring order could guide a circuit other than the one on screen (2026-11-03
// tour, S09 after the S06b and S06c edits). A code run keeps its own line; no change, no line
{
  const ai = guideNote(false, true), both = guideNote(true, true), code = guideNote(true, false)
  const src = fs.readFileSync(path.join('src', 'components', 'ResultPanel.tsx'), 'utf8')
  const wired = /const guideLine = guideNote\(!!result\?\.codeEdited, aiEdited, editWord\)/.test(src) && /\{guideLine && <div style=\{drawerNote\}>\{guideLine\}<\/div>\}/.test(src)
  // a hand edit on the schematic is not called an AI edit (2026-11-06)
  const hand = [guideNote(false, true, '편집'), netlistNote(true, null, '편집'), netlistNote(true, 'x.net', '편집')]
  check('D2 the Guide tab says an AI edit is not in it; a code run keeps its line',
    /AI 편집으로 바꾼 곳은 안내에 없습니다/.test(ai ?? '') && both === ai && /코드를 고친 뒤에는/.test(code ?? '') && guideNote(false, false) === null && wired
    && hand.every(t => !!t && !/AI/.test(t) && /편집/.test(t)),
    JSON.stringify({ ai, both, code, wired }))
}

console.log(failed ? `${failed} CHECK(S) FAILED` : `ALL PASS${skipped ? ` (${skipped} skipped: not counted as passed)` : ''}`)
process.exit(failed ? 1 : 0)
