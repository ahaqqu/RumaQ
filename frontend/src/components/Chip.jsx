import { cn } from '../lib/cn.js'

export function Chip({
  variant = 'default',
  pressed = false,
  onClick,
  className,
  children,
  ...props
}) {
  const classes = cn(
    'inline-flex items-center gap-2 rounded-pill text-xs font-medium px-3 py-1',
    variant === 'default' && 'bg-surface-inset text-text-muted',
    variant === 'loc' && 'bg-surface-raised border border-border text-text-muted',
    variant === 'filter' &&
      'min-h-9 px-4 py-2 text-sm bg-surface-raised border border-border-strong text-text-muted hover:bg-surface-sunken cursor-pointer select-none',
    variant === 'filter' && pressed && 'bg-accent-soft border-accent-soft-border text-accent-hover',
    variant === 'accent' && 'bg-accent-soft text-accent-hover border border-accent-soft-border',
    className
  )

  // Interactive chips (onClick) render as real toggle buttons (#404): native
  // focus, Enter/Space activation, and aria-pressed for the selected state.
  // Chips without a click handler are static badges — they stay spans so they
  // are never focusable controls (and never nest inside parent buttons, e.g.
  // the AdminPrices run rows).
  if (onClick) {
    return (
      <button type="button" className={classes} aria-pressed={pressed} onClick={onClick} {...props}>
        {children}
      </button>
    )
  }
  return (
    <span className={classes} {...props}>
      {children}
    </span>
  )
}
