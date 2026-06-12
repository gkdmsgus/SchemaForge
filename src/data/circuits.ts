import type { CircuitCategory, CategoryMeta } from '../types'

export const CIRCUITS: Record<string, CircuitCategory> = {
  audio: {
    icon: '🔊', name: '오디오 앰프',
    items: [
      { name: 'LM386 소형 앰프', desc: '배터리로 동작하는 0.5W 소형 앰프', parts: 'LM386, 전해 캐패시터 x 3, 저항 x 2', prompt: 'LM386 audio amplifier complete circuit with gain setting resistor and capacitor between pins 1 and 8, input coupling capacitor, output coupling electrolytic capacitor, bypass capacitor on pin 7, power supply decoupling capacitor. 9V battery powered, 0.5W output into 8 ohm speaker' },
      { name: 'TDA2030 파워 앰프', desc: '14W 고출력 클래스 AB 앰프', parts: 'TDA2030, 전해 캐패시터 x 4, 저항 x 4', prompt: 'TDA2030 class AB power amplifier complete circuit with feedback resistor network, input coupling capacitor, bootstrap capacitor, power supply bypass capacitors, output coupling capacitor. Single 18V supply, 14W output into 4 ohm speaker' },
      { name: '헤드폰 앰프', desc: 'NE5532 기반 저잡음 헤드폰 출력', parts: 'NE5532, 캐패시터 x 5, 저항 x 6', prompt: 'NE5532 headphone amplifier complete circuit with input coupling capacitor, gain resistors, DC bias network, output capacitor, power supply decoupling. Dual ±12V supply, low noise, 32 ohm headphones' },
      { name: '마이크 프리앰프', desc: '마이크 신호 40dB 증폭', parts: 'LM358, 캐패시터 x 4, 저항 x 5', prompt: 'LM358 microphone preamplifier complete circuit with bias resistors for electret microphone, input coupling capacitor, gain of 40dB feedback resistors, output coupling capacitor, power supply decoupling. 9V supply' },
    ]
  },
  power: {
    icon: '⚡', name: '전원 & 충전',
    items: [
      { name: 'TP4056 리튬 배터리 충전', desc: 'USB 5V로 1A 충전', parts: 'TP4056, 저항 x 2, LED x 2, 캐패시터 x 2', prompt: 'TP4056 lithium battery charger complete circuit with PROG resistor for 1A, CHRG LED, STDBY LED with resistors, input and output bypass capacitors. USB 5V input' },
      { name: 'LM7805 5V 정전압', desc: '안정적인 5V 1A 출력', parts: 'LM7805, 전해 캐패시터 x 2, 다이오드 x 2, LED x 1, 저항 x 1', prompt: 'LM7805 5V linear regulator complete circuit with input electrolytic, output electrolytic, ceramic bypass capacitors, input and output protection diodes, power LED. 5V 1A regulated output' },
      { name: 'MT3608 부스트 컨버터', desc: '3.7V → 5V 승압', parts: 'MT3608, 인덕터 x 1, 쇼트키 다이오드 x 1, 캐패시터 x 3, 저항 x 2', prompt: 'MT3608 boost converter complete circuit with 4.7uH inductor, SS34 schottky diode, input and output filter capacitors, feedback voltage divider resistors. 3.7V to 5V, 2A output' },
      { name: 'LM317 가변 전압', desc: '1.25V~30V 자유롭게 조절', parts: 'LM317, 전해 캐패시터 x 2, 가변저항 x 1, 다이오드 x 2', prompt: 'LM317 adjustable voltage regulator complete circuit with programming resistors, potentiometer, adjustment capacitor, input and output bypass capacitors, protection diodes. 1.25V to 12V, 1.5A' },
    ]
  },
  led: {
    icon: '💡', name: 'LED & 조명',
    items: [
      { name: 'NE555 LED 점멸기', desc: '1Hz 규칙적 깜빡임', parts: 'NE555, LED x 1, 저항 x 3, 캐패시터 x 2', prompt: 'NE555 astable LED blinker complete circuit with timing resistors, timing capacitor, bypass capacitor, output current limiting resistor, LED. 1Hz blink rate, 9V supply' },
      { name: 'RGB LED 색상 제어', desc: 'PWM으로 색상 자유 조절', parts: 'RGB LED x 1, 저항 x 3, NPN 트랜지스터 x 3, 캐패시터 x 3', prompt: 'RGB LED controller complete circuit with current limiting resistors, NPN transistor drivers for each channel, base resistors, bypass capacitors. Common cathode RGB LED, 9V supply, PWM input' },
      { name: 'LED 디머', desc: '가변저항으로 밝기 조절', parts: 'NE555, N-CH MOSFET x 1, 가변저항 x 1, 저항 x 3, 캐패시터 x 2', prompt: 'LED dimmer NE555 PWM complete circuit with potentiometer duty cycle control, timing capacitor, steering diodes, N-channel MOSFET gate resistor, LED array. 12V supply, 0-100% dimming' },
      { name: '자동 야간 조명', desc: '어두워지면 자동으로 켜짐', parts: 'LM393, LDR x 1, LED x 1, 저항 x 4, 트랜지스터 x 1', prompt: 'Automatic night light with LDR voltage divider, LM393 comparator with hysteresis, NPN transistor switch, LED with current limiting resistor. Auto on dark, off bright, 9V supply' },
    ]
  },
  sensor: {
    icon: '🌡️', name: '센서 회로',
    items: [
      { name: 'LM35 온도 측정', desc: '10mV/°C 정밀 온도 측정', parts: 'LM35, LM358, 저항 x 4, 캐패시터 x 2, LED x 2', prompt: 'LM35 temperature sensor complete circuit with output filtering capacitor, op-amp buffer, gain resistors, overheat LED indicator. 0-100°C, 5V supply' },
      { name: 'DHT11 온습도 (아두이노)', desc: '온도+습도 동시 측정', parts: 'DHT11 x 1, 저항 x 2, 캐패시터 x 2', prompt: 'DHT11 temperature humidity sensor interface complete circuit with pull-up resistor, decoupling capacitor, signal filtering capacitor, Arduino header. 5V supply' },
      { name: 'LDR 빛 감지 & 릴레이', desc: '조도에 따라 기기 ON/OFF', parts: 'LM393, LDR x 1, 저항 x 4, 트랜지스터 x 1, 릴레이 x 1, 다이오드 x 1', prompt: 'LDR light sensor relay control with LM393 comparator, hysteresis resistors, NPN transistor relay driver, flyback diode. 12V relay, adjustable threshold' },
      { name: 'PIR 모션 감지 경보', desc: '움직임 감지 시 버저 알람', parts: 'PIR 센서 x 1, 트랜지스터 x 2, 저항 x 4, 버저 x 1, LED x 1, 캐패시터 x 2', prompt: 'PIR motion sensor alarm with transistor amplifier, NE555 one-shot timer, buzzer driver transistor, flyback diode, LED indicator. 5V supply' },
    ]
  },
  timer: {
    icon: '⏱️', name: '타이머 & 발진',
    items: [
      { name: '지연 타이머 (단안정)', desc: '버튼 누르면 N초 후 자동 OFF', parts: 'NE555, 저항 x 3, 전해 캐패시터 x 1, 버튼 x 1, LED x 1', prompt: 'NE555 monostable timer complete circuit with trigger button, pull-up resistor, timing R and C for 10 second delay, reset pull-up, bypass capacitor, output LED. 9V supply' },
      { name: '사각파 발진기', desc: '1kHz 오디오 톤 발생', parts: 'NE555, 저항 x 2, 캐패시터 x 2, 트랜지스터 x 1, 스피커', prompt: 'NE555 astable 1kHz oscillator complete circuit with timing resistors, timing capacitor, bypass capacitor, NPN transistor driver, coupling capacitor, speaker. 9V supply' },
      { name: '반복 타이머', desc: '일정 주기로 ON/OFF 반복', parts: 'NE555, 가변저항 x 1, 저항 x 2, 캐패시터 x 2, 릴레이 x 1, 트랜지스터 x 1, 다이오드 x 1', prompt: 'NE555 astable repeating timer with potentiometer period control, relay driver transistor, flyback diode, status LED. 12V supply, adjustable 1-30 second period' },
    ]
  },
  motor: {
    icon: '🎛️', name: '모터 & 제어',
    items: [
      { name: 'DC 모터 PWM 속도 제어', desc: '가변저항으로 모터 속도 조절', parts: 'NE555, N-CH MOSFET x 1, 가변저항 x 1, 저항 x 3, 캐패시터 x 2, 다이오드 x 2', prompt: 'DC motor speed controller PWM with NE555 generator, potentiometer duty cycle, steering diodes, N-channel MOSFET, flyback diode. 12V 2A motor' },
      { name: 'L298N 모터 드라이버', desc: '정방향/역방향 양방향 제어', parts: 'L298N, 다이오드 x 8, 캐패시터 x 5, 저항 x 2', prompt: 'L298N dual H-bridge motor driver complete circuit with 8 freewheeling diodes, logic and motor supply bypass capacitors, enable and input resistors. 12V motor, 5V logic, bidirectional 2 motors' },
      { name: '릴레이 스위치 회로', desc: '소신호로 고전압 기기 제어', parts: '릴레이 x 1, NPN 트랜지스터 x 1, 저항 x 2, 다이오드 x 1, LED x 2, 캐패시터 x 1', prompt: 'Relay switch circuit with NPN transistor driver, base resistor, flyback diode, status LED, bypass capacitor. 5V logic input, 12V relay coil' },
    ]
  },
}

export const CATEGORIES: CategoryMeta[] = [
  { key: 'audio',  icon: '🔊', name: '오디오 앰프', desc: '스피커, 헤드폰, 마이크' },
  { key: 'power',  icon: '⚡', name: '전원 & 충전', desc: '배터리 충전, 전압 변환' },
  { key: 'led',    icon: '💡', name: 'LED & 조명', desc: '점멸, 밝기 조절, 색상' },
  { key: 'sensor', icon: '🌡️', name: '센서 회로', desc: '온도, 빛, 움직임 감지' },
  { key: 'timer',  icon: '⏱️', name: '타이머 & 발진', desc: '주기 제어, 신호 발생' },
  { key: 'motor',  icon: '🎛️', name: '모터 & 제어', desc: 'DC 모터, 릴레이 스위치' },
]

export function detectCategory(text: string): string {
  const t = text.toLowerCase()
  if (t.match(/앰프|엠프|amplif|스피커|헤드폰|마이크|프리앰프|오디오|bass|guitar|베이스/)) return 'amp'
  if (t.match(/led|조명|점멸|발광|깜빡|디머/)) return 'led'
  if (t.match(/충전|배터리|전원|전압|voltage|power|regul|boost|강압|승압/)) return 'power'
  if (t.match(/센서|sensor|온도|습도|temp|모션|pir|ldr|빛|소리|감지/)) return 'sensor'
  if (t.match(/타이머|timer|555|발진|oscillat|딜레이|delay/)) return 'timer'
  if (t.match(/모터|motor|relay|릴레이|servo/)) return 'motor'
  return 'general'
}
