// Re-export Lucide icons as named exports for backward compatibility.
// The light 1.5 stroke matches the Figma redesign's thin icon style.
import {
  House as _IconHome,
  Package as _IconBox,
  CalendarDays as _IconPlan,
  ReceiptText as _IconHistory,
  Settings as _IconSettings,
  ScanLine as _IconReceipt,
  Sparkles as _IconSpark,
  Search as _IconSearch,
  Camera as _IconCamera,
  Upload as _IconUpload,
  X as _IconClose,
  Check as _IconCheck,
  MapPin as _IconPin,
  Clock as _IconClock,
  Store as _IconShop,
  Zap as _IconBolt,
  Leaf as _IconLeaf,
  KeyRound as _IconKey,
  Trash2 as _IconTrash,
  RotateCw as _IconRefresh,
  Plus as _IconPlus,
  Minus as _IconMinus,
  TriangleAlert as _IconWarning,
  ArrowLeft as _IconArrowLeft,
  ArrowRight as _IconArrowRight,
  Calendar as _IconCalendarBlank,
  CloudOff as _IconOffline,
  CloudCheck as _IconCloudCheck,
  ChartNoAxesCombined as _IconPrices,
  Activity as _IconMonitor,
  ListChecks as _IconReview,
  Download as _IconDownload,
  Users as _IconUsers,
  UserRound as _IconUserRound,
  LogOut as _IconLogout,
  SlidersHorizontal as _IconSliders,
  Sprout as _IconSprout,
} from 'lucide-react'

function light(Icon) {
  return function LucideIcon(props) {
    return <Icon strokeWidth={1.5} {...props} />
  }
}

export const IconHome = light(_IconHome)
export const IconBox = light(_IconBox)
export const IconPlan = light(_IconPlan)
export const IconHistory = light(_IconHistory)
export const IconSettings = light(_IconSettings)
export const IconReceipt = light(_IconReceipt)
export const IconSpark = light(_IconSpark)
export const IconSearch = light(_IconSearch)
export const IconCamera = light(_IconCamera)
export const IconUpload = light(_IconUpload)
export const IconClose = light(_IconClose)
export const IconCheck = light(_IconCheck)
export const IconPin = light(_IconPin)
export const IconClock = light(_IconClock)
export const IconShop = light(_IconShop)
export const IconBolt = light(_IconBolt)
export const IconLeaf = light(_IconLeaf)
export const IconKey = light(_IconKey)
export const IconTrash = light(_IconTrash)
export const IconRefresh = light(_IconRefresh)
export const IconPlus = light(_IconPlus)
export const IconMinus = light(_IconMinus)
export const IconWarning = light(_IconWarning)
export const IconArrowLeft = light(_IconArrowLeft)
export const IconArrowRight = light(_IconArrowRight)
export const IconCalendarBlank = light(_IconCalendarBlank)
export const IconOffline = light(_IconOffline)
export const IconCloudCheck = light(_IconCloudCheck)
export const IconPrices = light(_IconPrices)
export const IconMonitor = light(_IconMonitor)
export const IconReview = light(_IconReview)
export const IconDownload = light(_IconDownload)
export const IconUsers = light(_IconUsers)
export const IconUserRound = light(_IconUserRound)
export const IconLogout = light(_IconLogout)
export const IconSliders = light(_IconSliders)
export const IconSprout = light(_IconSprout)

export function BrandMark({ size = 32 }) {
  return (
    <div
      aria-hidden="true"
      className="grid shrink-0 place-items-center bg-accent text-on-accent"
      style={{ width: size, height: size, borderRadius: '30%' }}
    >
      <IconSprout size={Math.round(size * 0.61)} />
    </div>
  )
}
