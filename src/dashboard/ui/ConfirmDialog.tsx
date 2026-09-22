import { Modal, Text } from "@mantine/core";

import { Button } from "./Button";

/**
 * "Bestätigungs-Modal (`ConfirmDialog`)" in docs/input/DESIGN-neu.md: takes
 * a title, a description and two actions, never children -- the seam
 * enforces that this is only ever used for confirmations, never a form or
 * an editor. Cancel is `subtle` and starts focused; the action is `danger`
 * or `filled`. Modal chrome (radius, shadow, surface, 420px width, the
 * 60%-opacity backdrop) comes from the theme's `Modal` override.
 */
export interface ConfirmDialogProps {
  opened: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** "Löschende Handlungen tragen sie dauerhaft" -- deleting actions render
   *  the confirm button as `danger` instead of `filled`. */
  danger?: boolean;
}

export function ConfirmDialog({
  opened,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
}: ConfirmDialogProps) {
  return (
    <Modal opened={opened} onClose={onCancel} title={title} size={420} centered closeOnEscape trapFocus returnFocus>
      <Text size="sm" c="dimmed">
        {description}
      </Text>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
        <Button variant="subtle" onClick={onCancel} autoFocus>
          {cancelLabel}
        </Button>
        <Button variant="primary" danger={danger} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
