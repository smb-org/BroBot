import { Popover as MantinePopover } from "@mantine/core";
import { useId, useState, type ReactElement, type ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export interface PopoverProps {
  /** Accessible name of the trigger icon button. */
  triggerLabel: string;
  /** Icon glyph rendered inside the trigger button. */
  icon: IconName;
  /** Popover body, reachable by screen readers via `aria-describedby`. */
  children: ReactNode;
}

/**
 * An icon button that reveals `children` on hover, keyboard focus, or tap --
 * without stealing the click from whatever it sits inside (e.g. a clickable
 * table row: the trigger stops the click from bubbling). Escape and clicking
 * outside close it (Mantine's own defaults); this is the one place the
 * dashboard reaches for Mantine's `Popover` (the seam, see `ui/index.ts`).
 */
export function Popover({ triggerLabel, icon, children }: PopoverProps): ReactElement {
  const [opened, setOpened] = useState(false);
  const contentId = useId();
  const close = (): void => { setOpened(false); };
  return (
    <MantinePopover opened={opened} onChange={setOpened} withArrow shadow="xs" position="top" width={280}>
      <MantinePopover.Target>
        <button
          type="button"
          className="ui-popover-trigger"
          aria-label={triggerLabel}
          aria-describedby={opened ? contentId : undefined}
          onMouseEnter={() => { setOpened(true); }}
          onMouseLeave={close}
          onFocus={() => { setOpened(true); }}
          onBlur={close}
          onClick={(event) => { event.stopPropagation(); setOpened(true); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
        >
          <Icon name={icon} size={16} />
        </button>
      </MantinePopover.Target>
      <MantinePopover.Dropdown id={contentId} role="tooltip" onClick={(event) => { event.stopPropagation(); }}>
        {children}
      </MantinePopover.Dropdown>
    </MantinePopover>
  );
}
