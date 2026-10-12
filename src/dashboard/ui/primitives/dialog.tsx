import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";

import { cn } from "./utils";

function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return <DialogPrimitive.Backdrop data-ui="" data-slot="dialog-backdrop" className={cn("fixed inset-0 z-50 bg-[var(--color-depth)]/75", className)} {...props} />;
}

function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Popup>) {
  return <DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Popup data-ui="" data-slot="dialog-content" className={cn("fixed left-1/2 top-1/2 z-50 grid w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-inspector)] p-5 text-[var(--color-text)] shadow-2xl outline-none", className)} {...props}>
      {children}
    </DialogPrimitive.Popup>
  </DialogPrimitive.Portal>;
}

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-ui="" data-slot="dialog-header" className={cn("grid gap-2", className)} {...props} />;
}

function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-[16px] font-semibold", className)} {...props} />;
}

export { DialogPrimitive, DialogContent, DialogHeader, DialogTitle };
