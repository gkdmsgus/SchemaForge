"""
Read pad positions the way KiCad computes them, via `kicad-cli pcb export ipcd356`.
Used by run_checks.py to prove our rotation math matches KiCad.

IPC-D-356 records (317 through-hole, 327 SMD) carry ref, pin and the pad
centre in 0.0001 inch with y pointing up.
"""
import os, re, subprocess, tempfile

REC = re.compile(r'^3[12]7(?P<net>.{14})\s*(?P<ref>\S+)\s+-(?P<pin>\S+).*?'
                 r'X(?P<x>[+-]\d{6})Y(?P<y>[+-]\d{6})X\d{4}Y\d{4}R(?P<rot>\d{3})')


def kicad_pad_positions(cli, pcb_path):
    """{(ref, pad): (x_mm, y_mm, rotation_deg)} as computed by KiCad."""
    out_path = os.path.join(tempfile.mkdtemp(prefix='sf_d356_'), 'board.d356')
    subprocess.run([cli, 'pcb', 'export', 'ipcd356', '--output', out_path, pcb_path],
                   check=True, capture_output=True)
    pads = {}
    with open(out_path, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = REC.match(line)
            if not m:
                continue
            x = int(m['x']) * 0.0001 * 25.4
            y = -int(m['y']) * 0.0001 * 25.4
            pads[(m['ref'], m['pin'])] = (x, y, int(m['rot']))
    return pads
