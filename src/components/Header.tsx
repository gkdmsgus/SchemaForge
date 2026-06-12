// ============================================================================
// Header.jsx — top app bar.
// ----------------------------------------------------------------------------
//   Sticky, blurred, sits above the trace background. Houses the logo,
//   model status pill, and quick-access actions (history / settings).
//
//   This replaces whatever Header lives at the top of the existing app shell.
//   If your old Header had a router-aware nav, lift just the nav <ul> in
//   from the old file — everything else here is brand-new.
// ============================================================================

import React from 'react';
import Logo from './Logo.tsx';
import { Button, IconSettings } from './primitives.tsx';
import type { AuthUser } from '../api';

function HamburgerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="3.5" width="14" height="1.5" rx="0.75" fill="currentColor" />
      <rect x="1" y="7.25" width="14" height="1.5" rx="0.75" fill="currentColor" />
      <rect x="1" y="11" width="14" height="1.5" rx="0.75" fill="currentColor" />
    </svg>
  )
}

interface HeaderProps {
  variant?: string
  modelLabel?: string
  modelStatus?: 'ready' | 'busy' | 'offline'
  onSettingsClick?: () => void
  onLogoClick?: () => void
  onMenuClick?: () => void
  user?: AuthUser | null
  onAuthClick?: () => void
  onLogout?: () => void
}

export default function Header({
  variant = 'app',
  modelLabel = 'GPT-4o',
  modelStatus = 'ready',
  onSettingsClick,
  onLogoClick,
  onMenuClick,
  user,
  onAuthClick,
  onLogout,
}: HeaderProps) {
  const dotColor = {
    ready:   'var(--sf-cyan)',
    busy:    'var(--sf-amber)',
    offline: 'var(--sf-fg-faint)',
  }[modelStatus] ?? 'var(--sf-cyan)';

  return (
    <header
      style={{
        position: 'sticky', top: 0, zIndex: 30,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 28px',
        borderBottom: '2px solid var(--sf-line-strong)',
        background: 'rgba(241, 236, 224, 0.88)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {onMenuClick && (
          <button
            onClick={onMenuClick}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--sf-fg-dim)', padding: '4px 6px', borderRadius: 6,
              display: 'flex', alignItems: 'center',
              transition: 'color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--sf-fg)'; e.currentTarget.style.background = 'var(--sf-bg-2)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--sf-fg-dim)'; e.currentTarget.style.background = 'none' }}
            aria-label="메뉴"
          >
            <HamburgerIcon />
          </button>
        )}
        <div
          onClick={onLogoClick}
          style={{ display: 'flex', alignItems: 'center', gap: 24, cursor: onLogoClick ? 'pointer' : 'default' }}
        >
          <Logo size={22} />
          <span
            style={{
              fontFamily: 'var(--sf-font-mono)',
              fontSize: 11,
              color: 'var(--sf-fg-dim)',
              letterSpacing: '0.1em',
            }}
          >
            v0.4 · {variant}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: 'var(--sf-bg-2)',
            border: '1px solid var(--sf-line)',
            fontFamily: 'var(--sf-font-mono)',
            fontSize: 11, color: 'var(--sf-fg-muted)',
            letterSpacing: '0.04em',
          }}
        >
          <span
            style={{
              width: 6, height: 6, borderRadius: '50%',
              background: dotColor,
              boxShadow: `0 0 6px ${dotColor}`,
            }}
          />
          {modelLabel} · {modelStatus}
        </span>
        {user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--sf-fg-dim)', fontFamily: 'var(--sf-font-mono)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email}
            </span>
            <button
              onClick={onLogout}
              style={{ background: 'none', border: '1px solid var(--sf-line-strong)', borderRadius: 6, color: 'var(--sf-fg-dim)', cursor: 'pointer', fontSize: 11, padding: '3px 8px', fontFamily: 'var(--sf-font-mono)' }}
            >로그아웃</button>
          </div>
        ) : (
          <button
            onClick={onAuthClick}
            style={{ background: 'var(--sf-amber-soft)', border: '1px solid var(--sf-amber-line)', borderRadius: 6, color: 'var(--sf-amber)', cursor: 'pointer', fontSize: 12, padding: '5px 12px', fontFamily: 'var(--sf-font-mono)', fontWeight: 600 }}
          >로그인</button>
        )}
        <Button variant="ghost" size="sm" icon={<IconSettings size={14} />} onClick={onSettingsClick} aria-label="Settings" />
      </div>
    </header>
  );
}
