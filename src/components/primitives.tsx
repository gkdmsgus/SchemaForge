import { useState, CSSProperties, ReactNode, ButtonHTMLAttributes } from 'react';

// ── Spinner ────────────────────────────────────────────────────────────────

interface SpinnerProps {
  size?: number
  color?: string
}

export function Spinner({ size = 16, color = 'currentColor' }: SpinnerProps) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      style={{ animation: 'sf-spin 0.8s linear infinite' }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke={color} strokeOpacity="0.2" strokeWidth="2.5" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke={color} strokeWidth="2.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

// ── Button ─────────────────────────────────────────────────────────────────

type BtnSize = 'sm' | 'md' | 'lg' | 'pill'
type BtnVariant = 'primary' | 'cyan' | 'secondary' | 'ghost' | 'outline' | 'danger'

const BTN_SIZES: Record<BtnSize, CSSProperties> = {
  sm:   { height: 28, padding: '0 10px', fontSize: 13, borderRadius: 'var(--sf-r-sm)' },
  md:   { height: 36, padding: '0 14px', fontSize: 14, borderRadius: 'var(--sf-r-sm)' },
  lg:   { height: 44, padding: '0 20px', fontSize: 15, borderRadius: 'var(--sf-r-sm)' },
  pill: { height: 40, padding: '0 20px', fontSize: 14, borderRadius: 'var(--sf-r-pill)' },
};

// border as separate width/style/colour: the hover styles change only borderColor, and React warns when
// a shorthand and its longhand meet in one style object
const BTN_VARIANTS: Record<BtnVariant, CSSProperties> = {
  primary:   { background: 'var(--sf-amber)',   color: '#fff8ef',            borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--sf-amber)' },
  cyan:      { background: 'var(--sf-cyan)',    color: '#f4f7f2',            borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--sf-cyan)' },
  secondary: { background: 'var(--sf-bg-3)',    color: 'var(--sf-fg)',       borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--sf-line-strong)' },
  ghost:     { background: 'transparent',       color: 'var(--sf-fg-muted)', borderWidth: 1, borderStyle: 'solid', borderColor: 'transparent' },
  outline:   { background: 'transparent',       color: 'var(--sf-fg)',       borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--sf-line-strong)' },
  danger:    { background: 'transparent',       color: 'var(--sf-danger)',   borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(255,106,91,0.4)' },
};

const BTN_HOVER: Record<BtnVariant, CSSProperties> = {
  primary:   { background: 'var(--sf-amber-deep)', borderColor: 'var(--sf-amber-deep)' },
  cyan:      { background: '#5e948a' },
  secondary: { background: 'var(--sf-bg-4)', borderColor: 'var(--sf-fg-faint)' },
  ghost:     { background: 'var(--sf-bg-3)', color: 'var(--sf-fg)' },
  outline:   { background: 'var(--sf-bg-3)', borderColor: 'var(--sf-fg-faint)' },
  danger:    { background: 'rgba(255,106,91,0.1)' },
};

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  variant?: BtnVariant
  size?: BtnSize
  icon?: ReactNode
  trailingIcon?: ReactNode
  loading?: boolean
  onClick?: () => void
  children?: ReactNode
  style?: CSSProperties
}

export function Button({
  variant = 'ghost', size = 'md',
  icon, trailingIcon,
  loading, disabled, onClick,
  children, style, ...rest
}: ButtonProps) {
  const [hover, setHover]     = useState(false);
  const [pressed, setPressed] = useState(false);
  const hoverStyle = hover && !disabled ? BTN_HOVER[variant] : {};

  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onClick={disabled || loading ? undefined : onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: 8, fontFamily: 'var(--sf-font-sans)', fontWeight: 500,
        letterSpacing: '-0.01em', whiteSpace: 'nowrap', userSelect: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'all var(--sf-dur) var(--sf-ease)',
        transform: pressed ? 'scale(0.98)' : 'none',
        ...BTN_SIZES[size],
        ...BTN_VARIANTS[variant],
        ...hoverStyle,
        ...style,
      }}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon}
      {children}
      {trailingIcon}
    </button>
  );
}

// ── Chip ───────────────────────────────────────────────────────────────────

interface ChipProps {
  children?: ReactNode
  icon?: ReactNode
  active?: boolean
  onClick?: () => void
  variant?: 'default' | 'cyan'
  style?: CSSProperties
}

export function Chip({ children, icon, active, onClick, variant = 'default', style }: ChipProps) {
  const [hover, setHover] = useState(false);
  const v = variant === 'cyan'
    ? { bg: 'var(--sf-cyan-soft)',  fg: 'var(--sf-cyan)',  bd: 'var(--sf-cyan-line)',  bgHover: 'var(--sf-cyan-soft)' }
    : {
        bg: active ? 'var(--sf-amber-soft)' : 'var(--sf-bg-3)',
        fg: active ? 'var(--sf-amber)'      : 'var(--sf-fg-muted)',
        bd: active ? 'var(--sf-amber-line)' : 'var(--sf-line-strong)',
        bgHover: 'var(--sf-bg-4)',
      };

  return (
    <button
      type="button"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 28, padding: '0 12px',
        fontSize: 12, fontWeight: 500, fontFamily: 'var(--sf-font-mono)',
        letterSpacing: '0.02em',
        background: hover ? v.bgHover : v.bg, color: v.fg,
        border: `1px solid ${v.bd}`, borderRadius: 'var(--sf-r-sm)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all var(--sf-dur) var(--sf-ease)',
        ...style,
      }}
    >
      {icon} {children}
    </button>
  );
}

// ── Icon set ───────────────────────────────────────────────────────────────

interface IconProps {
  size?: number
}

const stroke = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };

export const IconWand     = (p: IconProps) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" {...stroke}><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M3 21l9-9M12.2 6.2l-1.4-1.4"/></svg>;
export const IconClose    = (p: IconProps) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" {...stroke}><path d="M6 6l12 12M18 6L6 18"/></svg>;
export const IconCheck    = (p: IconProps) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" {...stroke}><path d="M4 12l5 5L20 6"/></svg>;
export const IconCopy     = (p: IconProps) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" {...stroke}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
export const IconDownload = (p: IconProps) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" {...stroke}><path d="M12 3v13M6 11l6 6 6-6M4 21h16"/></svg>;
export const IconSettings = (p: IconProps) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>;
export const IconLayers   = (p: IconProps) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" {...stroke}><path d="M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5"/></svg>;
