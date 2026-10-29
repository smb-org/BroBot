import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import type { ComponentProps } from "react";

import { cn } from "./utils";

// Track 36x20, thumb 16: the 2px transparent border is the inset, so the thumb never touches the
// track edge in either state.
// The touch target grows vertically only (36x44): a horizontal overhang past a switch that sits
// flush with the edge of a scrolling column would add a horizontal scrollbar.
// `p-0` removes the browser's default button padding, which would otherwise shrink the track.
function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return <SwitchPrimitive.Root nativeButton render={<button type="button" />} data-ui="" data-slot="switch" className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent p-0 bg-[var(--color-text-4)] outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] aria-invalid:border-[var(--color-error)] data-checked:bg-[var(--color-brand)] data-disabled:cursor-not-allowed data-disabled:opacity-70 after:absolute after:inset-x-0 after:-inset-y-3", className)} {...props}>
    <SwitchPrimitive.Thumb data-slot="switch-thumb" className="pointer-events-none block size-4 rounded-full bg-[var(--color-text)] shadow-sm transition-transform motion-reduce:transition-none data-checked:translate-x-4 data-unchecked:translate-x-0" />
  </SwitchPrimitive.Root>;
}

export { Switch };
