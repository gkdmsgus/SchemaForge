import { useState } from 'react'
import TraceField from './TraceField.jsx'
import Mascot from './Mascot.jsx'
import { Button, Chip, IconBolt, IconWand } from './primitives.jsx'

const CIRCUIT_TYPES = [
  {
    key: 'amp',
    label: '오디오 앰프',
    desc: '프리/파워앰프, 헤드폰, 기타·베이스',
    glyph: '〜',
    fields: [
      { key: 'subtype', label: '앰프 종류', required: true,
        options: ['프리앰프', '파워앰프', '헤드폰 앰프', '기타 프리앰프', '베이스 프리앰프'] },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['9V 배터리', '12V', '±15V', 'USB 5V'] },
      { key: 'gain', label: '이득',
        options: ['20dB', '30dB', '40dB', '60dB'] },
      { key: 'extras', label: '부가 기능', multi: true,
        options: ['전원 LED', '볼륨 조절', '톤 컨트롤', '뮤트 스위치', '입력 보호'] },
    ],
  },
  {
    key: 'led',
    label: 'LED 제어',
    desc: '점등 · 점멸 · 순차 · PWM 디밍',
    glyph: '●',
    fields: [
      { key: 'subtype', label: '동작', required: true,
        options: ['단순 점등', '점멸 (블링크)', '순차 점멸 (체이서)', 'PWM 디밍', 'RGB 페이드'] },
      { key: 'count', label: 'LED 개수', required: true,
        options: ['1', '3', '5', '8', '10+'] },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V', '9V', '12V'] },
      { key: 'color', label: '색상',
        options: ['빨강', '초록', '파랑', '노랑', 'RGB', '혼합'] },
    ],
  },
  {
    key: 'power',
    label: '전원 회로',
    desc: '레귤레이터 · Buck · Boost · 충전기',
    glyph: '⚡',
    fields: [
      { key: 'subtype', label: '종류', required: true,
        options: ['선형 레귤레이터', 'Buck (강압)', 'Boost (승압)', 'Buck-Boost', '리튬 충전기'] },
      { key: 'vin', label: '입력 전압', required: true,
        options: ['USB 5V', '7-12V', '12-24V', '리튬 1셀 (3.7V)'] },
      { key: 'vout', label: '출력 전압', required: true,
        options: ['1.8V', '3.3V', '5V', '9V', '12V'] },
      { key: 'iout', label: '출력 전류',
        options: ['100mA', '500mA', '1A', '2A 이상'] },
    ],
  },
  {
    key: 'timer',
    label: '타이머 / 펄스',
    desc: '555 · One-shot · PWM · 디바운스',
    glyph: '⏱',
    fields: [
      { key: 'subtype', label: '동작', required: true,
        options: ['단안정 (One-shot)', '비안정 (점멸)', 'PWM 발생기', '버튼 디바운스'] },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V', '9V', '12V'] },
      { key: 'freq', label: '주파수 / 시간',
        options: ['1Hz', '10Hz', '100Hz', '1kHz', '10kHz'] },
    ],
  },
  {
    key: 'sensor',
    label: '센서 입력',
    desc: '온도 · 거리 · 조도 · 버튼',
    glyph: '⌖',
    fields: [
      { key: 'subtype', label: '센서 종류', required: true,
        options: ['온도', '습도', '조도', '거리 (초음파)', '거리 (IR)', '버튼 / 스위치', '모션'] },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V'] },
      { key: 'output', label: '출력 인터페이스',
        options: ['아날로그', '디지털', 'I²C', 'SPI', 'UART'] },
    ],
  },
  {
    key: 'mcu',
    label: 'MCU 보드',
    desc: 'ATmega · ESP32 · STM32 · RP2040',
    glyph: '▦',
    fields: [
      { key: 'subtype', label: 'MCU', required: true,
        options: ['ATmega328P', 'ATtiny85', 'ESP32', 'STM32 (Blue Pill)', 'RP2040', 'Arduino Nano'] },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V'] },
      { key: 'extras', label: '주변 회로', multi: true,
        options: ['리셋 버튼', '전원 LED', '크리스털', 'ICSP 헤더', 'USB-UART', '디커플링'] },
    ],
  },
  {
    key: 'filter',
    label: '필터 회로',
    desc: 'LPF · HPF · BPF · Notch',
    glyph: '⌒',
    fields: [
      { key: 'subtype', label: '필터 종류', required: true,
        options: ['LPF (저역)', 'HPF (고역)', 'BPF (대역)', 'Notch'] },
      { key: 'topo', label: '구성',
        options: ['수동 RC', '액티브 1차', '액티브 2차 (Sallen-Key)'] },
      { key: 'fc', label: '컷오프',
        options: ['100Hz', '1kHz', '10kHz', '100kHz'] },
    ],
  },
  {
    key: 'logic',
    label: '디지털 로직',
    desc: '게이트 · 플립플롭 · 카운터',
    glyph: '◫',
    fields: [
      { key: 'subtype', label: '구성', required: true,
        options: ['AND/OR/NOT 게이트', 'XOR/XNOR', 'D 플립플롭', 'JK 플립플롭', '카운터', '시프트 레지스터', '디코더 (74138)'] },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V'] },
      { key: 'family', label: '로직 패밀리',
        options: ['74HC (CMOS)', '74LS (TTL)', '4000 시리즈'] },
    ],
  },
  {
    key: 'comms',
    label: '통신 / 인터페이스',
    desc: 'USB-UART · RS-485 · CAN',
    glyph: '⇄',
    fields: [
      { key: 'subtype', label: '인터페이스', required: true,
        options: ['USB-UART (CH340/CP2102)', 'RS-232 (MAX232)', 'RS-485 (MAX485)', 'CAN 트랜시버', 'I²C 레벨 시프터', 'Bluetooth 모듈'] },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V', '듀얼 (3.3V/5V)'] },
      { key: 'extras', label: '부가 기능', multi: true,
        options: ['ESD 보호', '전원 LED', 'TX/RX LED', '터미널 저항'] },
    ],
  },
  {
    key: 'display',
    label: '디스플레이',
    desc: '7세그·LCD·OLED·LED 매트릭스',
    glyph: '▤',
    fields: [
      { key: 'subtype', label: '디스플레이 종류', required: true,
        options: ['7-세그먼트 (1자리)', '7-세그먼트 (4자리)', '캐릭터 LCD 16x2', 'OLED 0.96" I²C', 'OLED 1.3" SPI', 'LED 매트릭스 8x8', 'LED 바'] },
      { key: 'voltage', label: '공급 전압', required: true,
        options: ['3.3V', '5V'] },
      { key: 'driver', label: '드라이버',
        options: ['직접 구동', '74HC595 (시프트)', 'MAX7219', 'TM1637', 'I²C 백팩'] },
    ],
  },
  {
    key: 'motor',
    label: '모터 드라이버',
    desc: 'DC · 스텝 · 서보 · BLDC',
    glyph: '◐',
    fields: [
      { key: 'subtype', label: '모터 종류', required: true,
        options: ['DC 모터 (단방향)', 'DC 모터 (양방향, H-브리지)', '스텝 모터 (바이폴라)', '스텝 모터 (유니폴라)', '서보 모터', 'BLDC'] },
      { key: 'driver', label: '드라이버 IC',
        options: ['L298N', 'TB6612FNG', 'DRV8833', 'A4988', 'DRV8825', 'ULN2003'] },
      { key: 'vmotor', label: '모터 전압', required: true,
        options: ['5V', '6V', '12V', '24V'] },
      { key: 'iout', label: '모터 전류',
        options: ['500mA', '1A', '2A', '3A 이상'] },
    ],
  },
]

function fieldHasValue(field, values, customs) {
  const c = customs[field.key]?.trim()
  if (c) return true
  const v = values[field.key]
  if (field.multi) return Array.isArray(v) && v.length > 0
  return !!v
}

function fieldValueString(field, values, customs) {
  const c = customs[field.key]?.trim()
  if (c) return c
  const v = values[field.key]
  if (field.multi) return Array.isArray(v) && v.length ? v.join(', ') : null
  return v || null
}

export default function FormComposer({ onSubmit }) {
  const [typeKey, setTypeKey] = useState(null)
  const [values, setValues] = useState({})
  const [customs, setCustoms] = useState({})
  const [heroText, setHeroText] = useState('')

  const type = CIRCUIT_TYPES.find(t => t.key === typeKey)

  const requiredFilled = !type ? false :
    type.fields.filter(f => f.required).every(f => fieldHasValue(f, values, customs))

  const canSubmit = (type && requiredFilled) || (!type && heroText.trim().length >= 4)

  function chooseType(key) {
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

  function pickSingle(fieldKey, opt) {
    setValues(v => ({ ...v, [fieldKey]: v[fieldKey] === opt ? '' : opt }))
    setCustoms(c => ({ ...c, [fieldKey]: '' }))
  }

  function toggleMulti(fieldKey, opt) {
    setValues(v => {
      const cur = Array.isArray(v[fieldKey]) ? v[fieldKey] : []
      return { ...v, [fieldKey]: cur.includes(opt) ? cur.filter(x => x !== opt) : [...cur, opt] }
    })
  }

  function setCustom(fieldKey, val) {
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
    onSubmit?.(buildPrompt(), typeKey)
  }

  return (
    <div style={{ position: 'relative', minHeight: '100%', background: 'var(--sf-bg)', overflow: 'hidden' }}>
      <TraceField opacity={0.22} />
      <div style={{ position: 'relative', maxWidth: 920, margin: '0 auto', padding: '64px 24px 96px' }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <Mascot state="idle" size={64} style={{ margin: '0 auto 20px' }} />
          <div className="sf-eyebrow" style={{ marginBottom: 12 }}>AI · CIRCUIT · DESIGN</div>
          <h1 className="sf-display-l" style={{ textWrap: 'balance', marginBottom: 12 }}>
            어떤 회로를 <span style={{ color: 'var(--sf-amber)' }}>만들까요?</span>
          </h1>
          <p className="sf-body-l" style={{ maxWidth: 540, margin: '0 auto' }}>
            한 줄로 설명하거나, 카테고리에서 사양을 골라 주세요.
          </p>
        </div>

        {/* Hero free-text entry */}
        <div style={{ marginBottom: 32 }}>
          <div style={{
            position: 'relative',
            background: 'var(--sf-bg-2)',
            border: '1px solid var(--sf-line-strong)',
            borderRadius: 'var(--sf-r-lg)',
            boxShadow: 'var(--sf-shadow-md)',
            overflow: 'hidden',
          }}>
            <textarea
              value={heroText}
              onChange={e => setHeroText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder="만들고 싶은 회로를 자유롭게 적어 주세요. 예: 9V 배터리로 빨간 LED 3개를 1초 간격으로 점멸"
              style={{
                width: '100%', minHeight: 108,
                background: 'transparent', border: 'none', outline: 'none',
                padding: '20px 22px 60px',
                color: 'var(--sf-fg)',
                fontFamily: 'var(--sf-font-sans)',
                fontSize: 16, lineHeight: 1.55,
                resize: 'none',
                boxSizing: 'border-box',
                display: 'block',
              }}
            />
            <div style={{
              position: 'absolute', right: 12, bottom: 12,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span style={{
                fontSize: 11, color: 'var(--sf-fg-dim)',
                fontFamily: 'var(--sf-font-mono)', letterSpacing: '0.06em',
              }}>⌘ + ↵</span>
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
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            marginTop: 18, marginBottom: 4,
          }}>
            <span style={{ flex: 1, height: 1, background: 'var(--sf-line)' }} />
            <span style={{
              fontSize: 11, color: 'var(--sf-fg-dim)',
              fontFamily: 'var(--sf-font-mono)', letterSpacing: '0.18em',
              textTransform: 'uppercase',
            }}>또는 카테고리에서 시작</span>
            <span style={{ flex: 1, height: 1, background: 'var(--sf-line)' }} />
          </div>
        </div>

        {/* Step 1: Circuit type cards */}
        <SectionLabel num="01" title="회로 종류" />
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10,
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

      <div style={{
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

function WorkflowCard({ step, isLast }) {
  return (
    <div style={{
      position: 'relative',
      background: 'var(--sf-bg-2)',
      border: '1px solid var(--sf-line)',
      borderRadius: 'var(--sf-r-md)',
      padding: '20px 18px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{
          fontFamily: 'var(--sf-font-mono)', fontSize: 11,
          color: 'var(--sf-amber)', letterSpacing: '0.14em',
          padding: '3px 8px',
          background: 'var(--sf-amber-soft)',
          border: '1px solid var(--sf-amber-line)',
          borderRadius: 'var(--sf-r-pill)',
        }}>{step.num}</span>
        {!isLast && (
          <span style={{
            flex: 1, height: 1,
            background: 'linear-gradient(to right, var(--sf-line-strong), transparent)',
          }} />
        )}
      </div>
      <h3 style={{
        margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--sf-fg)',
        fontFamily: 'var(--sf-font-sans)',
      }}>{step.title}</h3>
      <p style={{
        margin: 0, fontSize: 12.5, lineHeight: 1.55,
        color: 'var(--sf-fg-muted)',
      }}>{step.desc}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {step.bullets.map((b, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: 'var(--sf-fg-dim)',
            fontFamily: 'var(--sf-font-mono)',
          }}>
            <span style={{ color: 'var(--sf-cyan)' }}>›</span>
            {b}
          </div>
        ))}
      </div>
    </div>
  )
}

function SectionLabel({ num, title }) {
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

function TypeCard({ active, glyph, label, desc, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6,
        padding: '14px 16px',
        background: active ? 'var(--sf-amber-soft)' : 'var(--sf-bg-2)',
        border: `1px solid ${active ? 'var(--sf-amber-line)' : 'var(--sf-line)'}`,
        borderRadius: 'var(--sf-r-md)',
        cursor: 'pointer', textAlign: 'left',
        transition: 'all var(--sf-dur) var(--sf-ease)',
      }}
      onMouseEnter={ev => {
        if (!active) {
          ev.currentTarget.style.borderColor = 'var(--sf-line-strong)'
          ev.currentTarget.style.background = 'var(--sf-bg-3)'
        }
      }}
      onMouseLeave={ev => {
        if (!active) {
          ev.currentTarget.style.borderColor = 'var(--sf-line)'
          ev.currentTarget.style.background = 'var(--sf-bg-2)'
        }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 16, color: active ? 'var(--sf-amber)' : 'var(--sf-cyan)',
          fontFamily: 'var(--sf-font-mono)',
        }}>{glyph}</span>
        <span style={{
          fontSize: 14, fontWeight: 600,
          color: active ? 'var(--sf-amber)' : 'var(--sf-fg)',
        }}>{label}</span>
      </div>
      <span style={{
        fontSize: 12, color: 'var(--sf-fg-dim)',
        fontFamily: 'var(--sf-font-mono)',
      }}>{desc}</span>
    </button>
  )
}

function FieldRow({ field, value, custom, onPick, onCustom, isLast }) {
  const picked = field.multi
    ? (Array.isArray(value) ? value : [])
    : value
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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {field.options.map((opt, i) => {
          const active = field.multi ? picked.includes(opt) : picked === opt
          return (
            <Chip key={i} active={active} onClick={() => onPick(opt)}>{opt}</Chip>
          )
        })}
      </div>
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
