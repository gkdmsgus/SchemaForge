from skidl import *

# 9V battery -> 680 ohm -> red LED.  I = (9 - 2.0) / 680 = 10.3 mA

vcc = Net('VCC')
gnd = Net('GND')
led_a = Net('LED_A')

bt1 = Part(tool=SKIDL, name='Battery', ref_prefix='BT', pins=[Pin(num=1,name='+',func=Pin.types.PWROUT), Pin(num=2,name='-',func=Pin.types.PWROUT)])
bt1.value = '9V'
r1 = Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
r1.value = '680'
d1 = Part(tool=SKIDL, name='LED', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
d1.value = 'RED'

bt1['+'] += vcc
bt1['-'] += gnd
r1['p1'] += vcc
r1['p2'] += led_a
d1['A'] += led_a
d1['K'] += gnd

generate_netlist()
