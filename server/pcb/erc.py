"""
Electrical checks on the netlist (the schematic side of "is this circuit sane?").

The netlist carries a pintype for every node (POWER-IN, POWER-OUT, INPUT,
OUTPUT, PASSIVE), which is enough for a handful of checks that catch the
mistakes an LLM-generated circuit actually makes. Messages are Korean because
they are shown in the app.
"""
import re

POWER_NAME = re.compile(r'^(VCC|VDD|VEE|VSS|VIN|VOUT|VBAT|AVCC|\+?\d+V\d*|\+\d+V|PWR|POWER)$', re.I)
SOURCE_TYPES = {'POWER-OUT', 'OUTPUT', 'BIDIRECTIONAL', 'TRISTATE'}
# power that arrives through a connector or battery has passive pins, but it is a source
SOURCE_PREFIXES = ('J', 'BT')
# symbol pin names per template, so a message can say which pin ("4번(RESET)"); the same table as
# PIN_NAMES in src/lib/humanReview.ts (scripts/check_board_checks.ts compares the two)
PIN_NAMES = {
    'CP': ['+', '-'],
    'LED': ['A', 'K'],
    'D': ['A', 'K'],
    'Q_NPN': ['B', 'C', 'E'],
    'Q_NMOS': ['G', 'D', 'S'],
    'REG': ['GND', 'OUT', 'IN'],
    'NE555': ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THRES', 'DISCH', 'VCC'],
    'Relay': ['COIL1', 'COIL2', 'COM', 'NO', 'NC'],
    'Buzzer': ['+', '-'],
    'Battery': ['+', '-'],
}


def pin_label(part, pad):
    """'4번(RESET)' for a footprint pad whose symbol pin has a name, else '4번'."""
    sym = (part.get('pad_sym') or part.get('pad_pin') or {}).get(pad)
    names = PIN_NAMES.get(part.get('part', ''))
    name = names[sym - 1] if names and sym and 0 < sym <= len(names) else None
    return f"{pad}번({name})" if name else f"{pad}번"


def check(components, nets, parts=None):
    """[{rule, severity, message, refs:[{ref,pin}], net}] — parts (board model) gives pin counts."""
    findings = []

    # 1. pads that carry no net (the pin was never connected in the netlist)
    if parts:
        for p in parts:
            # a footprint can repeat a pad number (tab pins); count each number once
            loose = sorted({pad['num'] for pad in p['pads'] if pad['net'] is None}, key=lambda s: (len(s), s))
            if loose:
                findings.append({
                    'rule': 'floating_pin', 'severity': 'error',
                    'message': f"{p['ref']}의 핀 {', '.join(pin_label(p, n) for n in loose)}이 어느 넷에도 연결되지 않았습니다",
                    'refs': [{'ref': p['ref'], 'pin': n} for n in loose], 'net': None})

    # 2. nets with a single pin
    for n in nets:
        if len(n['nodes']) == 1:
            nd = n['nodes'][0]
            findings.append({
                'rule': 'single_pin_net', 'severity': 'error',
                'message': f"넷 '{n['name']}'에 핀이 {nd['ref']}.{nd['pin']} 하나뿐입니다 (연결이 끊긴 선)",
                'refs': [{'ref': nd['ref'], 'pin': nd['pin']}], 'net': n['name']})

    # 3. no ground
    if not any(n['name'].upper() in ('GND', 'AGND', 'DGND', 'PGND') for n in nets):
        findings.append({'rule': 'no_ground', 'severity': 'error',
                         'message': 'GND 넷이 없습니다 (기준 전위가 없는 회로)', 'refs': [], 'net': None})

    # 4. power net with nothing driving it
    for n in nets:
        if not POWER_NAME.match(n['name']):
            continue
        powered = any(nd.get('pintype', '').upper() in SOURCE_TYPES or
                      nd['ref'].rstrip('0123456789') in SOURCE_PREFIXES for nd in n['nodes'])
        if not powered:
            findings.append({
                'rule': 'unpowered_rail', 'severity': 'warning',
                'message': f"전원 넷 '{n['name']}'에 공급원(전원 출력 핀)이 없습니다",
                'refs': [{'ref': nd['ref'], 'pin': nd['pin']} for nd in n['nodes'][:4]], 'net': n['name']})

    # 5. two or more driving outputs on one net
    for n in nets:
        outs = [nd for nd in n['nodes'] if nd.get('pintype', '').upper() == 'OUTPUT']
        if len(outs) > 1:
            findings.append({
                'rule': 'output_conflict', 'severity': 'warning',
                'message': f"넷 '{n['name']}'에 출력 핀이 {len(outs)}개 (" +
                           ', '.join(f"{o['ref']}.{o['pin']}" for o in outs) + ") 있습니다 — 출력끼리 충돌",
                'refs': [{'ref': o['ref'], 'pin': o['pin']} for o in outs], 'net': n['name']})

    return findings
