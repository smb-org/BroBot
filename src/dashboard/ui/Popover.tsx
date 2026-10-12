import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";

import { Icon, type IconName } from "./Icon";
import { PopoverContent, PopoverPrimitive } from "./primitives/popover";

export interface PopoverProps {
  triggerLabel: string;
  icon: IconName;
  children: ReactNode;
}

export function Popover({ triggerLabel, icon, children }: PopoverProps): ReactElement {
  const [opened, setOpened] = useState(false);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const dismissedRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentId = useId();
  const cancelClose = (): void => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = (): void => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!hoveredRef.current && !focusedRef.current) setOpened(false);
    }, 120);
  };

  useEffect(() => () => { cancelClose(); }, []);
  useEffect(() => {
    if (!opened) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      dismissedRef.current = true;
      cancelClose();
      setOpened(false);
      event.stopPropagation();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [opened]);

  return <PopoverPrimitive.Root open={opened} onOpenChange={setOpened}>
    <div data-ui="" className="ui-popover">
      <PopoverPrimitive.Trigger
        data-ui=""
        type="button"
        className="ui-popover-trigger"
        aria-label={triggerLabel}
        aria-describedby={opened ? contentId : undefined}
        onMouseEnter={() => { dismissedRef.current = false; hoveredRef.current = true; cancelClose(); setOpened(true); }}
        onMouseLeave={() => { dismissedRef.current = false; hoveredRef.current = false; scheduleClose(); }}
        onFocus={() => { focusedRef.current = true; cancelClose(); if (!dismissedRef.current) setOpened(true); }}
        onBlur={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.parentElement?.contains(event.relatedTarget)) return;
          focusedRef.current = false;
          dismissedRef.current = false;
          if (!hoveredRef.current) { cancelClose(); setOpened(false); }
        }}
        onClick={(event) => { event.stopPropagation(); dismissedRef.current = false; setOpened(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            dismissedRef.current = true;
            cancelClose();
            setOpened(false);
          } else if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
      >
        <Icon name={icon} size={16} />
      </PopoverPrimitive.Trigger>
      <PopoverContent id={contentId} role="tooltip" side="top" align="end" className="ui-popover__content" onClick={(event) => { event.stopPropagation(); }} onMouseEnter={() => { dismissedRef.current = false; hoveredRef.current = true; cancelClose(); setOpened(true); }} onMouseLeave={() => { dismissedRef.current = false; hoveredRef.current = false; scheduleClose(); }}>
        {children}
      </PopoverContent>
    </div>
  </PopoverPrimitive.Root>;
}
