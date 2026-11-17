"""
Checks P1-P3 on the part templates added from 2026-11-17 (Fuse first; RS-485, HX711 and A4988 follow): each one in a small
circuit is placed and routed in both styles with every pin on a pad of the footprint the table names (nothing unmapped),
its pads carry the nets the template's pins were given, and KiCad's DRC finds no error on the board.

Usage: python server/pcb/check_new_parts.py   → exit 0 only if every check passes
"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import board  # noqa: E402
from footprints_table import TABLE  # noqa: E402

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

OUT = tempfile.mkdtemp(prefix='sf_parts_')
failed = 0


def check(name, ok, info=''):
    global failed
    if not ok:
        failed += 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}  {info}")


def netlist(parts, nets):
    """a KiCad netlist as skidl writes one: parts [(ref, part, value)], nets {name: ['REF.pin', ...]}"""
    comps = ''.join(f'(comp (ref "{r}") (value "{v}") (libsource (lib "NO_LIB") (part "{p}")))' for r, p, v in parts)
    ns = ''.join(f'(net (code "{i}") (name "{n}") ' + ''.join(f'(node (ref "{x.split(".")[0]}") (pin "{x.split(".")[1]}"))' for x in pins) + ')'
                 for i, (n, pins) in enumerate(nets.items(), 1))
    return f'(export (version "D") (components {comps}) (nets {ns}))'


CLI = os.environ.get('KICAD_CLI_PATH') or os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'KiCad', '10.0', 'bin', 'kicad-cli.exe')
CLI = CLI if os.path.exists(CLI) else 'kicad-cli'


def drc_errors(pcb):
    report = pcb + '.drc.json'
    try:
        subprocess.run([CLI, 'pcb', 'drc', '--format', 'json', '--severity-all', '-o', report, pcb], capture_output=True, timeout=180)
        with open(report, encoding='utf-8') as f:
            d = json.load(f)
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        return [f'DRC did not run: {e}']
    return [v['type'] for v in d.get('violations', []) if v.get('severity') == 'error'] + [f"unconnected x{len(d.get('unconnected_items', []))}"] * bool(d.get('unconnected_items'))


def board_of(name, parts, nets, style):
    net = os.path.join(OUT, f'{name}_{style}.net')
    with open(net, 'w', encoding='utf-8') as f:
        f.write(netlist(parts, nets))
    pcb = os.path.join(OUT, f'{name}_{style}.kicad_pcb')
    s = board.generate(net, pcb, style)
    with open(os.path.join(OUT, s['boardJson']), encoding='utf-8') as f:
        return s, json.load(f), pcb


def part_case(code, ref, part, value, pins_nets, extra_parts, extra_nets):
    """the part's own pins on the nets named, in both styles: mapped, its pads on those nets, DRC clean"""
    for style in ('smd', 'tht'):
        nets = {}
        for pin, n in pins_nets.items():
            nets.setdefault(n, []).append(f'{ref}.{pin}')
        for n, pins in extra_nets.items():
            nets.setdefault(n, []).extend(pins)
        s, m, pcb = board_of(f'{part}', [(ref, part, value)] + extra_parts, nets, style)
        lib, fp, pinmap = TABLE[(part, style)]
        p = next(x for x in m['parts'] if x['ref'] == ref)
        pads = {pad['num']: pad['net'] for pad in p['pads']}
        wrong = [f'{pin}->{pinmap[int(pin)]}:{pads.get(pinmap[int(pin)])}!={n}' for pin, n in pins_nets.items() if pads.get(pinmap[int(pin)]) != n]
        errs = drc_errors(pcb)
        check(f'{code} {part} {style}: {lib}:{fp}, every pin on its pad and net, routed, DRC clean',
              not s['unmapped'] and p['footprint'] == f'{lib}:{fp}' and not wrong and not s.get('unrouted') and not errs,
              f"unmapped {s['unmapped']} wrong {wrong[:3]} unrouted {s.get('unrouted')} drc {errs[:4]}")


# P1 a fuse after a battery's +, an LED and its resistor behind it
part_case('P1', 'F1', 'Fuse', '500mA', {'1': 'VBAT', '2': 'VCC'},
          [('BT1', 'Battery', '9V'), ('R1', 'R', '680'), ('D1', 'LED', 'RED')],
          {'VBAT': ['BT1.1'], 'VCC': ['R1.1'], 'LA': ['R1.2', 'D1.1'], 'GND': ['D1.2', 'BT1.2']})

print(f'\n{failed} check(s) failed' if failed else '\nALL PASS')
sys.exit(1 if failed else 0)
