"""
Electrical checks on the netlist (the schematic side of "is this circuit sane?").

A skidl netlist carries a pintype for every node (POWER-IN, POWER-OUT, INPUT,
OUTPUT, PASSIVE), which is enough for a handful of checks that catch the
mistakes an LLM-generated circuit actually makes. A netlist written from a graph
has none, so PIN_TYPES fills in the pins those checks read. Messages are Korean
because they are shown in the app.
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
    'Bridge': ['AC1', 'AC2', '+', '-'],
    'Q_NPN': ['B', 'C', 'E'],
    'Q_NMOS': ['G', 'D', 'S'],
    'REG': ['GND', 'OUT', 'IN'],
    'NE555': ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THRES', 'DISCH', 'VCC'],
    'Relay': ['COIL1', 'COIL2', 'COM', 'NO', 'NC'],
    'Buzzer': ['+', '-'],
    'Battery': ['+', '-'],
}
# The pins a template marks PWROUT or OUTPUT, by symbol pin. A netlist written from a graph (an AI edit, a session reopened
# from the history) has no pintype, so a regulator's output net read as unpowered and tied outputs as no conflict
# (2026-11-06). server/check_erc_repair.ts E27 compares this with the templates in server/index.ts.
PIN_TYPES = {
    'REG': {'2': 'POWER-OUT'},
    'Bridge': {'3': 'POWER-OUT'},
    'Battery': {'1': 'POWER-OUT', '2': 'POWER-OUT'},
    'NE555': {'3': 'OUTPUT'},
    'OpAmp': {'3': 'OUTPUT'},
}
# The supply-input pins that want a capacitor to ground beside them, by symbol pin: the pins a template marks PWRIN, less
# its ground pin. Apart from PIN_TYPES and from pintype, so a netlist with pintype and one written from a graph find the
# same (server/check_erc_repair.ts E26); E28 compares this with the templates in server/index.ts.
SUPPLY_PINS = {
    'NE555': ['8'],
    'REG': ['3'],
    'OpAmp': ['4', '5'],
}


def is_ground(name):
    """a ground net by its name: GND, AGND, DGND, PGND, or GND_x / x_GND"""
    n = (name or '').upper()
    return n in ('GND', 'AGND', 'DGND', 'PGND') or n.startswith('GND_') or n.endswith('_GND')


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
    part_of = {c['ref']: c.get('part', '') for c in components}

    def pintype(nd):
        """the node's own pintype; with none, what the part's template says of that pin"""
        return nd.get('pintype', '').upper() or PIN_TYPES.get(part_of.get(nd['ref']), {}).get(str(nd['pin']), '')

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
        powered = any(pintype(nd) in SOURCE_TYPES or
                      nd['ref'].rstrip('0123456789') in SOURCE_PREFIXES for nd in n['nodes'])
        if not powered:
            findings.append({
                'rule': 'unpowered_rail', 'severity': 'warning',
                'message': f"전원 넷 '{n['name']}'에 공급원(전원 출력 핀)이 없습니다",
                'refs': [node_ref(nd) for nd in n['nodes'][:4]], 'net': n['name']})

    # 5. two or more driving outputs on one net
    for n in nets:
        outs = [nd for nd in n['nodes'] if pintype(nd) == 'OUTPUT']
        if len(outs) > 1:
            findings.append({
                'rule': 'output_conflict', 'severity': 'warning',
                'message': f"넷 '{n['name']}'에 출력 핀이 {len(outs)}개 (" +
                           ', '.join(f"{o['ref']}.{o['pin']}" for o in outs) + ") 있습니다 — 출력끼리 충돌",
                'refs': [node_ref(o) for o in outs], 'net': n['name']})

    # 6. an IC supply pin with no capacitor from its net to ground: the chip's sudden current then comes down the long
    #    supply track and its voltage dips. A warning: the circuit may still run. Which pins: SUPPLY_PINS.
    net_of = {(nd['ref'], str(nd['pin'])): n for n in nets for nd in n['nodes']}
    pins_of = {}
    for n in nets:
        for nd in n['nodes']:
            pins_of.setdefault(nd['ref'], {})[str(nd['pin'])] = n['name']

    def bypassed(n):
        """a C or CP with one pin on this net and another on a ground net"""
        return any(part_of.get(nd['ref']) in ('C', 'CP') and
                   any(is_ground(m) for pin, m in pins_of.get(nd['ref'], {}).items() if pin != str(nd['pin']))
                   for nd in n['nodes'])

    for c in components:
        for sym in SUPPLY_PINS.get(c.get('part', ''), []):
            n = net_of.get((c['ref'], sym))
            if n is None or is_ground(n['name']) or bypassed(n):
                continue
            ref = node_ref({'ref': c['ref'], 'pin': sym})
            names = PIN_NAMES.get(c['part']) or []
            name = names[int(sym) - 1] if int(sym) <= len(names) else None
            # on the board: the pin and its pad, as the other findings say it; else the symbol pin
            label = pin_label(by_ref[c['ref']], ref['pin']) if 'sym' in ref else (f"{name} 핀({sym}번)" if name else f"{sym}번 핀")
            todo = ('레귤레이터 데이터시트가 권하는 입력 커패시터를 이 핀과 GND 사이에' if c['part'] == 'REG'
                    else '0.1 µF 커패시터를 이 핀과 GND 사이에')
            findings.append({
                'rule': 'no_bypass', 'severity': 'warning',
                'message': f"{c['ref']}의 {label} 옆에 GND로 가는 커패시터가 없습니다. {todo} {c['ref']} 가까이 달아야 합니다",
                'refs': [ref], 'net': n['name']})

    return findings
