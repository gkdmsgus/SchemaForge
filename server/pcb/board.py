"""
Netlist (.net) -> board model -> .kicad_pcb (KiCad 10 format) + .board.json

The board model is the single source of truth: the KiCad file, the JSON the
browser will draw, and later the placement/routing engines all come from it.
"""
import copy, json, math, os, re

from sexpr import QStr, parse, dumps, find, find_all
from footprints_table import lookup, KNOWN_UNMAPPED, ASSUMED_PART

HERE = os.path.dirname(os.path.abspath(__file__))
FP_DIR = os.path.join(HERE, 'footprints')

PART_GAP = 2.0        # mm between courtyards
BOARD_MARGIN = 3.0    # mm from outermost courtyard to board edge
ORIGIN = (100.0, 100.0)


# ── netlist ───────────────────────────────────────────────────────

def parse_netlist(text):
    """Return (components, nets). components: [{ref, value, part}], nets: [{name, nodes:[{ref, pin}]}]."""
    root = parse(text)
    components = []
    comps = find(root, 'components') or []
    for comp in find_all(comps, 'comp'):
        ref = str(find(comp, 'ref')[1])
        v = find(comp, 'value')
        lib = find(comp, 'libsource')
        p = find(lib, 'part') if lib else None
        components.append({'ref': ref, 'value': str(v[1]) if v and len(v) > 1 else '',
                           'part': str(p[1]) if p else ''})
    nets = []
    for net in find_all(find(root, 'nets') or [], 'net'):
        name = str(find(net, 'name')[1])
        nodes = [{'ref': str(find(n, 'ref')[1]), 'pin': str(find(n, 'pin')[1])}
                 for n in find_all(net, 'node')]
        if nodes:
            nets.append({'name': name, 'nodes': nodes})
    return components, nets


# ── footprints ────────────────────────────────────────────────────

_fp_cache = {}


def load_footprint(lib, name):
    key = (lib, name)
    if key not in _fp_cache:
        path = os.path.join(FP_DIR, lib + '.pretty', name + '.kicad_mod')
        with open(path, encoding='utf-8') as f:
            _fp_cache[key] = parse(f.read())
    return copy.deepcopy(_fp_cache[key])


def _xy(node):
    return float(node[1]), float(node[2])


def courtyard_bbox(fp):
    """Bounding box (x1, y1, x2, y2) of the F.CrtYd graphics, relative to the footprint origin."""
    pts = []
    for item in fp:
        if not (isinstance(item, list) and item and str(item[0]).startswith('fp_')):
            continue
        layer = find(item, 'layer')
        if not layer or layer[1] != 'F.CrtYd':
            continue
        kind = item[0]
        if kind in ('fp_line', 'fp_rect'):
            pts += [_xy(find(item, 'start')), _xy(find(item, 'end'))]
        elif kind == 'fp_arc':
            pts += [_xy(find(item, k)) for k in ('start', 'mid', 'end')]
        elif kind == 'fp_circle':
            cx, cy = _xy(find(item, 'center'))
            ex, ey = _xy(find(item, 'end'))
            r = math.hypot(ex - cx, ey - cy)
            pts += [(cx - r, cy - r), (cx + r, cy + r)]
        elif kind == 'fp_poly':
            pts += [_xy(p) for p in find_all(find(item, 'pts'), 'xy')]
    if not pts:
        for pad in find_all(fp, 'pad'):
            x, y = _xy(find(pad, 'at'))
            w, h = float(find(pad, 'size')[1]), float(find(pad, 'size')[2])
            pts += [(x - w / 2 - 0.25, y - h / 2 - 0.25), (x + w / 2 + 0.25, y + h / 2 + 0.25)]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def placeholder_footprint(part, pin_count):
    """A clearly marked stand-in for a part the table does not know."""
    pitch = 2.54
    w = max(1, pin_count - 1) * pitch
    fp = ['footprint', QStr('SchemaForge:UNMAPPED_' + (part or 'unknown')),
          ['layer', QStr('F.Cu')],
          ['property', QStr('Reference'), QStr('REF**'), ['at', '0', '-3', '0'], ['layer', QStr('F.SilkS')],
           ['effects', ['font', ['size', '1', '1'], ['thickness', '0.15']]]],
          ['property', QStr('Value'), QStr(''), ['at', '0', '3', '0'], ['layer', QStr('F.Fab')],
           ['effects', ['font', ['size', '1', '1'], ['thickness', '0.15']]]],
          ['fp_text', 'user', QStr('UNMAPPED'), ['at', f'{w / 2:.3f}', '1.8', '0'], ['layer', QStr('F.SilkS')],
           ['effects', ['font', ['size', '0.8', '0.8'], ['thickness', '0.12']]]],
          ['fp_rect', ['start', '-1.5', '-1.5'], ['end', f'{w + 1.5:.3f}', '1.5'],
           ['stroke', ['width', '0.05'], ['type', 'solid']], ['fill', 'no'], ['layer', QStr('F.CrtYd')]]]
    for i in range(pin_count):
        fp.append(['pad', QStr(str(i + 1)), 'thru_hole', 'circle', ['at', f'{i * pitch:.3f}', '0'],
                   ['size', '1.7', '1.7'], ['drill', '1'], ['layers', QStr('*.Cu'), QStr('*.Mask')]])
    return fp


# ── board model ───────────────────────────────────────────────────

def build_board(components, nets, style='smd'):
    # (ref, skidl pin) -> net name
    node_net = {(nd['ref'], nd['pin']): n['name'] for n in nets for nd in n['nodes']}
    max_pin = {}
    for (ref, pin) in node_net:
        if pin.isdigit():
            max_pin[ref] = max(max_pin.get(ref, 0), int(pin))

    parts, unmapped, warnings = [], [], []
    for comp in components:
        ref, part = comp['ref'], comp['part']
        entry = lookup(part, style)
        if entry:
            lib, name, pin_map = entry
            fp = load_footprint(lib, name)
            fp_id = f'{lib}:{name}'
        else:
            reason = KNOWN_UNMAPPED.get(part, 'no footprint mapping')
            unmapped.append({'ref': ref, 'part': part, 'reason': reason})
            n = max(2, max_pin.get(ref, 2))
            fp = placeholder_footprint(part, n)
            pin_map = {i: str(i) for i in range(1, n + 1)}
            fp_id = str(fp[1])

        assumed = ASSUMED_PART.get((part, style))
        value = comp['value']
        if assumed and value and assumed.upper() not in value.upper():
            warnings.append(f'{ref} ({value}): wired with the {assumed} pinout for {style.upper()}')

        pad_net = {}
        for (r, pin), net in node_net.items():
            if r != ref or not pin.isdigit():
                continue
            pad = pin_map.get(int(pin))
            if pad is None:
                warnings.append(f'{ref} pin {pin} has no pad in {fp_id}')
                continue
            pad_net[pad] = net

        parts.append({'ref': ref, 'value': value, 'part': part, 'footprint': fp_id,
                      'tree': fp, 'bbox': courtyard_bbox(fp), 'pad_net': pad_net})

    place(parts, nets)
    return parts, unmapped, warnings


def place(parts, nets):
    """Shelf packing in connectivity (BFS) order, spaced by real courtyard size."""
    adj = {p['ref']: set() for p in parts}
    for n in nets:
        refs = {nd['ref'] for nd in n['nodes'] if nd['ref'] in adj}
        for r in refs:
            adj[r] |= refs - {r}
    order, seen = [], set()
    for start in sorted(adj, key=lambda r: -len(adj[r])):
        queue = [start]
        while queue:
            r = queue.pop(0)
            if r in seen:
                continue
            seen.add(r)
            order.append(r)
            queue += sorted(adj[r] - seen)
    by_ref = {p['ref']: p for p in parts}

    sizes = [(p['bbox'][2] - p['bbox'][0], p['bbox'][3] - p['bbox'][1]) for p in parts]
    area = sum((w + PART_GAP) * (h + PART_GAP) for w, h in sizes)
    row_limit = max([w for w, _ in sizes] + [math.sqrt(area) * 1.4])

    x = y = row_h = 0.0
    for ref in order:
        p = by_ref[ref]
        x1, y1, x2, y2 = p['bbox']
        w, h = x2 - x1, y2 - y1
        if x > 0 and x + w > row_limit:
            x, y, row_h = 0.0, y + row_h + PART_GAP, 0.0
        p['x'] = round(ORIGIN[0] + x - x1, 4)
        p['y'] = round(ORIGIN[1] + y - y1, 4)
        p['rot'] = 0
        x += w + PART_GAP
        row_h = max(row_h, h)


def outline(parts):
    xs1 = [p['x'] + p['bbox'][0] for p in parts]
    ys1 = [p['y'] + p['bbox'][1] for p in parts]
    xs2 = [p['x'] + p['bbox'][2] for p in parts]
    ys2 = [p['y'] + p['bbox'][3] for p in parts]
    return (round(min(xs1) - BOARD_MARGIN, 4), round(min(ys1) - BOARD_MARGIN, 4),
            round(max(xs2) + BOARD_MARGIN, 4), round(max(ys2) + BOARD_MARGIN, 4))


# ── writers ───────────────────────────────────────────────────────

HEADER = '''(kicad_pcb
\t(version 20260206)
\t(generator "SchemaForge")
\t(generator_version "10.0")
\t(general
\t\t(thickness 1.6)
\t\t(legacy_teardrops no)
\t)
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(9 "F.Adhes" user "F.Adhesive")
\t\t(11 "B.Adhes" user "B.Adhesive")
\t\t(13 "F.Paste" user)
\t\t(15 "B.Paste" user)
\t\t(5 "F.SilkS" user "F.Silkscreen")
\t\t(7 "B.SilkS" user "B.Silkscreen")
\t\t(1 "F.Mask" user)
\t\t(3 "B.Mask" user)
\t\t(25 "Edge.Cuts" user)
\t\t(27 "Margin" user)
\t\t(31 "F.CrtYd" user "F.Courtyard")
\t\t(29 "B.CrtYd" user "B.Courtyard")
\t\t(35 "F.Fab" user)
\t\t(33 "B.Fab" user)
\t)
\t(setup
\t\t(pad_to_mask_clearance 0)
\t\t(allow_soldermask_bridges_in_footprints no)
\t)
'''

_LIB_ONLY_KEYS = {'version', 'generator', 'generator_version'}


def footprint_for_board(p):
    fp = [c for c in p['tree'] if not (isinstance(c, list) and c and c[0] in _LIB_ONLY_KEYS)]
    fp[1] = QStr(p['footprint'])
    # position right after (layer ...)
    li = next(i for i, c in enumerate(fp) if isinstance(c, list) and c and c[0] == 'layer')
    fp.insert(li + 1, ['at', f"{p['x']:.4f}", f"{p['y']:.4f}"])
    for prop in find_all(fp, 'property'):
        if prop[1] == 'Reference':
            prop[2] = QStr(p['ref'])
        elif prop[1] == 'Value':
            prop[2] = QStr(p['value'])
    for pad in find_all(fp, 'pad'):
        net = p['pad_net'].get(str(pad[1]))
        if net is not None:
            pad[:] = [c for c in pad if not (isinstance(c, list) and c and c[0] == 'net')]
            pad.append(['net', QStr(net)])
    return fp


def write_kicad_pcb(parts, box, path):
    body = [HEADER]
    for p in parts:
        body.append(_indent(dumps(footprint_for_board(p))) + '\n')
    x1, y1, x2, y2 = box
    body.append(f'\t(gr_rect\n\t\t(start {x1:.4f} {y1:.4f})\n\t\t(end {x2:.4f} {y2:.4f})\n'
                f'\t\t(stroke\n\t\t\t(width 0.05)\n\t\t\t(type default)\n\t\t)\n\t\t(fill no)\n'
                f'\t\t(layer "Edge.Cuts")\n\t)\n')
    body.append(')\n')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(''.join(body))


def _indent(text):
    return '\n'.join('\t' + line.replace('  ', '\t') for line in text.split('\n'))


def board_json(parts, nets, box, style, unmapped, warnings):
    out_parts = []
    for p in parts:
        pads = []
        for pad in find_all(p['tree'], 'pad'):
            px, py = _xy(find(pad, 'at'))
            size = find(pad, 'size')
            pads.append({'num': str(pad[1]), 'type': str(pad[2]), 'shape': str(pad[3]),
                         'x': round(p['x'] + px, 4), 'y': round(p['y'] + py, 4),
                         'w': float(size[1]), 'h': float(size[2]),
                         'net': p['pad_net'].get(str(pad[1]))})
        x1, y1, x2, y2 = p['bbox']
        out_parts.append({'ref': p['ref'], 'value': p['value'], 'part': p['part'],
                          'footprint': p['footprint'], 'x': p['x'], 'y': p['y'], 'rot': p['rot'],
                          'courtyard': [round(p['x'] + x1, 4), round(p['y'] + y1, 4),
                                        round(p['x'] + x2, 4), round(p['y'] + y2, 4)],
                          'pads': pads})
    return {'version': 1, 'units': 'mm', 'style': style,
            'outline': list(box), 'parts': out_parts,
            'nets': [n['name'] for n in nets], 'unmapped': unmapped, 'warnings': warnings}


def generate(net_path, pcb_path, style='smd'):
    with open(net_path, encoding='utf-8') as f:
        components, nets = parse_netlist(f.read())
    parts, unmapped, warnings = build_board(components, nets, style)
    box = outline(parts)
    write_kicad_pcb(parts, box, pcb_path)
    model = board_json(parts, nets, box, style, unmapped, warnings)
    json_path = re.sub(r'\.kicad_pcb$', '', pcb_path) + '.board.json'
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(model, f, ensure_ascii=False, indent=1)
    return {
        'components': len(components),
        'nets': len(nets),
        'nodes': sum(len(n['nodes']) for n in nets),
        'pads_with_net': sum(len(p['pad_net']) for p in parts),
        'unmapped': unmapped,
        'warnings': warnings,
        'style': style,
        'board': {'x1': box[0], 'y1': box[1], 'x2': box[2], 'y2': box[3],
                  'w': round(box[2] - box[0], 2), 'h': round(box[3] - box[1], 2)},
        'boardJson': os.path.basename(json_path),
    }
