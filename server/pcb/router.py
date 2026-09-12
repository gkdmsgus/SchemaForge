"""
Grid A* router for two-layer boards.

- Grid of RULES['grid'] mm cells on F.Cu and B.Cu, 8 directions (45 degree).
- For each net a blocked mask is rebuilt from the exact geometry of every
  other net's copper (pads, tracks, vias) inflated by clearance + half the
  track width + a margin that covers diagonal moves; the board edge is
  blocked too. Pads are rotated rects / rounded rects / ovals / circles.
- A net grows like a tree: the pad nearest the net centre starts it, then
  each remaining pad (nearest first) is routed to any copper already in the
  tree. SMD pads only connect on F.Cu, through-hole pads on both layers.
- A failed connection is retried with foreign tracks made passable at a
  high cost; the nets it crosses are ripped up, the failed connection is
  routed first, then the ripped nets are rerouted (RIP_ROUNDS times).

Coordinates follow board.py: mm, y down, rotation CCW on screen.
"""
import heapq, math, time

import numpy as np

from board import pad_positions, rotate

RULES = {
    'grid': 0.25,          # mm
    'signal_width': 0.25,  # mm
    'power_width': 0.5,    # mm
    'clearance': 0.25,     # mm, copper to copper of different nets
    'edge': 0.5,           # mm, copper to board edge
    'via_size': 0.8,       # mm
    'via_drill': 0.4,      # mm
    'margin': 0.1,         # mm, covers the corner cut of diagonal moves
}
VIA_COST = 5.0            # mm-equivalent
TURN_COST = 0.3
FOREIGN_TRACK_COST = 20.0 # per cell when searching for blockers
RIP_ROUNDS = 3
POWER_HINTS = ('GND', 'VCC', 'VDD', 'VIN', 'VBAT', 'VEE', 'VSS', '+', 'PWR')

LAYERS = ('F.Cu', 'B.Cu')
DIRS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]


def is_power(net):
    n = net.upper()
    return any(h in n for h in POWER_HINTS) or bool(__import__('re').match(r'^\d+V\d*$', n))


NET_WIDTH_OVERRIDE = {}   # {net: mm} — set per run (AI edits, manual rules)


def net_width(net):
    if net in NET_WIDTH_OVERRIDE:
        return NET_WIDTH_OVERRIDE[net]
    return RULES['power_width'] if is_power(net) else RULES['signal_width']


# ── geometry: distance from grid points to copper shapes ─────────

def _dist_rounded_box(u, v, w, h, rc):
    qx = np.abs(u) - (w / 2 - rc)
    qy = np.abs(v) - (h / 2 - rc)
    out = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
    inside = np.minimum(np.maximum(qx, qy), 0)
    return out + inside - rc


def _dist_segment(X, Y, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return np.hypot(X - x1, Y - y1)
    t = np.clip(((X - x1) * dx + (Y - y1) * dy) / L2, 0, 1)
    return np.hypot(X - (x1 + t * dx), Y - (y1 + t * dy))


class Shape:
    """A piece of copper: kind 'pad' | 'track' | 'via', with a distance function."""

    def __init__(self, kind, net, layers, bbox, dist):
        self.kind, self.net, self.layers, self.bbox, self.dist = kind, net, layers, bbox, dist


def pad_shape(p, pad, px, py):
    a = pad['angle'] + p['rot']
    w, h = pad['w'], pad['h']
    rc = min(w, h) / 2 if pad['shape'] in ('circle', 'oval') else 0.0   # roundrect treated as rect: safe side
    r = math.hypot(w, h) / 2

    def dist(X, Y):
        u, v = rotate(X - px, Y - py, -a) if a % 360 else (X - px, Y - py)
        return _dist_rounded_box(u, v, w, h, rc)
    layers = {'F.Cu'} if pad['type'] == 'smd' else {'F.Cu', 'B.Cu'}
    return Shape('pad', pad['net'], layers, (px - r, py - r, px + r, py + r), dist)


def track_shape(t):
    hw = t['width'] / 2

    def dist(X, Y):
        return _dist_segment(X, Y, t['x1'], t['y1'], t['x2'], t['y2']) - hw
    return Shape('track', t['net'], {t['layer']},
                 (min(t['x1'], t['x2']) - hw, min(t['y1'], t['y2']) - hw,
                  max(t['x1'], t['x2']) + hw, max(t['y1'], t['y2']) + hw), dist)


def via_shape(v):
    r = RULES['via_size'] / 2

    def dist(X, Y):
        return np.hypot(X - v['x'], Y - v['y']) - r
    return Shape('via', v['net'], {'F.Cu', 'B.Cu'}, (v['x'] - r, v['y'] - r, v['x'] + r, v['y'] + r), dist)


# ── router ────────────────────────────────────────────────────────

class Router:
    def __init__(self, parts, outline, on_event=None):
        self.parts = parts
        self.outline = outline
        self.on_event = on_event
        g = RULES['grid']
        self.x0, self.y0 = outline[0], outline[1]
        self.nx = int(math.floor((outline[2] - outline[0]) / g)) + 1
        self.ny = int(math.floor((outline[3] - outline[1]) / g)) + 1
        xs = self.x0 + np.arange(self.nx) * g
        ys = self.y0 + np.arange(self.ny) * g
        self.X, self.Y = np.meshgrid(xs, ys)          # shape (ny, nx)
        self.edge_dist = np.minimum.reduce([self.X - outline[0], outline[2] - self.X,
                                            self.Y - outline[1], outline[3] - self.Y])
        self.pads = []                                 # (part, pad, x, y, shape), one per physical pad
        for p in parts:
            # pad_positions walks p['pads'] in order, so duplicated numbers (SOT-223 tab) stay separate
            for pad, (_, px, py, _) in zip(p['pads'], pad_positions(p)):
                self.pads.append((p, pad, px, py, pad_shape(p, pad, px, py)))
        self.tracks = []       # dicts
        self.vias = []
        self.unrouted = []
        self.events = 0

    # grid helpers
    def cell(self, x, y):
        g = RULES['grid']
        return int(round((x - self.x0) / g)), int(round((y - self.y0) / g))

    def xy(self, i, j):
        g = RULES['grid']
        return self.x0 + i * g, self.y0 + j * g

    def _window(self, bbox, pad_mm):
        g = RULES['grid']
        i1 = max(0, int(math.floor((bbox[0] - pad_mm - self.x0) / g)))
        j1 = max(0, int(math.floor((bbox[1] - pad_mm - self.y0) / g)))
        i2 = min(self.nx, int(math.ceil((bbox[2] + pad_mm - self.x0) / g)) + 1)
        j2 = min(self.ny, int(math.ceil((bbox[3] + pad_mm - self.y0) / g)) + 1)
        return i1, j1, i2, j2

    def _shapes(self):
        return [s[4] for s in self.pads] + [track_shape(t) for t in self.tracks] + [via_shape(v) for v in self.vias]

    def masks_for(self, net):
        """hard[L], soft[L] (foreign tracks/vias only), owner[L] (net of the blocking track), via_ok."""
        w = net_width(net)
        keep = RULES['clearance'] + w / 2 + RULES['margin']
        via_keep = RULES['clearance'] + RULES['via_size'] / 2 + RULES['margin']
        hard = [self.edge_dist < RULES['edge'] + w / 2 + RULES['margin'] for _ in LAYERS]
        soft = [np.zeros_like(hard[0]) for _ in LAYERS]
        owner = [np.full(hard[0].shape, None, dtype=object) for _ in LAYERS]
        via_ok = self.edge_dist >= RULES['edge'] + RULES['via_size'] / 2 + RULES['margin']
        for sh in self._shapes():
            foreign = sh.net != net
            i1, j1, i2, j2 = self._window(sh.bbox, max(keep, via_keep) + 0.5)
            if i1 >= i2 or j1 >= j2:
                continue
            d = sh.dist(self.X[j1:j2, i1:i2], self.Y[j1:j2, i1:i2])
            if foreign:
                near = d < keep
                for li, L in enumerate(LAYERS):
                    if L not in sh.layers:
                        continue
                    if sh.kind == 'pad':
                        hard[li][j1:j2, i1:i2] |= near
                    else:
                        soft[li][j1:j2, i1:i2] |= near
                        owner[li][j1:j2, i1:i2][near] = sh.net
                via_ok[j1:j2, i1:i2] &= ~(d < via_keep)
            elif sh.kind == 'pad':
                # never drop a via into a pad (hole-to-hole, via-in-pad)
                via_ok[j1:j2, i1:i2] &= ~(d < RULES['via_size'] / 2 + RULES['clearance'])
        return hard, soft, owner, via_ok

    def pad_cells(self, entry):
        """Grid cells (i, j, layer index) whose centre lies inside this pad's copper."""
        p, pad, px, py, sh = entry
        i1, j1, i2, j2 = self._window(sh.bbox, 0)
        d = sh.dist(self.X[j1:j2, i1:i2], self.Y[j1:j2, i1:i2])
        js, is_ = np.nonzero(d <= 0)
        cells = []
        for li, L in enumerate(LAYERS):
            if L in sh.layers:
                cells += [(int(i + i1), int(j + j1), li) for j, i in zip(js, is_)]
        return cells

    # ── A* ────────────────────────────────────────────────────────
    def astar(self, sources, targets, goal_xy, hard, soft, via_ok, allow_foreign):
        g = RULES['grid']
        nx, ny = self.nx, self.ny
        tset = set(targets)
        gx, gy = goal_xy

        def h(i, j):
            x, y = self.x0 + i * g, self.y0 + j * g
            dx, dy = abs(x - gx), abs(y - gy)
            return (max(dx, dy) + (math.sqrt(2) - 1) * min(dx, dy))

        best = {}
        parent = {}
        heap = []
        for s in sources:
            i, j, L = s
            if (hard[L][j, i] or (soft[L][j, i] and not allow_foreign)) and s not in tset:
                continue
            best[s] = 0.0
            parent[s] = (None, None)
            heapq.heappush(heap, (h(i, j), 0.0, s, None))
        while heap:
            f, cost, s, d = heapq.heappop(heap)
            if cost > best.get(s, math.inf) + 1e-9:
                continue
            if s in tset:
                path = [s]
                while parent[path[-1]][0] is not None:
                    path.append(parent[path[-1]][0])
                return path[::-1]
            i, j, L = s
            for k, (di, dj) in enumerate(DIRS):
                ni, nj = i + di, j + dj
                if not (0 <= ni < nx and 0 <= nj < ny):
                    continue
                n = (ni, nj, L)
                if hard[L][nj, ni] and n not in tset:
                    continue
                step = g * (math.sqrt(2) if di and dj else 1.0)
                if soft[L][nj, ni] and n not in tset:
                    if not allow_foreign:
                        continue
                    step += FOREIGN_TRACK_COST
                if d is not None and d != k:
                    step += TURN_COST
                nc = cost + step
                if nc < best.get(n, math.inf) - 1e-9:
                    best[n] = nc
                    parent[n] = (s, k)
                    heapq.heappush(heap, (nc + h(ni, nj), nc, n, k))
            # layer change through a via
            if via_ok[j, i]:
                n = (i, j, 1 - L)
                if not hard[1 - L][j, i] and (allow_foreign or not soft[1 - L][j, i]):
                    nc = cost + VIA_COST + (FOREIGN_TRACK_COST if soft[1 - L][j, i] else 0)
                    if nc < best.get(n, math.inf) - 1e-9:
                        best[n] = nc
                        parent[n] = (s, d)
                        heapq.heappush(heap, (nc + h(i, j), nc, n, d))
        return None

    # ── net routing ───────────────────────────────────────────────
    def net_pads(self, net):
        return [e for e in self.pads if e[1]['net'] == net]

    def route_net(self, net, first_failures=None):
        """Route every pad of net into one tree. Returns list of failed (from_ref, to_ref)."""
        entries = self.net_pads(net)
        if len(entries) < 2:
            return []
        cx = sum(e[2] for e in entries) / len(entries)
        cy = sum(e[3] for e in entries) / len(entries)
        start = min(entries, key=lambda e: (e[2] - cx) ** 2 + (e[3] - cy) ** 2)
        tree = [start]
        rest = [e for e in entries if e is not start]
        tree_cells = set(self.pad_cells(start))
        failed = []
        hard, soft, owner, via_ok = self.masks_for(net)
        while rest:
            src = min(rest, key=lambda e: min((e[2] - t[2]) ** 2 + (e[3] - t[3]) ** 2 for t in tree))
            rest.remove(src)
            near = min(tree, key=lambda t: (src[2] - t[2]) ** 2 + (src[3] - t[3]) ** 2)
            path = self.astar(self.pad_cells(src), tree_cells, (near[2], near[3]), hard, soft, via_ok, False)
            if path is None:
                failed.append((src, near))
                continue
            segs, vias = self.commit(net, path)
            tree.append(src)
            tree_cells |= set(self.pad_cells(src)) | set(path)
            for v in vias:
                ci, cj = self.cell(v['x'], v['y'])
                tree_cells |= {(ci, cj, 0), (ci, cj, 1)}
            self.emit_route(net, segs, vias)
        return failed

    def commit(self, net, path):
        """Turn a cell path into merged segments (+ vias at layer changes) and record them."""
        w = net_width(net)
        segs, vias = [], []
        run = [path[0]]

        def flush(run):
            if len(run) < 2:
                return
            # merge collinear steps
            pts = [run[0]]
            for a, b, c in zip(run, run[1:], run[2:]):
                if (b[0] - a[0], b[1] - a[1]) != (c[0] - b[0], c[1] - b[1]):
                    pts.append(b)
            pts.append(run[-1])
            layer = LAYERS[run[0][2]]
            for a, b in zip(pts, pts[1:]):
                x1, y1 = self.xy(a[0], a[1])
                x2, y2 = self.xy(b[0], b[1])
                segs.append({'net': net, 'layer': layer, 'width': w,
                             'x1': round(x1, 4), 'y1': round(y1, 4), 'x2': round(x2, 4), 'y2': round(y2, 4)})

        for prev, cur in zip(path, path[1:]):
            if cur[2] != prev[2]:
                flush(run)
                x, y = self.xy(cur[0], cur[1])
                vias.append({'net': net, 'x': round(x, 4), 'y': round(y, 4)})
                run = [cur]
            else:
                run.append(cur)
        flush(run)
        self.tracks += segs
        self.vias += vias
        return segs, vias

    def rip(self, net):
        self.tracks = [t for t in self.tracks if t['net'] != net]
        self.vias = [v for v in self.vias if v['net'] != net]
        if self.on_event:
            self.on_event({'type': 'rip', 'net': net})

    def emit_route(self, net, segs, vias):
        self.events += 1
        if self.on_event:
            self.on_event({'type': 'route', 'net': net, 'segments': segs, 'vias': vias})

    def blockers(self, net, failed):
        """Nets whose tracks sit on the cheapest path that ignores foreign tracks."""
        hard, soft, owner, via_ok = self.masks_for(net)
        found = set()
        for src, near in failed:
            path = self.astar(self.pad_cells(src), set(self.pad_cells(near)), (near[2], near[3]),
                              hard, soft, via_ok, True)
            if path:
                for i, j, L in path:
                    o = owner[L][j, i]
                    if o and o != net:
                        found.add(o)
        return found

    def route_all(self):
        t0 = time.time()
        nets = sorted({e[1]['net'] for e in self.pads if e[1]['net']})
        nets = [n for n in nets if len(self.net_pads(n)) > 1]

        def mst_len(n):
            pts = [(e[2], e[3]) for e in self.net_pads(n)]
            inside, total = {0}, 0.0
            while len(inside) < len(pts):
                d, k = min((math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]), b)
                           for a in inside for b in range(len(pts)) if b not in inside)
                inside.add(k)
                total += d
            return total
        order = sorted(nets, key=lambda n: (not is_power(n), mst_len(n)))
        self.connections = sum(len(self.net_pads(n)) - 1 for n in nets)

        failed_nets = {}
        for n in order:
            f = self.route_net(n)
            if f:
                failed_nets[n] = f

        for _ in range(RIP_ROUNDS):
            if not failed_nets:
                break
            retry = {}
            for n, f in failed_nets.items():
                victims = self.blockers(n, f) - {n}
                for v in victims:
                    self.rip(v)
                self.rip(n)
                f2 = self.route_net(n)
                for v in sorted(victims, key=lambda v: (not is_power(v), mst_len(v))):
                    fv = self.route_net(v)
                    if fv:
                        retry[v] = fv
                if f2:
                    retry[n] = f2
            failed_nets = retry

        self.unrouted = [{'net': n, 'from': src[0]['ref'] + '.' + src[1]['num'],
                          'to': near[0]['ref'] + '.' + near[1]['num']}
                         for n, f in failed_nets.items() for src, near in f]
        self.ms = int((time.time() - t0) * 1000)


def route(parts, outline, on_event=None):
    r = Router(parts, outline, on_event)
    r.route_all()
    length = sum(math.hypot(t['x2'] - t['x1'], t['y2'] - t['y1']) for t in r.tracks)
    return {'tracks': r.tracks, 'vias': r.vias, 'unrouted': r.unrouted,
            'connections': r.connections, 'route_events': r.events,
            'track_length': round(length, 2), 'route_ms': r.ms}
