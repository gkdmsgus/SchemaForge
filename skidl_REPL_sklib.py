from collections import defaultdict
from skidl import Pin, Part, Alias, SchLib, SKIDL, TEMPLATE

from skidl.pin import pin_types

SKIDL_lib_version = '0.0.1'

skidl_REPL = SchLib(tool=SKIDL).add_parts(*[
        Part(**{ 'name':'Q', 'dest':TEMPLATE, 'tool':SKIDL, 'aliases':Alias({'Q'}), 'ref_prefix':'Q', 'fplist':None, 'footprint':None, 'keywords':None, 'description':'', 'datasheet':None, 'pins':[
            Pin(num='1',name='B',func=pin_types.PASSIVE),
            Pin(num='2',name='C',func=pin_types.PASSIVE),
            Pin(num='3',name='E',func=pin_types.PASSIVE)] }),
        Part(**{ 'name':'R', 'dest':TEMPLATE, 'tool':SKIDL, 'aliases':Alias({'R'}), 'ref_prefix':'R', 'fplist':None, 'footprint':None, 'keywords':None, 'description':'', 'datasheet':None, 'pins':[
            Pin(num='1',name='A',func=pin_types.PASSIVE),
            Pin(num='2',name='B',func=pin_types.PASSIVE)] })])