import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border text-[13px] font-semibold whitespace-nowrap transition-colors outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]",
        primary: "border-transparent bg-[var(--color-gold)] text-[var(--color-on-gold)] hover:bg-[var(--color-gold-hover)] active:bg-[var(--color-gold-press)]",
        subtle: "border-transparent bg-transparent text-[var(--color-text-2)] hover:bg-[var(--color-surface-hover)]",
        secondary: "border-[var(--color-border)] bg-transparent text-[var(--color-text-2)] hover:bg-[var(--color-surface-hover)]",
        danger: "border-transparent bg-[var(--color-error)] text-[var(--color-on-error)] hover:bg-[var(--color-error-surface)] hover:text-[var(--color-error-text)]",
        "danger-outline": "border-[var(--color-error-text)] bg-transparent text-[var(--color-error-text)] hover:bg-[var(--color-error-surface)]",
      },
      size: {
        md: "h-[var(--control-height)] min-h-[var(--control-height)] gap-1.5 px-2.5",
        compact: "h-[var(--control-height)] min-h-[var(--control-height)] gap-1 px-2",
        icon: "h-[var(--control-height)] min-h-[var(--control-height)] w-[var(--control-height)] p-0",
      },
    },
    defaultVariants: { variant: "neutral", size: "md" },
  },
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return <ButtonPrimitive data-ui="" data-slot="button" data-variant={variant ?? "neutral"} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button };
