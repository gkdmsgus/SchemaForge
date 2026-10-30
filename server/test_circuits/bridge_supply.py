from skidl import *

# 9 VAC in -> bridge rectifier -> smoothed DC out, an LED shows the rail is up.
# DC ~ 9 * 1.41 - 2 * 1 V (two diodes conduct) ~ 10.7 V; LED current ~ (10.7 - 2) / 1k ~ 8.7 mA

ac1 = Net('AC1')
ac2 = Net('AC2')
vdc = Net('+12V')
gnd = Net('GND')
led_a = Net('LED_A')

j1 = Part(tool=SKIDL, name='Conn_01x02', ref_prefix='J', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
j1.value = 'AC_IN'
d1 = Part(tool=SKIDL, name='Bridge', ref_prefix='D', pins=[Pin(num=1,name='AC1',func=Pin.types.PASSIVE), Pin(num=2,name='AC2',func=Pin.types.PASSIVE), Pin(num=3,name='+',func=Pin.types.PWROUT), Pin(num=4,name='-',func=Pin.types.PASSIVE)])
d1.value = 'MB6S'
c1 = Part(tool=SKIDL, name='CP', ref_prefix='C', pins=[Pin(num=1,name='+',func=Pin.types.PASSIVE), Pin(num=2,name='-',func=Pin.types.PASSIVE)])
c1.value = '470uF'
c2 = Part(tool=SKIDL, name='C', ref_prefix='C', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
c2.value = '100nF'
r1 = Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
r1.value = '1k'
d2 = Part(tool=SKIDL, name='LED', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
d2.value = 'RED'
j2 = Part(tool=SKIDL, name='Conn_01x02', ref_prefix='J', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
j2.value = 'DC_OUT'

j1['p1'] += ac1
j1['p2'] += ac2
d1['AC1'] += ac1
d1['AC2'] += ac2
d1['+'] += vdc
d1['-'] += gnd
c1['+'] += vdc
c1['-'] += gnd
c2['p1'] += vdc
c2['p2'] += gnd
r1['p1'] += vdc
r1['p2'] += led_a
d2['A'] += led_a
d2['K'] += gnd
j2['p1'] += vdc
j2['p2'] += gnd

generate_netlist()
