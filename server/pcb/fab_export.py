"""
Fabrication files for a finished board: the gerbers and drill files a PCB maker takes, and one zip of them.

The layer set and drill format follow JLCPCB's KiCad guide for two-layer boards (read 2026-10-29,
https://jlcpcb.com/help/article/how-to-generate-gerber-and-drill-files-in-kicad-9): seven layers, plated
and non-plated holes in separate Excellon files. Paste layers are for stencil and assembly orders only.
Zones are filled before plotting (--check-zones): without it the ground pour drawn on screen was missing
from the copper gerbers. The gerber job file is left out of the zip, the guide does not list it.

Usage: python fab_export.py <board.kicad_pcb> <out_dir> [--cli kicad-cli]   -> prints {"files": [...], "zip": name}
"""
import argparse, json, os, signal, subprocess, sys, zipfile

FAB_LAYERS = ['F.Cu', 'B.Cu', 'F.Mask', 'B.Mask', 'F.Silkscreen', 'B.Silkscreen', 'Edge.Cuts']
# what each layer is called on disk (KiCad's Protel extensions), in FAB_LAYERS order
FAB_SUFFIXES = ['-F_Cu.gtl', '-B_Cu.gbl', '-F_Mask.gts', '-B_Mask.gbs', '-F_Silkscreen.gto', '-B_Silkscreen.gbo',
                '-Edge_Cuts.gm1', '-PTH.drl', '-NPTH.drl']


def _run(cmd, timeout):
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode('utf-8', 'replace').strip()[-400:] or f'{cmd[1:4]} failed')


def export_fab(cli, pcb, out_dir, timeout=60):
    """Write the fabrication files into out_dir (emptied first) and out_dir/<board>-gerber.zip."""
    os.makedirs(out_dir, exist_ok=True)
    # a second export must not leave files of an older run (another layer set) beside the new ones
    for f in os.listdir(out_dir):
        if os.path.isfile(os.path.join(out_dir, f)):
            os.remove(os.path.join(out_dir, f))
    out = out_dir.rstrip('/\\') + os.sep
    _run([cli, 'pcb', 'export', 'gerbers', '-l', ','.join(FAB_LAYERS), '--check-zones', '-o', out, pcb], timeout)
    _run([cli, 'pcb', 'export', 'drill', '--excellon-separate-th', '-o', out, pcb], timeout)
    files = sorted(f for f in os.listdir(out_dir) if f.endswith(tuple(FAB_SUFFIXES)))
    missing = [s for s in FAB_SUFFIXES if not any(f.endswith(s) for f in files)]
    if missing:
        raise RuntimeError(f'kicad-cli did not write {missing}')
    name = os.path.splitext(os.path.basename(pcb))[0] + '-gerber.zip'
    with zipfile.ZipFile(os.path.join(out_dir, name), 'w', zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(os.path.join(out_dir, f), arcname=f)
    return {'files': files, 'zip': name}


if __name__ == '__main__':
    # the server stops a hung export with SIGTERM: leave through Python, so subprocess.run kills the
    # kicad-cli it is waiting on instead of leaving it running without a time limit
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    ap = argparse.ArgumentParser()
    ap.add_argument('pcb')
    ap.add_argument('out_dir')
    ap.add_argument('--cli', default='kicad-cli')
    a = ap.parse_args()
    try:
        print(json.dumps(export_fab(a.cli, a.pcb, a.out_dir)))
    except Exception as e:  # the server shows this sentence
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
