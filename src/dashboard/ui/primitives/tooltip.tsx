import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentProps } from "react";

import { cn } from "./utils";

function TooltipProvider(props: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-ui="" delay={300} {...props} />;
}

function TooltipContent({ className, side = "top", sideOffset = 4, children, ...props }: ComponentProps<typeof TooltipPrimitive.Popup> & Pick<ComponentProps<typeof TooltipPrimitive.Positioner>, "side" | "sideOffset">) {
  return <TooltipPrimitive.Portal>
    <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className="z-50">
      <TooltipPrimitive.Popup data-ui="" data-slot="tooltip-content" className={cn("max-w-xs rounded-md bg-[var(--color-text)] px-2.5 py-1.5 text-[12px] text-[var(--color-background)] shadow-lg", className)} {...props}>{children}</TooltipPrimitive.Popup>
    </TooltipPrimitive.Positioner>
  </TooltipPrimitive.Portal>;
}

export { TooltipPrimitive, TooltipProvider, TooltipContent };
