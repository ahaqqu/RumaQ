import { Link } from '@tanstack/react-router'
import { cn } from '../lib/cn.js'

export function NavItem({ to, active, mobile = false, children, ...props }) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center text-left w-full transition-colors duration-150',
        !mobile &&
          'gap-3 px-3 py-3 rounded-[10px] text-sm font-medium text-text-muted hover:bg-surface-sunken hover:text-text',
        !mobile && active && 'bg-accent-soft text-accent font-semibold',
        // Selected marker dot from the Figma shell
        !mobile &&
          active &&
          "after:content-[''] after:w-[5px] after:h-[5px] after:rounded-full after:bg-accent after:ml-auto",
        // Mobile tabs are icon-only (label lives in aria-label): five equal
        // flex-1 slots, a ≥56px tap target, icon centered in the slot.
        mobile &&
          'flex-1 flex-col items-center justify-center py-2 px-0 text-text-muted rounded-md min-h-14',
        mobile && active && 'text-accent'
      )}
      aria-current={active ? 'page' : undefined}
      {...props}
    >
      {children}
    </Link>
  )
}
