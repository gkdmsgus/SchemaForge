from skidl import *

# 12 V DC motor, low-side N-MOSFET switch with a 0.1 ohm current-sense resistor.
# Motor current path: +12V -> motor (J2) -> MOT_LOW -> Q1 drain-source -> SENSE -> R2 -> GND.
# The gate side (R1 100 ohm, R3 10k pull-down) carries no motor current.
# Flyback diode D1 across the motor, bulk capacitor C1 on the supply.
# Sense voltage at 2 A: 2 * 0.1 = 0.2 V; R2 dissipation 2^2 * 0.1 = 0.4 W.

v12 = Net('+12V')
gnd = Net('GND')
sig = Net('PWM')
gate = Net('GATE')
low = Net('MOT_LOW')
sense = Net('SENSE')


def two_pin(name, prefix, value):
    p = Part(tool=SKIDL, name=name, ref_prefix=prefix,
             pins=[Pin(num=1, name='p1', func=Pin.types.PASSIVE), Pin(num=2, name='p2', func=Pin.types.PASSIVE)])
    p.value = value
    return p


j1 = Part(tool=SKIDL, name='Conn_01x03', ref_prefix='J', pins=[Pin(num=1, name='p1', func=Pin.types.PASSIVE), Pin(num=2, name='p2', func=Pin.types.PASSIVE), Pin(num=3, name='p3', func=Pin.types.PASSIVE)])
j1.value = 'PWR_IN'
j2 = Part(tool=SKIDL, name='Conn_01x02', ref_prefix='J', pins=[Pin(num=1, name='p1', func=Pin.types.PASSIVE), Pin(num=2, name='p2', func=Pin.types.PASSIVE)])
j2.value = 'MOTOR'
q1 = Part(tool=SKIDL, name='Q_NMOS', ref_prefix='Q', pins=[Pin(num=1, name='G', func=Pin.types.INPUT), Pin(num=2, name='D', func=Pin.types.PASSIVE), Pin(num=3, name='S', func=Pin.types.PASSIVE)])
q1.value = '2N7002'
r1 = two_pin('R', 'R', '100')
r2 = two_pin('R', 'R', '0.1')
r3 = two_pin('R', 'R', '10k')
d1 = Part(tool=SKIDL, name='D', ref_prefix='D', pins=[Pin(num=1, name='A', func=Pin.types.PASSIVE), Pin(num=2, name='K', func=Pin.types.PASSIVE)])
d1.value = '1N4148'
c1 = Part(tool=SKIDL, name='CP', ref_prefix='C', pins=[Pin(num=1, name='+', func=Pin.types.PASSIVE), Pin(num=2, name='-', func=Pin.types.PASSIVE)])
c1.value = '100uF'

j1['p1'] += v12
j1['p2'] += sig
j1['p3'] += gnd
j2['p1'] += v12
j2['p2'] += low
r1['p1'] += sig
r1['p2'] += gate
r3['p1'] += gate
r3['p2'] += gnd
q1['G'] += gate
q1['D'] += low
q1['S'] += sense
r2['p1'] += sense
r2['p2'] += gnd
d1['K'] += v12
d1['A'] += low
c1['+'] += v12
c1['-'] += gnd

generate_netlist()
