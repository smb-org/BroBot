export type StatusLedState = "ok" | "loading" | "warn" | "error" | "off";

export interface StatusLedProps {
  state: StatusLedState;
  label: string;
  /** Dot only; the label stays available as aria-label. */
  dotOnly?: boolean;
}

export function StatusLed({ state, label, dotOnly = false }: StatusLedProps) {
  return <span data-ui="" className={`status-led status-led--${state}`} data-status={state} aria-label={label} title={label}>
    <span className="status-led__dot" aria-hidden="true" />
    {dotOnly ? null : <span className="status-led__label">{label}</span>}
  </span>;
}
