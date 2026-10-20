"""
Copy the footprints used by footprints_table.py from a KiCad install into
server/pcb/footprints/<lib>.pretty/<name>.kicad_mod, and the 3D models those
footprints point at into server/pcb/3dmodels/<lib>.3dshapes/<name>.step.

The deploy image has no 3D model library (the KiCad image leaves it out), so its
3D view showed bare boards; the Dockerfile points KICAD10_3DMODEL_DIR at the copy.
Only .step is copied: the GLB and STEP exports read STEP, not the .wrl render models.

Usage: python vendor_footprints.py [KICAD_SHARE_DIR]
Default share dir: %LOCALAPPDATA%/Programs/KiCad/10.0/share/kicad
"""
import os, re, sys, shutil
from footprints_table import all_footprints

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, 'footprints')
MODELS_DEST = os.path.join(HERE, '3dmodels')
MODEL_RE = re.compile(r'\(model\s+"?\$\{KICAD\d*_3DMODEL_DIR\}/([^"\s)]+)"?')


def model_paths(kicad_mod_text):
    """The 3D model files a footprint points at, relative to the model library ("Lib.3dshapes/X.step")."""
    return [os.path.splitext(m)[0] + '.step' for m in MODEL_RE.findall(kicad_mod_text)]


def main():
    share = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get('LOCALAPPDATA', ''), 'Programs', 'KiCad', '10.0', 'share', 'kicad')
    src_root = os.path.join(share, 'footprints')
    missing, models = [], set()
    for lib, fp in all_footprints():
        src = os.path.join(src_root, lib + '.pretty', fp + '.kicad_mod')
        if not os.path.exists(src):
            missing.append(f'{lib}:{fp}')
            continue
        dst_dir = os.path.join(DEST, lib + '.pretty')
        os.makedirs(dst_dir, exist_ok=True)
        shutil.copyfile(src, os.path.join(dst_dir, fp + '.kicad_mod'))
        with open(src, encoding='utf-8') as f:
            models.update(model_paths(f.read()))
    for rel in sorted(models):
        src = os.path.join(share, '3dmodels', rel)
        if not os.path.exists(src):
            missing.append(rel)
            continue
        os.makedirs(os.path.join(MODELS_DEST, os.path.dirname(rel)), exist_ok=True)
        shutil.copyfile(src, os.path.join(MODELS_DEST, rel))
    print(f'copied {len(all_footprints())} footprints and {len(models)} 3D models (minus missing)')
    if missing:
        print('MISSING:', ', '.join(missing))
        sys.exit(1)


if __name__ == '__main__':
    main()
