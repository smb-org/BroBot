import type { ComponentProps } from "react";

import { cn } from "./utils";

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-ui="" data-slot="textarea" className={cn("min-h-[64px] w-full rounded-md border border-[var(--color-border-control)] bg-[var(--color-well)] px-[10px] py-2 text-[14px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-3)] focus-visible:border-[var(--color-focus)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-55", className)} {...props} />;
}

export { Textarea };
