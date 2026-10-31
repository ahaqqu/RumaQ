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
        mobile &&
          'flex-1 flex-col items-center gap-1 py-2 px-0 text-[10px] font-medium text-text-muted rounded-md min-h-14 whitespace-nowrap',
        mobile && active && 'text-accent font-semibold'
      )}
      aria-current={active ? 'page' : undefined}
      {...props}
    >
      {children}
    </Link>
  )
}
