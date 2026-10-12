import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ComponentProps } from "react";

import { cn } from "./utils";

function PopoverContent({ className, side = "bottom", sideOffset = 6, align = "start", children, ...props }: ComponentProps<typeof PopoverPrimitive.Popup> & Pick<ComponentProps<typeof PopoverPrimitive.Positioner>, "side" | "sideOffset" | "align">) {
  return <PopoverPrimitive.Portal>
    <PopoverPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} className="z-50">
      <PopoverPrimitive.Popup data-ui="" data-slot="popover-content" className={cn("z-50 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3 text-[13px] text-[var(--color-text)] shadow-lg outline-none", className)} {...props}>{children}</PopoverPrimitive.Popup>
    </PopoverPrimitive.Positioner>
  </PopoverPrimitive.Portal>;
}

export { PopoverPrimitive, PopoverContent };
