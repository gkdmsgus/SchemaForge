// ============================================================================
// TraceField.jsx — ambient PCB-trace background.
// ----------------------------------------------------------------------------
//   Drop into any container with `position: relative`. Stretches to fill,
//   ignores pointer events, sits at low opacity. This is the *signature*
//   visual of the SchemaForge brand — keep it visible but never loud.
//
//   <div style={{position:'relative'}}>
//     <TraceField opacity={0.22} />
//     ... your content ...
//   </div>
// ============================================================================


const PATHS = [
  { d: 'M 0 80 L 200 80 L 200 160 L 420 160',                       node: [420, 160] },
  { d: 'M 0 220 L 120 220 L 120 300 L 300 300 L 300 200 L 560 200', node: [560, 200] },
  { d: 'M 100 0 L 100 60 L 260 60 L 260 140',                        node: [260, 140] },
  { d: 'M 340 0 L 340 80 L 440 80 L 440 180',                        node: [440, 180] },
  { d: 'M 500 0 L 500 100 L 620 100 L 620 260',                      node: [620, 260] },
  { d: 'M 0 380 L 160 380 L 160 460 L 340 460',                      node: [340, 460] },
  { d: 'M 240 520 L 240 400 L 400 400 L 400 520',                    node: [400, 520] },
  { d: 'M 500 540 L 500 380 L 660 380',                              node: [660, 380] },
  { d: 'M 60 540 L 60 460 L 180 460',                                node: [180, 460] },
  { d: 'M 480 540 L 480 460 L 340 460',                              node: null },
];

import React, { CSSProperties } from 'react'

export default function TraceField({
  density = 1,
  accent  = 'amber',
  opacity = 0.22,
  style,
}: {
  density?: number
  accent?: string
  opacity?: number
  style?: CSSProperties
}) {
  const color = accent === 'cyan' ? 'var(--sf-cyan)' : 'var(--sf-amber)';
  const slice = PATHS.slice(0, Math.ceil(PATHS.length * density));

  return (
    <svg
      viewBox="0 0 720 560"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity,
        ...style,
      }}
    >
      {slice.map((p, i) => (
        <g key={i}>
          <path d={p.d} stroke={color} strokeWidth="1" fill="none" opacity="0.55" />
          {p.node && (
            <>
              <circle cx={p.node[0]} cy={p.node[1]} r="2.5" fill={color} />
              <circle cx={p.node[0]} cy={p.node[1]} r="5"   fill="none" stroke={color} strokeOpacity="0.35" />
            </>
          )}
        </g>
      ))}
    </svg>
  );
}
