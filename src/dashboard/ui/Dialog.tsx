import type { ComponentProps, ReactElement, ReactNode } from "react";

import { dashboardCommonTexts } from "../locale";
import { Icon } from "./Icon";
import { DialogContent, DialogHeader, DialogPrimitive, DialogTitle } from "./primitives/dialog";

export function Dialog({ opened, title, children, onClose, pending = false, className, headerActions }: {
  opened: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  pending?: boolean;
  className?: string;
  headerActions?: ReactNode;
}): ReactElement {
  const closeLabel = dashboardCommonTexts().close;
  const handleOpenChange: NonNullable<ComponentProps<typeof DialogPrimitive.Root>["onOpenChange"]> = (nextOpen, eventDetails) => {
    if (!nextOpen && pending) {
      eventDetails.cancel();
      return;
    }
    if (!nextOpen) onClose();
  };

  return <DialogPrimitive.Root open={opened} onOpenChange={handleOpenChange}>
    <DialogContent className={["ui-dialog", className].filter(Boolean).join(" ")}>
      <DialogHeader className="ui-dialog__header">
        <DialogTitle>{title}</DialogTitle>
        {headerActions}
        <button className="ui-dialog__close" type="button" aria-label={closeLabel} disabled={pending} onClick={onClose}><Icon name="close" /></button>
      </DialogHeader>
      <div className="ui-dialog__body">{children}</div>
    </DialogContent>
  </DialogPrimitive.Root>;
}
