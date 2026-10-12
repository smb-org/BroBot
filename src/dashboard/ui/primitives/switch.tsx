import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import type { ComponentProps } from "react";

import { cn } from "./utils";

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return <SwitchPrimitive.Root nativeButton render={<button type="button" />} data-ui="" data-slot="switch" className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-[var(--color-text-4)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] data-checked:bg-[var(--color-brand)] data-disabled:cursor-not-allowed data-disabled:opacity-50 after:absolute after:-inset-3", className)} {...props}>
    <SwitchPrimitive.Thumb data-slot="switch-thumb" className="pointer-events-none block size-4 rounded-full bg-[var(--color-text)] shadow-sm transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0" />
  </SwitchPrimitive.Root>;
}

export { Switch };
