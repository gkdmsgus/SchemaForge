from skidl import *

# NE555 astable LED blinker.
# f = 1.44 / ((R1 + 2*R2) * C1) = 1.44 / ((10k + 2*68k) * 10uF) = 0.986 Hz

vcc = Net('VCC')
gnd = Net('GND')
disch = Net('DISCH')
thres = Net('THRES')
ctrl = Net('CTRL')
out = Net('OUT')
led_a = Net('LED_A')

bt1 = Part(tool=SKIDL, name='Battery', ref_prefix='BT', pins=[Pin(num=1,name='+',func=Pin.types.PWROUT), Pin(num=2,name='-',func=Pin.types.PWROUT)])
bt1.value = '9V'
u1 = Part(tool=SKIDL, name='NE555', ref_prefix='U', pins=[Pin(num=1,name='GND',func=Pin.types.PWRIN), Pin(num=2,name='TRIG',func=Pin.types.INPUT), Pin(num=3,name='OUT',func=Pin.types.OUTPUT), Pin(num=4,name='RESET',func=Pin.types.INPUT), Pin(num=5,name='CTRL',func=Pin.types.PASSIVE), Pin(num=6,name='THRES',func=Pin.types.INPUT), Pin(num=7,name='DISCH',func=Pin.types.PASSIVE), Pin(num=8,name='VCC',func=Pin.types.PWRIN)])
u1.value = 'NE555'
r1 = Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
r1.value = '10k'
r2 = Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
r2.value = '68k'
r3 = Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
r3.value = '680'
c1 = Part(tool=SKIDL, name='CP', ref_prefix='C', pins=[Pin(num=1,name='+',func=Pin.types.PASSIVE), Pin(num=2,name='-',func=Pin.types.PASSIVE)])
c1.value = '10uF'
c2 = Part(tool=SKIDL, name='C', ref_prefix='C', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
c2.value = '10nF'
c3 = Part(tool=SKIDL, name='C', ref_prefix='C', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
c3.value = '100nF'
d1 = Part(tool=SKIDL, name='LED', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
d1.value = 'RED'

bt1['+'] += vcc
bt1['-'] += gnd
u1['VCC'] += vcc
u1['RESET'] += vcc
u1['GND'] += gnd
r1['p1'] += vcc
r1['p2'] += disch
u1['DISCH'] += disch
r2['p1'] += disch
r2['p2'] += thres
u1['THRES'] += thres
u1['TRIG'] += thres
c1['+'] += thres
c1['-'] += gnd
u1['CTRL'] += ctrl
c2['p1'] += ctrl
c2['p2'] += gnd
c3['p1'] += vcc
c3['p2'] += gnd
u1['OUT'] += out
r3['p1'] += out
r3['p2'] += led_a
d1['A'] += led_a
d1['K'] += gnd

generate_netlist()
