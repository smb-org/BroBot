import { useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, Icon, SegmentChoice, notify } from "../../../dashboard/ui";
import type { ModuleImmediateActionProperties } from "../contract";
import { adsPanelTexts } from "./locale";
import { adFailureReason, commercialCooldownWaitMessage, rateLimitWaitMessage } from "./errors";
import { startCommercialNow } from "./service";

const AD_LENGTHS = ["30", "60", "90", "120", "150", "180"];

const AdNowAction = ({ channelId, canManage = false, availabilityReason }: ModuleImmediateActionProperties): ReactElement => {
  const labels = adsPanelTexts(typeof navigator === "undefined" || !navigator.language.toLowerCase().startsWith("en") ? "de" : "en");
  const [length, setLength] = useState<string | null>("60");
  const [pending, setPending] = useState(false);
  const [resultMessage, setResultMessage] = useState<{ full: string; short?: string } | null>(null);
  const availabilityReasonId = "stream-manager-ads-availability-reason";
  const actionReason = canManage ? availabilityReason : labels.immediateReadOnly;
  const unavailable = actionReason !== null;

  const run = async (): Promise<void> => {
    if (pending || length === null || actionReason !== null) return;
    setPending(true);
    setResultMessage(null);
    try {
      const result = await startCommercialNow(channelId, Number(length));
      const message = labels.immediateStarted(String(result.length ?? length));
      setResultMessage({ full: message });
      notify({ tone: "success", message });
    } catch (error: unknown) {
      const reason = adFailureReason(error);
      const message = error instanceof PanelApiError && error.code === "commercial_start_denied"
        ? labels.immediateReadOnly
        : error instanceof PanelApiError && error.code === "commercial_stream_offline"
          ? labels.immediateOffline
          : reason === "scope_missing"
            ? labels.immediateScopeMissing
            : reason === "token_invalid"
              ? labels.immediateTokenInvalid
              : reason === "commercial_cooldown"
                ? commercialCooldownWaitMessage(error, labels) ?? labels.immediateFailed
                : rateLimitWaitMessage(error, labels) ?? labels.immediateFailed;
      const short = reason === "scope_missing" ? labels.immediateScopeMissingShort
        : reason === "token_invalid" ? labels.immediateTokenInvalidShort
          : undefined;
      setResultMessage({ full: message, ...(short === undefined ? {} : { short }) });
      notify({ tone: "error", message });
    } finally {
      setPending(false);
    }
  };
  const fullResultMessage = actionReason ?? resultMessage?.full ?? "";
  const visibleResultMessage = actionReason ?? resultMessage?.short ?? resultMessage?.full ?? "";

  return (
    <div className="stream-manager-action">
      <div className="stream-manager-action__header"><Icon name="ad" size={20} /><h3>{labels.immediateTitle}</h3></div>
      <div className="stream-manager-action__body">
        <SegmentChoice
          label={labels.immediateLength}
          hint={labels.immediateLengthHint}
          value={length ?? ""}
          onChange={setLength}
          options={AD_LENGTHS.map((value) => ({ value, label: `${value}s` }))}
          disabled={pending || unavailable}
          size="compact"
        />
      </div>
      <Button className="stream-manager-action__button" icon="ad" variant="primary" disabled={pending || length === null || unavailable} {...(unavailable ? { describedBy: availabilityReasonId } : {})} onClick={() => { void run(); }}>
        {labels.immediateRun(length ?? "")}
      </Button>
      <p className="lock-reason stream-manager-action__result" id={availabilityReasonId} data-testid="immediate-action-result-slot"
        aria-live="polite"
        aria-label={fullResultMessage}
        title={fullResultMessage}>
        {visibleResultMessage}
      </p>
    </div>
  );
};

export default AdNowAction;
