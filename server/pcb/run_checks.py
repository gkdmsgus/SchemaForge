"""
Stage-0 checks: every test circuit x {smd, tht} must produce a real board.

Usage: python run_checks.py [--keep DIR]
Needs skidl (pip) and kicad-cli (env KICAD_CLI_PATH, PATH, or the default
per-user KiCad 10 install). Exit code 0 only if every check passes.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from board import generate, parse_netlist  # noqa: E402
from footprints_table import TABLE, KNOWN_UNMAPPED, MAX_HEADER_PINS  # noqa: E402
from sexpr import parse, find, find_all  # noqa: E402

CIRCUITS = ['led_basic', 'ne555_blink', 'npn_relay']
STYLES = ['smd', 'tht']
# (part, skidl pin that must sit on KiCad pad "1") — polarity checks
POLARITY = {'LED': '2', 'D': '2', 'CP': '1', 'Battery': '1', 'Buzzer': '1'}


def kicad_cli():
    env = os.environ.get('KICAD_CLI_PATH')
    if env:
        return env
    found = shutil.which('kicad-cli')
    if found:
        return found
    return os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'KiCad', '10.0', 'bin', 'kicad-cli.exe')


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
    pad_net = {(r, n): net for r, n, net in pads if net}
    bad = []
    for n in nets:
        for nd in n['nodes']:
            lib_fp = TABLE[(comp_part[nd['ref']], style)]
            pad = lib_fp[2][int(nd['pin'])]
            if pad_net.get((nd['ref'], pad)) != n['name']:
                bad.append(f"{nd['ref']}.{nd['pin']}")
    nodes = sum(len(n['nodes']) for n in nets)
    distinct = len({(r, n) for r, n, net in pads if net})
    res['2 nodes->pads'] = (not bad and distinct == nodes, f'nodes={nodes} pads={distinct} bad={bad}')

    # 3. polarity: the stated skidl pin is on KiCad pad "1"
    pol_bad = []
    node_net = {(nd['ref'], nd['pin']): n['name'] for n in nets for nd in n['nodes']}
    for ref, part in comp_part.items():
        if part in POLARITY:
            want = node_net.get((ref, POLARITY[part]))
            if pad_net.get((ref, '1')) != want:
                pol_bad.append(ref)
    res['3 polarity'] = (not pol_bad, str(pol_bad or ''))

    # 4. courtyards: no overlap, all inside the outline
    boxes = [p['courtyard'] for p in parts.values()]
    ox1, oy1, ox2, oy2 = model['outline']
    overlap = [(a, b) for i, a in enumerate(parts) for b in list(parts)[i + 1:]
               if _overlap(parts[a]['courtyard'], parts[b]['courtyard'])]
    outside = [r for r, p in parts.items()
               if not (p['courtyard'][0] >= ox1 and p['courtyard'][1] >= oy1 and
                       p['courtyard'][2] <= ox2 and p['courtyard'][3] <= oy2)]
    res['4 courtyard'] = (not overlap and not outside, f'overlap={overlap} outside={outside}')

    # 5. KiCad DRC: loads, 0 violations, unconnected = connections still to route
    drc = os.path.join(work, f'{name}_{style}.drc.json')
    p = subprocess.run([cli, 'pcb', 'drc', '--format', 'json', '--output', drc, pcb], capture_output=True)
    if p.returncode != 0 or not os.path.exists(drc):
        res['5 drc'] = (False, p.stderr.decode('utf-8', 'replace')[-200:])
        unconn = viol = None
    else:
        d = json.load(open(drc, encoding='utf-8'))
        unconn = len(d['unconnected_items'])
        viol = [v['type'] for v in d['violations']]
        expected = sum(len(n['nodes']) - 1 for n in nets if len(n['nodes']) > 1)
        res['5 drc'] = (not viol and unconn == expected and unconn > 0,
                        f'violations={viol} unconnected={unconn} expected={expected}')

    # 6. gerbers + drill export
    gdir = os.path.join(work, f'{name}_{style}_gerber')
    os.makedirs(gdir, exist_ok=True)
    g = subprocess.run([cli, 'pcb', 'export', 'gerbers', '--output', gdir, pcb], capture_output=True)
    dr = subprocess.run([cli, 'pcb', 'export', 'drill', '--output', gdir + os.sep, pcb], capture_output=True)
    files = os.listdir(gdir)
    res['6 gerber'] = (g.returncode == 0 and dr.returncode == 0 and any(f.endswith('.drl') for f in files),
                       f'{len(files)} files')

    return res, summary, unconn


def _overlap(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


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
    t_ok, t_info = check_templates()
    all_ok &= t_ok
    print(f'== templates {"PASS" if t_ok else "FAIL"}  {t_info}')
    print(f'\nboards in {work_root}')
    print('ALL PASS' if all_ok else 'SOME CHECKS FAILED')
    sys.exit(0 if all_ok else 1)


if __name__ == '__main__':
    main()
