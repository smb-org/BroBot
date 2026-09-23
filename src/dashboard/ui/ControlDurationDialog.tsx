import { Modal } from "@mantine/core";
import type { ReactElement } from "react";

import { Button } from "./Button";
import { ChoiceCards, type ChoiceCardOption } from "./ChoiceCards";

export interface ControlDurationDialogProps {
  opened: boolean;
  title: string;
  description: string;
  durationLabel: string;
  durationHint: string;
  value: string;
  options: readonly ChoiceCardOption[];
  confirmLabel: string;
  cancelLabel: string;
  pending?: boolean;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The channel operational-brake duration picker, kept inside the UI seam. */
export function ControlDurationDialog({
  opened,
  title,
  description,
  durationLabel,
  durationHint,
  value,
  options,
  confirmLabel,
  cancelLabel,
  pending = false,
  onChange,
  onConfirm,
  onCancel,
}: ControlDurationDialogProps): ReactElement {
  return (
    <Modal opened={opened} onClose={pending ? () => undefined : onCancel} title={title} size={560} centered closeOnEscape={!pending} trapFocus returnFocus>
      <p className="ui-control-duration-dialog__description">{description}</p>
      <ChoiceCards label={durationLabel} hint={durationHint} value={value} onChange={onChange} options={options} disabled={pending} />
      <div className="ui-confirm-dialog__actions">
        <Button variant="subtle" onClick={onCancel} disabled={pending}>{cancelLabel}</Button>
        <Button variant="primary" onClick={onConfirm} disabled={pending}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
