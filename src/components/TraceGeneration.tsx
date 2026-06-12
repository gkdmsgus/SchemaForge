// ============================================================================
// TraceGeneration.jsx — animated schematic that "draws itself" while the
// LLM is generating a circuit.
// ----------------------------------------------------------------------------
//   The component takes a `phase` prop. As the phase advances, traces and
//   nodes activate in sequence — visually, the schematic literally wires
//   itself together in front of the user. Use this in WizardPanel during
//   generation, and freeze it on phase="done" for the result view.
//
//   Phases:  idle → analyzing → routing → placing → done
// ============================================================================

import React from 'react'

const PHASE_ORDER = ['idle', 'analyzing', 'routing', 'placing', 'done'];

const NODES = [
  { id: 'vcc',  x: 120, y:  80, label: 'VCC', phase: 1 },
  { id: 'r1',   x: 300, y:  80, label: 'R1',  phase: 1 },
  { id: 'led',  x: 480, y:  80, label: 'D1',  phase: 2 },
  { id: 'gnd',  x: 480, y: 280, label: 'GND', phase: 3 },
  { id: 'ctrl', x: 120, y: 280, label: 'MCU', phase: 2 },
  { id: 'sw',   x: 300, y: 280, label: 'SW1', phase: 3 },
];

const TRACES = [
  { d: 'M 130 80 L 290 80',   phase: 1 },
  { d: 'M 310 80 L 470 80',   phase: 2 },
  { d: 'M 480 90 L 480 270',  phase: 3 },
  { d: 'M 470 280 L 310 280', phase: 3 },
  { d: 'M 290 280 L 130 280', phase: 3 },
  { d: 'M 120 270 L 120 90',  phase: 1 },
];

export default function TraceGeneration({ phase = 'idle', height = 360, style }: { phase?: string; height?: number; style?: React.CSSProperties }) {
  const p = PHASE_ORDER.indexOf(phase);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height,
        background: 'var(--sf-bg-2)',
        borderRadius: 'var(--sf-r-md)',
        border: '1px solid var(--sf-line)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* faint grid */}
      <svg
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.4 }}
        viewBox="0 0 600 360"
      >
        <defs>
          <pattern id="sf-tg-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="var(--sf-line)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="600" height="360" fill="url(#sf-tg-grid)" />
      </svg>

      <svg
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        viewBox="0 0 600 360"
      >
        {/* Traces */}
        {TRACES.map((t, i) => {
          const active = p >= t.phase;
          return (
            <path
              key={i}
              d={t.d}
              stroke={active ? 'var(--sf-amber)' : 'var(--sf-line-trace)'}
              strokeWidth={active ? 2 : 1.5}
              fill="none"
              strokeDasharray={active ? '300' : '0'}
              strokeDashoffset={active ? '300' : '0'}
              style={{
                animation: active
                  ? `sf-trace-draw 0.8s ${i * 0.12}s var(--sf-ease-out) forwards`
                  : 'none',
                filter: active ? 'drop-shadow(0 0 6px rgba(255,181,71,0.4))' : 'none',
              }}
            />
          );
        })}

        {/* Nodes */}
        {NODES.map((n) => {
          const active = p >= n.phase;
          return (
            <g
              key={n.id}
              opacity={active ? 1 : 0.35}
              style={{ transition: 'opacity 0.4s var(--sf-ease)' }}
            >
              <circle
                cx={n.x} cy={n.y} r="10"
                fill="var(--sf-bg-2)"
                stroke={active ? 'var(--sf-amber)' : 'var(--sf-line-trace)'}
                strokeWidth="1.8"
              />
              <circle
                cx={n.x} cy={n.y} r="4"
                fill={active ? 'var(--sf-amber)' : 'var(--sf-line-strong)'}
              />
              {active && (
                <circle
                  cx={n.x} cy={n.y} r="12"
                  fill="none"
                  stroke="var(--sf-amber)"
                  strokeOpacity="0.4"
                  style={{ animation: 'sf-node-pulse 1.6s infinite' }}
                />
              )}
              <text
                x={n.x} y={n.y - 18}
                fontFamily="var(--sf-font-mono)" fontSize="10"
                fill={active ? 'var(--sf-fg-muted)' : 'var(--sf-fg-faint)'}
                textAnchor="middle" letterSpacing="0.08em"
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
