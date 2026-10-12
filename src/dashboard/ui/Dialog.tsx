import type { ComponentProps, ReactElement, ReactNode } from "react";

import { DialogContent, DialogHeader, DialogPrimitive, DialogTitle } from "./primitives/dialog";

export function Dialog({ opened, title, children, onClose, pending = false }: {
  opened: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  pending?: boolean;
}): ReactElement {
  const handleOpenChange: NonNullable<ComponentProps<typeof DialogPrimitive.Root>["onOpenChange"]> = (nextOpen, eventDetails) => {
    if (!nextOpen && pending) {
      eventDetails.cancel();
      return;
    }
    if (!nextOpen) onClose();
  };

  return <DialogPrimitive.Root open={opened} onOpenChange={handleOpenChange}>
    <DialogContent className="ui-dialog">
      <DialogHeader className="ui-dialog__header"><DialogTitle>{title}</DialogTitle></DialogHeader>
      <div className="ui-dialog__body">{children}</div>
    </DialogContent>
  </DialogPrimitive.Root>;
}
