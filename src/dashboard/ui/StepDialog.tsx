import type { ComponentProps, ReactElement, ReactNode } from "react";

import { dashboardCommonTexts } from "../locale";
import { Icon } from "./Icon";
import { DialogContent, DialogHeader, DialogPrimitive, DialogTitle } from "./primitives/dialog";

interface StepDialogProps {
  opened: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  description?: ReactNode;
  pending?: boolean;
}

/** Fixed-height dialog surface for guided flows whose content changes by step. */
export function StepDialog({ opened, title, children, onClose, footer, description, pending = false }: StepDialogProps): ReactElement {
  const closeLabel = dashboardCommonTexts().close;
  const handleOpenChange: NonNullable<ComponentProps<typeof DialogPrimitive.Root>["onOpenChange"]> = (nextOpen, eventDetails) => {
    if (!nextOpen && pending) {
      eventDetails.cancel();
      return;
    }
    if (!nextOpen) onClose();
  };

  return <DialogPrimitive.Root open={opened} onOpenChange={handleOpenChange}>
    <DialogContent
      className="ui-step-dialog"
      style={{ height: "min(760px, calc(100dvh - 32px))" }}
    >
      <DialogHeader className="ui-dialog__header">
        <DialogTitle>{title}</DialogTitle>
        <button className="ui-dialog__close" type="button" aria-label={closeLabel} disabled={pending} onClick={onClose}><Icon name="close" /></button>
      </DialogHeader>
      <div className="ui-step-dialog__body">
        {description === undefined ? null : <div className="ui-step-dialog__description">{description}</div>}
        {children}
      </div>
      {footer === undefined ? null : <div className="ui-step-dialog__footer">{footer}</div>}
    </DialogContent>
  </DialogPrimitive.Root>;
}
