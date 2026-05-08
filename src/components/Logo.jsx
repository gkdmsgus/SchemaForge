// ============================================================================
// Logo.jsx — SchemaForge wordmark + chip glyph.
// ----------------------------------------------------------------------------
//   The glyph is an amber chip with pin "ticks" on all four sides plus a
//   cyan trace flying off the upper-right corner — the same metaphor as
//   Sparky's antenna and the trace background.
// ============================================================================

import React from 'react';

export default function Logo({ size = 22, showWord = true, style }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        lineHeight: 1,
        ...style,
      }}
    >
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <rect x="8" y="8" width="32" height="32" rx="7"
              stroke="var(--sf-amber)" strokeWidth="2.2" fill="none" />
        <rect x="16" y="16" width="16" height="16" rx="2" fill="var(--sf-amber)" />
        <path
          d="M4 18h4M4 24h4M4 30h4M40 18h4M40 24h4M40 30h4M18 4v4M24 4v4M30 4v4M18 40v4M24 40v4M30 40v4"
          stroke="var(--sf-amber)" strokeWidth="2.2" strokeLinecap="round"
        />
        <path d="M36 8 Q44 8 44 16"
              stroke="var(--sf-cyan)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
        <circle cx="44" cy="16" r="2" fill="var(--sf-cyan)" />
      </svg>
      {showWord && (
        <span
          style={{
            fontFamily: 'var(--sf-font-sans)',
            fontWeight: 600,
            fontSize: size * 0.82,
            letterSpacing: '-0.02em',
            color: 'var(--sf-fg)',
          }}
        >
          schemaforge
        </span>
      )}
    </span>
  );
}
