"""
Checks M1-M16: the board an enclosure fixes (기구 조건 step 1, 2026-11-17). A width and height in mm and M3 holes at given
spots (overrides['mech']): the parts go inside that board and keep off the holes, the outline is that board, a circuit that
does not fit and a hole too near the edge are refused in Korean, nothing is enlarged to make room, a reroute with the
fixed placer (the AI rounds) keeps the board, and with no mech the board is what it was. KiCad's DRC checks one board.
M11-M16 (step 2, 2026-11-17): a part pinned to an edge (mech['fixed'] = [{ref, side, at, rot?}]) sits there, its courtyard's
middle `at` mm along the side, and the rest is placed around it; a spot on a hole is refused with the range that fits (and
that range does fit), an unknown or twice-pinned part is refused, a reroute that moves a pinned part is refused, and KiCad's
DRC passes on the pinned boards in both styles.

Usage: python server/pcb/check_mech.py   → exit 0 only if every check passes
"""
import json, os, re, subprocess, sys, tempfile

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

# M11-M12: pinned parts stay where they were pinned, in both styles, and the board is otherwise as good
def pinned_at(m, ref, side):
    """(the keep-out's gap to that edge, the courtyard's middle along it, rot) for ref on the board model m"""
    p = next(q for q in m['parts'] if q['ref'] == ref)
    k, c = p['keepout'], p['courtyard']
    gap = {'left': k[0] - ox, 'right': ox + 40 - k[2], 'top': k[1] - oy, 'bottom': oy + 30 - k[3]}[side]
    mid = (c[1] + c[3]) / 2 - oy if side in ('left', 'right') else (c[0] + c[2]) / 2 - ox
    return round(gap, 3), round(mid, 3), p['rot']


LEFT = {'width': 40, 'height': 30, 'holes': FOUR, 'fixed': [{'ref': 'BT1', 'side': 'left', 'at': 15}]}
for style in ('smd', 'tht'):
    s, _ = run(f'pin_{style}', LEFT, style)
    ok = 'refused' not in s
    got = pinned_at(model(s), 'BT1', 'left') if ok else None
    check(f'M11 {style}: BT1 pinned to the left edge 15 mm down stays there; nothing outside or overlapping, all routed',
          ok and got[:2] == (board.BOARD_MARGIN, 15.0) and not s['outside'] and not s['overlaps'] and not s.get('unrouted')
          and s['mech']['fixed'] == ['BT1'],
          json.dumps({k: s.get(k) for k in ('outside', 'overlaps', 'unrouted', 'refused')}, ensure_ascii=False)[:200] + f' {got}')
two = {'width': 40, 'height': 30, 'holes': FOUR,
       'fixed': [{'ref': 'BT1', 'side': 'bottom', 'at': 20, 'rot': 90}, {'ref': 'D1', 'side': 'top', 'at': 12.5}]}
s, _ = run('pin_two', two)
ok = 'refused' not in s
m = model(s) if ok else {}
got = (pinned_at(m, 'BT1', 'bottom'), pinned_at(m, 'D1', 'top')) if ok else None
check('M12 a given rotation is kept (BT1 at 90° on the bottom edge) and a part that is not a connector can be pinned (D1 on top)',
      ok and got[0] == (board.BOARD_MARGIN, 20.0, 90) and got[1][:2] == (board.BOARD_MARGIN, 12.5) and not s['overlaps']
      and not s['outside'] and not s.get('unrouted'), f'{got} {s.get("refused", "")[:120]}')

# M13: pinned onto a hole is refused with the range that fits, and both ends of that range do fit
s, _ = run('pin_hole', {**LEFT, 'fixed': [{'ref': 'BT1', 'side': 'left', 'at': 5}]})
said = re.search(r'위에서 ([\d.]+)~([\d.]+) mm 사이로', s.get('refused', ''))
ends = []
for v in (said.groups() if said else ()):
    e, _ = run(f'pin_end_{v}', {**LEFT, 'fixed': [{'ref': 'BT1', 'side': 'left', 'at': float(v)}]})
    ends.append('refused' not in e and not e['overlaps'])
check('M13 a pinned spot on a hole is refused with the range that fits, and both ends of it fit',
      bool(said) and ends == [True, True], f"{s.get('refused', '')[:160]} ends {ends}")

# M14: a part not in the circuit, or pinned twice, is refused
s, _ = run('pin_none', {**LEFT, 'fixed': [{'ref': 'J9', 'side': 'left', 'at': 15}]})
s2, _ = run('pin_twice', {**LEFT, 'fixed': LEFT['fixed'] * 2})
check('M14 a part not in the circuit is refused naming its connectors; one pinned twice is refused',
      '고정할 부품(J9)이 회로에 없습니다' in s.get('refused', '') and 'BT1' in s.get('refused', '') and '두 번' in s2.get('refused', ''),
      f"{s.get('refused', '')[:100]} | {s2.get('refused', '')[:80]}")

# M15: a reroute keeps a pinned part: the same pose is drawn, a move of it is refused
s, _ = run('pin_again', LEFT)
m = model(s)
poses = {p['ref']: [p['x'], p['y'], p['rot']] for p in m['parts'] if p['part'] != 'MountingHole'}
same, _ = run('pin_fixed', LEFT, placer='fixed', parts=poses)
bt = poses['BT1']
moved, _ = run('pin_moved', LEFT, placer='fixed', parts=dict(poses, BT1=[bt[0], bt[1] + 1, bt[2]]))
check('M15 a fixed-placer reroute keeps the pinned BT1; moving it is refused',
      'refused' not in same and pinned_at(model(same), 'BT1', 'left')[:2] == (board.BOARD_MARGIN, 15.0)
      and '옮기거나 돌릴 수 없습니다' in moved.get('refused', ''), moved.get('refused', '')[:120])

# M10: KiCad's DRC on the SMD enclosure board: no violation, nothing unconnected
cli = os.environ.get('KICAD_CLI_PATH') or os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'KiCad', '10.0', 'bin', 'kicad-cli.exe')
cli = cli if os.path.exists(cli) else 'kicad-cli'


def drc(name, board_name):
    report = os.path.join(OUT, f'drc_{board_name}.json')
    try:
        subprocess.run([cli, 'pcb', 'drc', '--format', 'json', '--severity-all', '-o', report,
                        os.path.join(OUT, f'{board_name}.kicad_pcb')], capture_output=True, timeout=180)
        with open(report, encoding='utf-8') as f:
            d = json.load(f)
        errors = [v for v in d.get('violations', []) if v.get('severity') == 'error']
        check(f'{name}: no error, nothing unconnected', not errors and not d.get('unconnected_items'),
              f"{len(errors)} errors {[v['type'] for v in errors][:5]}, {len(d.get('unconnected_items', []))} unconnected")
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        check(name, False, f'DRC did not run: {e}')


drc('M10 KiCad DRC on the 40 x 30 mm SMD board', 'fit_smd')
for style in ('smd', 'tht'):
    drc(f'M16 KiCad DRC on the {style.upper()} board with BT1 pinned', f'pin_{style}')
drc('M16 KiCad DRC on the board with BT1 and D1 pinned', 'pin_two')

print(f'\n{failed} check(s) failed' if failed else '\nALL PASS')
sys.exit(1 if failed else 0)
