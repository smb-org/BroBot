import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "./utils";

function SelectGroup({ className, ...props }: ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-ui="" data-slot="select-group" className={cn("p-1", className)} {...props} />;
}

function SelectValue({ className, ...props }: ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" className={cn("min-w-0 flex-1 truncate text-left", className)} {...props} />;
}

function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger data-ui="" data-slot="select-trigger" className={cn("flex h-[var(--control-height)] min-w-0 items-center justify-between gap-2 rounded-md border border-[var(--color-border-control)] bg-[var(--color-well)] px-2.5 text-left text-[13px] font-medium text-[var(--color-text)] outline-none focus-visible:border-[var(--color-focus)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-55 data-placeholder:text-[var(--color-text-3)]", className)} {...props}>
    {children}<SelectPrimitive.Icon render={<ChevronDown aria-hidden="true" className="size-4 shrink-0 text-[var(--color-text-3)]" />} />
  </SelectPrimitive.Trigger>;
}

function SelectContent({ className, children, side = "bottom", sideOffset = 4, align = "start", anchor, alignItemWithTrigger, ...props }: ComponentProps<typeof SelectPrimitive.Popup> & Pick<ComponentProps<typeof SelectPrimitive.Positioner>, "side" | "sideOffset" | "align" | "anchor" | "alignItemWithTrigger">) {
  return <SelectPrimitive.Portal>
    <SelectPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} anchor={anchor} alignItemWithTrigger={alignItemWithTrigger} className="z-[var(--layer-popover)]" style={{ zIndex: "var(--layer-popover)" }}>
      <SelectPrimitive.Popup data-ui="" data-slot="select-content" className={cn("max-h-[var(--available-height)] min-w-[var(--anchor-width)] overflow-y-auto rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-1 text-[var(--color-text)] shadow-lg outline-none", className)} {...props}>
        <SelectPrimitive.ScrollUpArrow aria-hidden="true" className="flex h-5 items-center justify-center"><ChevronUp className="size-4" /></SelectPrimitive.ScrollUpArrow>
        <SelectPrimitive.List>{children}</SelectPrimitive.List>
        <SelectPrimitive.ScrollDownArrow aria-hidden="true" className="flex h-5 items-center justify-center"><ChevronDown className="size-4" /></SelectPrimitive.ScrollDownArrow>
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  </SelectPrimitive.Portal>;
}

function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return <SelectPrimitive.GroupLabel data-slot="select-label" className={cn("px-2 py-1 text-[11px] font-semibold text-[var(--color-text-3)]", className)} {...props} />;
}

function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item data-ui="" data-slot="select-item" className={cn("relative flex min-h-8 w-full cursor-default items-center gap-2 rounded px-2 pr-8 text-[13px] outline-none focus:bg-[var(--color-surface-hover)] data-disabled:pointer-events-none data-disabled:opacity-50", className)} {...props}>
    <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator render={<span className="absolute right-2 flex size-4 items-center justify-center"><Check aria-hidden="true" className="size-4" /></span>} />
  </SelectPrimitive.Item>;
}

export { SelectPrimitive, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem };
