"""
Netlist (.net) -> board model -> .kicad_pcb (KiCad 10 format) + .board.json

The board model is the single source of truth: the KiCad file, the JSON the
browser draws, and the placement/routing engines all come from it.

Coordinates are KiCad's: millimetres, y grows downward, rotation in degrees
counter-clockwise as seen on screen. A part keeps its pads and courtyard in
footprint-local coordinates; (x, y, rot) places them on the board.
"""
import copy, json, math, os, re

from sexpr import QStr, parse, dumps, find, find_all
from footprints_table import lookup, KNOWN_UNMAPPED, ASSUMED_PART

HERE = os.path.dirname(os.path.abspath(__file__))
FP_DIR = os.path.join(HERE, 'footprints')

PART_GAP = 2.0        # mm between courtyards in the shelf layout
BOARD_MARGIN = 1.0    # mm from outermost courtyard to board edge
ORIGIN = (100.0, 100.0)


# ── geometry ──────────────────────────────────────────────────────

def rotate(px, py, rot):
    """Rotate a footprint-local point by rot degrees (KiCad: CCW on a y-down screen)."""
    if rot % 360 == 0:
        return px, py
    a = math.radians(rot)
    c, s = math.cos(a), math.sin(a)
    return px * c + py * s, -px * s + py * c


def part_bbox(p, x=None, y=None, rot=None):
    """Axis-aligned courtyard box of a part on the board."""
    x = p['x'] if x is None else x
    y = p['y'] if y is None else y
    rot = p['rot'] if rot is None else rot
    x1, y1, x2, y2 = p['bbox']
    pts = [rotate(cx, cy, rot) for cx, cy in ((x1, y1), (x2, y1), (x2, y2), (x1, y2))]
    return (x + min(q[0] for q in pts), y + min(q[1] for q in pts),
            x + max(q[0] for q in pts), y + max(q[1] for q in pts))


def part_keepout(p, x=None, y=None, rot=None):
    """Box a neighbour must stay out of: courtyard + silkscreen graphics + reference text.
    Everything rotates with the part (footprint_for_board adds the part rotation to text angles)."""
    x = p['x'] if x is None else x
    y = p['y'] if y is None else y
    rot = p['rot'] if rot is None else rot
    boxes = [part_bbox(p, x, y, rot)]
    if p.get('silk_bbox'):
        sx1, sy1, sx2, sy2 = p['silk_bbox']
        pts = [rotate(cx, cy, rot) for cx, cy in ((sx1, sy1), (sx2, sy1), (sx2, sy2), (sx1, sy2))]
        boxes.append((x + min(q[0] for q in pts), y + min(q[1] for q in pts),
                      x + max(q[0] for q in pts), y + max(q[1] for q in pts)))
    t = p.get('ref_text')
    if t:
        tx, ty = rotate(t['x'], t['y'], rot)
        hw, hh = (t['w'] / 2, t['h'] / 2) if round(t['angle'] + rot) % 180 == 0 else (t['h'] / 2, t['w'] / 2)
        boxes.append((x + tx - hw, y + ty - hh, x + tx + hw, y + ty + hh))
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def pad_positions(p, x=None, y=None, rot=None):
    """[(pad num, abs x, abs y, net)] for a part at (x, y, rot)."""
    x = p['x'] if x is None else x
    y = p['y'] if y is None else y
    rot = p['rot'] if rot is None else rot
    out = []
    for pad in p['pads']:
        dx, dy = rotate(pad['x'], pad['y'], rot)
        out.append((pad['num'], x + dx, y + dy, pad['net']))
    return out


def hpwl(parts):
    """Half-perimeter wire length: sum over nets of the pad bounding box's width + height (mm)."""
    boxes = {}
    for p in parts:
        for _, px, py, net in pad_positions(p):
            if net is None:
                continue
            b = boxes.get(net)
            boxes[net] = (px, py, px, py) if b is None else (min(b[0], px), min(b[1], py), max(b[2], px), max(b[3], py))
    return sum((b[2] - b[0]) + (b[3] - b[1]) for b in boxes.values())


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
        nodes = [{'ref': str(find(n, 'ref')[1]), 'pin': str(find(n, 'pin')[1]),
                  'pintype': str(find(n, 'pintype')[1]) if find(n, 'pintype') else ''}
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


def silk_bbox(fp):
    """Local bounding box of F.SilkS graphics (lines, arcs, circles, polys), or None."""
    pts = []
    for item in fp:
        if not (isinstance(item, list) and item and str(item[0]).startswith('fp_') and item[0] != 'fp_text'):
            continue
        layer = find(item, 'layer')
        if not layer or layer[1] != 'F.SilkS':
            continue
        stroke = find(item, 'stroke')
        width = find(stroke, 'width') if stroke else None
        hw = float(width[1]) / 2 if width else 0.06
        kind = item[0]
        got = []
        if kind in ('fp_line', 'fp_rect'):
            got = [_xy(find(item, 'start')), _xy(find(item, 'end'))]
        elif kind == 'fp_arc':
            got = [_xy(find(item, k)) for k in ('start', 'mid', 'end')]
        elif kind == 'fp_circle':
            cx, cy = _xy(find(item, 'center'))
            ex, ey = _xy(find(item, 'end'))
            r = math.hypot(ex - cx, ey - cy)
            got = [(cx - r, cy - r), (cx + r, cy + r)]
        elif kind == 'fp_poly':
            got = [_xy(q) for q in find_all(find(item, 'pts'), 'xy')]
        pts += [(gx - hw, gy - hw) for gx, gy in got] + [(gx + hw, gy + hw) for gx, gy in got]
    if not pts:
        return None
    return (min(q[0] for q in pts), min(q[1] for q in pts), max(q[0] for q in pts), max(q[1] for q in pts))


def local_silk(fp):
    """F.SilkS graphics in footprint-local coordinates, so the browser can draw the real outlines.

    Kinds: line (x1,y1,x2,y2) · circle (cx,cy,r) · arc (x1,y1,mx,my,x2,y2) · poly (pts).
    Each carries its stroke width w in mm.
    """
    out = []
    for item in fp:
        if not (isinstance(item, list) and item and str(item[0]).startswith('fp_') and item[0] != 'fp_text'):
            continue
        layer = find(item, 'layer')
        if not layer or layer[1] != 'F.SilkS':
            continue
        stroke = find(item, 'stroke')
        width = find(stroke, 'width') if stroke else None
        w = round(float(width[1]), 4) if width else 0.12
        kind = item[0]
        if kind in ('fp_line', 'fp_rect'):
            (x1, y1), (x2, y2) = _xy(find(item, 'start')), _xy(find(item, 'end'))
            if kind == 'fp_line':
                out.append({'t': 'line', 'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'w': w})
            else:
                out.append({'t': 'poly', 'pts': [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]], 'w': w})
        elif kind == 'fp_arc':
            (x1, y1), (mx, my), (x2, y2) = (_xy(find(item, k)) for k in ('start', 'mid', 'end'))
            out.append({'t': 'arc', 'x1': x1, 'y1': y1, 'mx': mx, 'my': my, 'x2': x2, 'y2': y2, 'w': w})
        elif kind == 'fp_circle':
            cx, cy = _xy(find(item, 'center'))
            ex, ey = _xy(find(item, 'end'))
            out.append({'t': 'circle', 'cx': cx, 'cy': cy, 'r': round(math.hypot(ex - cx, ey - cy), 4), 'w': w})
        elif kind == 'fp_poly':
            pts = [list(_xy(q)) for q in find_all(find(item, 'pts'), 'xy')]
            if pts:
                out.append({'t': 'poly', 'pts': pts, 'w': w})
    return out


def ref_text(fp, ref):
    """Approximate box of the visible silkscreen reference text (KiCad stroke font ~1 char = 1 size)."""
    for prop in find_all(fp, 'property'):
        if prop[1] != 'Reference':
            continue
        layer = find(prop, 'layer')
        if not layer or layer[1] != 'F.SilkS' or find(prop, 'hide'):
            return None
        at = find(prop, 'at')
        font = find(find(prop, 'effects') or [], 'font') or []
        size = find(font, 'size')
        thick = find(font, 'thickness')
        sy, sx = (float(size[1]), float(size[2])) if size else (1.0, 1.0)
        t = float(thick[1]) if thick else 0.15
        return {'x': float(at[1]), 'y': float(at[2]), 'angle': float(at[3]) if len(at) > 3 else 0.0,
                'w': len(ref) * sx + t, 'h': sy + t}
    return None


def local_pads(fp, pad_net):
    """Pads in footprint-local coordinates, as the browser and placer need them."""
    out = []
    for pad in find_all(fp, 'pad'):
        at = find(pad, 'at')
        size = find(pad, 'size')
        drill = find(pad, 'drill')
        d = None
        if drill:
            nums = [float(v) for v in drill[1:] if not isinstance(v, list) and _is_num(v)]
            d = nums[0] if nums else None
        out.append({'num': str(pad[1]), 'type': str(pad[2]), 'shape': str(pad[3]),
                    'x': float(at[1]), 'y': float(at[2]),
                    'angle': float(at[3]) if len(at) > 3 else 0.0,
                    'w': float(size[1]), 'h': float(size[2]), 'drill': d,
                    'net': pad_net.get(str(pad[1]))})
    return out


def _is_num(v):
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


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
    """Parts with real footprints and nets, laid out by the shelf packer (rot 0)."""
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

        pad_net, pad_pin = {}, {}
        for (r, pin), net in node_net.items():
            if r != ref or not pin.isdigit():
                continue
            pad = pin_map.get(int(pin))
            if pad is None:
                warnings.append(f'{ref} pin {pin} has no pad in {fp_id}')
                continue
            pad_net[pad] = net
            pad_pin[pad] = int(pin)

        parts.append({'ref': ref, 'value': value, 'part': part, 'footprint': fp_id,
                      'tree': fp, 'bbox': courtyard_bbox(fp), 'pad_net': pad_net, 'pad_pin': pad_pin,
                      'silk_bbox': silk_bbox(fp), 'ref_text': ref_text(fp, ref),
                      'pads': local_pads(fp, pad_net), 'silk': local_silk(fp),
                      'x': 0.0, 'y': 0.0, 'rot': 0})

    shelf_place(parts, nets)
    return parts, unmapped, warnings


def connectivity_order(parts, nets):
    """Refs in BFS order from the most-connected part."""
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
    return order


def shelf_place(parts, nets):
    """Rows in connectivity order, spaced by real courtyard size (the stage-0 layout)."""
    by_ref = {p['ref']: p for p in parts}
    sizes = [(p['bbox'][2] - p['bbox'][0], p['bbox'][3] - p['bbox'][1]) for p in parts]
    area = sum((w + PART_GAP) * (h + PART_GAP) for w, h in sizes)
    row_limit = max([w for w, _ in sizes] + [math.sqrt(area) * 1.4])

    x = y = row_h = 0.0
    for ref in connectivity_order(parts, nets):
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


def overlaps(parts):
    """[(refA, refB)] whose keep-out boxes intersect — must be empty on a good board."""
    boxes = [(p['ref'], part_keepout(p)) for p in parts]
    out = []
    for i, (ra, a) in enumerate(boxes):
        for rb, b in boxes[i + 1:]:
            if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                out.append([ra, rb])
    return out


def _inside(box, outer):
    return box[0] >= outer[0] - 1e-6 and box[1] >= outer[1] - 1e-6 and \
        box[2] <= outer[2] + 1e-6 and box[3] <= outer[3] + 1e-6


def outline(parts):
    boxes = [part_keepout(p) for p in parts]
    return (round(min(b[0] for b in boxes) - BOARD_MARGIN, 4), round(min(b[1] for b in boxes) - BOARD_MARGIN, 4),
            round(max(b[2] for b in boxes) + BOARD_MARGIN, 4), round(max(b[3] for b in boxes) + BOARD_MARGIN, 4))


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


def _fmt(v):
    s = f'{v:.4f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def footprint_for_board(p):
    fp = [c for c in p['tree'] if not (isinstance(c, list) and c and c[0] in _LIB_ONLY_KEYS)]
    fp[1] = QStr(p['footprint'])
    rot = p['rot'] % 360
    at = ['at', _fmt(p['x']), _fmt(p['y'])] + ([_fmt(rot)] if rot else [])
    li = next(i for i, c in enumerate(fp) if isinstance(c, list) and c and c[0] == 'layer')
    fp.insert(li + 1, at)
    for prop in find_all(fp, 'property'):
        if prop[1] == 'Reference':
            prop[2] = QStr(p['ref'])
        elif prop[1] == 'Value':
            prop[2] = QStr(p['value'])
    if rot:
        # text angles are absolute too: turn labels with the part, like KiCad's own rotate
        for item in find_all(fp, 'property') + find_all(fp, 'fp_text'):
            tat = find(item, 'at')
            if tat:
                own = float(tat[3]) if len(tat) > 3 else 0.0
                tat[3:] = [_fmt((own + rot) % 360)]
    for pad in find_all(fp, 'pad'):
        if rot:
            # KiCad stores a pad's orientation as an absolute angle: add the part's rotation.
            pat = find(pad, 'at')
            own = float(pat[3]) if len(pat) > 3 else 0.0
            pat[3:] = [_fmt((own + rot) % 360)]
        net = p['pad_net'].get(str(pad[1]))
        if net is not None:
            pad[:] = [c for c in pad if not (isinstance(c, list) and c and c[0] == 'net')]
            pad.append(['net', QStr(net)])
    return fp


def write_kicad_pcb(parts, box, path, routing=None):
    body = [HEADER]
    for p in parts:
        body.append(_indent(dumps(footprint_for_board(p))) + '\n')
    if routing:
        from router import RULES
        for t in routing['tracks']:
            body.append(f'\t(segment\n\t\t(start {_fmt(t["x1"])} {_fmt(t["y1"])})\n\t\t(end {_fmt(t["x2"])} {_fmt(t["y2"])})\n'
                        f'\t\t(width {_fmt(t["width"])})\n\t\t(layer "{t["layer"]}")\n\t\t(net {_q(t["net"])})\n\t)\n')
        for v in routing['vias']:
            body.append(f'\t(via\n\t\t(at {_fmt(v["x"])} {_fmt(v["y"])})\n\t\t(size {_fmt(RULES["via_size"])})\n'
                        f'\t\t(drill {_fmt(RULES["via_drill"])})\n\t\t(layers "F.Cu" "B.Cu")\n\t\t(net {_q(v["net"])})\n\t)\n')
    x1, y1, x2, y2 = box
    body.append(f'\t(gr_rect\n\t\t(start {x1:.4f} {y1:.4f})\n\t\t(end {x2:.4f} {y2:.4f})\n'
                f'\t\t(stroke\n\t\t\t(width 0.05)\n\t\t\t(type default)\n\t\t)\n\t\t(fill no)\n'
                f'\t\t(layer "Edge.Cuts")\n\t)\n')
    body.append(')\n')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(''.join(body))


def _q(s):
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


def _indent(text):
    return '\n'.join('\t' + line.replace('  ', '\t') for line in text.split('\n'))


def part_static(p):
    """What the browser needs once per part (local geometry); positions come in frames."""
    return {'ref': p['ref'], 'value': p['value'], 'part': p['part'], 'footprint': p['footprint'],
            'bbox': [round(v, 4) for v in p['bbox']],
            'pads': [{k: pad[k] for k in ('num', 'type', 'shape', 'x', 'y', 'angle', 'w', 'h', 'drill', 'net')}
                     for pad in p['pads']],
            'silk': p.get('silk', []),
            'ref_text': p.get('ref_text')}


def board_json(parts, nets, box, style, unmapped, warnings):
    out_parts = []
    for p in parts:
        cb = part_bbox(p)
        d = part_static(p)
        d.update({'x': round(p['x'], 4), 'y': round(p['y'], 4), 'rot': p['rot'] % 360,
                  'courtyard': [round(v, 4) for v in cb],
                  'keepout': [round(v, 4) for v in part_keepout(p)],
                  # symbol pin number per footprint pad, so later steps can tell a gate from a drain
                  'pad_pins': {pad: pin for pad, pin in p.get('pad_pin', {}).items()},
                  'pads_abs': [{'num': n, 'x': round(px, 4), 'y': round(py, 4), 'net': net}
                               for n, px, py, net in pad_positions(p)]})
        out_parts.append(d)
    return {'version': 2, 'units': 'mm', 'style': style,
            'outline': list(box), 'parts': out_parts,
            'nets': [n['name'] for n in nets], 'unmapped': unmapped, 'warnings': warnings}


def generate(net_path, pcb_path, style='smd', placer='force', on_event=None, route=True, overrides=None):
    """Build, place, route, write.

    placer: 'force' (default), 'shelf', or 'fixed' — 'fixed' keeps the positions in
    overrides['parts'] = {ref: [x, y, rot]}; overrides['net_width'] = {net: mm} widens tracks.
    on_event(dict) receives parts / init / frame / erc / route events when streaming.
    """
    with open(net_path, encoding='utf-8') as f:
        components, nets = parse_netlist(f.read())
    parts, unmapped, warnings = build_board(components, nets, style)
    hpwl_shelf = hpwl(parts)
    if on_event:
        # local geometry first, so the browser can draw parts before the first frame
        on_event({'type': 'parts', 'parts': [part_static(p) for p in parts],
                  'nets': [n['name'] for n in nets]})

    import router as router_mod
    router_mod.NET_WIDTH_OVERRIDE = dict((overrides or {}).get('net_width') or {})

    if placer == 'force':
        from placer import force_place
        force_place(parts, nets, on_event=on_event)
    elif placer == 'fixed':
        fixed = (overrides or {}).get('parts') or {}
        for p in parts:
            pose = fixed.get(p['ref'])
            if pose:
                p['x'], p['y'], p['rot'] = float(pose[0]), float(pose[1]), int(pose[2]) % 360
        if on_event:
            on_event({'type': 'frame', 'iter': 0, 'phase': 'refine', 'hpwl': round(hpwl(parts), 2),
                      'parts': {p['ref']: [round(p['x'], 3), round(p['y'], 3), p['rot'] % 360] for p in parts}})

    import erc as erc_mod
    findings = erc_mod.check(components, nets, parts)
    if on_event:
        on_event({'type': 'erc', 'findings': findings})

    box = outline(parts)
    routing = None
    if route:
        from router import route as run_router
        routing = run_router(parts, box, on_event=on_event)
    write_kicad_pcb(parts, box, pcb_path, routing)
    model = board_json(parts, nets, box, style, unmapped, warnings)
    model['erc'] = findings
    if routing:
        model.update({'version': 3, 'tracks': routing['tracks'], 'vias': routing['vias'],
                      'unrouted': routing['unrouted']})
    json_path = re.sub(r'\.kicad_pcb$', '', pcb_path) + '.board.json'
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(model, f, ensure_ascii=False, indent=1)
    final = hpwl(parts)
    return {
        'components': len(components),
        'nets': len(nets),
        'nodes': sum(len(n['nodes']) for n in nets),
        'pads_with_net': sum(len(p['pad_net']) for p in parts),
        'unmapped': unmapped,
        'warnings': warnings,
        'style': style,
        'placer': placer,
        'hpwl': round(final, 2),
        'hpwl_shelf': round(hpwl_shelf, 2),
        'rotated': sum(1 for p in parts if p['rot'] % 360),
        'board': {'x1': box[0], 'y1': box[1], 'x2': box[2], 'y2': box[3],
                  'w': round(box[2] - box[0], 2), 'h': round(box[3] - box[1], 2)},
        'boardJson': os.path.basename(json_path),
        'erc': findings,
        'overlaps': overlaps(parts),
        'outside': [p['ref'] for p in parts if not _inside(part_keepout(p), box)],
        'net_width': dict(router_mod.NET_WIDTH_OVERRIDE),
        **({'connections': routing['connections'], 'unrouted': routing['unrouted'],
            'tracks': len(routing['tracks']), 'vias': len(routing['vias']),
            'track_length': routing['track_length'], 'route_ms': routing['route_ms']}
           if routing else {}),
    }
