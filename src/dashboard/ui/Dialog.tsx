import { Modal } from "@mantine/core";
import type { ReactElement, ReactNode } from "react";

export function Dialog({ opened, title, children, onClose, pending = false }: {
  opened: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  pending?: boolean;
}): ReactElement {
  return (
    <Modal
      opened={opened}
      onClose={pending ? () => undefined : onClose}
      title={title}
      size={720}
      centered
      closeOnEscape={!pending}
      trapFocus
      returnFocus
    >
      {children}
    </Modal>
  );
}
