import { Button } from "./Button";
import { Dialog } from "./Dialog";

export interface ConfirmDialogProps {
  opened: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  alternative?: { label: string; onClick: () => void };
  danger?: boolean;
  pending?: boolean;
  error?: string;
}

export function ConfirmDialog({ opened, title, description, confirmLabel, cancelLabel, onConfirm, onCancel, alternative, danger = false, pending = false, error }: ConfirmDialogProps) {
  return <Dialog opened={opened} title={title} onClose={onCancel} pending={pending}>
    <p className="ui-dialog__description">{description}</p>
    <div className="ui-dialog__error-slot">{error === undefined ? null : <p className="form-error" role="alert" title={error}><span aria-hidden="true">× </span>{error}</p>}</div>
    <div className="ui-confirm-dialog__actions">
      <Button variant="subtle" onClick={onCancel} autoFocus disabled={pending}>{cancelLabel}</Button>
      {alternative === undefined ? null : <Button variant="neutral" onClick={alternative.onClick} disabled={pending}>{alternative.label}</Button>}
      <Button variant={danger ? "neutral" : "primary"} {...(danger ? { danger: true } : {})} onClick={onConfirm} disabled={pending}>{confirmLabel}</Button>
    </div>
  </Dialog>;
}
