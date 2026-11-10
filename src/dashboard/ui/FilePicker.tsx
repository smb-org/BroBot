import type { ReactElement, Ref } from "react";

export interface FilePickerProps {
  accept: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLInputElement>;
  onChange: (file: File | undefined) => void;
}

export function FilePicker({ accept, ariaLabel, disabled = false, className, ref, onChange }: FilePickerProps): ReactElement {
  return <input
    ref={ref}
    className={className}
    type="file"
    accept={accept}
    aria-label={ariaLabel}
    disabled={disabled}
    onChange={(event) => onChange(event.currentTarget.files?.[0])}
  />;
}
