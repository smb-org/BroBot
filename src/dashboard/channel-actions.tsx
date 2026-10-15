import type { ReactElement } from "react";

import { channelPanelTexts } from "./labels";

export const BroadcasterConsentAction = ({ login, needed, canRequest, reasonId = "broadcaster-consent-action-reason", actionLabel }: {
  login: string;
  needed: boolean;
  canRequest: boolean;
  reasonId?: string;
  actionLabel?: string;
}): ReactElement | null => {
  if (!needed) return null;
  const texts = channelPanelTexts();
  return (
    <div className="header-action">
      {canRequest
        ? <a className="button button--primary" href={`/auth/login?channel=${encodeURIComponent(login)}`}>{actionLabel ?? texts.requestFullConsent}</a>
        : <button className="button" type="button" disabled aria-describedby={reasonId}>{actionLabel ?? texts.requestFullConsent}</button>}
      <div className="header-action__reason-slot">{!canRequest ? <span className="lock-reason" id={reasonId}>{texts.fullConsentLocked}</span> : null}</div>
    </div>
  );
};
