import { useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, Icon, SegmentedControl, notify } from "../../../dashboard/ui";
import type { ModuleImmediateActionProperties } from "../contract";
import { adsPanelTexts } from "./locale";
import { startCommercialNow } from "./service";

const AD_LENGTHS = ["30", "60", "90", "120", "150", "180"];

const AdNowAction = ({ channelId, availabilityReason }: ModuleImmediateActionProperties): ReactElement => {
  const labels = adsPanelTexts(typeof navigator === "undefined" || !navigator.language.toLowerCase().startsWith("en") ? "de" : "en");
  const [length, setLength] = useState<string | null>("60");
  const [pending, setPending] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const availabilityReasonId = "stream-manager-ads-availability-reason";
  const unavailable = availabilityReason !== null;

  const run = async (): Promise<void> => {
    if (pending || length === null || availabilityReason !== null) return;
    setPending(true);
    setResultMessage("");
    try {
      const result = await startCommercialNow(channelId, Number(length));
      const message = labels.immediateStarted(String(result.length ?? length));
      setResultMessage(message);
      notify({ tone: "success", message });
    } catch (error: unknown) {
      const message = error instanceof PanelApiError && error.code === "commercial_stream_offline"
        ? labels.immediateOffline
        : labels.immediateFailed;
      setResultMessage(message);
      notify({ tone: "error", message });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="stream-manager-action">
      <div className="stream-manager-action__header"><Icon name="ad" size={20} /><h3>{labels.immediateTitle}</h3></div>
      <div className="stream-manager-action__body">
        <SegmentedControl
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
      <p className="lock-reason" id={availabilityReasonId} data-testid="immediate-action-result-slot"
        style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }} aria-live="polite"
        title={availabilityReason ?? resultMessage}>
        {availabilityReason ?? resultMessage}
      </p>
    </div>
  );
};

export default AdNowAction;
