import {
  IconAd2, IconAdjustmentsHorizontal, IconAlertTriangle, IconArrowUp, IconBellRinging, IconCheck, IconChevronLeft, IconCopy,
  IconDiamond, IconExternalLink, IconInfoCircle, IconKey, IconLock, IconMinus, IconMovie, IconPlus, IconRefresh,
  IconMessage, IconSearch, IconSettings, IconSpeakerphone, IconStar, IconSword, IconTrash, IconUser, IconUserMinus,
  IconUserPlus, IconUsers, IconVideo, IconX, IconBroadcast, IconBroadcastOff, IconClockHour4,
  IconPlayerPause, IconPlayerPlay, IconVolume3, IconVolumeOff, IconBraces,
} from "@tabler/icons-react";
import type { TablerIcon } from "@tabler/icons-react";
import type { ReactElement } from "react";

const glyphs = {
  ad: IconAd2, shoutout: IconSpeakerphone, clip: IconMovie,
  add: IconPlus, remove: IconTrash, close: IconX, copy: IconCopy, copied: IconCheck,
  reload: IconRefresh, search: IconSearch, lock: IconLock, external: IconExternalLink,
  warning: IconAlertTriangle, jumpToTop: IconArrowUp, collapse: IconChevronLeft,
  minus: IconMinus, plus: IconPlus, member: IconUser, memberAdd: IconUserPlus, memberRemove: IconUserMinus,
  tierEveryone: IconUsers, tierSubscriber: IconStar, tierVip: IconDiamond,
  tierModerator: IconSword, tierBroadcaster: IconVideo,
  tabSettings: IconSettings, tabAdvanced: IconAdjustmentsHorizontal, tabCode: IconBraces,
  tabMessages: IconMessage, tabPrewarning: IconBellRinging,
  broadcast: IconBroadcast, "broadcast-off": IconBroadcastOff, "volume-3": IconVolume3,
  "volume-off": IconVolumeOff, "player-pause": IconPlayerPause, "player-play": IconPlayerPlay,
  "clock-hour-4": IconClockHour4,
  cause: IconInfoCircle,
  token: IconKey, variable: IconBraces,
} as const satisfies Record<string, TablerIcon>;

export type IconName = keyof typeof glyphs;
type IconSize = 16 | 20 | 25 | 28;

export function Icon({ name, size = 16, className }: { name: IconName; size?: IconSize; className?: string }): ReactElement {
  const Glyph = glyphs[name];
  return <Glyph size={size} stroke={1.5} aria-hidden="true" focusable="false" className={className === undefined ? "ui-icon" : `ui-icon ${className}`} />;
}
