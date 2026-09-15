"""
Stage-4 checks: fixed placement and the AI improvement loop.

The loop itself lives in the Node server, so this script talks to a server started
with SF_AI_STUB=1 (a deterministic stand-in for the model: round 1 widens GND,
round 2 moves a part far off the board, round 3 stops).

Usage: python check_ai_loop.py [--port 8098]
Exit code 0 only if every check passes.
"""
import argparse, json, os, subprocess, sys, tempfile, shutil, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from board import generate  # noqa: E402


def sse_post(url, body, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    events = []
    with urllib.request.urlopen(req, timeout=timeout) as r:
        name = None
        for raw in r:
            line = raw.decode('utf-8').rstrip('\n')
            if line.startswith('event: '):
                name = line[7:]
            elif line.startswith('data: ') and name:
                events.append((name, json.loads(line[6:])))
                name = None
    return events


def check_fixed_placement(work):
    """20. re-running with the produced positions reproduces the same board."""
    shutil.copy(os.path.join(SERVER, 'test_circuits', 'ne555_blink.py'), work)
    subprocess.run([sys.executable, 'ne555_blink.py'], cwd=work, check=True, capture_output=True)
    net = os.path.join(work, 'ne555_blink.net')
    a = generate(net, os.path.join(work, 'fx_a.kicad_pcb'), 'smd')
    ja = json.load(open(os.path.join(work, 'fx_a.board.json'), encoding='utf-8'))
    ov = {'parts': {p['ref']: [p['x'], p['y'], p['rot']] for p in ja['parts']}, 'net_width': {'GND': 0.8}}
    b = generate(net, os.path.join(work, 'fx_b.kicad_pcb'), 'smd', placer='fixed', overrides=ov)
    jb = json.load(open(os.path.join(work, 'fx_b.board.json'), encoding='utf-8'))
    same = all(abs(p['x'] - q['x']) < 1e-6 and abs(p['y'] - q['y']) < 1e-6 and p['rot'] == q['rot']
               for p, q in zip(ja['parts'], jb['parts']))
    widths = {t['width'] for t in jb['tracks'] if t['net'] == 'GND'}
    ok = same and not b['unrouted'] and widths == {0.8} and not b['overlaps'] and not b['outside']
    return ok, f'same positions={same} GND widths={sorted(widths)} unrouted={len(b["unrouted"])}'


def check_loop(port):
    """21-23. the stub loop: good round kept, bad round rolled back, stream well formed."""
    src = os.path.join(SERVER, 'outputs', 'stage0_ne555.net')
    dst = os.path.join(SERVER, 'outputs', 'ai_check.net')
    shutil.copy(src, dst)
    events = sse_post(f'http://localhost:{port}/generate_pcb_stream',
                      {'filename': 'ai_check.net', 'style': 'smd', 'ai': True})
    kinds = [k for k, _ in events]
    rounds = [d for k, d in events if k == 'ai']
    done = [d for k, d in events if k == 'done'][-1]
    board = json.load(open(os.path.join(SERVER, 'outputs', 'ai_check.board.json'), encoding='utf-8'))

    res = {}
    # A bad move is rolled back either after rerouting (numbers got worse) or before it,
    # by the courtyard/outline precheck (note says so, no `after`).
    bad = [r for r in rounds if not r['kept'] and not r['actions'].get('stop')]
    res['21 bad round rolled back'] = (
        any((r.get('after') and r['after']['hpwl'] > r['before']['hpwl']) or '사전 검사' in (r.get('note') or '')
            for r in bad)
        and max(p['x'] for p in board['parts']) < board['outline'][2],
        f'rounds kept={[r["kept"] for r in rounds]} notes={[r.get("note") for r in bad]}')
    gnd = {t['width'] for t in board['tracks'] if t['net'] == 'GND'}
    res['22 good round kept'] = (
        any(r['kept'] for r in rounds) and gnd == {0.8} and done['summary']['net_width'].get('GND') == 0.8,
        f'GND widths={sorted(gnd)} net_width={done["summary"]["net_width"]}')
    res['23 stream shape'] = (
        kinds.count('ai') == len(rounds) and kinds.index('ai') < len(kinds) - 1 and kinds[-1] == 'done'
        and all('before' in r for r in rounds),
        f'{len(rounds)} ai events, order ok')
    res['24 board still clean'] = (
        not done['summary']['unrouted'] and not done['summary']['overlaps'] and
        (done.get('drc') or {}).get('errors', 0) == 0,
        f'unrouted={len(done["summary"]["unrouted"])} drc={done.get("drc", {}).get("errors")}')
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8098)
    ap.add_argument('--skip-loop', action='store_true', help='only the generator-side check')
    args = ap.parse_args()
    work = tempfile.mkdtemp(prefix='sf_ai_')
    all_ok = True

    ok, info = check_fixed_placement(work)
    all_ok &= ok
    print(f'{"ok  " if ok else "FAIL"} 20 fixed placement  {info}')

    if not args.skip_loop:
        try:
            for name, (passed, info) in check_loop(args.port).items():
                all_ok &= passed
                print(f'{"ok  " if passed else "FAIL"} {name}  {info}')
        except Exception as e:
            all_ok = False
            print(f'FAIL loop checks  {e} (is the stub server running on {args.port}? '
                  f'SF_AI_STUB=1 PORT={args.port} npx tsx index.ts)')

    print('ALL PASS' if all_ok else 'SOME CHECKS FAILED')
    sys.exit(0 if all_ok else 1)


if __name__ == '__main__':
    main()
