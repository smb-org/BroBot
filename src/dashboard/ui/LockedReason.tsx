import { Icon } from "./Icon";

export interface LockedReasonProps {
  reason?: string;
  id?: string;
}

export function LockedReason({ reason, id }: LockedReasonProps) {
  if (reason === undefined || reason.length === 0) {
    return <span data-ui="" id={id} className="ui-locked-reason ui-locked-reason--reserved" aria-hidden="true">&nbsp;</span>;
  }

  return <span data-ui="" id={id} className="ui-locked-reason" role="note"><Icon name="lock" size={16} />{reason}</span>;
}
