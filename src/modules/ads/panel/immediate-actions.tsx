import { useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, Icon, SegmentedControl } from "../../../dashboard/ui";
import type { ModuleImmediateActionProperties } from "../contract";
import { adsPanelTexts } from "./locale";
import { startCommercialNow } from "./service";

const AD_LENGTHS = ["30", "60", "90", "120", "150", "180"];

const AdNowAction = ({ channelId, streamState }: ModuleImmediateActionProperties): ReactElement => {
  const labels = adsPanelTexts(typeof navigator === "undefined" || !navigator.language.toLowerCase().startsWith("en") ? "de" : "en");
  const [length, setLength] = useState<string | null>("60");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const offlineReasonId = "stream-manager-ads-offline-reason";

  const run = async (): Promise<void> => {
    if (pending || length === null) return;
    setPending(true);
    setMessage(null);
    setSucceeded(false);
    try {
      const result = await startCommercialNow(channelId, Number(length));
      setMessage(labels.immediateStarted(String(result.length ?? length)));
      setSucceeded(true);
    } catch (error: unknown) {
      setMessage(error instanceof PanelApiError && error.code === "commercial_stream_offline"
        ? labels.immediateOffline
        : labels.immediateFailed);
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
          disabled={pending}
          size="compact"
        />
      </div>
      <Button className="stream-manager-action__button" icon="ad" variant="primary" disabled={pending || length === null || streamState === "offline"} {...(streamState === "offline" ? { describedBy: offlineReasonId } : {})} onClick={() => { void run(); }}>
        {labels.immediateRun(length ?? "")}
      </Button>
      {streamState === "offline" ? <p className="lock-reason" id={offlineReasonId}>{labels.immediateOffline}</p> : null}
      {message === null ? null : <p className={succeeded ? "form-success" : "form-error"} role={succeeded ? "status" : "alert"}>{message}</p>}
    </div>
  );
};

export default AdNowAction;
