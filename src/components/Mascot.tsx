// ============================================================================
// Mascot.jsx — "Sparky" the SchemaForge mascot.
// ----------------------------------------------------------------------------
//   Sparky is a chip-shaped mascot with three states:
//     idle    — neutral, gentle eyes, antenna at rest
//     working — closed/squinting eyes, sparkle radiating from antenna
//     ready   — wide eyes + smile, ambient particles
//
//   We import the SVGs as static URLs (works with Vite, Webpack 5, CRA).
//   If your bundler doesn't support `?url` imports, just replace these with
//   plain string paths or move the SVGs to /public.
// ============================================================================

import React from 'react'


import sparkyIdle    from '../assets/sparky-idle.svg';
import sparkyWorking from '../assets/sparky-working.svg';
import sparkyReady   from '../assets/sparky-ready.svg';

const SOURCES = {
  idle:    sparkyIdle,
  working: sparkyWorking,
  ready:   sparkyReady,
};

/**
 * <Mascot state="idle" size={56} />
 * @param {'idle'|'working'|'ready'} state
 * @param {number} size  rendered px (square)
 */
export default function Mascot({ state = 'idle', size = 56, alt = 'Sparky', style, ...rest }: {
  state?: 'idle' | 'working' | 'ready'
  size?: number
  alt?: string
  style?: React.CSSProperties
  [key: string]: unknown
}) {
  const src = SOURCES[state] ?? SOURCES.idle;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={alt}
      draggable={false}
      style={{
        display: 'block',
        userSelect: 'none',
        // a tiny breath while working
        animation: state === 'working' ? 'sf-mascot-breath 2.4s ease-in-out infinite' : 'none',
        ...style,
      }}
      {...rest}
    />
  );
}

// Inject the breath keyframe once on first import.
if (typeof document !== 'undefined' && !document.getElementById('sf-mascot-styles')) {
  const s = document.createElement('style');
  s.id = 'sf-mascot-styles';
  s.textContent = `
    @keyframes sf-mascot-breath {
      0%, 100% { transform: translateY(0)    scale(1);    }
      50%      { transform: translateY(-2px) scale(1.02); }
    }
  `;
  document.head.appendChild(s);
}
