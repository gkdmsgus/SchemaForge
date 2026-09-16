"""
Part -> KiCad footprint table.

Key: (skidl part name, style) where style is 'smd' or 'tht'.
Value: (library, footprint, pin_map) where pin_map maps the skidl pin number
(fixed by the part templates in server/index.ts SYSTEM_PROMPT) to the pad
number on the KiCad footprint.

Pin orders were checked against the KiCad 10.0.6 symbol library (whose
maintainers take them from the datasheets) and the footprint pad layout:
  Device:LED / Device:D        pin 1 = K, pin 2 = A
  Device:C_Polarized           pin 1 = +
  Device:Buzzer                pin 1 = +
  Transistor_BJT:MMBT3904      SOT-23  1=B 2=E 3=C
  Transistor_BJT:2N3904        TO-92   1=E 2=B 3=C
  Transistor_FET:2N7002        SOT-23  1=G 2=S 3=D
  Transistor_FET:2N7000        TO-92   1=S 2=G 3=D
  Regulator_Linear:AMS1117-3.3 SOT-223 1=GND 2=VO 3=VI (tab = 2)
  Regulator_Linear:L7805       TO-220  1=IN 2=GND 3=OUT
  Timer:NE555D / NE555P        1..8 same on SOIC-8 and DIP-8
  Relay:SANYOU_SRD_Form_C      1=COM 2,5=coil 3=NO 4=NC
    (NO/NC read from the symbol drawing: the arm rests on pin 4's contact;
     footprint drills match the Sanyou SRD datasheet: COM offset 2 mm,
     coil holes 1.0 mm, contact holes 1.3 mm)
Parts that are not in this table are reported as unmapped, never guessed.
"""

IDENTITY2 = {1: '1', 2: '2'}

# skidl template pin numbers, for reference:
#   LED/D: 1=A 2=K   Q_NPN: 1=B 2=C 3=E   Q_NMOS: 1=G 2=D 3=S
#   REG: 1=GND 2=OUT 3=IN   Relay: 1=COIL1 2=COIL2 3=COM 4=NO 5=NC
#   CP / Buzzer / Battery: 1=+ 2=-
DIODE_MAP = {1: '2', 2: '1'}                      # A -> pad 2, K -> pad 1
RELAY_MAP = {1: '2', 2: '5', 3: '1', 4: '3', 5: '4'}

TABLE = {
    ('R', 'smd'):      ('Resistor_SMD', 'R_0805_2012Metric', IDENTITY2),
    ('R', 'tht'):      ('Resistor_THT', 'R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal', IDENTITY2),
    ('C', 'smd'):      ('Capacitor_SMD', 'C_0805_2012Metric', IDENTITY2),
    ('C', 'tht'):      ('Capacitor_THT', 'C_Disc_D5.0mm_W2.5mm_P5.00mm', IDENTITY2),
    ('CP', 'smd'):     ('Capacitor_SMD', 'CP_Elec_5x5.4', IDENTITY2),
    ('CP', 'tht'):     ('Capacitor_THT', 'CP_Radial_D5.0mm_P2.00mm', IDENTITY2),
    ('L', 'smd'):      ('Inductor_SMD', 'L_0805_2012Metric', IDENTITY2),
    ('L', 'tht'):      ('Inductor_THT', 'L_Axial_L5.3mm_D2.2mm_P10.16mm_Horizontal_Vishay_IM-1', IDENTITY2),
    ('LED', 'smd'):    ('LED_SMD', 'LED_0805_2012Metric', DIODE_MAP),
    ('LED', 'tht'):    ('LED_THT', 'LED_D5.0mm', DIODE_MAP),
    ('D', 'smd'):      ('Diode_SMD', 'D_SOD-123', DIODE_MAP),
    ('D', 'tht'):      ('Diode_THT', 'D_DO-35_SOD27_P7.62mm_Horizontal', DIODE_MAP),
    ('Q_NPN', 'smd'):  ('Package_TO_SOT_SMD', 'SOT-23', {1: '1', 2: '3', 3: '2'}),       # MMBT3904
    ('Q_NPN', 'tht'):  ('Package_TO_SOT_THT', 'TO-92_Inline', {1: '2', 2: '3', 3: '1'}),  # 2N3904
    ('Q_NMOS', 'smd'): ('Package_TO_SOT_SMD', 'SOT-23', {1: '1', 2: '3', 3: '2'}),       # 2N7002
    ('Q_NMOS', 'tht'): ('Package_TO_SOT_THT', 'TO-92_Inline', {1: '2', 2: '3', 3: '1'}),  # 2N7000
    ('NE555', 'smd'):  ('Package_SO', 'SOIC-8_3.9x4.9mm_P1.27mm', {i: str(i) for i in range(1, 9)}),
    ('NE555', 'tht'):  ('Package_DIP', 'DIP-8_W7.62mm', {i: str(i) for i in range(1, 9)}),
    ('REG', 'smd'):    ('Package_TO_SOT_SMD', 'SOT-223-3_TabPin2', {1: '1', 2: '2', 3: '3'}),  # AMS1117
    ('REG', 'tht'):    ('Package_TO_SOT_THT', 'TO-220-3_Vertical', {1: '2', 2: '3', 3: '1'}),  # 78xx
    ('SW', 'smd'):     ('Button_Switch_SMD', 'SW_SPST_TL3342', IDENTITY2),
    ('SW', 'tht'):     ('Button_Switch_THT', 'SW_PUSH_6mm', IDENTITY2),
    # Through-hole in both styles: no common SMD equivalent for hand assembly.
    ('Relay', 'smd'):  ('Relay_THT', 'Relay_SPDT_SANYOU_SRD_Series_Form_C', RELAY_MAP),
    ('Relay', 'tht'):  ('Relay_THT', 'Relay_SPDT_SANYOU_SRD_Series_Form_C', RELAY_MAP),
    ('Buzzer', 'smd'): ('Buzzer_Beeper', 'Buzzer_12x9.5RM7.6', IDENTITY2),
    ('Buzzer', 'tht'): ('Buzzer_Beeper', 'Buzzer_12x9.5RM7.6', IDENTITY2),
    # A battery is off-board; its leads land on a 2-pin header (pin 1 = +).
    # board furniture: a test point is one pad on a net, a mounting hole has no net at all
    ('TestPoint', 'smd'): ('TestPoint', 'TestPoint_Pad_D1.5mm', {1: '1'}),
    ('TestPoint', 'tht'): ('TestPoint', 'TestPoint_THTPad_D1.5mm_Drill0.7mm', {1: '1'}),
    ('MountingHole', 'smd'): ('MountingHole', 'MountingHole_3.2mm_M3', {}),
    ('MountingHole', 'tht'): ('MountingHole', 'MountingHole_3.2mm_M3', {}),
    ('Battery', 'smd'): ('Connector_PinHeader_2.54mm', 'PinHeader_1x02_P2.54mm_Vertical', IDENTITY2),
    ('Battery', 'tht'): ('Connector_PinHeader_2.54mm', 'PinHeader_1x02_P2.54mm_Vertical', IDENTITY2),
    ('Crystal', 'smd'): ('Crystal', 'Crystal_SMD_HC49-SD', IDENTITY2),
    ('Crystal', 'tht'): ('Crystal', 'Crystal_HC49-U_Vertical', IDENTITY2),
}

# Conn_01xNN -> 1xNN 2.54 mm pin header, pins map 1:1.
MAX_HEADER_PINS = 10
for _n in range(1, MAX_HEADER_PINS + 1):
    for _style in ('smd', 'tht'):
        TABLE[(f'Conn_01x{_n:02d}', _style)] = (
            'Connector_PinHeader_2.54mm', f'PinHeader_1x{_n:02d}_P2.54mm_Vertical',
            {i: str(i) for i in range(1, _n + 1)})

# Template parts deliberately left unmapped (see module docstring).
KNOWN_UNMAPPED = {'OpAmp': 'template is a 5-pin single op-amp; real parts are 8-pin with different numbering'}

# The pinout each style assumes, shown to the user so a value like "LM7805"
# on an SMD board is not silently wired as an AMS1117.
ASSUMED_PART = {
    ('Q_NPN', 'smd'): 'MMBT3904', ('Q_NPN', 'tht'): '2N3904',
    ('Q_NMOS', 'smd'): '2N7002', ('Q_NMOS', 'tht'): '2N7000',
    ('REG', 'smd'): 'AMS1117', ('REG', 'tht'): 'L78xx',
}


def lookup(part, style):
    """Return (lib, footprint, pin_map) or None."""
    return TABLE.get((part, style))


def all_footprints():
    """Every (lib, footprint) the table can emit — the set to vendor."""
    return sorted({(lib, fp) for lib, fp, _ in TABLE.values()})
