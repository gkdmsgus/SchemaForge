"""
Stage-0 checks: every test circuit x {smd, tht} must produce a real board.

Usage: python run_checks.py [--keep DIR]
Needs skidl (pip) and kicad-cli (env KICAD_CLI_PATH, PATH, or the default
per-user KiCad 10 install). Exit code 0 only if every check passes.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from board import build_board, generate, hpwl, netlist_check, parse_netlist, BOARD_MARGIN, MAX_PLACEHOLDER_PINS  # noqa: E402
import placer  # noqa: E402
from kicad_pads import kicad_pad_positions  # noqa: E402
from footprints_table import TABLE, KNOWN_UNMAPPED  # noqa: E402
from erc import PIN_NAMES  # noqa: E402
from sexpr import parse, find, find_all  # noqa: E402
from fab_export import export_fab, FAB_SUFFIXES  # noqa: E402

CIRCUITS = ['led_basic', 'ne555_blink', 'npn_relay', 'nmos_motor', 'bridge_supply']
STYLES = ['smd', 'tht']
# (part, skidl pin that must sit on KiCad pad "1") — polarity checks
POLARITY = {'LED': '2', 'D': '2', 'CP': '1', 'Battery': '1', 'Buzzer': '1'}
# Independent pad expectations from the manufacturer's pinout diagrams, not TABLE.
# SKiDL Q_NPN pins: 1=B, 2=C, 3=E; Q_NMOS: 1=G, 2=D, 3=S.
# https://www.onsemi.com/download/data-sheet/pdf/pzt3904-d.pdf
# https://www.onsemi.com/download/data-sheet/pdf/nds7002a-d.pdf
TRANSISTOR_PADS = {
    ('Q_NPN', 'smd'): {'1': '1', '2': '3', '3': '2'},  # MMBT3904: 1=B 2=E 3=C
    ('Q_NPN', 'tht'): {'1': '2', '2': '3', '3': '1'},  # 2N3904: 1=E 2=B 3=C
    ('Q_NMOS', 'smd'): {'1': '1', '2': '3', '3': '2'}, # 2N7002: 1=G 2=S 3=D
    ('Q_NMOS', 'tht'): {'1': '2', '2': '3', '3': '1'}, # 2N7000: 1=S 2=G 3=D
}
# SKiDL Bridge pins: 1=AC1, 2=AC2, 3=+, 4=-; the two AC pins are interchangeable.
# Seen from above with + and - on the right (MB6S) or the left (DF06M), + is the lower (MB6S) or upper (DF06M) lead:
# https://www.vishay.com/docs/88661/mb2s.pdf  https://www.vishay.com/docs/88571/dfm.pdf (front-page drawings)
BRIDGE_PADS = {
    'smd': {'3': '3', '4': '4', 'ac': {'1', '2'}},     # MB6S TO-269AA: pad 3 (3.075, 1.27) = +, pad 4 = -
    'tht': {'3': '1', '4': '2', 'ac': {'3', '4'}},     # DF06M DIP-4: pad 1 (0, 0) = +, pad 2 (0, 5.08) = -
}


def kicad_cli():
    env = os.environ.get('KICAD_CLI_PATH')
    if env:
        return env
    found = shutil.which('kicad-cli')
    if found:
        return found
    return os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'KiCad', '10.0', 'bin', 'kicad-cli.exe')


def vendored_kicad_config(home, footprints=os.path.join(HERE, 'footprints')):
    """A KICAD_CONFIG_HOME whose footprint table is the vendored libraries, as the images and the development server
    write it (server/kicad_config.ts, the same text): this PC's own table made each DRC about 10 s and 1.4 GB."""
    libs = sorted(d for d in os.listdir(footprints) if d.endswith('.pretty') and os.path.isdir(os.path.join(footprints, d)))
    lines = ['(fp_lib_table', '  (version 7)'] + [
        f'  (lib (name "{d[:-len(".pretty")]}")(type "KiCad")(uri "{os.path.join(footprints, d).replace(os.sep, "/")}")'
        '(options "")(descr ""))' for d in libs] + [')', '']
    os.makedirs(os.path.join(home, '10.0'), exist_ok=True)
    with open(os.path.join(home, '10.0', 'fp-lib-table'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))
    return home


# DRC's environment, set in main(): the vendored table unless KICAD_CONFIG_HOME names one
DRC_ENV = None


def build_netlist(name, work):
    shutil.copyfile(os.path.join(SERVER, 'test_circuits', name + '.py'), os.path.join(work, name + '.py'))
    subprocess.run([sys.executable, name + '.py'], cwd=work, check=True, capture_output=True)
    return os.path.join(work, name + '.net')


def board_pads(pcb_path):
    """[(ref, pad number, net or None)] read back from the written .kicad_pcb."""
    root = parse(open(pcb_path, encoding='utf-8').read())
    out = []
    for fp in find_all(root, 'footprint'):
        ref = next(str(p[2]) for p in find_all(fp, 'property') if p[1] == 'Reference')
        for pad in find_all(fp, 'pad'):
            net = find(pad, 'net')
            out.append((ref, str(pad[1]), str(net[-1]) if net else None))
    return out


def check_one(name, style, work, cli):
    res = {}
    net_path = build_netlist(name, work)
    pcb = os.path.join(work, f'{name}_{style}.kicad_pcb')
    summary = generate(net_path, pcb, style)
    components, nets = parse_netlist(open(net_path, encoding='utf-8').read())
    model = json.load(open(pcb.replace('.kicad_pcb', '.board.json'), encoding='utf-8'))
    parts = {p['ref']: p for p in model['parts']}
    comp_part = {c['ref']: c['part'] for c in components}

    # 1. unmapped
    res['1 unmapped=0'] = (not summary['unmapped'], str(summary['unmapped'] or ''))

    # 2. every netlist node lands on its mapped pad with the same net (read back from the file)
    pads = board_pads(pcb)
    distinct_pads = lambda ps: len({(r, n) for r, n, net in ps if net})
    pad_net = {(r, n): net for r, n, net in pads if net}
    bad = []
    for n in nets:
        for nd in n['nodes']:
            if nd['ref'] not in comp_part:           # test point added by the generator
                continue
            lib_fp = TABLE.get((comp_part[nd['ref']], style))
            pad = lib_fp[2].get(int(nd['pin'])) if lib_fp else None
            if pad is None or pad_net.get((nd['ref'], pad)) != n['name']:
                bad.append(f"{nd['ref']}.{nd['pin']}")
    nodes = sum(len(n['nodes']) for n in nets)
    tps = summary.get('test_points') or []           # probe pads the generator adds on top of the netlist
    tp_pads = len({(r, n) for r, n, net in pads if net and r in tps})
    res['2 nodes->pads'] = (not bad and distinct_pads(pads) == nodes + tp_pads,
                            f'nodes={nodes}+{tp_pads} tp pads={distinct_pads(pads)} bad={bad}')

    # 3. polarity: the stated skidl pin is on KiCad pad "1"
    pol_bad = []
    node_net = {(nd['ref'], nd['pin']): n['name'] for n in nets for nd in n['nodes']}
    for ref, part in comp_part.items():
        if part in POLARITY:
            want = node_net.get((ref, POLARITY[part]))
            if pad_net.get((ref, '1')) != want:
                pol_bad.append(ref)
    res['3 polarity'] = (not pol_bad, str(pol_bad or ''))

    # A self-consistent TABLE can still be wrong: assert the actual transistor and bridge
    # pad/net assignments against separately recorded manufacturer pinouts.
    transistor_bad = []
    for ref, part in comp_part.items():
        expected = TRANSISTOR_PADS.get((part, style))
        if part == 'Bridge':
            b = BRIDGE_PADS[style]
            expected = {'3': b['3'], '4': b['4']}
            ac = {pad_net.get((ref, pad)) for pad in b['ac']}
            if ac != {node_net.get((ref, '1')), node_net.get((ref, '2'))}:
                transistor_bad.append(f'{ref}: AC pins not on pads {sorted(b["ac"])}')
        if expected:
            for pin, pad in expected.items():
                if pad_net.get((ref, pad)) != node_net.get((ref, pin)):
                    transistor_bad.append(f'{ref}: pin {pin} -> pad {pad}')
    res['3b exact-part pinout'] = (not transistor_bad, str(transistor_bad or ''))

    # 4. courtyards: no overlap, all inside the outline
    boxes = [p['courtyard'] for p in parts.values()]
    ox1, oy1, ox2, oy2 = model['outline']
    overlap = [(a, b) for i, a in enumerate(parts) for b in list(parts)[i + 1:]
               if _overlap(parts[a]['courtyard'], parts[b]['courtyard'])]
    outside = [r for r, p in parts.items()
               if not (p['courtyard'][0] >= ox1 and p['courtyard'][1] >= oy1 and
                       p['courtyard'][2] <= ox2 and p['courtyard'][3] <= oy2)]
    res['4 courtyard'] = (not overlap and not outside, f'overlap={overlap} outside={outside}')

    # 5. KiCad DRC: loads, 0 violations, unconnected = connections still to route.
    # The zones are filled first, as for the gerbers, so the ground pour that gets made is checked too.
    drc = os.path.join(work, f'{name}_{style}.drc.json')
    t0 = time.time()
    p = subprocess.run([cli, 'pcb', 'drc', '--format', 'json', '--refill-zones', '--output', drc, pcb], capture_output=True, env=DRC_ENV)
    drc_s = f'{time.time() - t0:.1f} s'
    if p.returncode != 0 or not os.path.exists(drc):
        res['5 drc'] = (False, f'{drc_s} ' + p.stderr.decode('utf-8', 'replace')[-200:])
        unconn = viol = None
    else:
        d = json.load(open(drc, encoding='utf-8'))
        unconn = len(d['unconnected_items'])
        viol = [v['type'] for v in d['violations']]
        expected = sum(len(n['nodes']) - 1 for n in nets if len(n['nodes']) > 1)
        # stage 2: the board is routed, so KiCad must find nothing left to connect
        res['5 drc'] = (not viol and unconn == 0,
                        f'violations={viol} unconnected={unconn} (before routing: {expected}) {drc_s}')

    # 6. gerbers + drill export, by the same function as the server's /generate_gerber
    gdir = os.path.join(work, f'{name}_{style}_gerber')
    try:
        fab = export_fab(cli, pcb, gdir)
        files = fab['files']
        res['6 gerber'] = (len(files) == len(FAB_SUFFIXES), f'{len(files)} files')
    except Exception as e:
        fab, files = None, []
        res['6 gerber'] = (False, str(e)[-200:])

    # 6b. what a PCB maker gets: the zip holds exactly those files, the drill files split plated from
    # non-plated holes, the copper gerbers carry the filled ground pour (G36 regions) on the layers the
    # preview pours, and pads join the pour through thermal spokes with the preview's clearance
    fab_bad = []
    if fab:
        import zipfile
        with zipfile.ZipFile(os.path.join(gdir, fab['zip'])) as z:
            if sorted(z.namelist()) != sorted(files) or z.testzip() is not None:
                fab_bad.append(f'zip={sorted(z.namelist())}')
        drl = {s: open(os.path.join(gdir, next(f for f in files if f.endswith(s))), encoding='utf-8').read()
               for s in ('-PTH.drl', '-NPTH.drl')}
        if 'FileFunction,Plated,' not in drl['-PTH.drl'] or 'FileFunction,NonPlated,' not in drl['-NPTH.drl']:
            fab_bad.append('drill files not split by plating')
        layer_file = {'F.Cu': '-F_Cu.gtl', 'B.Cu': '-B_Cu.gbl'}
        pour_layers = sorted({r['layer'] for r in model.get('pour', [])})
        if not pour_layers:   # every test circuit has a GND net: no pour at all means board.py stopped pouring
            fab_bad.append('no ground pour')
        for layer in pour_layers:
            g = open(os.path.join(gdir, next(f for f in files if f.endswith(layer_file[layer]))), encoding='utf-8').read()
            if 'G36*' not in g:
                fab_bad.append(f'no pour in {layer} gerber')
        # one zone per poured layer, at the preview's 0.5 mm from other copper (0 let KiCad fill to 0.2 mm)
        pads_rule = re.findall(r'\(connect_pads([^()]*)\(clearance ([\d.]+)\)', open(pcb, encoding='utf-8').read())
        if len(pads_rule) != len(pour_layers) or any(float(gap) != 0.5 for _, gap in pads_rule):
            fab_bad.append(f'zone pad rules {pads_rule}')
    res['6b fab files'] = (fab is not None and not fab_bad, '; '.join(fab_bad) or f"{fab['zip'] if fab else ''}")

    # ── stage 1: placement ──
    # 8. placement beats the stage-0 shelf layout
    res['8 hpwl<shelf'] = (summary['hpwl'] < summary['hpwl_shelf'],
                           f"shelf={summary['hpwl_shelf']} force={summary['hpwl']} "
                           f"(-{(1 - summary['hpwl'] / summary['hpwl_shelf']) * 100:.0f}%)")

    # 9. connectors sit on the edge of the circuit area (the board itself is bigger: it carries
    #    the mounting-hole ring), so measure against parts_box when the generator reports one
    pb = summary.get('parts_box')
    px1, py1, px2, py2 = (pb['x1'], pb['y1'], pb['x2'], pb['y2']) if pb else (ox1, oy1, ox2, oy2)
    far = []
    for ref, p in parts.items():
        if ref.rstrip('0123456789') in ('J', 'BT'):
            c = p['keepout']
            gap = min(c[0] - px1, c[1] - py1, px2 - c[2], py2 - c[3])
            if gap > BOARD_MARGIN + 0.01:
                far.append(f'{ref}:{gap:.2f}mm')
    res['9 connectors@edge'] = (not far, str(far or ''))

    # 10. our pad positions and orientations = KiCad's (proves the rotation math)
    kp = kicad_pad_positions(cli, pcb)
    worst, missing, rot_bad = 0.0, 0, []
    for ref, p in parts.items():
        local = {pad['num']: pad for pad in p['pads']}
        for pa in p['pads_abs']:
            k = kp.get((ref, pa['num']))
            if k is None:
                missing += 1
                continue
            worst = max(worst, abs(k[0] - pa['x']), abs(k[1] - pa['y']))
            want_r = (360 - int(round(local[pa['num']]['angle'] + p['rot']))) % 360
            if k[2] != want_r:
                rot_bad.append(f"{ref}.{pa['num']}")
    rotated = sum(1 for p in parts.values() if p['rot'])
    res['10 pads=KiCad'] = (worst <= 0.01 and not rot_bad and missing < len(kp),
                            f'worst={worst:.4f}mm rotated_parts={rotated} angle_bad={rot_bad[:4]}')

    # 11. deterministic: a second run gives the same layout
    pcb2 = os.path.join(work, f'{name}_{style}_again.kicad_pcb')
    generate(net_path, pcb2, style)
    model2 = json.load(open(pcb2.replace('.kicad_pcb', '.board.json'), encoding='utf-8'))
    same = [(p['x'], p['y'], p['rot']) for p in model['parts']] == [(p['x'], p['y'], p['rot']) for p in model2['parts']]
    res['11 deterministic'] = (same, '')

    # 12. stream: every line JSON, parts -> init -> frames -> done
    sp = subprocess.run([sys.executable, os.path.join(SERVER, 'pcb_generator.py'), net_path,
                         os.path.join(work, f'{name}_{style}_stream.kicad_pcb'), '--style', style, '--stream'],
                        capture_output=True)
    try:
        events = [json.loads(l) for l in sp.stdout.decode('utf-8').splitlines() if l.strip()]
        kinds = [e['type'] for e in events]
        frames = kinds.count('frame')
        routes, rips = kinds.count('route'), kinds.count('rip')
        last_frame = max(i for i, k in enumerate(kinds) if k == 'frame')
        first_route = min((i for i, k in enumerate(kinds) if k == 'route'), default=len(kinds))
        ok = (sp.returncode == 0 and kinds[:2] == ['parts', 'init'] and kinds[-1] == 'done' and frames > 20
              and events[-1]['board']['parts'][0]['x'] == model['parts'][0]['x']
              and last_frame < first_route and routes >= summary['connections'])
        res['12 stream'] = (ok, f'{len(events)} events, {frames} frames, {routes} routes, {rips} rips, '
                                f'{len(sp.stdout)} bytes')
    except (ValueError, KeyError, IndexError) as e:
        res['12 stream'] = (False, f'bad stream: {e}')

    # ── stage 2: routing ──
    # 13. every connection routed
    res['13 unrouted=0'] = (not summary['unrouted'],
                            f"{summary['connections']} connections, {summary['tracks']} segments, "
                            f"{summary['vias']} vias, {summary['track_length']} mm {summary['unrouted'] or ''}")

    # 14. file, model and summary agree on the copper
    root = parse(open(pcb, encoding='utf-8').read())
    seg_n, via_n = len(find_all(root, 'segment')), len(find_all(root, 'via'))
    res['14 copper counts'] = (seg_n == len(model['tracks']) == summary['tracks'] and
                               via_n == len(model['vias']) == summary['vias'],
                               f'file segments={seg_n} vias={via_n}')

    # 15. the gerbers really carry the tracks (draw commands on the copper layers)
    draws = 0
    for f in files:
        if f.endswith(('-F_Cu.gtl', '-B_Cu.gbl')):
            draws += open(os.path.join(gdir, f), encoding='utf-8', errors='replace').read().count('D01*')
    res['15 gerber copper'] = (draws >= summary['tracks'], f'D01 draws={draws} segments={summary["tracks"]}')

    # 16. routing time
    res['16 route time'] = (summary['route_ms'] <= 10000, f"{summary['route_ms']} ms")

    # ── stage 3: checks ──
    # 17. a good circuit produces no netlist findings
    res['17 erc clean'] = (not summary['erc'], str([f['rule'] for f in summary['erc']]))

    # 20. the check /generate runs before any PCB (pcb_generator.py --erc-only) agrees with the board's
    pre = netlist_check(net_path, style)
    res['20 pre-PCB ERC = board ERC'] = (pre['erc'] == summary['erc'] and len(pre['components']) == len(components),
                                         f"pre={[f['rule'] for f in pre['erc']]} parts={len(pre['components'])}")

    # 18. the stream carries erc and drc-worthy data before done
    try:
        kinds2 = [e['type'] for e in events]
        res['18 erc in stream'] = (kinds2.count('erc') == 1 and kinds2.index('erc') < kinds2.index('done'),
                                   f"erc events={kinds2.count('erc')}")
    except (NameError, ValueError):
        res['18 erc in stream'] = (False, 'stream not parsed')

    return res, summary, unconn


def _overlap(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def check_broken_circuit(work, cli):
    """19. the netlist checks must catch a deliberately broken circuit (and only its faults).
    20. the pre-PCB check (--erc-only, run as a subprocess the way the server runs it) finds the same."""
    net_path = build_netlist('broken_floating', work)
    pcb = os.path.join(work, 'broken.kicad_pcb')
    summary = generate(net_path, pcb, 'smd')
    rules = {f['rule'] for f in summary['erc']}
    refs = {(r['ref'], r['pin']) for f in summary['erc'] for r in f['refs']}
    nets = {f['net'] for f in summary['erc'] if f['net']}
    ok = (rules == {'floating_pin', 'single_pin_net'} and ('R2', '2') in refs and 'TEST' in nets)
    p = subprocess.run([sys.executable, os.path.join(SERVER, 'pcb_generator.py'), net_path, '--erc-only'],
                       capture_output=True)
    try:
        pre = json.loads(p.stdout.decode('utf-8').strip().splitlines()[-1])
        pre_ok = p.returncode == 0 and pre['erc'] == summary['erc']
        pre_info = f"pre={sorted(f['rule'] for f in pre['erc'])} board={sorted(rules)}"
    except (ValueError, KeyError, IndexError) as e:
        pre_ok, pre_info = False, f'no JSON from --erc-only: {e} {p.stderr.decode("utf-8", "replace")[-200:]}'
    return (ok, f'rules={sorted(rules)} refs={sorted(refs)} nets={sorted(nets)}'), (pre_ok, pre_info)


def check_no_bypass(work):
    """The 555 demo with its 100 nF C3 taken out: one no_bypass warning on U1's VCC pin, in both styles (the demos
    themselves have none: item 17). Before the rule (2026-11-08) this circuit passed every netlist check."""
    src = open(os.path.join(SERVER, 'test_circuits', 'ne555_blink.py'), encoding='utf-8').read()
    with open(os.path.join(work, 'ne555_no_bypass.py'), 'w', encoding='utf-8') as f:
        f.write(''.join(line for line in src.splitlines(True) if not line.startswith('c3')))
    subprocess.run([sys.executable, 'ne555_no_bypass.py'], cwd=work, check=True, capture_output=True)
    got = {}
    for style in STYLES:
        erc = netlist_check(os.path.join(work, 'ne555_no_bypass.net'), style)['erc']
        got[style] = [(f['rule'], f['severity'], f['net'], [(r['ref'], r.get('sym')) for r in f['refs']]) for f in erc]
    want = [('no_bypass', 'warning', 'VCC', [('U1', '8')])]
    return all(g == want for g in got.values()), f'{got}'


def check_split_ground(work):
    """Two supplies whose grounds (GND, AGND) nothing joins: one split_ground warning; joined by a 0 Ω resistor or an
    inductor (a ferrite bead), none; a 10 kΩ resistor between them does not join them. Before the rule (2026-11-08) the
    split circuit passed every netlist check."""
    comps = [{'ref': 'J1', 'value': 'P5', 'part': 'Conn_01x02'}, {'ref': 'R1', 'value': '1k', 'part': 'R'},
             {'ref': 'J2', 'value': 'P12', 'part': 'Conn_01x02'}, {'ref': 'R2', 'value': '1k', 'part': 'R'}]
    nets = [('+5V', ['J1.1', 'R1.1']), ('GND', ['J1.2', 'R1.2']), ('+12V', ['J2.1', 'R2.1']), ('AGND', ['J2.2', 'R2.2'])]
    got = {}
    for name, tie in (('split', None), ('0 ohm', ('R3', 'R', '0')), ('ferrite', ('L1', 'L', 'FB')), ('10k', ('R3', 'R', '10k'))):
        cs = comps + ([{'ref': tie[0], 'value': tie[2], 'part': tie[1]}] if tie else [])
        ns = [(n, pins + ([f'{tie[0]}.{1 if n == "GND" else 2}'] if tie and n in ('GND', 'AGND') else [])) for n, pins in nets]
        path = os.path.join(work, f'split_{name.replace(" ", "_")}.net')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(_graph_netlist(cs, [{'name': n, 'nodes': [{'ref': p.split('.')[0], 'pin': p.split('.')[1]} for p in pins]}
                                        for n, pins in ns]))
        got[name] = [(e['rule'], e['severity']) for e in netlist_check(path)['erc']]
    want = {'split': [('split_ground', 'warning')], '0 ohm': [], 'ferrite': [], '10k': [('split_ground', 'warning')]}
    return got == want, f'{got}'


def check_four_legged_diode(work):
    """A bridge written as a 'D' with four pins (seen from the model) is reported pin by pin, never placed
    as if it fit. src/lib/humanReview.ts missingPads reads these words for the screen."""
    src = open(os.path.join(SERVER, 'test_circuits', 'bridge_supply.py'), encoding='utf-8').read()
    with open(os.path.join(work, 'bridge_as_d.py'), 'w', encoding='utf-8') as f:
        f.write(src.replace("name='Bridge'", "name='D'"))
    subprocess.run([sys.executable, 'bridge_as_d.py'], cwd=work, check=True, capture_output=True)
    summary = generate(os.path.join(work, 'bridge_as_d.net'), os.path.join(work, 'bridge_as_d.kicad_pcb'), 'smd')
    want = [f'D1 pin {n} has no pad in Diode_SMD:D_SOD-123' for n in (3, 4)]
    return summary['warnings'] == want and not summary['unmapped'], f"warnings={summary['warnings']}"


def _rss_mb(proc):
    """What a running child holds in memory right now (psutil is not in requirements.txt); 0 if it cannot be read."""
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('faults', wintypes.DWORD), ('peak', ctypes.c_size_t),
                        ('rss', ctypes.c_size_t), ('rest', ctypes.c_size_t * 6)]
        c = Counters(cb=ctypes.sizeof(Counters))
        got = ctypes.windll.kernel32.K32GetProcessMemoryInfo(wintypes.HANDLE(int(proc._handle)), ctypes.byref(c), c.cb)
        return c.rss / 2**20 if got else 0
    try:
        with open(f'/proc/{proc.pid}/statm') as f:
            return int(f.read().split()[1]) * os.sysconf('SC_PAGE_SIZE') / 2**20
    except OSError:
        return 0


def _run_watched(cmd, out_path, limit_mb, limit_s):
    """(exit code, or None when killed past a limit; peak MB; seconds). stdout goes to a file: a full pipe would stall it."""
    with open(out_path, 'wb') as out:
        proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.DEVNULL)
        t0, peak = time.time(), 0
        while proc.poll() is None:
            peak = max(peak, _rss_mb(proc))
            if peak > limit_mb or time.time() - t0 > limit_s:
                proc.kill()
                proc.wait()
                return None, peak, time.time() - t0
            time.sleep(0.02)
    return proc.returncode, peak, time.time() - t0


# What graphToNetlist (server/index.ts) writes for a 150-byte request to /erc_graph, which needs no login.
PIN_BOMB_NET = '''(export (version "D")
  (components
    (comp (ref "U1") (value "x")
      (description "X")
      (footprint "")
      (libsource (lib "NO_LIB") (part "X"))
    )
  )
  (nets
    (net (code 1) (name "A")
      (node (ref "U1") (pin "999999999"))
    )
  )
)'''
PIN_BOMB_MB, PIN_BOMB_S = 300, 30    # measured 31 MB, 0.9 s (--erc-only); 46 MB, 1.5 s (whole board); 30 s is runErc's limit


def check_pin_number_bomb(work):
    """A huge pin number on a part the table does not know makes MAX_PLACEHOLDER_PINS pads and a no-pad warning, not that
    many pads. Run the two ways the server runs the generator, watched: before the cap python went past 2 GB in 4 s
    (2026-11-06), here it is killed at the limit. src/lib/fixes.ts missingLegs reads the warning's words."""
    net = os.path.join(work, 'pin_bomb.net')
    with open(net, 'w', encoding='utf-8') as f:
        f.write(PIN_BOMB_NET)
    gen = os.path.join(SERVER, 'pcb_generator.py')
    pcb = os.path.join(work, 'pin_bomb.kicad_pcb')
    runs = {'erc': [sys.executable, gen, net, '--erc-only'], 'board': [sys.executable, gen, net, pcb]}
    done, info = {}, []
    for name, cmd in runs.items():
        out = os.path.join(work, name + '.out')
        code, peak, secs = _run_watched(cmd, out, PIN_BOMB_MB, PIN_BOMB_S)
        info.append(f'{name}: exit={code} {peak:.0f} MB {secs:.1f} s')
        # peak 0 is a watch that saw nothing, not a pass
        if code == 0 and 0 < peak <= PIN_BOMB_MB:
            done[name] = json.loads(open(out, encoding='utf-8').read().strip().splitlines()[-1])
    if len(done) < len(runs):
        return False, '; '.join(info)
    want = 'U1 pin 999999999 has no pad in SchemaForge:UNMAPPED_X'
    model = json.load(open(pcb.replace('.kicad_pcb', '.board.json'), encoding='utf-8'))
    pads = len(model['parts'][0]['pads'])
    bomb_ok = done['board']['warnings'] == [want] and [u['ref'] for u in done['board']['unmapped']] == ['U1'] \
        and pads == MAX_PLACEHOLDER_PINS and len(done['erc']['components']) == 1
    # the cap's edge: the last pin that fits keeps its pad and its net, the next one is reported, and a low pin is untouched
    edge = [str(n) for n in (5, MAX_PLACEHOLDER_PINS, MAX_PLACEHOLDER_PINS + 1)]
    parts, unmapped, warnings = build_board([{'ref': 'U1', 'value': 'x', 'part': 'X'}],
                                            [{'name': 'B', 'nodes': [{'ref': 'U1', 'pin': p} for p in edge]}])
    edge_ok = warnings == [f'U1 pin {edge[2]} has no pad in SchemaForge:UNMAPPED_X'] and len(unmapped) == 1 \
        and parts[0]['pad_net'] == {edge[0]: 'B', edge[1]: 'B'}
    return bomb_ok and edge_ok, f"{'; '.join(info)}; pads={pads} warnings={done['board']['warnings']} edge={warnings}"


def _graph_netlist(components, nets):
    """A netlist as server/index.ts graphToNetlist writes one from the schematic graph: no pintype, pins as saved."""
    comps = '\n'.join(f'    (comp (ref "{c["ref"]}") (value "{c["value"]}") (libsource (lib "NO_LIB") (part "{c["part"]}")))'
                      for c in components)
    body = '\n'.join(f'    (net (code {i + 1}) (name "{n["name"]}")\n'
                     + '\n'.join(f'      (node (ref "{nd["ref"]}") (pin "{nd["pin"]}"))' for nd in n['nodes']) + ')'
                     for i, n in enumerate(nets))
    return f'(export (version "D")\n  (components\n{comps}\n  )\n  (nets\n{body}\n  )\n)'


def check_pin_names(work):
    """A graph an older edit saved by pin name ({ref: 'D1', pin: 'A'}) reaches the netlist as written (graphToNetlist).
    Read through erc.PIN_NAMES, the front end's table, it gives the numbered circuit's pads and netlist checks; a name the
    table does not know is not guessed: one warning in the words src/lib/fixes.ts missingLegs reads, and its pad left
    without the net. Before 2026-11-08 every pin saved by name was left off the board without a word."""
    bad, seen = [], 0
    for name in ('ne555_blink', 'npn_relay'):
        components, nets = parse_netlist(open(build_netlist(name, work), encoding='utf-8').read())
        part_of = {c['ref']: c['part'] for c in components}

        def by_name(nd):
            names, n = PIN_NAMES.get(part_of[nd['ref']]), int(nd['pin'])
            return names[n - 1] if names and n <= len(names) else f'p{n}'

        led, kind_of_led = next((c['ref'], c['part']) for c in components if c['part'] in ('LED', 'D'))
        files = {}
        for kind, pin in (('number', lambda nd: nd['pin']), ('name', by_name),
                          ('unknown', lambda nd: 'ANODE' if nd['ref'] == led and nd['pin'] == '1' else by_name(nd))):
            path = os.path.join(work, f'{name}_{kind}.net')
            with open(path, 'w', encoding='utf-8') as f:
                f.write(_graph_netlist(components, [{'name': n['name'], 'nodes': [{'ref': nd['ref'], 'pin': pin(nd)}
                                                                                  for nd in n['nodes']]} for n in nets]))
            files[kind] = path
        got = {}
        for kind, path in files.items():
            comps, ns = parse_netlist(open(path, encoding='utf-8').read())
            seen += kind == 'name' and sum(not nd['pin'].isdigit() for n in ns for nd in n['nodes'])
            parts, unmapped, warnings = build_board(comps, ns, 'smd')
            got[kind] = ({p['ref']: p['pad_net'] for p in parts}, warnings, netlist_check(path)['erc'], parts)
        (pads, warn, erc, _), (n_pads, n_warn, n_erc, _) = got['number'], got['name']
        if n_pads != pads or n_warn != warn or n_erc != erc:
            bad.append(f'{name} by name: pads {n_pads == pads} warnings {n_warn} erc {[f["message"] for f in n_erc]}')
        u_pads, u_warn, _, u_parts = got['unknown']
        a_pad = next(pd for pd, s in next(p for p in u_parts if p['ref'] == led)['pad_sym'].items() if s == 1)
        if u_warn != [f'{led} pin "ANODE" is neither a pin number nor a pin name of {kind_of_led}'] + warn or a_pad in u_pads[led] \
                or {r: v for r, v in u_pads.items() if r != led} != {r: v for r, v in pads.items() if r != led}:
            bad.append(f'{name} unknown name: warnings {u_warn} {led} pads {u_pads[led]}')
    return not bad and seen > 0, f'{seen} pins saved by name; ' + (' | '.join(bad) or 'same pads, warnings and erc')


def _round_against_plain_loop(parts):
    """One local-search round beside the per-candidate loop it replaced: (parts that moved, parts that took another move)."""
    costs_of = placer._part_costs
    want = {}

    def pose(p):
        return p['x'], p['y'], p['rot']

    def recording(p, cands, boxes):
        costs = costs_of(p, cands, boxes)
        if len(cands) > 1:  # the current pose is costed alone
            base = costs_of(p, [pose(p)], boxes)[0]
            others = [placer.part_bbox(q) for q in parts if q is not p]
            want[p['ref']] = pose(p)
            best = None
            for k, cand in enumerate(cands):
                if costs[k] < base - 1e-6 and (best is None or costs[k] < best) \
                        and not any(placer._overlap(placer.part_bbox(p, *cand), o, placer.GAP / 2) for o in others):
                    best = costs[k]
                    want[p['ref']] = cand
        return costs

    before = {p['ref']: pose(p) for p in parts}
    placer._part_costs = recording
    try:
        placer._local_search_round(parts, {})
    finally:
        placer._part_costs = costs_of
    return sum(pose(p) != before[p['ref']] for p in parts), [p['ref'] for p in parts if pose(p) != want[p['ref']]]


def check_local_search(work):
    """The local search's candidate costs (one numpy step per rotation, its own rotation math) move exactly as hpwl() does
    for every part at poses in all four rotations, a round takes the move the per-candidate loop took (the cheapest free one,
    the first of equal costs), and it does not go back to a python call per candidate, which was most of the placement time
    (2026-11-06): pad_positions runs once per other part, not once per candidate."""
    net = build_netlist('ne555_blink', work)
    components, nets = parse_netlist(open(net, encoding='utf-8').read())
    # the shelf layout has moves to take; after force_place a round has none, and a check on those would pass on nothing
    shelf, _, _ = build_board(components, nets, 'tht')
    moved, wrong = _round_against_plain_loop(shelf)
    parts, _, _ = build_board(components, nets, 'tht')
    placer.force_place(parts, nets)
    worst = 0.0
    for p in parts:
        home = p['x'], p['y'], p['rot']
        cands = [(home[0] + 3.0 * i, home[1] - 2.0 * i, (home[2] + 90 * i) % 360) for i in range(8)]
        costs = placer._part_costs(p, cands, placer._net_boxes([q for q in parts if q is not p]))
        totals = []
        for cand in cands:
            p['x'], p['y'], p['rot'] = cand
            totals.append(hpwl(parts))
        p['x'], p['y'], p['rot'] = home
        worst = max(worst, *(abs((t - totals[0]) - (c - costs[0])) for t, c in zip(totals, costs)))
    calls = 0
    counted = placer.pad_positions

    def counting(*args):
        nonlocal calls
        calls += 1
        return counted(*args)

    placer.pad_positions = counting
    try:
        placer._local_search_round(parts, {})
    finally:
        placer.pad_positions = counted
    limit = len(parts) * (len(parts) - 1)
    return worst < 1e-6 and 0 < calls <= limit and moved > 0 and not wrong, \
        f'cost off hpwl by {worst:.2e} mm; pad_positions {calls} calls, limit {limit}; {moved} parts moved, other move on {wrong}'


def check_templates():
    """7. every part template in SYSTEM_PROMPT has a table entry (or is a documented exception)."""
    src = open(os.path.join(SERVER, 'index.ts'), encoding='utf-8').read()
    prompt = src[src.index('const SYSTEM_PROMPT'):src.index('═══ SECTION 2')]
    names = set(re.findall(r"name='([^']+)', ref_prefix=", prompt))
    known = {k[0] for k in TABLE}
    missing = sorted(n for n in names if n not in known and n not in KNOWN_UNMAPPED
                     and not re.fullmatch(r'Conn_01x\d\d', n))
    return (not missing, f'templates={sorted(names)} missing={missing}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--keep', help='write boards here instead of a temp dir')
    args = ap.parse_args()
    cli = kicad_cli()
    work_root = args.keep or tempfile.mkdtemp(prefix='sf_checks_')
    os.makedirs(work_root, exist_ok=True)
    global DRC_ENV
    if not os.environ.get('KICAD_CONFIG_HOME'):
        DRC_ENV = dict(os.environ, KICAD_CONFIG_HOME=vendored_kicad_config(os.path.join(work_root, 'kicad_config')))
        print(f'DRC reads the vendored footprint table in {DRC_ENV["KICAD_CONFIG_HOME"]}')

    all_ok = True
    rows = []
    for name in CIRCUITS:
        for style in STYLES:
            work = os.path.join(work_root, f'{name}_{style}')
            os.makedirs(work, exist_ok=True)
            res, summary, unconn = check_one(name, style, work, cli)
            ok = all(v[0] for v in res.values())
            all_ok &= ok
            rows.append((name, style, ok, summary, unconn))
            print(f'== {name} [{style}] {"PASS" if ok else "FAIL"}  '
                  f'{summary["components"]} parts, {summary["nets"]} nets, board {summary["board"]["w"]} x {summary["board"]["h"]} mm')
            for k, (passed, info) in res.items():
                print(f'   {"ok  " if passed else "FAIL"} {k}  {info}')
            for w in summary['warnings']:
                print(f'   warn {w}')
    b_dir = os.path.join(work_root, 'broken')
    os.makedirs(b_dir, exist_ok=True)
    (b_ok, b_info), (pre_ok, pre_info) = check_broken_circuit(b_dir, cli)
    all_ok &= b_ok and pre_ok
    print(f'== broken circuit caught {"PASS" if b_ok else "FAIL"}  {b_info}')
    print(f'== broken circuit, pre-PCB ERC = board ERC {"PASS" if pre_ok else "FAIL"}  {pre_info}')
    c_dir = os.path.join(work_root, 'no_bypass')
    os.makedirs(c_dir, exist_ok=True)
    c_ok, c_info = check_no_bypass(c_dir)
    all_ok &= c_ok
    print(f'== 555 with no capacitor on VCC warned {"PASS" if c_ok else "FAIL"}  {c_info}')
    g_dir = os.path.join(work_root, 'split_ground')
    os.makedirs(g_dir, exist_ok=True)
    g_ok, g_info = check_split_ground(g_dir)
    all_ok &= g_ok
    print(f'== two grounds nothing joins warned, a 0 ohm or ferrite tie not {"PASS" if g_ok else "FAIL"}  {g_info}')
    d_dir = os.path.join(work_root, 'four_legged_diode')
    os.makedirs(d_dir, exist_ok=True)
    d_ok, d_info = check_four_legged_diode(d_dir)
    all_ok &= d_ok
    print(f'== four-legged diode reported {"PASS" if d_ok else "FAIL"}  {d_info}')
    n_dir = os.path.join(work_root, 'pin_bomb')
    os.makedirs(n_dir, exist_ok=True)
    n_ok, n_info = check_pin_number_bomb(n_dir)
    all_ok &= n_ok
    print(f'== huge pin number capped {"PASS" if n_ok else "FAIL"}  {n_info}')
    p_dir = os.path.join(work_root, 'pin_names')
    os.makedirs(p_dir, exist_ok=True)
    p_ok, p_info = check_pin_names(p_dir)
    all_ok &= p_ok
    print(f'== pins saved by name read, an unknown name reported {"PASS" if p_ok else "FAIL"}  {p_info}')
    l_dir = os.path.join(work_root, 'local_search')
    os.makedirs(l_dir, exist_ok=True)
    l_ok, l_info = check_local_search(l_dir)
    all_ok &= l_ok
    print(f'== local search costs = hpwl, per rotation {"PASS" if l_ok else "FAIL"}  {l_info}')
    t_ok, t_info = check_templates()
    all_ok &= t_ok
    print(f'== templates {"PASS" if t_ok else "FAIL"}  {t_info}')
    print(f'\nboards in {work_root}')
    print('ALL PASS' if all_ok else 'SOME CHECKS FAILED')
    sys.exit(0 if all_ok else 1)


if __name__ == '__main__':
    main()
