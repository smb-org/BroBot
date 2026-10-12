import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type { ComponentProps } from "react";

import { cn } from "./utils";

function ScrollArea({ className, children, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return <ScrollAreaPrimitive.Root data-ui="" data-slot="scroll-area" className={cn("relative min-h-0", className)} {...props}>
    <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">{children}</ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar orientation="vertical" data-slot="scroll-area-scrollbar" className="flex w-2.5 touch-none p-px"><ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" className="flex-1 rounded-full bg-[var(--color-border-strong)]" /></ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>;
}

export { ScrollArea };
