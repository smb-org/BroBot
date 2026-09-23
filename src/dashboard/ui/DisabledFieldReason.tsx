import { createContext, useContext, type ReactNode } from "react";

export interface DisabledFieldReasonValue {
  id: string;
  reason: string;
}

export const DisabledFieldReasonContext = createContext<DisabledFieldReasonValue | null>(null);

export const useDisabledFieldReason = (): DisabledFieldReasonValue | null => useContext(DisabledFieldReasonContext);

export const describedHelper = (helper: ReactNode, reason: DisabledFieldReasonValue | null, suffix: string): ReactNode => (
  <>
    {helper}
    {reason === null ? null : <span className="sr-only" id={`${reason.id}-${suffix}`}>{reason.reason}</span>}
  </>
);
