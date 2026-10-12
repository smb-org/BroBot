export type StatusLedState = "ok" | "loading" | "warn" | "error" | "off";

export interface StatusLedProps {
  state: StatusLedState;
  label: string;
}

export function StatusLed({ state, label }: StatusLedProps) {
  return <span data-ui="" className={`status-led status-led--${state}`} data-status={state} aria-label={label}>
    <span className="status-led__dot" aria-hidden="true" />
    <span className="status-led__label">{label}</span>
  </span>;
}
