import { Modal } from "@mantine/core";
import type { ReactElement, ReactNode } from "react";

import { Button } from "./Button";

export interface FormDialogProps {
  opened: boolean;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  confirmDisabled?: boolean;
  error?: string;
}

/** A modal form with the panel's shared title, focus, and action treatment. */
export function FormDialog({
  opened,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  pending = false,
  confirmDisabled = false,
  error,
}: FormDialogProps): ReactElement {
  return (
    <Modal opened={opened} onClose={pending ? () => undefined : onCancel} title={title} size={720} centered closeOnEscape={!pending} trapFocus returnFocus>
      {description === undefined ? null : <div className="ui-form-dialog__description">{description}</div>}
      {children}
      {error === undefined ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="ui-confirm-dialog__actions">
        <Button variant="subtle" onClick={onCancel} disabled={pending}>{cancelLabel}</Button>
        <Button variant="primary" onClick={onConfirm} disabled={pending || confirmDisabled}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
