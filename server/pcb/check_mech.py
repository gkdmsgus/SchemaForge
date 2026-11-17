"""
Checks M1-M9: the board an enclosure fixes (기구 조건 step 1, 2026-11-17). A width and height in mm and M3 holes at given
spots (overrides['mech']): the parts go inside that board and keep off the holes, the outline is that board, a circuit that
does not fit and a hole too near the edge are refused in Korean, nothing is enlarged to make room, a reroute with the
fixed placer (the AI rounds) keeps the board, and with no mech the board is what it was. KiCad's DRC checks one board.

Usage: python server/pcb/check_mech.py   → exit 0 only if every check passes
"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import board  # noqa: E402

# Korean in the output; never let the console codepage stop the run
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

NET = os.path.join(os.path.dirname(HERE), 'test_circuits', 'led_basic.net')
OUT = tempfile.mkdtemp(prefix='sf_mech_')
failed = 0


def check(name, ok, info=''):
    global failed
    if not ok:
        failed += 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}  {info}")


def run(name, mech=None, style='smd', placer='force', parts=None):
    path = os.path.join(OUT, f'{name}.kicad_pcb')
    ov = {**({'mech': mech} if mech else {}), **({'parts': parts} if parts else {})}
    try:
        return board.generate(NET, path, style, placer, overrides=ov or None), path
    except board.MechRefused as e:
        return {'refused': str(e)}, path


def model(summary):
    with open(os.path.join(OUT, summary['boardJson']), encoding='utf-8') as f:
        return json.load(f)


FOUR = [[4, 5], [36, 5], [36, 26], [4, 26]]
ox, oy = board.MECH_ORIGIN

# M1-M2: both styles fit 40 x 30 mm with four holes where they were asked, nothing outside or on a hole, all routed
for style in ('smd', 'tht'):
    s, _ = run(f'fit_{style}', {'width': 40, 'height': 30, 'holes': FOUR}, style)
    ok = 'refused' not in s
    m = model(s) if ok else {}
    holes = sorted((round(p['x'] - ox, 3), round(p['y'] - oy, 3)) for p in m.get('parts', []) if p['part'] == 'MountingHole')
    check(f'M1 {style}: 40 x 30 mm, holes at the asked spots, nothing outside or overlapping, everything routed',
          ok and s['board']['w'] == 40 and s['board']['h'] == 30 and holes == sorted(tuple(map(float, h)) for h in FOUR)
          and not s['outside'] and not s['overlaps'] and not s.get('unrouted') and s.get('mech', {}).get('holes') == 4,
          json.dumps({k: s.get(k) for k in ('board', 'outside', 'overlaps', 'unrouted', 'refused')}, ensure_ascii=False)[:300])
    if ok and style == 'smd':
        # the connector (BT1) sits on the board's edge, BOARD_MARGIN in: a cable reaches it from outside the case
        bt = next(p for p in m['parts'] if p['ref'] == 'BT1')
        k = board.part_keepout(bt)
        gaps = [k[0] - ox, k[1] - oy, ox + 40 - k[2], oy + 30 - k[3]]
        check('M2 the connector lies along an edge of the enclosure\'s board', abs(min(gaps) - board.BOARD_MARGIN) < 0.51,
              f'gaps to the edges {[round(g, 2) for g in gaps]}')

# M3: too small is refused with the size the layout needs, and no file is left claiming a board
s, path = run('small', {'width': 12, 'height': 10, 'holes': []})
check('M3 a board too small is refused in Korean with the size it would need, no .kicad_pcb written',
      'refused' in s and '들어가지 않습니다' in s['refused'] and '필요' in s['refused'] and '구멍' not in s['refused'] and not os.path.exists(path),
      s.get('refused', '')[:160])

# M4: a hole too near the edge says each side's distance; M5 two holes on each other
s, _ = run('edge', {'width': 40, 'height': 30, 'holes': [[3.5, 3.5]]})
check('M4 a hole too near the edge is refused and says how far in its centre must be on each side',
      'refused' in s and '가장자리에 너무 가깝' in s['refused'] and '왼쪽 가장자리에서 3.45 mm' in s['refused'], s.get('refused', '')[:200])
s, _ = run('twin', {'width': 40, 'height': 30, 'holes': [[10, 10], [12, 10]]})
check('M5 two holes on each other are refused', 'refused' in s and '서로 겹칩니다' in s['refused'], s.get('refused', '')[:120])

# M6: a size with no holes gives a board with none (the corners are not filled in by guess)
s, _ = run('bare', {'width': 40, 'height': 30, 'holes': []})
check('M6 a size with no holes: that board, no holes', 'refused' not in s and s['holes'] == [] and s['board']['w'] == 40, str(s.get('holes')))

# M7: the AI rounds reroute with the fixed placer and the same mech: the board and its holes stay
s, _ = run('fit_again', {'width': 40, 'height': 30, 'holes': FOUR})
m = model(s)
poses = {p['ref']: [p['x'], p['y'], p['rot']] for p in m['parts'] if p['part'] != 'MountingHole'}
s2, _ = run('fixed', {'width': 40, 'height': 30, 'holes': FOUR}, placer='fixed', parts=poses)
check('M7 a fixed-placer reroute with the mech keeps the 40 x 30 mm board and its four holes',
      'refused' not in s2 and s2['board'] == s['board'] and s2['holes'] == s['holes'], f"{s2.get('board')} {s2.get('holes')}")
# and a move onto a hole there is refused, not drawn
onto = dict(poses, R1=[ox + 4, oy + 5, 0])
s3, _ = run('onto', {'width': 40, 'height': 30, 'holes': FOUR}, placer='fixed', parts=onto)
check('M8 a fixed-placer move onto a hole is refused', 'refused' in s3 and '구멍 자리와 겹칩니다' in s3['refused'], s3.get('refused', '')[:160])

# M9: no mech is the board as before: sized from the parts, a hole in each corner
s, _ = run('plain')
check('M9 with no mech the board is sized from the parts and has its four corner holes', 'mech' not in s and len(s['holes']) == 4
      and s['board']['w'] < 40, f"{s['board']} {s['holes']}")

# M10: KiCad's DRC on the SMD enclosure board: no violation, nothing unconnected
cli = os.environ.get('KICAD_CLI_PATH') or os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'KiCad', '10.0', 'bin', 'kicad-cli.exe')
cli = cli if os.path.exists(cli) else 'kicad-cli'
report = os.path.join(OUT, 'drc.json')
try:
    subprocess.run([cli, 'pcb', 'drc', '--format', 'json', '--severity-all', '-o', report, os.path.join(OUT, 'fit_smd.kicad_pcb')],
                   capture_output=True, timeout=180)
    with open(report, encoding='utf-8') as f:
        d = json.load(f)
    errors = [v for v in d.get('violations', []) if v.get('severity') == 'error']
    check('M10 KiCad DRC on the 40 x 30 mm SMD board: no error, nothing unconnected', not errors and not d.get('unconnected_items'),
          f"{len(errors)} errors {[v['type'] for v in errors][:5]}, {len(d.get('unconnected_items', []))} unconnected")
except (OSError, subprocess.TimeoutExpired, ValueError) as e:
    check('M10 KiCad DRC on the 40 x 30 mm SMD board', False, f'DRC did not run: {e}')

print(f'\n{failed} check(s) failed' if failed else '\nALL PASS')
sys.exit(1 if failed else 0)
