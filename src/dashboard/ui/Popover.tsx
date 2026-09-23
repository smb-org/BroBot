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
 * closes it (Mantine's own default); Escape closes it via a `document`
 * listener added only while open, rather than relying on Mantine's
 * `closeOnEscape` or an `onKeyDown` on the trigger/dropdown -- opening by
 * hover alone (mouse only, no focus) is the common case for this popover,
 * and neither of those fires unless the keydown's target already has focus
 * inside the popover, which a plain hover never gives it. This is the one
 * place the dashboard reaches for Mantine's `Popover` (the seam, see
 * `ui/index.ts`).
 *
 * Hover and keyboard focus are tracked separately (in refs, not state --
 * they don't need their own render): losing one doesn't close the popover
 * while the other is still active, e.g. tabbing to the trigger and then an
 * incidental mouseleave (or the reverse) must not dismiss it. It only
 * actually closes once neither is active, and even then a hover-out waits
 * `CLOSE_DELAY_MS` first (cancelled by a hover onto either the trigger or
 * the dropdown) -- without that grace period, moving the mouse from the
 * trigger toward the dropdown closes it before the pointer arrives. A blur
 * closes right away if nothing is still hovered, since there's no pointer
 * travel to wait for.
 */
export function Popover({ triggerLabel, icon, children }: PopoverProps): ReactElement {
  const [opened, setOpened] = useState(false);
  const contentId = useId();
  const closeTimeoutRef = useRef<number | null>(null);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);

  const clearCloseTimeout = (): void => {
    if (closeTimeoutRef.current === null) return;
    window.clearTimeout(closeTimeoutRef.current);
    closeTimeoutRef.current = null;
  };
  const isActive = (): boolean => hoveredRef.current || focusedRef.current;
  const open = (): void => { clearCloseTimeout(); setOpened(true); };
  const scheduleClose = (): void => {
    clearCloseTimeout();
    closeTimeoutRef.current = window.setTimeout(() => {
      closeTimeoutRef.current = null;
      if (!isActive()) setOpened(false);
    }, CLOSE_DELAY_MS);
  };
  const closeNow = (): void => { clearCloseTimeout(); setOpened(false); };
  useEffect(() => clearCloseTimeout, []);

  const handleMouseEnter = (): void => { hoveredRef.current = true; open(); };
  const handleMouseLeave = (): void => { hoveredRef.current = false; scheduleClose(); };
  const handleFocus = (): void => { focusedRef.current = true; open(); };
  const handleBlur = (): void => {
    focusedRef.current = false;
    if (!isActive()) closeNow();
  };
  const handleEscape = (): void => {
    hoveredRef.current = false;
    focusedRef.current = false;
    closeNow();
  };
  useEffect(() => {
    if (!opened) return;
    const onDocumentKeyDown = (event: KeyboardEvent): void => { if (event.key === "Escape") handleEscape(); };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => { document.removeEventListener("keydown", onDocumentKeyDown); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `handleEscape` closes over refs only, never changes in a way that needs re-subscribing.
  }, [opened]);

  return (
    <MantinePopover opened={opened} onChange={setOpened} withArrow shadow="xs" position="top" width={280}>
      <MantinePopover.Target>
        <button
          type="button"
          className="ui-popover-trigger"
          aria-label={triggerLabel}
          aria-describedby={opened ? contentId : undefined}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onClick={(event) => { event.stopPropagation(); open(); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
        >
          <Icon name={icon} size={16} />
        </button>
      </MantinePopover.Target>
      <MantinePopover.Dropdown
        id={contentId}
        role="tooltip"
        onClick={(event) => { event.stopPropagation(); }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {children}
      </MantinePopover.Dropdown>
    </MantinePopover>
  );
}
