export interface NativeRadioProps {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

/** Native mutually exclusive choice, including browser arrow-key navigation. */
export function NativeRadio({ ariaLabel, ...props }: NativeRadioProps) {
  return <input type="radio" aria-label={ariaLabel} {...props} />;
}
