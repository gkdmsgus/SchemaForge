import type { NetGraph } from '../types'

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

  const pinNets = new Map<string, string[]>()
  for (const net of nets) for (const node of net.nodes) {
    const key = `${node.ref}.${node.pin}`
    pinNets.set(key, [...(pinNets.get(key) || []), net.name])
  }
  for (const [pin, names] of pinNets) if (names.length > 1) add({ code: 'CIR006', severity: 'error', title: '핀의 넷이 충돌합니다', message: `${pin}이 ${names.join(', ')} 넷에 동시에 들어 있습니다.`, suggestion: '이 핀은 하나의 넷에만 남기세요.', chat: `${pin}이 ${names.join(', ')} 넷에 동시에 들어 있어. ${pin}을 맞는 넷 하나에만 남겨줘.`, refs: [pin.split('.')[0]], nets: names })

  const resistors = new Set(components.filter(c => c.name === 'R' || /^R\d+$/i.test(c.ref)).map(c => c.ref))
  for (const led of components.filter(c => c.name === 'LED')) {
    const ledNets = nets.filter(n => n.nodes.some(node => node.ref === led.ref))
    if (!ledNets.some(n => n.nodes.some(node => resistors.has(node.ref)))) add({ code: 'CIR101', severity: 'error', title: 'LED 전류 제한 저항이 없습니다', message: `${led.ref}와 직접 연결된 전류 제한 저항을 찾지 못했습니다. LED가 손상될 수 있습니다.`, suggestion: '전원과 LED 사이에 계산된 직렬 저항을 추가하세요.', chat: `${led.ref} LED에 전류 제한 저항이 없어. 전원과 ${led.ref}의 A 핀 사이에 저항을 하나 넣어줘. 값은 LED 전류가 10~20 mA가 되게 정해줘.`, refs: [led.ref], nets: ledNets.map(n => n.name) })
  }

  for (const transistor of components.filter(c => c.name === 'Q_NMOS' || c.name === 'Q_NPN')) {
    const controlNet = nets.find(n => n.nodes.some(node => node.ref === transistor.ref && String(node.pin) === '1'))
    if (!controlNet || controlNet.nodes.length < 2) add({ code: 'CIR102', severity: 'error', title: '트랜지스터 제어 핀이 떠 있습니다', message: `${transistor.ref}의 ${transistor.name === 'Q_NMOS' ? '게이트' : '베이스'} 핀에 유효한 제어 경로가 없습니다.`, suggestion: '제어 신호와 바이어스 저항 연결을 복구하세요.', chat: `${transistor.ref}의 ${transistor.name === 'Q_NMOS' ? '게이트' : '베이스'} 핀에 제어 신호가 없어. 제어 신호 커넥터나 출력 핀에서 저항을 거쳐 ${transistor.ref}의 ${transistor.name === 'Q_NMOS' ? '게이트' : '베이스'}로 이어줘.`, refs: [transistor.ref], nets: controlNet ? [controlNet.name] : [] })
  }

  const protectedLoad = components.filter(c => /MOTOR/i.test(c.value || '') || c.name === 'Relay')
  if (protectedLoad.length && !components.some(c => c.name === 'D')) add({ code: 'CIR201', severity: 'warning', title: '역기전력 보호가 없습니다', message: '모터 또는 릴레이는 꺼질 때 큰 역전압을 만들 수 있는데 보호 다이오드가 없습니다.', suggestion: '부하 양단에 방향을 확인한 플라이백 다이오드를 추가하세요.', chat: `${protectedLoad.map(c => c.ref).join(', ')} 양단에 보호 다이오드를 추가해줘. 다이오드의 K(캐소드)는 전원 쪽, A(애노드)는 트랜지스터 쪽에 연결해줘.`, refs: protectedLoad.map(c => c.ref), nets: [] })

  return issues
}
