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
# symbol pin names per template, so a message can say which pin ("RESET 핀(4번)"); the same table as
# PIN_NAMES in src/lib/humanReview.ts (server/check_erc_repair.ts E19 compares the two)
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


def pin_of(part, pad):
    """(symbol pin number, pin name or None) of a footprint pad."""
    sym = (part.get('pad_sym') or part.get('pad_pin') or {}).get(pad)
    names = PIN_NAMES.get(part.get('part', ''))
    name = names[sym - 1] if names and sym and 0 < sym <= len(names) else None
    return sym, name


def pin_label(part, pad):
    """'RESET 핀(4번)' by the symbol pin the code and schematic use; the board pad is added when it differs."""
    sym, name = pin_of(part, pad)
    num = sym if sym is not None else pad
    board = f", 기판 패드 {pad}" if sym is not None and str(sym) != str(pad) else ''
    return f"{name} 핀({num}번{board})" if name else f"{num}번 핀" + (f"(기판 패드 {pad})" if board else '')


def sym_ref(part, pad):
    sym, name = pin_of(part, pad)
    return {**({'sym': str(sym)} if sym is not None else {}), **({'name': name} if name else {})}


def check(components, nets, parts=None):
    """[{rule, severity, message, refs:[{ref,pin,sym?,name?}], net}] — parts (board model) gives pin counts.

    refs.pin is the footprint pad (the board view marks it) when the board model is given, and sym/name
    the symbol pin the code and the netlist use; messages name the symbol pin.
    """
    findings = []
    by_ref = {p['ref']: p for p in (parts or [])}

    def node_ref(nd):
        """a netlist node (symbol pin) as a ref on its board pad, with the symbol pin and its name"""
        p = by_ref.get(nd['ref'])
        pad = next((pd for pd, s in (p or {}).get('pad_sym', {}).items() if str(s) == str(nd['pin'])), None)
        if p is None or pad is None:
            return {'ref': nd['ref'], 'pin': nd['pin']}
        return {'ref': nd['ref'], 'pin': pad, **sym_ref(p, pad)}

    # 1. pads that carry no net (the pin was never connected in the netlist)
    if parts:
        for p in parts:
            # a footprint can repeat a pad number (tab pins); count each number once
            loose = sorted({pad['num'] for pad in p['pads'] if pad['net'] is None}, key=lambda s: (len(s), s))
            if loose:
                findings.append({
                    'rule': 'floating_pin', 'severity': 'error',
                    'message': f"{p['ref']}의 {', '.join(pin_label(p, n) for n in loose)}이 어느 넷에도 연결되지 않았습니다",
                    # pin is the footprint pad (the board view marks it); sym/name are the symbol pin
                    'refs': [{'ref': p['ref'], 'pin': n, **sym_ref(p, n)} for n in loose], 'net': None})

    # 2. nets with a single pin
    for n in nets:
        if len(n['nodes']) == 1:
            nd = n['nodes'][0]
            findings.append({
                'rule': 'single_pin_net', 'severity': 'error',
                'message': f"넷 '{n['name']}'에 핀이 {nd['ref']}.{nd['pin']} 하나뿐입니다 (연결이 끊긴 선)",
                'refs': [node_ref(nd)], 'net': n['name']})

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
                'refs': [node_ref(nd) for nd in n['nodes'][:4]], 'net': n['name']})

    # 5. two or more driving outputs on one net
    for n in nets:
        outs = [nd for nd in n['nodes'] if nd.get('pintype', '').upper() == 'OUTPUT']
        if len(outs) > 1:
            findings.append({
                'rule': 'output_conflict', 'severity': 'warning',
                'message': f"넷 '{n['name']}'에 출력 핀이 {len(outs)}개 (" +
                           ', '.join(f"{o['ref']}.{o['pin']}" for o in outs) + ") 있습니다 — 출력끼리 충돌",
                'refs': [node_ref(o) for o in outs], 'net': n['name']})

    return findings
