import { Popover as MantinePopover } from "@mantine/core";
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export interface PopoverProps {
  /** Accessible name of the trigger icon button. */
  triggerLabel: string;
  /** Icon glyph rendered inside the trigger button. */
  icon: IconName;
  /** Popover body, reachable by screen readers via `aria-describedby`. */
  children: ReactNode;
}

/** How long a hover-out waits before closing -- long enough for the pointer
 *  to travel from the trigger to the dropdown above it (they don't touch:
 *  there's a gap for the arrow), short enough that leaving the row entirely
 *  still reads as immediate. */
const CLOSE_DELAY_MS = 200;

/**
 * An icon button that reveals `children` on hover, keyboard focus, or tap --
 * without stealing the click from whatever it sits inside (e.g. a clickable
 * table row: the trigger stops the click from bubbling). Clicking outside
 * closes it (Mantine's own default); Escape closes it explicitly here
 * rather than relying on Mantine's `closeOnEscape` -- that one only listens
 * on the dropdown itself, so it never fires while focus (or just the mouse)
 * stays on the trigger, the common case for a hover popover. This is the
 * one place the dashboard reaches for Mantine's `Popover` (the seam, see
 * `ui/index.ts`).
 *
 * Hovering out of the trigger doesn't close it right away -- it schedules a
 * close after `CLOSE_DELAY_MS`, which a hover onto either the trigger or the
 * dropdown itself cancels. Without that grace period, moving the mouse from
 * the trigger toward the dropdown closes it before the pointer arrives.
 */
export function Popover({ triggerLabel, icon, children }: PopoverProps): ReactElement {
  const [opened, setOpened] = useState(false);
  const contentId = useId();
  const closeTimeoutRef = useRef<number | null>(null);

  const clearCloseTimeout = (): void => {
    if (closeTimeoutRef.current === null) return;
    window.clearTimeout(closeTimeoutRef.current);
    closeTimeoutRef.current = null;
  };
  const open = (): void => { clearCloseTimeout(); setOpened(true); };
  const scheduleClose = (): void => {
    clearCloseTimeout();
    closeTimeoutRef.current = window.setTimeout(() => { setOpened(false); }, CLOSE_DELAY_MS);
  };
  const closeNow = (): void => { clearCloseTimeout(); setOpened(false); };
  useEffect(() => clearCloseTimeout, []);

  return (
    <MantinePopover opened={opened} onChange={setOpened} withArrow shadow="xs" position="top" width={280}>
      <MantinePopover.Target>
        <button
          type="button"
          className="ui-popover-trigger"
          aria-label={triggerLabel}
          aria-describedby={opened ? contentId : undefined}
          onMouseEnter={open}
          onMouseLeave={scheduleClose}
          onFocus={open}
          onBlur={closeNow}
          onClick={(event) => { event.stopPropagation(); open(); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            if (event.key === "Escape") closeNow();
          }}
        >
          <Icon name={icon} size={16} />
        </button>
      </MantinePopover.Target>
      <MantinePopover.Dropdown
        id={contentId}
        role="tooltip"
        onClick={(event) => { event.stopPropagation(); }}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        onKeyDown={(event) => { if (event.key === "Escape") closeNow(); }}
      >
        {children}
      </MantinePopover.Dropdown>
    </MantinePopover>
  );
}
