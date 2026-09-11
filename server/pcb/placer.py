"""
Force-directed placement.

1. Parts start scattered on a ring outside the target board, so the browser
   can show them being pulled in.
2. Force iterations: every net pulls its pads toward the net centre, decoupling
   capacitors are pulled harder toward their IC, overlapping courtyards push
   apart, and the target frame pulls stragglers inside. A cooling step limit
   makes the layout settle.
3. Legalize: best of 0/90/180/270 per part (by HPWL), snap to a 0.5 mm grid,
   remove every overlap, push connectors (J, BT) to the board edge.

Deterministic: the only randomness is a seeded jitter.
"""
import math, random

from board import part_keepout as part_bbox, pad_positions, hpwl, connectivity_order

ITERATIONS = 300
FRAME_EVERY = 5
GAP = 1.0            # mm kept between courtyards
GRID = 0.5           # mm
DECOUPLING_WEIGHT = 4.0
CONNECTOR_PREFIXES = ('J', 'BT')
POWER_NET_HINT = ('VCC', 'VDD', 'VIN', '+', 'V+', '3V3', '5V', '12V')


def _center(p):
    b = part_bbox(p)
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def _overlap(a, b, gap):
    """Penetration (dx, dy) of box a into box b including gap, or None."""
    ox = min(a[2], b[2]) - max(a[0], b[0]) + gap
    oy = min(a[3], b[3]) - max(a[1], b[1]) + gap
    if ox > 0 and oy > 0:
        return ox, oy
    return None


def _is_connector(p):
    return p['ref'].rstrip('0123456789') in CONNECTOR_PREFIXES


def _decoupling_pairs(parts):
    """(cap index, IC index) for 2-pin caps that sit between an IC's supply net and GND."""
    pairs = []
    ic_nets = {i: {pad['net'] for pad in p['pads'] if pad['net']} for i, p in enumerate(parts)
               if p['ref'].startswith('U')}
    for i, p in enumerate(parts):
        if not p['ref'].startswith('C') or len(p['pads']) != 2:
            continue
        nets = {pad['net'] for pad in p['pads']}
        if 'GND' not in nets:
            continue
        other = (nets - {'GND'}).pop() if len(nets) == 2 else None
        if not other or not any(h in other.upper() for h in POWER_NET_HINT):
            continue
        for j, n in ic_nets.items():
            if other in n and 'GND' in n:
                pairs.append((i, j))
                break
    return pairs


def _snapshot(parts, it, phase, on_event):
    if on_event:
        on_event({'type': 'frame', 'iter': it, 'phase': phase, 'hpwl': round(hpwl(parts), 2),
                  'parts': {p['ref']: [round(p['x'], 3), round(p['y'], 3), p['rot'] % 360] for p in parts}})


def force_place(parts, nets, on_event=None, seed=42):
    rng = random.Random(seed)
    n = len(parts)
    if n == 0:
        return

    areas = [(p['bbox'][2] - p['bbox'][0] + GAP) * (p['bbox'][3] - p['bbox'][1] + GAP) for p in parts]
    side = math.sqrt(sum(areas) * 1.6)
    side = max(side, max(max(p['bbox'][2] - p['bbox'][0], p['bbox'][3] - p['bbox'][1]) for p in parts) + 2 * GAP)
    cx0, cy0 = 100.0 + side / 2, 100.0 + side / 2
    frame = (cx0 - side / 2, cy0 - side / 2, cx0 + side / 2, cy0 + side / 2)

    # 1. scatter on a ring, in connectivity order so neighbours start near each other
    order = connectivity_order(parts, nets)
    idx = {p['ref']: i for i, p in enumerate(parts)}
    radius = side * 0.8   # just outside the target frame (half-side 0.5) — keeps the view tight
    for k, ref in enumerate(order):
        p = parts[idx[ref]]
        a = 2 * math.pi * k / n + rng.uniform(-0.15, 0.15)
        p['rot'] = 0
        # place so the courtyard centre lands on the ring
        bx = (p['bbox'][0] + p['bbox'][2]) / 2
        by = (p['bbox'][1] + p['bbox'][3]) / 2
        p['x'] = cx0 + radius * math.cos(a) - bx
        p['y'] = cy0 + radius * math.sin(a) - by

    if on_event:
        on_event({'type': 'init', 'frame': [round(v, 3) for v in frame], 'iterations': ITERATIONS})
    _snapshot(parts, 0, 'force', on_event)

    net_members = {}
    for i, p in enumerate(parts):
        for pad in p['pads']:
            if pad['net']:
                net_members.setdefault(pad['net'], []).append(i)
    decap = _decoupling_pairs(parts)

    # 2. force iterations
    t0 = radius * 0.12
    for it in range(1, ITERATIONS + 1):
        temp = t0 * (1 - it / ITERATIONS) ** 2 + 0.05
        fx = [0.0] * n
        fy = [0.0] * n
        pads = [pad_positions(p) for p in parts]

        # nets: pull every pad toward its net centre (weight 1/(pins-1) so GND does not dominate)
        centre = {}
        for i, pl in enumerate(pads):
            for _, px, py, net in pl:
                if net:
                    s = centre.setdefault(net, [0.0, 0.0, 0])
                    s[0] += px
                    s[1] += py
                    s[2] += 1
        for i, pl in enumerate(pads):
            for _, px, py, net in pl:
                if not net:
                    continue
                s = centre[net]
                if s[2] < 2:
                    continue
                w = 1.0 / (s[2] - 1)
                fx[i] += w * (s[0] / s[2] - px)
                fy[i] += w * (s[1] / s[2] - py)

        for ci, ui in decap:
            ax, ay = _center(parts[ci])
            bx, by = _center(parts[ui])
            fx[ci] += DECOUPLING_WEIGHT * 0.1 * (bx - ax)
            fy[ci] += DECOUPLING_WEIGHT * 0.1 * (by - ay)

        # repulsion between overlapping courtyards (grows as the layout cools)
        boxes = [part_bbox(p) for p in parts]
        push = 0.5 + 1.5 * it / ITERATIONS
        for i in range(n):
            for j in range(i + 1, n):
                ov = _overlap(boxes[i], boxes[j], GAP)
                if not ov:
                    continue
                ci = ((boxes[i][0] + boxes[i][2]) / 2, (boxes[i][1] + boxes[i][3]) / 2)
                cj = ((boxes[j][0] + boxes[j][2]) / 2, (boxes[j][1] + boxes[j][3]) / 2)
                if ov[0] < ov[1]:
                    d = (ov[0] / 2) * push * (1 if ci[0] >= cj[0] else -1)
                    fx[i] += d
                    fx[j] -= d
                else:
                    d = (ov[1] / 2) * push * (1 if ci[1] >= cj[1] else -1)
                    fy[i] += d
                    fy[j] -= d

        # frame: pull parts that stick out back inside
        for i, b in enumerate(boxes):
            if b[0] < frame[0]:
                fx[i] += (frame[0] - b[0]) * 0.5
            if b[2] > frame[2]:
                fx[i] -= (b[2] - frame[2]) * 0.5
            if b[1] < frame[1]:
                fy[i] += (frame[1] - b[1]) * 0.5
            if b[3] > frame[3]:
                fy[i] -= (b[3] - frame[3]) * 0.5

        for i, p in enumerate(parts):
            dx, dy = fx[i], fy[i]
            d = math.hypot(dx, dy)
            if d > temp:
                dx, dy = dx / d * temp, dy / d * temp
            p['x'] += dx
            p['y'] += dy

        if it % FRAME_EVERY == 0:
            _snapshot(parts, it, 'force', on_event)

    # 3. legalize
    it = ITERATIONS
    _best_rotations(parts)
    it += 1
    _snapshot(parts, it, 'legalize', on_event)
    for p in parts:
        p['x'] = round(p['x'] / GRID) * GRID
        p['y'] = round(p['y'] / GRID) * GRID
    _remove_overlaps(parts, pinned=set())
    it += 1
    _snapshot(parts, it, 'legalize', on_event)
    sides = _connectors_to_edge(parts)
    it += 1
    _snapshot(parts, it, 'legalize', on_event)
    for _ in range(LOCAL_ROUNDS):
        if not _local_search_round(parts, sides):
            break
        it += 1
        _snapshot(parts, it, 'refine', on_event)


LOCAL_ROUNDS = 8
LOCAL_STEPS = (0.5, 1.0, 2.0, 4.0)


RELOCATE_RADIUS = 8.0   # mm around the current layout scanned for a better spot
RELOCATE_BUDGET = 4000  # candidate positions per part per round


def _part_cost(p, x, y, rot, other_boxes):
    """HPWL of the nets touching p if p sat at (x, y, rot); other_boxes = per-net pad box of the other parts."""
    boxes = {}
    for _, px, py, net in pad_positions(p, x, y, rot):
        if not net:
            continue
        b = boxes.get(net) or other_boxes.get(net)
        boxes[net] = (px, py, px, py) if b is None else (min(b[0], px), min(b[1], py), max(b[2], px), max(b[3], py))
    return sum((b[2] - b[0]) + (b[3] - b[1]) for b in boxes.values())


def _local_search_round(parts, conn_sides):
    """One pass per part: try small moves, rotations and relocation to any free grid spot nearby;
    keep the best move that lowers HPWL without overlaps. Connectors only slide along their edge."""
    improved = False
    for p in parts:
        others = [q for q in parts if q is not p]
        other_bbs = [part_bbox(q) for q in others]
        other_boxes = {}
        for q in others:
            for _, px, py, net in pad_positions(q):
                if net:
                    b = other_boxes.get(net)
                    other_boxes[net] = (px, py, px, py) if b is None else (min(b[0], px), min(b[1], py), max(b[2], px), max(b[3], py))

        # a connector's outer edge is the board edge: nothing else may stick out past it
        limits = []
        if p['ref'] not in conn_sides:
            for q in others:
                s = conn_sides.get(q['ref'])
                if s:
                    limits.append((s, part_bbox(q)))

        def free(x, y, rot):
            b = part_bbox(p, x, y, rot)
            for s, cb in limits:
                if (s == 'left' and b[0] < cb[0]) or (s == 'right' and b[2] > cb[2]) or \
                   (s == 'top' and b[1] < cb[1]) or (s == 'bottom' and b[3] > cb[3]):
                    return False
            return not any(_overlap(b, o, GAP / 2) for o in other_bbs)

        base = _part_cost(p, p['x'], p['y'], p['rot'], other_boxes)
        side = conn_sides.get(p['ref'])
        cands = []
        if side is None:
            ext = (min(b[0] for b in other_bbs), min(b[1] for b in other_bbs),
                   max(b[2] for b in other_bbs), max(b[3] for b in other_bbs)) if other_bbs else part_bbox(p)
            xs = _grid_range(ext[0] - RELOCATE_RADIUS, ext[2] + RELOCATE_RADIUS)
            ys = _grid_range(ext[1] - RELOCATE_RADIUS, ext[3] + RELOCATE_RADIUS)
            stride = max(1, int(math.sqrt(len(xs) * len(ys) * 4 / RELOCATE_BUDGET)))
            cands = [(x, y, r) for r in (0, 90, 180, 270) for x in xs[::stride] for y in ys[::stride]]
        else:
            axis = 'y' if side in ('left', 'right') else 'x'
            for step in LOCAL_STEPS:
                for s in (step, -step):
                    cands.append((p['x'] + (s if axis == 'x' else 0), p['y'] + (s if axis == 'y' else 0), p['rot']))
        best = None
        for x, y, r in cands:
            c = _part_cost(p, x, y, r, other_boxes)
            if c < base - 1e-6 and (best is None or c < best[0]) and free(x, y, r):
                best = (c, x, y, r)
        if best:
            _, p['x'], p['y'], p['rot'] = best
            improved = True
    return improved


def _grid_range(a, b):
    start = math.floor(a / GRID) * GRID
    n = int((b - start) / GRID) + 1
    return [start + i * GRID for i in range(max(n, 1))]


def _best_rotations(parts):
    """Greedy: for each part, keep the rotation that lowers total HPWL without new overlaps."""
    for p in sorted(parts, key=lambda q: -len(q['pads'])):
        best_rot, best = p['rot'], hpwl(parts)
        others = [part_bbox(q) for q in parts if q is not p]
        for rot in (0, 90, 180, 270):
            if rot == p['rot']:
                continue
            old = p['rot']
            p['rot'] = rot
            b = part_bbox(p)
            if any(_overlap(b, o, 0) for o in others):
                p['rot'] = old
                continue
            h = hpwl(parts)
            if h < best - 1e-6:
                best_rot, best = rot, h
            p['rot'] = old
        p['rot'] = best_rot


def _remove_overlaps(parts, pinned, max_rounds=400):
    """Push overlapping courtyards apart along the shorter axis until none overlap (grid-aligned steps)."""
    for _ in range(max_rounds):
        moved = False
        boxes = [part_bbox(p) for p in parts]
        for i in range(len(parts)):
            for j in range(i + 1, len(parts)):
                ov = _overlap(boxes[i], boxes[j], GAP / 2)
                if not ov:
                    continue
                a, b = parts[i], parts[j]
                ca = ((boxes[i][0] + boxes[i][2]) / 2, (boxes[i][1] + boxes[i][3]) / 2)
                cb = ((boxes[j][0] + boxes[j][2]) / 2, (boxes[j][1] + boxes[j][3]) / 2)
                movers = [q for q in (a, b) if q['ref'] not in pinned] or [b]
                axis = 0 if ov[0] < ov[1] else 1
                step = math.ceil((ov[axis] / len(movers)) / GRID) * GRID
                for q in movers:
                    sign = (1 if (ca[axis] >= cb[axis]) == (q is a) else -1)
                    if axis == 0:
                        q['x'] += sign * step
                    else:
                        q['y'] += sign * step
                moved = True
                boxes = [part_bbox(p) for p in parts]
        if not moved:
            return


def _connectors_to_edge(parts):
    """Slide each connector outward until its courtyard touches the layout's outer edge."""
    conns = [p for p in parts if _is_connector(p)]
    sides = {}
    if not conns:
        return sides
    for p in conns:
        others = [part_bbox(q) for q in parts if q is not p]
        if not others:
            return sides
        ex = (min(o[0] for o in others), min(o[1] for o in others),
              max(o[2] for o in others), max(o[3] for o in others))
        # try every side (and every rotation) and keep the one with the shortest wiring
        x0, y0, r0 = p['x'], p['y'], p['rot']
        best = None
        for rot in (0, 90, 180, 270):
            p['rot'] = rot
            p['x'], p['y'] = x0, y0
            b = part_bbox(p)
            w, h = b[2] - b[0], b[3] - b[1]
            for side in ('left', 'right', 'top', 'bottom'):
                p['x'], p['y'] = x0, y0
                if side == 'left':
                    p['x'] += (ex[0] - w - GAP) - b[0]
                elif side == 'right':
                    p['x'] += (ex[2] + GAP) - b[0]
                elif side == 'top':
                    p['y'] += (ex[1] - h - GAP) - b[1]
                else:
                    p['y'] += (ex[3] + GAP) - b[1]
                p['x'] = round(p['x'] / GRID) * GRID
                p['y'] = round(p['y'] / GRID) * GRID
                cost = hpwl(parts)
                if best is None or cost < best[0]:
                    best = (cost, side, rot, p['x'], p['y'])
        _, side, p['rot'], p['x'], p['y'] = best
        sides[p['ref']] = side
    _remove_overlaps(parts, pinned={p['ref'] for p in conns})
    return sides
