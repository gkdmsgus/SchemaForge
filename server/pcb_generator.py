"""
SchemaForge PCB Generator
Reads a KiCad netlist (.net) and writes a KiCad 10 .kicad_pcb with real
library footprints, nets on every pad, force-directed placement and a board
outline — plus a <name>.board.json model for the browser. No KiCad needed.

Usage: python pcb_generator.py <input.net> <output.kicad_pcb>
                               [--style smd|tht] [--placer force|shelf] [--stream]
Without --stream the last stdout line is a JSON summary.
With --stream every stdout line is a JSON event:
  {"type":"parts", "parts":[...local geometry...], "nets":[...]}
  {"type":"init", "frame":[x1,y1,x2,y2], "iterations":N}
  {"type":"frame", "iter":i, "phase":"force|legalize|refine", "hpwl":h, "parts":{ref:[x,y,rot]}}
  {"type":"done", "summary":{...}, "board":{...board.json...}}
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pcb'))
import board  # noqa: E402


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + '\n')
    sys.stdout.flush()


# Korean messages travel through stdout; never let the console codepage mangle them.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('net')
    ap.add_argument('pcb')
    ap.add_argument('--style', choices=['smd', 'tht'], default='smd')
    ap.add_argument('--placer', choices=['force', 'shelf', 'fixed'], default='force')
    ap.add_argument('--overrides', help='JSON file: {"parts": {ref: [x, y, rot]}, "net_width": {net: mm}}')
    ap.add_argument('--stream', action='store_true')
    args = ap.parse_args()

    overrides = None
    if args.overrides:
        with open(args.overrides, encoding='utf-8') as f:
            overrides = json.load(f)

    summary = board.generate(args.net, args.pcb, args.style, args.placer,
                             on_event=emit if args.stream else None, overrides=overrides)
    if args.stream:
        json_path = os.path.join(os.path.dirname(os.path.abspath(args.pcb)), summary['boardJson'])
        with open(json_path, encoding='utf-8') as f:
            emit({'type': 'done', 'summary': summary, 'board': json.load(f)})
    else:
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
