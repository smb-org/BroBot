import { Modal } from "@mantine/core";
import type { ReactElement, ReactNode, SyntheticEvent } from "react";

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
  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending || confirmDisabled) return;
    onConfirm();
  };

  return (
    <Modal opened={opened} onClose={pending ? () => undefined : onCancel} title={title} size={720} centered closeOnEscape={!pending} trapFocus returnFocus>
      <form onSubmit={handleSubmit}>
        {description === undefined ? null : <div className="ui-form-dialog__description">{description}</div>}
        {children}
        <div className="ui-dialog__error-slot">{error === undefined ? null : <p className="form-error" role="alert" title={error}><span aria-hidden="true">× </span>{error}</p>}</div>
        <div className="ui-confirm-dialog__actions">
          <Button type="button" variant="subtle" onClick={onCancel} disabled={pending}>{cancelLabel}</Button>
          <Button type="submit" variant="primary" disabled={pending || confirmDisabled}>{confirmLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}
