// ============================================================================
// WizardPanel.jsx — composer + live generation view.
// ----------------------------------------------------------------------------
//   Houses the two earliest screens of the user journey:
//     1. composer   — empty prompt, category chips, example prompts
//     2. generating — live PCB trace draw with phase log
//
//   Pass `phase` to switch:
//     'composer'                                 → input UI
//     'analyzing' | 'routing' | 'placing' | 'done' → live generation UI
//
//   Hook up `onSubmit(prompt)` to your actual generator action; everything
//   else is presentational. Replace the existing wizard component with this
//   file and prop-thread accordingly.
// ============================================================================

import React, { useEffect, useState } from 'react';
import TraceField      from './TraceField.jsx';
import TraceGeneration from './TraceGeneration.jsx';
import Mascot          from './Mascot.jsx';
import FormComposer    from './FormComposer.jsx';
import {
  Button, Spinner,
  IconClose, IconCheck,
} from './primitives.jsx';

const PHASES = [
  { key: 'analyzing', label: '요구사항 분석',     note: 'GPT-4o · 부품 추론' },
  { key: 'routing',   label: '네트리스트 라우팅', note: 'skidl · 노드 연결'  },
  { key: 'placing',   label: '부품 배치 검증',     note: '풋프린트 매칭'      },
  { key: 'export',    label: 'KiCad .net 내보내기', note: '직렬화'            },
];

const PHASE_TO_IDX = {
  analyzing: 0,
  routing:   1,
  placing:   2,
  done:      4,
};

export default function WizardPanel({
  phase = 'composer',
  initialPrompt = '',
  currentPrompt = '',
  onSubmit,
  onCancel,
  logLines,
  tokensUsed = 1243,
  tokenBudget = 4096,
}) {
  if (phase === 'composer') {
    return <FormComposer onSubmit={onSubmit} />;
  }
  return (
    <Generating
      phase={phase}
      currentPrompt={currentPrompt}
      onCancel={onCancel}
      logLines={logLines}
      tokensUsed={tokensUsed}
      tokenBudget={tokenBudget}
    />
  );
}

// ─── Generating ────────────────────────────────────────────────────────────

const DEFAULT_LOG = [
  { ts: '12:04:33', kind: 'info',  msg: 'tavily search complete · 12 datasheets' },
  { ts: '12:04:34', kind: 'info',  msg: 'identified parts: BAT_9V, R_330, LED_RED ×3, NE555, C_10uF' },
  { ts: '12:04:35', kind: 'plan',  msg: 'astable multivibrator topology @ 1Hz' },
  { ts: '12:04:36', kind: 'plan',  msg: 'routing VCC → R1 → D1 ↘' },
  { ts: '12:04:37', kind: 'route', msg: 'connecting GND rail …', cursor: true },
];

function Generating({ phase, currentPrompt, onCancel, logLines, tokensUsed, tokenBudget }) {
  const currentIdx = PHASE_TO_IDX[phase] ?? 0;
  const lines = logLines ?? DEFAULT_LOG;
  const title = currentPrompt?.trim() || '회로 생성 중';
  const truncated = title.length > 50 ? title.slice(0, 50) + '…' : title;
  const cliPrompt = title.length > 60 ? title.slice(0, 60) + '…' : title;

  return (
    <div style={{ position: 'relative', minHeight: '100%', background: 'var(--sf-bg)', overflow: 'hidden' }}>
      <TraceField opacity={0.18} />
      <div style={{ position: 'relative', maxWidth: 1100, margin: '0 auto', padding: '40px 24px 80px' }}>
        {/* Header row */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 16, marginBottom: 24,
        }}>
          <div>
            <div className="sf-eyebrow" style={{ marginBottom: 8 }}>지금 만들고 있어요</div>
            <h2 className="sf-heading-l" style={{ maxWidth: 700 }}>
              {truncated}
            </h2>
            <p className="sf-body" style={{ marginTop: 6, fontFamily: 'var(--sf-font-mono)', fontSize: 13, maxWidth: 700, wordBreak: 'break-word' }}>
              <span style={{ color: 'var(--sf-cyan)' }}>$</span> forge generate "{cliPrompt}"
            </p>
          </div>
          <Button variant="outline" size="md" icon={<IconClose size={14} />} onClick={onCancel}>
            취소
          </Button>
        </div>

        {/* Body grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 24 }}>
          {/* Trace visual */}
          <div>
            <div style={{ position: 'relative' }}>
              <TraceGeneration phase={phase} height={420} />
              <NarrationBubble lines={lines} />
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Mascot state="working" size={44} />
                <div>
                  <div style={{ fontSize: 14, color: 'var(--sf-fg)', fontWeight: 500 }}>
                    Sparky가 회로를 짜고 있어요
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--sf-fg-dim)', marginTop: 2 }}>
                    토큰 {tokensUsed.toLocaleString()} / {tokenBudget.toLocaleString()}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {PHASES.map((_, i) => (
                  <span
                    key={i}
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: i <= Math.min(currentIdx, PHASES.length - 1)
                        ? 'var(--sf-amber)'
                        : 'var(--sf-line-strong)',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Right column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{
              background: 'var(--sf-bg-2)', border: '1px solid var(--sf-line)',
              borderRadius: 'var(--sf-r-md)', padding: 6,
            }}>
              {PHASES.map((p, i) => {
                const state = i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'idle';
                return (
                  <div
                    key={p.key}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10,
                      padding: '12px 14px', borderRadius: 'var(--sf-r-sm)',
                      background: state === 'active' ? 'var(--sf-amber-soft)' : 'transparent',
                    }}
                  >
                    <span style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background:
                        state === 'done'   ? 'var(--sf-cyan)'  :
                        state === 'active' ? 'var(--sf-amber)' : 'var(--sf-bg-3)',
                      color: state === 'idle' ? 'var(--sf-fg-faint)' : '#11140f',
                      marginTop: 2,
                    }}>
                      {state === 'done'   ? <IconCheck size={11} />
                       : state === 'active' ? <Spinner size={11} color="#11140f" />
                       : <span style={{ fontSize: 10, fontFamily: 'var(--sf-font-mono)' }}>{i + 1}</span>}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13,
                        color: state === 'idle' ? 'var(--sf-fg-dim)' : 'var(--sf-fg)',
                        fontWeight: state === 'active' ? 500 : 400,
                      }}>
                        {p.label}
                      </div>
                      <div style={{
                        fontSize: 11, color: 'var(--sf-fg-dim)', marginTop: 2,
                        fontFamily: 'var(--sf-font-mono)',
                      }}>
                        {p.note}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <pre style={{
              margin: 0,
              background: '#06070a', border: '1px solid var(--sf-line)',
              borderRadius: 'var(--sf-r-md)',
              padding: 14,
              fontFamily: 'var(--sf-font-mono)', fontSize: 11.5, lineHeight: 1.7,
              color: 'var(--sf-fg-muted)',
              maxHeight: 220, overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}>
              {lines.map((l, i) => (
                <div key={i} style={{ color: l.kind === 'route' ? 'var(--sf-fg)' : 'var(--sf-fg-dim)' }}>
                  [{l.ts}] <span style={{
                    color: l.kind === 'info' ? 'var(--sf-cyan)' : 'var(--sf-amber)',
                  }}>{l.kind}</span> {l.msg}
                  {l.cursor && <span style={{ animation: 'sf-pulse 1.2s infinite' }}>▍</span>}
                </div>
              ))}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Narration bubble (flux-style speech overlay) ─────────────────────────

function pickNarration(lines) {
  if (!lines?.length) return null;
  // Prefer the line marked with cursor (active), else the last non-info line, else last.
  const active = lines.find(l => l.cursor);
  if (active) return active;
  return lines[lines.length - 1];
}

function humanizeMsg(raw) {
  if (!raw) return '';
  let m = raw.replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]\s*/u, ''); // strip leading emoji
  // Translate common english status into Korean phrasing
  if (/searching/i.test(m))     return '데이터시트 찾는 중이에요...';
  if (/analy[sz]ing/i.test(m))  return 'GPT가 부품·토폴로지 추론 중...';
  if (/generating/i.test(m))    return '네트리스트 빌드 중...';
  if (/fixing/i.test(m))        return '코드 오류 발견, 자동 수정하고 있어요...';
  if (/done/i.test(m))          return '완성! 곧 결과를 보여드릴게요.';
  return m.length > 80 ? m.slice(0, 78) + '…' : m;
}

function NarrationBubble({ lines }) {
  const active = pickNarration(lines);
  const text = humanizeMsg(active?.msg || '');
  const [show, setShow] = useState(false);
  const [bumpKey, setBumpKey] = useState(0);

  useEffect(() => {
    if (!text) { setShow(false); return; }
    setBumpKey(k => k + 1);
    setShow(true);
  }, [text]);

  if (!text) return null;

  return (
    <div
      key={bumpKey}
      style={{
        position: 'absolute',
        top: 16, left: 16,
        maxWidth: 'calc(100% - 32px)',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        background: 'linear-gradient(135deg, rgba(146, 88, 224, 0.22), rgba(116, 70, 188, 0.16))',
        border: '1px solid rgba(170, 110, 255, 0.45)',
        boxShadow: '0 8px 28px rgba(120, 60, 220, 0.25), 0 0 0 1px rgba(255,255,255,0.04) inset',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: 14,
        padding: '10px 14px 10px 12px',
        animation: show ? 'sf-bubble-in 320ms cubic-bezier(.22,1,.36,1) both' : 'none',
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <div style={{
        flexShrink: 0, marginTop: 1,
        width: 22, height: 22, borderRadius: '50%',
        background: 'linear-gradient(135deg, #c89cff, #8a5dd8)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 0 0 2px rgba(0,0,0,0.3), 0 0 12px rgba(170,110,255,0.6)',
      }}>
        <span style={{ fontSize: 12, color: '#fff', fontWeight: 700, lineHeight: 1 }}>✦</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 10, color: 'rgba(220, 200, 255, 0.85)',
          fontFamily: 'var(--sf-font-mono)', letterSpacing: '0.14em',
          textTransform: 'uppercase', marginBottom: 2,
        }}>
          Sparky · AI 작업 중
        </div>
        <div style={{
          fontSize: 13, color: '#f3eaff', lineHeight: 1.45, fontWeight: 500,
          maxWidth: 360,
        }}>
          {text}
          <span style={{
            display: 'inline-block', marginLeft: 6,
            width: 6, height: 6, borderRadius: '50%',
            background: '#c89cff',
            animation: 'sf-pulse 1.2s ease-in-out infinite',
            verticalAlign: 'middle',
          }} />
        </div>
      </div>
    </div>
  );
}
