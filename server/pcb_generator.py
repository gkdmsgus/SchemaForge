"""
SchemaForge PCB Generator
Reads a KiCad netlist (.net) and generates a .kicad_pcb file
with auto-placed components and board outline.
No KiCad installation required — writes the S-expression format directly.

Usage: python pcb_generator.py <input.net> <output.kicad_pcb>
"""
import sys, re, math

# ── Default footprint mapping ─────────────────────────────────────
FOOTPRINT_MAP = {
    'R':   ('Resistor_SMD', 'R_0805_2012Metric', 2, (2.0, 1.3)),
    'C':   ('Capacitor_SMD', 'C_0805_2012Metric', 2, (2.0, 1.3)),
    'L':   ('Inductor_SMD', 'L_0805_2012Metric', 2, (2.0, 1.3)),
    'D':   ('LED_SMD', 'LED_0805_2012Metric', 2, (2.0, 1.3)),
    'Q':   ('Package_TO_SOT_SMD', 'SOT-23', 3, (3.0, 2.5)),
    'U':   ('Package_SO', 'SOIC-8_3.9x4.9mm_P1.27mm', 8, (6.0, 5.0)),
    'SW':  ('Button_Switch_SMD', 'SW_SPST_TactSwitch', 2, (3.0, 3.0)),
    'K':   ('Relay_SMD', 'Relay_SPDT', 5, (8.0, 6.0)),
    'LS':  ('Buzzer_Beeper', 'Buzzer_12x9.5RM7.6', 2, (12.0, 10.0)),
    'BT':  ('Battery', 'BatteryHolder_Keystone_3000', 2, (6.0, 4.0)),
    'J':   ('Connector_PinHeader_2.54mm', 'PinHeader_1x02_P2.54mm', 2, (2.54, 5.0)),
    'Y':   ('Crystal', 'Crystal_HC49-U_Vertical', 2, (5.0, 3.0)),
}
DEFAULT_FP = ('Package_SO', 'SOIC-8_3.9x4.9mm_P1.27mm', 8, (6.0, 5.0))


# ── Parse .net file ───────────────────────────────────────────────
def parse_netlist(text):
    components = []
    comp_re = re.compile(r'\(comp\s*\(ref\s+"([^"]+)"\)\s*\(value\s+"([^"]*)"\)')
    for m in comp_re.finditer(text):
        components.append({'ref': m.group(1), 'value': m.group(2)})

    nets = []
    net_section = re.search(r'\(nets[\s\S]*$', text)
    if net_section:
        section = net_section.group(0)
        net_starts = list(re.finditer(
            r'\(net\s*\n?\s*\(code\s+(\d+)\)\s*\n?\s*\(name\s+"([^"]+)"\)', section))
        for i, nm in enumerate(net_starts):
            start = nm.start()
            end = net_starts[i+1].start() if i+1 < len(net_starts) else len(section)
            block = section[start:end]
            nodes = []
            for node_m in re.finditer(
                r'\(node\s*\n?\s*\(ref\s+"([^"]+)"\)\s*\n?\s*\(pin\s+"([^"]+)"\)', block):
                nodes.append({'ref': node_m.group(1), 'pin': node_m.group(2)})
            if nodes:
                nets.append({'name': nm.group(2), 'nodes': nodes})
    return components, nets


# ── Auto-place components ─────────────────────────────────────────
def auto_place(components, nets):
    """Simple grid-based placement with connected components nearby."""
    # Build adjacency from nets
    adj = {}
    for n in nets:
        refs = list(set(node['ref'] for node in n['nodes']))
        for r in refs:
            adj.setdefault(r, set())
            for r2 in refs:
                if r != r2:
                    adj[r].add(r2)

    placed = {}
    remaining = [c['ref'] for c in components]

    # Place using BFS from most-connected component
    remaining.sort(key=lambda r: len(adj.get(r, set())), reverse=True)

    cols = max(3, int(math.ceil(math.sqrt(len(remaining)))))
    spacing_x, spacing_y = 15.0, 12.0
    start_x, start_y = 25.0, 25.0

    # Simple BFS ordering
    ordered = []
    visited = set()
    queue = list(remaining)
    while queue:
        ref = queue.pop(0)
        if ref in visited:
            continue
        visited.add(ref)
        ordered.append(ref)
        for neighbor in sorted(adj.get(ref, set())):
            if neighbor not in visited:
                queue.insert(0, neighbor)

    for i, ref in enumerate(ordered):
        col = i % cols
        row = i // cols
        x = start_x + col * spacing_x
        y = start_y + row * spacing_y
        placed[ref] = (x, y)

    return placed


# ── Generate pad S-expression ─────────────────────────────────────
def gen_pad(num, name, x, y, pad_type='smd', shape='rect', size=(1.0, 0.8)):
    layers = '"F.Cu" "F.Paste" "F.Mask"' if pad_type == 'smd' else '"*.Cu" "*.Mask"'
    return f'''    (pad "{num}" {pad_type} {shape}
      (at {x:.3f} {y:.3f})
      (size {size[0]:.3f} {size[1]:.3f})
      (layers {layers})
    )'''


# ── Generate footprint S-expression ──────────────────────────────
def gen_footprint(ref, value, x, y, fp_info):
    lib, name, pin_count, (fw, fh) = fp_info
    fp_full = f"{lib}:{name}"

    # Generate pads in a line or dual-row
    pads = []
    if pin_count <= 3:
        # Single row
        pitch = 1.27
        start = -(pin_count - 1) * pitch / 2
        for i in range(pin_count):
            px = start + i * pitch
            pads.append(gen_pad(i+1, f"p{i+1}", px, 0))
    else:
        # Dual row (like SOIC)
        half = pin_count // 2
        pitch = 1.27
        start_y = -(half - 1) * pitch / 2
        for i in range(half):
            py = start_y + i * pitch
            pads.append(gen_pad(i+1, f"p{i+1}", -fw/2 + 0.5, py))
        for i in range(half):
            py = start_y + (half - 1 - i) * pitch
            pads.append(gen_pad(half + i + 1, f"p{half+i+1}", fw/2 - 0.5, py))

    pads_str = '\n'.join(pads)

    return f'''  (footprint "{fp_full}"
    (layer "F.Cu")
    (at {x:.3f} {y:.3f})
    (property "Reference" "{ref}"
      (at 0 {-fh/2 - 1.5:.3f})
      (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "{value}"
      (at 0 {fh/2 + 1.5:.3f})
      (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (fp_line (start {-fw/2:.3f} {-fh/2:.3f}) (end {fw/2:.3f} {-fh/2:.3f})
      (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
    (fp_line (start {fw/2:.3f} {-fh/2:.3f}) (end {fw/2:.3f} {fh/2:.3f})
      (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
    (fp_line (start {fw/2:.3f} {fh/2:.3f}) (end {-fw/2:.3f} {fh/2:.3f})
      (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
    (fp_line (start {-fw/2:.3f} {fh/2:.3f}) (end {-fw/2:.3f} {-fh/2:.3f})
      (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
{pads_str}
  )'''


# ── Generate board outline ────────────────────────────────────────
def gen_board_outline(positions, margin=10.0):
    if not positions:
        return 0, 0, 60, 40
    xs = [p[0] for p in positions.values()]
    ys = [p[1] for p in positions.values()]
    x1 = min(xs) - margin
    y1 = min(ys) - margin
    x2 = max(xs) + margin
    y2 = max(ys) + margin
    return x1, y1, x2, y2


# ── Main: generate .kicad_pcb ────────────────────────────────────
def generate_pcb(net_path, pcb_path):
    with open(net_path, 'r', encoding='utf-8') as f:
        net_text = f.read()

    components, nets = parse_netlist(net_text)
    positions = auto_place(components, nets)

    # Build footprints
    footprints = []
    for comp in components:
        ref = comp['ref']
        prefix = re.sub(r'\d+', '', ref)
        fp_info = FOOTPRINT_MAP.get(prefix, DEFAULT_FP)
        x, y = positions.get(ref, (30, 30))
        footprints.append(gen_footprint(ref, comp['value'], x, y, fp_info))

    footprints_str = '\n'.join(footprints)

    # Build nets
    net_defs = '  (net 0 "")\n'
    for i, n in enumerate(nets, 1):
        net_defs += f'  (net {i} "{n["name"]}")\n'

    # Board outline
    x1, y1, x2, y2 = gen_board_outline(positions)
    outline = f'''  (gr_line (start {x1:.3f} {y1:.3f}) (end {x2:.3f} {y1:.3f})
    (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))
  (gr_line (start {x2:.3f} {y1:.3f}) (end {x2:.3f} {y2:.3f})
    (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))
  (gr_line (start {x2:.3f} {y2:.3f}) (end {x1:.3f} {y2:.3f})
    (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))
  (gr_line (start {x1:.3f} {y2:.3f}) (end {x1:.3f} {y1:.3f})
    (stroke (width 0.05) (type solid)) (layer "Edge.Cuts"))'''

    pcb_content = f'''(kicad_pcb
  (version 20240108)
  (generator "SchemaForge")
  (general
    (thickness 1.6)
  )
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (32 "B.Adhes" user "B.Adhesive")
    (33 "F.Adhes" user "F.Adhesive")
    (34 "B.Paste" user)
    (35 "F.Paste" user)
    (36 "B.SilkS" user "B.Silkscreen")
    (37 "F.SilkS" user "F.Silkscreen")
    (38 "B.Mask" user "B.Mask")
    (39 "F.Mask" user "F.Mask")
    (44 "Edge.Cuts" user)
    (45 "Margin" user)
    (46 "B.CrtYd" user "B.Courtyard")
    (47 "F.CrtYd" user "F.Courtyard")
    (48 "B.Fab" user)
    (49 "F.Fab" user)
  )
  (setup
    (pad_to_mask_clearance 0)
    (allow_soldermask_bridges_in_footprints no)
    (pcbplotparams
      (layerselection 0x00010fc_ffffffff)
      (plot_on_all_layers_selection 0x0000000_00000000)
    )
  )
{net_defs}
{footprints_str}

{outline}
)
'''
    with open(pcb_path, 'w', encoding='utf-8') as f:
        f.write(pcb_content)

    return {
        'components': len(components),
        'nets': len(nets),
        'board': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
    }


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python pcb_generator.py <input.net> <output.kicad_pcb>")
        sys.exit(1)
    result = generate_pcb(sys.argv[1], sys.argv[2])
    print(f"PCB generated: {result['components']} components, {result['nets']} nets")
    print(f"Board area: ({result['board']['x1']:.1f}, {result['board']['y1']:.1f}) - ({result['board']['x2']:.1f}, {result['board']['y2']:.1f}) mm")
