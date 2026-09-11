"""
Copy the footprints used by footprints_table.py from a KiCad install into
server/pcb/footprints/<lib>.pretty/<name>.kicad_mod.

Usage: python vendor_footprints.py [KICAD_SHARE_DIR]
Default share dir: %LOCALAPPDATA%/Programs/KiCad/10.0/share/kicad
"""
import os, sys, shutil
from footprints_table import all_footprints

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, 'footprints')


def main():
    share = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get('LOCALAPPDATA', ''), 'Programs', 'KiCad', '10.0', 'share', 'kicad')
    src_root = os.path.join(share, 'footprints')
    missing = []
    for lib, fp in all_footprints():
        src = os.path.join(src_root, lib + '.pretty', fp + '.kicad_mod')
        if not os.path.exists(src):
            missing.append(f'{lib}:{fp}')
            continue
        dst_dir = os.path.join(DEST, lib + '.pretty')
        os.makedirs(dst_dir, exist_ok=True)
        shutil.copyfile(src, os.path.join(dst_dir, fp + '.kicad_mod'))
    print(f'copied {len(all_footprints()) - len(missing)} footprints')
    if missing:
        print('MISSING:', ', '.join(missing))
        sys.exit(1)


if __name__ == '__main__':
    main()
