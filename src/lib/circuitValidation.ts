import type { NetGraph } from '../types'
import { pinNumber } from './graphEdit'
import { fromGraph, ledsWithoutResistor, lithiumPack } from './operatingCheck'

export interface CircuitIssue {
  code: string
  severity: 'error' | 'warning'
  title: string
  message: string
  suggestion: string
  /** an instruction for the AI editor that fixes it, put into the chat box by the 해결 button (sent by the person) */
  chat: string
  refs: string[]
  nets: string[]
  /** safety advice for the design (CIR202, CIR203), not a broken connection: the schematic folds the advice a circuit came
   *  with into a chip, and opens the box only for advice an edit brought in */
  advice?: true
}

/** Fast static checks for failures that can be inferred from the editable graph. */
export function validateCircuit(graph: NetGraph | null | undefined): CircuitIssue[] {
  if (!graph) return []
  const components = graph.components || []
  const nets = graph.nets || []
  const refs = new Set(components.map(c => c.ref))
  const issues: CircuitIssue[] = []
  const add = (issue: CircuitIssue) => {
    if (!issues.some(i => i.code === issue.code && i.message === issue.message)) issues.push(issue)
  }

  if (!components.length) add({ code: 'CIR001', severity: 'error', title: '회로가 비어 있습니다', message: '동작할 부품이 하나도 남아 있지 않습니다.', suggestion: '필요한 부품을 다시 추가하세요.', chat: '회로가 비었어. 처음 회로에 있던 부품과 연결을 다시 추가해줘.', refs: [], nets: [] })

  for (const net of nets) {
    const dangling = net.nodes.filter(n => !refs.has(n.ref))
    if (dangling.length) add({ code: 'CIR002', severity: 'error', title: '삭제된 부품을 가리키는 연결', message: `${net.name} 넷이 존재하지 않는 ${dangling.map(n => `${n.ref}.${n.pin}`).join(', ')} 핀을 참조합니다.`, suggestion: '해당 연결을 제거하거나 부품을 복구하세요.', chat: `${net.name} 넷에서 없는 부품의 연결(${dangling.map(n => `${n.ref}.${n.pin}`).join(', ')})을 지워줘. 다른 연결은 그대로 둬.`, refs: dangling.map(n => n.ref), nets: [net.name] })
    if (net.nodes.length === 1) {
      const node = net.nodes[0]
      add({ code: 'CIR003', severity: 'error', title: '연결이 끊긴 선', message: `${net.name} 넷에 ${node.ref}.${node.pin} 하나만 남아 전류가 흐를 경로가 없습니다.`, suggestion: '삭제한 부품을 복구하거나 이 핀을 올바른 넷에 연결하세요.', chat: `${net.name} 넷에 ${node.ref}.${node.pin} 하나만 남아 끊겨 있어. 이 넷에 원래 이어져야 할 핀을 다시 연결해줘. 필요 없는 넷이면 지워줘.`, refs: [node.ref], nets: [net.name] })
    }
  }

  for (const component of components) {
    if (!nets.some(n => n.nodes.some(node => node.ref === component.ref))) add({ code: 'CIR004', severity: 'error', title: '회로에서 분리된 부품', message: `${component.ref}가 어느 넷에도 연결되어 있지 않습니다.`, suggestion: `${component.ref}의 핀을 회로에 연결하거나 부품을 제거하세요.`, chat: `${component.ref}가 어디에도 연결되어 있지 않아. ${component.ref}의 핀을 회로의 맞는 넷에 연결해줘. 필요 없는 부품이면 ${component.ref}를 지워줘.`, refs: [component.ref], nets: [] })
  }

  if (components.length && !nets.some(n => /^(GND|AGND|DGND|PGND)$/i.test(n.name))) add({ code: 'CIR005', severity: 'error', title: '기준 접지가 없습니다', message: 'GND 넷이 없어 전압의 기준점과 귀환 경로를 확인할 수 없습니다.', suggestion: '전원 음극과 회로의 귀환 경로를 GND 넷으로 연결하세요.', chat: 'GND 넷이 없어. 배터리나 전원의 − 단자가 있는 넷의 이름을 GND로 바꿔줘. 연결된 핀은 그대로 둬.', refs: [], nets: [] })

  // one pin by its number in one net and by its name in another (D1.1 and D1.A) is one pin on two nets: read through the
  // pin-name table as the board generator reads it (2026-11-08), which would otherwise put the pad on one of them unasked.
  // The same pin twice in one net is on one net
  const kindOf = new Map(components.map(c => [c.ref, c.name]))
  const pinNets = new Map<string, Set<string>>(), written = new Map<string, Set<string>>()
  for (const net of nets) for (const node of net.nodes) {
    const key = `${node.ref}.${pinNumber(kindOf.get(node.ref), String(node.pin))}`
    pinNets.set(key, (pinNets.get(key) ?? new Set()).add(net.name))
    written.set(key, (written.get(key) ?? new Set()).add(`${node.ref}.${node.pin}`))
  }
  for (const [key, on] of pinNets) if (on.size > 1) {
    const pin = [...written.get(key)!].join('/'), names = [...on]
    add({ code: 'CIR006', severity: 'error', title: '핀의 넷이 충돌합니다', message: `${pin}이 ${names.join(', ')} 넷에 동시에 들어 있습니다.`, suggestion: '이 핀은 하나의 넷에만 남기세요.', chat: `${pin}이 ${names.join(', ')} 넷에 동시에 들어 있어. ${pin}을 맞는 넷 하나에만 남겨줘.`, refs: [key.split('.')[0]], nets: names })
  }

  // a part counts as a resistor by its type or its reference, as it did here: an edit may have saved R3 under a name of its own
  const resistors = new Set(components.filter(c => c.name === 'R' || /^R\d+$/i.test(c.ref)).map(c => c.ref))
  const kinds = new Map(components.map(c => [c.ref, resistors.has(c.ref) ? 'R' : c.name]))
  // a pin an older edit saved by its name (D1 'A', BT1 '+') is read through the template's pin-name table, as the AI editor
  // reads it now (2026-11-07: such a graph had its resistor and was refused, the walk saw no pins on the LED). A name the
  // table does not know is not guessed: the LED it is on is not judged here, and a net it is on may hold the resistor
  const unread = new Set<string>(), unjudged = new Set<string>()
  const read = nets.map(n => ({ ...n, nodes: n.nodes.map(node => {
    const kind = kinds.get(node.ref), pin = pinNumber(kind, String(node.pin))
    if (kind && !/^\d+$/.test(pin)) { unread.add(n.name); if (kind === 'LED') unjudged.add(node.ref) }
    return { ...node, pin }
  }) }))
  const walked = fromGraph({ ...graph, components: components.map(c => (resistors.has(c.ref) ? { ...c, name: 'R' } : c)), nets: read })
  for (const string of ledsWithoutResistor(walked, unread)) {
    if (string.some(ref => unjudged.has(ref))) continue
    const names = string.join('·')
    add({ code: 'CIR101', severity: 'error', title: 'LED 전류 제한 저항이 없습니다', message: `${names}에 직렬로 이어진 전류 제한 저항을 찾지 못했습니다. LED가 손상될 수 있습니다.`, suggestion: '전원과 LED 사이에 계산된 직렬 저항을 추가하세요.', chat: `${names} LED에 전류 제한 저항이 없어. 전원과 ${string[0]}의 A 핀 사이에 저항을 하나 넣어줘. 값은 LED 전류가 10~20 mA가 되게 정해줘.`, refs: string, nets: nets.filter(n => n.nodes.some(node => string.includes(node.ref))).map(n => n.name) })
  }

  for (const transistor of components.filter(c => c.name === 'Q_NMOS' || c.name === 'Q_NPN')) {
    // the base or gate is template pin 1, also when an older edit saved it by name ('B', 'G'): read through the same table
    // (2026-11-08: a base saved as 'B' read as floating and the PCB was refused). A name the table does not know is not
    // guessed: it may be that pin, so this transistor is not judged here (the operating check says 판단 불가 for it)
    const own = nets.flatMap(n => n.nodes.filter(node => node.ref === transistor.ref).map(node => ({ n, pin: pinNumber(transistor.name, String(node.pin)) })))
    if (own.some(o => !/^\d+$/.test(o.pin))) continue
    const controlNet = own.find(o => o.pin === '1')?.n
    if (!controlNet || controlNet.nodes.length < 2) add({ code: 'CIR102', severity: 'error', title: '트랜지스터 제어 핀이 떠 있습니다', message: `${transistor.ref}의 ${transistor.name === 'Q_NMOS' ? '게이트' : '베이스'} 핀에 유효한 제어 경로가 없습니다.`, suggestion: '제어 신호와 바이어스 저항 연결을 복구하세요.', chat: `${transistor.ref}의 ${transistor.name === 'Q_NMOS' ? '게이트' : '베이스'} 핀에 제어 신호가 없어. 제어 신호 커넥터나 출력 핀에서 저항을 거쳐 ${transistor.ref}의 ${transistor.name === 'Q_NMOS' ? '게이트' : '베이스'}로 이어줘.`, refs: [transistor.ref], nets: controlNet ? [controlNet.name] : [] })
  }

  const protectedLoad = components.filter(c => /MOTOR/i.test(c.value || '') || c.name === 'Relay')
  if (protectedLoad.length && !components.some(c => c.name === 'D')) add({ code: 'CIR201', severity: 'warning', title: '역기전력 보호가 없습니다', message: '모터 또는 릴레이는 꺼질 때 큰 역전압을 만들 수 있는데 보호 다이오드가 없습니다.', suggestion: '부하 양단에 방향을 확인한 플라이백 다이오드를 추가하세요.', chat: `${protectedLoad.map(c => c.ref).join(', ')} 양단에 보호 다이오드를 추가해줘. 다이오드의 K(캐소드)는 전원 쪽, A(애노드)는 트랜지스터 쪽에 연결해줘.`, refs: protectedLoad.map(c => c.ref), nets: [] })

  // ── the supply side, for a beginner's board (2026-11-14, src-yt-capstone2026-robot-teams in the vault) ──
  // pins read through the pin-name table, as above; nets by name with their nodes
  const isGndName = (n: string) => /^(GND|AGND|DGND|PGND|0V|VSS)$/i.test(n)
  const on = new Map(read.map(n => [n.name, n.nodes]))
  const netOf = (ref: string, pin: string) => read.find(n => n.nodes.some(nd => nd.ref === ref && nd.pin === pin))?.name ?? null
  // where the supply comes in: a battery's + and the non-ground pins of a header named as a supply (DC jack, PWR_IN, VIN)
  const supplyIn = components.flatMap(c => {
    if (c.name === 'Battery') { const n = netOf(c.ref, '1'); return n ? [{ ref: c.ref, net: n }] : [] }
    if (/^Conn_/.test(c.name ?? '') && /PWR|POWER|전원|\bDC\b|DC_?IN|DC_?JACK|VIN|BAT|배터리|ADAPTER|어댑터/i.test(c.value || '') && !/MOTOR|모터/i.test(c.value || '')) {
      return read.filter(n => !isGndName(n.name) && n.nodes.some(nd => nd.ref === c.ref)).map(n => ({ ref: c.ref, net: n.name }))
    }
    return []
  })
  const kindOfRef = (ref: string) => kinds.get(ref) ?? ''

  // CIR202. no reverse-polarity protection: the supply's + goes straight on to the circuit. Protected when, past switches
  // on the way, its net holds nothing but the supply, a series diode's anode or a bridge rectifier's AC pin. Said only where
  // a reversed supply breaks something (an IC, a polarised capacitor, a transistor, a relay): an LED and its resistor alone
  // only stay dark. The diode is 1N5819, whose datasheet figures the app already holds (partSpecs.ts)
  const fragile = components.filter(c => ['NE555', 'REG', 'CP', 'Q_NPN', 'Q_NMOS', 'Relay', 'Buzzer'].includes(c.name ?? ''))
  if (fragile.length) {
    for (const s of supplyIn) {
      const seen = new Set<string>(), queue = [s.net]
      let bare = false
      while (queue.length && !bare) {
        const n = queue.shift()!
        if (seen.has(n)) continue
        seen.add(n)
        for (const nd of on.get(n) ?? []) {
          const k = kindOfRef(nd.ref)
          if (nd.ref === s.ref || k === 'TestPoint' || (k === 'D' && nd.pin === '1') || (k === 'Bridge' && (nd.pin === '1' || nd.pin === '2'))) continue
          if (k === 'SW' || k === 'Fuse') { const other = netOf(nd.ref, nd.pin === '1' ? '2' : '1'); if (other && !isGndName(other)) queue.push(other); continue }
          bare = true
          break
        }
      }
      if (!bare) continue
      add({ code: 'CIR202', severity: 'warning', advice: true, title: '전원 역접속 보호가 없습니다',
        message: `${s.ref} 전원에 역접속 보호가 없습니다 (역접속: 전원의 +와 −를 거꾸로 꽂는 것). 거꾸로 꽂으면 IC와 전해 커패시터에 반대 전압이 걸려 바로 타거나 터질 수 있습니다.`,
        suggestion: `${s.ref}의 + 바로 뒤에 쇼트키 다이오드 1N5819를 하나 직렬로 넣습니다(띠가 있는 쪽이 회로 쪽). 이 다이오드에서 최대 0.6 V가 줄어듭니다.`,
        chat: `${s.ref}의 + 바로 뒤에 쇼트키 다이오드 1N5819를 직렬로 추가해줘. 다이오드의 A(애노드)는 ${s.ref}의 +에, K(캐소드)는 원래 ${s.ref}의 +에 이어져 있던 회로 쪽에 연결해줘.`,
        refs: [s.ref], nets: [s.net] })
    }
  }

  // CIR203. no emergency stop for a motor: from the motor, along the way its current takes (diodes, inductors, resistors, a
  // regulator's input and output, a transistor's channel, a relay's contacts), the supply's + is reached without a switch a
  // person works (SW). Ground nets end the walk. A motor whose supply cannot be traced is not judged
  const supplyNets = new Set(supplyIn.map(s => s.net))
  const through: Record<string, string[][]> = {
    D: [['1', '2']], L: [['1', '2']], R: [['1', '2']], Fuse: [['1', '2']], REG: [['3', '2']], Q_NPN: [['2', '3']], Q_NMOS: [['2', '3']],
    Relay: [['3', '4'], ['3', '5']],
  }
  for (const m of components.filter(c => /MOTOR|모터/i.test(c.value || ''))) {
    const seen = new Set<string>()
    const queue = read.filter(n => !isGndName(n.name) && n.nodes.some(nd => nd.ref === m.ref)).map(n => n.name)
    let reached: string | null = null
    while (queue.length && !reached) {
      const n = queue.shift()!
      if (seen.has(n) || isGndName(n)) continue
      seen.add(n)
      if (supplyNets.has(n)) { reached = n; break }
      for (const nd of on.get(n) ?? []) {
        if (nd.ref === m.ref) continue
        for (const [a, b] of through[kindOfRef(nd.ref)] ?? []) {
          const other = nd.pin === a ? b : nd.pin === b ? a : null
          const next = other && netOf(nd.ref, other)
          if (next && !seen.has(next)) queue.push(next)
        }
      }
    }
    if (!reached) continue
    const src = supplyIn.find(s => s.net === reached)!.ref
    add({ code: 'CIR203', severity: 'warning', advice: true, title: '모터 비상정지 스위치가 없습니다',
      message: `모터 ${m.ref}의 전원을 손으로 바로 끊을 스위치가 없습니다 (비상정지: 문제가 생겼을 때 사람이 전원을 끊는 장치). 프로그램이 멈추거나 트랜지스터가 고장 나 켜진 채로 붙으면 모터가 계속 돌아 손이나 물건이 끼일 수 있습니다.`,
      suggestion: `${src}의 +와 모터 ${m.ref} 사이에 모터 전류를 견디는 스위치를 하나 넣습니다. 사람이 다칠 수 있는 로봇이면 누르면 끊기는 비상정지 버튼을 씁니다.`,
      chat: `${src}의 +와 모터 ${m.ref} 전원 사이에 스위치(SW)를 직렬로 추가해줘. 스위치를 끄면 모터 전원이 끊기게 해줘.`,
      refs: [m.ref], nets: [reached] })
  }

  // CIR205. no fuse where a short would be a fire (2026-11-17): a lithium-ion battery (lithiumPack), or any supply when the
  // circuit drives a motor. From the supply's +, past switches and series diodes, a part is reached before a fuse (Fuse). No
  // rating is given: it is the circuit's largest current and the fuse's datasheet that decide it
  const motorHere = components.some(c => /MOTOR|모터/i.test(c.value || ''))
  for (const s of supplyIn) {
    const lith = components.find(c => c.ref === s.ref && c.name === 'Battery' && lithiumPack(c.value || ''))
    if (!lith && !motorHere) continue
    const seen = new Set<string>(), queue = [s.net], crossed = new Set<string>()   // parts walked through: their far pin is no load
    let bare = false
    while (queue.length && !bare) {
      const n = queue.shift()!
      if (seen.has(n)) continue
      seen.add(n)
      for (const nd of on.get(n) ?? []) {
        const k = kindOfRef(nd.ref)
        if (nd.ref === s.ref || k === 'TestPoint' || k === 'Fuse' || crossed.has(nd.ref)) continue
        if (k === 'SW' || (k === 'D' && nd.pin === '1')) { crossed.add(nd.ref); const other = netOf(nd.ref, nd.pin === '1' ? '2' : '1'); if (other && !isGndName(other)) queue.push(other); continue }
        bare = true
        break
      }
    }
    if (!bare) continue
    add({ code: 'CIR205', severity: 'warning', advice: true, title: '전원에 퓨즈가 없습니다',
      message: `${s.ref} 전원에 퓨즈가 없습니다 (퓨즈: 전류가 너무 많이 흐르면 스스로 끊어져 회로를 지키는 부품). 선끼리 닿는 단락이 생기면 ${lith ? '리튬 배터리가' : '모터를 돌리는 전원이'} 큰 전류를 그대로 내보내, 선과 기판이 뜨거워지고 불이 날 수 있습니다.`,
      suggestion: `${s.ref}의 + 바로 뒤에 퓨즈나 PTC(되살아나는 퓨즈)를 하나 직렬로 넣습니다. 정격 전류는 회로가 평소 쓰는 가장 큰 전류보다 크게, 퓨즈 데이터시트를 보고 고릅니다.`,
      chat: `${s.ref}의 + 바로 뒤에 퓨즈(Fuse)를 직렬로 추가해줘. 퓨즈의 1번 핀은 ${s.ref}의 +에, 2번 핀은 원래 ${s.ref}의 +에 이어져 있던 회로 쪽에 연결해줘.`,
      refs: [s.ref], nets: [s.net] })
  }

  // CIR206-CIR207. an RS-485 transceiver (TI SN75176B, 2026-11-17). 206: its direction pins (2 ~RE, 3 DE) joined to nothing
  // else: the chip neither knows when to talk nor when to listen. 207 (advice): a resistor straight across A and B is the
  // bus's termination, right only on the two boards at the bus's ends (SN75176B datasheet SLLS101I, 7.2: "terminate the
  // line at both ends in its characteristic impedance", its CAT-5E example 120 Ω)
  for (const u of components.filter(c => c.name === 'RS485')) {
    const loose = [['2', 'RE'], ['3', 'DE']].filter(([pin]) => {
      const n = netOf(u.ref, pin)
      return !n || (on.get(n) ?? []).every(nd => nd.ref === u.ref)
    })
    if (loose.length) {
      add({ code: 'CIR206', severity: 'warning', title: 'RS-485 방향 핀이 연결되지 않았습니다',
        message: `${u.ref}의 ${loose.map(([, nm]) => nm).join('·')} 핀이 아무 데도 연결되지 않았습니다 (방향 핀: 지금 말할지 들을지 정하는 핀). RS-485는 선 한 쌍을 여러 기기가 나눠 써서 한 번에 한 기기만 말해야 하는데, 이 핀이 떠 있으면 칩이 언제 보내고 받을지 정해지지 않아 통신이 되지 않습니다.`,
        suggestion: `${u.ref}의 RE(2번)와 DE(3번)를 서로 잇고, 마이크로컨트롤러의 출력 핀 하나에 연결합니다. 그 핀을 높게 하면 보내고, 낮게 하면 받습니다.`,
        chat: `${u.ref}의 2번(RE)과 3번(DE) 핀을 같은 넷 RS485_DIR로 묶어줘.`,
        refs: [u.ref], nets: [] })
    }
    const a = netOf(u.ref, '6'), b = netOf(u.ref, '7')
    const term = a && b && a !== b ? components.find(c => c.name === 'R' && [netOf(c.ref, '1'), netOf(c.ref, '2')].sort().join() === [a, b].sort().join()) : undefined
    if (term) {
      add({ code: 'CIR207', severity: 'warning', advice: true, title: 'RS-485 종단 저항은 버스 양 끝에만 둡니다',
        message: `${u.ref}의 A와 B 사이에 종단 저항(${term.ref})이 있습니다 (종단 저항: 선 끝에서 신호가 튕겨 돌아오지 않게 막는 저항). 종단 저항은 버스의 물리적인 양 끝 두 기기에만 둡니다. 가운데 기기에도 달면 신호가 약해져 통신이 불안정해집니다.`,
        suggestion: `이 보드가 버스의 맨 끝이 아니면 이 저항을 빼거나, 스위치나 점퍼로 켜고 끌 수 있게 합니다. 값은 선의 특성 임피던스와 같게 합니다 (TI SN75176B 데이터시트의 예: CAT-5E 선에 120 Ω).`,
        chat: `종단 저항 ${term.ref}에 스위치(SW)를 직렬로 추가해, 이 보드가 버스 끝일 때만 종단 저항이 이어지게 해줘.`,
        refs: [term.ref, u.ref], nets: [a!, b!] })
    }
  }

  // CIR204. a servo powered from the microcontroller board alone (2026-11-17): a header whose value says SERVO, its supply
  // pin's net (named as a supply: 5V, VCC, VIN, VBUS…) fed by a board's header (Arduino, ESP32, Pico…) or USB and by
  // nothing else that supplies (a battery, a regulator's output, a supply header). No figure is given: the stall current
  // and the capacitor are the servo's own datasheet's
  const BOARD_WORDS = /ARDUINO|\bUNO\b|\bNANO\b|\bMEGA\b|ESP-?32|ESP-?8266|PICO|RASPBERRY|STM32|\bUSB\b/i
  const SUPPLY_NET = /(^|[^A-Z])(\d+V\d*|VCC|VDD|VIN|VBUS|V\+|PWR|POWER|USB)([^A-Z]|$)/i
  const supplies = (nd: { ref: string; pin: string }) => {
    const c = components.find(x => x.ref === nd.ref)
    const k = c?.name ?? ''
    if (k === 'Battery') return nd.pin === '1'
    if (k === 'REG') return nd.pin === '2'
    return /^Conn_/.test(k) && !/SERVO|서보|MOTOR|모터/i.test(c?.value || '') && !BOARD_WORDS.test(c?.value || '')
  }
  for (const sv of components.filter(c => /^Conn_/.test(c.name ?? '') && /SERVO|서보/i.test(c.value || ''))) {
    for (const n of read.filter(x => !isGndName(x.name) && SUPPLY_NET.test(x.name) && x.nodes.some(nd => nd.ref === sv.ref))) {
      const boards = [...new Set(n.nodes.filter(nd => nd.ref !== sv.ref && BOARD_WORDS.test(components.find(c => c.ref === nd.ref)?.value || '')).map(nd => nd.ref))]
      if (!boards.length || n.nodes.some(nd => nd.ref !== sv.ref && supplies(nd))) continue
      add({ code: 'CIR204', severity: 'warning', advice: true, title: '서보 전원이 보드에서만 나옵니다',
        message: `서보 ${sv.ref}의 전원을 ${boards.join(', ')} 보드(또는 USB)에서만 받습니다. 서보는 움직이기 시작하는 순간 전류를 크게 당겨서, 보드의 5 V가 순간 떨어지고 보드가 다시 켜질 수 있습니다 (브라운아웃: 전압이 잠깐 떨어져 칩이 리셋되는 것).`,
        suggestion: `서보 전원은 배터리나 별도 5 V 전원에서 따로 받고, 그 전원의 GND를 보드 GND와 이어 줍니다(GND 공통). 서보 전원 바로 옆에 큰 전해 커패시터를 하나 답니다(용량은 서보 설명서를 봅니다).`,
        chat: `서보 ${sv.ref}의 전원 핀을 별도 전원 커넥터(값 PWR_IN)의 +에 연결하고, 그 커넥터의 −는 GND에 이어줘. 서보 전원과 GND 사이에 전해 커패시터(CP)를 하나 추가해줘.`,
        refs: [sv.ref], nets: [n.name] })
    }
  }

  return issues
}
