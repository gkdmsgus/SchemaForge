"""
SchemaForge PCB Generator
Reads a KiCad netlist (.net) and writes a KiCad 10 .kicad_pcb with real
library footprints, nets on every pad, and a board outline — plus a
<name>.board.json model for the browser. No KiCad installation required.

Usage: python pcb_generator.py <input.net> <output.kicad_pcb> [--style smd|tht]
The last stdout line is a JSON summary (components, nets, unmapped, warnings, board size).
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pcb'))
from board import generate  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('net')
    ap.add_argument('pcb')
    ap.add_argument('--style', choices=['smd', 'tht'], default='smd')
    args = ap.parse_args()
    summary = generate(args.net, args.pcb, args.style)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
