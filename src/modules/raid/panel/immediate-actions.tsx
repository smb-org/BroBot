import { useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { SHOUTOUT_FAILURE_REASONS, type ShoutoutFailureReason } from "../../../contracts/values";
import { apiErrorText } from "../../../dashboard/locale";
import { Button, Field, Icon, notify } from "../../../dashboard/ui";
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
  const [resultMessage, setResultMessage] = useState("");

  const run = async (): Promise<void> => {
    const trimmed = login.trim();
    if (pending || availabilityReason !== null || trimmed.length === 0) return;
    setPending(true);
    setResultMessage("");
    try {
      await sendManualShoutout(channelId, trimmed);
      const message = labels.sent(trimmed);
      setResultMessage(message);
      notify({ tone: "success", message });
    } catch (error: unknown) {
      const details = error instanceof PanelApiError && typeof error.details === "object" && error.details !== null && !Array.isArray(error.details)
        ? error.details as Record<string, unknown>
        : null;
      const reason = details?.reason;
      const message = isShoutoutFailureReason(reason)
        ? labels.failureReasons[reason]
        : error instanceof PanelApiError ? apiErrorText(error.code, labels.failed, language) : labels.failed;
      setResultMessage(message);
      notify({ tone: "error", message });
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
      <p className="lock-reason" id={availabilityReasonId} data-testid="immediate-action-result-slot"
        style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }} aria-live="polite"
        title={availabilityReason ?? resultMessage}>
        {availabilityReason ?? resultMessage}
      </p>
    </div>
  );
};

export default ShoutoutAction;
