import { useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { SHOUTOUT_FAILURE_REASONS, type ShoutoutFailureReason } from "../../../contracts/values";
import { apiErrorText } from "../../../dashboard/locale";
import { Button, Field, Icon } from "../../../dashboard/ui";
import type { ModuleImmediateActionProperties } from "../contract";
import { sendManualShoutout } from "./immediate-action-service";
import { raidActionTexts } from "./immediate-action-locale";

const isShoutoutFailureReason = (reason: unknown): reason is ShoutoutFailureReason =>
  typeof reason === "string" && SHOUTOUT_FAILURE_REASONS.includes(reason as ShoutoutFailureReason);

const ShoutoutAction = ({ channelId, availabilityReason }: ModuleImmediateActionProperties): ReactElement => {
  const language = typeof navigator === "undefined" || !navigator.language.toLowerCase().startsWith("en") ? "de" : "en";
  const labels = raidActionTexts(language);
  const [login, setLogin] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  const run = async (): Promise<void> => {
    const trimmed = login.trim();
    if (pending || availabilityReason !== null || trimmed.length === 0) return;
    setPending(true);
    setMessage(null);
    setSucceeded(false);
    try {
      await sendManualShoutout(channelId, trimmed);
      setMessage(labels.sent(trimmed));
      setSucceeded(true);
    } catch (error: unknown) {
      const details = error instanceof PanelApiError && typeof error.details === "object" && error.details !== null && !Array.isArray(error.details)
        ? error.details as Record<string, unknown>
        : null;
      const reason = details?.reason;
      setMessage(isShoutoutFailureReason(reason)
        ? labels.failureReasons[reason]
        : error instanceof PanelApiError ? apiErrorText(error.code, labels.failed, language) : labels.failed);
    } finally {
      setPending(false);
    }
  };

  const isEmpty = login.trim().length === 0;
  const loginId = "stream-manager-shoutout-login";
  const helperId = `${loginId}-description`;
  const availabilityReasonId = "stream-manager-shoutout-availability-reason";

  return (
    <div className="stream-manager-action">
      <div className="stream-manager-action__header"><Icon name="shoutout" size={20} /><h3>{labels.title}</h3></div>
      <div className="stream-manager-action__body">
        <Field
          id={loginId}
          label={labels.login}
          hint={isEmpty ? labels.loginRequired : labels.loginHint}
          prefix="@"
          value={login}
          onChange={setLogin}
          disabled={pending || availabilityReason !== null}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void run(); } }}
        />
      </div>
      <Button className="stream-manager-action__button" icon="shoutout" variant="primary" disabled={pending || isEmpty || availabilityReason !== null} {...(availabilityReason !== null ? { describedBy: availabilityReasonId } : isEmpty ? { describedBy: helperId } : {})} onClick={() => { void run(); }}>
        {labels.send}
      </Button>
      {availabilityReason === null ? null : <p className="lock-reason" id={availabilityReasonId}>{availabilityReason}</p>}
      {message === null ? null : <p className={succeeded ? "form-success" : "form-error"} role={succeeded ? "status" : "alert"}>{message}</p>}
    </div>
  );
};

export default ShoutoutAction;
