from skidl import *

# 5V relay driven by an NPN transistor, flyback diode across the coil.
# Base current = (5 - 0.7) / 1k = 4.3 mA

vcc = Net('+5V')
gnd = Net('GND')
sig = Net('IN')
base = Net('BASE')
coil = Net('COIL_LOW')
com = Net('COM')
no = Net('NO')
nc = Net('NC')

j1 = Part(tool=SKIDL, name='Conn_01x03', ref_prefix='J', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE), Pin(num=3,name='p3',func=Pin.types.PASSIVE)])
j1.value = 'PWR_IN'
j2 = Part(tool=SKIDL, name='Conn_01x03', ref_prefix='J', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE), Pin(num=3,name='p3',func=Pin.types.PASSIVE)])
j2.value = 'RELAY_OUT'
r1 = Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
r1.value = '1k'
q1 = Part(tool=SKIDL, name='Q_NPN', ref_prefix='Q', pins=[Pin(num=1,name='B',func=Pin.types.INPUT), Pin(num=2,name='C',func=Pin.types.PASSIVE), Pin(num=3,name='E',func=Pin.types.PASSIVE)])
q1.value = '2N3904'
d1 = Part(tool=SKIDL, name='D', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
d1.value = '1N4148'
k1 = Part(tool=SKIDL, name='Relay', ref_prefix='K', pins=[Pin(num=1,name='COIL1',func=Pin.types.PASSIVE), Pin(num=2,name='COIL2',func=Pin.types.PASSIVE), Pin(num=3,name='COM',func=Pin.types.PASSIVE), Pin(num=4,name='NO',func=Pin.types.PASSIVE), Pin(num=5,name='NC',func=Pin.types.PASSIVE)])
k1.value = '5V'
c1 = Part(tool=SKIDL, name='C', ref_prefix='C', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
c1.value = '100nF'

j1['p1'] += vcc
j1['p2'] += sig
j1['p3'] += gnd
r1['p1'] += sig
r1['p2'] += base
q1['B'] += base
q1['E'] += gnd
q1['C'] += coil
k1['COIL1'] += vcc
k1['COIL2'] += coil
d1['K'] += vcc
d1['A'] += coil
k1['COM'] += com
k1['NO'] += no
k1['NC'] += nc
j2['p1'] += com
j2['p2'] += no
j2['p3'] += nc
c1['p1'] += vcc
c1['p2'] += gnd

generate_netlist()
