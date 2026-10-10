import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { Badge, Button, ConfirmDialog, InspectorSection, LoadState, Skeleton, notify } from "../../../dashboard/ui";
import { dashboardLanguage } from "../../../dashboard/locale";
import type { ModulePanelProperties } from "../../contract";
import type { Votekick } from "../contracts";
import { remainingVotekickSeconds } from "../domain";
import { cancelVotekick, liftVotekickTimeout, loadVotekickPanel, type VotekickPanelData } from "./service";
import { votekickPanelTexts } from "./locale";
import { refetchModuleQueryData, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";

const formatTime = (value: string, language: "de" | "en"): string => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", { dateStyle: "short", timeStyle: "short" }).format(date)
    : value;
};

const VotekickCountdown = ({ endsAt, language }: { endsAt: string; language: "de" | "en" }): ReactElement => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const labels = votekickPanelTexts(language);
  return <span style={{ minWidth: "calc(var(--s10) * 7)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
    {labels.remaining(remainingVotekickSeconds(endsAt, now))}
  </span>;
};

const VotekickLiftAction = ({ item, canOperate, busy, onLift, liftLabel, liftedLabel }: {
  item: Votekick;
  canOperate: boolean;
  busy: boolean;
  onLift: () => void;
  liftLabel: string;
  liftedLabel: string;
}): ReactElement | null => {
  const expiredAt = item.endedAt === null || item.durationSeconds === null
    ? Number.NaN
    : Date.parse(item.endedAt) + item.durationSeconds * 1000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const remaining = expiredAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => { setNow(Date.now()); }, Math.min(2_147_483_647, remaining));
    return () => window.clearTimeout(timer);
  }, [expiredAt]);
  if (item.liftedAt !== null) return <span role="status">{liftedLabel}</span>;
  const expired = !Number.isFinite(expiredAt) || expiredAt <= now;
  return expired ? null : <Button variant="neutral" disabled={!canOperate || busy} onClick={onLift}>{liftLabel}</Button>;
};

export default function VotekickPanel({ channelId, language, canOperate = true }: ModulePanelProperties): ReactElement {
  const resolvedLanguage = language ?? dashboardLanguage();
  const labels = useMemo(() => votekickPanelTexts(resolvedLanguage), [resolvedLanguage]);
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queryClient = useDashboardQueryClient();
  const loadErrorNotified = useRef(false);
  const panelQuery = useModuleQuery(channelId, "votekick", "panel", async (signal) => {
    try {
      const panel = await loadVotekickPanel(channelId, signal);
      loadErrorNotified.current = false;
      return panel;
    } catch (error) {
      if (!loadErrorNotified.current) {
        loadErrorNotified.current = true;
        notify({ tone: "error", message: labels.loadError });
      }
      throw error;
    }
  }, {
    refetchInterval: realtimeStatus === "connected" ? false : 2_000,
  });
  const data = panelQuery.data ?? null;
  const loading = panelQuery.isPending;
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | undefined>();
  const [cancelTarget, setCancelTarget] = useState<Votekick | null>(null);
  const [liftTarget, setLiftTarget] = useState<Votekick | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      await refetchModuleQueryData<VotekickPanelData>(queryClient, channelId, "votekick", "panel");
      loadErrorNotified.current = false;
    } catch {
      if (!loadErrorNotified.current) {
        loadErrorNotified.current = true;
        notify({ tone: "error", message: labels.loadError });
      }
    }
  }, [channelId, labels.loadError, queryClient]);
  const cancel = async (): Promise<void> => {
    if (cancelTarget === null) return;
    setBusy(true);
    setDialogError(undefined);
    try {
      await cancelVotekick(channelId, cancelTarget.id);
      setCancelTarget(null);
      await reload();
    } catch {
      setDialogError(labels.actionError);
    } finally {
      setBusy(false);
    }
  };

  const lift = async (): Promise<void> => {
    if (liftTarget === null) return;
    setBusy(true);
    setDialogError(undefined);
    try {
      await liftVotekickTimeout(channelId, liftTarget.id);
      setLiftTarget(null);
      await reload();
    } catch {
      setDialogError(labels.actionError);
    } finally {
      setBusy(false);
    }
  };

  const running = data?.running ?? null;
  const history = data?.votekicks.filter((item) => item.status !== "running") ?? [];
  const renderSections = (skeleton: boolean): ReactElement => <div className="module-stack" data-testid="votekick-reserved-content">
    <p className="lock-reason" data-testid="votekick-operation-permission-reason"
      style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }}>
      {canOperate ? "" : labels.readOnlyReason}
    </p>
    <InspectorSection title={labels.running}>
      <div data-testid="votekick-running-slot" style={{ height: "calc(var(--s10) * 7)", overflowY: "auto" }}>
        {skeleton ? <Skeleton rows={2} height={34} /> : running === null
          ? <p className="muted">{labels.emptyRunning}</p>
          : <article className="timer-row">
              <div className="timer-row__copy">
                <strong>{labels.target} · <code>{running.targetLogin ?? running.targetUserId ?? "—"}</code></strong>
                <span>{labels.votes(running.yesVotes, running.noVotes, running.threshold)}</span>
                <VotekickCountdown endsAt={running.endsAt} language={resolvedLanguage} />
              </div>
              <div className="timer-row__actions">
                <Button variant="subtle" danger disabled={!canOperate || busy} onClick={() => { setDialogError(undefined); setCancelTarget(running); }}>{labels.cancel}</Button>
              </div>
            </article>}
      </div>
    </InspectorSection>

    <InspectorSection title={labels.history}>
      <div className="state-list" data-testid="votekick-history-list"
        style={{ height: "calc(var(--s10) * 20)", overflowY: "auto" }}>
        {skeleton ? <Skeleton rows={5} height={34} /> : history.length === 0
          ? <p className="muted">{labels.emptyHistory}</p>
          : history.map((item) => (
              <article key={item.id} className="timer-row" style={{ height: "calc(var(--s10) * 5)", overflow: "hidden" }}>
                <div className="timer-row__copy">
                  <strong>{labels.target} · <code>{item.targetLogin ?? item.targetUserId ?? "—"}</code></strong>
                  <span><Badge tone={item.status === "passed" ? "brand" : "neutral"}>{labels.status[item.status]}</Badge> · {formatTime(item.startedAt, resolvedLanguage)}</span>
                  <span>{labels.votes(item.yesVotes, item.noVotes, item.threshold)} · {labels.duration(item.durationSeconds)}</span>
                </div>
                <div className="timer-row__actions">
                  {item.status === "passed" && item.targetUserId !== null && item.liftedAt === null &&
                    item.endedAt !== null && item.durationSeconds !== null &&
                    Number.isFinite(Date.parse(item.endedAt))
                    ? <VotekickLiftAction key={`${item.id}:${item.endedAt}:${String(item.durationSeconds)}`} item={item} canOperate={canOperate} busy={busy}
                        onLift={() => { setDialogError(undefined); setLiftTarget(item); }} liftLabel={labels.lift} liftedLabel={labels.lifted} />
                    : item.liftedAt === null ? null : <span role="status">{labels.lifted}</span>}
                </div>
              </article>
            ))}
      </div>
    </InspectorSection>
  </div>;
  return <section className="module-stack" aria-label={labels.ariaLabel}>
    <LoadState variant="panel" status={loading ? "loading" : data === null ? "error" : "success"}
      minHeight="0"
      loading={renderSections(true)}
      empty={renderSections(false)}
      error={renderSections(true)}
    >
      {renderSections(false)}
    </LoadState>

    <ConfirmDialog
      opened={cancelTarget !== null}
      title={labels.cancelTitle}
      description={labels.cancelDescription}
      confirmLabel={labels.confirmCancel}
      cancelLabel={labels.cancelDialogCancel}
      onConfirm={() => { void cancel(); }}
      onCancel={() => { setCancelTarget(null); setDialogError(undefined); }}
      pending={busy}
      danger
      {...(dialogError === undefined ? {} : { error: dialogError })}
    />
    <ConfirmDialog
      opened={liftTarget !== null}
      title={labels.liftTitle}
      description={labels.liftDescription}
      confirmLabel={labels.confirmLift}
      cancelLabel={labels.liftDialogCancel}
      onConfirm={() => { void lift(); }}
      onCancel={() => { setLiftTarget(null); setDialogError(undefined); }}
      pending={busy}
      danger
      {...(dialogError === undefined ? {} : { error: dialogError })}
    />
  </section>;
}
