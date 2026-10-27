// Re-export Phosphor icons as named exports for backward compatibility
import {
  House as IconHome,
  Package as IconBox,
  Clipboard as IconPlan,
  ClockCounterClockwise as IconHistory,
  Gear as IconSettings,
  Receipt as IconReceipt,
  Sparkle as IconSpark,
  MagnifyingGlass as IconSearch,
  Camera as IconCamera,
  Upload as IconUpload,
  X as IconClose,
  Check as IconCheck,
  MapPin as IconPin,
  Clock as IconClock,
  Storefront as IconShop,
  Lightning as IconBolt,
  Leaf as IconLeaf,
  Key as IconKey,
  Trash as IconTrash,
  ArrowsClockwise as IconRefresh,
  Plus as IconPlus,
  Minus as IconMinus,
  Warning as IconWarning,
  ArrowLeft as IconArrowLeft,
  CalendarBlank as IconCalendarBlank,
  WifiSlash as IconOffline,
  Tag as IconPrices,
  Pulse as IconMonitor,
} from '@phosphor-icons/react'

export {
  IconHome,
  IconBox,
  IconPlan,
  IconHistory,
  IconSettings,
  IconReceipt,
  IconSpark,
  IconSearch,
  IconCamera,
  IconUpload,
  IconClose,
  IconCheck,
  IconPin,
  IconClock,
  IconShop,
  IconBolt,
  IconLeaf,
  IconKey,
  IconTrash,
  IconRefresh,
  IconPlus,
  IconMinus,
  IconWarning,
  IconArrowLeft,
  IconCalendarBlank,
  IconOffline,
  IconPrices,
  IconMonitor,
}

export function BrandMark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="url(#rmq-g)" />
      <path
        d="M16 7 7 14.2V24a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V14.2L16 7z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M16 15l1.2 2.8 2.8 1.2-2.8 1.2L16 23l-1.2-2.8L12 19l2.8-1.2z" fill="#fff" />
      <defs>
        <linearGradient id="rmq-g" x1="7" y1="4" x2="25" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.62 0.13 230)" />
          <stop offset="1" stopColor="oklch(0.45 0.14 230)" />
        </linearGradient>
      </defs>
    </svg>
  )
}
