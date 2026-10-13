import {
  AlertTriangle, ArrowUp, BellRing, Braces, Check, ChevronLeft, Clock, Copy, Diamond, ExternalLink, Film, Image, Info, KeyRound, Layers,
  Lock, Megaphone, MessageSquareText, Minus, MoreVertical, Pause, Pencil, Play, Plus, Radio, RadioTower, RefreshCw, Search, Settings,
  SlidersHorizontal, Square, Star, Sword, Trash2, Type, User, UserMinus, UserPlus, Users, Video, Volume2, VolumeX, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";

const glyphs = {
  ad: Megaphone, shoutout: Megaphone, clip: Film,
  add: Plus, remove: Trash2, close: X, copy: Copy, copied: Check,
  reload: RefreshCw, search: Search, lock: Lock, external: ExternalLink,
  warning: AlertTriangle, jumpToTop: ArrowUp, collapse: ChevronLeft,
  minus: Minus, plus: Plus, member: User, memberAdd: UserPlus, memberRemove: UserMinus,
  tierEveryone: Users, tierSubscriber: Star, tierVip: Diamond,
  tierModerator: Sword, tierBroadcaster: Video,
  tabSettings: Settings, tabAdvanced: SlidersHorizontal, tabCode: Braces,
  styleFont: Type, styleOutline: Square, styleShadow: Layers, styleBackground: Image,
  tabMessages: MessageSquareText, tabPrewarning: BellRing,
  broadcast: RadioTower, "broadcast-off": Radio, "volume-3": Volume2,
  "volume-off": VolumeX, "player-pause": Pause, "player-play": Play,
  "clock-hour-4": Clock,
  cause: Info,
  edit: Pencil,
  more: MoreVertical,
  token: KeyRound, variable: Braces,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof glyphs;
type IconSize = 16 | 20 | 25 | 28;

export function Icon({ name, size = 16, className }: { name: IconName; size?: IconSize; className?: string }): ReactElement {
  const Glyph = glyphs[name];
  return <Glyph data-ui="" size={size} strokeWidth={1.5} aria-hidden="true" focusable="false" className={className === undefined ? "ui-icon" : `ui-icon ${className}`} />;
}
