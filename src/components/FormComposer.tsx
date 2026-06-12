import { useState } from 'react'
import TraceField from './TraceField.tsx'
import Mascot from './Mascot.tsx'
import { Button, Chip, IconBolt, IconWand } from './primitives.tsx'

const EXAMPLE_PROMPTS = [
  '9V로 LED 3개 점멸',
  'USB 5V → 3.3V 레귤레이터',
  'NE555 1Hz 타이머',
  'DHT11 온습도 센서',
  '오디오 헤드폰 앰프',
]

interface CircuitField {
  key: string
  label: string
  required?: boolean
  options: string[]
  recommended?: string
  hints?: Record<string, string>
  multi?: boolean
}

interface WorkflowStep {
  num: string
  title: string
  desc: string
  bullets: string[]
}

interface CircuitType {
  key: string
  label: string
  desc: string
  glyph: string
  fields: CircuitField[]
}

const CIRCUIT_TYPES: CircuitType[] = [
  {
    key: 'amp',
    label: '오디오 앰프',
    desc: '프리/파워앰프, 헤드폰, 기타·베이스',
    glyph: '〜',
    fields: [
      { key: 'subtype', label: '앰프 종류', required: true,
        options: ['프리앰프', '파워앰프', '헤드폰 앰프', '기타 프리앰프', '베이스 프리앰프'],
        recommended: '헤드폰 앰프',
        hints: {
          '프리앰프': '마이크·픽업 신호를 증폭, 다음 단계로 넘기는 역할',
          '파워앰프': '스피커를 직접 구동하는 최종 증폭단',
          '헤드폰 앰프': '입문자에게 가장 많이 쓰이는 소형 앰프',
          '기타 프리앰프': '일렉 기타 픽업 신호 버퍼·이퀄라이저',
          '베이스 프리앰프': '베이스 기타용, 저역 특화 이퀄라이저',
        },
      },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['9V 배터리', '12V', '±15V', 'USB 5V'],
        recommended: '9V 배터리',
        hints: {
          '9V 배터리': '가장 흔한 선택 — 시중 어디서나 구할 수 있어요',
          '12V': '어댑터 사용 시 안정적인 전압',
          '±15V': '고품질 오디오·레퍼런스 회로에 사용',
          'USB 5V': '컴퓨터나 충전기에서 바로 전원 공급',
        },
      },
      { key: 'gain', label: '이득',
        options: ['20dB', '30dB', '40dB', '60dB'],
        recommended: '20dB',
        hints: {
          '20dB': '일반 용도 — 전압 10배 증폭, 가장 많이 사용',
          '30dB': '약한 신호를 강하게 — 전압 32배',
          '40dB': '고이득 — 마이크 등 극소 신호용',
          '60dB': '초고이득 — 노이즈 관리 필요',
        },
      },
      { key: 'extras', label: '부가 기능', multi: true,
        options: ['전원 LED', '볼륨 조절', '톤 컨트롤', '뮤트 스위치', '입력 보호'],
        hints: {
          '전원 LED': '전원이 켜졌는지 한눈에 확인',
          '볼륨 조절': '가변저항으로 출력 볼륨 조절',
          '톤 컨트롤': '고음·저음 강조/감쇠 필터',
          '뮤트 스위치': '출력을 빠르게 끄는 기능',
          '입력 보호': '과전압으로부터 입력단 보호',
        },
      },
    ],
  },
  {
    key: 'led',
    label: 'LED 제어',
    desc: '점등 · 점멸 · 순차 · PWM 디밍',
    glyph: '●',
    fields: [
      { key: 'subtype', label: '동작', required: true,
        options: ['단순 점등', '점멸 (블링크)', '순차 점멸 (체이서)', 'PWM 디밍', 'RGB 페이드'],
        recommended: '점멸 (블링크)',
        hints: {
          '단순 점등': '버튼 누르면 켜지는 가장 기본 회로',
          '점멸 (블링크)': '입문자에게 가장 인기 — 1초 깜빡이는 Hello World 회로',
          '순차 점멸 (체이서)': '여러 LED가 차례로 켜지는 Knight Rider 효과',
          'PWM 디밍': '밝기를 부드럽게 조절, 모터 속도 제어와 같은 원리',
          'RGB 페이드': '색상이 천천히 변하는 무드 조명',
        },
      },
      { key: 'count', label: 'LED 개수', required: true,
        options: ['1', '3', '5', '8', '10+'],
        recommended: '3',
        hints: {
          '1': '가장 단순한 구성, 테스트용',
          '3': '삼색 신호등 등 일반적인 구성',
          '5': '바 그래프 표시 등에 많이 사용',
          '8': '시프트 레지스터와 함께 자주 사용',
          '10+': '드라이버 IC(74HC595 등) 필요',
        },
      },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V', '9V', '12V'],
        recommended: '5V',
        hints: {
          '3.3V': 'ESP32 등 3.3V MCU와 직접 연결 가능',
          '5V': '아두이노·USB 전원 — 가장 많이 쓰는 표준 전압',
          '9V': '9V 배터리 사용 시, 저항으로 전류 제한 필요',
          '12V': '자동차·고출력 LED 스트립에 사용',
        },
      },
      { key: 'color', label: '색상',
        options: ['빨강', '초록', '파랑', '노랑', 'RGB', '혼합'],
        recommended: '빨강',
        hints: {
          '빨강': '순방향 전압이 낮아 회로 설계가 쉬움 (약 2V)',
          '초록': '눈에 잘 띄는 표시등, 전원 LED로 많이 사용',
          '파랑': '순방향 전압 약 3.2V — 저전압 회로에서 주의',
          '노랑': '경고 표시에 주로 사용',
          'RGB': '세 색을 조합해 다양한 색 표현 가능',
          '혼합': '여러 색을 조합한 인디케이터 구성',
        },
      },
    ],
  },
  {
    key: 'power',
    label: '전원 회로',
    desc: '레귤레이터 · Buck · Boost · 충전기',
    glyph: '⚡',
    fields: [
      { key: 'subtype', label: '종류', required: true,
        options: ['선형 레귤레이터', 'Buck (강압)', 'Boost (승압)', 'Buck-Boost', '리튬 충전기'],
        recommended: '선형 레귤레이터',
        hints: {
          '선형 레귤레이터': '회로가 가장 단순 — LM7805 하나로 완성, 입문자 강력 추천',
          'Buck (강압)': '효율이 높아 배터리 기기에 적합, 부품 수가 조금 더 많음',
          'Boost (승압)': '낮은 전압을 높여줌 — 배터리→5V USB 충전기 등',
          'Buck-Boost': '입출력 전압 차이가 없어도 동작, 복잡한 편',
          '리튬 충전기': 'TP4056 같은 IC 하나로 간단히 구성 가능',
        },
      },
      { key: 'vin', label: '입력 전압', required: true,
        options: ['USB 5V', '7-12V', '12-24V', '리튬 1셀 (3.7V)'],
        recommended: 'USB 5V',
        hints: {
          'USB 5V': '컴퓨터·충전기에서 바로 사용 — 가장 구하기 쉬운 전원',
          '7-12V': 'DC 어댑터 사용 시 일반적인 범위',
          '12-24V': '산업용·자동차·SMPS 어댑터',
          '리튬 1셀 (3.7V)': '배터리 기기 설계, Boost 변환 필요할 수 있음',
        },
      },
      { key: 'vout', label: '출력 전압', required: true,
        options: ['1.8V', '3.3V', '5V', '9V', '12V'],
        recommended: '3.3V',
        hints: {
          '1.8V': '초저전력 MCU·플래시 메모리용',
          '3.3V': 'ESP32·STM32 등 현대 MCU 표준 전압 — 가장 많이 사용',
          '5V': '아두이노·USB 기기·74HC 로직 표준',
          '9V': '오디오 앰프·이펙터에 많이 사용',
          '12V': '모터·릴레이·소형 어댑터 출력',
        },
      },
      { key: 'iout', label: '출력 전류',
        options: ['100mA', '500mA', '1A', '2A 이상'],
        recommended: '500mA',
        hints: {
          '100mA': 'MCU + 센서 정도의 소형 회로',
          '500mA': '아두이노 + 주변 부품 구성에 충분 — 가장 흔한 선택',
          '1A': '모터 1개 또는 여러 LED 구동 가능',
          '2A 이상': '모터 여러 개·고출력 LED 스트립 등',
        },
      },
    ],
  },
  {
    key: 'timer',
    label: '타이머 / 펄스',
    desc: '555 · One-shot · PWM · 디바운스',
    glyph: '⏱',
    fields: [
      { key: 'subtype', label: '동작', required: true,
        options: ['단안정 (One-shot)', '비안정 (점멸)', 'PWM 발생기', '버튼 디바운스'],
        recommended: '비안정 (점멸)',
        hints: {
          '단안정 (One-shot)': '버튼 누르면 정해진 시간만큼 출력 — 타이머 기능',
          '비안정 (점멸)': '555 타이머의 대표 활용 — LED 깜빡임, 클럭 신호 생성',
          'PWM 발생기': '모터 속도나 LED 밝기를 조절하는 펄스 신호 생성',
          '버튼 디바운스': '버튼 채터링(떨림)을 제거해 안정적인 입력 처리',
        },
      },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V', '9V', '12V'],
        recommended: '5V',
        hints: {
          '3.3V': 'CMOS 555(TLC555)와 사용, 저전력',
          '5V': '일반 NE555와 가장 많이 조합 — 표준 구성',
          '9V': '9V 배터리 직결, 출력 전류가 조금 더 큼',
          '12V': '릴레이·솔레노이드 구동 타이머에 사용',
        },
      },
      { key: 'freq', label: '주파수 / 시간',
        options: ['1Hz', '10Hz', '100Hz', '1kHz', '10kHz'],
        recommended: '1Hz',
        hints: {
          '1Hz': '1초에 한 번 깜빡임 — 눈으로 확인하기 좋은 입문용',
          '10Hz': '빠른 깜빡임, 버저 저음',
          '100Hz': '모터 PWM 등에 자주 사용',
          '1kHz': '가청 주파수 버저 톤, 고속 PWM',
          '10kHz': '초음파 근처, 모터 고속 PWM',
        },
      },
    ],
  },
  {
    key: 'sensor',
    label: '센서 입력',
    desc: '온도 · 거리 · 조도 · 버튼',
    glyph: '⌖',
    fields: [
      { key: 'subtype', label: '센서 종류', required: true,
        options: ['온도', '습도', '조도', '거리 (초음파)', '거리 (IR)', '버튼 / 스위치', '모션'],
        recommended: '온도',
        hints: {
          '온도': 'DHT11·LM35 — 입문자 1순위, 부품 구하기 쉬움',
          '습도': 'DHT11/DHT22로 온도와 함께 측정 가능',
          '조도': 'CdS(광센서)로 밝기 감지, 야간등 자동화에 활용',
          '거리 (초음파)': 'HC-SR04 — 주차 보조·로봇 장애물 감지에 많이 사용',
          '거리 (IR)': '짧은 거리 감지, 반사식 물체 감지',
          '버튼 / 스위치': '가장 기본적인 입력 — 풀업/풀다운 저항 포함',
          '모션': 'PIR 센서 — 사람 감지 자동 조명에 활용',
        },
      },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V'],
        recommended: '5V',
        hints: {
          '3.3V': 'ESP32·Raspberry Pi 등 3.3V 시스템과 직접 연결',
          '5V': '아두이노와 대부분의 센서 모듈 표준 — 가장 범용적',
        },
      },
      { key: 'output', label: '출력 인터페이스',
        options: ['아날로그', '디지털', 'I²C', 'SPI', 'UART'],
        recommended: 'I²C',
        hints: {
          '아날로그': '전압값으로 출력 — ADC 핀에 바로 연결',
          '디지털': 'HIGH/LOW 신호 — 가장 단순한 인터페이스',
          'I²C': '배선 2개(SDA·SCL)로 여러 센서 연결 가능 — 가장 많이 사용',
          'SPI': '빠른 속도, 배선 4개 필요 — 디스플레이·SD카드 등',
          'UART': '시리얼 통신 — GPS·블루투스 모듈 등',
        },
      },
    ],
  },
  {
    key: 'mcu',
    label: 'MCU 보드',
    desc: 'ATmega · ESP32 · STM32 · RP2040',
    glyph: '▦',
    fields: [
      { key: 'subtype', label: 'MCU', required: true,
        options: ['ATmega328P', 'ATtiny85', 'ESP32', 'STM32 (Blue Pill)', 'RP2040', 'Arduino Nano'],
        recommended: 'Arduino Nano',
        hints: {
          'ATmega328P': '아두이노 UNO의 두뇌 — 자료가 가장 많은 입문용 칩',
          'ATtiny85': '8핀 초소형 MCU, 간단한 기능에 적합',
          'ESP32': 'Wi-Fi·블루투스 내장 — IoT 프로젝트 1순위',
          'STM32 (Blue Pill)': '고성능·저가, 아두이노보다 복잡하지만 강력',
          'RP2040': '라즈베리파이 공식 MCU, 이중 코어, MicroPython 지원',
          'Arduino Nano': '아두이노 입문자 1순위 — 작고 USB 바로 연결 가능',
        },
      },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V'],
        recommended: '5V',
        hints: {
          '3.3V': 'ESP32·STM32 등 현대 MCU는 3.3V 동작, 5V 허용 안 됨 주의',
          '5V': '아두이노 계열 표준 — 대부분의 센서·모듈과 바로 연결 가능',
        },
      },
      { key: 'extras', label: '주변 회로', multi: true,
        options: ['리셋 버튼', '전원 LED', '크리스털', 'ICSP 헤더', 'USB-UART', '디커플링'],
        hints: {
          '리셋 버튼': '프로그램 재시작용 — 개발 중에 편리',
          '전원 LED': '전원 공급 여부 확인용 표시등',
          '크리스털': '정확한 클럭 타이밍 필요할 때 (기본 내부 RC로도 충분한 경우 많음)',
          'ICSP 헤더': '부트로더 없이 직접 프로그래밍하는 6핀 헤더',
          'USB-UART': 'PC와 시리얼 통신·프로그래밍용 브리지 칩',
          '디커플링': '전원 노이즈 제거 캐패시터 — 항상 넣는 것을 권장',
        },
      },
    ],
  },
  {
    key: 'filter',
    label: '필터 회로',
    desc: 'LPF · HPF · BPF · Notch',
    glyph: '⌒',
    fields: [
      { key: 'subtype', label: '필터 종류', required: true,
        options: ['LPF (저역)', 'HPF (고역)', 'BPF (대역)', 'Notch'],
        recommended: 'LPF (저역)',
        hints: {
          'LPF (저역)': '고주파 노이즈 제거 — 오디오·센서 신호 정제에 가장 많이 사용',
          'HPF (고역)': '직류 성분(DC)·저주파 제거, 마이크 커플링에 활용',
          'BPF (대역)': '특정 주파수만 통과 — 라디오·신호 분리',
          'Notch': '특정 주파수만 제거 — 60/50Hz 전원 노이즈 제거',
        },
      },
      { key: 'topo', label: '구성',
        options: ['수동 RC', '액티브 1차', '액티브 2차 (Sallen-Key)'],
        recommended: '수동 RC',
        hints: {
          '수동 RC': '저항+캐패시터만 사용 — 가장 간단, 전원 불필요',
          '액티브 1차': '연산증폭기 추가로 버퍼링 효과, 로딩 영향 없음',
          '액티브 2차 (Sallen-Key)': '롤오프가 가파름 — 더 날카로운 차단 특성',
        },
      },
      { key: 'fc', label: '컷오프',
        options: ['100Hz', '1kHz', '10kHz', '100kHz'],
        recommended: '1kHz',
        hints: {
          '100Hz': '저음 이하 차단, 진동·맥동 노이즈 제거',
          '1kHz': '오디오 중간 대역 — 가장 범용적인 기준점',
          '10kHz': '가청 주파수 상단, 고주파 노이즈 제거',
          '100kHz': '오디오 초과 대역, 스위칭 노이즈 제거',
        },
      },
    ],
  },
  {
    key: 'logic',
    label: '디지털 로직',
    desc: '게이트 · 플립플롭 · 카운터',
    glyph: '◫',
    fields: [
      { key: 'subtype', label: '구성', required: true,
        options: ['AND/OR/NOT 게이트', 'XOR/XNOR', 'D 플립플롭', 'JK 플립플롭', '카운터', '시프트 레지스터', '디코더 (74138)'],
        recommended: 'AND/OR/NOT 게이트',
        hints: {
          'AND/OR/NOT 게이트': '디지털 논리의 기본 — 학습·실험에 가장 많이 사용',
          'XOR/XNOR': '비교·패리티 체크·덧셈 회로에 활용',
          'D 플립플롭': '1비트 기억 소자 — 순차 논리의 핵심',
          'JK 플립플롭': '범용 플립플롭, 분주 회로에 자주 활용',
          '카운터': '74HC163 등 — 이진/십진 카운팅, 주파수 분주',
          '시프트 레지스터': '74HC595 — LED 많이 제어할 때 핀 절약 필수',
          '디코더 (74138)': '3→8 디코더, 메모리 선택·세그먼트 구동',
        },
      },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V'],
        recommended: '5V',
        hints: {
          '3.3V': '74LVC 계열 사용 — ESP32·최신 MCU와 호환',
          '5V': '74HC 계열 표준 — 아두이노와 바로 연결 가능',
        },
      },
      { key: 'family', label: '로직 패밀리',
        options: ['74HC (CMOS)', '74LS (TTL)', '4000 시리즈'],
        recommended: '74HC (CMOS)',
        hints: {
          '74HC (CMOS)': '현재 표준 — 저전력·고속·3.3V~5V 광범위 동작, 강력 추천',
          '74LS (TTL)': '구형 표준 — 전력 소모 크고 5V 고정, 레거시 설계용',
          '4000 시리즈': '광범위 전압(3~15V), 저속·교육용 실험에 활용',
        },
      },
    ],
  },
  {
    key: 'comms',
    label: '통신 / 인터페이스',
    desc: 'USB-UART · RS-485 · CAN',
    glyph: '⇄',
    fields: [
      { key: 'subtype', label: '인터페이스', required: true,
        options: ['USB-UART (CH340/CP2102)', 'RS-232 (MAX232)', 'RS-485 (MAX485)', 'CAN 트랜시버', 'I²C 레벨 시프터', 'Bluetooth 모듈'],
        recommended: 'USB-UART (CH340/CP2102)',
        hints: {
          'USB-UART (CH340/CP2102)': 'PC↔MCU 직결 가장 흔한 방법 — 아두이노 프로그래밍 필수',
          'RS-232 (MAX232)': 'PC 시리얼 포트 연결, 산업용 장비 인터페이스',
          'RS-485 (MAX485)': '장거리·노이즈 환경 산업용 통신, 최대 1.2km',
          'CAN 트랜시버': '자동차·로봇 내부 통신 표준',
          'I²C 레벨 시프터': '3.3V↔5V 간 신호 변환, 서로 다른 전압 장치 연결',
          'Bluetooth 모듈': 'HC-05/HC-06 — 스마트폰과 무선 통신',
        },
      },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V', '듀얼 (3.3V/5V)'],
        recommended: '5V',
        hints: {
          '3.3V': 'ESP32·최신 모듈과 직접 연결',
          '5V': '대부분의 UART 모듈 표준 전압',
          '듀얼 (3.3V/5V)': '레벨 시프터 포함, 두 전압 시스템 연결',
        },
      },
      { key: 'extras', label: '부가 기능', multi: true,
        options: ['ESD 보호', '전원 LED', 'TX/RX LED', '터미널 저항'],
        hints: {
          'ESD 보호': '정전기로부터 통신 IC 보호 — 실외·장거리 배선에 권장',
          '전원 LED': '전원 인가 확인용',
          'TX/RX LED': '데이터 송수신 시 깜빡임 — 디버깅에 유용',
          '터미널 저항': 'RS-485/CAN 라인 끝단 120Ω 저항 — 반사파 제거',
        },
      },
    ],
  },
  {
    key: 'display',
    label: '디스플레이',
    desc: '7세그·LCD·OLED·LED 매트릭스',
    glyph: '▤',
    fields: [
      { key: 'subtype', label: '디스플레이 종류', required: true,
        options: ['7-세그먼트 (1자리)', '7-세그먼트 (4자리)', '캐릭터 LCD 16x2', 'OLED 0.96" I²C', 'OLED 1.3" SPI', 'LED 매트릭스 8x8', 'LED 바'],
        recommended: 'OLED 0.96" I²C',
        hints: {
          '7-세그먼트 (1자리)': '숫자 0~9 표시, 기본 디지털 시계·카운터',
          '7-세그먼트 (4자리)': '4자리 숫자 표시, TM1637 드라이버와 많이 사용',
          '캐릭터 LCD 16x2': '문자 32개 표시, 아두이노 입문 단골 부품',
          'OLED 0.96" I²C': '그래픽 가능·배선 2개·저렴 — 입문자 1순위 추천',
          'OLED 1.3" SPI': '더 크고 빠른 OLED, SPI 배선 4개',
          'LED 매트릭스 8x8': '애니메이션·이모티콘 표시, MAX7219와 함께 사용',
          'LED 바': '레벨 미터·진행률 표시에 활용',
        },
      },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V'],
        recommended: '5V',
        hints: {
          '3.3V': 'ESP32와 OLED 직결 구성에 사용',
          '5V': '아두이노 + LCD/OLED 표준 조합',
        },
      },
      { key: 'driver', label: '드라이버',
        options: ['직접 구동', '74HC595 (시프트)', 'MAX7219', 'TM1637', 'I²C 백팩'],
        recommended: 'I²C 백팩',
        hints: {
          '직접 구동': 'MCU 핀을 많이 사용, 소규모 LED에 적합',
          '74HC595 (시프트)': '3핀으로 8개 출력 제어 — 핀 절약의 기본',
          'MAX7219': '8x8 LED 매트릭스·7세그 전용, SPI로 제어',
          'TM1637': '4자리 7세그 전용 드라이버, 배선 2개만 필요',
          'I²C 백팩': 'LCD에 붙여 배선 2개로 줄임 — 가장 편리한 방법',
        },
      },
    ],
  },
  {
    key: 'motor',
    label: '모터 드라이버',
    desc: 'DC · 스텝 · 서보 · BLDC',
    glyph: '◐',
    fields: [
      { key: 'subtype', label: '모터 종류', required: true,
        options: ['DC 모터 (단방향)', 'DC 모터 (양방향, H-브리지)', '스텝 모터 (바이폴라)', '스텝 모터 (유니폴라)', '서보 모터', 'BLDC'],
        recommended: 'DC 모터 (양방향, H-브리지)',
        hints: {
          'DC 모터 (단방향)': '한 방향만 회전, 팬·펌프 등 단순 구동',
          'DC 모터 (양방향, H-브리지)': '정역 회전 가능 — 로봇·RC카에서 가장 많이 사용',
          '스텝 모터 (바이폴라)': '정밀 위치 제어 — 3D 프린터·CNC 표준',
          '스텝 모터 (유니폴라)': '드라이버가 단순하지만 토크가 낮음',
          '서보 모터': 'PWM 신호로 각도 제어 — 로봇 관절·RC 조종',
          'BLDC': '고효율·고속 — 드론·전동 공구, 별도 ESC 필요',
        },
      },
      { key: 'driver', label: '드라이버 IC',
        options: ['L298N', 'TB6612FNG', 'DRV8833', 'A4988', 'DRV8825', 'ULN2003'],
        recommended: 'L298N',
        hints: {
          'L298N': '가장 많이 쓰는 H-브리지 — 저렴·자료 풍부, 입문자 강력 추천',
          'TB6612FNG': 'L298N보다 효율 좋고 작음 — 중급 이상 추천',
          'DRV8833': '소형·저전압용, 브레드보드 프로젝트에 적합',
          'A4988': '스텝 모터 전용 — 3D 프린터 표준 드라이버',
          'DRV8825': 'A4988보다 세밀한 마이크로스텝 지원',
          'ULN2003': '유니폴라 스텝 모터·릴레이 구동용 달링턴 어레이',
        },
      },
      { key: 'vmotor', label: '모터 전압', required: true,
        options: ['5V', '6V', '12V', '24V'],
        recommended: '12V',
        hints: {
          '5V': 'USB 전원 직결 소형 모터, 토크 제한적',
          '6V': '소형 DC 모터·서보 모터 표준 전압',
          '12V': '가장 흔한 DC 모터 전압 — 어댑터·배터리 구하기 쉬움',
          '24V': '산업용·고토크 모터, 별도 전원 필요',
        },
      },
      { key: 'iout', label: '모터 전류',
        options: ['500mA', '1A', '2A', '3A 이상'],
        recommended: '1A',
        hints: {
          '500mA': '소형 팬·경량 바퀴 모터',
          '1A': '일반 DC 모터·소형 로봇 — 가장 흔한 사양',
          '2A': '중형 로봇·다축 구동에 적합',
          '3A 이상': '고토크 모터·드릴 등 고전류 부하',
        },
      },
    ],
  },
]

function fieldHasValue(field: {key: string; multi?: boolean}, values: Record<string, unknown>, customs: Record<string, string>) {
  const c = customs[field.key]?.trim()
  if (c) return true
  const v = values[field.key]
  if (field.multi) return Array.isArray(v) && v.length > 0
  return !!v
}

function fieldValueString(field: {key: string; multi?: boolean}, values: Record<string, unknown>, customs: Record<string, string>) {
  const c = customs[field.key]?.trim()
  if (c) return c
  const v = values[field.key]
  if (field.multi) return Array.isArray(v) && v.length ? v.join(', ') : null
  return v || null
}

export default function FormComposer({ onSubmit }: { onSubmit: (prompt: string, typeKey?: string) => void }) {
  const [typeKey, setTypeKey] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [customs, setCustoms] = useState<Record<string, string>>({})
  const [heroText, setHeroText] = useState('')
  const [heroFocused, setHeroFocused] = useState(false)

  const type = CIRCUIT_TYPES.find(t => t.key === typeKey)

  const requiredFilled = !type ? false :
    type.fields.filter(f => f.required).every(f => fieldHasValue(f, values, customs))

  const canSubmit = (type && requiredFilled) || (!type && heroText.trim().length >= 4)

  function chooseType(key: string) {
    if (key === typeKey) {
      setTypeKey(null)
      setValues({})
      setCustoms({})
      return
    }
    setTypeKey(key)
    setValues({})
    setCustoms({})
  }

  function pickSingle(fieldKey: string, opt: string) {
    setValues(v => ({ ...v, [fieldKey]: v[fieldKey] === opt ? '' : opt }))
    setCustoms(c => ({ ...c, [fieldKey]: '' }))
  }

  function toggleMulti(fieldKey: string, opt: string) {
    setValues(v => {
      const cur = Array.isArray(v[fieldKey]) ? v[fieldKey] : []
      return { ...v, [fieldKey]: cur.includes(opt) ? cur.filter(x => x !== opt) : [...cur, opt] }
    })
  }

  function setCustom(fieldKey: string, val: string) {
    setCustoms(c => ({ ...c, [fieldKey]: val }))
    if (val.trim()) {
      setValues(v => {
        const next = { ...v }
        delete next[fieldKey]
        return next
      })
    }
  }

  function buildPrompt() {
    const extras = heroText.trim()
    if (!type) return extras
    const lines = type.fields
      .map(f => {
        const val = fieldValueString(f, values, customs)
        return val ? `- ${f.label}: ${val}` : null
      })
      .filter(Boolean)
    let prompt = type.label
    if (lines.length) prompt += `\n\n[사양]\n${lines.join('\n')}`
    if (extras) prompt += `\n\n[추가 요청]\n${extras}`
    return prompt
  }

  function submit() {
    if (!canSubmit) return
    onSubmit?.(buildPrompt(), typeKey ?? undefined)
  }

  return (
    <div style={{ position: 'relative', minHeight: '100%', background: 'var(--sf-bg)', overflow: 'hidden' }}>
      <TraceField opacity={0.18} />
      <div className="sf-composer-wrap" style={{ position: 'relative', maxWidth: 940, margin: '0 auto', padding: '56px 24px 96px' }}>

        {/* Hero headline */}
        <div style={{ textAlign: 'center', marginBottom: 44 }}>
          <Mascot state="idle" size={60} style={{ margin: '0 auto 18px' }} />
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            background: 'var(--sf-amber-soft)',
            border: '1px solid var(--sf-amber-line)',
            borderRadius: 999,
            padding: '4px 14px',
            marginBottom: 18,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--sf-cyan)', boxShadow: '0 0 6px var(--sf-cyan)', flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--sf-font-mono)', fontSize: 10.5, color: 'var(--sf-amber)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              AI · Circuit · Design
            </span>
          </div>
          <h1 style={{
            margin: '0 0 14px',
            fontFamily: 'var(--sf-font-sans)',
            fontSize: 'clamp(32px, 5vw, 52px)',
            fontWeight: 700,
            color: 'var(--sf-fg)',
            lineHeight: 1.1,
            letterSpacing: '-0.03em',
          }}>
            어떤 회로를{' '}
            <span style={{
              color: 'var(--sf-amber)',
              position: 'relative',
              display: 'inline-block',
            }}>만들까요?</span>
          </h1>
          <p style={{
            margin: '0 auto',
            maxWidth: 500,
            fontFamily: 'var(--sf-font-sans)',
            fontSize: 15.5,
            color: 'var(--sf-fg-muted)',
            lineHeight: 1.65,
          }}>
            한 줄로 설명하거나, 카테고리에서 사양을 골라 주세요.
          </p>
        </div>

        {/* Hero free-text entry */}
        <div style={{ marginBottom: 36 }}>
          <div style={{
            position: 'relative',
            background: 'var(--sf-bg-2)',
            border: `1.5px solid ${heroFocused ? 'var(--sf-amber)' : 'var(--sf-line-strong)'}`,
            borderRadius: 20,
            boxShadow: heroFocused
              ? '0 0 0 4px rgba(200,117,21,0.1), 0 8px 32px rgba(74,52,18,0.12)'
              : '0 4px 20px rgba(74,52,18,0.08)',
            overflow: 'hidden',
            transition: 'border-color 0.2s, box-shadow 0.2s',
          }}>
            <textarea
              value={heroText}
              onChange={e => setHeroText(e.target.value)}
              onFocus={() => setHeroFocused(true)}
              onBlur={() => setHeroFocused(false)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder="만들고 싶은 회로를 자유롭게 적어 주세요&#10;예: 9V 배터리로 빨간 LED 3개를 1초 간격으로 점멸"
              style={{
                width: '100%', minHeight: 116,
                background: 'transparent', border: 'none', outline: 'none',
                padding: '22px 24px 64px',
                color: 'var(--sf-fg)',
                fontFamily: 'var(--sf-font-sans)',
                fontSize: 15.5, lineHeight: 1.6,
                resize: 'none',
                boxSizing: 'border-box',
                display: 'block',
              }}
            />
            <div style={{
              position: 'absolute', left: 16, right: 12, bottom: 12,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{
                fontSize: 11, color: 'var(--sf-fg-faint)',
                fontFamily: 'var(--sf-font-mono)', letterSpacing: '0.06em',
              }}>
                {heroText.length > 0 ? `${heroText.length}자` : '⌘ + ↵ 로 바로 생성'}
              </span>
              <Button
                variant="primary" size="md"
                icon={<IconBolt size={14} />}
                onClick={submit}
                disabled={!canSubmit}
              >
                {type ? `${type.label} 만들기` : '바로 만들기'}
              </Button>
            </div>
          </div>

          {/* Quick example chips */}
          {!heroText && !type && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
              {EXAMPLE_PROMPTS.map(ex => (
                <button
                  key={ex}
                  onClick={() => setHeroText(ex)}
                  style={{
                    background: 'var(--sf-bg-2)',
                    border: '1px solid var(--sf-line)',
                    borderRadius: 999,
                    padding: '5px 13px',
                    fontFamily: 'var(--sf-font-sans)',
                    fontSize: 12,
                    color: 'var(--sf-fg-muted)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = 'var(--sf-amber-line)'
                    e.currentTarget.style.background = 'var(--sf-amber-soft)'
                    e.currentTarget.style.color = 'var(--sf-amber)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'var(--sf-line)'
                    e.currentTarget.style.background = 'var(--sf-bg-2)'
                    e.currentTarget.style.color = 'var(--sf-fg-muted)'
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
          )}

          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            marginTop: 28, marginBottom: 4,
          }}>
            <span style={{ flex: 1, height: 1, background: 'var(--sf-line-soft)' }} />
            <span style={{
              fontSize: 11, color: 'var(--sf-fg-faint)',
              fontFamily: 'var(--sf-font-mono)', letterSpacing: '0.16em',
              textTransform: 'uppercase',
            }}>또는 카테고리에서 시작</span>
            <span style={{ flex: 1, height: 1, background: 'var(--sf-line-soft)' }} />
          </div>
        </div>

        {/* Step 1: Circuit type cards */}
        <SectionLabel num="01" title="회로 종류" />
        <div className="sf-type-grid" style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10,
          marginBottom: 28,
        }}>
          {CIRCUIT_TYPES.map(t => (
            <TypeCard
              key={t.key}
              active={typeKey === t.key}
              glyph={t.glyph}
              label={t.label}
              desc={t.desc}
              onClick={() => chooseType(t.key)}
            />
          ))}
        </div>

        {/* Step 2: Fields */}
        {type && (
          <>
            <SectionLabel num="02" title="사양 선택" />
            <div style={{
              background: 'var(--sf-bg-2)',
              border: '1px solid var(--sf-line-strong)',
              borderRadius: 'var(--sf-r-lg)',
              padding: '8px',
              marginBottom: 28,
            }}>
              {type.fields.map((f, i) => (
                <FieldRow
                  key={f.key}
                  field={f}
                  value={values[f.key]}
                  custom={customs[f.key] || ''}
                  onPick={(opt) => f.multi ? toggleMulti(f.key, opt) : pickSingle(f.key, opt)}
                  onCustom={(val) => setCustom(f.key, val)}
                  isLast={i === type.fields.length - 1}
                />
              ))}
            </div>
          </>
        )}

        {/* Submit (only when type is selected — free text submits from top button) */}
        {type && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="primary"
              size="lg"
              icon={<IconBolt size={14} />}
              onClick={submit}
              disabled={!canSubmit}
            >
              {type.label} 만들기
            </Button>
          </div>
        )}

        <WorkflowSection />
      </div>
    </div>
  )
}

const WORKFLOW_STEPS = [
  {
    num: '01',
    title: '입력',
    desc: '카테고리를 고르거나 자연어로 설명하세요. Sparky가 사양을 정리해요.',
    bullets: ['7+ 카테고리', '자유 텍스트', '한국어/영어'],
  },
  {
    num: '02',
    title: '분석',
    desc: 'GPT-4o가 부품·토폴로지를 추론하고 데이터시트로 사양을 검증해요.',
    bullets: ['부품 매칭', '값 계산', '안전 확인'],
  },
  {
    num: '03',
    title: '생성',
    desc: 'skidl로 네트리스트를 빌드하고 풋프린트를 매칭해 회로를 짭니다.',
    bullets: ['skidl 코드', '네트리스트', '풋프린트'],
  },
  {
    num: '04',
    title: '내보내기',
    desc: 'KiCad에서 바로 열리는 .net과 Gerber, BOM, PDF를 다운로드.',
    bullets: ['.net 파일', 'Gerber', 'BOM · PDF'],
  },
]

function WorkflowSection() {
  return (
    <div style={{ marginTop: 80 }}>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div className="sf-eyebrow" style={{ marginBottom: 12 }}>HOW IT WORKS</div>
        <h2 className="sf-heading-l" style={{ marginBottom: 8 }}>
          한 줄에서 <span style={{ color: 'var(--sf-cyan)' }}>KiCad 파일</span>까지
        </h2>
        <p className="sf-body" style={{ maxWidth: 540, margin: '0 auto', color: 'var(--sf-fg-muted)' }}>
          입력부터 내보내기까지 4단계, 평균 30초.
        </p>
      </div>

      <div className="sf-workflow-grid" style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12,
        position: 'relative',
      }}>
        {WORKFLOW_STEPS.map((s, i) => (
          <WorkflowCard key={s.num} step={s} isLast={i === WORKFLOW_STEPS.length - 1} />
        ))}
      </div>
    </div>
  )
}

function WorkflowCard({ step, isLast }: { step: WorkflowStep; isLast: boolean }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        background: hovered ? 'var(--sf-bg-3)' : 'var(--sf-bg-2)',
        border: `1px solid ${hovered ? 'var(--sf-line-strong)' : 'var(--sf-line)'}`,
        borderRadius: 16,
        padding: '22px 20px',
        display: 'flex', flexDirection: 'column', gap: 10,
        transition: 'all 0.18s ease',
        boxShadow: hovered ? '0 6px 20px rgba(74,52,18,0.1)' : 'none',
        transform: hovered ? 'translateY(-2px)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 32, height: 32,
          background: 'var(--sf-amber-soft)',
          border: '1px solid var(--sf-amber-line)',
          borderRadius: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--sf-font-mono)', fontSize: 11,
          color: 'var(--sf-amber)', letterSpacing: '0.1em', fontWeight: 600,
        }}>{step.num}</div>
        {!isLast && (
          <span style={{
            flex: 1, height: 1,
            background: 'linear-gradient(to right, var(--sf-line), transparent)',
          }} />
        )}
      </div>
      <h3 style={{
        margin: 0, fontSize: 15.5, fontWeight: 700, color: 'var(--sf-fg)',
        fontFamily: 'var(--sf-font-sans)', letterSpacing: '-0.01em',
      }}>{step.title}</h3>
      <p style={{
        margin: 0, fontSize: 12.5, lineHeight: 1.6,
        color: 'var(--sf-fg-muted)',
      }}>{step.desc}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2 }}>
        {step.bullets.map((b, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 7,
            fontSize: 11, color: 'var(--sf-fg-dim)',
            fontFamily: 'var(--sf-font-mono)',
          }}>
            <span style={{
              width: 4, height: 4, borderRadius: '50%',
              background: 'var(--sf-cyan)', flexShrink: 0,
            }} />
            {b}
          </div>
        ))}
      </div>
    </div>
  )
}

function SectionLabel({ num, title }: { num: string; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
      <span style={{
        fontFamily: 'var(--sf-font-mono)', fontSize: 11,
        color: 'var(--sf-amber)', letterSpacing: '0.14em',
      }}>{num}</span>
      <span style={{
        fontFamily: 'var(--sf-font-mono)', fontSize: 11,
        color: 'var(--sf-fg-dim)', letterSpacing: '0.14em', textTransform: 'uppercase',
      }}>{title}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--sf-line)' }} />
    </div>
  )
}

function TypeCard({ active, glyph, label, desc, onClick }: { active: boolean; glyph: string; label: string; desc: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  const on = active || hovered
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8,
        padding: '16px 16px 14px',
        background: active ? 'var(--sf-amber-soft)' : hovered ? 'var(--sf-bg-3)' : 'var(--sf-bg-2)',
        border: `1.5px solid ${active ? 'var(--sf-amber)' : hovered ? 'var(--sf-line-strong)' : 'var(--sf-line)'}`,
        borderRadius: 14,
        cursor: 'pointer', textAlign: 'left',
        transition: 'all 0.18s ease',
        boxShadow: active
          ? '0 4px 16px rgba(200,117,21,0.15)'
          : hovered
          ? '0 4px 14px rgba(74,52,18,0.1)'
          : 'none',
        transform: on ? 'translateY(-1px)' : 'none',
      }}
    >
      <div style={{
        width: 36, height: 36,
        background: active ? 'var(--sf-amber)' : hovered ? 'var(--sf-bg-4)' : 'var(--sf-bg-3)',
        border: `1px solid ${active ? 'transparent' : 'var(--sf-line)'}`,
        borderRadius: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.18s ease',
        fontSize: 17,
        color: active ? '#fff' : hovered ? 'var(--sf-cyan)' : 'var(--sf-fg-dim)',
        fontFamily: 'var(--sf-font-mono)',
      }}>{glyph}</div>
      <span style={{
        fontSize: 13.5, fontWeight: 600, lineHeight: 1.2,
        color: active ? 'var(--sf-amber)' : 'var(--sf-fg)',
        fontFamily: 'var(--sf-font-sans)',
      }}>{label}</span>
      <span style={{
        fontSize: 11.5, color: 'var(--sf-fg-dim)',
        fontFamily: 'var(--sf-font-mono)',
        lineHeight: 1.4,
      }}>{desc}</span>
    </button>
  )
}

function FieldRow({ field, value, custom, onPick, onCustom, isLast }: { field: CircuitField; value: unknown; custom: string; onPick: (opt: string) => void; onCustom: (val: string) => void; isLast: boolean }) {
  const [hoveredOpt, setHoveredOpt] = useState<string | null>(null)
  const picked = field.multi
    ? (Array.isArray(value) ? (value as string[]) : [])
    : (value as string | undefined)

  const hintText = hoveredOpt && field.hints?.[hoveredOpt]

  return (
    <div style={{
      padding: '14px 16px',
      borderBottom: isLast ? 'none' : '1px solid var(--sf-line)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{
          fontSize: 13, color: 'var(--sf-fg)', fontWeight: 500,
        }}>{field.label}</span>
        {field.required && (
          <span style={{
            fontFamily: 'var(--sf-font-mono)', fontSize: 10,
            color: 'var(--sf-amber)', letterSpacing: '0.06em',
          }}>REQUIRED</span>
        )}
        {field.multi && (
          <span style={{
            fontFamily: 'var(--sf-font-mono)', fontSize: 10,
            color: 'var(--sf-fg-dim)', letterSpacing: '0.06em',
          }}>MULTI</span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: hintText ? 6 : 8 }}>
        {field.options.map((opt, i) => {
          const active = field.multi ? (picked as string[]).includes(opt) : picked === opt
          const isRec = field.recommended === opt
          return (
            <div
              key={i}
              style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}
              onMouseEnter={() => setHoveredOpt(opt)}
              onMouseLeave={() => setHoveredOpt(null)}
            >
              <Chip active={active} onClick={() => onPick(opt)}>{opt}</Chip>
              {isRec && (
                <span style={{
                  position: 'absolute', top: -7, right: -4,
                  fontSize: 9, fontFamily: 'var(--sf-font-mono)',
                  fontWeight: 700, letterSpacing: '0.04em',
                  color: 'var(--sf-amber)',
                  background: 'var(--sf-amber-soft)',
                  border: '1px solid var(--sf-amber-line)',
                  borderRadius: 'var(--sf-r-pill)',
                  padding: '1px 5px',
                  pointerEvents: 'none',
                  lineHeight: 1.4,
                }}>추천</span>
              )}
            </div>
          )
        })}
      </div>
      {hintText && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 6,
          marginBottom: 8, padding: '6px 10px',
          background: 'var(--sf-bg-3)',
          border: '1px solid var(--sf-line)',
          borderRadius: 'var(--sf-r-sm)',
          animation: 'none',
        }}>
          <span style={{ color: 'var(--sf-cyan)', fontSize: 12, lineHeight: 1.5, flexShrink: 0 }}>›</span>
          <span style={{ fontSize: 12, color: 'var(--sf-fg-muted)', lineHeight: 1.5 }}>{hintText}</span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconWand size={13} />
        <input
          placeholder="직접 입력 (선택)"
          value={custom}
          onChange={e => onCustom(e.target.value)}
          style={{
            flex: 1, height: 30, padding: '0 12px',
            background: 'var(--sf-bg-3)',
            border: `1px solid ${custom ? 'var(--sf-amber-line)' : 'var(--sf-line)'}`,
            borderRadius: 'var(--sf-r-sm)',
            color: 'var(--sf-fg)', fontFamily: 'var(--sf-font-sans)', fontSize: 13,
            outline: 'none',
          }}
        />
      </div>
    </div>
  )
}
