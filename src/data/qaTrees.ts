import type { QaTree } from '../types'

export const QA_TREES: Record<string, QaTree> = {
  amp: {
    label: '앰프 회로',
    questions: [
      { id: 'amp_type', ask: '어떤 종류의 앰프인가요?', opts: [
        { txt: '🔊 스피커 앰프', sub: '외부 스피커에 소리 크게 내기', val: 'speaker amplifier' },
        { txt: '🎧 헤드폰 앰프', sub: '이어폰/헤드셋 출력', val: 'headphone amplifier' },
        { txt: '🎙️ 마이크 프리앰프', sub: '마이크 신호 40dB 증폭', val: 'microphone preamplifier 40dB gain' },
        { txt: '🎸 악기 프리앰프', sub: '기타/베이스 신호 처리', val: 'instrument guitar bass preamplifier' },
      ]},
      { id: 'amp_power', ask: '출력 파워는 어느 정도 원하세요?', showIf: a => a.amp_type === 'speaker amplifier', opts: [
        { txt: 'LM386 (0.5W)', sub: '배터리 동작 가능, 조용한 환경', val: 'LM386 0.5W output into 8 ohm' },
        { txt: 'PAM8403 (3W)', sub: 'USB 5V 전원, 책상용 스피커', val: 'PAM8403 3W stereo output' },
        { txt: 'TDA2030 (14W)', sub: '어댑터 필요, 큰 방/야외', val: 'TDA2030 14W output into 4 ohm' },
      ]},
      { id: 'amp_supply', ask: '전원 공급은 어떻게 할까요?', opts: [
        { txt: '🔋 9V 배터리', val: '9V battery supply' },
        { txt: '🔌 12V DC 어댑터', val: '12V DC adapter supply' },
        { txt: '💻 USB 5V', val: '5V USB supply' },
        { txt: '± 양전원 (고음질)', sub: '헤드폰 앰프 권장', val: 'dual ±12V supply' },
      ]},
      { id: 'amp_input', ask: '오디오 입력 소스는 뭔가요?', opts: [
        { txt: '📱 스마트폰 / 노트북', sub: '3.5mm 잭 입력', val: '3.5mm audio jack line-level input' },
        { txt: '🎙️ 마이크 (직접 연결)', sub: '약한 신호, 프리앰프 필요', val: 'microphone direct input with preamp stage' },
        { txt: '🎸 악기 (기타/베이스)', sub: '하이 임피던스 입력', val: 'high impedance instrument input' },
        { txt: '📻 라디오/DAC 모듈', sub: '라인 레벨 출력 장치', val: 'line-level DAC or radio module input' },
      ]},
      { id: 'amp_extra', ask: '추가 기능이 필요한가요?', opts: [
        { txt: '🎚️ 볼륨 조절', sub: '가변저항으로 음량 조절', val: 'with volume control potentiometer' },
        { txt: '🎛️ 톤 컨트롤', sub: '고음/저음 조절 가능', val: 'with bass treble tone control' },
        { txt: '🔇 음소거 스위치', sub: 'ON/OFF 전환', val: 'with mute switch' },
        { txt: '❌ 없음 (기본만)', val: '' },
      ]},
    ],
    build: (base, a) => {
      const parts = []
      if (a.amp_power) parts.push(a.amp_power)
      else if (a.amp_type) parts.push(a.amp_type)
      if (a.amp_supply) parts.push(a.amp_supply)
      if (a.amp_input) parts.push(a.amp_input)
      if (a.amp_extra) parts.push(a.amp_extra)
      return `${parts.join(', ')} complete circuit with all necessary components bias decoupling coupling protection. Based on: ${base}`
    }
  },
  led: {
    label: 'LED 회로',
    questions: [
      { id: 'led_mode', ask: 'LED를 어떻게 동작시킬까요?', opts: [
        { txt: '💫 LED 점멸', sub: 'NE555 타이머로 규칙적으로 깜빡임', val: 'NE555 astable LED blinker' },
        { txt: '🌙 밝기 조절 (디머)', sub: '가변저항으로 0~100% 연속 조절', val: 'LED PWM dimmer with MOSFET' },
        { txt: '🌈 RGB 색상 제어', sub: '빨강/초록/파랑 각각 조절', val: 'RGB LED color controller' },
        { txt: '🌑 자동 야간 조명', sub: '어두워지면 자동으로 켜짐', val: 'automatic night light LDR sensor' },
        { txt: '🚦 순차 점등', sub: 'LED가 하나씩 차례로 켜짐', val: 'sequential LED chaser circuit with NE555 and CD4017' },
      ]},
      { id: 'led_count', ask: 'LED를 몇 개 사용할 건가요?', opts: [
        { txt: '1개', sub: '표시용/시제품', val: '1 LED' },
        { txt: '3~5개', sub: '소규모 조명/표시', val: '3 to 5 LEDs in series-parallel' },
        { txt: '10개 이상 (LED 스트립)', sub: 'MOSFET 드라이버 필요', val: '10+ LEDs or LED strip with MOSFET driver' },
      ]},
      { id: 'led_supply', ask: '전원은 어떻게 할까요?', opts: [
        { txt: '🔋 9V 배터리', val: '9V battery' },
        { txt: '🔌 12V 어댑터', val: '12V DC adapter' },
        { txt: '💻 USB 5V', val: '5V USB' },
        { txt: '🪫 3V 코인셀 (CR2032)', sub: '소형/웨어러블용', val: '3V CR2032 coin cell battery' },
      ]},
      { id: 'led_extra', ask: '추가 기능이 필요한가요?', opts: [
        { txt: '🔘 ON/OFF 스위치', val: 'with power on-off switch' },
        { txt: '🔋 배터리 잔량 표시', sub: '전압이 낮으면 LED로 알림', val: 'with low battery indicator LED' },
        { txt: '⏱️ 자동 꺼짐 타이머', sub: '일정 시간 뒤 자동 OFF', val: 'with auto-off timer using NE555 monostable' },
        { txt: '❌ 없음 (기본만)', val: '' },
      ]},
    ],
    build: (base, a) => `${a.led_mode || 'LED circuit'}, ${a.led_count || '1 LED'}, ${a.led_supply || '9V supply'}${a.led_extra ? ', ' + a.led_extra : ''}, complete circuit with all components including current limiting resistors. Based on: ${base}`
  },
  power: {
    label: '전원 회로',
    questions: [
      { id: 'pwr_type', ask: '어떤 전원 회로인가요?', opts: [
        { txt: '🔋 리튬 배터리 충전기', sub: 'USB 5V로 18650 배터리 충전', val: 'TP4056 lithium battery charger 1A USB input' },
        { txt: '⬇️ 전압 낮추기 (강압)', sub: '예: 12V → 5V 안정화 출력', val: 'LM7805 linear voltage regulator 5V 1A' },
        { txt: '⬆️ 전압 높이기 (승압)', sub: '예: 3.7V → 5V 부스트 변환', val: 'MT3608 boost converter 3.7V to 5V' },
        { txt: '🔧 가변 전압 조절기', sub: '1.25V~30V 원하는 전압 설정', val: 'LM317 adjustable voltage regulator' },
      ]},
      { id: 'pwr_input', ask: '입력 전원은 뭔가요?', opts: [
        { txt: '🔋 리튬 배터리 (3.7V)', sub: '18650, 리포 등', val: '3.7V lithium battery input' },
        { txt: '🔋 9V 배터리', val: '9V battery input' },
        { txt: '🔌 12V DC 어댑터', val: '12V DC adapter input' },
        { txt: '💻 USB 5V', val: '5V USB input' },
        { txt: '🔌 24V 산업용', val: '24V industrial DC input' },
      ]},
      { id: 'pwr_output', ask: '출력 전압은 얼마가 필요한가요?', showIf: a => a.pwr_type !== 'TP4056 lithium battery charger 1A USB input', opts: [
        { txt: '3.3V', sub: 'ESP32, 센서 등', val: '3.3V output' },
        { txt: '5V', sub: '아두이노, USB 기기 등', val: '5V output' },
        { txt: '9V', sub: '아날로그 회로 등', val: '9V output' },
        { txt: '12V', sub: 'LED 스트립, 모터 등', val: '12V output' },
        { txt: '가변 (사용자 조절)', sub: 'LM317 등으로 조절', val: 'adjustable output voltage' },
      ]},
      { id: 'pwr_current', ask: '최대 전류는 어느 정도 필요한가요?', opts: [
        { txt: '소전류 (500mA 이하)', sub: '소형 부품, LED 등', val: '500mA max current' },
        { txt: '중전류 (1~2A)', sub: '아두이노, 센서 등', val: '1-2A max current' },
        { txt: '대전류 (2A 이상)', sub: '모터, 히터 등', val: '2A or more max current' },
      ]},
      { id: 'pwr_extra', ask: '추가 보호 기능이 필요한가요?', opts: [
        { txt: '🔌 역극성 보호', sub: '전원 반대로 연결해도 안전', val: 'with reverse polarity protection diode' },
        { txt: '⚡ 과전류 보호 (퓨즈)', sub: '과전류 시 차단', val: 'with fuse overcurrent protection' },
        { txt: '💡 전원 표시 LED', sub: '동작 중 LED 점등', val: 'with power indicator LED' },
        { txt: '🛡️ 전부 다', sub: '역극성 + 퓨즈 + LED', val: 'with reverse polarity protection, fuse, and power indicator LED' },
        { txt: '❌ 없음 (기본만)', val: '' },
      ]},
    ],
    build: (base, a) => `${a.pwr_type || 'power supply circuit'}, input: ${a.pwr_input || ''}, output: ${a.pwr_output || ''}, ${a.pwr_current || ''}${a.pwr_extra ? ', ' + a.pwr_extra : ''}, complete circuit with filter capacitors. Based on: ${base}`
  },
  sensor: {
    label: '센서 회로',
    questions: [
      { id: 'sensor_type', ask: '무엇을 감지하고 싶으세요?', opts: [
        { txt: '🌡️ 온도', sub: 'LM35로 정밀 측정', val: 'LM35 temperature sensor circuit' },
        { txt: '💧 온도 + 습도', sub: 'DHT11 디지털 출력', val: 'DHT11 temperature humidity sensor Arduino interface' },
        { txt: '☀️ 빛 (조도)', sub: 'LDR로 밝기 감지', val: 'LDR light sensor comparator circuit' },
        { txt: '👋 움직임 (모션)', sub: 'PIR 센서로 사람 감지', val: 'PIR motion detection alarm circuit' },
        { txt: '🔊 소리', sub: '마이크로 소리 감지', val: 'microphone sound detection comparator circuit' },
        { txt: '📏 거리 (초음파)', sub: 'HC-SR04로 거리 측정', val: 'HC-SR04 ultrasonic distance sensor circuit' },
        { txt: '🧲 자기장 (홀 센서)', sub: '자석 근접 감지', val: 'hall effect sensor magnetic field detection circuit' },
      ]},
      { id: 'sensor_sensitivity', ask: '감도 조절이 필요한가요?', opts: [
        { txt: '🎚️ 가변저항으로 조절', sub: '감지 기준값을 직접 설정', val: 'with adjustable threshold using potentiometer and comparator' },
        { txt: '📊 고정 기준값', sub: '저항으로 고정 설정', val: 'with fixed threshold resistor divider' },
      ]},
      { id: 'sensor_output', ask: '감지 후 어떻게 하고 싶으세요?', opts: [
        { txt: '💡 LED 표시', sub: '감지 시 LED 켜짐', val: 'LED indicator output' },
        { txt: '🔔 버저 알람', sub: '감지 시 소리 경보', val: 'buzzer alarm output' },
        { txt: '🔌 릴레이 제어', sub: '다른 기기 ON/OFF', val: 'relay control output' },
        { txt: '📊 아두이노 연결', sub: '아날로그/디지털 신호 출력', val: 'Arduino analog digital output interface' },
      ]},
      { id: 'sensor_supply', ask: '전원은 어떻게 할까요?', opts: [
        { txt: '💻 USB 5V', val: '5V USB supply' },
        { txt: '🔋 9V 배터리', val: '9V battery with 7805 regulator to 5V' },
        { txt: '🔋 3.7V 리튬 배터리', sub: '휴대용', val: '3.7V lithium battery with boost to 5V' },
      ]},
    ],
    build: (base, a) => `${a.sensor_type || 'sensor circuit'} ${a.sensor_sensitivity || ''} with ${a.sensor_output || 'indicator output'}, ${a.sensor_supply || '5V supply'}, complete circuit. Based on: ${base}`
  },
  timer: {
    label: '타이머 회로',
    questions: [
      { id: 'timer_type', ask: '타이머를 어떻게 사용할 건가요?', opts: [
        { txt: '⏸️ 지연 타이머', sub: '버튼 누르면 N초 뒤 자동 OFF', val: 'NE555 monostable timer delay off circuit' },
        { txt: '🔁 반복 타이머', sub: '일정 주기로 ON/OFF 자동 반복', val: 'NE555 astable repeating timer circuit' },
        { txt: '🔊 발진기 (소리 발생)', sub: '오디오 주파수 신호 출력', val: 'NE555 astable oscillator audio tone 1kHz' },
        { txt: '⏲️ 듀얼 타이머', sub: 'ON 시간과 OFF 시간 각각 설정', val: 'NE555 astable with adjustable duty cycle ON and OFF' },
      ]},
      { id: 'timer_time', ask: '동작 시간(주기)은요?', opts: [
        { txt: '짧게 (1초 미만)', val: 'less than 1 second' },
        { txt: '1~10초', val: '1 to 10 seconds' },
        { txt: '10초~1분', val: '10 seconds to 1 minute' },
        { txt: '1분 이상', val: 'more than 1 minute' },
      ]},
      { id: 'timer_output', ask: '타이머 출력은 뭘로 연결할까요?', opts: [
        { txt: '💡 LED', sub: 'LED 깜빡임/ON-OFF', val: 'LED output indicator' },
        { txt: '🔔 버저/스피커', sub: '소리 알림', val: 'buzzer or speaker output' },
        { txt: '🔌 릴레이', sub: '외부 기기 제어', val: 'relay output to control external device' },
        { txt: '🔄 다른 회로 트리거', sub: '신호 출력으로 연결', val: 'trigger signal output to next stage' },
      ]},
      { id: 'timer_supply', ask: '전원은 어떻게 할까요?', opts: [
        { txt: '💻 USB 5V', val: '5V USB supply' },
        { txt: '🔋 9V 배터리', val: '9V battery supply' },
        { txt: '🔌 12V 어댑터', val: '12V DC adapter supply' },
      ]},
    ],
    build: (base, a) => `${a.timer_type || 'NE555 timer circuit'}, timing period ${a.timer_time || ''}, ${a.timer_output || ''}, ${a.timer_supply || '9V supply'}, complete circuit with decoupling capacitor. Based on: ${base}`
  },
  motor: {
    label: '모터 제어 회로',
    questions: [
      { id: 'motor_type', ask: '어떤 모터를 제어하나요?', opts: [
        { txt: '🔄 DC 모터', sub: '속도 조절 (PWM)', val: 'DC motor PWM speed control' },
        { txt: '↔️ DC 모터 양방향', sub: '정방향/역방향 모두', val: 'L298N H-bridge DC motor bidirectional control' },
        { txt: '🔌 릴레이 스위치', sub: '고전압 기기 ON/OFF', val: 'relay switch transistor driver circuit' },
        { txt: '🌀 서보 모터', sub: '각도 제어 (0~180도)', val: 'servo motor control with PWM signal' },
        { txt: '🏎️ 스텝 모터', sub: '정밀 위치 제어', val: 'stepper motor driver circuit with ULN2003' },
      ]},
      { id: 'motor_voltage', ask: '모터 전원 전압은요?', opts: [
        { txt: '3.3V', sub: '소형 모터', val: '3.3V motor supply' },
        { txt: '5V', val: '5V motor supply' },
        { txt: '9V', val: '9V motor supply' },
        { txt: '12V', val: '12V motor supply' },
        { txt: '24V', val: '24V motor supply' },
      ]},
      { id: 'motor_control', ask: '속도/방향 제어는 어떻게 할까요?', opts: [
        { txt: '🎚️ 가변저항 (수동)', sub: '손으로 돌려서 조절', val: 'manual potentiometer speed control' },
        { txt: '🔘 버튼 (정/역/정지)', sub: '3개 버튼으로 제어', val: 'push button forward reverse stop control' },
        { txt: '📊 아두이노/MCU', sub: '프로그래밍으로 제어', val: 'Arduino MCU PWM control interface' },
      ]},
      { id: 'motor_protect', ask: '보호 기능이 필요한가요?', opts: [
        { txt: '⚡ 역기전력 보호 다이오드', sub: '모터 필수 보호', val: 'with flyback diode protection' },
        { txt: '🛡️ 역기전력 + 퓨즈', sub: '과전류까지 보호', val: 'with flyback diode and fuse protection' },
        { txt: '🛡️ 전부 다 (다이오드+퓨즈+LED)', val: 'with flyback diode, fuse, and status LED' },
      ]},
    ],
    build: (base, a) => `${a.motor_type || 'motor control circuit'}, ${a.motor_voltage || '12V'}, ${a.motor_control || ''}, ${a.motor_protect || 'with flyback diode protection'}, complete circuit with all protection components. Based on: ${base}`
  },
  general: {
    label: '회로',
    questions: [
      { id: 'gen_type', ask: '어떤 기능의 회로인가요?', opts: [
        { txt: '신호 증폭 (앰프)', val: 'amplifier circuit' },
        { txt: '전원 공급 / 충전', val: 'power supply circuit' },
        { txt: 'LED / 조명 제어', val: 'LED control circuit' },
        { txt: '센서 / 측정', val: 'sensor measurement circuit' },
        { txt: '타이머 / 발진', val: 'timer oscillator circuit' },
        { txt: '모터 / 릴레이', val: 'motor relay control circuit' },
      ]},
      { id: 'gen_supply', ask: '전원은 어떻게 할까요?', opts: [
        { txt: '🔋 9V 배터리', val: '9V battery supply' },
        { txt: '🔌 12V DC 어댑터', val: '12V DC adapter supply' },
        { txt: '💻 USB 5V', val: '5V USB supply' },
        { txt: '🔋 3.7V 리튬 배터리', val: '3.7V lithium battery supply' },
      ]},
      { id: 'gen_platform', ask: '구현 방식은요?', opts: [
        { txt: '🔧 브레드보드 (시제품)', sub: '납땜 없이 빠르게 테스트', val: 'breadboard prototype' },
        { txt: '🔩 만능기판 (납땜)', sub: '반영구적 조립', val: 'perfboard soldered assembly' },
        { txt: '🖥️ PCB 제작', sub: '전문 기판 발주', val: 'custom PCB fabrication' },
      ]},
    ],
    build: (base, a) => `${a.gen_type || ''} ${base}, ${a.gen_supply || ''}, ${a.gen_platform || ''}, complete professional circuit with all necessary components bias decoupling protection`
  },
}
