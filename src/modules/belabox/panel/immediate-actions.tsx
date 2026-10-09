import { useEffect, useRef, useState, type ReactElement } from "react";

import { Button, Icon, notify } from "../../../dashboard/ui";
import type { ModuleImmediateActionProperties } from "../../contract";
import type { BelaboxStatusResponse } from "../contracts";
import { belaboxPanelTexts, belaboxReasonText } from "./locale";
import { loadBelaboxStatus, testBelaboxConnection } from "./service";
import { refetchModuleQueryData, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";

const language = typeof navigator === "undefined" || !navigator.language.toLowerCase().startsWith("en") ? "de" : "en";

const BelaboxStatusAction = ({ channelId, canManage = false, availabilityReason }: ModuleImmediateActionProperties): ReactElement => {
  const labels = belaboxPanelTexts(language);
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queryClient = useDashboardQueryClient();
  const statusQuery = useModuleQuery(channelId, "belabox", "status", (signal) => loadBelaboxStatus(channelId, signal), {
    refetchInterval: realtimeStatus === "connected" ? false : (query) => {
      const current = query.state.data;
      return current?.pollingDesired === true
        ? Math.max(5, current.intervalSeconds) * 1_000
        : current === undefined ? 5_000 : 60_000;
    },
  });
  const status = statusQuery.data ?? null;
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState("");
  const suppressNextStatusResultClear = useRef(false);

  useEffect(() => {
    if (statusQuery.dataUpdatedAt === 0) return;
    if (suppressNextStatusResultClear.current) {
      suppressNextStatusResultClear.current = false;
      return;
    }
    setResult("");
  }, [statusQuery.dataUpdatedAt]);

  const checkNow = async (): Promise<void> => {
    if (checking || availabilityReason !== null || !canManage) return;
    setChecking(true);
    setResult("");
    try {
      const outcome = await testBelaboxConnection(channelId);
      if (!outcome.ok) {
        const message = belaboxReasonText(labels, outcome.reason);
        setResult(message);
        notify({ tone: "error", message });
        return;
      }
      const message = `${outcome.connected ? labels.connected : labels.disconnected} · ${labels.bitrate}: ${String(outcome.bitrateKbps)} kbps`;
      setResult(message);
      notify({ tone: outcome.connected ? "success" : "info", message });
      suppressNextStatusResultClear.current = true;
      await refetchModuleQueryData<BelaboxStatusResponse>(queryClient, channelId, "belabox", "status");
    } catch {
      setResult(labels.testFailed);
      notify({ tone: "error", message: labels.testFailed });
    } finally {
      setChecking(false);
    }
  };

  const notice = status?.fetchFailureNotice === true
    ? labels.fetchFailureNotice
    : status?.alertNotice === null || status?.alertNotice === undefined
      ? status === null
        ? labels.statusUnavailable
        : status.sample === null
          ? status.configured ? labels.statusUnavailable : labels.notConfigured
        : `${status.sample.connected ? labels.connected : labels.disconnected} · ${labels.bitrate}: ${String(status.sample.bitrateKbps)} kbps`
      : `${status.alertNotice.phase === "pending" ? labels.alertPending : status.alertNotice.phase === "recovering"
        ? labels.alertRecovering : status.alertNotice.kind === "disconnect" ? labels.alertDisconnect : labels.alertLow}${
        status.alertNotice.bitrateKbps === null ? "" : ` · ${labels.bitrate}: ${String(status.alertNotice.bitrateKbps)} kbps`}`;
  const availabilityReasonId = "stream-manager-belabox-availability-reason";

  return <div className="stream-manager-action">
    <div className="stream-manager-action__header"><Icon name="broadcast" size={20} /><h3>{labels.title}</h3></div>
    <p className={status?.fetchFailureNotice === true || (status?.alertNotice !== null && status?.alertNotice !== undefined) ? "" : "muted"}
      data-testid="belabox-immediate-status-slot" role="status" aria-live="polite" title={availabilityReason ?? notice}
      style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }}>
      {availabilityReason ?? notice}
    </p>
    <Button className="stream-manager-action__button" icon="reload" disabled={checking || availabilityReason !== null || !canManage || status?.configured === false}
      {...(availabilityReason !== null ? { describedBy: availabilityReasonId } : !canManage ? { describedBy: availabilityReasonId } : {})}
      onClick={() => { void checkNow(); }}>
      {labels.checkNow}
    </Button>
    <p className="lock-reason" id={availabilityReasonId} data-testid="immediate-action-result-slot"
      style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }} aria-live="polite"
      title={availabilityReason ?? (!canManage ? labels.readOnly : result || undefined)}>
      {availabilityReason ?? (!canManage ? labels.readOnly : result)}
    </p>
  </div>;
};

export default BelaboxStatusAction;
