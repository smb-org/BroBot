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

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-ui="" data-slot="dialog-footer" className={cn("flex flex-col-reverse justify-end gap-2 border-t border-[var(--color-border)] pt-4 sm:flex-row", className)} {...props} />;
}

function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-[16px] font-semibold", className)} {...props} />;
}

function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-[13px] leading-normal text-[var(--color-text-2)]", className)} {...props} />;
}

export { DialogPrimitive, DialogOverlay, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription };
