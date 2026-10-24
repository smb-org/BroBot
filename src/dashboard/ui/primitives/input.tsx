import { Input as InputPrimitive } from "@base-ui/react/input";
import type { ComponentProps } from "react";

import { cn } from "./utils";

function Input({ className, ...props }: ComponentProps<typeof InputPrimitive>) {
  return <InputPrimitive data-ui="" data-slot="input" className={cn("h-[var(--control-height)] w-full min-w-0 rounded-md border border-[var(--color-border-control)] bg-[var(--color-well)] px-[10px] text-[14px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-3)] focus-visible:border-[var(--color-focus)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-[var(--color-error)]", className)} {...props} />;
}

export { Input };
