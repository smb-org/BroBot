import {
  AlertTriangle, ArrowDown, ArrowDownRight, ArrowUp, ArrowUpDown, ArrowUpRight, BellRing, Bookmark, Braces, Check, ChevronLeft, ChevronRight, Clock, Cloud, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Copy, Crown, Diamond, ExternalLink, Eye, Film, GripVertical, Image, Info, KeyRound, Layers,
  ListChecks, Lock, MapPin, Megaphone, MessageSquareText, Minus, MoreVertical, Pause, Pencil, Play, Plus, Radio, RadioTower, RefreshCw, Search, Settings,
  SlidersHorizontal, Square, Star, Sun, Moon, Timer, Wind, Sword, Trash2, Type, User, UserMinus, UserPlus, Users, Video, Volume2, VolumeX, Vote, X, Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";

const glyphs = {
  ad: Megaphone, shoutout: User, clip: Film, vote: Vote, boss: Crown, blitz: Zap, duel: Sword, quiz: ListChecks,
  counter: Plus, "test-message": MessageSquareText, marker: Bookmark,
  timer: Timer,
  cloud: Cloud, "cloud-fog": CloudFog, "cloud-lightning": CloudLightning, "cloud-moon": CloudMoon,
  "cloud-rain": CloudRain, "cloud-snow": CloudSnow, "cloud-sun": CloudSun, moon: Moon, sun: Sun, wind: Wind,
  add: Plus, remove: Trash2, close: X, copy: Copy, copied: Check,
  reload: RefreshCw, search: Search, lock: Lock, external: ExternalLink,
  warning: AlertTriangle, jumpToTop: ArrowUp, collapse: ChevronLeft,
  trendUp: ArrowUpRight, trendDown: ArrowDownRight, sortAscending: ArrowUp, sortDescending: ArrowDown, sort: ArrowUpDown,
  "map-pin": MapPin,
  minus: Minus, plus: Plus, member: User, memberAdd: UserPlus, memberRemove: UserMinus,
  tierEveryone: Users, tierSubscriber: Star, tierVip: Diamond,
  tierModerator: Sword, tierBroadcaster: Video,
  tabSettings: Settings, tabAdvanced: SlidersHorizontal, tabCode: Braces,
  styleFont: Type, styleOutline: Square, styleShadow: Layers, styleBackground: Image,
  tabMessages: MessageSquareText, tabPrewarning: BellRing,
  broadcast: RadioTower, "broadcast-off": Radio, "volume-3": Volume2,
  "volume-off": VolumeX, "player-pause": Pause, "player-play": Play,
  "clock-hour-4": Clock,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  info: Info,
  eye: Eye,
  cause: Info,
  edit: Pencil,
  more: MoreVertical,
  drag: GripVertical,
  token: KeyRound, variable: Braces,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof glyphs;
type IconSize = 16 | 20 | 25 | 28;

export function Icon({ name, size = 16, className }: { name: IconName; size?: IconSize; className?: string }): ReactElement {
  const Glyph = glyphs[name];
  return <Glyph data-ui="" size={size} strokeWidth={1.5} aria-hidden="true" focusable="false" className={className === undefined ? "ui-icon" : `ui-icon ${className}`} />;
}
